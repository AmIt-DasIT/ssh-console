'use strict';

/**
 * Self-update for the desktop app, fed by GitHub Releases.
 *
 * Every release carries a `latest.json` (written by scripts/release.js):
 *   { version, date, notes, files: { "darwin-arm64": { name, sha256, size }, "linux-x64": {…}, … } }
 * The app reads https://github.com/<repo>/releases/latest/download/latest.json at launch and every
 * few hours. When it is newer, the tab bar offers "Update". The download is checked against the
 * SHA-256 in the manifest, installed, and the app restarts after a 5-second countdown that the user
 * can cancel (and that never starts while an upload runs or a file has unsaved changes).
 *
 * - macOS: the build is ad-hoc signed, so Squirrel.Mac (electron-updater) can't be used. The zip is
 *   unpacked and checked, and once the app quits a small detached script swaps the .app bundle and
 *   opens the new one. A cancelled countdown keeps the update staged: it is applied when the app quits.
 * - Linux AppImage: the new AppImage replaces the running file (rename on the same disk), then the
 *   app relaunches it. No password needed.
 * - Linux .deb, or an app that can't replace itself (read-only folder, run from the disk image):
 *   "Download" opens the release page instead.
 */

const { app, net, ipcMain, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const pkg = require('../package.json');

const REPO = String(pkg.updateRepo || '');
const CONFIGURED = /^[\w.-]+\/[\w.-]+$/.test(REPO) && !/YOUR-/i.test(REPO);
// SSH_CONSOLE_UPDATE_FEED points at another folder holding latest.json + the files (for testing a release).
const FEED = process.env.SSH_CONSOLE_UPDATE_FEED || '';
const manifestUrl = () => (FEED ? `${FEED.replace(/\/$/, '')}/latest.json` : `https://github.com/${REPO}/releases/latest/download/latest.json`);
const fileUrl = (version, name) => (FEED ? `${FEED.replace(/\/$/, '')}/${encodeURIComponent(name)}` : `https://github.com/${REPO}/releases/download/v${version}/${encodeURIComponent(name)}`);
const releasePage = (version) => (FEED ? FEED : `https://github.com/${REPO}/releases/${version ? `tag/v${version}` : 'latest'}`);

const FIRST_CHECK_MS = 8 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const COUNTDOWN_S = 5;
const BUNDLE_ID = pkg.build?.appId || '';

let opts = { beforeRestart: () => {}, isBusy: async () => false };
// What the tab bar shows. state: idle | checking | available | downloading | installing | ready | error
let status = { state: 'idle', current: app.getVersion() };
let manifest = null;
let request = null; // the running download (net.ClientRequest)
let staged = null; // { kind: 'mac', bundle, newApp, dir } | { kind: 'appimage', file }
let countdownTimer = null;
let restarting = false;

// ---------------------------------------------------------------- helpers

/** -1 / 0 / 1. Pre-releases (1.4.0-beta) sort before the release. */
function compareVersions(a, b) {
  const parse = (v) => {
    const [main, pre = ''] = String(v).replace(/^v/, '').split('-', 2);
    return { nums: main.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((x.nums[i] || 0) !== (y.nums[i] || 0)) return (x.nums[i] || 0) > (y.nums[i] || 0) ? 1 : -1;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(file)}: ${String(stderr || err.message).trim()}`));
      else resolve(String(stdout).trim());
    });
  });
}

const header = (res, name) => {
  const v = res.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

function set(patch) {
  status = { ...status, ...patch, current: app.getVersion() };
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('update-status', status);
  }
}

/** Which file of the manifest this copy of the app can install, and how. */
function installTarget() {
  if (process.platform === 'darwin') {
    const bundle = path.resolve(app.getPath('exe'), '../../..');
    if (!bundle.endsWith('.app')) return { why: "This copy isn't an app bundle." };
    if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) {
      return { why: 'ssh-console is running from the disk image or a quarantined folder. Move it to Applications, open it from there, and update again.' };
    }
    try {
      fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
      fs.accessSync(bundle, fs.constants.W_OK);
    } catch {
      return { why: `ssh-console can't replace itself in ${path.dirname(bundle)} (no write permission).` };
    }
    return { kind: 'mac', bundle, keys: [`darwin-${process.arch}`, 'darwin-universal'] };
  }
  if (process.platform === 'linux') {
    const file = process.env.APPIMAGE;
    if (!file) return { why: 'This copy was installed from the .deb package. Download the new .deb (or switch to the AppImage, which updates itself).' };
    try {
      fs.accessSync(path.dirname(file), fs.constants.W_OK);
    } catch {
      return { why: `ssh-console can't replace itself in ${path.dirname(file)} (no write permission).` };
    }
    return { kind: 'appimage', file, keys: [`linux-${process.arch}`] };
  }
  return { why: 'Automatic updates are not available on this system.' };
}

// ---------------------------------------------------------------- check

async function check({ manual = false } = {}) {
  if (!CONFIGURED && !FEED) {
    if (manual) dialog.showMessageBox({ type: 'info', message: 'Updates are not set up for this build.', detail: 'Set "updateRepo" in package.json to the GitHub repository that holds the releases.' });
    return;
  }
  if (['downloading', 'installing', 'ready'].includes(status.state)) {
    if (manual) set({}); // re-send, so the tab bar shows it again
    return;
  }
  set({ state: 'checking' });
  try {
    const res = await net.fetch(`${manifestUrl()}?t=${Date.now()}`, { cache: 'no-store' });
    if (res.status === 404) throw new Error('No release has been published yet.');
    if (!res.ok) throw new Error(`The update server answered ${res.status}.`);
    const m = await res.json();
    if (!m || typeof m.version !== 'string' || typeof m.files !== 'object') throw new Error('The update manifest is malformed.');
    if (compareVersions(m.version, app.getVersion()) <= 0) {
      manifest = null;
      set({ state: 'idle', version: null, error: null });
      if (manual) dialog.showMessageBox({ type: 'info', message: "You're up to date.", detail: `ssh-console ${app.getVersion()} is the newest version.` });
      return;
    }
    manifest = m;
    const target = installTarget();
    const file = target.keys?.map((k) => m.files[k]).find(Boolean);
    set({
      state: 'available',
      version: m.version,
      notes: String(m.notes || '').slice(0, 4000),
      date: m.date || null,
      size: file?.size || null,
      canInstall: Boolean(file),
      why: file ? null : target.why || 'This release has no build for this system.',
      releaseUrl: releasePage(m.version),
      error: null,
    });
  } catch (err) {
    // A failed background check stays quiet; a manual one says what went wrong.
    set({ state: manifest ? 'available' : 'idle' });
    if (manual) dialog.showMessageBox({ type: 'warning', message: "Couldn't check for updates.", detail: err.message });
  }
}

// ---------------------------------------------------------------- download

function download(url, dest, expected) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest, { mode: 0o644 });
    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastSent = 0;
    const req = net.request({ url, redirect: 'follow', cache: 'no-store' });
    request = req;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      request = null;
      out.destroy();
      fs.rm(dest, { force: true }, () => {});
      reject(err);
    };
    out.on('error', (err) => {
      try { req.abort(); } catch { /* ignore */ }
      fail(new Error(`Couldn't save the download: ${err.message}`));
    });
    req.on('response', (res) => {
      if (res.statusCode !== 200) return fail(new Error(`Download failed: the server answered ${res.statusCode}.`));
      const total = Number(header(res, 'content-length')) || expected.size || 0;
      res.on('data', (chunk) => {
        if (failed) return;
        received += chunk.length;
        hash.update(chunk);
        out.write(chunk);
        const now = Date.now();
        if (now - lastSent > 120) {
          lastSent = now;
          set({ received, total, percent: total ? Math.min(99, Math.floor((received / total) * 100)) : null });
        }
      });
      res.on('end', () => {
        if (failed) return;
        out.end(() => {
          request = null;
          resolve({ sha256: hash.digest('hex'), size: received });
        });
      });
      res.on('aborted', () => fail(new Error('The download was interrupted.')));
      res.on('error', fail);
    });
    req.on('abort', () => fail(Object.assign(new Error('Cancelled'), { cancelled: true })));
    req.on('error', fail);
    req.end();
  });
}

async function startUpdate() {
  if (status.state !== 'available' || !manifest) return;
  const target = installTarget();
  const key = target.keys?.find((k) => manifest.files[k]);
  const file = key && manifest.files[key];
  if (!file) return shell.openExternal(releasePage(manifest.version));
  if (!/^[\w.+-]+$/.test(file.name || '') || !/^[a-f0-9]{64}$/i.test(file.sha256 || '')) {
    return set({ state: 'error', error: 'The update manifest lists an invalid file.' });
  }

  const dir = target.kind === 'appimage' ? path.dirname(target.file) : fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-console-update-'));
  const dest = target.kind === 'appimage' ? path.join(dir, `.${path.basename(target.file)}.update`) : path.join(dir, file.name);
  set({ state: 'downloading', percent: 0, received: 0, total: file.size || 0, error: null });
  try {
    const got = await download(fileUrl(manifest.version, file.name), dest, file);
    if (file.size && got.size !== file.size) throw new Error(`The download is incomplete (${got.size} of ${file.size} bytes).`);
    if (got.sha256.toLowerCase() !== file.sha256.toLowerCase()) throw new Error('The download is damaged: its checksum does not match the release.');
    set({ state: 'installing', percent: 100 });
    staged = target.kind === 'mac' ? await stageMac(target.bundle, dest, dir, manifest.version) : stageAppImage(target.file, dest);
    set({ state: 'ready', countdown: null, blocked: false });
    await beginCountdown();
  } catch (err) {
    request = null;
    fs.rm(dest, { force: true }, () => {});
    if (target.kind === 'mac') fs.rm(dir, { recursive: true, force: true }, () => {});
    if (err.cancelled) set({ state: 'available', percent: null });
    else set({ state: 'error', error: err.message });
  }
}

// ---------------------------------------------------------------- install

/** Unpack the zip and make sure it really is the new ssh-console before anything is replaced. */
async function stageMac(bundle, zip, dir, version) {
  const unpack = path.join(dir, 'app');
  fs.mkdirSync(unpack);
  await run('/usr/bin/ditto', ['-x', '-k', zip, unpack]);
  fs.rmSync(zip, { force: true });
  const name = fs.readdirSync(unpack).find((n) => n.endsWith('.app'));
  if (!name) throw new Error('The update does not contain an app.');
  const newApp = path.join(unpack, name);
  const plist = path.join(newApp, 'Contents', 'Info.plist');
  const id = await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]);
  const ver = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);
  if (BUNDLE_ID && id !== BUNDLE_ID) throw new Error(`The update is a different app (${id}).`);
  if (ver !== version) throw new Error(`The update is version ${ver}, expected ${version}.`);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', newApp]);
  await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', newApp]).catch(() => {});
  return { kind: 'mac', bundle, newApp, dir };
}

/** The new AppImage takes the old one's place right away; the running copy keeps working until restart. */
function stageAppImage(file, downloaded) {
  fs.chmodSync(downloaded, 0o755);
  fs.renameSync(downloaded, file);
  return { kind: 'appimage', file };
}

/**
 * macOS: a detached script waits for this process to exit, swaps the bundles (putting the old one
 * back if anything fails) and, when relaunch is set, opens the app again.
 */
function spawnMacSwap(relaunch) {
  const { bundle, newApp, dir } = staged;
  const backup = path.join(path.dirname(bundle), `.${path.basename(bundle)}.old`);
  const script = path.join(dir, 'swap.sh');
  // A separate test instance (SSH_CONSOLE_INSTANCE) comes back as that same instance.
  const keep = ['SSH_CONSOLE_INSTANCE', 'SSH_CONSOLE_UPDATE_FEED'].filter((k) => process.env[k]);
  const shq = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
  const openCmd = `open ${keep.map((k) => `--env ${shq(`${k}=${process.env[k]}`)}`).join(' ')} "$OLD"`;
  fs.writeFileSync(script, `#!/bin/sh
PID="$1"; OLD="$2"; NEW="$3"; BAK="$4"; RELAUNCH="$5"; DIR="$6"
i=0
while kill -0 "$PID" 2>/dev/null && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done
rm -rf "$BAK"
if mv "$OLD" "$BAK"; then
  if mv "$NEW" "$OLD"; then rm -rf "$BAK"; else mv "$BAK" "$OLD"; fi
fi
[ "$RELAUNCH" = 1 ] && ${openCmd}
rm -rf "$DIR"
`, { mode: 0o755 });
  spawn('/bin/sh', [script, String(process.pid), bundle, newApp, backup, relaunch ? '1' : '0', dir], { detached: true, stdio: 'ignore' }).unref();
}

// ---------------------------------------------------------------- restart

async function beginCountdown() {
  clearInterval(countdownTimer);
  if (await opts.isBusy()) return set({ state: 'ready', countdown: null, blocked: true });
  let n = COUNTDOWN_S;
  set({ state: 'ready', countdown: n, blocked: false });
  countdownTimer = setInterval(async () => {
    n -= 1;
    if (n > 0) return set({ countdown: n });
    clearInterval(countdownTimer);
    countdownTimer = null;
    // Something may have started during the countdown.
    if (await opts.isBusy()) return set({ state: 'ready', countdown: null, blocked: true });
    restartNow();
  }, 1000);
}

function cancelCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
  if (status.state === 'ready') set({ countdown: null, blocked: false });
}

/** The "Restart now" button: asks first when an upload runs or a file has unsaved changes. */
async function restartRequested(e) {
  if (status.state !== 'ready' || !staged) return;
  cancelCountdown();
  if (await opts.isBusy()) {
    const win = BrowserWindow.fromWebContents(e.sender);
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Restart anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Uploads are still running or a file has unsaved changes.',
      detail: 'Restarting now stops the uploads and discards the changes.',
    });
    if (response !== 0) return;
  }
  restartNow();
}

function restartNow() {
  if (!staged || restarting) return;
  restarting = true;
  try {
    opts.beforeRestart();
  } catch { /* ignore */ }
  if (staged.kind === 'mac') {
    spawnMacSwap(true);
    app.exit(0);
  } else {
    app.relaunch({ execPath: staged.file, args: process.argv.slice(1) });
    app.exit(0);
  }
}

// ---------------------------------------------------------------- wiring

/**
 * opts.fromApp(event): IPC is only accepted from the app's own pages.
 * opts.isBusy(): resolves true while an upload runs or a file has unsaved changes in any window.
 * opts.beforeRestart(): save what should survive the restart (window positions).
 */
function initUpdater(o) {
  opts = { ...opts, ...o };
  const on = (channel, fn) => ipcMain.on(channel, (e, ...a) => o.fromApp(e) && fn(e, ...a));
  ipcMain.handle('update-status', (e) => (o.fromApp(e) ? status : null));
  on('update-check', () => check({ manual: true }));
  on('update-start', () => startUpdate());
  on('update-cancel', () => request?.abort());
  on('update-restart', (e) => restartRequested(e));
  on('update-later', () => cancelCountdown());
  on('update-open-release', () => shell.openExternal(status.releaseUrl || releasePage()));
  on('update-retry', () => {
    if (status.state === 'error') {
      set({ state: 'available', error: null });
      startUpdate();
    }
  });

  // A cancelled countdown leaves the update staged: apply it when the app quits (macOS; an
  // AppImage was already replaced on disk).
  app.on('will-quit', () => {
    if (staged?.kind === 'mac' && !restarting) {
      restarting = true;
      spawnMacSwap(false);
    }
  });

  if (!CONFIGURED && !FEED) return;
  if (!app.isPackaged && !FEED) return; // `npm run app` from the source folder never updates itself
  setTimeout(() => check(), FIRST_CHECK_MS);
  setInterval(() => check(), CHECK_EVERY_MS);
}

const updatesConfigured = () => CONFIGURED || Boolean(FEED);

module.exports = { initUpdater, checkForUpdates: () => check({ manual: true }), updatesConfigured, compareVersions };
