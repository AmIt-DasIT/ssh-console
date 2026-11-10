'use strict';

/**
 * Database backups (SQL dumps) and restores for MySQL/MariaDB and PostgreSQL.
 *
 * Backups stream the engine's own dump tool (mysqldump / mariadb-dump, pg_dump) straight to the
 * browser, optionally gzip-compressed on the server so less crosses the SSH connection. They can
 * cover a whole database or chosen tables, structure and/or data, and can keep only the rows whose
 * date column falls in a range:
 *   - MySQL: mysqldump --where on the tables that have the column.
 *   - PostgreSQL: pg_dump writes the structure (pre-data before the rows, constraints and indexes
 *     after them, as pg_dump itself orders a restore) and the filtered rows are written as
 *     `COPY … FROM stdin` blocks from `COPY (SELECT … WHERE …) TO STDOUT`, the same format pg_dump
 *     uses, so the file restores with psql like any other dump. Sequences are set to their current
 *     values so new rows don't collide after a restore.
 *
 * Restores pipe an uploaded .sql or .sql.gz file into the mysql / psql client.
 *
 * As everywhere else, the password is the first line on stdin and reaches the tools only through
 * their environment variable (MYSQL_PWD, PGPASSWORD), never a command line.
 */

const { shq } = require('./util');
const { NOT_FOUND, normalizeParams, resolvePassword } = require('./db');

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/;
const PRELUDE = 'IFS= read -r P || P=;';

const myIdent = (s) => '`' + String(s).replace(/`/g, '``') + '`';
const pgIdent = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const pgQualified = (t) => `${pgIdent(t.schema || 'public')}.${pgIdent(t.name)}`;

function checkName(v, what) {
  const s = String(v ?? '');
  // No leading '-' (would read as an option); no '=' or URI prefix (pg tools would read a database
  // name like that as connection settings).
  if (!s || s.length > 128 || /[\0\r\n=]/.test(s) || s.startsWith('-') || /^postgres(ql)?:/i.test(s)) throw new Error(`Invalid ${what} name`);
  return s;
}

function checkTables(list, engine) {
  if (list == null) return null;
  if (!Array.isArray(list) || list.length > 5000) throw new Error('Invalid table list');
  return list.map((t) => ({
    schema: engine === 'postgres' ? checkName(t?.schema || 'public', 'schema') : null,
    name: checkName(t?.name, 'table'),
  }));
}

const tableKey = (t) => `${t.schema || ''}\u0000${t.name}`;

/** '2026-03-31' → '2026-04-01' (an inclusive end date becomes an exclusive bound). */
function nextDay(d) {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day + 1)).toISOString().slice(0, 10);
}

/** { column, from, to } → SQL condition, or null. Dates are validated, so quoting them is safe. */
function dateCondition(f, quoteIdent) {
  if (!f || !f.column) return null;
  const column = checkName(f.column, 'column');
  const from = f.from ? String(f.from) : '';
  const to = f.to ? String(f.to) : '';
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) throw new Error('Dates must look like 2026-01-31 or 2026-01-31 13:45');
  if (!from && !to) throw new Error('Choose a start date, an end date, or both');
  const c = quoteIdent(column);
  const parts = [];
  if (from) parts.push(`${c} >= '${from.replace('T', ' ')}'`);
  if (to) parts.push(to.length === 10 ? `${c} < '${nextDay(to)}'` : `${c} <= '${to.replace('T', ' ')}'`);
  return parts.join(' AND ');
}

const cmdLine = (args) => args.map(shq).join(' ');

/** Run `script` (POSIX sh) inside the container or on the host. stdin is passed through. */
function inTarget(session, n, script) {
  const inner = `sh -c ${shq(script)}`;
  return n.target.kind === 'host' ? inner : `${session.docker} exec -i ${n.target.id} ${inner}`;
}

/**
 * `left | right`, failing if either side fails (POSIX sh has no pipefail). `report` decides whose
 * error wins when both fail: the side that does the real work.
 */
function pipeBoth(left, right, report = 'left') {
  const first = report === 'left' ? 's' : 'r';
  const second = report === 'left' ? 'r' : 's';
  return sh(
    `st=$(mktemp) || exit 1; { ${left}; echo $? >"$st"; } | ${right}; r=$?; s=$(cat "$st" 2>/dev/null); rm -f "$st"; s=\${s:-1}; ` +
      `[ "$${first}" = 0 ] || exit "$${first}"; exit "$${second}"`,
  );
}
const sh = (script) => `sh -c ${shq(script)}`;

// ---------------------------------------------------------------- MySQL / MariaDB

function mysqlConn(n) {
  const a = ['--default-character-set=utf8mb4'];
  if (n.user) a.push(`--user=${n.user}`);
  if (n.host) a.push(`--host=${n.host}`);
  if (n.port) a.push(`--port=${n.port}`);
  if (n.host && n.host !== 'localhost') a.push('--protocol=TCP');
  return a;
}

function mysqlDumpScript(n, db, o) {
  const base = [...mysqlConn(n), '--single-transaction', '--quick', '--hex-blob', '--no-tablespaces'];
  if (o.content === 'schema') base.push('--no-data');
  if (o.content === 'data') base.push('--no-create-info', '--skip-triggers');
  if (!o.drop) base.push('--skip-add-drop-table');
  // Routines and events belong to the database, not to a table: write them once.
  let extrasDone = false;
  const extras = () => {
    if (extrasDone || o.content === 'data') return [];
    extrasDone = true;
    return [...(o.routines ? ['--routines'] : []), ...(o.events ? ['--events'] : [])];
  };

  const runs = [];
  const where = o.content === 'schema' ? null : dateCondition(o.dateFilter, myIdent);
  if (!where) {
    runs.push([...base, ...extras(), db, ...(o.tables || []).map((t) => t.name)]);
  } else {
    const has = new Set((o.dateFilter.tables || []).map((t) => checkName(t.name ?? t, 'table')));
    const all = o.tables;
    const filtered = all ? all.filter((t) => has.has(t.name)) : [...has].map((name) => ({ name }));
    const others = o.dateFilter.others || 'full';
    if (others !== 'skip' && !(others === 'schema' && o.content === 'data')) {
      const flags = others === 'schema' ? ['--no-data'] : [];
      if (all) {
        const rest = all.filter((t) => !has.has(t.name));
        if (rest.length) runs.push([...base, ...flags, ...extras(), db, ...rest.map((t) => t.name)]);
      } else {
        // The whole database except the filtered tables (views, routines and all).
        runs.push([...base, ...flags, ...extras(), ...filtered.map((t) => `--ignore-table=${db}.${t.name}`), db]);
      }
    }
    if (filtered.length) runs.push([...base, ...extras(), `--where=${where}`, db, ...filtered.map((t) => t.name)]);
    if (!runs.length) throw new Error('Nothing to back up: no chosen table has that date column');
  }

  const lines = [
    PRELUDE,
    `C=$(command -v mariadb-dump || command -v mysqldump) || ${NOT_FOUND('mysqldump')};`,
    '[ -n "$P" ] && export MYSQL_PWD="$P";',
    'set -e;',
  ];
  if (o.createDb) lines.push(`printf '%s\\n' ${shq(`CREATE DATABASE IF NOT EXISTS ${myIdent(db)};`)} ${shq(`USE ${myIdent(db)};`)} '';`);
  for (const r of runs) lines.push(`"$C" ${cmdLine(r)};`);
  return lines.join(' ');
}

function mysqlRestoreScript(n, db, o) {
  const args = [...mysqlConn(n)];
  if (!o.stopOnError) args.push('--force');
  if (db) args.push(`--database=${db}`);
  return [
    PRELUDE,
    `C=$(command -v mariadb || command -v mysql) || ${NOT_FOUND('mysql/mariadb')};`,
    '[ -n "$P" ] && export MYSQL_PWD="$P";',
    `exec "$C" ${cmdLine(args)}`,
  ].join(' ');
}

// ---------------------------------------------------------------- PostgreSQL

function pgConn(n, db) {
  const a = [];
  if (n.user) a.push('-U', n.user);
  if (n.host) a.push('-h', n.host);
  if (n.port) a.push('-p', String(n.port));
  a.push('-d', db);
  return a;
}

/** SQL that prints `SELECT setval(…)` for the sequences owned by a table, at their current values. */
const pgSetvalQuery = (t) =>
  `SELECT format('SELECT pg_catalog.setval(%L, %s, true);', quote_ident(ps.schemaname) || '.' || quote_ident(ps.sequencename), ps.last_value) ` +
  `FROM pg_catalog.pg_sequences ps JOIN pg_catalog.pg_namespace sn ON sn.nspname = ps.schemaname ` +
  `JOIN pg_catalog.pg_class sc ON sc.relname = ps.sequencename AND sc.relnamespace = sn.oid ` +
  `JOIN pg_catalog.pg_depend d ON d.objid = sc.oid AND d.classid = 'pg_catalog.pg_class'::regclass AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i') ` +
  `WHERE d.refobjid = '${pgQualified(t).replace(/'/g, "''")}'::regclass AND ps.last_value IS NOT NULL`;

function pgDumpScript(n, db, o) {
  const conn = pgConn(n, db);
  const common = [...conn];
  if (o.noOwner) common.push('--no-owner', '--no-privileges');
  const clean = o.drop && o.content !== 'data' ? ['--clean', '--if-exists'] : [];
  const inserts = o.inserts && o.content !== 'schema' ? ['--column-inserts'] : [];
  const pick = (list) => list.flatMap((t) => ['-t', pgQualified(t)]);
  const exclude = (list) => list.flatMap((t) => ['-T', pgQualified(t)]);

  const lines = [
    PRELUDE,
    `command -v pg_dump >/dev/null || ${NOT_FOUND('pg_dump')};`,
    '[ -n "$P" ] && export PGPASSWORD="$P";',
    'export PGCLIENTENCODING=UTF8;',
    'set -e;',
  ];
  const pgDump = (args) => lines.push(`pg_dump ${cmdLine(args)};`);

  const where = o.content === 'schema' ? null : dateCondition(o.dateFilter, pgIdent);
  if (!where) {
    const content = o.content === 'schema' ? ['--schema-only'] : o.content === 'data' ? ['--data-only'] : [];
    pgDump([...common, ...content, ...clean, ...inserts, ...pick(o.tables || [])]);
    return lines.join(' ');
  }

  const has = new Set((o.dateFilter.tables || []).map((t) => tableKey({ schema: checkName(t.schema || 'public', 'schema'), name: checkName(t.name, 'table') })));
  const filtered = o.tables ? o.tables.filter((t) => has.has(tableKey(t))) : (o.dateFilter.tables || []).map((t) => ({ schema: t.schema || 'public', name: t.name }));
  const others = o.dateFilter.others || 'full';
  const rest = o.tables ? o.tables.filter((t) => !has.has(tableKey(t))) : null; // null: "everything else"
  if (!filtered.length && (others === 'skip' || (rest && !rest.length))) throw new Error('Nothing to back up: no chosen table has that date column');

  // Which objects get their structure written: whole database, or a list of tables.
  let structure;
  if (others === 'skip') structure = filtered;
  else structure = rest ? [...rest, ...filtered] : null;

  if (o.content !== 'data') pgDump([...common, '--section=pre-data', ...clean, ...pick(structure || [])]);
  if (others === 'full') {
    if (rest === null) pgDump([...common, '--section=data', ...inserts, ...exclude(filtered)]);
    else if (rest.length) pgDump([...common, '--section=data', ...inserts, ...pick(rest)]);
  }
  if (filtered.length) {
    lines.push(`printf '%s\\n' '' ${shq("SET client_encoding = 'UTF8';")} 'SET standard_conforming_strings = on;' '';`);
    const psql = `psql -X -q -v ON_ERROR_STOP=1 ${cmdLine(conn)}`;
    for (const t of filtered) {
      const q = pgQualified(t);
      lines.push(`printf '%s\\n' ${shq(`-- Rows of ${q} where ${where}`)} ${shq(`COPY ${q} FROM stdin;`)};`);
      lines.push(`${psql} -c ${shq(`COPY (SELECT * FROM ${q} WHERE ${where}) TO STDOUT`)};`);
      lines.push(`printf '%s\\n' '\\.' '';`);
      lines.push(`${psql} -A -t -c ${shq(pgSetvalQuery(t))};`);
    }
  }
  if (o.content !== 'data') pgDump([...common, '--section=post-data', ...pick(structure || [])]);
  return lines.join(' ');
}

function pgRestoreScript(n, db, o) {
  const args = ['-X', '-q'];
  if (o.stopOnError) args.push('-v', 'ON_ERROR_STOP=1');
  if (o.singleTransaction) args.push('--single-transaction');
  args.push(...pgConn(n, db));
  return [PRELUDE, `command -v psql >/dev/null || ${NOT_FOUND('psql')};`, '[ -n "$P" ] && export PGPASSWORD="$P";', `exec psql ${cmdLine(args)}`].join(' ');
}

// ---------------------------------------------------------------- transfer specs

function options(m) {
  const o = m.options || {};
  return {
    content: ['all', 'schema', 'data'].includes(o.content) ? o.content : 'all',
    drop: o.drop !== false,
    routines: o.routines !== false,
    events: !!o.events,
    createDb: !!o.createDb,
    inserts: !!o.inserts,
    noOwner: o.noOwner !== false,
    gzip: !!o.gzip,
    stopOnError: o.stopOnError !== false,
    singleTransaction: o.singleTransaction !== false,
    dateFilter: o.dateFilter && o.dateFilter.column ? { ...o.dateFilter, others: ['full', 'schema', 'skip'].includes(o.dateFilter.others) ? o.dateFilter.others : 'full' } : null,
  };
}

function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Download spec for GET /api/download: { cmd, stdin, filename, type }. */
function dumpSpec(session, m) {
  const n = normalizeParams(m);
  if (n.engine !== 'mysql' && n.engine !== 'postgres') throw new Error('Backups are available for MySQL/MariaDB and PostgreSQL');
  const db = checkName(m.database, 'database');
  const o = options(m);
  o.tables = checkTables(m.tables, n.engine);
  if (o.tables && !o.tables.length) throw new Error('Choose at least one table');
  const script = n.engine === 'mysql' ? mysqlDumpScript(n, db, o) : pgDumpScript(n, db, o);
  let cmd = inTarget(session, n, script);
  if (o.gzip) cmd = pipeBoth(cmd, 'gzip -c', 'left');

  const what = !o.tables ? '' : o.tables.length === 1 ? `-${o.tables[0].name}` : `-${o.tables.length}-tables`;
  const range = o.dateFilter && o.content !== 'schema' ? `-${(o.dateFilter.from || 'start').slice(0, 10)}_to_${(o.dateFilter.to || 'now').slice(0, 10)}` : '';
  const kind = o.content === 'schema' ? '-schema' : o.content === 'data' ? '-data' : '';
  const filename = `${db}${what}${kind}${range}-${stamp()}.sql${o.gzip ? '.gz' : ''}`.replace(/[^\w.-]+/g, '_');
  return {
    cmd,
    stdin: `${resolvePassword(session, n, m).replace(/[\r\n]/g, '')}\n`,
    filename,
    type: o.gzip ? 'application/gzip' : 'application/sql; charset=utf-8',
  };
}

/** Upload spec for POST /api/upload: the file is piped into mysql / psql after the password line. */
function restoreSpec(session, m) {
  const n = normalizeParams(m);
  if (n.engine !== 'mysql' && n.engine !== 'postgres') throw new Error('Restores are available for MySQL/MariaDB and PostgreSQL');
  const db = checkName(m.database, 'database');
  const o = options(m);
  const name = String(m.name || '');
  if (!/\.sql(\.gz)?$/i.test(name)) throw new Error('Choose a .sql or .sql.gz file');
  const script = n.engine === 'mysql' ? mysqlRestoreScript(n, db, o) : pgRestoreScript(n, db, o);
  let cmd = inTarget(session, n, script);
  // Decompress on the SSH host (which always has gzip; slim database images may not). The
  // password line is passed through first.
  if (/\.gz$/i.test(name)) cmd = pipeBoth(`(IFS= read -r P; printf '%s\\n' "$P"; exec gzip -dc)`, cmd, 'right');
  return {
    cmd,
    stdinPrefix: `${resolvePassword(session, n, m).replace(/[\r\n]/g, '')}\n`,
    target: `${db}`,
  };
}

module.exports = { dumpSpec, restoreSpec, dateCondition, nextDay };
