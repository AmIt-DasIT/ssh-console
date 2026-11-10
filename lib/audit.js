'use strict';

/**
 * Activity (audit) log: one JSON line per security-relevant action, written to audit.log in the
 * data folder (readable by this OS user only, rotated at 5 MB with one previous file kept).
 *
 * Records who (OS user), where (SSH user@host:port), what and whether it worked. Never records
 * passwords, keys, passphrases, file contents, SQL text or environment values.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024;
let osUser = 'unknown';
try {
  osUser = os.userInfo().username;
} catch { /* ignore */ }

const clip = (v, n = 300) => {
  const s = String(v ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const target = (m) => (m.target === 'host' || !m.target ? 'host' : `container:${clip(m.id || m.target, 64)}`);
const dbWhere = (m) => `${m.target === 'host' ? 'host' : `container:${clip(m.id, 64)}`} ${clip(m.engine, 16)}`;
const dateRange = (m) => {
  const f = m.options?.dateFilter;
  return f?.column ? `${clip(f.column, 64)} ${clip(f.from || '…', 19)} → ${clip(f.to || '…', 19)}` : undefined;
};
const sqlVerb = (sql) => (String(sql || '').trim().match(/^[a-zA-Z]+/)?.[0] || '').toUpperCase();

/** RPC / event type → safe description of the request. Only these are logged. */
const DESCRIBE = {
  connect: (m) => ({ host: clip(m.host, 255), port: m.port, username: clip(m.username, 64), auth: m.profileKey ? 'saved' : m.privateKey ? 'key' : 'password', legacyAlgorithms: !!m.legacyAlgorithms }),
  reconnect: () => ({}),
  disconnect: () => ({}),
  'docker.fixAccess': () => ({}),
  action: (m) => ({ action: m.action, container: clip(m.id, 64) }),
  actionMany: (m) => ({ action: m.action, containers: Array.isArray(m.ids) ? m.ids.length : 0 }),
  'docker.imageRemove': (m) => ({ image: clip(m.ref, 255) }),
  'docker.imagePrune': (m) => ({ all: !!m.all }),
  'files.write': (m) => ({ where: target(m), path: clip(m.path, 1024), create: !!m.create, bytes: typeof m.content === 'string' ? m.content.length : undefined }),
  'files.mkdir': (m) => ({ where: target(m), path: clip(m.path || m.dir, 1024), name: clip(m.name, 255) }),
  'files.rename': (m) => ({ where: target(m), path: clip(m.path, 1024), name: clip(m.name, 255) }),
  'files.move': (m) => ({ where: target(m), paths: (m.paths || []).slice(0, 20).map((p) => clip(p, 512)), dest: clip(m.dest, 1024) }),
  'files.remove': (m) => ({ where: target(m), paths: (m.paths || [m.path]).filter(Boolean).slice(0, 20).map((p) => clip(p, 512)) }),
  download: (m) =>
    m.what === 'dbdump'
      ? { what: 'database backup', where: dbWhere(m), database: clip(m.database, 128), tables: Array.isArray(m.tables) ? m.tables.length : 'all', content: m.options?.content || 'all', dateRange: dateRange(m) }
      : { what: m.what, where: m.what === 'logs' ? `container:${clip(m.id, 64)}` : target(m), path: m.path ? clip(m.path, 1024) : undefined, paths: Array.isArray(m.paths) ? m.paths.length : undefined },
  upload: (m) =>
    m.what === 'dbrestore'
      ? { what: 'database restore', where: dbWhere(m), database: clip(m.database, 128), file: clip(m.name, 255) }
      : { where: target(m), path: clip(m.path || m.dir, 1024), name: m.name ? clip(m.name, 255) : undefined },
  'db.query': (m) => ({ where: m.id ? `container:${clip(m.id, 64)}` : 'host', statement: sqlVerb(m.sql) }),
  'sys.serviceAction': (m) => ({ unit: clip(m.unit, 255), action: m.action }),
  'sys.kill': (m) => ({ pid: m.pid, signal: m.signal || 'TERM' }),
  'sys.run': (m) => ({ command: m.kind === 'pull' ? `docker pull ${clip(m.ref, 255)}` : clip(m.cmd, 500), sudo: !!m.sudo }),
  'sys.sudoCheck': () => ({}),
  'profiles.delete': (m) => ({ profile: clip(m.key, 300) }),
  'profiles.forgetSecret': (m) => ({ profile: clip(m.key, 300) }),
  'profiles.setAutoConnect': (m) => ({ profile: m.key ? clip(m.key, 300) : null }),
  'term:open': (m) => ({ kind: m.kind, container: m.kind === 'container' ? clip(m.id, 64) : undefined }),
};

class AuditLog {
  constructor(dir) {
    this.file = dir ? path.join(dir, 'audit.log') : null;
  }

  has(type) {
    return Object.hasOwn(DESCRIBE, type);
  }

  /** session: the Session (for the SSH target); m: the request; result: { ok, error, data } */
  record(session, m, { ok, error, data } = {}) {
    if (!this.file || !this.has(m.type)) return;
    let details;
    try {
      details = DESCRIBE[m.type](m);
    } catch {
      details = {};
    }
    const info = session?.info;
    const entry = {
      t: new Date().toISOString(),
      user: osUser,
      ssh: info ? `${info.username}@${info.host}:${info.port}` : undefined,
      event: m.type,
      ...details,
      ok: ok !== false,
    };
    if (m.type === 'connect' && ok && data) {
      entry.ssh = `${data.username}@${data.host}:${data.port}`;
      entry.hostKey = data.fingerprint;
      entry.hostKeyTrust = data.hostKeyTrust;
    }
    if (error) entry.error = clip(error, 300);
    this.append(entry);
  }

  append(entry) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      try {
        if (fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, `${this.file}.1`);
      } catch { /* no file yet */ }
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch { /* the log must never break the app */ }
  }

  /** Most recent entries first. */
  tail(limit = 300) {
    const out = [];
    for (const f of [this.file, `${this.file}.1`]) {
      if (!f || out.length >= limit) break;
      let lines;
      try {
        lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      } catch {
        continue;
      }
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        try {
          out.push(JSON.parse(lines[i]));
        } catch { /* skip a torn line */ }
      }
    }
    return out;
  }
}

module.exports = { AuditLog };
