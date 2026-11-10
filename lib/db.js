'use strict';

/**
 * Database access (MySQL/MariaDB, PostgreSQL, MongoDB, Redis).
 *
 * Every database command runs the engine's own CLI client, either inside a container
 * (`docker exec`) or directly on the SSH host. Passwords are never put on a command line:
 * the wrapper script reads the password from the first line of stdin and hands it to the
 * client through its environment variable (MYSQL_PWD, PGPASSWORD, REDISCLI_AUTH).
 */

const { shq, checkId, clampInt } = require('./util');

// psql prints this for SQL NULLs so the browser can tell NULL from the string 'NULL'.
const PG_NULL = '<NULL:5dc1>';
// Printed by interactive wrappers once the terminal no longer echoes, so the password can be sent.
const READY_MARKER = '__SDC_DB_READY_8f2a__';

const ENGINES = {
  mysql: { label: 'MySQL / MariaDB', sql: true, port: 3306 },
  postgres: { label: 'PostgreSQL', sql: true, port: 5432 },
  mongo: { label: 'MongoDB', sql: false, port: 27017 },
  redis: { label: 'Redis', sql: false, port: 6379 },
};

function detectEngine(image = '') {
  const img = image.toLowerCase();
  if (/mysql|mariadb|percona/.test(img)) return 'mysql';
  if (/postgres|postgis|timescale|pgvector|supabase\/postgres/.test(img)) return 'postgres';
  if (/mongo/.test(img)) return 'mongo';
  if (/redis|valkey|keydb/.test(img)) return 'redis';
  return null;
}

function envMap(inspect) {
  const env = {};
  for (const e of inspect?.Config?.Env || []) {
    const i = e.indexOf('=');
    if (i > 0) env[e.slice(0, i)] = e.slice(i + 1);
  }
  return env;
}

/**
 * Work out default credentials from the container's environment, the same variables the
 * official (and Bitnami) images use. Returns { engine, user, database, passwords: {user: pw} }.
 * `*_FILE` variables (Docker secrets) are read from inside the container.
 */
async function autoCredentials(session, id) {
  const inspect = await session.inspect({ id });
  const env = envMap(inspect);
  const engine = detectEngine(inspect?.Config?.Image);
  const passwords = {};

  const readSecret = async (name) => {
    if (env[name]) return env[name];
    const file = env[`${name}_FILE`];
    if (!file || !file.startsWith('/')) return undefined;
    const r = await session.exec(`${session.docker} exec ${checkId(id)} cat -- ${shq(file)}`, { timeout: 10000 });
    return r.code === 0 ? r.stdout.replace(/\r?\n$/, '') : undefined;
  };
  const first = (...keys) => keys.map((k) => env[k]).find((v) => v);

  let user = '';
  let database = '';

  if (engine === 'mysql') {
    const rootPw = (await readSecret('MYSQL_ROOT_PASSWORD')) ?? (await readSecret('MARIADB_ROOT_PASSWORD'));
    const appUser = first('MYSQL_USER', 'MARIADB_USER');
    const appPw = (await readSecret('MYSQL_PASSWORD')) ?? (await readSecret('MARIADB_PASSWORD'));
    const emptyRoot = first('MYSQL_ALLOW_EMPTY_PASSWORD', 'MARIADB_ALLOW_EMPTY_ROOT_PASSWORD', 'ALLOW_EMPTY_PASSWORD');
    if (rootPw !== undefined) passwords.root = rootPw;
    else if (emptyRoot) passwords.root = '';
    if (appUser) passwords[appUser] = appPw ?? '';
    user = 'root' in passwords ? 'root' : appUser || 'root';
    database = first('MYSQL_DATABASE', 'MARIADB_DATABASE') || '';
  } else if (engine === 'postgres') {
    user = first('POSTGRES_USER', 'POSTGRESQL_USERNAME') || 'postgres';
    const pw = (await readSecret('POSTGRES_PASSWORD')) ?? (await readSecret('POSTGRESQL_PASSWORD'));
    if (pw !== undefined) passwords[user] = pw;
    const superPw = await readSecret('POSTGRESQL_POSTGRES_PASSWORD');
    if (superPw !== undefined) passwords.postgres = superPw;
    database = first('POSTGRES_DB', 'POSTGRESQL_DATABASE') || user;
  } else if (engine === 'mongo') {
    user = first('MONGO_INITDB_ROOT_USERNAME', 'MONGODB_ROOT_USER') || '';
    const pw = (await readSecret('MONGO_INITDB_ROOT_PASSWORD')) ?? (await readSecret('MONGODB_ROOT_PASSWORD'));
    if (user && pw !== undefined) passwords[user] = pw;
    database = first('MONGO_INITDB_DATABASE') || '';
  } else if (engine === 'redis') {
    let pw = await readSecret('REDIS_PASSWORD');
    // `redis-server --requirepass secret`
    const args = [...(inspect?.Config?.Cmd || []), ...(inspect?.Args || [])];
    const i = args.indexOf('--requirepass');
    if (pw === undefined && i >= 0 && args[i + 1]) pw = args[i + 1];
    if (pw !== undefined) passwords.default = pw;
    user = '';
  }

  return { engine, user, database, passwords };
}

// ---------------------------------------------------------------- command building

const NOT_FOUND = (what) => `{ echo "${what} client not found here. Install it, or open the database from its own container." >&2; exit 127; }`;

const SCRIPTS = {
  mysql: `C=$(command -v mariadb || command -v mysql) || ${NOT_FOUND('mysql/mariadb')}; [ -n "$P" ] && export MYSQL_PWD="$P"; exec "$C" "$@"`,
  postgres: `command -v psql >/dev/null || ${NOT_FOUND('psql')}; [ -n "$P" ] && export PGPASSWORD="$P"; exec psql "$@"`,
  mongo: `C=$(command -v mongosh || command -v mongo) || ${NOT_FOUND('mongosh')}; if [ -n "$P" ]; then set -- "$@" -p "$P"; fi; exec "$C" "$@"`,
  redis: `command -v redis-cli >/dev/null || ${NOT_FOUND('redis-cli')}; [ -n "$P" ] && export REDISCLI_AUTH="$P"; exec redis-cli "$@"`,
};

const PRELUDE_PIPE = `IFS= read -r P || P=;`;
const PRELUDE_TTY = `stty -echo 2>/dev/null; printf '%s\\n' ${READY_MARKER}; IFS= read -r P || P=; stty echo 2>/dev/null;`;

function normalizeParams(p) {
  const engine = String(p.engine || '');
  if (!ENGINES[engine]) throw new Error('Unsupported database engine');
  const host = String(p.host || '').trim();
  if (host && !/^[a-zA-Z0-9_.:-]{1,255}$/.test(host)) throw new Error('Invalid database host');
  const port = p.port ? clampInt(p.port, ENGINES[engine].port, 1, 65535) : '';
  const user = String(p.user || '').trim();
  const database = String(p.database || '').trim();
  if (user.length > 128 || database.length > 256) throw new Error('User or database name too long');
  const target = p.target === 'host' ? { kind: 'host' } : { kind: 'container', id: checkId(p.id) };
  return { engine, host, port, user, database, target };
}

function clientArgs(n, mode) {
  const a = [];
  const { engine, host, port, user, database } = n;
  if (engine === 'mysql') {
    // -vv prints each statement and its "Query OK, N rows affected" around the XML result sets.
    if (mode === 'query') a.push('--xml', '-vv');
    a.push('--default-character-set=utf8mb4');
    if (user) a.push(`--user=${user}`);
    if (host) a.push(`--host=${host}`);
    if (port) a.push(`--port=${port}`);
    if (host && host !== 'localhost') a.push('--protocol=TCP');
    if (database) a.push(`--database=${database}`);
  } else if (engine === 'postgres') {
    a.push('-X');
    if (mode === 'query') a.push('-v', 'ON_ERROR_STOP=1', '-H', '-P', 'footer=off', '-P', `null=${PG_NULL}`);
    if (user) a.push('-U', user);
    if (host) a.push('-h', host);
    if (port) a.push('-p', String(port));
    if (database) a.push('-d', database);
  } else if (engine === 'mongo') {
    if (host) a.push('--host', host);
    if (port) a.push('--port', String(port));
    if (user) a.push('-u', user, '--authenticationDatabase', 'admin');
    if (database) a.push(database);
  } else if (engine === 'redis') {
    if (host) a.push('-h', host);
    if (port) a.push('-p', String(port));
    if (user && user !== 'default') a.push('--user', user);
    if (database && /^\d+$/.test(database)) a.push('-n', database);
  }
  return a;
}

/** Build the full remote command. mode: 'query' (stdin = password line + SQL) or 'tty' (interactive). */
function buildCommand(session, n, mode) {
  const script = (mode === 'tty' ? PRELUDE_TTY : PRELUDE_PIPE) + ' ' + SCRIPTS[n.engine];
  const inner = `sh -c ${shq(script)} sh ${clientArgs(n, mode).map(shq).join(' ')}`;
  if (n.target.kind === 'host') return inner;
  const flags = mode === 'tty' ? '-it -e TERM=xterm-256color' : '-i';
  return `${session.docker} exec ${flags} ${n.target.id} ${inner}`;
}

/** Resolve which password to send: an explicit one from the browser, or the container's own. */
function resolvePassword(session, n, p) {
  if (typeof p.password === 'string' && p.password !== '') return p.password;
  if (n.target.kind !== 'container') return '';
  const auto = session.dbAuto.get(n.target.id);
  if (!auto || auto.engine !== n.engine) return '';
  const key = n.engine === 'redis' && !n.user ? 'default' : n.user;
  return auto.passwords[key] ?? '';
}

// ---------------------------------------------------------------- session-facing API

async function dbDefaults(session, m) {
  const id = checkId(m.id);
  const auto = await autoCredentials(session, id);
  session.dbAuto.set(id, auto);
  return {
    engine: auto.engine,
    user: auto.user,
    database: auto.database,
    // Tell the browser which users have a known password, never the password itself.
    autoPasswordUsers: Object.keys(auto.passwords),
    engines: ENGINES,
  };
}

async function dbQuery(session, m) {
  const n = normalizeParams(m);
  if (!ENGINES[n.engine].sql) throw new Error('Queries are only supported for SQL databases. Use the shell instead.');
  const sql = String(m.sql || '');
  if (!sql.trim()) throw new Error('Nothing to run');
  if (sql.length > 1024 * 1024) throw new Error('Query is too large');

  const pw = resolvePassword(session, n, m).replace(/[\r\n]/g, '');
  const cmd = buildCommand(session, n, 'query');
  const token = String(m.token || '');
  const started = Date.now();
  const r = await session.exec(cmd, {
    stdin: `${pw}\n${sql}\n`,
    timeout: clampInt(m.timeout, 300, 5, 3600) * 1000,
    maxBytes: 30 * 1024 * 1024,
    onStream: (stream) => token && session.queries.set(token, stream),
  }).finally(() => token && session.queries.delete(token));

  return {
    engine: n.engine,
    format: n.engine === 'mysql' ? 'xml' : 'html',
    nullMarker: PG_NULL,
    output: r.stdout,
    error: r.stderr.trim(),
    code: r.code,
    truncated: r.truncated,
    timedOut: r.timedOut,
    ms: Date.now() - started,
  };
}

function dbCancel(session, m) {
  const s = session.queries.get(String(m.token));
  if (s) {
    try { s.signal('INT'); } catch { /* not supported by every sshd */ }
    s.close();
    session.queries.delete(String(m.token));
  }
  return true;
}

/** Interactive shell: returns { cmd, password } for Session.termOpen. */
function dbShellCommand(session, m) {
  const n = normalizeParams(m);
  return { cmd: buildCommand(session, n, 'tty'), password: resolvePassword(session, n, m).replace(/[\r\n]/g, '') };
}

module.exports = { ENGINES, READY_MARKER, NOT_FOUND, detectEngine, dbDefaults, dbQuery, dbCancel, dbShellCommand, normalizeParams, resolvePassword };
