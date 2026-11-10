// Database panel: connection form, schema browser, SQL editor (Monaco, with autocomplete and
// {{variables}}), typed result grids, backups (SQL dumps), restores, insights and a DB shell.
import { $, $$, esc, rpc, uid, storage, toast, copyText, downloadBlob, msg, fmtBytes, fmtDuration, prefs } from './core.js';
import { TermSession } from './terminal.js';
import { icon } from './icons.js';
import { openModal, holdButton, confirmDialog, promptDialog } from './ui.js';
import { loadMonaco, themeName } from './codeeditor.js';
import { download, upload } from './transfers.js';
import { findVariables, substitute, toLiteral, formatSql, statementAt, installSqlLanguage, registerSchema, analyzeSql, inspectSqlFile } from './sqlkit.js';

const ENGINES = {
  mysql: { label: 'MySQL / MariaDB', sql: true, port: 3306, user: 'root', icon: 'database', tone: 'var(--mysql)' },
  postgres: { label: 'PostgreSQL', sql: true, port: 5432, user: 'postgres', icon: 'database', tone: 'var(--pg)' },
  mongo: { label: 'MongoDB', sql: false, port: 27017, user: '', icon: 'leaf', tone: 'var(--mongo)' },
  redis: { label: 'Redis', sql: false, port: 6379, user: '', icon: 'zap', tone: 'var(--redis)' },
};
const CAN_BACKUP = new Set(['mysql', 'postgres']);

const MAX_RENDER_ROWS = 1000;
const SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const DATE_TYPE_RE = /^(date|datetime|timestamp|timestamp without time zone|timestamp with time zone|timestamptz)$/i;

const ident = {
  mysql: (s) => '`' + String(s).replace(/`/g, '``') + '`',
  postgres: (s) => '"' + String(s).replace(/"/g, '""') + '"',
};
const literal = {
  mysql: (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`,
  postgres: (s) => `'${String(s).replace(/'/g, "''")}'`,
};

const SQL = {
  mysql: {
    version: 'SELECT VERSION() AS version;',
    databases: 'SHOW DATABASES;',
    schema:
      'SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS est_rows, DATA_LENGTH + INDEX_LENGTH AS bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME;\n' +
      'SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col, DATA_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION;',
    qualified: (t) => ident.mysql(t.name),
    structure: (t) => `SHOW FULL COLUMNS FROM ${ident.mysql(t.name)};\nSHOW INDEX FROM ${ident.mysql(t.name)};`,
    stats:
      "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Questions','Slow_queries','Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads');\n" +
      "SHOW VARIABLES WHERE Variable_name IN ('max_connections','version','version_comment');",
    activity:
      "SELECT ID AS id, USER AS user, HOST AS client, DB AS db, COMMAND AS command, TIME AS seconds, STATE AS state, LEFT(INFO, 600) AS query FROM information_schema.PROCESSLIST WHERE COMMAND NOT IN ('Sleep','Daemon','Binlog Dump') AND ID <> CONNECTION_ID() ORDER BY TIME DESC;",
    cancel: (id) => `KILL QUERY ${Number(id)};`,
    terminate: (id) => `KILL ${Number(id)};`,
  },
  postgres: {
    version: 'SELECT version();',
    databases: 'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1;',
    schema:
      "SELECT t.table_schema AS schema, t.table_name AS name, t.table_type AS type, CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END AS est_rows, CASE WHEN t.table_type = 'BASE TABLE' THEN pg_total_relation_size(c.oid) END AS bytes " +
      "FROM information_schema.tables t LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = t.table_schema LEFT JOIN pg_catalog.pg_class c ON c.relname = t.table_name AND c.relnamespace = n.oid " +
      "WHERE t.table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2;\n" +
      "SELECT table_schema AS schema, table_name AS tbl, column_name AS col, data_type AS type FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name, ordinal_position;",
    qualified: (t) => `${ident.postgres(t.schema)}.${ident.postgres(t.name)}`,
    structure: (t) =>
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = ${literal.postgres(t.schema)} AND table_name = ${literal.postgres(t.name)} ORDER BY ordinal_position;\n` +
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = ${literal.postgres(t.schema)} AND tablename = ${literal.postgres(t.name)};`,
    stats:
      "SELECT split_part(version(), ' on ', 1) AS version, extract(epoch FROM now() - pg_postmaster_start_time())::bigint AS uptime, (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend') AS connections, " +
      "current_setting('max_connections') AS max_connections, (SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND backend_type = 'client backend') AS active, pg_database_size(current_database()) AS bytes, " +
      '(SELECT round(100.0 * sum(blks_hit) / nullif(sum(blks_hit) + sum(blks_read), 0), 1) FROM pg_stat_database) AS cache_hit, (SELECT sum(xact_commit + xact_rollback) FROM pg_stat_database) AS transactions;',
    activity:
      "SELECT pid AS id, usename AS user, client_addr AS client, datname AS db, state AS command, extract(epoch FROM now() - query_start)::int AS seconds, wait_event_type AS state, left(query, 600) AS query FROM pg_stat_activity " +
      "WHERE state IS DISTINCT FROM 'idle' AND pid <> pg_backend_pid() AND backend_type = 'client backend' ORDER BY query_start NULLS LAST;",
    cancel: (id) => `SELECT pg_cancel_backend(${Number(id)});`,
    terminate: (id) => `SELECT pg_terminate_backend(${Number(id)});`,
  },
};

const VAR_KINDS = [
  ['auto', 'Auto', 'Numbers, NULL and TRUE/FALSE as they are; anything else becomes quoted text'],
  ['text', 'Text', 'Always quoted, e.g. a zip code like 00123'],
  ['number', 'Number', 'Must be a number'],
  ['list', 'List', 'Comma-separated values for IN (…); each one typed like Auto'],
  ['raw', 'Raw SQL', 'Inserted exactly as typed'],
];

// ------------------------------------------------------------------ output parsing

/** mysql/mariadb `--xml -vv`: "--------------\n<statement>\n--------------\n\n<body>" per statement. */
function parseMysql(out) {
  const parts = out.split(/^-{14}\r?\n/m);
  const blocks = [];
  for (let i = 1; i < parts.length; i += 2) blocks.push(parseMysqlBody(parts[i].trim(), parts[i + 1] || ''));
  if (!blocks.length && out.trim()) blocks.push(parseMysqlBody('', out));
  return blocks.filter((b) => b.columns.length || b.message || b.isResult);
}

function parseMysqlBody(statement, body) {
  const block = { statement, columns: [], rows: [], isResult: false, message: '' };
  let rest = body;
  const start = body.indexOf('<resultset');
  const endTag = '</resultset>';
  const end = body.lastIndexOf(endTag);
  if (start >= 0 && end > start) {
    const doc = new DOMParser().parseFromString(body.slice(start, end + endTag.length), 'application/xml');
    if (!doc.querySelector('parsererror')) {
      block.isResult = true;
      const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
      for (const row of doc.getElementsByTagName('row')) {
        const fields = [...row.getElementsByTagName('field')];
        if (!block.columns.length) block.columns = fields.map((f) => f.getAttribute('name'));
        block.rows.push(fields.map((f) => (f.getAttributeNS(XSI, 'nil') === 'true' ? null : f.textContent)));
      }
      const declStart = body.lastIndexOf('<?xml', start);
      rest = body.slice(0, declStart >= 0 ? declStart : start) + body.slice(end + endTag.length);
    }
  }
  block.message = rest
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== 'Bye')
    .join('\n');
  return block;
}

/** psql `-H`: <table> per result set, <p> for command tags (INSERT 0 1, UPDATE 3 ...). */
function parsePg(out, nullMarker) {
  const doc = new DOMParser().parseFromString(`<body>${out}</body>`, 'text/html');
  const blocks = [];
  const cell = (td) => {
    const raw = td.textContent;
    if (raw === nullMarker) return null;
    if (raw === '  ') return '';
    return raw.replace(/ /g, ' ');
  };
  for (const node of doc.body.childNodes) {
    if (node.nodeName === 'TABLE') {
      const trs = [...node.querySelectorAll('tr')];
      const columns = trs.length ? [...trs[0].querySelectorAll('th')].map((th) => th.textContent) : [];
      const rows = trs.slice(1).map((tr) => [...tr.querySelectorAll('td')].map(cell));
      blocks.push({ statement: '', columns, rows, isResult: true, message: '' });
    } else {
      const text = node.textContent.trim();
      if (text) blocks.push({ statement: '', columns: [], rows: [], isResult: false, message: text });
    }
  }
  return blocks;
}

export function parseResult(res) {
  return res.format === 'xml' ? parseMysql(res.output) : parsePg(res.output, res.nullMarker);
}

/** Result block → array of { column: value } objects. */
const objects = (b) => (b?.rows || []).map((r) => Object.fromEntries(b.columns.map((c, i) => [c, r[i]])));

// ------------------------------------------------------------------ typed values

const NUM_RE = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?([+-]\d{2}(:?\d{2})?|Z)?$/;
const BOOL_RE = /^(t|f|true|false)$/i;
const KIND_BADGE = { num: '123', text: 'abc', date: 'date', bool: 'bool', json: '{ }' };

/** Guess each column's kind from its values: num | date | bool | json | text. */
function detectKinds(columns, rows) {
  return columns.map((_, c) => {
    let seen = 0;
    const can = { num: true, date: true, bool: true, json: true };
    for (let r = 0; r < rows.length && seen < 400; r++) {
      const v = rows[r][c];
      if (v === null || v === '') continue;
      seen++;
      if (can.num && !NUM_RE.test(v)) can.num = false;
      if (can.date && !DATE_RE.test(v)) can.date = false;
      if (can.bool && !BOOL_RE.test(v)) can.bool = false;
      if (can.json && !(/^[[{]/.test(v) && /[\]}]$/.test(v))) can.json = false;
    }
    if (!seen) return 'text';
    return can.num ? 'num' : can.date ? 'date' : can.bool ? 'bool' : can.json ? 'json' : 'text';
  });
}

const isTrue = (v) => /^(t|true)$/i.test(v);

function cellHtml(v, kind, r, c) {
  if (v === null) return `<td data-r="${r}" data-c="${c}" class="null"><span>NULL</span></td>`;
  const s = String(v);
  const title = s.length > 40 ? ` title="${esc(s.slice(0, 600))}"` : '';
  if (kind === 'bool') return `<td data-r="${r}" data-c="${c}" class="bool"><span class="b-${isTrue(s) ? 'yes' : 'no'}">${isTrue(s) ? 'true' : 'false'}</span></td>`;
  if (kind === 'num') {
    const neg = s.startsWith('-');
    return `<td data-r="${r}" data-c="${c}" class="num${neg ? ' neg' : ''}"${title}>${esc(s)}</td>`;
  }
  if (kind === 'date') {
    const [d, t] = s.split(/[ T]/);
    return `<td data-r="${r}" data-c="${c}" class="date"${title}>${esc(d)}${t ? ` <span class="t">${esc(t)}</span>` : ''}</td>`;
  }
  return `<td data-r="${r}" data-c="${c}" class="${kind}"${title}>${esc(s.slice(0, 300))}</td>`;
}

function compareFor(kind) {
  if (kind === 'num') return (a, b) => Number(a) - Number(b);
  if (kind === 'bool') return (a, b) => Number(isTrue(a)) - Number(isTrue(b));
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return (a, b) => coll.compare(a, b);
}

function toCsv(columns, rows) {
  const q = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(q).join(','), ...rows.map((r) => r.map(q).join(','))].join('\r\n');
}

function jsonValue(v, kind) {
  if (v === null) return null;
  if (kind === 'num') {
    const n = Number(v);
    return Number.isSafeInteger(n) || (!Number.isInteger(n) && Number.isFinite(n)) ? n : v;
  }
  if (kind === 'bool') return isTrue(v);
  if (kind === 'json') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

const stampNow = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ------------------------------------------------------------------ panel

/**
 * opts: { target: 'container' | 'host', id?, name? }
 */
export class DbPanel {
  constructor(mount, opts) {
    this.opts = opts;
    this.mount = mount;
    this.autoPasswordUsers = [];
    this.connected = false;
    this.serverVersion = '';
    this.dbNames = [];
    this.tables = [];
    this.colRows = []; // [{ schema, tbl, col, type }]
    this.columns = new Map(); // lower table name → [{ name, type }]
    this.blocks = [];
    this.running = null;
    this.shell = null;
    this.mode = 'query';
    this.ed = null; // Monaco editor once loaded
    this.render();
    this.initEditor();
  }

  get engine() {
    return this.form.engine.value;
  }

  render() {
    const isHost = this.opts.target === 'host';
    const root = document.createElement('div');
    root.className = 'db';
    root.innerHTML = `
      <form class="db-conn" autocomplete="off">
        <label class="w-md">Engine <select name="engine" data-search="Search engines…">${Object.entries(ENGINES)
          .map(([k, e]) => `<option value="${k}" data-icon="${e.icon}" data-tone="${e.tone}" data-hint=":${e.port}" data-desc="${e.sql ? 'SQL editor, backups, insights, shell' : 'Interactive shell'}">${esc(e.label)}</option>`)
          .join('')}</select></label>
        <label class="w-md" ${isHost ? '' : 'hidden'}>Host <input name="host" placeholder="${isHost ? '127.0.0.1' : 'local socket'}" /></label>
        <label class="w-xs" ${isHost ? '' : 'hidden'}>Port <input name="port" type="number" min="1" max="65535" /></label>
        <label class="w-sm">User <input name="user" /></label>
        <label class="w-sm">Password <input name="password" type="password" autocomplete="new-password" /></label>
        <label class="w-sm">Database <input name="database" /></label>
        <button class="btn primary small" type="submit">${icon('plug')}Connect</button>
        <button class="btn ghost small db-more" type="button" title="Show host/port to connect over TCP">${isHost ? '' : 'TCP…'}</button>
        <div class="seg db-mode">
          <button type="button" data-mode="query" class="active">${icon('logs')}Query</button>
          <button type="button" data-mode="shell">${icon('terminal')}Shell</button>
        </div>
      </form>
      <div class="db-statusline">
        <span class="db-dot"></span>
        <span class="db-status muted tiny">${isHost ? 'Runs the mysql / psql / mongosh / redis-cli client installed on the SSH host.' : 'Runs the database client inside this container.'}</span>
        <span class="spacer"></span>
        <div class="db-tools">
          <button class="btn ghost small" type="button" data-tool="backup" disabled title="Download a .sql backup of the whole database, chosen tables or a date range">${icon('hardDriveDownload')}Backup</button>
          <button class="btn ghost small" type="button" data-tool="restore" disabled title="Run a .sql or .sql.gz file against a database">${icon('hardDriveUpload')}Restore</button>
          <button class="btn ghost small" type="button" data-tool="insights" disabled title="Server health, table sizes and running queries">${icon('activity')}Insights</button>
        </div>
      </div>
      <div class="db-query">
        <aside class="db-schema">
          <select class="db-dbs" title="Database" data-search="Search databases…"><option value="">(database)</option></select>
          <div class="search-box sm db-tfilter-box">${icon('search')}<input type="search" class="db-tfilter" placeholder="Filter tables" /></div>
          <div class="db-tables">${msg('Connect to browse tables.')}</div>
          <div class="db-schema-foot muted tiny"></div>
        </aside>
        <section class="db-main">
          <div class="db-editor-wrap">
            <div class="db-editor-head">
              <span class="db-lang"><span class="db-lang-dot"></span><span class="db-lang-name">SQL</span></span>
              <span class="db-curdb mono"></span>
              <span class="spacer"></span>
              <span class="db-keys hide-sm"><kbd>${isMac() ? '⌘' : 'Ctrl'}</kbd><kbd>↵</kbd> run <span class="sep">·</span> <kbd>⇧</kbd><kbd>${isMac() ? '⌘' : 'Ctrl'}</kbd><kbd>↵</kbd> statement <span class="sep">·</span> <code>{{name}}</code> variables</span>
            </div>
            <textarea class="db-editor" spellcheck="false" placeholder="SELECT * FROM users WHERE id = {{id}} LIMIT 10;"></textarea>
            <div class="db-monaco" hidden></div>
            <div class="db-actions">
              <button class="btn primary small db-run" type="button" title="Run everything, or the selected text">${icon('play')}Run</button>
              <button class="btn ghost small db-run-stmt" type="button" title="Run only the statement the cursor is in">${icon('chevronRight')}Statement</button>
              <button class="btn small danger-ghost db-cancel" type="button" hidden>${icon('stop')}Cancel</button>
              <span class="db-sep"></span>
              <button class="btn ghost small db-format" type="button" title="Format SQL (⇧⌥F)">${icon('wand')}Format</button>
              <button class="btn ghost small db-save" type="button" title="Save this query (${isMac() ? '⌘' : 'Ctrl+'}S)">${icon('bookmark')}Save</button>
              <select class="db-history" data-search="Search saved and recent queries…"><option value="" hidden>Saved &amp; recent…</option></select>
              <span class="spacer"></span>
              <span class="db-runinfo muted tiny"></span>
            </div>
          </div>
          <div class="db-split" title="Drag to resize the editor"></div>
          <div class="db-results"></div>
        </section>
      </div>
      <div class="db-shell" hidden>
        <div class="toolbar">
          <button class="btn ghost small db-shell-new" type="button">${icon('plus')}New session</button>
          <span class="muted tiny">Interactive client session. Transactions and session settings persist here.</span>
        </div>
        <div class="term-mount db-shell-mount"></div>
      </div>`;
    this.mount.appendChild(root);
    this.root = root;
    this.form = $('.db-conn', root);
    this.editor = $('.db-editor', root);

    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.connect();
    });
    this.form.engine.addEventListener('change', () => this.onEngineChange());
    this.form.user.addEventListener('input', () => this.updatePasswordHint());
    $('.db-more', root).addEventListener('click', () => {
      $$('[name=host], [name=port]', this.form).forEach((i) => (i.closest('label').hidden = false));
      $('.db-more', root).hidden = true;
    });
    if (isHost) $('.db-more', root).hidden = true;
    $$('.db-mode button', root).forEach((b) => b.addEventListener('click', () => this.setMode(b.dataset.mode)));
    $('.db-run', root).addEventListener('click', () => this.runEditor());
    $('.db-run-stmt', root).addEventListener('click', () => this.runStatement());
    $('.db-cancel', root).addEventListener('click', () => this.cancel());
    $('.db-format', root).addEventListener('click', () => this.format());
    $('.db-save', root).addEventListener('click', () => this.saveQuery());
    $('.db-shell-new', root).addEventListener('click', async () => {
      if (this.shell && !(await confirmDialog({ icon: 'terminal', title: 'Start a new database session?', message: 'The current shell is closed: anything still running in it is stopped and its scrollback is lost.', confirmLabel: 'New session' }))) return;
      this.openShell(true);
    });
    $('.db-dbs', root).addEventListener('change', (e) => {
      this.form.database.value = e.target.value;
      this.loadTables();
    });
    $('.db-tfilter', root).addEventListener('input', () => this.renderTables());
    $('.db-tables', root).addEventListener('click', (e) => this.onTableClick(e));
    $('.db-history', root).addEventListener('change', (e) => this.onHistoryPick(e.target));
    $$('[data-tool]', root).forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.tool === 'backup') this.openBackup();
        else if (b.dataset.tool === 'restore') this.openRestore();
        else this.openInsights();
      }),
    );
    const results = $('.db-results', root);
    results.addEventListener('click', (e) => this.onResultsClick(e));
    results.addEventListener('input', (e) => {
      const q = e.target.closest('[data-rs-q]');
      if (!q) return;
      const bi = Number(q.closest('[data-b]').dataset.b);
      clearTimeout(this.filterTimer);
      this.filterTimer = setTimeout(() => {
        this.blocks[bi].q = q.value.trim().toLowerCase();
        this.updateView(bi);
      }, 120);
    });
    results.addEventListener('dblclick', (e) => {
      const td = e.target.closest('td[data-r]');
      if (!td) return;
      const b = this.blocks[Number(td.closest('[data-b]').dataset.b)];
      const v = b?.rows[Number(td.dataset.r)]?.[Number(td.dataset.c)];
      copyText(v === null ? 'NULL' : String(v), 'Cell value copied');
    });
    this.editor.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) this.runStatement();
        else this.runEditor();
      } else if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: en, value } = this.editor;
        this.editor.value = value.slice(0, s) + '  ' + value.slice(en);
        this.editor.selectionStart = this.editor.selectionEnd = s + 2;
      }
    });
    this.initSplitter();
    this.onEngineChange(true);

    this.draftKey = `sdc.dbdraft.${this.opts.target === 'host' ? 'host' : this.opts.name || this.opts.id}`;
    this.editor.value = storage.get(this.draftKey, '');
    this.editor.addEventListener('input', () => this.saveDraft());
  }

  show(v) {
    this.root.hidden = !v;
    if (v && this.mode === 'shell') this.shell?.show(true);
    if (v) this.ed?.layout();
  }

  // ---------------------------------------------------------------- editor

  async initEditor() {
    let monaco;
    try {
      monaco = await loadMonaco();
    } catch {
      return; // the plain textarea keeps working
    }
    if (!this.root.isConnected && !this.mount.isConnected) return;
    installSqlLanguage(monaco);
    this.monaco = monaco;
    const box = $('.db-monaco', this.root);
    box.style.height = `${storage.get('sdc.dbEditorH', 190)}px`;
    box.hidden = false;
    this.editor.hidden = true;
    const model = monaco.editor.createModel(this.editor.value, this.monacoLang(), monaco.Uri.from({ scheme: 'sdc-sql', path: `/${uid('q')}.sql` }));
    const ed = monaco.editor.create(box, {
      model,
      theme: themeName(),
      automaticLayout: true,
      fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: Number(prefs.get('fontSize')) || 13,
      lineHeight: 1.6,
      minimap: { enabled: false },
      lineNumbers: 'on',
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 8,
      glyphMargin: false,
      folding: true,
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active', indentation: false },
      matchBrackets: 'always',
      fixedOverflowWidgets: true,
      tabSize: 2,
      padding: { top: 10, bottom: 10 },
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      quickSuggestions: { other: true, comments: false, strings: false },
      suggest: { showWords: false, preview: true },
      acceptSuggestionOnEnter: 'smart',
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: false },
      placeholder: 'SELECT * FROM users WHERE id = {{id}} LIMIT 10;',
    });
    this.ed = ed;
    this.model = model;
    const { KeyMod, KeyCode } = monaco;
    ed.addAction({ id: 'sdc.run', label: 'Run query', keybindings: [KeyMod.CtrlCmd | KeyCode.Enter], run: () => this.runEditor() });
    ed.addAction({ id: 'sdc.runStatement', label: 'Run statement at cursor', keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter], run: () => this.runStatement() });
    ed.addAction({ id: 'sdc.format', label: 'Format SQL', keybindings: [KeyMod.Shift | KeyMod.Alt | KeyCode.KeyF], contextMenuGroupId: '1_modification', run: () => this.format() });
    ed.addAction({ id: 'sdc.save', label: 'Save query', keybindings: [KeyMod.CtrlCmd | KeyCode.KeyS], run: () => this.saveQuery() });
    this.unregister = registerSchema(model, () => ({ engine: this.engine, tables: this.tables, columns: this.columns }));
    this.varDecorations = ed.createDecorationsCollection();
    model.onDidChangeContent(() => {
      this.saveDraft();
      this.decorateVariables();
    });
    this.decorateVariables();
  }

  monacoLang() {
    return this.engine === 'postgres' ? 'pgsql' : 'mysql';
  }

  sqlText() {
    return this.ed ? this.model.getValue() : this.editor.value;
  }

  setSql(text, { run = false } = {}) {
    if (this.ed) {
      this.ed.pushUndoStop();
      this.ed.executeEdits('sdc', [{ range: this.model.getFullModelRange(), text }]);
      this.ed.pushUndoStop();
      this.ed.setPosition(this.model.getPositionAt(text.length));
    } else this.editor.value = text;
    this.saveDraft();
    if (run) this.run(text, { remember: false });
  }

  selectedText() {
    if (this.ed) return this.model.getValueInRange(this.ed.getSelection());
    const { selectionStart: s, selectionEnd: e, value } = this.editor;
    return s !== e ? value.slice(s, e) : '';
  }

  cursorOffset() {
    return this.ed ? this.model.getOffsetAt(this.ed.getPosition()) : this.editor.selectionStart;
  }

  focusEditor() {
    (this.ed || this.editor).focus();
  }

  saveDraft() {
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => storage.set(this.draftKey, this.sqlText().slice(0, 100000)), 400);
  }

  decorateVariables() {
    if (!this.ed) return;
    const text = this.model.getValue();
    const decos = [];
    const re = /\{\{\s*[A-Za-z_]\w*\s*\}\}/g;
    let m;
    while ((m = re.exec(text)) && decos.length < 200) {
      const s = this.model.getPositionAt(m.index);
      const e = this.model.getPositionAt(m.index + m[0].length);
      decos.push({ range: new this.monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column), options: { inlineClassName: 'sql-var', hoverMessage: { value: 'Variable: you are asked for its value when the query runs.' } } });
    }
    this.varDecorations.set(decos);
  }

  format() {
    const sel = this.selectedText();
    if (this.ed && sel) {
      const range = this.ed.getSelection();
      this.ed.pushUndoStop();
      this.ed.executeEdits('sdc', [{ range, text: formatSql(sel, this.engine) }]);
      this.ed.pushUndoStop();
    } else {
      const text = this.sqlText();
      if (!text.trim()) return;
      this.setSql(formatSql(text, this.engine) + (/;\s*$/.test(text) ? '' : ''));
    }
    this.focusEditor();
  }

  initSplitter() {
    const bar = $('.db-split', this.root);
    bar.addEventListener('pointerdown', (e) => {
      const box = $('.db-monaco', this.root);
      if (box.hidden) return;
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      const startY = e.clientY;
      const startH = box.offsetHeight;
      document.body.classList.add('resizing-v');
      const move = (ev) => {
        const h = Math.max(90, Math.min(innerHeight * 0.7, startH + ev.clientY - startY));
        box.style.height = `${h}px`;
      };
      const up = () => {
        bar.removeEventListener('pointermove', move);
        document.body.classList.remove('resizing-v');
        storage.set('sdc.dbEditorH', box.offsetHeight);
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up, { once: true });
      bar.addEventListener('pointercancel', up, { once: true });
    });
  }

  // ---------------------------------------------------------------- connection

  /** Container: fetch auto-detected credentials and connect straight away. */
  async init() {
    if (this.opts.target !== 'container' || this.initialized) return;
    this.initialized = true;
    this.status('Detecting database settings…');
    try {
      const d = await rpc('db.defaults', { id: this.opts.id });
      this.autoPasswordUsers = d.autoPasswordUsers || [];
      if (d.engine) this.form.engine.value = d.engine;
      this.onEngineChange(true);
      this.form.user.value = d.user || '';
      this.form.database.value = d.database || '';
      this.updatePasswordHint();
      if (ENGINES[this.engine].sql) await this.connect();
      else this.setMode('shell');
    } catch (err) {
      this.status(err.message, true);
    }
  }

  onEngineChange(silent) {
    const engine = this.engine;
    const e = ENGINES[engine];
    if (!silent || !this.form.user.value) this.form.user.value = e.user;
    this.form.port.placeholder = String(e.port);
    if (this.opts.target === 'host' && !this.form.host.value) this.form.host.value = '127.0.0.1';
    this.form.database.placeholder = engine === 'redis' ? 'db index (0)' : engine === 'mongo' ? 'database' : '';
    $('.db-mode [data-mode=query]', this.root).disabled = !e.sql;
    if (!e.sql && this.mode === 'query') this.setMode('shell', true);
    this.root.dataset.engine = engine;
    $('.db-lang-name', this.root).textContent = engine === 'postgres' ? 'PostgreSQL' : engine === 'mysql' ? 'MySQL' : 'SQL';
    if (this.ed) this.monaco.editor.setModelLanguage(this.model, this.monacoLang());
    this.updatePasswordHint();
    this.setConnected(false);
  }

  setConnected(v) {
    this.connected = v;
    const sql = ENGINES[this.engine].sql;
    $$('[data-tool]', this.root).forEach((b) => (b.disabled = !v || !sql || (b.dataset.tool !== 'insights' && !CAN_BACKUP.has(this.engine))));
    this.root.classList.toggle('is-connected', v);
  }

  updatePasswordHint() {
    const user = this.form.user.value || (this.engine === 'redis' ? 'default' : '');
    const known = this.autoPasswordUsers.includes(user);
    this.form.password.placeholder = known ? 'from container env' : this.opts.target === 'container' ? 'none' : '';
  }

  params() {
    const f = this.form;
    const p = {
      engine: f.engine.value,
      user: f.user.value.trim(),
      database: f.database.value.trim(),
      host: f.host.value.trim(),
      port: f.port.value,
    };
    if (f.password.value) p.password = f.password.value;
    if (this.opts.target === 'host') p.target = 'host';
    else {
      p.target = 'container';
      p.id = this.opts.id;
    }
    return p;
  }

  status(text, isError = false, ok = false) {
    const el = $('.db-status', this.root);
    el.textContent = text;
    el.classList.toggle('err', isError);
    el.classList.toggle('ok', ok);
    const dot = $('.db-dot', this.root);
    dot.className = `db-dot${isError ? ' err' : ok ? ' ok' : ''}`;
  }

  /** Run SQL with the panel's connection settings. opts.database overrides the database. */
  async query(sql, { timeout, database } = {}) {
    const p = this.params();
    if (database !== undefined) p.database = database;
    const res = await rpc('db.query', { ...p, sql, timeout });
    const blocks = parseResult(res);
    if (res.code !== 0 && res.error) {
      const err = new Error(res.error);
      err.blocks = blocks;
      throw err;
    }
    return { res, blocks };
  }

  async connect() {
    this.updatePasswordHint();
    const engine = this.engine;
    if (!ENGINES[engine].sql) {
      this.setMode('shell');
      this.openShell(true);
      return;
    }
    this.status('Connecting…');
    try {
      const { blocks } = await this.query(SQL[engine].version, { timeout: 30 });
      const v = blocks.find((b) => b.rows.length)?.rows[0][0] || '';
      this.serverVersion = String(v).split(' on ')[0].split(',')[0];
      this.setConnected(true);
      this.status(`Connected · ${this.serverVersion}`, false, true);
      this.setMode(this.mode === 'shell' ? 'shell' : 'query');
      await this.loadDatabases();
      await this.loadTables();
      this.focusEditor();
    } catch (err) {
      this.setConnected(false);
      this.status(`Connection failed: ${err.message.split('\n')[0]}`, true);
      $('.db-results', this.root).innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
    }
  }

  async loadDatabases() {
    const engine = this.engine;
    const sel = $('.db-dbs', this.root);
    try {
      const { blocks } = await this.query(SQL[engine].databases);
      const names = (blocks.find((b) => b.columns.length)?.rows || []).map((r) => r[0]);
      this.dbNames = names;
      const cur = this.form.database.value;
      const user = names.filter((n) => !SYSTEM_DBS.has(n));
      const sys = names.filter((n) => SYSTEM_DBS.has(n));
      sel.innerHTML =
        `<option value="">${engine === 'mysql' ? '(no database)' : '(default)'}</option>` +
        (user.length ? `<optgroup label="Databases">${user.map((n) => `<option value="${esc(n)}" data-icon="database" data-tone="${ENGINES[engine].tone}">${esc(n)}</option>`).join('')}</optgroup>` : '') +
        (sys.length ? `<optgroup label="System">${sys.map((n) => `<option value="${esc(n)}" data-icon="settings">${esc(n)}</option>`).join('')}</optgroup>` : '');
      if (cur && !names.includes(cur)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(cur)}">${esc(cur)}</option>`);
      sel.value = cur;
    } catch (err) {
      sel.innerHTML = `<option>${esc(err.message.slice(0, 60))}</option>`;
    }
  }

  /** Tables (with size and row estimates) and columns of a database. */
  async fetchSchema(database) {
    const engine = this.engine;
    const { blocks } = await this.query(SQL[engine].schema, database !== undefined ? { database } : {});
    const sets = blocks.filter((b) => b.columns.length || b.isResult);
    const tb = objects(sets[0]);
    const cb = objects(sets[1]);
    const tables = tb.map((r) => ({
      schema: r.schema ?? null,
      name: r.name,
      type: r.type,
      rows: r.est_rows != null && r.est_rows !== '' ? Number(r.est_rows) : null,
      bytes: r.bytes != null && r.bytes !== '' ? Number(r.bytes) : null,
    }));
    const colRows = cb.map((r) => ({ schema: r.schema ?? null, tbl: r.tbl, col: r.col, type: r.type }));
    return { tables, colRows };
  }

  async loadTables() {
    const engine = this.engine;
    const box = $('.db-tables', this.root);
    $('.db-curdb', this.root).textContent = this.form.database.value || '';
    if (engine === 'mysql' && !this.form.database.value) {
      this.tables = [];
      this.colRows = [];
      this.columns = new Map();
      box.innerHTML = msg('Pick a database above.');
      $('.db-schema-foot', this.root).textContent = '';
      return;
    }
    box.innerHTML = msg('Loading…');
    try {
      const { tables, colRows } = await this.fetchSchema();
      this.tables = tables;
      this.colRows = colRows;
      this.columns = new Map();
      for (const c of colRows) {
        const k = String(c.tbl).toLowerCase();
        if (!this.columns.has(k)) this.columns.set(k, []);
        this.columns.get(k).push({ name: c.col, type: c.type });
      }
      this.renderTables();
    } catch (err) {
      box.innerHTML = `<div class="alert error inset">${esc(err.message)}</div>`;
    }
  }

  renderTables() {
    const q = $('.db-tfilter', this.root).value.trim().toLowerCase();
    const list = this.tables.filter((t) => !q || `${t.schema || ''}.${t.name}`.toLowerCase().includes(q));
    const box = $('.db-tables', this.root);
    const total = this.tables.reduce((n, t) => n + (t.bytes || 0), 0);
    $('.db-schema-foot', this.root).textContent = this.tables.length ? `${this.tables.length} table${this.tables.length === 1 ? '' : 's'}${total ? ` · ${fmtBytes(total)}` : ''}` : '';
    if (!list.length) {
      box.innerHTML = msg(this.tables.length ? 'No tables match.' : 'No tables in this database.');
      return;
    }
    const schemas = new Set(list.map((t) => t.schema));
    const canBackup = CAN_BACKUP.has(this.engine);
    let lastSchema;
    box.innerHTML = list
      .map((t) => {
        const i = this.tables.indexOf(t);
        const head = schemas.size > 1 && t.schema !== lastSchema ? `<div class="group-label">${esc(t.schema)}</div>` : '';
        lastSchema = t.schema;
        const isView = /view/i.test(t.type || '');
        const tip = `${t.name}${t.rows != null ? ` · ~${t.rows.toLocaleString()} rows` : ''}${t.bytes ? ` · ${fmtBytes(t.bytes)}` : ''} · click to preview`;
        return `${head}<div class="db-table" data-i="${i}" title="${esc(tip)}">
          <span class="db-ticon${isView ? ' is-view' : ''}">${icon(isView ? 'eye' : 'table')}</span>
          <span class="db-tname">${esc(t.name)}</span>
          ${t.rows != null ? `<span class="db-trows">${esc(compact(t.rows))}</span>` : ''}
          <span class="db-tacts">
            <button class="icon-btn db-tinfo" data-i="${i}" title="Columns and indexes">${icon('info')}</button>
            ${canBackup ? `<button class="icon-btn db-tbackup" data-i="${i}" title="Back up this table">${icon('download')}</button>` : ''}
          </span>
        </div>`;
      })
      .join('');
  }

  onTableClick(e) {
    const item = e.target.closest('.db-table');
    if (!item) return;
    const t = this.tables[Number(item.dataset.i)];
    if (e.target.closest('.db-tbackup')) return this.openBackup({ table: t });
    const info = e.target.closest('.db-tinfo');
    const engine = this.engine;
    $$('.db-table.active', this.root).forEach((x) => x.classList.remove('active'));
    item.classList.add('active');
    const sql = info ? SQL[engine].structure(t) : `SELECT * FROM ${SQL[engine].qualified(t)} LIMIT 100;`;
    this.setSql(sql);
    this.run(sql, { remember: false });
  }

  // ---------------------------------------------------------------- running SQL

  runEditor() {
    const sel = this.selectedText();
    this.run(sel.trim() ? sel : this.sqlText());
  }

  runStatement() {
    const text = this.sqlText();
    const st = statementAt(text, this.cursorOffset(), this.engine);
    if (!st) return toast('Write a query first');
    if (this.ed) {
      const s = this.model.getPositionAt(st.start + (st.text.length - st.text.trimStart().length));
      const e = this.model.getPositionAt(st.end);
      const range = new this.monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column);
      const flash = this.ed.createDecorationsCollection([{ range, options: { className: 'sql-flash', isWholeLine: false } }]);
      setTimeout(() => flash.clear(), 700);
    }
    this.run(st.text);
  }

  /** Ask for {{variable}} values. Resolves the SQL with typed literals, or null if cancelled. */
  askVariables(sql, names) {
    const engine = this.engine;
    const savedVals = storage.get('sdc.dbvars', {});
    return new Promise((resolve) => {
      let done = false;
      const { el, close } = openModal({
        title: names.length === 1 ? 'Value for the variable' : `Values for ${names.length} variables`,
        size: 'wide',
        onClose: () => !done && resolve(null),
        content: `
          <p class="muted tiny vars-intro">Type values as they are: <b>42</b> stays a number, <b>hello</b> becomes <code>'hello'</code>, <b>null</b>/<b>true</b> stay keywords. No quotes or casts needed.</p>
          <div class="vars">${names
            .map(
              (n, i) => `<div class="var-row">
                <label class="var-name mono" for="var-${i}">{{${esc(n)}}}</label>
                <input id="var-${i}" data-var="${esc(n)}" value="${esc(savedVals[n]?.v ?? '')}" spellcheck="false" autocomplete="off" />
                <select data-kind="${esc(n)}" data-search="Search types…">${VAR_KINDS.map(([k, l, d]) => `<option value="${k}" data-desc="${esc(d)}"${(savedVals[n]?.k || 'auto') === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
              </div>`,
            )
            .join('')}</div>
          <div class="vars-preview"><div class="muted tiny">Runs as</div><pre class="mono"></pre></div>
          <div class="modal-actions"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>${icon('play')}Run</button></div>`,
      });
      const values = () => {
        const v = {};
        const k = {};
        for (const n of names) {
          v[n] = $(`[data-var="${CSS.escape(n)}"]`, el).value;
          k[n] = $(`[data-kind="${CSS.escape(n)}"]`, el).value;
        }
        return { v, k };
      };
      const preview = () => {
        const { v, k } = values();
        let text;
        try {
          text = esc(substitute(sql, engine, v, k));
          $('[data-ok]', el).disabled = false;
        } catch (err) {
          text = `<span class="err">${esc(err.message)}</span>`;
          $('[data-ok]', el).disabled = true;
        }
        $('.vars-preview pre', el).innerHTML = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
      };
      const ok = () => {
        const { v, k } = values();
        let out;
        try {
          out = substitute(sql, engine, v, k);
        } catch (err) {
          return toast(err.message, 'error');
        }
        const store = storage.get('sdc.dbvars', {});
        for (const n of names) store[n] = { v: v[n], k: k[n] };
        storage.set('sdc.dbvars', store);
        done = true;
        close();
        resolve(out);
      };
      el.addEventListener('input', preview);
      el.addEventListener('change', preview);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.matches('input[data-var]')) {
          e.preventDefault();
          ok();
        }
      });
      $('[data-x]', el).addEventListener('click', () => close());
      $('[data-ok]', el).addEventListener('click', ok);
      preview();
      const first = $('input[data-var]', el);
      first.focus();
      first.select();
    });
  }

  async run(sql, { remember = true } = {}) {
    if (!sql.trim()) return toast('Write a query first');
    if (this.running) return toast('A query is already running');
    const original = sql;
    const vars = findVariables(sql, this.engine);
    if (vars.length) {
      sql = await this.askVariables(sql, vars);
      if (sql == null) return;
    }
    // Anything that changes data, structure, users or settings is confirmed first.
    const changes = analyzeSql(sql, this.engine);
    if (changes.length && !(await this.confirmChanges(changes))) return;
    const token = uid('q');
    this.running = token;
    $('.db-run', this.root).disabled = true;
    $('.db-run-stmt', this.root).disabled = true;
    $('.db-cancel', this.root).hidden = false;
    const info = $('.db-runinfo', this.root);
    info.innerHTML = '<span class="db-spin"></span>Running…';
    const resultsEl = $('.db-results', this.root);
    resultsEl.classList.add('busy');
    try {
      const res = await rpc('db.query', { ...this.params(), sql, token });
      if (this.running !== token) return;
      this.blocks = parseResult(res);
      this.lastSql = sql;
      const sets = this.blocks.filter((b) => b.isResult).length;
      const total = this.blocks.reduce((n, b) => n + b.rows.length, 0);
      info.innerHTML = `<span class="${res.code === 0 ? 'ok' : 'err'}">${icon(res.code === 0 ? 'check' : 'error')}</span>${res.ms.toLocaleString()} ms · ${sets} result set${sets === 1 ? '' : 's'} · ${total.toLocaleString()} row${total === 1 ? '' : 's'}${res.truncated ? ' · output truncated (30 MB)' : ''}`;
      this.renderResults(res.code !== 0 ? res.error || `Exited with code ${res.code}` : '');
      if (remember) this.remember(original);
      if (/\b(create|drop|alter|rename|truncate)\b/i.test(sql)) this.loadTables();
    } catch (err) {
      info.textContent = '';
      resultsEl.innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
    } finally {
      if (this.running === token) this.running = null;
      resultsEl.classList.remove('busy');
      $('.db-run', this.root).disabled = false;
      $('.db-run-stmt', this.root).disabled = false;
      $('.db-cancel', this.root).hidden = true;
    }
  }

  /** Where queries run, for confirmations: "container shop-db" or "127.0.0.1:5432 (from the SSH host)". */
  whereLabel() {
    if (this.opts.target === 'host') return `${this.form.host.value || 'localhost'}${this.form.port.value ? `:${this.form.port.value}` : ''} (from the SSH host)`;
    return `container ${this.opts.name || this.opts.id}`;
  }

  /**
   * Confirm statements that change something: what, where, as whom, warnings for the dangerous
   * ones (no WHERE, DROP, TRUNCATE…) and, for UPDATE / DELETE, how many rows they would touch
   * (counted with the same WHERE before anything runs).
   */
  confirmChanges(changes) {
    const engine = this.engine;
    const sev = changes.some((c) => c.severity === 'danger') ? 'danger' : changes.some((c) => c.severity === 'warn') ? 'warn' : 'primary';
    const one = changes.length === 1 ? changes[0] : null;
    const warnings = [];
    for (const c of changes) {
      if ((c.verb === 'UPDATE' || c.verb === 'DELETE') && c.noWhere) warnings.push(`${c.verb} without WHERE: every row in ${c.table} will be ${c.verb === 'DELETE' ? 'deleted' : 'changed'}.`);
      if (c.verb === 'DROP') warnings.push(`${c.label} ${c.table}: it is removed with everything in it. Only a backup can bring it back.`);
      if (c.verb === 'TRUNCATE') warnings.push(`TRUNCATE ${c.table}: every row is removed at once.`);
    }
    if (engine === 'mysql' && changes.some((c) => ['DROP', 'ALTER', 'TRUNCATE', 'RENAME', 'CREATE'].includes(c.verb))) warnings.push('MySQL applies structure changes immediately; they cannot be rolled back.');
    const countable = changes.filter((c) => c.countSql).slice(0, 5);
    const pending = countable.length
      ? (async () => {
          const facts = [];
          for (const c of countable) {
            try {
              const { blocks } = await this.query(c.countSql, { timeout: 20 });
              const n = Number(blocks.find((b) => b.rows.length)?.rows[0][0]);
              const what = c.verb === 'DELETE' ? 'Rows to delete' : 'Rows to update';
              facts.push([changes.length > 1 ? `${what} in ${c.table}` : what, `${n.toLocaleString()}${c.noWhere ? ' (all of them)' : ''}`, n === 0 ? 'muted' : n > 1000 ? 'big' : '']);
            } catch {
              facts.push([`Rows in ${c.table}`, 'could not be counted']);
            }
          }
          return { facts };
        })()
      : null;
    return confirmDialog({
      tone: sev,
      icon: sev === 'danger' ? 'trash' : 'database',
      title: one ? `${one.label}${one.table ? ` ${one.table}` : ''}?` : `Run ${changes.length} statements that change the database?`,
      message: one ? 'This statement changes the database.' : `${changes.length} of the statements change the database.`,
      facts: [
        ['Database', `${this.form.database.value || '(default)'} · ${ENGINES[engine].label}`],
        ['Where', this.whereLabel()],
        ['As user', this.form.user.value || '(default)'],
      ],
      warnings,
      detail: changes.map((c, i) => `${changes.length > 1 ? `${i + 1}. ` : ''}${c.text.replace(/\s+/g, ' ').slice(0, 240)}${c.text.length > 240 ? '…' : ''}`).join('\n'),
      pending,
      confirmLabel: 'Run',
    });
  }

  async cancel() {
    if (!this.running) return;
    const token = this.running;
    this.running = null;
    await rpc('db.cancel', { token }).catch(() => {});
    $('.db-runinfo', this.root).textContent = 'Cancelled (the server may finish the statement in the background).';
    $('.db-run', this.root).disabled = false;
    $('.db-run-stmt', this.root).disabled = false;
    $('.db-cancel', this.root).hidden = true;
    $('.db-results', this.root).classList.remove('busy');
  }

  // ---------------------------------------------------------------- results

  renderResults(error) {
    const parts = [];
    if (error) parts.push(`<div class="alert error">${esc(error)}</div>`);
    this.blocks.forEach((b, bi) => {
      const stmt = b.statement ? `<code class="db-stmt" title="${esc(b.statement)}">${esc(b.statement.slice(0, 120))}</code>` : '';
      if (!b.columns.length) {
        const text = b.message || (b.isResult ? 'Empty set' : 'OK');
        parts.push(`<div class="rs-msg"><span class="ok">${icon('check')}</span> ${esc(text).replace(/\n/g, ' · ')} ${stmt}</div>`);
        return;
      }
      b.kinds = detectKinds(b.columns, b.rows);
      b.q = '';
      b.sort = null;
      b.view = b.rows.map((_, i) => i);
      parts.push(`
        <div class="rs" data-b="${bi}">
          <div class="rs-head">
            <span class="rs-count"><strong>${b.rows.length.toLocaleString()}</strong> row${b.rows.length === 1 ? '' : 's'}</span>
            ${stmt}
            <span class="spacer"></span>
            ${b.rows.length > 1 ? `<div class="search-box xs">${icon('search')}<input type="search" data-rs-q placeholder="Filter rows" /></div>` : ''}
            <div class="rs-export">
              <button class="btn ghost small" data-act="csv" title="Download as CSV">${icon('download')}CSV</button>
              <button class="btn ghost small" data-act="json" title="Download as JSON (numbers, booleans and JSON keep their types)">JSON</button>
              <button class="btn ghost small" data-act="sql" title="Download as INSERT statements">SQL</button>
              <button class="btn ghost small" data-act="copy" title="Copy as TSV, ready to paste into a spreadsheet">${icon('copy')}</button>
            </div>
          </div>
          <div class="grid-wrap"></div>
          <div class="muted tiny rs-foot" hidden></div>
        </div>`);
    });
    if (!parts.length) parts.push(msg('Query finished with no output.'));
    $('.db-results', this.root).innerHTML = parts.join('');
    this.blocks.forEach((b, bi) => b.columns.length && this.renderGrid(bi));
  }

  updateView(bi) {
    const b = this.blocks[bi];
    let view = b.rows.map((_, i) => i);
    if (b.q) view = view.filter((i) => b.rows[i].some((v) => v !== null && String(v).toLowerCase().includes(b.q)));
    if (b.sort) {
      const { c, dir } = b.sort;
      const cmp = compareFor(b.kinds[c]);
      view.sort((x, y) => {
        const a = b.rows[x][c];
        const z = b.rows[y][c];
        if (a === null && z === null) return 0;
        if (a === null) return 1;
        if (z === null) return -1;
        return cmp(a, z) * dir;
      });
    }
    b.view = view;
    this.renderGrid(bi);
  }

  renderGrid(bi) {
    const b = this.blocks[bi];
    const el = $(`.rs[data-b="${bi}"]`, this.root);
    if (!el) return;
    const shown = b.view.slice(0, MAX_RENDER_ROWS);
    const arrow = (ci) => (b.sort?.c === ci ? (b.sort.dir > 0 ? '▲' : '▼') : '');
    $('.grid-wrap', el).innerHTML = `<table class="grid">
      <thead><tr><th class="rn">#</th>${b.columns
        .map((c, ci) => `<th data-sort="${ci}" class="k-${b.kinds[ci]}${b.sort?.c === ci ? ' sorted' : ''}" title="Sort by ${esc(c)}"><span class="th-in"><span class="th-name">${esc(c)}</span><span class="kind">${KIND_BADGE[b.kinds[ci]]}</span><span class="th-sort">${arrow(ci)}</span></span></th>`)
        .join('')}</tr></thead>
      <tbody>${shown.map((ri) => `<tr><td class="rn" data-row="${ri}" title="Show this row">${ri + 1}</td>${b.rows[ri].map((v, ci) => cellHtml(v, b.kinds[ci], ri, ci)).join('')}</tr>`).join('')}</tbody>
    </table>${shown.length ? '' : msg('No rows match the filter.')}`;
    const foot = $('.rs-foot', el);
    const notes = [];
    if (b.q) notes.push(`${b.view.length.toLocaleString()} of ${b.rows.length.toLocaleString()} rows match`);
    if (b.view.length > MAX_RENDER_ROWS) notes.push(`showing the first ${MAX_RENDER_ROWS.toLocaleString()}; exports include all ${b.view.length.toLocaleString()}`);
    foot.textContent = notes.join(' · ');
    foot.hidden = !notes.length;
  }

  onResultsClick(e) {
    const blockEl = e.target.closest('[data-b]');
    if (!blockEl) return;
    const bi = Number(blockEl.dataset.b);
    const b = this.blocks[bi];
    if (!b) return;
    const th = e.target.closest('th[data-sort]');
    if (th) {
      const c = Number(th.dataset.sort);
      b.sort = b.sort?.c !== c ? { c, dir: 1 } : b.sort.dir > 0 ? { c, dir: -1 } : null;
      return this.updateView(bi);
    }
    const rn = e.target.closest('td.rn[data-row]');
    if (rn) return this.openRow(b, Number(rn.dataset.row));
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const rows = b.view.map((i) => b.rows[i]);
    const base = `${(this.form.database.value || 'query').replace(/[^\w.-]/g, '_')}-${stampNow()}`;
    if (btn.dataset.act === 'csv') downloadBlob(`${base}.csv`, toCsv(b.columns, rows), 'text/csv');
    else if (btn.dataset.act === 'json') {
      const data = rows.map((r) => Object.fromEntries(b.columns.map((c, i) => [c, jsonValue(r[i], b.kinds[i])])));
      downloadBlob(`${base}.json`, JSON.stringify(data, null, 2), 'application/json');
    } else if (btn.dataset.act === 'sql') {
      downloadBlob(`${base}.sql`, this.insertStatements(b, rows), 'application/sql');
    } else {
      const tsv = [b.columns.join('\t'), ...rows.map((r) => r.map((v) => (v === null ? 'NULL' : String(v).replace(/[\t\n]/g, ' '))).join('\t'))].join('\n');
      copyText(tsv, `Copied ${rows.length.toLocaleString()} rows`);
    }
  }

  insertStatements(b, rows) {
    const engine = this.engine;
    const q = ident[engine] || ident.mysql;
    const m = /\bfrom\s+((?:[`"]?[\w$]+[`"]?\.)?[`"]?[\w$]+[`"]?)/i.exec(b.statement || this.lastSql || '');
    const table = m ? m[1] : 'exported_rows';
    const cols = b.columns.map(q).join(', ');
    const lit = (v, kind) => {
      if (v === null) return 'NULL';
      if (kind === 'num') return String(v);
      if (kind === 'bool' && engine === 'postgres') return isTrue(v) ? 'TRUE' : 'FALSE';
      return toLiteral(v, 'text', engine);
    };
    return `-- ${rows.length} row(s) exported from ssh-console on ${new Date().toISOString()}\n${rows.map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map((v, i) => lit(v, b.kinds[i])).join(', ')});`).join('\n')}\n`;
  }

  openRow(b, ri) {
    const row = b.rows[ri];
    const { el } = openModal({
      title: `Row ${ri + 1}`,
      size: 'wide',
      content: `<div class="row-detail">${b.columns
        .map((c, i) => {
          const v = row[i];
          const kind = b.kinds[i];
          let shown;
          if (v === null) shown = '<span class="null">NULL</span>';
          else if (kind === 'json') {
            try {
              shown = `<pre>${esc(JSON.stringify(JSON.parse(v), null, 2))}</pre>`;
            } catch {
              shown = `<pre>${esc(v)}</pre>`;
            }
          } else shown = `<span class="v k-${kind}">${esc(v)}</span>`;
          return `<div class="rd-row"><div class="rd-k"><span class="mono">${esc(c)}</span><span class="kind">${KIND_BADGE[kind]}</span></div><div class="rd-v">${shown}</div><button class="icon-btn" data-copy="${i}" title="Copy value">${icon('copy')}</button></div>`;
        })
        .join('')}</div>
        <div class="modal-actions"><button class="btn ghost" data-json>${icon('copy')}Copy as JSON</button></div>`,
    });
    el.addEventListener('click', (e) => {
      const c = e.target.closest('[data-copy]');
      if (c) {
        const v = row[Number(c.dataset.copy)];
        copyText(v === null ? 'NULL' : String(v), 'Value copied');
      }
      if (e.target.closest('[data-json]')) copyText(JSON.stringify(Object.fromEntries(b.columns.map((c2, i) => [c2, jsonValue(row[i], b.kinds[i])])), null, 2), 'Row copied as JSON');
    });
  }

  // ---------------------------------------------------------------- saved queries + history

  history() {
    return storage.get('sdc.dbhistory', []).filter((h) => h.engine === this.engine);
  }

  saved() {
    return storage.get('sdc.dbsaved', []).filter((h) => h.engine === this.engine);
  }

  remember(sql) {
    const engine = this.engine;
    const all = storage.get('sdc.dbhistory', []).filter((h) => !(h.engine === engine && h.sql === sql));
    all.unshift({ engine, sql, at: Date.now() });
    storage.set('sdc.dbhistory', all.slice(0, 100));
    this.renderHistory();
  }

  async saveQuery() {
    const sql = (this.selectedText().trim() ? this.selectedText() : this.sqlText()).trim();
    if (!sql) return toast('Write a query first');
    const guess = sql.replace(/\s+/g, ' ').slice(0, 40);
    const name = await promptDialog({ title: 'Save query', message: 'Saved queries are listed first in the Saved & recent menu, for this database engine.', label: 'Name', value: guess, confirmLabel: 'Save' });
    if (!name) return;
    const engine = this.engine;
    const all = storage.get('sdc.dbsaved', []).filter((h) => !(h.engine === engine && h.name === name));
    all.unshift({ engine, name, sql, at: Date.now() });
    storage.set('sdc.dbsaved', all.slice(0, 200));
    this.renderHistory();
    toast(`Saved “${name}”`, 'success');
  }

  renderHistory() {
    const sel = $('.db-history', this.root);
    const preview = (s) => esc(s.replace(/\s+/g, ' ').slice(0, 90));
    const saved = this.saved();
    const hist = this.history().slice(0, 40);
    sel.innerHTML =
      '<option value="" hidden>Saved &amp; recent…</option>' +
      (saved.length ? `<optgroup label="Saved">${saved.map((h, i) => `<option value="s:${i}" data-icon="bookmark" data-desc="${preview(h.sql)}">${esc(h.name)}</option>`).join('')}</optgroup>` : '') +
      (hist.length ? `<optgroup label="Recent">${hist.map((h, i) => `<option value="h:${i}" data-hint="${esc(ago(h.at))}">${preview(h.sql)}</option>`).join('')}</optgroup>` : '') +
      (saved.length || hist.length ? `<optgroup label="Manage"><option value="manage" data-icon="settings">Manage saved queries…</option>${hist.length ? '<option value="clear" data-icon="trash">Clear recent queries</option>' : ''}</optgroup>` : '');
  }

  onHistoryPick(sel) {
    const v = sel.value;
    sel.value = '';
    if (!v) return;
    if (v === 'manage') return this.manageSaved();
    if (v === 'clear') {
      return confirmDialog({ title: 'Clear recent queries?', message: `The ${this.history().length} recent ${ENGINES[this.engine].label} queries are removed from this browser. Saved queries stay.`, confirmLabel: 'Clear', icon: 'trash' }).then((ok) => {
        if (!ok) return;
        storage.set('sdc.dbhistory', storage.get('sdc.dbhistory', []).filter((h) => h.engine !== this.engine));
        this.renderHistory();
        toast('Recent queries cleared');
      });
    }
    const [kind, i] = v.split(':');
    const h = (kind === 's' ? this.saved() : this.history())[Number(i)];
    if (h) this.setSql(h.sql);
    this.focusEditor();
  }

  manageSaved() {
    const { el } = openModal({ title: 'Saved queries', size: 'wide', content: '<div class="saved-q"></div>' });
    const draw = () => {
      const list = this.saved();
      $('.saved-q', el).innerHTML = list.length
        ? list
            .map(
              (h, i) => `<div class="sq-row"><div class="sq-main"><strong>${esc(h.name)}</strong><code>${esc(h.sql.replace(/\s+/g, ' ').slice(0, 160))}</code></div>
                <button class="btn ghost small" data-open="${i}">Open</button><button class="icon-btn" data-del="${i}" title="Delete">${icon('trash')}</button></div>`,
            )
            .join('')
        : msg('No saved queries yet. Use Save (⌘S) in the editor.');
    };
    el.addEventListener('click', (e) => {
      const o = e.target.closest('[data-open]');
      const d = e.target.closest('[data-del]');
      const list = this.saved();
      if (o) {
        this.setSql(list[Number(o.dataset.open)].sql);
        el.querySelector('[data-close]').click();
      } else if (d) {
        const h = list[Number(d.dataset.del)];
        confirmDialog({ title: `Delete saved query “${h.name}”?`, detail: h.sql.slice(0, 400), confirmLabel: 'Delete', icon: 'trash' }).then((ok) => {
          if (!ok) return;
          storage.set('sdc.dbsaved', storage.get('sdc.dbsaved', []).filter((x) => !(x.engine === h.engine && x.name === h.name)));
          draw();
          this.renderHistory();
        });
      }
    });
    draw();
  }

  // ---------------------------------------------------------------- backup

  async openBackup({ table } = {}) {
    const engine = this.engine;
    if (!CAN_BACKUP.has(engine)) return toast('Backups are available for MySQL/MariaDB and PostgreSQL', 'warn');
    if (!this.connected) return toast('Connect to the database first', 'warn');
    const pref = storage.get('sdc.dbbackup', {});
    const userDbs = this.dbNames.filter((n) => !SYSTEM_DBS.has(n));
    let db = this.form.database.value || userDbs[0] || '';
    if (!db) return toast('Pick a database first', 'warn');
    const allDbs = [...new Set([db, ...userDbs, ...this.dbNames])];
    const tkey = (t) => (t.schema ? `${t.schema}.${t.name}` : t.name);

    const st = {
      scope: table ? 'tables' : 'all',
      selected: new Set(table ? [tkey(table)] : []),
      content: pref.content || 'all',
      range: false,
      meta: null,
      opts: { gzip: !!pref.gzip, drop: pref.drop !== false, routines: pref.routines !== false, events: !!pref.events, createDb: !!pref.createDb, noOwner: pref.noOwner !== false, inserts: !!pref.inserts },
    };
    const check = (k, label, desc) =>
      `<label class="opt"><input type="checkbox" data-opt="${k}"${st.opts[k] ? ' checked' : ''} /><span><strong>${label}</strong><small>${desc}</small></span></label>`;
    const optsHtml =
      check('gzip', 'Compress (.sql.gz)', 'Smaller file, compressed on the server before it is sent') +
      check('drop', 'Add DROP statements', 'Restoring replaces existing tables with the same names') +
      (engine === 'mysql'
        ? check('routines', 'Stored procedures & functions', 'Triggers are always included with their tables') +
          check('events', 'Scheduled events', 'Needs the EVENT privilege') +
          check('createDb', 'CREATE DATABASE + USE', 'The file creates and selects the database itself')
        : check('noOwner', 'Skip owners & privileges', 'Restores cleanly as any user (recommended)') + check('inserts', 'INSERT statements instead of COPY', 'Slower to restore, but readable by more tools'));

    const { el, close } = openModal({
      title: 'Back up database',
      size: 'xl',
      content: `
        <div class="bk">
          <div class="bk-col">
            <section class="bk-sec">
              <h4>${icon('database')}Database</h4>
              <select data-bk-db data-search="Search databases…">${allDbs.map((n) => `<option value="${esc(n)}" data-icon="${SYSTEM_DBS.has(n) ? 'settings' : 'database'}" data-tone="${SYSTEM_DBS.has(n) ? 'var(--muted)' : ENGINES[engine].tone}"${n === db ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
            </section>
            <section class="bk-sec">
              <h4>${icon('table')}What to back up</h4>
              <div class="seg" data-bk-scope><button type="button" data-v="all">Whole database</button><button type="button" data-v="tables">Choose tables</button></div>
              <div class="bk-tables-wrap" hidden>
                <div class="bk-tbar">
                  <div class="search-box xs">${icon('search')}<input type="search" data-bk-tq placeholder="Filter tables" /></div>
                  <button type="button" class="btn ghost small" data-bk-all>All</button>
                  <button type="button" class="btn ghost small" data-bk-none>None</button>
                </div>
                <div class="bk-tables"></div>
              </div>
              <div class="bk-whole muted tiny"></div>
            </section>
            <section class="bk-sec">
              <h4>${icon('settings')}Options</h4>
              <div class="bk-opts">${optsHtml}</div>
            </section>
          </div>
          <div class="bk-col">
            <section class="bk-sec">
              <h4>${icon('layers')}Content</h4>
              <div class="seg" data-bk-content><button type="button" data-v="all">Structure + data</button><button type="button" data-v="schema">Structure only</button><button type="button" data-v="data">Data only</button></div>
            </section>
            <section class="bk-sec">
              <label class="opt range-toggle"><input type="checkbox" data-bk-range /><span><strong>Only rows in a date range</strong><small>Off: every row is backed up</small></span></label>
              <div class="bk-range" hidden>
                <label>Date column <select data-bk-col data-search="Search date columns…"></select></label>
                <div class="bk-dates" data-range-group>
                  <label>From <input type="date" data-bk-from data-range="start" placeholder="Start date" /></label>
                  <span class="bk-arrow">${icon('arrowRight')}</span>
                  <label>To (inclusive) <input type="date" data-bk-to data-range="end" placeholder="End date" /></label>
                </div>
                <div class="chips" data-bk-presets>
                  <button type="button" data-p="today">Today</button><button type="button" data-p="7">Last 7 days</button><button type="button" data-p="30">Last 30 days</button>
                  <button type="button" data-p="month">This month</button><button type="button" data-p="lastmonth">Last month</button><button type="button" data-p="year">This year</button><button type="button" data-p="lastyear">Last year</button>
                </div>
                <label>Tables without this column <select data-bk-others>
                  <option value="full" data-desc="Every row of those tables is included" ${pref.others === 'full' || !pref.others ? 'selected' : ''}>Back up all their rows</option>
                  <option value="schema" data-desc="Their CREATE statements only" ${pref.others === 'schema' ? 'selected' : ''}>Structure only</option>
                  <option value="skip" data-desc="Only tables with the date column are in the file" ${pref.others === 'skip' ? 'selected' : ''}>Leave them out</option>
                </select></label>
                <p class="muted tiny">Dates use the database server's time zone; the end date is included. Rows are filtered table by table: related rows in other tables (foreign keys) are not followed.</p>
              </div>
            </section>
          </div>
        </div>
        <div class="bk-summary"></div>
        <div class="modal-actions"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-go>${icon('download')}Download backup</button></div>`,
    });

    const segSet = (sel, v) => $$(`${sel} button`, el).forEach((b) => b.classList.toggle('active', b.dataset.v === v));
    segSet('[data-bk-scope]', st.scope);
    segSet('[data-bk-content]', st.content);

    const chosen = () => (st.scope === 'all' ? st.meta?.tables || [] : (st.meta?.tables || []).filter((t) => st.selected.has(tkey(t))));
    const dateCols = () => {
      const pool = new Set(chosen().filter((t) => !/view/i.test(t.type || '')).map(tkey));
      const map = new Map();
      for (const c of st.meta?.colRows || []) {
        if (!DATE_TYPE_RE.test(c.type || '')) continue;
        const k = c.schema ? `${c.schema}.${c.tbl}` : c.tbl;
        if (!pool.has(k)) continue;
        if (!map.has(c.col)) map.set(c.col, { col: c.col, tables: [], types: new Set() });
        map.get(c.col).tables.push(k);
        map.get(c.col).types.add(c.type);
      }
      return [...map.values()].sort((a, b) => b.tables.length - a.tables.length || score(b.col) - score(a.col) || a.col.localeCompare(b.col));
    };
    const score = (n) => (/^(created|inserted|added)(_at|_on|_date|at)?$/i.test(n) ? 3 : /created|date|time|_at$|_on$/i.test(n) ? 1 : 0);

    const renderTables = () => {
      const q = $('[data-bk-tq]', el).value.trim().toLowerCase();
      const list = (st.meta?.tables || []).filter((t) => !q || tkey(t).toLowerCase().includes(q));
      const maxBytes = Math.max(1, ...(st.meta?.tables || []).map((t) => t.bytes || 0));
      $('.bk-tables', el).innerHTML = list.length
        ? list
            .map((t) => {
              const k = tkey(t);
              const isView = /view/i.test(t.type || '');
              return `<label class="bk-t${st.selected.has(k) ? ' on' : ''}">
                <input type="checkbox" data-t="${esc(k)}"${st.selected.has(k) ? ' checked' : ''} />
                <span class="bk-tn mono">${isView ? `${icon('eye')}` : ''}${esc(k)}</span>
                <span class="bk-tr">${t.rows != null ? esc(compact(t.rows)) : ''}</span>
                <span class="bk-ts"><span class="bk-bar" style="--w:${Math.round(((t.bytes || 0) / maxBytes) * 100)}%"></span>${t.bytes ? esc(fmtBytes(t.bytes)) : ''}</span>
              </label>`;
            })
            .join('')
        : msg(st.meta ? 'No tables match.' : 'Loading tables…');
    };
    const renderCols = () => {
      const cols = dateCols();
      const sel = $('[data-bk-col]', el);
      const cur = sel.value || pref.column;
      const total = chosen().filter((t) => !/view/i.test(t.type || '')).length;
      sel.innerHTML = cols.length
        ? cols.map((c) => `<option value="${esc(c.col)}" data-icon="calendar" data-desc="${esc(`in ${c.tables.length} of ${total} table${total === 1 ? '' : 's'}: ${c.tables.slice(0, 4).join(', ')}${c.tables.length > 4 ? '…' : ''}`)}" data-hint="${esc([...c.types].join(', '))}">${esc(c.col)}</option>`).join('')
        : '<option value="">No date or timestamp columns in the chosen tables</option>';
      if (cols.some((c) => c.col === cur)) sel.value = cur;
    };
    const summary = () => {
      const tables = chosen();
      const all = st.meta?.tables || [];
      const bytes = tables.reduce((n, t) => n + (t.bytes || 0), 0);
      const lines = [];
      lines.push(`<b>${esc(db)}</b> · ${st.scope === 'all' ? `whole database (${all.length} table${all.length === 1 ? '' : 's'}${engine === 'mysql' ? ', views and routines' : ', views, functions and types'})` : `${tables.length} of ${all.length} tables`}${bytes ? ` · about ${esc(fmtBytes(bytes))} on disk` : ''}`);
      lines.push({ all: 'Structure and data', schema: 'Structure only (no rows)', data: 'Data only (no CREATE statements)' }[st.content]);
      const rng = st.range && st.content !== 'schema';
      let problem = '';
      if (st.scope === 'tables' && !tables.length) problem = 'Choose at least one table.';
      if (rng) {
        const col = $('[data-bk-col]', el).value;
        const from = $('[data-bk-from]', el).value;
        const to = $('[data-bk-to]', el).value;
        const info = dateCols().find((c) => c.col === col);
        if (!col) problem ||= 'None of the chosen tables has a date or timestamp column.';
        else if (!from && !to) problem ||= 'Choose a start date, an end date, or both.';
        else if (from && to && from > to) problem ||= 'The start date is after the end date.';
        else {
          const others = $('[data-bk-others]', el).value;
          const otherCount = tables.filter((t) => !/view/i.test(t.type || '')).length - info.tables.length;
          lines.push(`Rows where <code>${esc(col)}</code> is ${from && to ? `from <b>${esc(from)}</b> to <b>${esc(to)}</b>` : from ? `on or after <b>${esc(from)}</b>` : `on or before <b>${esc(to)}</b>`} in ${info.tables.length} table${info.tables.length === 1 ? '' : 's'}${otherCount > 0 ? `; ${otherCount} other table${otherCount === 1 ? '' : 's'}: ${{ full: 'all rows', schema: 'structure only', skip: 'left out' }[others]}` : ''}`);
        }
      } else if (st.content !== 'schema') lines.push('All rows');
      const fname = `${db}${st.scope === 'tables' ? (tables.length === 1 ? `-${tables[0].name}` : `-${tables.length}-tables`) : ''}${st.content === 'schema' ? '-schema' : st.content === 'data' ? '-data' : ''}${rng && !problem ? `-${$('[data-bk-from]', el).value || 'start'}_to_${$('[data-bk-to]', el).value || 'now'}` : ''}-…${st.opts.gzip ? '.sql.gz' : '.sql'}`.replace(/[^\w.…-]+/g, '_');
      $('.bk-summary', el).innerHTML = `
        <div class="bk-sum-icon">${icon(problem ? 'alert' : 'archive')}</div>
        <div class="bk-sum-text">${lines.map((l) => `<div>${l}</div>`).join('')}${problem ? `<div class="err">${esc(problem)}</div>` : `<div class="muted mono tiny">${esc(fname)}</div>`}</div>`;
      $('.bk-summary', el).classList.toggle('bad', !!problem);
      $('[data-go]', el).disabled = !!problem || !st.meta;
      $('.bk-whole', el).textContent = st.scope === 'all' && st.meta ? `${all.length} tables${bytes ? ` · ${fmtBytes(bytes)}` : ''}` : '';
    };
    const refresh = () => {
      $('.bk-tables-wrap', el).hidden = st.scope !== 'tables';
      $('.bk-whole', el).hidden = st.scope !== 'all';
      $('.bk-range', el).hidden = !st.range || st.content === 'schema';
      $('[data-bk-range]', el).disabled = st.content === 'schema';
      $('[data-bk-range]', el).closest('.opt').classList.toggle('disabled', st.content === 'schema');
      renderTables();
      renderCols();
      summary();
    };
    const loadMeta = async () => {
      st.meta = null;
      refresh();
      try {
        st.meta = db === this.form.database.value && this.tables.length ? { tables: this.tables, colRows: this.colRows } : await this.fetchSchema(db);
      } catch (err) {
        $('.bk-tables', el).innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
        st.meta = { tables: [], colRows: [] };
      }
      refresh();
    };

    $('[data-bk-db]', el).addEventListener('change', (e) => {
      db = e.target.value;
      st.selected.clear();
      loadMeta();
    });
    $('[data-bk-scope]', el).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      st.scope = b.dataset.v;
      segSet('[data-bk-scope]', st.scope);
      refresh();
    });
    $('[data-bk-content]', el).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      st.content = b.dataset.v;
      segSet('[data-bk-content]', st.content);
      refresh();
    });
    $('[data-bk-tq]', el).addEventListener('input', renderTables);
    $('.bk-tables', el).addEventListener('change', (e) => {
      const c = e.target.closest('[data-t]');
      if (!c) return;
      if (c.checked) st.selected.add(c.dataset.t);
      else st.selected.delete(c.dataset.t);
      c.closest('.bk-t').classList.toggle('on', c.checked);
      renderCols();
      summary();
    });
    const bulk = (on) => {
      const q = $('[data-bk-tq]', el).value.trim().toLowerCase();
      for (const t of st.meta?.tables || []) if (!q || tkey(t).toLowerCase().includes(q)) (on ? st.selected.add(tkey(t)) : st.selected.delete(tkey(t)));
      refresh();
    };
    $('[data-bk-all]', el).addEventListener('click', () => bulk(true));
    $('[data-bk-none]', el).addEventListener('click', () => bulk(false));
    $('[data-bk-range]', el).addEventListener('change', (e) => {
      st.range = e.target.checked;
      if (st.range && !$('[data-bk-from]', el).value && !$('[data-bk-to]', el).value) preset('30');
      refresh();
    });
    for (const s of ['[data-bk-col]', '[data-bk-from]', '[data-bk-to]', '[data-bk-others]']) $(s, el).addEventListener('change', summary);
    // Picking a date by hand: no preset is active any more.
    for (const s of ['[data-bk-from]', '[data-bk-to]'])
      $(s, el).addEventListener('input', () => {
        $$('[data-bk-presets] button', el).forEach((b) => b.classList.toggle('active', false));
        summary();
      });
    const preset = (p) => {
      const now = new Date();
      const y = now.getFullYear();
      const m = now.getMonth();
      const day = (d) => localDate(d);
      let from;
      let to = day(now);
      if (p === 'today') from = to;
      else if (p === '7' || p === '30') from = day(new Date(y, m, now.getDate() - Number(p) + 1));
      else if (p === 'month') from = day(new Date(y, m, 1));
      else if (p === 'lastmonth') {
        from = day(new Date(y, m - 1, 1));
        to = day(new Date(y, m, 0));
      } else if (p === 'year') from = day(new Date(y, 0, 1));
      else if (p === 'lastyear') {
        from = day(new Date(y - 1, 0, 1));
        to = day(new Date(y - 1, 11, 31));
      }
      $('[data-bk-from]', el).value = from;
      $('[data-bk-to]', el).value = to;
      $$('[data-bk-presets] button', el).forEach((b) => b.classList.toggle('active', b.dataset.p === p));
      summary();
    };
    $('[data-bk-presets]', el).addEventListener('click', (e) => {
      const b = e.target.closest('[data-p]');
      if (b) preset(b.dataset.p);
    });
    $('.bk-opts', el).addEventListener('change', (e) => {
      const c = e.target.closest('[data-opt]');
      if (!c) return;
      st.opts[c.dataset.opt] = c.checked;
      summary();
    });
    $('[data-x]', el).addEventListener('click', () => close());
    $('[data-go]', el).addEventListener('click', async () => {
      const tables = chosen();
      const rng = st.range && st.content !== 'schema';
      const col = $('[data-bk-col]', el).value;
      const others = $('[data-bk-others]', el).value;
      const info = rng ? dateCols().find((c) => c.col === col) : null;
      const split = (k) => {
        const t = (st.meta.tables || []).find((x) => tkey(x) === k);
        return { schema: t?.schema || undefined, name: t?.name || k };
      };
      const payload = {
        what: 'dbdump',
        ...this.params(),
        database: db,
        tables: st.scope === 'tables' ? tables.map((t) => ({ schema: t.schema || undefined, name: t.name })) : null,
        options: {
          content: st.content,
          ...st.opts,
          dateFilter: rng && info ? { column: col, from: $('[data-bk-from]', el).value, to: $('[data-bk-to]', el).value, others, tables: info.tables.map(split) } : null,
        },
      };
      const all = st.meta.tables || [];
      const bytes = tables.reduce((n, t) => n + (t.bytes || 0), 0);
      const ok = await confirmDialog({
        icon: 'hardDriveDownload',
        title: `Back up ${db}?`,
        message: 'A consistent snapshot is read from the database and saved to your Downloads folder. Nothing in the database is changed.',
        facts: [
          ['Database', `${db} · ${ENGINES[engine].label}`],
          ['Where', this.whereLabel()],
          ['Backs up', st.scope === 'all' ? `the whole database (${all.length} tables)` : `${tables.length} of ${all.length} tables: ${tables.slice(0, 6).map((t) => t.name).join(', ')}${tables.length > 6 ? '…' : ''}`],
          ['Content', { all: 'structure and data', schema: 'structure only', data: 'data only' }[st.content]],
          rng && info ? ['Rows', `${col} from ${$('[data-bk-from]', el).value || 'the start'} to ${$('[data-bk-to]', el).value || 'today'} (${info.tables.length} table${info.tables.length === 1 ? '' : 's'}); other tables: ${{ full: 'all rows', schema: 'structure only', skip: 'left out' }[others]}`] : null,
          ['Size on disk', bytes ? `about ${fmtBytes(bytes)}${st.opts.gzip ? ', compressed while downloading' : ''}` : '—'],
          ['File', $('.bk-summary .mono', el)?.textContent || `${db}.sql`],
        ],
        warnings: st.content !== 'schema' && bytes > 2 * 1024 ** 3 ? ['This is a large database: the backup can take a while and reads every row.'] : [],
        confirmLabel: 'Start backup',
      });
      if (!ok) return;
      storage.set('sdc.dbbackup', { ...st.opts, content: st.content, others, column: col || pref.column });
      download(payload, { name: `${db}.sql${st.opts.gzip ? '.gz' : ''}` });
      toast(`Backing up ${db}… progress is shown above`, 'info');
      close();
    });

    await loadMeta();
  }

  // ---------------------------------------------------------------- restore

  openRestore() {
    const engine = this.engine;
    if (!CAN_BACKUP.has(engine)) return toast('Restores are available for MySQL/MariaDB and PostgreSQL', 'warn');
    if (!this.connected) return toast('Connect to the database first', 'warn');
    const userDbs = this.dbNames.filter((n) => !SYSTEM_DBS.has(n));
    const db0 = this.form.database.value || userDbs[0] || '';
    const allDbs = [...new Set([db0, ...userDbs, ...this.dbNames].filter(Boolean))];
    let file = null;
    const { el, close } = openModal({
      title: 'Restore from a SQL file',
      size: 'wide',
      content: `
        <label class="drop" data-drop>
          <input type="file" accept=".sql,.gz,application/sql,application/gzip" hidden data-file />
          <span class="drop-icon">${icon('uploadFile')}</span>
          <span class="drop-text"><strong>Drop a .sql or .sql.gz file here</strong><small>or click to choose one. Compressed files are unpacked on the server.</small></span>
        </label>
        <div class="rs-form">
          <label>Into database <select data-rs-db data-search="Search databases…">${allDbs.map((n) => `<option value="${esc(n)}" data-icon="database" data-tone="${ENGINES[engine].tone}"${n === db0 ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
          <label class="opt"><input type="checkbox" data-rs-stop checked /><span><strong>Stop at the first error</strong><small>Otherwise errors are skipped and the rest of the file still runs</small></span></label>
          ${engine === 'postgres' ? '<label class="opt"><input type="checkbox" data-rs-tx checked /><span><strong>All or nothing</strong><small>One transaction: if anything fails, nothing is changed</small></span></label>' : ''}
        </div>
        <div class="rs-scan" hidden></div>
        <div class="alert warn rs-warn">${icon('alert')} Every statement in the file runs as <b>${esc(this.form.user.value || 'the database user')}</b>. Tables it drops or creates are replaced. <button type="button" class="link-btn" data-rs-backup>Back up this database first</button></div>
        <div class="modal-actions rs-actions"><button class="btn ghost" data-x>Cancel</button></div>`,
    });
    let scan = null; // Promise of the file's summary (inspectSqlFile)
    const go = document.createElement('button');
    go.className = 'btn primary';
    go.disabled = true;
    go.innerHTML = `${icon('hardDriveUpload')}Restore…`;
    $('.rs-actions', el).appendChild(go);
    const summarize = (r, database) => {
      const out = { facts: [], warnings: [] };
      if (!r) return out;
      const list = (set) => [...set].slice(0, 6).join(', ') + (set.size > 6 ? ` +${set.size - 6}` : '');
      out.facts.push(['Made by', r.tool || (r.engine ? ENGINES[r.engine].label : 'unknown (not a recognised dump)')]);
      if (r.creates.size) out.facts.push(['Creates', `${r.creates.size} table${r.creates.size === 1 ? '' : 's'}: ${list(r.creates)}`]);
      if (r.drops.size) out.facts.push(['Drops first', `${r.drops.size} table${r.drops.size === 1 ? '' : 's'}: ${list(r.drops)}`, 'big']);
      if (r.data.size) out.facts.push(['Loads rows into', `${r.data.size} table${r.data.size === 1 ? '' : 's'}: ${list(r.data)}`]);
      if (r.truncates.size) out.facts.push(['Empties', list(r.truncates), 'big']);
      if (r.partial) out.facts.push(['Scanned', `the first ${fmtBytes(r.bytes)} only`]);
      if (r.engine && r.engine !== engine) out.warnings.push(`This is a ${ENGINES[r.engine].label} dump, but the target is ${ENGINES[engine].label}. It will almost certainly fail part-way.`);
      if (r.dropsDatabase.length) out.warnings.push(`The file drops a whole database or schema: ${r.dropsDatabase.join(', ')}.`);
      if (database === this.form.database.value && this.tables.length) {
        const existing = this.tables.map((t) => t.name).filter((n) => r.drops.has(n) || r.creates.has(n) || r.truncates.has(n));
        if (existing.length) out.warnings.push(`${existing.length} table${existing.length === 1 ? '' : 's'} already in ${database} will be replaced: ${existing.slice(0, 8).join(', ')}${existing.length > 8 ? '…' : ''}.`);
      }
      return out;
    };
    go.addEventListener('click', async () => {
      const database = $('[data-rs-db]', el).value;
      const options = { stopOnError: $('[data-rs-stop]', el).checked, singleTransaction: $('[data-rs-tx]', el)?.checked ?? false };
      const ok = await confirmDialog({
        tone: 'danger',
        icon: 'hardDriveUpload',
        title: `Restore ${file.name} into ${database}?`,
        message: 'Every statement in the file runs against this database. This cannot be undone except by restoring a backup.',
        facts: [
          ['File', `${file.name} · ${fmtBytes(file.size)}${/\.gz$/i.test(file.name) ? ' (compressed)' : ''}`],
          ['Into', `${database} · ${ENGINES[engine].label}`],
          ['Where', this.whereLabel()],
          ['As user', this.form.user.value || '(default)'],
          ['On error', options.stopOnError ? 'stop at the first error' : 'skip errors and keep going'],
          engine === 'postgres' ? ['Transaction', options.singleTransaction ? 'all or nothing' : 'each statement on its own'] : null,
        ],
        pending: scan.then((r) => summarize(r, database)),
        confirmLabel: 'Restore',
      });
      if (!ok) return;
      close();
      toast(`Restoring ${file.name} into ${database}…`);
      upload([{ file, rel: file.name }], {
        params: { what: 'dbrestore', ...this.params(), database, options },
        dir: '',
        onDone: (r) => {
          if (r.done) {
            toast(`Restored ${file.name} into ${database}`, 'success');
            if (database === this.form.database.value) this.loadTables();
          } else if (r.failed) toast(`Restore failed: ${(r.errors?.[0] || 'error').split('\n').filter(Boolean).slice(-2).join(' ')}`, 'error');
        },
      });
    });
    const pick = (f) => {
      if (!f) return;
      if (!/\.sql(\.gz)?$/i.test(f.name)) return toast('Choose a .sql or .sql.gz file', 'warn');
      file = f;
      $('.drop-text', el).innerHTML = `<strong>${esc(f.name)}</strong><small>${esc(fmtBytes(f.size))}${/\.gz$/i.test(f.name) ? ' · compressed' : ''} · click to choose another file</small>`;
      $('[data-drop]', el).classList.add('has-file');
      go.disabled = false;
      // Look inside the file (in the browser) to say what it will do before anything is sent.
      const box = $('.rs-scan', el);
      box.hidden = false;
      box.innerHTML = '<span class="db-spin"></span> Reading the file…';
      scan = inspectSqlFile(f).catch(() => null);
      scan.then((r) => {
        if (file !== f) return;
        if (!r) return (box.innerHTML = `${icon('info')} The file's contents could not be read in this browser; it will still restore.`);
        const sum = summarize(r, $('[data-rs-db]', el).value);
        box.innerHTML = `<div class="rs-scan-facts">${sum.facts.map(([k, v, c]) => `<span class="rs-chip ${c || ''}"><b>${esc(k)}</b> ${esc(v)}</span>`).join('')}</div>${sum.warnings.map((w) => `<div class="modal-warn">${icon('alert')}<span>${esc(w)}</span></div>`).join('')}`;
      });
    };
    $('[data-file]', el).addEventListener('change', (e) => pick(e.target.files[0]));
    const drop = $('[data-drop]', el);
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      pick(e.dataTransfer.files[0]);
    });
    $('[data-x]', el).addEventListener('click', () => close());
    $('[data-rs-backup]', el).addEventListener('click', () => {
      const database = $('[data-rs-db]', el).value;
      close();
      if (database !== this.form.database.value) {
        this.form.database.value = database;
        $('.db-dbs', this.root).value = database;
        this.loadTables().then(() => this.openBackup());
      } else this.openBackup();
    });
  }

  // ---------------------------------------------------------------- insights

  async openInsights() {
    if (!this.connected) return toast('Connect to the database first', 'warn');
    const engine = this.engine;
    let timer = 0;
    let tab = 'tables';
    let closed = false;
    const { el } = openModal({
      title: `Insights · ${this.form.database.value || ENGINES[engine].label}`,
      size: 'xl',
      onClose: () => {
        closed = true;
        clearTimeout(timer);
      },
      content: `
        <div class="ins-tiles">${msg('Loading…')}</div>
        <div class="ins-head">
          <div class="seg seg-sm" data-ins-tab><button type="button" data-v="tables" class="active">${icon('table')}Tables by size</button><button type="button" data-v="activity">${icon('activity')}Running queries</button></div>
          <span class="spacer"></span>
          <label class="check tiny" data-live hidden><input type="checkbox" checked /> Live</label>
          <button type="button" class="icon-btn" data-ins-refresh title="Refresh">${icon('refresh')}</button>
        </div>
        <div class="ins-body"></div>`,
    });
    const tile = (label, value, sub = '', tone = '') => `<div class="ins-tile ${tone}"><div class="ins-l">${esc(label)}</div><div class="ins-v">${esc(value)}</div>${sub ? `<div class="ins-s">${esc(sub)}</div>` : ''}</div>`;

    const loadStats = async () => {
      try {
        const { blocks } = await this.query(SQL[engine].stats, { timeout: 30 });
        let html = '';
        const dbBytes = this.tables.reduce((n, t) => n + (t.bytes || 0), 0);
        if (engine === 'mysql') {
          const kv = {};
          for (const b of blocks) for (const r of b.rows) kv[r[0]] = r[1];
          const up = Number(kv.Uptime) || 0;
          const reads = Number(kv.Innodb_buffer_pool_reads) || 0;
          const reqs = Number(kv.Innodb_buffer_pool_read_requests) || 0;
          const hit = reqs ? (100 * (1 - reads / reqs)).toFixed(2) : null;
          const ver = String(kv.version || this.serverVersion);
          html =
            tile(/mariadb/i.test(ver + (kv.version_comment || '')) ? 'MariaDB' : 'MySQL', ver.split('-')[0], kv.version_comment || '') +
            tile('Uptime', fmtDuration(up)) +
            tile('Connections', `${kv.Threads_connected ?? '—'} / ${kv.max_connections ?? '—'}`, `${kv.Threads_running ?? 0} running`, Number(kv.Threads_connected) > 0.8 * Number(kv.max_connections) ? 'warn' : '') +
            tile('Queries / s', up ? (Number(kv.Questions) / up).toFixed(1) : '—', `${compact(Number(kv.Questions) || 0)} since start`) +
            tile('Slow queries', compact(Number(kv.Slow_queries) || 0), '', Number(kv.Slow_queries) ? 'warn' : '') +
            tile('Buffer pool hits', hit != null ? `${hit}%` : '—', 'InnoDB reads served from memory', hit != null && hit < 95 ? 'warn' : 'ok') +
            tile('Database size', dbBytes ? fmtBytes(dbBytes) : '—', `${this.tables.length} tables`);
        } else {
          const r = objects(blocks.find((b) => b.columns.length))[0] || {};
          html =
            tile('PostgreSQL', (/\d+(\.\d+)*/.exec(String(r.version || this.serverVersion)) || ['—'])[0], String(r.version || '').replace(/^PostgreSQL [\d.]+\s*/, '')) +
            tile('Uptime', fmtDuration(Number(r.uptime) || 0)) +
            tile('Connections', `${r.connections ?? '—'} / ${r.max_connections ?? '—'}`, `${r.active ?? 0} active`, Number(r.connections) > 0.8 * Number(r.max_connections) ? 'warn' : '') +
            tile('Cache hit ratio', r.cache_hit != null ? `${r.cache_hit}%` : '—', 'Blocks served from memory', r.cache_hit != null && Number(r.cache_hit) < 95 ? 'warn' : 'ok') +
            tile('Transactions', compact(Number(r.transactions) || 0), 'since statistics reset') +
            tile('Database size', fmtBytes(Number(r.bytes) || dbBytes), `${this.tables.length} tables`);
        }
        $('.ins-tiles', el).innerHTML = html;
      } catch (err) {
        $('.ins-tiles', el).innerHTML = `<div class="alert error">${esc(err.message.split('\n')[0])}</div>`;
      }
    };

    const drawTables = () => {
      const list = [...this.tables].sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
      const max = Math.max(1, ...list.map((t) => t.bytes || 0));
      $('.ins-body', el).innerHTML = list.length
        ? `<table class="tbl ins-tbl"><thead><tr><th>Table</th><th class="num">Rows (est.)</th><th class="num">Size</th><th class="ins-barcol"></th><th></th></tr></thead><tbody>${list
            .map((t) => {
              const i = this.tables.indexOf(t);
              return `<tr><td class="mono">${t.schema && t.schema !== 'public' ? `<span class="muted">${esc(t.schema)}.</span>` : ''}${esc(t.name)}${/view/i.test(t.type || '') ? ' <span class="pill">view</span>' : ''}</td>
                <td class="num">${t.rows != null ? esc(t.rows.toLocaleString()) : '—'}</td>
                <td class="num">${t.bytes != null ? esc(fmtBytes(t.bytes)) : '—'}</td>
                <td class="ins-barcol"><span class="ins-bar" style="--w:${Math.max(1, Math.round(((t.bytes || 0) / max) * 100))}%"></span></td>
                <td class="nowrap"><button class="btn ghost small" data-preview="${i}">${icon('eye')}Preview</button>${CAN_BACKUP.has(engine) ? `<button class="icon-btn" data-backup="${i}" title="Back up this table">${icon('download')}</button>` : ''}</td></tr>`;
            })
            .join('')}</tbody></table>`
        : msg(engine === 'mysql' && !this.form.database.value ? 'Pick a database to see its tables.' : 'No tables.');
    };

    const drawActivity = async () => {
      clearTimeout(timer);
      try {
        const { blocks } = await this.query(SQL[engine].activity, { timeout: 20 });
        if (closed || tab !== 'activity') return;
        const rows = objects(blocks.find((b) => b.columns.length));
        $('.ins-body', el).innerHTML = rows.length
          ? `<table class="tbl ins-tbl"><thead><tr><th>${engine === 'mysql' ? 'ID' : 'PID'}</th><th>User</th><th>Database</th><th class="num">Time</th><th>State</th><th>Query</th><th></th></tr></thead><tbody>${rows
              .map((r) => {
                const secs = Number(r.seconds) || 0;
                return `<tr><td class="mono">${esc(r.id)}</td><td>${esc(r.user || '')}<div class="muted tiny">${esc(r.client || '')}</div></td><td class="mono">${esc(r.db || '—')}</td>
                  <td class="num"><span class="${secs > 60 ? 'bad' : secs > 5 ? 'warn' : ''}">${esc(secs >= 60 ? fmtDuration(secs) : `${secs}s`)}</span></td>
                  <td class="tiny">${esc([r.command, r.state].filter(Boolean).join(' · '))}</td>
                  <td><code class="ins-q" title="${esc(r.query || '')}">${esc((r.query || '').replace(/\s+/g, ' ').slice(0, 200)) || '<span class="muted">—</span>'}</code></td>
                  <td class="nowrap"><button class="btn small warn-ghost" data-cancelq="${esc(r.id)}">Cancel</button><button class="icon-btn" data-kill="${esc(r.id)}" title="End the connection">${icon('power')}</button></td></tr>`;
              })
              .join('')}</tbody></table>`
          : `<div class="list-msg">${icon('check')} Nothing running right now.</div>`;
      } catch (err) {
        if (!closed) $('.ins-body', el).innerHTML = `<div class="alert error">${esc(err.message)}</div>`;
      }
      if (!closed && tab === 'activity' && $('[data-live] input', el).checked) timer = setTimeout(drawActivity, 3000);
    };

    const show = () => {
      clearTimeout(timer);
      $('[data-live]', el).hidden = tab !== 'activity';
      if (tab === 'tables') drawTables();
      else {
        $('.ins-body', el).innerHTML = msg('Loading…');
        drawActivity();
      }
    };
    $('[data-ins-tab]', el).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      tab = b.dataset.v;
      $$('[data-ins-tab] button', el).forEach((x) => x.classList.toggle('active', x === b));
      show();
    });
    $('[data-live] input', el).addEventListener('change', () => tab === 'activity' && drawActivity());
    $('[data-ins-refresh]', el).addEventListener('click', async () => {
      loadStats();
      if (tab === 'tables') {
        await this.loadTables();
        drawTables();
      } else drawActivity();
    });
    el.addEventListener('click', async (e) => {
      const p = e.target.closest('[data-preview]');
      const bk = e.target.closest('[data-backup]');
      const cq = e.target.closest('[data-cancelq]');
      const kl = e.target.closest('[data-kill]');
      if (p) {
        el.querySelector('[data-close]').click();
        const t = this.tables[Number(p.dataset.preview)];
        const sql = `SELECT * FROM ${SQL[engine].qualified(t)} LIMIT 100;`;
        this.setSql(sql);
        this.run(sql, { remember: false });
      } else if (bk) {
        el.querySelector('[data-close]').click();
        this.openBackup({ table: this.tables[Number(bk.dataset.backup)] });
      } else if (cq || kl) {
        const id = (cq || kl).dataset.cancelq || (cq || kl).dataset.kill;
        const ok = await confirmDialog({
          title: cq ? `Cancel query ${id}?` : `End connection ${id}?`,
          message: cq ? 'The running statement is stopped; the client stays connected. Uncommitted work in that statement is rolled back.' : 'The client is disconnected and its open transaction is rolled back.',
          confirmLabel: cq ? 'Cancel query' : 'End connection',
          tone: cq ? 'warn' : 'danger',
          icon: cq ? 'stop' : 'power',
        });
        if (!ok) return;
        try {
          await this.query(cq ? SQL[engine].cancel(id) : SQL[engine].terminate(id), { timeout: 20 });
          toast(cq ? `Query ${id} cancelled` : `Connection ${id} ended`, 'success');
        } catch (err) {
          toast(err.message.split('\n')[0], 'error');
        }
        drawActivity();
      }
    });
    loadStats();
    show();
  }

  // ---------------------------------------------------------------- shell mode

  setMode(mode, silent) {
    this.mode = mode;
    $$('.db-mode button', this.root).forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('.db-query', this.root).hidden = mode !== 'query';
    $('.db-shell', this.root).hidden = mode !== 'shell';
    if (mode === 'query') {
      this.renderHistory();
      this.ed?.layout();
    }
    if (mode === 'shell' && !silent) this.openShell(false);
  }

  openShell(fresh) {
    if (this.shell && !fresh) {
      this.shell.show(true);
      return;
    }
    this.shell?.close();
    const p = this.params();
    const label = `${ENGINES[p.engine].label} shell${p.user ? ` as ${p.user}` : ''}`;
    this.shell = new TermSession($('.db-shell-mount', this.root), { kind: 'db', db: p }, label);
    this.shell.show(true);
  }

  destroy() {
    this.shell?.close();
    this.unregister?.();
    this.ed?.dispose();
    this.model?.dispose();
    this.root.remove();
  }
}

function compact(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  if (Math.abs(v) < 1000) return String(v);
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function isMac() {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
