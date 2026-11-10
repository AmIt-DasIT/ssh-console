'use strict';

/**
 * Host-key lookup in OpenSSH known_hosts files (the user's ~/.ssh/known_hosts and the system-wide
 * /etc/ssh/ssh_known_hosts), so servers you already trust with `ssh` are trusted here too, and a key
 * that doesn't match what OpenSSH knows is refused.
 *
 * Supports plain and hashed (|1|salt|hash) host names, [host]:port, comma lists, * and ? wildcards,
 * negated patterns (!host) and @revoked lines. @cert-authority lines are ignored (no certificate
 * support), so such hosts fall back to the app's own trust-on-first-use confirmation.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FILES = () => [path.join(os.homedir(), '.ssh', 'known_hosts'), path.join(os.homedir(), '.ssh', 'known_hosts2'), '/etc/ssh/ssh_known_hosts'];

function hostLabel(host, port) {
  return port === 22 ? host : `[${host}]:${port}`;
}

function globMatch(pattern, text) {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(text);
}

function hashedMatch(entry, label) {
  const [, , salt, hash] = entry.split('|');
  if (!salt || !hash) return false;
  try {
    const h = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(label).digest('base64');
    return h === hash;
  } catch {
    return false;
  }
}

/** Does a known_hosts host field match this host/port? */
function hostsMatch(field, host, port) {
  const label = hostLabel(host, port);
  if (field.startsWith('|1|')) return hashedMatch(field, label);
  let matched = false;
  for (const raw of field.split(',')) {
    const neg = raw.startsWith('!');
    const pat = neg ? raw.slice(1) : raw;
    if (!pat) continue;
    if (globMatch(pat, label)) {
      if (neg) return false;
      matched = true;
    }
  }
  return matched;
}

const fingerprint = (blob) => 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');

/** The key type at the start of an SSH public-key blob, e.g. "ssh-ed25519". */
function keyType(blob) {
  try {
    const n = blob.readUInt32BE(0);
    return blob.subarray(4, 4 + n).toString('ascii');
  } catch {
    return 'unknown';
  }
}

/**
 * Look up the presented key.
 * Returns { status: 'match' | 'mismatch' | 'revoked' | 'unknown', file?, expected? (fingerprint) }.
 * Only entries of the same key type count for a mismatch, as OpenSSH does: a server may have
 * several host keys, and a different type was simply not offered.
 */
function check(host, port, keyBlob, files = FILES()) {
  const type = keyType(keyBlob);
  const presented = keyBlob.toString('base64');
  let mismatch = null;
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const parts = t.split(/\s+/);
      let marker = null;
      if (parts[0].startsWith('@')) marker = parts.shift();
      const [hosts, ktype, key] = parts;
      if (!hosts || !ktype || !key) continue;
      if (marker === '@cert-authority') continue;
      if (!hostsMatch(hosts, host, port)) continue;
      if (marker === '@revoked') {
        if (key === presented) return { status: 'revoked', file };
        continue;
      }
      if (ktype !== type) continue;
      if (key === presented) return { status: 'match', file };
      if (!mismatch) {
        let expected = '';
        try {
          expected = fingerprint(Buffer.from(key, 'base64'));
        } catch { /* ignore */ }
        mismatch = { status: 'mismatch', file, expected };
      }
    }
  }
  return mismatch || { status: 'unknown' };
}

module.exports = { check, fingerprint, keyType, hostsMatch };
