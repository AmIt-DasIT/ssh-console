'use strict';

// Container IDs / names: docker allows [a-zA-Z0-9][a-zA-Z0-9_.-]. Anything else is rejected.
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
// Image references / IDs: registry.example.com:5000/org/name:tag@sha256:...
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,255}$/;

/** Quote a value for a POSIX shell: everything inside single quotes is literal. */
function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Invalid container id');
  return id;
}

function checkImage(ref) {
  if (typeof ref !== 'string' || !IMAGE_RE.test(ref)) throw new Error('Invalid image reference');
  return ref;
}

function checkPath(p) {
  if (typeof p !== 'string' || !p.startsWith('/') || p.length > 4096 || p.includes('\0')) {
    throw new Error('Invalid path');
  }
  return p;
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

function parseJsonLines(out) {
  return String(out)
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = { shq, checkId, checkImage, checkPath, clampInt, parseJsonLines, ID_RE };
