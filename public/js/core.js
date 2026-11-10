// Shared helpers, WebSocket RPC, app state and small UI builders.
import { icon } from './icons.js';

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const shortId = (id) => (id || '').replace(/^sha256:/, '').slice(0, 12);
export const firstName = (names) => String(names || '').split(',')[0].replace(/^\//, '');
export const uid = (p = 'x') => p + Math.random().toString(36).slice(2) + Date.now().toString(36);

export const storage = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch { /* storage unavailable */ }
  },
};

// ------------------------------------------------------------------ formatting
export function relTime(d) {
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  const abs = Math.abs(sec);
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  for (const [u, n] of units) {
    if (abs >= n || u === 'second') {
      const v = Math.floor(abs / n);
      return sec >= 0 ? `${v} ${u}${v === 1 ? '' : 's'} ago` : `in ${v} ${u}${v === 1 ? '' : 's'}`;
    }
  }
}
export function fmtDate(s) {
  if (!s || String(s).startsWith('0001-01-01')) return '—';
  const d = new Date(s);
  if (isNaN(d)) return s;
  return `${d.toLocaleString()} (${relTime(d)})`;
}
export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  if (!n) return '0 B';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const i = Math.min(Math.floor(Math.log(Math.abs(n)) / Math.log(1024)), u.length - 1);
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
export function fmtDuration(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
export const cmdStr = (v) => (Array.isArray(v) ? v.join(' ') : v || '');

// ------------------------------------------------------------------ UI builders
export const kv = (rows) =>
  `<dl class="kv">${rows
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v, mono]) => `<dt>${esc(k)}</dt><dd${mono ? ' class="mono"' : ''}>${v}</dd>`)
    .join('')}</dl>`;
export const card = (title, body, cls = '') => `<section class="card ${cls}"><h3>${title}</h3>${body}</section>`;
export const table = (heads, rows, cls = '') =>
  rows.length
    ? `<div class="tbl-wrap"><table class="tbl ${cls}"><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>`
    : '<div class="none">None</div>';
export const bar = (pct, warnAt = 80) =>
  `<div class="bar"><i class="${pct >= 90 ? 'crit' : pct >= warnAt ? 'warn' : ''}" style="width:${Math.max(0, Math.min(pct, 100)).toFixed(1)}%"></i></div>`;
export const msg = (text, cls = 'list-msg') => `<div class="${cls}">${esc(text)}</div>`;
export const errorBox = (text) => `<div class="alert error inset">${esc(text)}</div>`;

// Notices go to the status island (see island.js); uploads and downloads too (transfers.js).
export { toast } from './island.js';
import { toast } from './island.js';

// ------------------------------------------------------------------ tabs
// The console normally runs as one tab of the tab bar (public/tabs.html): a same-origin frame with
// ?tab=<id>, its own WebSocket and its own SSH session. Tabs share the window's sessionStorage, so
// per-tab values (the session to resume after a reload) are stored under "<key>@<tab id>".
export const TAB_ID = new URLSearchParams(location.search).get('tab') || '';
export const inTab = Boolean(TAB_ID) && window.parent !== window;
const tabKey = (k) => (TAB_ID ? `${k}@${TAB_ID}` : k);
export const tabSession = {
  get(k) {
    try {
      return sessionStorage.getItem(tabKey(k));
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      sessionStorage.setItem(tabKey(k), v);
    } catch { /* storage unavailable */ }
  },
  remove(k) {
    try {
      sessionStorage.removeItem(tabKey(k));
    } catch { /* storage unavailable */ }
  },
};
/** Tell the tab bar about this tab: { title, sub, status, tile, profileKey }. */
export function reportTab(info) {
  if (inTab) parent.postMessage({ type: 'sdc-tab-info', ...info }, location.origin);
}
/** Ask the tab bar to run a tab command (new, close, next, …). */
export function tabCommand(cmd) {
  if (inTab) parent.postMessage({ type: 'sdc-tab-cmd', cmd }, location.origin);
}

// ------------------------------------------------------------------ desktop app bridge + preferences
/**
 * In the Mac app the bridge lives in the tab bar's window. A tab uses it for calls (downloads,
 * notifications, new window), but events go through the tab bar, which routes them: download
 * progress to every tab, ⌘R to the visible one, and the dock badge adds up all tabs.
 */
function tabDesktop() {
  let pd = null;
  try {
    pd = window.parent.desktop || null;
  } catch { /* not same-origin */ }
  if (!pd) return null;
  const post = (m) => parent.postMessage(m, location.origin);
  const listen = (type, fn) =>
    typeof fn === 'function' &&
    addEventListener('message', (e) => {
      if (e.source === parent && e.origin === location.origin && e.data?.type === type) fn(e.data.payload);
    });
  return {
    isDesktop: true,
    platform: pd.platform,
    newWindow: () => pd.newWindow(),
    notify: (title, body) => pd.notify(title, body),
    download: (url) => pd.download(url),
    cancelDownload: (url) => pd.cancelDownload(url),
    revealDownload: (url) => pd.revealDownload(url),
    setBadge: (count) => post({ type: 'sdc-badge', count: Number(count) || 0 }),
    onDownloadProgress: (fn) => listen('sdc-download-progress', fn),
    onSoftRefresh: (fn) => listen('sdc-soft-refresh', fn),
  };
}
export const desktop = (inTab ? tabDesktop() : window.desktop) || null;

const PREF_DEFAULTS = { theme: 'system', notify: true, restoreSession: true, fontSize: 13, logLevels: true, idleMinutes: 60 };
export const prefs = {
  get(k) {
    return { ...PREF_DEFAULTS, ...storage.get('sdc.prefs', {}) }[k];
  },
  all() {
    return { ...PREF_DEFAULTS, ...storage.get('sdc.prefs', {}) };
  },
  set(k, v) {
    storage.set('sdc.prefs', { ...storage.get('sdc.prefs', {}), [k]: v });
    emit('prefs', { [k]: v });
  },
};

/** System notification (desktop app, or browser Notification when permitted). */
export function notify(title, body) {
  if (!prefs.get('notify')) return;
  if (desktop) return desktop.notify(title, body);
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try {
      new Notification(title, { body });
    } catch { /* ignore */ }
  }
}

export async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast('Clipboard not available', true);
  }
}

export function downloadBlob(filename, content, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ------------------------------------------------------------------ state + events
export const state = {
  connected: false,
  info: null,
  containers: [],
  selected: null,
  view: 'host',
};

const bus = new EventTarget();
export const on = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

// ------------------------------------------------------------------ WebSocket RPC
let ws = null;
let seq = 0;
const pending = new Map();
const streamHandlers = {};

export const onStream = (type, fn) => (streamHandlers[type] = fn);

// The desktop app passes a per-launch access token in the page URL.
// The access token arrives once in the link (?k=…). It is moved into this tab's sessionStorage and
// removed from the address bar, so it doesn't linger in history, bookmarks or screenshots.
const accessToken = (() => {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('k');
  let t = fromUrl || '';
  try {
    if (fromUrl) sessionStorage.setItem('sdc.k', fromUrl);
    else t = sessionStorage.getItem('sdc.k') || '';
  } catch { /* storage unavailable: keep it in memory */ }
  if (fromUrl) {
    url.searchParams.delete('k');
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }
  return t;
})();
export const hasAccessToken = () => Boolean(accessToken);

/**
 * Return the open socket, or open one. Concurrent callers share the socket being opened
 * (opening a second one would close the first while it is still connecting).
 */
let opening = null;
export function ensureSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
  if (!opening) opening = openSocket().finally(() => (opening = null));
  return opening;
}

export function openSocket() {
  return new Promise((resolve, reject) => {
    if (ws) {
      const old = ws;
      ws = null;
      old.close();
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws${accessToken ? `?k=${encodeURIComponent(accessToken)}` : ''}`);
    let opened = false;
    sock.onopen = () => {
      opened = true;
      resolve(sock);
    };
    sock.onerror = () => {
      if (opened) return;
      reject(new Error(accessToken
        ? 'Cannot reach the console server, or this access link is no longer valid. Is it running? Open the link it printed.'
        : 'This page needs its access link. Open the link that `npm start` printed (it ends in ?k=…).'));
    };
    sock.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === 'result') {
        const p = pending.get(m.reqId);
        if (!p) return;
        pending.delete(m.reqId);
        m.ok ? p.resolve(m.data) : p.reject(new Error(m.error));
      } else if (streamHandlers[m.type]) {
        streamHandlers[m.type](m);
      }
    };
    sock.onclose = () => {
      for (const p of pending.values()) p.reject(new Error('Connection to the console server was lost'));
      pending.clear();
      if (ws === sock) {
        ws = null;
        if (state.connected) emit('disconnected', 'Connection to the console server was lost.');
      }
    };
    ws = sock;
  });
}

export function closeSocket() {
  const s = ws;
  ws = null;
  s?.close();
}

export function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// How long the page waits for an answer before giving up (ms; 0 = no limit). Server-side
// commands have their own timeouts; these only make sure the page never waits forever.
const RPC_TIMEOUTS = {
  connect: 60000, reconnect: 60000, 'docker.fixAccess': 60000,
  action: 150000, actionMany: 330000, 'docker.imageRemove': 150000, 'docker.imagePrune': 330000,
  'files.remove': 330000, 'files.move': 330000, 'files.du': 150000,
  'db.query': 0, // long queries are fine; they have their own limit and a Cancel button
  'sys.serviceAction': 150000, 'sys.run': 60000, 'sys.journal': 60000,
};
export const PROTOCOL = 2; // must match server.js

export function rpc(type, data = {}, { timeout } = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
    const reqId = ++seq;
    const ms = timeout ?? RPC_TIMEOUTS[type] ?? 90000;
    const timer = ms
      ? setTimeout(() => {
          if (!pending.has(reqId)) return;
          pending.delete(reqId);
          const err = new Error(`The console server did not answer (${type}). If this keeps happening, restart it.`);
          err.timeout = true;
          reject(err);
        }, ms)
      : null;
    pending.set(reqId, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    send({ type, reqId, ...data });
  });
}

/**
 * Is the running console server the same code as this page? A server started before an update
 * keeps running the old code while serving the new page. Resolves true when it is out of date.
 */
export async function serverOutdated() {
  try {
    const h = await rpc('hello', {}, { timeout: 5000 });
    return h.protocol !== PROTOCOL || !!h.outdated;
  } catch (err) {
    // Servers from before the handshake never answer it, or answer "Unknown request".
    return !!err.timeout || /unknown request/i.test(err.message);
  }
}

export const containerById = (id) => state.containers.find((c) => c.ID === id);

/** Give a segmented control (.seg) a pill thumb that slides to the active button. */
export function enhanceSeg(seg) {
  if (seg.dataset.thumb) return;
  seg.dataset.thumb = '1';
  seg.classList.add('has-thumb');
  const thumb = document.createElement('span');
  thumb.className = 'seg-thumb';
  seg.prepend(thumb);
  const place = (instant) => {
    const b = seg.querySelector(':scope > button.active');
    if (!b || !b.offsetWidth) {
      thumb.style.opacity = '0';
      return;
    }
    if (instant || thumb.style.opacity === '0' || !thumb.style.width) thumb.classList.add('instant');
    thumb.style.opacity = '1';
    thumb.style.width = `${b.offsetWidth}px`;
    thumb.style.height = `${b.offsetHeight}px`;
    thumb.style.transform = `translate(${b.offsetLeft}px, ${b.offsetTop}px)`;
    requestAnimationFrame(() => requestAnimationFrame(() => thumb.classList.remove('instant')));
  };
  new MutationObserver((muts) => {
    if (muts.some((m) => m.target !== thumb)) place(false);
  }).observe(seg, { attributes: true, subtree: true, attributeFilter: ['class', 'hidden', 'disabled'] });
  new ResizeObserver(() => place(true)).observe(seg);
  place(true);
}

/** Enhance every .seg now and whenever new ones appear (dialogs, database panels...). */
export function enhanceSegsEverywhere() {
  document.querySelectorAll('.seg').forEach(enhanceSeg);
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches('.seg')) enhanceSeg(n);
        n.querySelectorAll?.('.seg').forEach(enhanceSeg);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

/** Run a DOM change as a smooth cross-fade where the browser supports view transitions. */
export function withTransition(fn) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || reduce) return fn();
  document.startViewTransition(fn);
}

/** Briefly mark an element so its children play their entrance animation once. */
export function animateIn(el, ms = 1400) {
  if (!el) return;
  el.classList.remove('animate-in');
  void el.offsetWidth;
  el.classList.add('animate-in');
  clearTimeout(el._animT);
  el._animT = setTimeout(() => el.classList.remove('animate-in'), ms);
}

// Each saved connection gets its own colour, used for its icon tile everywhere.
const TILE_COLORS = [
  ['#22d3ee', '#0891b2'], // cyan
  ['#0ea5e9', '#2563eb'], // blue
  ['#10b981', '#059669'], // emerald
  ['#f59e0b', '#ea580c'], // amber
  ['#94a3b8', '#475569'], // slate
  ['#14b8a6', '#0e7490'], // teal
  ['#84cc16', '#15803d'], // lime
  ['#f43f5e', '#be123c'], // rose
];
function hash32(str) {
  let h = 0x811c9dc5;
  for (const ch of String(str)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  return h >>> 0;
}
let tileAssignment = new Map();
/** Give every saved connection a distinct colour (stable: keys are processed in sorted order). */
export function assignTiles(keys) {
  const used = new Set();
  tileAssignment = new Map();
  for (const key of [...keys].sort()) {
    let i = hash32(key) % TILE_COLORS.length;
    for (let n = 0; n < TILE_COLORS.length && used.has(i); n++) i = (i + 1) % TILE_COLORS.length;
    used.add(i);
    if (used.size === TILE_COLORS.length) used.clear();
    tileAssignment.set(key, i);
  }
}
export function tileStyle(key = '') {
  const i = tileAssignment.has(key) ? tileAssignment.get(key) : hash32(key) % TILE_COLORS.length;
  const [a, b] = TILE_COLORS[i];
  return `--tile-a:${a};--tile-b:${b}`;
}

/** Database engine guessed from an image name (mirrors lib/db.js detectEngine). */
export function dbEngineOf(image = '') {
  const img = image.toLowerCase();
  if (/mysql|mariadb|percona/.test(img)) return 'mysql';
  if (/postgres|postgis|timescale|pgvector|supabase\/postgres/.test(img)) return 'postgres';
  if (/mongo/.test(img)) return 'mongo';
  if (/redis|valkey|keydb/.test(img)) return 'redis';
  return null;
}
export const ENGINE_LABEL = { mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'Postgres', mongo: 'MongoDB', redis: 'Redis' };
/** Like dbEngineOf, but tells MariaDB apart from MySQL (for labels and colours). */
export function dbFlavorOf(image = '') {
  const eng = dbEngineOf(image);
  return eng === 'mysql' && /mariadb/i.test(image) ? 'mariadb' : eng;
}
/** Coloured engine chip (Postgres blue, MySQL orange, MariaDB tan, MongoDB green, Redis red). */
export const dbBadge = (image) => {
  const f = dbFlavorOf(image);
  return f ? `<span class="db-badge eng-${f}">${esc(ENGINE_LABEL[f])}</span>` : '';
};

/**
 * Sub-tab controller with a sliding pill thumb (Kokonut "smooth tab").
 * Buttons [data-tab] inside navEl, panels [data-panel] inside panelsEl.
 */
export function tabs(navEl, panelsEl, onChange) {
  const track = document.createElement('div');
  track.className = 'tab-track';
  const thumb = document.createElement('span');
  thumb.className = 'tab-thumb';
  track.appendChild(thumb);
  for (const b of $$('[data-tab]', navEl)) track.appendChild(b);
  navEl.prepend(track);

  const place = (instant) => {
    const b = $('[data-tab].active', track);
    if (!b || !b.offsetWidth) return;
    thumb.classList.toggle('instant', !!instant);
    thumb.style.width = `${b.offsetWidth}px`;
    thumb.style.transform = `translateX(${b.offsetLeft - 4}px)`;
    if (instant) requestAnimationFrame(() => thumb.classList.remove('instant'));
    const l = b.offsetLeft;
    const r = l + b.offsetWidth;
    if (l < track.scrollLeft || r > track.scrollLeft + track.clientWidth) {
      track.scrollTo({ left: l - 24, behavior: instant ? 'auto' : 'smooth' });
    }
  };
  // Re-measure when the tabs become visible, change size, or a tab is shown/hidden.
  new ResizeObserver(() => place(true)).observe(track);
  new MutationObserver(() => requestAnimationFrame(() => place(true))).observe(track, {
    attributes: true,
    subtree: true,
    attributeFilter: ['hidden'],
  });

  const ctl = {
    current: null,
    show(name) {
      const first = ctl.current === null;
      ctl.current = name;
      $$('[data-tab]', track).forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
      $$(':scope > [data-panel]', panelsEl).forEach((p) => (p.hidden = p.dataset.panel !== name));
      place(first);
      onChange?.(name);
    },
  };
  track.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b && !b.hidden) ctl.show(b.dataset.tab);
  });
  return ctl;
}
