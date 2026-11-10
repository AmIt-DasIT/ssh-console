'use strict';

/**
 * File operations on the SSH host itself or inside a container: list, preview, thumbnails,
 * edit/save, new folder, rename, move, delete, folder size, download and upload.
 *
 * Every call names its target: { target: 'host' } or { id: <container> }. Paths are always
 * absolute and passed to the remote shell as single-quoted arguments, never interpolated.
 */

const path = require('path').posix;
const crypto = require('crypto');
const { shq, checkId, checkPath } = require('./util');

const NO_SHELL = /executable file not found|no such file or directory.*"?sh"?|OCI runtime exec failed/i;

// Top-level folders that are never deleted as a whole, even after confirmation.
const PROTECTED = new Set([
  'bin', 'boot', 'dev', 'etc', 'home', 'lib', 'lib32', 'lib64', 'libx32', 'media', 'mnt', 'opt', 'proc', 'root',
  'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var', 'Users', 'System', 'Library', 'Applications', 'private', 'Volumes',
]);

const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};

function friendly(stderr, fallback) {
  const msg = (stderr || '').trim();
  if (NO_SHELL.test(msg) && /\bsh\b/.test(msg)) {
    return 'This container has no shell (sh), so its files cannot be managed. You can still download a known path.';
  }
  if (/is not running/i.test(msg)) return 'The container is not running. Start it to browse its files.';
  if (/permission denied/i.test(msg)) return `Permission denied${msg.includes(':') ? `: ${msg.split('\n')[0]}` : ''}`;
  return msg || fallback;
}

/** Where a command runs: directly on the host, or through `docker exec` in a container. */
function where(session, m, { stdin = false } = {}) {
  if (m.target === 'host') return { prefix: '', host: true };
  const id = checkId(m.id);
  return { prefix: `${session.docker} exec${stdin ? ' -i' : ''} ${id} `, host: false, id };
}

/** Normalised absolute path; trailing slashes removed. */
function cleanPath(p) {
  const n = path.normalize(checkPath(p));
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

function checkName(name) {
  const s = String(name || '');
  if (!s || s === '.' || s === '..' || s.includes('/') || s.includes('\0') || s.length > 255) {
    throw new Error('Invalid name. Names cannot be empty, "." or "..", or contain "/".');
  }
  return s;
}

/** A path that may be deleted or moved: never "/" and never a protected top-level folder. */
function checkMutable(p) {
  const c = cleanPath(p);
  if (c === '/') throw new Error('The root folder cannot be changed');
  const segs = c.split('/').filter(Boolean);
  if (segs.length === 1 && PROTECTED.has(segs[0])) throw new Error(`Refusing to change the system folder ${c}`);
  return c;
}

function sh(session, m, script, args = [], opts = {}) {
  const w = where(session, m, opts);
  return `${w.prefix}sh -c ${shq(script)} sh ${args.map(shq).join(' ')}`.trim();
}

async function run(session, cmd, fallback, opts = {}) {
  const r = await session.exec(cmd, { timeout: 60000, ...opts });
  if (r.code !== 0) throw new Error(friendly(r.stderr || r.stdout, fallback));
  return r;
}

// ---------------------------------------------------------------- listing

async function list(session, m) {
  const dir = cleanPath(m.path);
  // Glob all entries (hidden ones too), stat them in one process (GNU or BSD stat), then list which
  // are directories (this also catches symlinks that point to directories).
  const script = [
    'cd -- "$1" || exit 2',
    'command -v stat >/dev/null 2>&1 || { echo "stat is not available here" >&2; exit 3; }',
    'set -- .[!.]* ..?* *',
    `if stat -c %F . >/dev/null 2>&1; then stat -c '%F|%s|%Y|%A|%U|%n' -- "$@" 2>/dev/null; else stat -f '%HT|%z|%m|%Sp|%Su|%N' -- "$@" 2>/dev/null; fi`,
    'echo @@DIRS',
    `for f; do [ -d "$f" ] && printf '%s\\n' "$f"; done`,
    'exit 0',
  ].join('; ');
  const r = await session.exec(sh(session, m, script, [dir]), { timeout: 30000 });
  if (r.code === 2 && /can't cd|can.t cd|No such file|Not a directory|cd:/i.test(r.stderr)) {
    throw new Error(/permission denied/i.test(r.stderr) ? `Permission denied: ${dir}` : `No such folder: ${dir}`);
  }
  if (r.code !== 0) throw new Error(friendly(r.stderr, `Cannot open ${dir}`));

  const [statPart, dirPart = ''] = r.stdout.split('@@DIRS\n');
  const dirs = new Set(dirPart.split('\n').filter(Boolean));
  const entries = [];
  for (const line of statPart.split('\n')) {
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 6) continue;
    const [type, size, mtime, mode, owner] = parts;
    const name = parts.slice(5).join('|');
    if (name === '.' || name === '..') continue;
    entries.push({
      name,
      type: /directory/i.test(type) ? 'dir' : /symbolic link/i.test(type) ? 'link' : /regular/i.test(type) ? 'file' : 'other',
      isDir: dirs.has(name),
      size: Number(size),
      mtime: Number(mtime),
      mode,
      owner,
    });
  }
  return { path: dir, entries };
}

/** The SSH user's home folder on the host (or the container user's $HOME). */
async function home(session, m) {
  const r = await session.exec(sh(session, m, 'printf %s "${HOME:-/}"'), { timeout: 15000 });
  const h = r.stdout.trim();
  return { path: h.startsWith('/') ? h : '/' };
}

// ---------------------------------------------------------------- reading

const PREVIEW_LIMIT = 1024 * 1024;

async function read(session, m) {
  const file = cleanPath(m.path);
  const w = where(session, m);
  const r = await session.exec(`${w.prefix}head -c ${PREVIEW_LIMIT + 1} -- ${shq(file)}`, { timeout: 30000, buffer: true });
  if (r.code !== 0) throw new Error(friendly(r.stderr, `Cannot read ${file}`));
  const buf = r.stdout;
  const truncated = buf.length > PREVIEW_LIMIT;
  const data = truncated ? buf.subarray(0, PREVIEW_LIMIT) : buf;
  const binary = data.subarray(0, 8000).includes(0);
  return { path: file, truncated, binary, size: data.length, text: binary ? '' : data.toString('utf8') };
}

/** Image bytes as base64, for gallery thumbnails and the image preview. */
async function image(session, m) {
  const file = cleanPath(m.path);
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = IMAGE_TYPES[ext];
  if (!mime) throw new Error('Not an image');
  const limit = Math.min(Math.max(Number(m.limit) || 0, 64 * 1024), 12 * 1024 * 1024) || 4 * 1024 * 1024;
  const w = where(session, m);
  const r = await session.exec(`${w.prefix}head -c ${limit + 1} -- ${shq(file)}`, { timeout: 30000, buffer: true });
  if (r.code !== 0) throw new Error(friendly(r.stderr, `Cannot read ${file}`));
  if (r.stdout.length > limit) return { tooLarge: true };
  return { mime, data: r.stdout.toString('base64') };
}

/** Total size of a folder (or file), in bytes. */
async function du(session, m) {
  const p = cleanPath(m.path);
  const w = where(session, m);
  const r = await session.exec(`${w.prefix}du -sk -- ${shq(p)}`, { timeout: 120000 });
  const kb = parseInt(r.stdout.trim().split(/\s+/)[0], 10);
  if (!Number.isFinite(kb)) throw new Error(friendly(r.stderr, `Cannot measure ${p}`));
  // du exits non-zero when some sub-folders are unreadable but still prints a total.
  return { path: p, bytes: kb * 1024, partial: r.code !== 0 };
}

// ---------------------------------------------------------------- changing

const WRITE_LIMIT = 3 * 1024 * 1024;

async function write(session, m) {
  const file = cleanPath(m.path);
  if (typeof m.content !== 'string') throw new Error('Nothing to save');
  if (Buffer.byteLength(m.content) > WRITE_LIMIT) throw new Error('File is too large to edit here (3 MiB maximum)');
  const script = m.create ? '[ -e "$1" ] && { echo "Something with that name already exists" >&2; exit 17; }; cat > "$1"' : 'cat > "$1"';
  await run(session, sh(session, m, script, [file], { stdin: true }), `Cannot save ${file}`, { stdin: m.content });
  return { path: file };
}

async function mkdir(session, m) {
  const dir = cleanPath(m.path);
  const name = checkName(m.name);
  const target = path.join(dir, name);
  await run(session, sh(session, m, 'mkdir -- "$1"', [target]), `Cannot create ${target}`);
  return { path: target };
}

async function rename(session, m) {
  const from = checkMutable(m.path);
  const to = path.join(path.dirname(from), checkName(m.name));
  if (to === from) return { path: to };
  const script = '[ -e "$2" ] || [ -L "$2" ] && { echo "Something with that name already exists" >&2; exit 17; }; mv -- "$1" "$2"';
  await run(session, sh(session, m, script, [from, to]), `Cannot rename ${from}`);
  return { path: to };
}

function pathList(m, max = 1000) {
  const list = Array.isArray(m.paths) ? m.paths : [];
  if (!list.length) throw new Error('Nothing selected');
  if (list.length > max) throw new Error(`Too many items (maximum ${max})`);
  return [...new Set(list.map(checkMutable))];
}

async function move(session, m) {
  const dest = cleanPath(m.dest);
  const srcs = pathList(m);
  for (const s of srcs) {
    if (dest === s || dest.startsWith(s + '/')) throw new Error(`Cannot move ${s} into itself`);
    if (path.dirname(s) === dest) throw new Error(`${path.basename(s)} is already in ${dest}`);
  }
  const script = [
    'd="$1"; shift',
    '[ -d "$d" ] || { echo "Not a folder: $d" >&2; exit 2; }',
    'for f; do b="${f##*/}"; if [ -e "$d/$b" ] || [ -L "$d/$b" ]; then echo "Already exists in the destination: $b" >&2; exit 17; fi; done',
    'mv -- "$@" "$d"/',
  ].join('; ');
  await run(session, sh(session, m, script, [dest, ...srcs]), 'Move failed', { timeout: 300000 });
  return { moved: srcs.length, dest };
}

async function remove(session, m) {
  const paths = pathList(m);
  const w = where(session, m);
  await run(session, `${w.prefix}rm -rf -- ${paths.map(shq).join(' ')}`, 'Delete failed', { timeout: 300000 });
  return { removed: paths.length };
}

// ---------------------------------------------------------------- transfers

/**
 * Download spec. Container folders come out of `docker cp` as a tar stream (works even without a
 * shell in the container); host folders through tar.
 */
function downloadSpec(session, m) {
  // Several items from one folder: a single tar (needs tar on the host / in the container).
  if (Array.isArray(m.paths) && m.paths.length > 1) {
    const paths = m.paths.slice(0, 1000).map(cleanPath);
    const dir = path.dirname(paths[0]);
    if (paths.some((x) => path.dirname(x) !== dir || x === '/')) throw new Error('Items must be in the same folder');
    const w = where(session, m);
    const names = paths.map((x) => shq(`./${path.basename(x)}`)).join(' ');
    return { cmd: `${w.prefix}tar -C ${shq(dir)} -cf - ${names}`, filename: `${path.basename(dir) || 'root'}-selection.tar`, type: 'application/x-tar' };
  }
  const p = cleanPath(m.path);
  const base = path.basename(p) || 'root';
  const w = where(session, m);
  if (m.isDir) {
    const cmd = w.host
      ? `tar -C ${shq(path.dirname(p))} -cf - ${shq(p === '/' ? '.' : `./${base}`)}`
      : `${session.docker} cp ${w.id}:${shq(p)} -`;
    return { cmd, filename: `${base}.tar`, type: 'application/x-tar' };
  }
  return { cmd: `${w.prefix}cat -- ${shq(p)}`, filename: base, type: 'application/octet-stream' };
}

/** Upload spec. `name` may be a relative path ("folder/sub/file.txt") for folder uploads. */
function uploadSpec(session, m) {
  const dir = cleanPath(m.dir);
  const rel = String(m.name || '');
  const segs = rel.split('/');
  if (!rel || rel.length > 4096 || rel.includes('\0') || segs.some((s) => !s || s === '.' || s === '..' || s.length > 255)) {
    throw new Error('Invalid file name');
  }
  const target = path.join(dir, rel);
  const parent = path.dirname(target);
  // Write to a hidden temporary file first and only put it in place once every byte arrived, so a
  // cancelled or broken upload never leaves a truncated file or damages the file it would replace.
  // (Closing the connection mid-upload looks like a normal end of input to `cat`, hence the size
  // check.) An existing regular file is overwritten in place to keep its permissions and owner.
  const tmp = path.join(parent, `.${path.basename(target).slice(0, 180)}.${crypto.randomBytes(5).toString('hex')}.sdc-part`);
  const script = [
    'f="$1"; d="$2"; tmp="$3"; want="$4"',
    'mkdir -p -- "$d" || exit 1',
    'cat > "$tmp" || { rm -f -- "$tmp"; exit 1; }',
    'if [ -n "$want" ]; then got=$(wc -c < "$tmp" | tr -d " "); if [ "$got" != "$want" ]; then rm -f -- "$tmp"; echo "Upload incomplete: $got of $want bytes arrived" >&2; exit 1; fi; fi',
    'if [ -f "$f" ] && [ ! -L "$f" ]; then cat -- "$tmp" > "$f" && rm -f -- "$tmp" || { rm -f -- "$tmp"; exit 1; }; else mv -f -- "$tmp" "$f" || { rm -f -- "$tmp"; exit 1; }; fi',
  ].join('\n');
  return {
    // The expected size comes from the upload request's Content-Length.
    cmd: (size) => sh(session, m, script, [target, parent, tmp, Number.isFinite(size) && size >= 0 ? String(size) : ''], { stdin: true }),
    cleanup: sh(session, m, 'rm -f -- "$1"', [tmp]),
    target,
  };
}

module.exports = { list, home, read, image, du, write, mkdir, rename, move, remove, downloadSpec, uploadSpec };
