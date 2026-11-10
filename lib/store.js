'use strict';

/**
 * Saved connection profiles.
 *
 * Profiles (host, port, user, docker command, label) are kept in a JSON file in the data dir.
 * Secrets (password / private key / passphrase) are only stored when an encryptor is available:
 * the macOS app passes Electron's `safeStorage`, which encrypts with a key held in the macOS Keychain.
 * Secrets never leave the server process: the browser only learns whether a profile has one.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** ~/.ssh-console, moving the folder over from its old name (~/.ssh-docker-console) the first time. */
function defaultDir() {
  const dir = path.join(os.homedir(), '.ssh-console');
  const legacy = path.join(os.homedir(), '.ssh-docker-console');
  if (!fs.existsSync(dir) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, dir);
    } catch {
      return legacy;
    }
  }
  return dir;
}

class Store {
  constructor({ dataDir, secrets } = {}) {
    this.dir = dataDir || process.env.SDC_DATA_DIR || defaultDir();
    this.file = path.join(this.dir, 'profiles.json');
    this.secrets = secrets || null; // { available(): bool, encrypt(str): str, decrypt(str): str }
    this.harden();
  }

  /**
   * The web server's access token: random, kept in the data folder (readable by this user only) so
   * the access link keeps working across restarts. Delete the file to issue a new link.
   */
  accessToken() {
    const file = path.join(this.dir, 'access-token');
    try {
      const t = fs.readFileSync(file, 'utf8').trim();
      if (/^[A-Za-z0-9_-]{32,}$/.test(t)) return t;
    } catch { /* create below */ }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const t = require('crypto').randomBytes(32).toString('base64url');
    fs.writeFileSync(file, `${t}\n`, { mode: 0o600 });
    return t;
  }

  /** Tighten permissions left too open by an older version or a copy (profiles hold host keys and secrets). */
  harden() {
    try {
      fs.chmodSync(this.dir, 0o700);
    } catch { /* not created yet */ }
    for (const f of ['profiles.json', 'access-token', 'audit.log', 'audit.log.1']) {
      try {
        fs.chmodSync(path.join(this.dir, f), 0o600);
      } catch { /* missing */ }
    }
  }

  canSaveSecrets() {
    try {
      return Boolean(this.secrets && this.secrets.available());
    } catch {
      return false;
    }
  }

  read() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { profiles: Array.isArray(d.profiles) ? d.profiles : [], autoConnect: d.autoConnect || null };
    } catch {
      return { profiles: [], autoConnect: null };
    }
  }

  write(d) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  list() {
    const d = this.read();
    return {
      profiles: d.profiles.map(({ secret, ...p }) => ({ ...p, hasSecret: Boolean(secret) })),
      autoConnect: d.autoConnect,
      canSaveSecrets: this.canSaveSecrets(),
    };
  }

  get(key) {
    return this.read().profiles.find((p) => p.key === key) || null;
  }

  /**
   * secret: object → encrypt and store; null → forget any stored secret; undefined → keep as is.
   */
  upsert(profile, secret) {
    const d = this.read();
    const prev = d.profiles.find((p) => p.key === profile.key) || {};
    const next = { ...prev, ...profile, lastUsed: Date.now() };
    if (secret === null) delete next.secret;
    else if (secret && this.canSaveSecrets()) next.secret = this.secrets.encrypt(JSON.stringify(secret));
    d.profiles = [next, ...d.profiles.filter((p) => p.key !== profile.key)].slice(0, 50);
    this.write(d);
  }

  /** A changed host key was accepted: every saved connection to that host:port now pins the new key. */
  repin(host, port, fingerprint) {
    const d = this.read();
    let changed = false;
    for (const p of d.profiles) {
      if (p.host === host && Number(p.port) === Number(port) && p.fingerprint && p.fingerprint !== fingerprint) {
        p.fingerprint = fingerprint;
        changed = true;
      }
    }
    if (changed) this.write(d);
  }

  remove(key) {
    const d = this.read();
    d.profiles = d.profiles.filter((p) => p.key !== key);
    if (d.autoConnect === key) d.autoConnect = null;
    this.write(d);
  }

  setAutoConnect(key) {
    const d = this.read();
    d.autoConnect = key && d.profiles.some((p) => p.key === key) ? key : null;
    this.write(d);
    return d.autoConnect;
  }

  secret(key) {
    const p = this.get(key);
    if (!p || !p.secret || !this.canSaveSecrets()) return null;
    try {
      return JSON.parse(this.secrets.decrypt(p.secret));
    } catch {
      return null;
    }
  }
}

module.exports = { Store };
