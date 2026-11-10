'use strict';

const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { Client } = require('ssh2');
const { shq, checkId, clampInt, parseJsonLines } = require('./util');
const db = require('./db');
const dbBackup = require('./dbbackup');
const host = require('./host');
const files = require('./files');
const transfers = require('./transfers');
const system = require('./system');
const knownHosts = require('./knownhosts');

// Modern algorithms only (no SHA-1 MACs or signatures, no CBC ciphers, no small DH groups), in line
// with current OpenSSH defaults and Mozilla's OpenSSH guidelines. "Allow legacy algorithms" on a
// connection adds a few older ones for old servers.
//
// Each list is narrowed to what this runtime's crypto can actually do: the Mac app runs on
// Electron's BoringSSL, which has no chacha20-poly1305, and ssh2 rejects a requested algorithm it
// can't provide. The order (strongest first) is kept.
const SSH_SUPPORTED = require('ssh2/lib/protocol/constants');
const usable = (kind, names) => names.filter((n) => SSH_SUPPORTED[`SUPPORTED_${kind}`].includes(n));
const STRICT_ALGORITHMS = {
  kex: usable('KEX', [
    'curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp521', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp256',
    'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group18-sha512', 'diffie-hellman-group16-sha512', 'diffie-hellman-group14-sha256',
  ]),
  cipher: usable('CIPHER', ['chacha20-poly1305@openssh.com', 'aes256-gcm@openssh.com', 'aes128-gcm@openssh.com', 'aes256-ctr', 'aes192-ctr', 'aes128-ctr']),
  hmac: usable('MAC', ['hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512', 'hmac-sha2-256']),
  serverHostKey: usable('SERVER_HOST_KEY', ['ssh-ed25519', 'ecdsa-sha2-nistp521', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256']),
  compress: ['none'],
};
const LEGACY_ALGORITHMS = {
  kex: [...STRICT_ALGORITHMS.kex, ...usable('KEX', ['diffie-hellman-group-exchange-sha1', 'diffie-hellman-group14-sha1'])],
  cipher: [...STRICT_ALGORITHMS.cipher, ...usable('CIPHER', ['aes256-cbc', 'aes192-cbc', 'aes128-cbc'])],
  hmac: [...STRICT_ALGORITHMS.hmac, ...usable('MAC', ['hmac-sha1'])],
  serverHostKey: [...STRICT_ALGORITHMS.serverHostKey, ...usable('SERVER_HOST_KEY', ['ssh-rsa'])],
  compress: ['none'],
};

// "docker", "sudo docker", "/usr/bin/docker", "sudo -n docker", "podman" ...
const DOCKER_CMD_RE = /^[a-zA-Z0-9_/.\- ]{1,200}$/;

const SHELLS = {
  auto: `sh -c 'if command -v bash >/dev/null 2>&1; then exec bash; elif command -v ash >/dev/null 2>&1; then exec ash; else exec sh; fi'`,
  bash: 'bash',
  sh: 'sh',
  ash: 'ash',
};

const ACTIONS = { start: 'start', stop: 'stop', restart: 'restart', pause: 'pause', unpause: 'unpause', remove: 'rm' };

const profileKey = (username, host, port) => `${username}@${host}:${port}`;

// When the page goes away (reload, closed tab), the SSH session and its shells are kept this long
// so the page can pick them up again with its resume token.
const RESUME_GRACE_MS = Number(process.env.SDC_RESUME_GRACE_MS) || 3 * 60 * 1000;
const SCROLLBACK_CHARS = 200 * 1024; // per shell, replayed after a reload
// Every connected session by resume token, attached to a page or not. A reloaded page can arrive
// before the server has even noticed the old page's socket closing, so resume must find live
// sessions as well as ones whose page already went away.
const sessions = new Map(); // resumeToken -> Session

class Session {
  constructor(ws, store) {
    this.ws = ws;
    this.store = store;
    this.conn = null;
    this.docker = 'docker';
    this.terms = new Map(); // termId -> ssh channel
    this.termMeta = new Map(); // termId -> { kind, id, shell, buf } for shells that survive a reload
    this.termGates = new Map(); // termId -> { password, buffer } for db shells waiting to receive the password
    this.logs = null; // { token, stream }
    this.queries = new Map(); // db query token -> ssh channel
    this.dbAuto = new Map(); // containerId -> auto-detected db credentials (kept server-side)
    this.info = null;
    this.resumeToken = null;
    this.detachTimer = null;
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  // ---------------------------------------------------------------- reload survival

  /** Drop what belongs to the page that is going away: log streams, running queries, DB shells. */
  releasePage() {
    this.logsStop();
    system.stopAllStreams(this);
    for (const s of this.queries.values()) {
      try { s.close(); } catch { /* ignore */ }
    }
    this.queries.clear();
    // Database shells hold a password prompt flow that can't be re-attached; close them.
    for (const id of [...this.terms.keys()]) if (!this.termMeta.has(id)) this.termClose({ termId: id });
  }

  /** The page closed its WebSocket. Keep the SSH session (and its shells) for a while, or end it. */
  detach() {
    if (!this.conn || !this.resumeToken) return this.disconnect();
    this.ws = null;
    this.releasePage();
    clearTimeout(this.detachTimer);
    this.detachTimer = setTimeout(() => {
      if (!this.ws) this.disconnect();
    }, RESUME_GRACE_MS);
    this.detachTimer.unref?.();
  }

  /**
   * Attach a session to a new WebSocket (page reload). Works whether or not the old page's socket
   * has closed yet; the old socket is told and closed. Returns null if the session has ended.
   */
  static resume(token, ws) {
    const s = sessions.get(String(token || ''));
    if (!s || !s.conn) return null;
    clearTimeout(s.detachTimer);
    s.detachTimer = null;
    const old = s.ws;
    if (old && old !== ws) {
      s.releasePage();
      try {
        if (old.readyState === 1) old.send(JSON.stringify({ type: 'session:moved' }));
        old.close(4001, 'Session resumed elsewhere');
      } catch { /* ignore */ }
    }
    s.ws = ws;
    return s;
  }

  resumeInfo() {
    return {
      ...this.info,
      resumed: true,
      terms: [...this.termMeta.values()].map(({ termId, kind, id, shell, buf }) => ({ termId, kind, id, shell, buffer: buf })),
    };
  }

  requireConn() {
    if (!this.conn) throw new Error('Not connected to an SSH server');
    return this.conn;
  }

  /**
   * Run a non-interactive command and collect its output.
   * opts: timeout (ms), stdin (string|Buffer), maxBytes, buffer (return stdout as Buffer), onStream(stream)
   */
  exec(cmd, opts = {}) {
    const { timeout = 30000, stdin, maxBytes = 50 * 1024 * 1024, buffer = false, onStream } = opts;
    const conn = this.requireConn();
    return new Promise((resolve, reject) => {
      conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        if (onStream) onStream(stream);
        const chunks = [];
        let size = 0;
        let truncated = false;
        let timedOut = false;
        let stderr = '';
        const timer = setTimeout(() => {
          timedOut = true;
          stream.close();
        }, timeout);
        stream.on('data', (d) => {
          if (truncated) return;
          if (size + d.length > maxBytes) {
            chunks.push(d.subarray(0, maxBytes - size));
            truncated = true;
            stream.close();
          } else chunks.push(d);
          size += d.length;
        });
        stream.stderr.on('data', (d) => {
          if (stderr.length < 1024 * 1024) stderr += d;
        });
        stream.on('close', (code) => {
          clearTimeout(timer);
          const out = Buffer.concat(chunks);
          if (timedOut && !truncated) stderr += `\n[timed out after ${Math.round(timeout / 1000)}s]`;
          resolve({ code: code ?? (timedOut ? 124 : truncated ? 0 : -1), stdout: buffer ? out : out.toString('utf8'), stderr, truncated, timedOut });
        });
        if (stdin != null) stream.end(stdin);
        else stream.end();
      });
    });
  }

  async docker$(args, timeout) {
    const r = await this.exec(`${this.docker} ${args}`, { timeout });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `docker ${args.split(' ')[0]} failed (exit ${r.code})`);
    return r.stdout;
  }

  // ---------------------------------------------------------------- SSH lifecycle

  async connect(m) {
    this.disconnect();

    // Connecting from a saved profile: fill in anything not typed from the profile and its stored secret.
    if (m.profileKey && this.store) {
      const p = this.store.get(String(m.profileKey));
      if (!p) throw new Error('That saved connection no longer exists');
      m = { host: p.host, port: p.port, username: p.username, dockerCmd: p.dockerCmd, label: p.label, authMode: p.authMode, legacyAlgorithms: p.legacyAlgorithms, ...stripEmpty(m) };
      if (!m.password && !m.privateKey) {
        const s = this.store.secret(p.key);
        if (!s) throw new Error('No saved password for this connection. Enter it to connect.');
        Object.assign(m, s);
      }
    }

    const hostName = String(m.host || '').trim();
    const username = String(m.username || '').trim();
    const port = clampInt(m.port, 22, 1, 65535);
    const dockerCmd = String(m.dockerCmd || 'docker').trim() || 'docker';
    if (!hostName || !username) throw new Error('Host and username are required');
    if (!DOCKER_CMD_RE.test(dockerCmd)) throw new Error('Docker command may only contain letters, digits, spaces and _ / . -');

    // Host-key trust, checked before any credentials are sent:
    //  - a key pinned for this host:port in a saved connection must match exactly;
    //  - otherwise the user's OpenSSH known_hosts decides (match → trusted, different key → refused);
    //  - otherwise the server is unknown and the user must confirm its fingerprint first.
    // A changed or unknown key is only accepted when the page sends back that exact fingerprint
    // (m.acceptHostKey) after the user confirmed it. Revoked keys are always refused.
    const pins = this.store
      ? this.store.read().profiles.filter((p) => p.host === hostName && Number(p.port) === port && p.fingerprint).map((p) => p.fingerprint)
      : [];
    let fingerprint = null;
    let hostKeyType = null;
    let trust = null;
    let problem = null;
    let kbdPrompt = '';
    const cfg = {
      host: hostName,
      port,
      username,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      tryKeyboard: true,
      algorithms: m.legacyAlgorithms ? LEGACY_ALGORITHMS : STRICT_ALGORITHMS,
      hostVerifier: (key) => {
        fingerprint = knownHosts.fingerprint(key);
        hostKeyType = knownHosts.keyType(key);
        const accepted = typeof m.acceptHostKey === 'string' && m.acceptHostKey === fingerprint;
        const kh = knownHosts.check(hostName, port, key);
        if (kh.status === 'revoked') {
          problem = `HOSTKEY_REVOKED|${fingerprint}|${kh.file}`;
          return false;
        }
        if (pins.includes(fingerprint)) trust = 'pinned';
        else if (pins.length) {
          if (!accepted) {
            problem = `HOSTKEY_CHANGED|${pins[0]}|${fingerprint}|saved connection`;
            return false;
          }
          trust = 'accepted-change';
        } else if (kh.status === 'match') trust = 'known_hosts';
        else if (kh.status === 'mismatch') {
          if (!accepted) {
            problem = `HOSTKEY_CHANGED|${kh.expected}|${fingerprint}|${kh.file}`;
            return false;
          }
          trust = 'accepted-change';
        } else {
          if (!accepted) {
            problem = `HOSTKEY_UNKNOWN|${fingerprint}|${hostKeyType}`;
            return false;
          }
          trust = 'accepted-new';
        }
        return true;
      },
    };
    if (m.privateKey) {
      cfg.privateKey = String(m.privateKey);
      if (m.passphrase) cfg.passphrase = String(m.passphrase);
    }
    if (m.password) cfg.password = String(m.password);
    if (!cfg.password && !cfg.privateKey) throw new Error('Provide a password or a private key');

    const conn = new Client();
    await new Promise((resolve, reject) => {
      conn.once('ready', resolve);
      conn.on('error', (err) => {
        reject(err);
        if (this.conn === conn) this.send({ type: 'ssh:error', error: err.message });
      });
      // Answer password prompts only: the password is never typed into a one-time-code or any other
      // prompt the server might show.
      conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
        if (prompts.length && cfg.password && prompts.every((p) => /password/i.test(p.prompt || ''))) {
          return finish(prompts.map(() => cfg.password));
        }
        kbdPrompt = prompts.map((p) => String(p.prompt || '').trim()).filter(Boolean).join(' ');
        finish(prompts.map(() => ''));
      });
      conn.on('close', () => {
        if (this.conn === conn) {
          this.cleanupChannels();
          this.conn = null;
          this.send({ type: 'ssh:closed' });
        }
      });
      conn.connect(cfg);
    }).catch((err) => {
      conn.end();
      if (problem) throw new Error(problem);
      if (kbdPrompt && err.level === 'client-authentication') {
        throw new Error(`The server asked "${kbdPrompt.slice(0, 120)}", which ssh-console cannot answer (for example a one-time code). Use a key or a plain password login for this user.`);
      }
      throw new Error(friendlySshError(err));
    });

    this.conn = conn;
    this.docker = dockerCmd;
    // Kept in memory for this browser session only, so "reconnect" can log in again (e.g. after a
    // permission fix) without asking for the password a second time.
    this.lastConnect = {
      host: hostName, port, username, dockerCmd, label: m.label || '',
      password: cfg.password, privateKey: cfg.privateKey, passphrase: cfg.passphrase,
      legacyAlgorithms: Boolean(m.legacyAlgorithms),
    };

    const key = profileKey(username, hostName, port);
    this.resumeToken = crypto.randomBytes(24).toString('hex');
    sessions.set(this.resumeToken, this);
    const info = {
      host: hostName, port, username, fingerprint, hostKeyType, hostKeyTrust: trust, dockerCmd, profileKey: key,
      label: m.label || '', resumeToken: this.resumeToken, legacyAlgorithms: Boolean(m.legacyAlgorithms),
    };
    this.info = info;

    if (this.store) {
      try {
        const authMode = cfg.privateKey ? 'key' : 'password';
        const secret = m.remember
          ? authMode === 'key'
            ? { privateKey: cfg.privateKey, passphrase: cfg.passphrase || '' }
            : { password: cfg.password }
          : m.remember === false
            ? null
            : undefined;
        this.store.upsert({ key, host: hostName, port, username, dockerCmd, authMode, label: String(m.label || '').slice(0, 80), fingerprint, legacyAlgorithms: Boolean(m.legacyAlgorithms) }, secret);
        if (trust === 'accepted-change') this.store.repin(hostName, port, fingerprint);
      } catch (err) {
        info.saveError = err.message;
      }
    }
    const [hn, dv] = await Promise.allSettled([
      this.exec('hostname', { timeout: 10000 }),
      this.exec(`${this.docker} version --format '{{.Server.Version}}'`, { timeout: 15000 }),
    ]);
    if (hn.status === 'fulfilled') info.hostname = hn.value.stdout.trim();
    if (dv.status === 'fulfilled' && dv.value.code === 0) info.dockerVersion = dv.value.stdout.trim();
    else info.dockerError = dv.status === 'fulfilled' ? (dv.value.stderr || dv.value.stdout).trim() || 'docker is not available' : dv.reason.message;
    if (info.dockerError && /permission denied/i.test(info.dockerError)) {
      info.dockerFix = await this.diagnoseDockerAccess(username).catch(() => ({ permissionDenied: true }));
      info.dockerFix.hasLoginPassword = Boolean(cfg.password);
    }
    return info;
  }

  /** Why can't this user reach the Docker socket, and which fixes are available? */
  async diagnoseDockerAccess(username) {
    const script = [
      'id -nG 2>/dev/null',
      'echo @@',
      'getent group docker >/dev/null 2>&1 && echo yes || echo no',
      'echo @@',
      'sudo -n true >/dev/null 2>&1 && echo yes || echo no',
      'echo @@',
      'ls -l /var/run/docker.sock 2>/dev/null',
    ].join('; ');
    const r = await this.exec(`sh -c ${shq(script)}`, { timeout: 15000 });
    const [groups = '', groupExists = '', sudo = '', socket = ''] = r.stdout.split('@@').map((s) => s.trim());
    return {
      permissionDenied: true,
      user: username,
      inGroup: groups.split(/\s+/).includes('docker'),
      groupExists: groupExists === 'yes',
      sudoNoPassword: sudo === 'yes',
      socket: socket.split('\n')[0] || '',
    };
  }

  /** Add the SSH user to the docker group with sudo (one-time fix). Takes effect on the next login. */
  async fixDockerAccess(m) {
    const last = this.lastConnect;
    if (!last) throw new Error('Not connected');
    const user = last.username;
    if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}\$?$/.test(user)) throw new Error(`Unsupported user name: ${user}`);
    const password = typeof m.password === 'string' && m.password ? m.password : last.password || '';
    // usermod/groupadd on most distros; addgroup on Alpine/BusyBox.
    const script =
      '(getent group docker >/dev/null 2>&1 || groupadd docker 2>/dev/null || addgroup docker) && ' +
      '(usermod -aG docker "$1" 2>/dev/null || addgroup "$1" docker)';
    const r = await this.exec(`sudo -S -p '' sh -c ${shq(script)} sh ${shq(user)}`, {
      stdin: `${password.replace(/[\r\n]/g, '')}\n`,
      timeout: 30000,
    });
    if (r.code === 0) return { user };
    const err = (r.stderr || r.stdout).trim();
    if (/incorrect password|try again|no password was provided|password is required|a terminal is required/i.test(err)) {
      throw new Error(`SUDO_PASSWORD|${user}`);
    }
    if (/not in the sudoers|not allowed to (run|execute)|may not run sudo/i.test(err)) {
      throw new Error(`${user} isn't allowed to use sudo on this server. Ask an administrator to run: sudo usermod -aG docker ${user}`);
    }
    throw new Error(err || `Could not change the group (exit ${r.code})`);
  }

  /** Log in again with this session's credentials, optionally with a different docker command. */
  async reconnect(m = {}) {
    if (!this.lastConnect) throw new Error('Nothing to reconnect to');
    const next = { ...this.lastConnect };
    if (m.dockerCmd) next.dockerCmd = String(m.dockerCmd);
    return this.connect(next);
  }

  cleanupChannels() {
    for (const s of this.terms.values()) {
      try { s.close(); } catch { /* ignore */ }
    }
    this.terms.clear();
    this.termMeta.clear();
    this.termGates.clear();
    for (const s of this.queries.values()) {
      try { s.close(); } catch { /* ignore */ }
    }
    this.queries.clear();
    this.logsStop();
    system.stopAllStreams(this);
  }

  disconnect() {
    if (this.resumeToken && sessions.get(this.resumeToken) === this) sessions.delete(this.resumeToken);
    clearTimeout(this.detachTimer);
    this.resumeToken = null;
    this.cleanupChannels();
    this.dbAuto.clear();
    this.lastConnect = null; // drop the login secrets kept for reconnect
    // Privilege facts and a typed sudo password belong to one login only.
    this.isRoot = null;
    this.canSudo = null;
    this.sudoPassword = null;
    if (this.conn) {
      const c = this.conn;
      this.conn = null;
      c.end();
    }
  }

  // ---------------------------------------------------------------- containers

  async containers() {
    return parseJsonLines(await this.docker$(`ps -a --no-trunc --format '{{json .}}'`));
  }

  async inspect(m) {
    const out = await this.docker$(`inspect --type container ${checkId(m.id)}`);
    return JSON.parse(out)[0];
  }

  async stats(m) {
    const out = await this.docker$(`stats --no-stream --no-trunc --format '{{json .}}' ${checkId(m.id)}`);
    return JSON.parse(out.trim().split('\n')[0]);
  }

  async top(m) {
    const out = await this.docker$(`top ${checkId(m.id)}`);
    const lines = out.split('\n').filter((l) => l.trim());
    if (!lines.length) return { titles: [], processes: [] };
    const titles = lines[0].trim().split(/\s+/);
    const processes = lines.slice(1).map((l) => {
      const parts = l.trim().split(/\s+/);
      return [...parts.slice(0, titles.length - 1), parts.slice(titles.length - 1).join(' ')];
    });
    return { titles, processes };
  }

  async action(m) {
    const cmd = ACTIONS[m.action];
    if (!cmd) throw new Error('Unsupported action');
    await this.docker$(`${cmd} ${checkId(m.id)}`, 120000);
    return true;
  }

  /** Same action on several containers at once (e.g. a whole Compose project). */
  async actionMany(m) {
    const cmd = ACTIONS[m.action];
    if (!cmd || cmd === 'rm') throw new Error('Unsupported action');
    const ids = (Array.isArray(m.ids) ? m.ids : []).map(checkId);
    if (!ids.length) throw new Error('No containers selected');
    if (ids.length > 200) throw new Error('Too many containers');
    await this.docker$(`${cmd} ${ids.join(' ')}`, 300000);
    return true;
  }

  // ---------------------------------------------------------------- streaming logs

  logsStart(m) {
    const conn = this.requireConn();
    this.logsStop();
    const id = checkId(m.id);
    const token = String(m.token);
    const tail = m.tail === 'all' ? 'all' : String(clampInt(m.tail, 500, 1, 100000));
    const ts = m.timestamps ? ' --timestamps' : '';
    // docker parses --since as a Go duration, which has no "d" unit ("7d" makes docker logs fail).
    const sm = /^(\d{1,5})([smhd])$/.exec(m.since || '');
    const since = sm ? ` --since ${sm[2] === 'd' ? `${Number(sm[1]) * 24}h` : m.since}` : '';
    const cmd = `${this.docker} logs -f --tail ${tail}${since}${ts} ${id}`;
    this.logs = { token, stream: null };

    // A pty makes the remote `docker logs -f` die (SIGHUP) as soon as we close the channel.
    conn.exec(cmd, { pty: { term: 'dumb', cols: 1000, rows: 50 } }, (err, stream) => {
      if (err) return this.send({ type: 'logs:end', token, error: err.message });
      if (!this.logs || this.logs.token !== token) return stream.close();
      this.logs.stream = stream;
      const dec = new StringDecoder('utf8');
      const decErr = new StringDecoder('utf8');
      stream.on('data', (d) => this.send({ type: 'logs:data', token, data: dec.write(d) }));
      stream.stderr.on('data', (d) => this.send({ type: 'logs:data', token, data: decErr.write(d) }));
      stream.on('close', (code) => {
        if (this.logs && this.logs.token === token) this.logs = null;
        this.send({ type: 'logs:end', token, code });
      });
    });
  }

  logsStop() {
    if (this.logs) {
      const { stream } = this.logs;
      this.logs = null;
      if (stream) try { stream.close(); } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- interactive terminals

  termOpen(m) {
    const conn = this.requireConn();
    const termId = String(m.termId);
    this.termClose({ termId });
    const pty = { term: 'xterm-256color', cols: clampInt(m.cols, 80, 10, 1000), rows: clampInt(m.rows, 24, 5, 500) };

    let gate = null;
    const onStream = (err, stream) => {
      if (err) return this.send({ type: 'term:exit', termId, error: err.message });
      this.terms.set(termId, stream);
      if (gate) this.termGates.set(termId, gate);
      // Host and container shells keep a scrollback copy so a reloaded page can pick them up again.
      if (m.kind === 'host' || m.kind === 'container') {
        this.termMeta.set(termId, { termId, kind: m.kind, id: m.kind === 'container' ? String(m.id) : null, shell: m.shell || 'auto', buf: '' });
      }
      const out = new StringDecoder('utf8');
      const errOut = new StringDecoder('utf8');
      const emit = (text) => {
        if (!text) return;
        const meta = this.termMeta.get(termId);
        if (meta) {
          meta.buf += text;
          if (meta.buf.length > SCROLLBACK_CHARS) {
            const cut = meta.buf.indexOf('\n', meta.buf.length - SCROLLBACK_CHARS);
            meta.buf = meta.buf.slice(cut >= 0 ? cut + 1 : meta.buf.length - SCROLLBACK_CHARS);
          }
        }
        this.send({ type: 'term:data', termId, data: text });
      };

      stream.on('data', (d) => {
        const text = out.write(d);
        const g = this.termGates.get(termId);
        if (!g) return emit(text);
        // DB shell: hold output until the wrapper says the terminal stopped echoing, then send the password.
        g.buffer += text;
        const i = g.buffer.indexOf(db.READY_MARKER);
        if (i >= 0) {
          this.termGates.delete(termId);
          clearTimeout(g.timer);
          stream.write(g.password + '\n');
          emit(g.buffer.slice(0, i) + g.buffer.slice(i + db.READY_MARKER.length).replace(/^\r?\n/, ''));
        }
      });
      if (stream.stderr) stream.stderr.on('data', (d) => emit(errOut.write(d)));
      stream.on('close', (code) => {
        const g = this.termGates.get(termId);
        if (g) {
          clearTimeout(g.timer);
          this.termGates.delete(termId);
          emit(g.buffer);
        }
        if (this.terms.get(termId) === stream) {
          this.terms.delete(termId);
          this.termMeta.delete(termId);
        }
        this.send({ type: 'term:exit', termId, code });
      });
      if (gate) {
        gate.timer = setTimeout(() => {
          if (this.termGates.get(termId) === gate) {
            this.termGates.delete(termId);
            emit(gate.buffer + '\r\n[database client did not start in time]\r\n');
            stream.close();
          }
        }, 30000);
      }
    };

    if (m.kind === 'host') {
      conn.shell(pty, onStream);
    } else if (m.kind === 'db') {
      const { cmd, password } = db.dbShellCommand(this, m.db || {});
      gate = { password, buffer: '', timer: null };
      conn.exec(cmd, { pty }, onStream);
    } else {
      const id = checkId(m.id);
      const shell = SHELLS[m.shell] || SHELLS.auto;
      conn.exec(`${this.docker} exec -it -e TERM=xterm-256color ${id} ${shell}`, { pty }, onStream);
    }
  }

  termInput(m) {
    const id = String(m.termId);
    if (this.termGates.has(id)) return; // don't let keystrokes become the password
    const s = this.terms.get(id);
    if (s && typeof m.data === 'string') s.write(m.data);
  }

  termResize(m) {
    const s = this.terms.get(String(m.termId));
    if (s) s.setWindow(clampInt(m.rows, 24, 5, 500), clampInt(m.cols, 80, 10, 1000), 0, 0);
  }

  termClose(m) {
    const id = String(m.termId);
    const s = this.terms.get(id);
    this.termGates.delete(id);
    this.termMeta.delete(id);
    if (s) {
      this.terms.delete(id);
      try { s.close(); } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- downloads / uploads

  createDownload(m) {
    this.requireConn();
    let spec;
    if (m.what === 'logs') {
      const id = checkId(m.id);
      spec = { cmd: `${this.docker} logs --timestamps ${id} 2>&1`, filename: `${m.name || id}.log`.replace(/[^\w.-]/g, '_'), type: 'text/plain; charset=utf-8' };
    } else if (m.what === 'file') {
      spec = files.downloadSpec(this, m);
    } else if (m.what === 'dbdump') {
      spec = { ...dbBackup.dumpSpec(this, m), strict: true };
    } else {
      throw new Error('Unknown download');
    }
    return { token: transfers.create(this, { kind: 'download', ...spec }) };
  }

  createUpload(m) {
    this.requireConn();
    const spec = m.what === 'dbrestore' ? dbBackup.restoreSpec(this, m) : files.uploadSpec(this, m);
    return { token: transfers.create(this, { kind: 'upload', ...spec }) };
  }
}

function stripEmpty(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== '' && v !== undefined && v !== null) out[k] = v;
  return out;
}

function requireStore(s) {
  if (!s.store) throw new Error('Saved connections are not available');
  return s.store;
}

function friendlySshError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (err && err.level === 'client-authentication') return 'Authentication failed: check the username, password or key';
  if (/ECONNREFUSED/.test(msg)) return 'Connection refused: is SSH running on that host and port?';
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'Host not found';
  if (/ETIMEDOUT|Timed out/i.test(msg)) return 'Connection timed out';
  if (/no matching|handshake failed/i.test(msg)) {
    return `The server only offers older encryption that ssh-console does not use by default (${msg.replace(/^.*?:\s*/, '')}). If you trust this server, turn on Advanced → Allow legacy algorithms.`;
  }
  if (/passphrase/i.test(msg)) return 'Private key is encrypted: enter its passphrase';
  if (/Cannot parse privateKey|Unsupported key format/i.test(msg)) return 'Could not read the private key. Paste the full key, including the BEGIN/END lines.';
  return msg;
}

// RPC messages carry a reqId and get a { type: 'result' } reply.
const RPC = {
  connect: (s, m) => s.connect(m),
  disconnect: (s) => {
    s.lastConnect = null;
    s.disconnect();
    return true;
  },
  reconnect: (s, m) => s.reconnect(m),
  'docker.fixAccess': (s, m) => s.fixDockerAccess(m),
  containers: (s) => s.containers(),
  inspect: (s, m) => s.inspect(m),
  stats: (s, m) => s.stats(m),
  top: (s, m) => s.top(m),
  action: (s, m) => s.action(m),
  actionMany: (s, m) => s.actionMany(m),
  'profiles.list': (s) => requireStore(s).list(),
  'profiles.delete': (s, m) => (requireStore(s).remove(String(m.key)), true),
  'profiles.rename': (s, m) => {
    const st = requireStore(s);
    const p = st.get(String(m.key));
    if (p) st.upsert({ key: p.key, label: String(m.label || '').slice(0, 80) });
    return true;
  },
  'profiles.forgetSecret': (s, m) => {
    const st = requireStore(s);
    const p = st.get(String(m.key));
    if (p) st.upsert({ key: p.key }, null);
    return true;
  },
  'profiles.setAutoConnect': (s, m) => requireStore(s).setAutoConnect(m.key ? String(m.key) : null),
  'host.info': (s) => host.hostInfo(s),
  'docker.images': (s) => host.images(s),
  'docker.volumes': (s) => host.volumes(s),
  'docker.networks': (s) => host.networks(s),
  'docker.statsAll': (s) => host.statsAll(s),
  'docker.imageRemove': (s, m) => host.imageRemove(s, m),
  'docker.imagePrune': (s, m) => host.imagePrune(s, m),
  'sys.services': (s) => system.services(s),
  'sys.service': (s, m) => system.service(s, m),
  'sys.serviceAction': (s, m) => system.serviceAction(s, m),
  'sys.processes': (s) => system.processes(s),
  'sys.kill': (s, m) => system.kill(s, m),
  'sys.ports': (s) => system.ports(s),
  'sys.sudoCheck': (s, m) => system.sudoCheck(s, m),
  'sys.journal': (s, m) => system.journalStart(s, m).then(() => true),
  'sys.run': (s, m) => system.runStart(s, m),
  'files.list': (s, m) => files.list(s, m),
  'files.home': (s, m) => files.home(s, m),
  'files.read': (s, m) => files.read(s, m),
  'files.image': (s, m) => files.image(s, m),
  'files.du': (s, m) => files.du(s, m),
  'files.write': (s, m) => files.write(s, m),
  'files.mkdir': (s, m) => files.mkdir(s, m),
  'files.rename': (s, m) => files.rename(s, m),
  'files.move': (s, m) => files.move(s, m),
  'files.remove': (s, m) => files.remove(s, m),
  'db.defaults': (s, m) => db.dbDefaults(s, m),
  'db.query': (s, m) => db.dbQuery(s, m),
  'db.cancel': (s, m) => db.dbCancel(s, m),
  download: (s, m) => s.createDownload(m),
  upload: (s, m) => s.createUpload(m),
};

// Fire-and-forget messages (streams).
const EVENTS = {
  'logs:start': (s, m) => s.logsStart(m),
  'logs:stop': (s) => s.logsStop(),
  'stream:stop': (s, m) => system.stopStream(s, String(m.token)),
  'term:open': (s, m) => s.termOpen(m),
  'term:input': (s, m) => s.termInput(m),
  'term:resize': (s, m) => s.termResize(m),
  'term:close': (s, m) => s.termClose(m),
};

module.exports = { Session, RPC, EVENTS, shq };
