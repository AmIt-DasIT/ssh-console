'use strict';

/**
 * Host control: systemd services (with a live journal), processes, listening ports, and commands
 * that stream their output (saved commands, `docker pull`).
 *
 * Privileged operations go through sudo. The password is the SSH login password unless the user
 * typed a different one; it is written to sudo's stdin (never put on a command line) and kept in
 * memory for this session only. Servers where sudo isn't possible fall back to what the user can see.
 */

const { StringDecoder } = require('string_decoder');
const { shq, checkImage, clampInt } = require('./util');

// systemd unit names: letters, digits and :-_.@\ (instances such as getty@tty1.service).
const UNIT_RE = /^[a-zA-Z0-9:_.@\\-]{1,240}\.(service|socket|timer|target|mount|path)$/;
const SERVICE_ACTIONS = new Set(['start', 'stop', 'restart', 'reload', 'enable', 'disable']);
const SIGNALS = new Set(['TERM', 'KILL', 'HUP', 'INT', 'STOP', 'CONT']);

const SUDO_NEEDS_PASSWORD = /incorrect password|try again|no password was provided|password is required|a terminal is required|askpass/i;
const SUDO_FORBIDDEN = /not in the sudoers|not allowed to (run|execute)|may not run sudo/i;
const SUDO_PROMPT = '\u0001sdc-sudo\u0002'; // printed by sudo when it wants the password (streamed runs)

function checkUnit(u) {
  if (typeof u !== 'string' || !UNIT_RE.test(u)) throw new Error('Invalid service name');
  return u;
}

const userName = (s) => s.lastConnect?.username || 'this user';

// ---------------------------------------------------------------- privileges

async function isRoot(s) {
  if (s.isRoot == null) {
    const r = await s.exec('id -u', { timeout: 10000 });
    s.isRoot = r.stdout.trim() === '0';
  }
  return s.isRoot;
}

const sudoPassword = (s, typed) => String(typed || s.sudoPassword || s.lastConnect?.password || '').replace(/[\r\n]/g, '');

/**
 * Run a command as root. Throws SUDO_PASSWORD|user when sudo wants a password we don't have (the
 * page then asks for it and retries with m.sudoPassword).
 */
async function privExec(s, cmd, { timeout = 60000, password } = {}) {
  if (await isRoot(s)) return s.exec(cmd, { timeout });
  const pw = sudoPassword(s, password);
  const r = pw
    ? await s.exec(`sudo -S -p '' sh -c ${shq(cmd)}`, { timeout, stdin: `${pw}\n` })
    : await s.exec(`sudo -n sh -c ${shq(cmd)}`, { timeout });
  if (r.code !== 0) {
    const err = r.stderr || '';
    if (SUDO_FORBIDDEN.test(err)) {
      s.canSudo = false;
      throw new Error(`${userName(s)} isn't allowed to use sudo on this server, so this needs an administrator.`);
    }
    if (SUDO_NEEDS_PASSWORD.test(err) && /^sudo:/m.test(err)) throw new Error(`SUDO_PASSWORD|${userName(s)}`);
  }
  if (password && r.code === 0) s.sudoPassword = pw; // the typed password worked: remember it for this session
  if (r.code === 0) s.canSudo = true;
  return r;
}

/** Can we act as root without asking? Tried once per session (a wrong guess counts as a failed sudo). */
async function canSudoQuietly(s) {
  if (await isRoot(s)) return true;
  if (s.canSudo != null) return s.canSudo;
  try {
    const r = await privExec(s, 'true', { timeout: 15000 });
    s.canSudo = r.code === 0;
  } catch {
    s.canSudo = false;
  }
  return s.canSudo;
}

/** Check (and remember) a sudo password typed by the user. */
async function sudoCheck(s, m) {
  if (await isRoot(s)) return { root: true };
  const r = await privExec(s, 'true', { timeout: 20000, password: m.sudoPassword });
  if (r.code !== 0) throw new Error((r.stderr || 'sudo failed').trim());
  return { ok: true };
}

const fail = (r, what) => {
  throw new Error((r.stderr || r.stdout || '').trim() || `${what} failed (exit ${r.code})`);
};

// ---------------------------------------------------------------- services (systemd)

async function services(s) {
  const script = [
    'if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then echo @@nosystemd; exit 0; fi',
    'echo @@units',
    'systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null',
    'echo @@files',
    'systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null',
  ].join('; ');
  const r = await s.exec(`sh -c ${shq(script)}`, { timeout: 30000 });
  if (r.stdout.includes('@@nosystemd')) return { systemd: false, services: [] };
  const [, units = '', files = ''] = r.stdout.split(/@@units\n|@@files\n/);
  const map = new Map();
  for (const line of units.split('\n')) {
    const p = line.replace(/^[●*\s]+/, '').trim().split(/\s+/);
    if (p.length < 4 || !p[0].endsWith('.service') || p[1] === 'not-found') continue; // not-found: stale references
    map.set(p[0], { unit: p[0], load: p[1], active: p[2], sub: p[3], description: p.slice(4).join(' '), enabled: '' });
  }
  for (const line of files.split('\n')) {
    const [unit, st] = line.trim().split(/\s+/);
    if (!unit || !unit.endsWith('.service') || unit.includes('@.')) continue; // skip templates
    const e = map.get(unit);
    if (e) e.enabled = st;
    else map.set(unit, { unit, load: 'loaded', active: 'inactive', sub: 'dead', description: '', enabled: st });
  }
  return { systemd: true, root: await isRoot(s), services: [...map.values()] };
}

const SHOW_PROPS = [
  'Id', 'Description', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'FragmentPath', 'MainPID',
  'ActiveEnterTimestamp', 'ExecMainStartTimestamp', 'MemoryCurrent', 'CPUUsageNSec', 'TasksCurrent', 'NRestarts',
  'Restart', 'User', 'Type', 'Result', 'Documentation', 'Requires', 'After', 'WantedBy',
];

async function service(s, m) {
  const unit = checkUnit(m.unit);
  const r = await s.exec(`systemctl show ${shq(unit)} --no-pager -p ${SHOW_PROPS.join(',')}`, { timeout: 15000 });
  if (r.code !== 0) fail(r, 'systemctl show');
  const props = {};
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
  }
  return props;
}

async function serviceAction(s, m) {
  const unit = checkUnit(m.unit);
  if (!SERVICE_ACTIONS.has(m.action)) throw new Error('Unsupported action');
  const r = await privExec(s, `systemctl ${m.action} ${shq(unit)}`, { timeout: 120000, password: m.sudoPassword });
  if (r.code !== 0) fail(r, `systemctl ${m.action}`);
  return service(s, { unit });
}

// ---------------------------------------------------------------- processes

async function processes(s) {
  const script = [
    'echo @@ps',
    'ps -A -o pid=,ppid=,user=,pcpu=,pmem=,rss=,etime=,stat=,args= 2>/dev/null',
    'echo @@meta',
    'nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null',
    'cat /proc/loadavg 2>/dev/null',
    'grep -E "^(MemTotal|MemAvailable):" /proc/meminfo 2>/dev/null',
    'id -u',
  ].join('; ');
  const r = await s.exec(`sh -c ${shq(script)}`, { timeout: 20000, maxBytes: 8 * 1024 * 1024 });
  const [, ps = '', meta = ''] = r.stdout.split(/@@ps\n|@@meta\n/);
  const procs = [];
  for (const line of ps.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 9 || !/^\d+$/.test(p[0])) continue;
    procs.push({
      pid: Number(p[0]), ppid: Number(p[1]), user: p[2], cpu: parseFloat(p[3]) || 0, mem: parseFloat(p[4]) || 0,
      rss: (Number(p[5]) || 0) * 1024, etime: p[6], stat: p[7], cmd: p.slice(8).join(' '),
    });
  }
  if (!procs.length) throw new Error('Could not list processes: this server\'s ps does not support the needed columns');
  const lines = meta.split('\n').map((l) => l.trim()).filter(Boolean);
  const mem = {};
  for (const l of lines) {
    const x = /^(MemTotal|MemAvailable):\s+(\d+)/.exec(l);
    if (x) mem[x[1]] = Number(x[2]) * 1024;
  }
  const load = (lines.find((l) => /^\d+\.\d+ \d+\.\d+ \d+\.\d+/.test(l)) || '').split(/\s+/).slice(0, 3).map(Number);
  return {
    procs,
    cpus: parseInt(lines[0], 10) || null,
    load,
    memTotal: mem.MemTotal || null,
    memAvailable: mem.MemAvailable || null,
    uid: lines[lines.length - 1],
  };
}

async function kill(s, m) {
  const pid = clampInt(m.pid, 0, 0, 2 ** 31);
  if (pid <= 1) throw new Error('Refusing to signal that process');
  const sig = SIGNALS.has(m.signal) ? m.signal : 'TERM';
  const cmd = `kill -s ${sig} ${pid}`;
  let r = await s.exec(cmd, { timeout: 15000 });
  if (r.code !== 0 && /not permitted|permission/i.test(r.stderr)) r = await privExec(s, cmd, { timeout: 15000, password: m.sudoPassword });
  if (r.code !== 0) fail(r, 'kill');
  return true;
}

// ---------------------------------------------------------------- listening ports

function splitHostPort(a) {
  const i = a.lastIndexOf(':');
  let host = a.slice(0, i);
  const port = Number(a.slice(i + 1));
  host = host.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  return { host: host === '*' ? '0.0.0.0' : host, port };
}

function parseSs(out) {
  const rows = [];
  for (const line of out.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (p.length < 5 || !/^(tcp|udp)/.test(p[0])) continue;
    const { host, port } = splitHostPort(p[4]);
    if (!Number.isFinite(port)) continue;
    const procs = [...(p.slice(6).join(' ').matchAll(/\("([^"]+)",pid=(\d+)/g))].map((x) => ({ name: x[1], pid: Number(x[2]) }));
    rows.push({ proto: p[0].replace(/6$/, ''), state: p[1], host, port, procs });
  }
  return rows;
}

function parseNetstat(out) {
  const rows = [];
  for (const line of out.split('\n')) {
    const p = line.trim().split(/\s+/);
    if (!/^(tcp|udp)/.test(p[0] || '') || p.length < 4) continue;
    const { host, port } = splitHostPort(p[3]);
    if (!Number.isFinite(port)) continue;
    const prog = p[p.length - 1];
    const m = /^(\d+)\/(.+)$/.exec(prog);
    rows.push({ proto: p[0].replace(/6$/, ''), state: /^tcp/.test(p[0]) ? 'LISTEN' : 'UNCONN', host, port, procs: m ? [{ pid: Number(m[1]), name: m[2] }] : [] });
  }
  return rows;
}

async function ports(s) {
  const cmd = 'if command -v ss >/dev/null 2>&1; then echo @@ss; ss -H -tulpn; else echo @@netstat; netstat -tulpn 2>/dev/null; fi';
  // Process names of other users' sockets need root: use sudo when it works without asking.
  const priv = await canSudoQuietly(s);
  const r = priv ? await privExec(s, cmd, { timeout: 20000 }) : await s.exec(`sh -c ${shq(cmd)}`, { timeout: 20000 });
  if (r.code !== 0 && !r.stdout.trim()) fail(r, 'ss');
  const tool = r.stdout.startsWith('@@ss') ? 'ss' : 'netstat';
  const body = r.stdout.replace(/^@@\w+\n/, '');
  const rows = tool === 'ss' ? parseSs(body) : parseNetstat(body);
  // ss lists IPv4 and IPv6 sockets separately; merge "any address" and loopback pairs into one row.
  const scope = (h) => (h === '0.0.0.0' || h === '::' ? '*' : h === '127.0.0.1' || h === '::1' ? 'lo' : h);
  const seen = new Map();
  for (const x of rows) {
    const k = `${x.proto}|${scope(x.host)}|${x.port}|${x.procs.map((p) => p.pid).join(',')}`;
    if (!seen.has(k)) seen.set(k, x);
  }
  return { tool, privileged: priv, ports: [...seen.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto)) };
}

// ---------------------------------------------------------------- streams: service journal + command runs

/**
 * A remote command whose output streams to the page. It runs on a pty so it stops (SIGHUP) when the
 * page closes it; when sudo asks for a password (marker prompt), the session's password is typed once.
 */
function startStream(s, { token, cmd, sudo, cols, rows, onData, onEnd, kind }) {
  const conn = s.requireConn();
  const pw = sudo ? sudoPassword(s) : '';
  const full = sudo ? `sudo -S -p ${shq(SUDO_PROMPT)} sh -c ${shq(cmd)}` : cmd;
  const pty = { term: 'xterm-256color', cols: clampInt(cols, 120, 20, 1000), rows: clampInt(rows, 30, 5, 500) };
  const entry = { token, kind, stream: null };
  s.streams ??= new Map();
  stopStream(s, token);
  s.streams.set(token, entry);
  const started = Date.now();
  conn.exec(full, { pty }, (err, stream) => {
    if (err) {
      s.streams.delete(token);
      return onEnd({ error: err.message });
    }
    if (s.streams.get(token) !== entry) return stream.close();
    entry.stream = stream;
    const dec = new StringDecoder('utf8');
    let carry = '';
    let prompted = 0;
    const handle = (text) => {
      if (!sudo) return onData(text);
      text = carry + text;
      carry = '';
      let i;
      while ((i = text.indexOf(SUDO_PROMPT)) >= 0) {
        if (i) onData(text.slice(0, i));
        text = text.slice(i + SUDO_PROMPT.length);
        prompted++;
        if (prompted === 1 && pw) stream.write(`${pw}\n`);
        else {
          onData('\r\n\x1b[31msudo needs a password that this session does not have.\x1b[0m\r\n');
          stream.close();
          return;
        }
      }
      // Hold back a tail that could be the start of a split prompt marker.
      for (let k = Math.min(SUDO_PROMPT.length - 1, text.length); k > 0; k--) {
        if (SUDO_PROMPT.startsWith(text.slice(-k))) {
          carry = text.slice(-k);
          text = text.slice(0, -k);
          break;
        }
      }
      if (text) onData(text);
    };
    stream.on('data', (d) => handle(dec.write(d)));
    stream.stderr?.on('data', (d) => handle(d.toString('utf8')));
    stream.on('close', (code) => {
      if (s.streams.get(token) === entry) s.streams.delete(token);
      onEnd({ code, ms: Date.now() - started });
    });
  });
}

function stopStream(s, token) {
  const e = s.streams?.get(token);
  if (!e) return;
  s.streams.delete(token);
  if (e.stream) try { e.stream.close(); } catch { /* ignore */ }
}

function stopAllStreams(s) {
  for (const token of [...(s.streams?.keys() || [])]) stopStream(s, token);
}

async function journalStart(s, m) {
  const token = String(m.token);
  const unit = checkUnit(m.unit);
  const lines = clampInt(m.lines, 200, 10, 5000);
  const send = (o) => s.send({ ...o, token });
  const cmd = `journalctl -u ${shq(unit)} -n ${lines} -f --no-pager -o short-iso --no-hostname`;
  let sudo = false;
  if (!(await isRoot(s))) {
    sudo = await canSudoQuietly(s);
    if (!sudo) send({ type: 'journal:data', data: `\x1b[90m(Showing what ${userName(s)} may read. Add the user to the systemd-journal group, or use sudo, to see everything.)\x1b[0m\r\n` });
  }
  startStream(s, {
    token, kind: 'journal', cmd, sudo, cols: m.cols, rows: m.rows,
    onData: (data) => send({ type: 'journal:data', data }),
    onEnd: (r) => send({ type: 'journal:end', ...r }),
  });
}

async function runStart(s, m) {
  const token = String(m.token);
  let cmd;
  if (m.kind === 'pull') cmd = `${s.docker} pull ${shq(checkImage(m.ref))}`;
  else {
    cmd = String(m.cmd || '').trim();
    if (!cmd) throw new Error('Nothing to run');
    if (cmd.length > 20000) throw new Error('Command is too long');
  }
  let sudo = false;
  if (m.sudo && !(await isRoot(s))) {
    // Confirm sudo works first, so a wrong password is asked for again instead of failing mid-run.
    const r = await privExec(s, 'true', { timeout: 20000, password: m.sudoPassword });
    if (r.code !== 0) fail(r, 'sudo');
    sudo = true;
  }
  startStream(s, {
    token, kind: 'run', cmd, sudo, cols: m.cols, rows: m.rows,
    onData: (data) => s.send({ type: 'run:data', token, data }),
    onEnd: (r) => s.send({ type: 'run:end', token, ...r }),
  });
  return { started: true };
}

module.exports = {
  services, service, serviceAction, processes, kill, ports, sudoCheck,
  journalStart, runStart, stopStream, stopAllStreams,
};
