'use strict';

/**
 * macOS desktop app (Electron).
 *
 * Starts the console's server inside the app on 127.0.0.1 (port 47821 when free) and shows it in
 * native windows. A random per-launch token is required for every WebSocket, so other programs on
 * the Mac can't use the app's server. Saved passwords/keys are encrypted with Electron safeStorage,
 * whose key is kept in the macOS Keychain.
 */

const { app, BrowserWindow, Menu, shell, safeStorage, dialog, nativeTheme, Notification, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { startServer } = require('../server');
const { Store } = require('../lib/store');
const { initUpdater, checkForUpdates, updatesConfigured } = require('./updater');

const APP_NAME = 'ssh-console';
// app.setName() also decides the data folder and the Keychain entry that encrypts saved passwords.
// Installs from before the rename (as "SSH Docker Console") keep that identity, so their saved
// connections, passwords and preferences keep working; new installs use the new name. Everything
// the user sees says ssh-console either way.
const LEGACY_NAME = 'SSH Docker Console';
const appData = app.getPath('appData');
const keepLegacy = fs.existsSync(path.join(appData, LEGACY_NAME)) && !fs.existsSync(path.join(appData, APP_NAME));
// SSH_CONSOLE_INSTANCE=<name> runs a separate instance (own data folder, Keychain entry and
// single-instance lock), e.g. to try a build next to the installed app.
const INSTANCE = String(process.env.SSH_CONSOLE_INSTANCE || '').replace(/[^\w-]/g, '').slice(0, 32);
app.setName(INSTANCE ? `${APP_NAME}-${INSTANCE}` : keepLegacy ? LEGACY_NAME : APP_NAME);
app.setAboutPanelOptions({ applicationName: APP_NAME, copyright: 'Copyright © 2026 Amit Das' });

// Every renderer is sandboxed, whatever a window asks for.
app.enableSandbox();
const DEV = !app.isPackaged;

const PREFERRED_PORT = 47821; // stable port keeps the window's localStorage (history, preferences) between launches
const token = crypto.randomBytes(24).toString('hex');
const windows = new Set();
let baseUrl = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = [...windows][0];
    if (!w) return createWindow();
    if (w.isMinimized()) w.restore();
    w.focus();
  });
}

// ---------------------------------------------------------------- window state

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadBounds() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return null;
  }
}

function saveBounds(win) {
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch { /* ignore */ }
}

function createWindow({ fresh = false } = {}) {
  const saved = windows.size === 0 ? loadBounds() : null;
  const win = new BrowserWindow({
    width: saved?.width || 1440,
    height: saved?.height || 900,
    x: saved?.x,
    y: saved?.y,
    minWidth: 880,
    minHeight: 560,
    title: APP_NAME,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 17 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#f5f6f8',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      devTools: DEV,
      spellcheck: false,
    },
  });
  if (saved?.maximized) win.maximize();
  windows.add(win);

  win.once('ready-to-show', () => win.show());
  win.on('close', () => saveBounds(win));
  win.on('closed', () => windows.delete(win));

  // Links (published ports, docs) open in the default browser; the app itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // ⌘R refreshes the data on screen instead of reloading the page, so an accidental reload never
  // throws away what you were doing. (Ctrl+R and F5 are handled by the page, which leaves them to a
  // focused terminal.) "Reload Window" (⇧⌘R) still reloads, and the page resumes its SSH session.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    // Chrome's tab shortcuts, before any page (terminal, editor) can take them.
    const cmd = tabShortcut(input);
    if (cmd) {
      e.preventDefault();
      if (cmd === 'newWindow') createWindow({ fresh: true });
      else tabCommand(win, cmd);
      return;
    }
    if (process.platform !== 'darwin') return;
    if (String(input.key || '').toLowerCase() === 'r' && input.meta && !input.control && !input.shift && !input.alt) {
      e.preventDefault();
      softRefresh(win);
    }
  });
  // The page asks before unloading while uploads run or a file has unsaved changes.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Leave anyway', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      message: 'Uploads are still running or a file has unsaved changes.',
      detail: 'Leaving now stops the uploads and discards the changes.',
    });
    if (choice === 0) e.preventDefault(); // preventDefault here means: ignore the page and unload
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(baseUrl)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  const q = new URLSearchParams({ k: token });
  if (!fresh && windows.size === 1) q.set('auto', '1'); // only the first window auto-connects
  win.loadURL(`${baseUrl}/?${q}`);
  return win;
}

// ---------------------------------------------------------------- menu

/**
 * Chrome's tab shortcuts → tab command (kept in sync with public/js/tabkeys.js):
 * ⌘T new · ⌘W close · ⇧⌘T reopen · ⌃Tab / ⌥⌘→ / ⇧⌘] / Ctrl+PageDown next · ⌃⇧Tab / ⌥⌘← / ⇧⌘[ /
 * Ctrl+PageUp previous · ⌘1…8 tab N · ⌘9 last tab · ⌃⇧PageUp/PageDown move tab · ⇧⌘A search tabs ·
 * ⌘N new window. (On Windows/Linux, Ctrl instead of ⌘; Ctrl+F4 also closes the tab.)
 */
function tabShortcut(input) {
  const mac = process.platform === 'darwin';
  const { code = '', key = '' } = input;
  const mod = mac ? input.meta && !input.control : input.control && !input.meta;
  if (mod && !input.alt) {
    if (code === 'KeyT') return input.shift ? 'reopen' : 'new';
    if (code === 'KeyW' && !input.shift) return 'close';
    if (code === 'KeyA' && input.shift) return 'search';
    if (code === 'KeyN' && !input.shift) return 'newWindow';
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code);
    if (digit && !input.shift) return digit[1] === '9' ? 'last' : `select:${digit[1]}`;
    if (mac && input.shift && (code === 'BracketRight' || code === 'BracketLeft')) return code === 'BracketRight' ? 'next' : 'prev';
  }
  if (mac && input.meta && input.alt && !input.control && !input.shift && (key === 'ArrowRight' || key === 'ArrowLeft')) return key === 'ArrowRight' ? 'next' : 'prev';
  if (input.control && !input.meta && !input.alt) {
    if (key === 'Tab') return input.shift ? 'prev' : 'next';
    if (key === 'PageDown' || key === 'PageUp') {
      if (input.shift) return key === 'PageDown' ? 'moveRight' : 'moveLeft';
      return key === 'PageDown' ? 'next' : 'prev';
    }
    if (key === 'F4' && !input.shift && !mac) return 'close';
  }
  return null;
}

function tabCommand(win, cmd) {
  if (win && !win.isDestroyed()) win.webContents.send('tab-command', cmd);
}

function softRefresh(win) {
  if (win && !win.isDestroyed()) win.webContents.send('soft-refresh');
}

function buildMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `About ${APP_NAME}` },
        ...(updatesConfigured() ? [{ label: 'Check for Updates…', click: () => checkForUpdates() }] : []),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${APP_NAME}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${APP_NAME}` },
      ],
    },
    {
      label: 'File',
      // Shortcuts are handled in before-input-event (so terminals can't take them); the menu shows them.
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', registerAccelerator: false, click: (_i, win) => tabCommand(win, 'new') },
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', registerAccelerator: false, click: () => createWindow({ fresh: true }) },
        { label: 'Reopen Closed Tab', accelerator: 'Shift+CmdOrCtrl+T', registerAccelerator: false, click: (_i, win) => tabCommand(win, 'reopen') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', registerAccelerator: false, click: (_i, win) => tabCommand(win, 'close') },
        { role: 'close', label: 'Close Window', accelerator: 'Shift+CmdOrCtrl+W' },
      ],
    },
    {
      label: 'Tab',
      submenu: [
        { label: 'Select Next Tab', accelerator: 'Ctrl+Tab', registerAccelerator: false, click: (_i, win) => tabCommand(win, 'next') },
        { label: 'Select Previous Tab', accelerator: 'Ctrl+Shift+Tab', registerAccelerator: false, click: (_i, win) => tabCommand(win, 'prev') },
        { label: 'Search Tabs…', accelerator: 'Shift+CmdOrCtrl+A', registerAccelerator: false, click: (_i, win) => tabCommand(win, 'search') },
        { type: 'separator' },
        { label: 'Move Tab Left', accelerator: 'Ctrl+Shift+PageUp', registerAccelerator: false, click: (_i, win) => tabCommand(win, 'moveLeft') },
        { label: 'Move Tab Right', accelerator: 'Ctrl+Shift+PageDown', registerAccelerator: false, click: (_i, win) => tabCommand(win, 'moveRight') },
        { type: 'separator' },
        { label: 'Duplicate Tab', click: (_i, win) => tabCommand(win, 'duplicate') },
        { label: 'Pin / Unpin Tab', click: (_i, win) => tabCommand(win, 'pin') },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Refresh View',
          accelerator: 'CmdOrCtrl+R',
          registerAccelerator: false, // handled in before-input-event, so terminals keep their keys
          click: (_item, win) => softRefresh(win),
        },
        {
          label: 'Reload Window',
          accelerator: 'Shift+CmdOrCtrl+R',
          click: (_item, win) => win && !win.isDestroyed() && win.webContents.reload(),
        },
        ...(DEV ? [{ role: 'toggleDevTools' }] : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Open Data Folder', click: () => shell.openPath(app.getPath('userData')) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- hardening

// No webviews, no pop-up windows and no navigation away from the app, in any web contents.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !(baseUrl && url.startsWith(baseUrl))) shell.openExternal(url);
    return { action: 'deny' };
  });
});

/** Web permissions: deny everything except writing to the clipboard (copy buttons) and fullscreen. */
function lockPermissions(ses) {
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
  const ours = (url) => Boolean(baseUrl && String(url || '').startsWith(baseUrl));
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.has(permission) && ours(wc.getURL())));
  ses.setPermissionCheckHandler((wc, permission) => allowed.has(permission) && ours(wc?.getURL()));
  ses.setDevicePermissionHandler(() => false);
}

/** IPC is only accepted from the app's own page, never from anything else that might load. */
const fromApp = (e) => Boolean(baseUrl && String(e.senderFrame?.url || '').startsWith(baseUrl));
const onIpc = (channel, fn) => ipcMain.on(channel, (e, ...args) => fromApp(e) && fn(e, ...args));

// ---------------------------------------------------------------- IPC from the page

onIpc('new-window', () => createWindow({ fresh: true }));
onIpc('notify', (e, { title, body } = {}) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: String(title || '').slice(0, 120), body: String(body || '').slice(0, 300) });
  const win = BrowserWindow.fromWebContents(e.sender);
  n.on('click', () => win && !win.isDestroyed() && (win.show(), win.focus()));
  n.show();
});
// ---------------------------------------------------------------- downloads (progress → status island)

const downloads = new Map(); // url -> { item, path }
const isOwnDownload = (url) => typeof url === 'string' && baseUrl && url.startsWith(`${baseUrl}/api/download/`);

function uniquePath(dir, name) {
  const safe = String(name || 'download').replace(/[/\\:\0]/g, '_').slice(0, 200) || 'download';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let p = path.join(dir, safe);
  for (let i = 1; fs.existsSync(p) && i < 1000; i++) p = path.join(dir, `${stem} (${i})${ext}`);
  return p;
}

onIpc('download', (e, url) => {
  if (isOwnDownload(url)) e.sender.downloadURL(url);
});
onIpc('download-cancel', (_e, url) => downloads.get(url)?.item?.cancel());
onIpc('download-reveal', (_e, url) => {
  const d = downloads.get(url);
  if (d?.done && d.path) shell.showItemInFolder(d.path);
});

function wireDownloads(ses) {
  ses.on('will-download', (_event, item, wc) => {
    const url = item.getURL();
    if (!isOwnDownload(url)) return; // anything else keeps Electron's default behaviour
    const file = uniquePath(app.getPath('downloads'), item.getFilename());
    item.setSavePath(file);
    const rec = { item, path: file, done: false };
    downloads.set(url, rec);
    const send = (state) => {
      if (wc.isDestroyed()) return;
      wc.send('download-progress', { url, state, received: item.getReceivedBytes(), total: item.getTotalBytes(), filename: path.basename(file) });
    };
    let last = 0;
    item.on('updated', (_e, state) => {
      const now = Date.now();
      if (state === 'progressing' && now - last < 100) return;
      last = now;
      send(state === 'interrupted' ? 'interrupted' : 'progressing');
    });
    item.once('done', (_e, state) => {
      rec.done = state === 'completed';
      rec.item = null;
      send(state);
      setTimeout(() => downloads.delete(url), 10 * 60 * 1000);
    });
  });
}

onIpc('badge', (_e, count) => {
  if (app.dock) app.dock.setBadge(count > 0 ? String(count) : '');
});

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(async () => {
  const store = new Store({
    dataDir: app.getPath('userData'),
    secrets: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
      decrypt: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
    },
  });
  try {
    const r = await startServer({ host: '127.0.0.1', port: PREFERRED_PORT, fallbackToRandomPort: true, token, store });
    baseUrl = r.url;
  } catch (err) {
    dialog.showErrorBox(`${APP_NAME} could not start`, err.message);
    app.quit();
    return;
  }
  buildMenu();
  initUpdater({
    fromApp,
    // An upload or an unsaved file in any window holds the automatic restart back.
    isBusy: async () => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        try {
          if (await w.webContents.executeJavaScript('Boolean(window.__sdcShellBusy && window.__sdcShellBusy())')) return true;
        } catch { /* window still loading */ }
      }
      return false;
    },
    beforeRestart: () => {
      for (const w of windows) if (!w.isDestroyed()) saveBounds(w);
    },
  });
  lockPermissions(require('electron').session.defaultSession);
  wireDownloads(require('electron').session.defaultSession);
  createWindow();

  app.on('activate', () => {
    if (windows.size === 0) createWindow();
  });
});

// macOS convention: closing the last window keeps the app in the Dock.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
