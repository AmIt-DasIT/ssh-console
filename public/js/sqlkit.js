// SQL helpers for the database panel: a small tokenizer (strings, comments, quoted identifiers,
// dollar quotes, {{variables}}), statement splitting, a formatter, typed variable substitution and
// Monaco autocompletion (keywords, functions, snippets, tables and columns of the open database).

// ------------------------------------------------------------------ tokenizer

/** → [{ t: 'ws'|'comment'|'string'|'ident'|'word'|'number'|'var'|'punct', v, s, e }] */
export function tokenize(sql, engine = 'mysql') {
  const out = [];
  const n = sql.length;
  let i = 0;
  const push = (t, s) => out.push({ t, v: sql.slice(s, i), s, e: i });
  while (i < n) {
    const s = i;
    const c = sql[i];
    const d = sql[i + 1];
    if (/\s/.test(c)) {
      while (i < n && /\s/.test(sql[i])) i++;
      push('ws', s);
    } else if ((c === '-' && d === '-') || (c === '#' && engine === 'mysql')) {
      while (i < n && sql[i] !== '\n') i++;
      push('comment', s);
    } else if (c === '/' && d === '*') {
      const j = sql.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
      push('comment', s);
    } else if (c === '{' && d === '{' && /^\{\{\s*[A-Za-z_][\w]*\s*\}\}/.test(sql.slice(i, i + 80))) {
      i = sql.indexOf('}}', i) + 2;
      push('var', s);
    } else if (c === "'" || (c === '"' && engine === 'mysql') || c === '`' || (c === '"' && engine !== 'mysql')) {
      const q = c;
      i++;
      while (i < n) {
        if (sql[i] === '\\' && engine === 'mysql' && q !== '`') i += 2;
        else if (sql[i] === q && sql[i + 1] === q) i += 2;
        else if (sql[i] === q) {
          i++;
          break;
        } else i++;
      }
      push(q === "'" || (q === '"' && engine === 'mysql') ? 'string' : 'ident', s);
    } else if (c === '$' && engine === 'postgres' && /^\$[A-Za-z_]*\$/.test(sql.slice(i, i + 64))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64))[0];
      const j = sql.indexOf(tag, i + tag.length);
      i = j < 0 ? n : j + tag.length;
      push('string', s);
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d || ''))) {
      while (i < n && /[0-9a-fA-FxX._eE]/.test(sql[i])) {
        if ((sql[i] === 'e' || sql[i] === 'E') && /[+-]/.test(sql[i + 1] || '')) i++;
        i++;
      }
      push('number', s);
    } else if (/[A-Za-z_\u0080-￿$@]/.test(c)) {
      while (i < n && /[\w\u0080-￿$@]/.test(sql[i])) i++;
      push('word', s);
    } else {
      // Multi-character operators stay together.
      const three = sql.slice(i, i + 3);
      const two = sql.slice(i, i + 2);
      if (['<=>', '->>', '#>>'].includes(three)) i += 3;
      else if (['<=', '>=', '<>', '!=', '::', '||', '->', ':=', '#>', '@>', '<@', '&&'].includes(two)) i += 2;
      else i++;
      push('punct', s);
    }
  }
  return out;
}

/** Split into statements at top-level semicolons. → [{ text, start, end }] (empty ones dropped) */
export function splitStatements(sql, engine) {
  const parts = [];
  let start = 0;
  for (const tk of tokenize(sql, engine)) {
    if (tk.t === 'punct' && tk.v === ';') {
      parts.push({ text: sql.slice(start, tk.e), start, end: tk.e });
      start = tk.e;
    }
  }
  if (start < sql.length) parts.push({ text: sql.slice(start), start, end: sql.length });
  return parts.filter((p) => tokenize(p.text, engine).some((t) => t.t !== 'ws' && t.t !== 'comment' && !(t.t === 'punct' && t.v === ';')));
}

/** The statement the cursor is in (or just after). */
export function statementAt(sql, offset, engine) {
  const all = splitStatements(sql, engine);
  return all.find((p) => offset >= p.start && offset <= p.end) || all.filter((p) => p.end <= offset).pop() || all[0] || null;
}

// ------------------------------------------------------------------ keywords

export const KEYWORDS = `SELECT FROM WHERE AND OR NOT IN IS NULL LIKE ILIKE BETWEEN EXISTS AS ON USING JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL
GROUP BY ORDER ASC DESC HAVING LIMIT OFFSET UNION ALL DISTINCT INTERSECT EXCEPT CASE WHEN THEN ELSE END INSERT INTO VALUES UPDATE SET DELETE
RETURNING CREATE TABLE VIEW INDEX UNIQUE PRIMARY KEY FOREIGN REFERENCES DEFAULT CONSTRAINT CHECK ALTER ADD COLUMN DROP RENAME TO TRUNCATE
IF REPLACE DATABASE SCHEMA GRANT REVOKE BEGIN COMMIT ROLLBACK TRANSACTION SAVEPOINT EXPLAIN ANALYZE SHOW DESCRIBE WITH RECURSIVE OVER PARTITION
WINDOW ROWS RANGE PRECEDING FOLLOWING CURRENT ROW TRUE FALSE CASCADE RESTRICT TEMPORARY TEMP NULLS FIRST LAST FOR LOCK SHARE NOWAIT SKIP LOCKED
CONFLICT DO NOTHING DUPLICATE IGNORE AUTO_INCREMENT SERIAL INTERVAL COLLATE`.split(/\s+/);

const FUNCTIONS = {
  common: 'COUNT SUM AVG MIN MAX COALESCE NULLIF CAST LOWER UPPER LENGTH TRIM LTRIM RTRIM SUBSTRING REPLACE ROUND FLOOR CEIL ABS CONCAT NOW CURRENT_DATE CURRENT_TIMESTAMP ROW_NUMBER RANK DENSE_RANK LAG LEAD GREATEST LEAST'.split(' '),
  mysql: 'IFNULL IF DATE_FORMAT DATE_ADD DATE_SUB DATEDIFF TIMESTAMPDIFF STR_TO_DATE UNIX_TIMESTAMP FROM_UNIXTIME GROUP_CONCAT JSON_EXTRACT JSON_UNQUOTE JSON_OBJECT JSON_ARRAYAGG CONCAT_WS LAST_INSERT_ID FOUND_ROWS UUID CHAR_LENGTH LOCATE YEAR MONTH DAY HOUR CURDATE CURTIME'.split(' '),
  postgres: 'STRING_AGG ARRAY_AGG JSON_AGG JSONB_AGG TO_CHAR TO_DATE TO_TIMESTAMP DATE_TRUNC DATE_PART EXTRACT AGE GENERATE_SERIES UNNEST JSONB_BUILD_OBJECT JSON_BUILD_OBJECT REGEXP_REPLACE SPLIT_PART POSITION GEN_RANDOM_UUID PG_SIZE_PRETTY PG_TOTAL_RELATION_SIZE CURRVAL NEXTVAL SETVAL'.split(' '),
};

const MAJOR = ['SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'UNION ALL', 'UNION', 'EXCEPT', 'INTERSECT', 'VALUES', 'SET', 'RETURNING',
  'INSERT INTO', 'UPDATE', 'DELETE FROM', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'JOIN',
  'ON DUPLICATE KEY UPDATE', 'ON CONFLICT'].map((m) => m.split(' '));
const KW = new Set(KEYWORDS);
const FN = new Set([...FUNCTIONS.common, ...FUNCTIONS.mysql, ...FUNCTIONS.postgres]);

// ------------------------------------------------------------------ formatter

/**
 * Reformat SQL: keywords upper-cased, one clause per line, AND/OR, JOIN … ON and select lists
 * indented. Clauses only break lines at statement or sub-query level, so EXTRACT(YEAR FROM d) and
 * "timestamp with time zone" stay as written. Strings, comments and identifiers are untouched.
 */
export function formatSql(sql, engine) {
  const tks = tokenize(sql, engine).filter((t) => t.t !== 'ws');
  const W = tks.map((t) => (t.t === 'word' ? t.v.toUpperCase() : null));
  let out = '';
  let depth = 0;
  const clause = ['']; // current clause per paren level
  const query = [true]; // is this paren level a (sub)query?
  const pad = [0]; // indentation of each level's clauses
  // nl(d): new line at level d's indentation; nl(d, 1): one step deeper (AND/OR, list items).
  const nl = (d, extra = 0) => {
    out = out.replace(/[ \t]+$/, '');
    if (out && !out.endsWith('\n')) out += '\n';
    out += ' '.repeat((pad[Math.max(0, d)] || 0) + extra * 2);
  };
  const space = () => {
    if (out && !/[\s(]$/.test(out) && !out.endsWith('.') && !out.endsWith('::')) out += ' ';
  };
  const matchClause = (k) => {
    for (const parts of MAJOR) if (parts.every((p, j) => W[k + j] === p)) return parts;
    return null;
  };
  const inBetween = (k) => {
    for (let j = k - 1; j >= Math.max(0, k - 6); j--) {
      if (W[j] === 'BETWEEN') return true;
      if (W[j] === 'AND' || W[j] === 'OR' || W[j] === 'WHERE') return false;
    }
    return false;
  };
  for (let k = 0; k < tks.length; k++) {
    const tk = tks[k];
    if (tk.t === 'comment') {
      space();
      out += tk.v;
      if (!tk.v.startsWith('/*')) nl(depth);
      continue;
    }
    if (tk.t === 'word') {
      const parts = query[depth] ? matchClause(k) : null;
      if (parts) {
        if (out.trim() && !out.endsWith('(')) nl(depth);
        out += parts.join(' ');
        clause[depth] = parts.join(' ');
        k += parts.length - 1;
        continue;
      }
      const up = W[k];
      const c = clause[depth] || '';
      if (query[depth] && (up === 'AND' || up === 'OR') && /WHERE|HAVING|JOIN|ON/.test(c) && !inBetween(k)) {
        nl(depth, 1);
        out += up;
        continue;
      }
      if (query[depth] && up === 'ON' && /JOIN/.test(c)) {
        nl(depth, 1);
        out += 'ON';
        continue;
      }
      space();
      out += KW.has(up) || (FN.has(up) && tks[k + 1]?.v === '(') ? up : tk.v;
      continue;
    }
    if (tk.t === 'punct') {
      const v = tk.v;
      if (v === '(') {
        const fnCall = /[\w`"\]]$/.test(out) && tks[k - 1]?.t !== 'word' ? false : tks[k - 1] && (tks[k - 1].t === 'word' || tks[k - 1].t === 'ident') && !KW.has(W[k - 1]);
        if (fnCall) out = out.trimEnd();
        else space();
        out += '(';
        const lineIndent = /[^\n]*$/.exec(out)[0].match(/^ */)[0].length;
        depth++;
        query[depth] = W[k + 1] === 'SELECT' || W[k + 1] === 'WITH';
        clause[depth] = '';
        pad[depth] = lineIndent + 2;
        if (query[depth]) nl(depth);
        continue;
      }
      if (v === ')') {
        if (query[depth]) {
          out = out.trimEnd();
          out += `\n${' '.repeat(Math.max(0, (pad[depth] || 2) - 2))})`;
        } else out = out.trimEnd() + ')';
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (v === ',') {
        out = out.trimEnd() + ',';
        if (query[depth] && /^(SELECT|GROUP BY|ORDER BY|SET|RETURNING)$/.test(clause[depth] || '')) nl(depth, 1);
        else out += ' ';
        continue;
      }
      if (v === ';') {
        out = out.trimEnd() + ';\n\n';
        depth = 0;
        clause.length = 1;
        clause[0] = '';
        continue;
      }
      if (v === '.' || v === '::') {
        out = out.trimEnd() + v;
        continue;
      }
      space();
      out += v;
      continue;
    }
    // strings, identifiers, numbers, variables
    if (/[.(]$/.test(out) || out.endsWith('::')) out += tk.v;
    else {
      space();
      out += tk.v;
    }
  }
  return out
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ------------------------------------------------------------------ {{variables}}

/** Names of {{variables}} in order of first use. */
export function findVariables(sql, engine) {
  const names = [];
  for (const t of tokenize(sql, engine)) {
    if (t.t !== 'var') continue;
    const name = t.v.slice(2, -2).trim();
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

/** A typed SQL literal. kind: auto (numbers, NULL, TRUE/FALSE as-is; anything else quoted) | text | number | list | raw */
export function toLiteral(value, kind, engine) {
  const v = String(value ?? '');
  const quote = (s) => (engine === 'mysql' ? `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'` : `'${s.replace(/'/g, "''")}'`);
  const auto = (s) => {
    const x = s.trim();
    if (NUMBER_RE.test(x)) return x;
    if (/^(null|true|false)$/i.test(x)) return x.toUpperCase();
    return quote(s);
  };
  switch (kind) {
    case 'raw':
      return v;
    case 'text':
      return quote(v);
    case 'number':
      if (!NUMBER_RE.test(v.trim())) throw new Error(`“${v}” is not a number`);
      return v.trim();
    case 'list':
      return v
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '')
        .map(auto)
        .join(', ') || 'NULL';
    default:
      return auto(v);
  }
}

/** Replace every {{name}} with values[name] as a typed literal. */
export function substitute(sql, engine, values, kinds = {}) {
  return tokenize(sql, engine)
    .map((t) => (t.t === 'var' ? toLiteral(values[t.v.slice(2, -2).trim()], kinds[t.v.slice(2, -2).trim()] || 'auto', engine) : t.v))
    .join('');
}

// ------------------------------------------------------------------ Monaco: colours + completion

const registry = new Map(); // model uri → () => { engine, tables, columns }
let installed = false;

const unquote = (s) => s.replace(/^[`"]|[`"]$/g, '');

/** Table name for an alias used in the statement ("FROM orders o" → o → orders). */
function resolveAlias(text, alias) {
  const re = /\b(?:from|join|update|into)\s+((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)(?:\s+(?:as\s+)?([`"]?[\w$]+[`"]?))?/gi;
  let m;
  const a = alias.toLowerCase();
  while ((m = re.exec(text))) {
    const full = m[1].split('.').map(unquote);
    const name = full[full.length - 1];
    if ((m[2] && unquote(m[2]).toLowerCase() === a) || name.toLowerCase() === a) return name;
  }
  return null;
}

function tablesInText(text) {
  const out = new Set();
  const re = /\b(?:from|join|update|into)\s+((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)/gi;
  let m;
  while ((m = re.exec(text))) out.add(unquote(m[1].split('.').pop()).toLowerCase());
  return out;
}

export function installSqlLanguage(monaco) {
  if (installed) return;
  installed = true;
  const K = monaco.languages.CompletionItemKind;
  const snippets = [
    ['sel', 'SELECT * FROM ${1:table} WHERE ${2:condition} LIMIT ${3:100};', 'SELECT … WHERE … LIMIT'],
    ['selc', 'SELECT ${1:column}, COUNT(*) AS n FROM ${2:table} GROUP BY ${1:column} ORDER BY n DESC;', 'Count per value'],
    ['ins', 'INSERT INTO ${1:table} (${2:columns}) VALUES (${3:values});', 'INSERT'],
    ['upd', 'UPDATE ${1:table} SET ${2:column} = ${3:value} WHERE ${4:condition};', 'UPDATE … WHERE'],
    ['del', 'DELETE FROM ${1:table} WHERE ${2:condition};', 'DELETE … WHERE'],
    ['join', 'JOIN ${1:table} ${2:t} ON ${2:t}.${3:id} = ${4:other}.${5:t_id}', 'JOIN … ON'],
    ['today', "WHERE ${1:created_at} >= CURRENT_DATE", 'Rows from today'],
    ['range', "WHERE ${1:created_at} BETWEEN '{{from}}' AND '{{to}}'", 'Date range with variables'],
  ];
  const provider = {
    triggerCharacters: ['.'],
    provideCompletionItems(model, position) {
      const get = registry.get(model.uri.toString());
      if (!get) return { suggestions: [] };
      const ctx = get();
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      const before = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: word.startColumn });
      const full = model.getValue();
      const colsOf = (name) => ctx.columns.get(String(name).toLowerCase()) || [];
      const quoteIf = (s) => (/^[a-z_][a-z0-9_$]*$/i.test(s) ? s : engineQuote(ctx.engine, s));

      // "alias." / "table." → that table's columns.
      const dot = /([`"]?[\w$]+[`"]?)\.$/.exec(before);
      if (dot) {
        const t = resolveAlias(full, unquote(dot[1])) || unquote(dot[1]);
        return {
          suggestions: colsOf(t).map((c, i) => ({ label: c.name, kind: K.Field, detail: c.type, insertText: quoteIf(c.name), range, sortText: String(i).padStart(4, '0') })),
        };
      }
      const wantTable = /\b(from|join|into|update|table|truncate|describe|desc)\s+[`"\w$.]*$/i.test(before);
      const sugg = [];
      const used = tablesInText(full);
      for (const t of ctx.tables) {
        sugg.push({
          label: t.name,
          kind: /view/i.test(t.type || '') ? K.Interface : K.Struct,
          detail: `${/view/i.test(t.type || '') ? 'view' : 'table'}${t.schema && t.schema !== 'public' ? ` · ${t.schema}` : ''}${t.rows != null && t.rows >= 0 ? ` · ~${Number(t.rows).toLocaleString()} rows` : ''}`,
          insertText: quoteIf(t.name),
          range,
          sortText: `${wantTable ? '0' : '2'}${t.name}`,
        });
      }
      if (!wantTable) {
        const seen = new Set();
        for (const [tbl, cols] of ctx.columns) {
          const inQuery = used.has(tbl);
          for (const c of cols) {
            const key = `${c.name}`;
            if (!inQuery && (seen.has(key) || used.size)) continue;
            seen.add(key);
            sugg.push({ label: c.name, kind: K.Field, detail: `${c.type} · ${tbl}`, insertText: quoteIf(c.name), range, sortText: `${inQuery ? '0' : '3'}${c.name}` });
          }
        }
        for (const k of KEYWORDS) sugg.push({ label: k, kind: K.Keyword, insertText: k, range, sortText: `4${k}` });
        for (const f of [...FUNCTIONS.common, ...(FUNCTIONS[ctx.engine] || [])]) {
          sugg.push({ label: `${f}()`, filterText: f, kind: K.Function, insertText: `${f}($0)`, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range, sortText: `5${f}` });
        }
        for (const [label, body, detail] of snippets) {
          sugg.push({ label, kind: K.Snippet, detail, insertText: body, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range, sortText: `1${label}` });
        }
      }
      return { suggestions: sugg };
    },
  };
  for (const lang of ['mysql', 'pgsql']) monaco.languages.registerCompletionItemProvider(lang, provider);

  // Hover a table name → its columns.
  const hover = {
    provideHover(model, position) {
      const get = registry.get(model.uri.toString());
      const w = model.getWordAtPosition(position);
      if (!get || !w) return null;
      const ctx = get();
      const name = resolveAlias(model.getValue(), w.word) || w.word;
      const cols = ctx.columns.get(name.toLowerCase());
      const t = ctx.tables.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!cols || !t) return null;
      return {
        contents: [
          { value: `**${t.name}**${t.rows != null && t.rows >= 0 ? ` · ~${Number(t.rows).toLocaleString()} rows` : ''}` },
          { value: cols.slice(0, 40).map((c) => `\`${c.name}\` ${c.type}`).join('  \n') + (cols.length > 40 ? `  \n… ${cols.length - 40} more` : '') },
        ],
      };
    },
  };
  for (const lang of ['mysql', 'pgsql']) monaco.languages.registerHoverProvider(lang, hover);
}

function engineQuote(engine, s) {
  return engine === 'mysql' ? '`' + s.replace(/`/g, '``') + '`' : '"' + s.replace(/"/g, '""') + '"';
}

/** Connect a Monaco model to the schema it should complete from. Returns an unregister function. */
export function registerSchema(model, getContext) {
  const key = model.uri.toString();
  registry.set(key, getContext);
  return () => registry.delete(key);
}

// ------------------------------------------------------------------ what a query changes

const READ_VERBS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES', 'TABLE', 'WITH', 'USE', 'BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'END', 'SAVEPOINT', 'RELEASE', 'HELP', 'SET', 'CHECKSUM', 'FETCH', 'DECLARE', 'CLOSE', 'LISTEN', 'UNLISTEN']);
const DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'MERGE', 'UPSERT']);
const DANGER = new Set(['DROP', 'TRUNCATE', 'ALTER', 'RENAME', 'GRANT', 'REVOKE']);
const GENTLE = new Set(['INSERT', 'CREATE', 'ANALYZE', 'VACUUM', 'OPTIMIZE', 'COMMENT', 'REINDEX', 'REFRESH']);
// Functions that change server state even inside a SELECT.
const SIDE_EFFECT_FN = /\b(setval|nextval|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|lo_unlink|lo_import|lo_export|dblink_exec|pg_drop_replication_slot|pg_create_restore_point)\s*\(/i;

const VERB_LABEL = { INSERT: 'Insert rows into', UPDATE: 'Update rows in', DELETE: 'Delete rows from', REPLACE: 'Replace rows in', TRUNCATE: 'Empty', DROP: 'Drop', ALTER: 'Alter', CREATE: 'Create', RENAME: 'Rename', GRANT: 'Grant on', REVOKE: 'Revoke on' };

/**
 * The statements in sql that change something, with how risky each is:
 * [{ text, verb, table, severity: 'primary' | 'warn' | 'danger', noWhere, countSql, label }]
 * countSql (UPDATE / DELETE on one table) counts the rows the statement would touch.
 */
export function analyzeSql(sql, engine) {
  const out = [];
  for (const st of splitStatements(sql, engine)) {
    const tks = tokenize(st.text, engine).filter((t) => t.t !== 'ws' && t.t !== 'comment');
    if (!tks.length) continue;
    const W = tks.map((t) => (t.t === 'word' ? t.v.toUpperCase() : null));
    let verb = W[0] || '';
    let mutating;
    if (verb === 'EXPLAIN') {
      // EXPLAIN ANALYZE really runs the statement.
      const inner = W.find((w, i) => i > 0 && DML.has(w));
      mutating = W.slice(1, 5).includes('ANALYZE') && Boolean(inner);
      if (mutating) verb = inner;
    } else if (verb === 'WITH') {
      const inner = W.find((w) => DML.has(w));
      mutating = Boolean(inner) && !/\bFOR\s+UPDATE\b/i.test(st.text);
      if (mutating) verb = inner;
    } else if (verb === 'SET') {
      mutating = ['GLOBAL', 'PERSIST', 'PERSIST_ONLY', 'PASSWORD'].includes(W[1]);
    } else if (verb === 'SELECT') {
      mutating = SIDE_EFFECT_FN.test(st.text) || W.some((w, i) => w === 'INTO' && !['INSERT'].includes(W[i - 1]));
    } else mutating = !READ_VERBS.has(verb);
    if (!mutating) continue;

    const s = { text: st.text.trim(), verb, table: '', severity: 'warn', noWhere: false, countSql: '' };
    // Target table and WHERE clause of single-table UPDATE / DELETE.
    if (verb === 'UPDATE' || verb === 'DELETE') {
      let i = W.indexOf(verb);
      if (verb === 'DELETE') i = W[i + 1] === 'FROM' ? i + 1 : -1;
      const seg = (from, stops) => {
        let depth = 0;
        let k = from;
        for (; k < tks.length; k++) {
          const v = tks[k].v;
          if (v === '(') depth++;
          else if (v === ')') depth--;
          else if (depth === 0 && (stops.includes(W[k]) || v === ';')) break;
        }
        return k;
      };
      if (i >= 0) {
        let a = i + 1;
        while (['LOW_PRIORITY', 'QUICK', 'IGNORE', 'ONLY'].includes(W[a])) a++;
        const tEnd = seg(a, verb === 'UPDATE' ? ['SET'] : ['WHERE', 'ORDER', 'LIMIT', 'RETURNING', 'USING']);
        const tableToks = tks.slice(a, tEnd);
        // Words outside parentheses after the table (a sub-query's FROM doesn't count).
        const top = [];
        for (let k = tEnd, depth = 0; k < tks.length; k++) {
          if (tks[k].v === '(') depth++;
          else if (tks[k].v === ')') depth--;
          else if (depth === 0) top.push(W[k]);
        }
        const complex =
          !(W[0] === verb || W[0] === 'EXPLAIN') ||
          tableToks.some((t) => t.v === ',' || /^(JOIN|USING)$/i.test(t.v)) ||
          top.includes('USING') ||
          (verb === 'UPDATE' && top.includes('FROM'));
        if (tableToks.length) s.table = st.text.slice(tableToks[0].s, tableToks[tableToks.length - 1].e).trim();
        const wi = (() => {
          let depth = 0;
          for (let k = tEnd; k < tks.length; k++) {
            const v = tks[k].v;
            if (v === '(') depth++;
            else if (v === ')') depth--;
            else if (depth === 0 && W[k] === 'WHERE') return k;
          }
          return -1;
        })();
        s.noWhere = wi < 0;
        if (!complex && s.table) {
          let where = '';
          if (wi >= 0) {
            const wEnd = seg(wi + 1, ['ORDER', 'LIMIT', 'RETURNING']);
            if (wEnd > wi + 1) where = st.text.slice(tks[wi + 1].s, tks[wEnd - 1].e);
          }
          s.countSql = `SELECT COUNT(*) AS n FROM ${s.table}${where ? ` WHERE ${where}` : ''};`;
        }
      }
    } else if (verb === 'SELECT' || verb === 'SET') {
      s.label = verb === 'SET' ? 'Change a server setting' : /\bINTO\b/i.test(st.text) ? 'Write query results (SELECT … INTO)' : 'Call a function that changes the server';
    } else {
      // The object a statement works on: the first name after the verb and its keywords.
      const skip = new Set(['INTO', 'TABLE', 'IF', 'NOT', 'EXISTS', 'FROM', 'ONLY', 'OR', 'REPLACE', 'TEMPORARY', 'TEMP', 'UNIQUE', 'INDEX', 'VIEW', 'DATABASE', 'SCHEMA', 'MATERIALIZED', 'FUNCTION', 'PROCEDURE', 'TRIGGER', 'SEQUENCE', 'USER', 'ROLE', 'CONCURRENTLY', 'LOW_PRIORITY', 'IGNORE', 'DELAYED', 'ALL', 'PRIVILEGES', 'ON', 'CASCADE']);
      const t = tks.slice(1).find((x, k) => (x.t === 'word' || x.t === 'ident') && !skip.has(W[k + 1]));
      if (t) s.table = t.v;
      const kind = tks.slice(1, 4).map((x) => x.v.toUpperCase()).find((w) => ['TABLE', 'DATABASE', 'SCHEMA', 'INDEX', 'VIEW', 'USER', 'ROLE'].includes(w));
      if (kind && verb === 'DROP') s.label = `Drop ${kind.toLowerCase()}`;
    }
    s.severity = DANGER.has(verb) || ((verb === 'UPDATE' || verb === 'DELETE') && s.noWhere) ? 'danger' : GENTLE.has(verb) ? 'primary' : 'warn';
    s.label ||= VERB_LABEL[verb] || verb.charAt(0) + verb.slice(1).toLowerCase();
    out.push(s);
  }
  return out;
}

// ------------------------------------------------------------------ restore file inspection

/**
 * Read a .sql / .sql.gz file in the browser (streamed, never fully in memory) and summarise it:
 * { engine: 'mysql' | 'postgres' | null, tool, bytes, partial, creates, drops, data, other, dropsDatabase }
 * creates / drops / data are Sets of table names; data = tables that get rows (INSERT / COPY).
 */
export async function inspectSqlFile(file, { maxBytes = 512 * 1024 * 1024 } = {}) {
  let stream = file.stream();
  if (/\.gz$/i.test(file.name)) {
    if (typeof DecompressionStream === 'undefined') return null;
    stream = stream.pipeThrough(new DecompressionStream('gzip'));
  }
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  const r = { engine: null, tool: '', bytes: 0, partial: false, creates: new Set(), drops: new Set(), data: new Set(), truncates: new Set(), alters: new Set(), dropsDatabase: [], other: 0 };
  const name = (s) => s.replace(/[`"]/g, '').replace(/^public\./, '');
  const RX = /^(CREATE TABLE(?: IF NOT EXISTS)?|DROP TABLE(?: IF EXISTS)?|INSERT INTO|COPY|TRUNCATE(?: TABLE)?|ALTER TABLE(?: ONLY)?(?: IF EXISTS)?|DROP DATABASE(?: IF EXISTS)?|DROP SCHEMA(?: IF EXISTS)?|DELETE FROM|UPDATE|GRANT|REVOKE|CREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE|VIEW|TRIGGER))\s+([^\s(;,]+)/i;
  let rest = '';
  let inCopy = false;
  const line = (l) => {
    if (inCopy) {
      if (l === '\\.') inCopy = false;
      return;
    }
    if (!r.engine) {
      if (/^-- (MySQL|MariaDB) dump/i.test(l)) [r.engine, r.tool] = ['mysql', l.slice(3).trim()];
      else if (/^-- (PostgreSQL database dump|Dumped (by|from) (pg_dump|database version))/i.test(l)) [r.engine, r.tool] = ['postgres', 'pg_dump'];
    }
    if (/^-- Dumped by pg_dump version/i.test(l)) r.tool = l.slice(3).trim();
    const m = RX.exec(l);
    if (!m) return;
    const v = m[1].toUpperCase();
    const t = name(m[2]);
    if (v.startsWith('CREATE TABLE')) r.creates.add(t);
    else if (v.startsWith('DROP TABLE')) r.drops.add(t);
    else if (v === 'INSERT INTO') r.data.add(t);
    else if (v === 'COPY') {
      r.data.add(t);
      inCopy = /FROM stdin;\s*$/i.test(l);
    } else if (v.startsWith('TRUNCATE')) r.truncates.add(t);
    else if (v.startsWith('ALTER TABLE')) r.alters.add(t);
    else if (v.startsWith('DROP DATABASE') || v.startsWith('DROP SCHEMA')) r.dropsDatabase.push(t);
    else r.other++;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    r.bytes += value.length;
    const parts = (rest + value).split('\n');
    rest = parts.pop();
    for (const l of parts) line(l.replace(/\r$/, ''));
    if (r.bytes > maxBytes) {
      r.partial = true;
      await reader.cancel();
      break;
    }
  }
  if (rest) line(rest);
  return r;
}
