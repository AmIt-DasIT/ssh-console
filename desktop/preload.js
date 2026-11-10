'use strict';

// The only bridge between the page and the app: a few fire-and-forget calls. No Node access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  newWindow: () => ipcRenderer.send('new-window'),
  notify: (title, body) => ipcRenderer.send('notify', { title: String(title), body: String(body) }),
  setBadge: (count) => ipcRenderer.send('badge', Number(count) || 0),
  // Downloads go through the app's download manager (saved to Downloads); progress comes back.
  download: (url) => ipcRenderer.send('download', String(url)),
  cancelDownload: (url) => ipcRenderer.send('download-cancel', String(url)),
  revealDownload: (url) => ipcRenderer.send('download-reveal', String(url)),
  onDownloadProgress: (fn) => {
    if (typeof fn === 'function') ipcRenderer.on('download-progress', (_e, d) => fn(d));
  },
  // Tab shortcuts and menu items (new tab, close tab, next tab, …), caught by the app before any page.
  onTabCommand: (fn) => {
    if (typeof fn === 'function') ipcRenderer.on('tab-command', (_e, cmd) => fn(String(cmd)));
  },
  // Self-update (desktop/updater.js): status pushes + the tab bar's buttons.
  update: {
    status: () => ipcRenderer.invoke('update-status'),
    onStatus: (fn) => {
      if (typeof fn === 'function') ipcRenderer.on('update-status', (_e, s) => fn(s));
    },
    check: () => ipcRenderer.send('update-check'),
    start: () => ipcRenderer.send('update-start'),
    cancel: () => ipcRenderer.send('update-cancel'),
    retry: () => ipcRenderer.send('update-retry'),
    restart: () => ipcRenderer.send('update-restart'),
    later: () => ipcRenderer.send('update-later'),
    openRelease: () => ipcRenderer.send('update-open-release'),
  },
  // ⌘R / F5 in the app: refresh what is on screen instead of reloading the page.
  onSoftRefresh: (fn) => {
    if (typeof fn === 'function') ipcRenderer.on('soft-refresh', () => fn());
  },
});
