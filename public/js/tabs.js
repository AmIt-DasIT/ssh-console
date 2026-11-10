// Chrome-style tab bar. Every tab is the whole console (/app?tab=<id>) in its own frame, with its
// own WebSocket and SSH session, so any number of servers can be open side by side.
//
// - Tabs, the active tab and recently closed tabs survive a reload (sessionStorage). A tab's page
//   keeps its SSH session for a few minutes after it goes away, so a reload or "Reopen closed tab"
//   picks the same session (and its terminals) back up.
// - Shortcuts: see tabkeys.js. In the Mac app they are caught before any page sees them.
// - Mouse: click to switch, middle-click to close, drag to reorder, double-click the empty bar for a
//   new tab, right-click for Duplicate / Pin / Close others / Close to the right / Reopen.
import { icon } from './icons.js';
import { installTabKeys, KEYS, isMac } from './tabkeys.js';
import { confirmDialog } from './ui.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const desktop = window.desktop || null;
const STORE = 'sdc.tabs';
const MAX_CLOSED = 25;

// The access token arrives once in the link (?k=…). It is kept in this window's sessionStorage,
// which the tabs' frames share, and removed from the address bar.
const params = new URLSearchParams(location.search);
try {
  if (params.get('k')) sessionStorage.setItem('sdc.k', params.get('k'));
} catch { /* storage unavailable */ }
const autoFirst = params.get('auto') === '1';
if (location.search) history.replaceState(null, '', location.pathname);

const strip = $('#tabstrip');
const frames = $('#tabframes');
$('#tab-new').innerHTML = icon('plus');
$('#tab-new').title = `New tab (${KEYS.new})`;
$('#tab-search').innerHTML = icon('chevronDown');
$('#tab-search').title = `Search tabs (${KEYS.search})`;

/** tabs: [{ id, pinned, title, sub, status, tile, profileKey, attention, frame }] */
let tabs = [];
let activeId = null;
let closed = []; // [{ id, index, pinned, title, sub, tile, profileKey }]
const badges = new Map();
const els = new Map();

const newId = () => Math.random().toString(36).slice(2, 10);
const byId = (id) => tabs.find((t) => t.id === id);
const active = () => byId(activeId);
const pinnedCount = () => tabs.filter((t) => t.pinned).length;

function save() {
  try {
    sessionStorage.setItem(
      STORE,
      JSON.stringify({
        tabs: tabs.map(({ id, pinned, title, sub, tile, profileKey, production }) => ({ id, pinned, title, sub, tile, profileKey, production })),
        active: activeId,
        closed,
      }),
    );
  } catch { /* storage unavailable */ }
}

function restore() {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) || 'null');
  } catch {
    return null;
  }
}

/** A closed tab that can no longer be reopened: drop its per-tab session keys. */
function forget(id) {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.endsWith(`@${id}`)) sessionStorage.removeItem(k);
    }
  } catch { /* storage unavailable */ }
}

// ------------------------------------------------------------------ tabs

function createTab({ id = newId(), index = tabs.length, pinned = false, auto = false, profile = '', activate = true, title = 'New tab', sub = '', tile = '', profileKey = '', production = false } = {}) {
  const frame = document.createElement('iframe');
  frame.className = 'tab-frame';
  frame.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
  frame.title = title;
  const q = new URLSearchParams({ tab: id });
  if (auto) q.set('auto', '1');
  if (profile) q.set('profile', profile);
  frame.src = `/app?${q}`;
  frames.appendChild(frame);
  const t = { id, pinned, title, sub, tile, profileKey, production, status: 'loading', attention: false, frame };
  const pc = pinnedCount();
  const at = pinned ? Math.min(index, pc) : Math.max(Math.min(index, tabs.length), pc);
  tabs.splice(at, 0, t);
  if (activate) select(id);
  else render();
  save();
  return t;
}

function select(id) {
  const t = byId(id);
  if (!t) return;
  activeId = id;
  t.attention = false;
  render();
  save();
  // Focus moves into the page, so typing and shortcuts go to it straight away.
  requestAnimationFrame(() => {
    try {
      t.frame.contentWindow?.focus();
    } catch { /* not loaded yet */ }
  });
}

async function close(id) {
  const t = byId(id);
  if (!t) return;
  let busy = false;
  try {
    busy = Boolean(t.frame.contentWindow?.__sdcBusy?.());
  } catch { /* ignore */ }
  if (busy) {
    select(id);
    const ok = await confirmDialog({
      tone: 'warn',
      icon: 'x',
      title: `Close “${t.title}”?`,
      message: 'Uploads are still running or a file has unsaved changes in this tab. Closing it stops them.',
      confirmLabel: 'Close tab',
    });
    if (!ok) return;
  }
  const i = tabs.indexOf(t);
  closed.push({ id: t.id, index: i, pinned: t.pinned, title: t.title, sub: t.sub, tile: t.tile, profileKey: t.profileKey });
  while (closed.length > MAX_CLOSED) forget(closed.shift().id);
  tabs.splice(i, 1);
  t.frame.remove();
  badges.delete(id);
  updateBadge();
  if (!tabs.length) {
    // Like Chrome: closing the last tab closes the window (in a browser, a fresh tab opens instead).
    save();
    if (desktop) return window.close();
    createTab();
    return;
  }
  if (activeId === id) select(tabs[Math.min(i, tabs.length - 1)].id);
  else {
    render();
    save();
  }
}

function reopen() {
  const c = closed.pop();
  if (!c) return;
  createTab({ ...c, activate: true });
}

function duplicate(t = active()) {
  if (!t) return;
  createTab({ index: tabs.indexOf(t) + 1, profile: t.profileKey, title: t.title, tile: t.tile });
}

function togglePin(t) {
  t.pinned = !t.pinned;
  tabs.splice(tabs.indexOf(t), 1);
  // Pinning puts it at the end of the pinned tabs; unpinning, first among the others.
  tabs.splice(pinnedCount(), 0, t);
  render();
  save();
}

function move(t, dir) {
  const i = tabs.indexOf(t);
  const j = i + dir;
  if (j < 0 || j >= tabs.length || tabs[j].pinned !== t.pinned) return;
  [tabs[i], tabs[j]] = [tabs[j], tabs[i]];
  render();
  save();
}

function closeOthers(t) {
  for (const x of [...tabs]) if (x !== t && !x.pinned) close(x.id);
}

function closeRight(t) {
  for (const x of tabs.slice(tabs.indexOf(t) + 1)) close(x.id);
}

/** Run a tab command (from a shortcut, the menu, a page or the tab bar). */
function run(cmd, from) {
  const t = active();
  const i = tabs.indexOf(t);
  const n = tabs.length;
  if (cmd === 'new') createTab({ index: n });
  else if (cmd === 'close') close((from || t)?.id);
  else if (cmd === 'reopen') reopen();
  else if (cmd === 'next') n > 1 && select(tabs[(i + 1) % n].id);
  else if (cmd === 'prev') n > 1 && select(tabs[(i - 1 + n) % n].id);
  else if (cmd === 'last') select(tabs[n - 1].id);
  else if (cmd.startsWith('select:')) {
    const x = tabs[Number(cmd.slice(7)) - 1];
    if (x) select(x.id);
  } else if (cmd === 'moveLeft') t && move(t, -1);
  else if (cmd === 'moveRight') t && move(t, 1);
  else if (cmd === 'duplicate') duplicate(from || t);
  else if (cmd === 'pin') t && togglePin(from || t);
  else if (cmd === 'search') openSearch();
  else if (cmd === 'newWindow') desktop?.newWindow();
}

// ------------------------------------------------------------------ rendering

function favicon(t) {
  if (t.status === 'loading' || t.status === 'connecting') return '<span class="tab-spin"></span>';
  if (t.status === 'lost') return `<span class="tab-lost">${icon('error')}</span>`;
  if (t.status === 'connected') return `<span class="tab-tile" style="${esc(t.tile)}">${icon('server')}</span>`;
  return '<img class="tab-logo" src="/icon.svg" alt="" />';
}

function render() {
  for (const [id, el] of els) {
    if (!byId(id)) {
      el.remove();
      els.delete(id);
    }
  }
  tabs.forEach((t, i) => {
    let el = els.get(t.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tab opening';
      el.dataset.id = t.id;
      el.setAttribute('role', 'tab');
      el.innerHTML = `<i class="ear l"></i><span class="tab-fav"></span><span class="tab-title"></span><button class="tab-x" type="button" tabindex="-1" aria-label="Close tab">${icon('x')}</button><i class="ear r"></i>`;
      el.addEventListener('animationend', () => el.classList.remove('opening'), { once: true });
      els.set(t.id, el);
    }
    const fav = favicon(t);
    if (el._fav !== fav) {
      $('.tab-fav', el).innerHTML = fav;
      el._fav = fav;
    }
    $('.tab-title', el).textContent = t.title;
    el.title = [t.title, t.sub].filter(Boolean).join('\n');
    el.classList.toggle('active', t.id === activeId);
    el.classList.toggle('pinned', t.pinned);
    el.classList.toggle('attention', t.attention);
    el.classList.toggle('production', Boolean(t.production));
    el.setAttribute('aria-selected', String(t.id === activeId));
    $('.tab-x', el).title = `Close tab (${KEYS.close})`;
    if (strip.children[i] !== el) strip.insertBefore(el, strip.children[i] || null);
    t.frame.classList.toggle('active', t.id === activeId);
    t.frame.title = t.title;
  });
  const a = active();
  document.title = a && a.title !== 'New tab' ? `${a.title} · ssh-console` : 'ssh-console';
  strip.classList.toggle('crowded', tabs.length > 8);
}

function updateBadge() {
  let sum = 0;
  for (const n of badges.values()) sum += n;
  desktop?.setBadge?.(sum);
}

// ------------------------------------------------------------------ messages from the tabs' pages

addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
  const t = tabs.find((x) => x.frame.contentWindow === e.source);
  if (!t) return;
  const d = e.data;
  if (d.type === 'sdc-tab-info') {
    const wasLost = t.status === 'lost';
    for (const k of ['title', 'sub', 'status', 'tile', 'profileKey']) if (typeof d[k] === 'string') t[k] = d[k].slice(0, 200);
    if (typeof d.production === 'boolean') t.production = d.production;
    // A background tab that lost its connection asks for attention, like Chrome's tab alerts.
    if (t.status === 'lost' && !wasLost && t.id !== activeId) t.attention = true;
    render();
    save();
  } else if (d.type === 'sdc-tab-cmd' && typeof d.cmd === 'string') {
    run(d.cmd, d.cmd === 'close' || d.cmd === 'duplicate' ? t : undefined);
  } else if (d.type === 'sdc-badge') {
    badges.set(t.id, Number(d.count) || 0);
    updateBadge();
  }
});

// Mac app events: download progress goes to every tab (each keeps the downloads it started), ⌘R
// refreshes only the visible tab, and the menu and shortcuts run tab commands.
desktop?.onDownloadProgress?.((payload) => {
  for (const t of tabs) t.frame.contentWindow?.postMessage({ type: 'sdc-download-progress', payload }, location.origin);
});
desktop?.onSoftRefresh?.(() => active()?.frame.contentWindow?.postMessage({ type: 'sdc-soft-refresh' }, location.origin));
desktop?.onTabCommand?.((cmd) => run(String(cmd)));

// ------------------------------------------------------------------ mouse: click, drag, middle-click, menu

strip.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.tab');
  if (!el || e.button !== 0 || e.target.closest('.tab-x')) return;
  const t = byId(el.dataset.id);
  select(t.id);
  let startX = e.clientX;
  let dragging = false;
  // Listen on the window: reordering moves tab elements, which would drop pointer capture.
  const moveTo = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    let dx = ev.clientX - startX;
    if (!dragging && Math.abs(dx) < 5) return;
    if (!dragging) {
      dragging = true;
      el.classList.add('dragging');
      strip.classList.add('dragging');
    }
    // Swap with a neighbour (in the same pinned / unpinned group) once past half of it.
    const next = el.nextElementSibling;
    const prev = el.previousElementSibling;
    if (dx > 0 && next && byId(next.dataset.id).pinned === t.pinned && dx > next.offsetWidth / 2) {
      move(t, 1);
      startX += next.offsetWidth;
      dx = ev.clientX - startX;
    } else if (dx < 0 && prev && byId(prev.dataset.id).pinned === t.pinned && -dx > prev.offsetWidth / 2) {
      move(t, -1);
      startX -= prev.offsetWidth;
      dx = ev.clientX - startX;
    }
    el.style.transform = `translateX(${dx}px)`;
  };
  const up = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    removeEventListener('pointermove', moveTo);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    el.style.transform = '';
    el.classList.remove('dragging');
    strip.classList.remove('dragging');
    save();
  };
  addEventListener('pointermove', moveTo);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
});
strip.addEventListener('click', (e) => {
  const x = e.target.closest('.tab-x');
  if (x) close(x.closest('.tab').dataset.id);
});
// Middle-click closes, as in every browser.
strip.addEventListener('auxclick', (e) => {
  const el = e.target.closest('.tab');
  if (el && e.button === 1) {
    e.preventDefault();
    close(el.dataset.id);
  }
});
strip.addEventListener('mousedown', (e) => e.button === 1 && e.preventDefault());
// Double-click the empty part of the bar: new tab.
$('#tabbar').addEventListener('dblclick', (e) => {
  if (!e.target.closest('.tab, button')) run('new');
});
$('#tab-new').addEventListener('click', () => run('new'));
$('#tab-search').addEventListener('click', () => openSearch());

let menu = null;
function closeMenu() {
  menu?.remove();
  menu = null;
}
addEventListener('pointerdown', (e) => menu && !menu.contains(e.target) && closeMenu(), true);
addEventListener('blur', closeMenu);
strip.addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.tab');
  if (!el) return;
  e.preventDefault();
  const t = byId(el.dataset.id);
  const i = tabs.indexOf(t);
  const items = [
    { label: 'New tab to the right', icon: 'plus', run: () => createTab({ index: i + 1 }) },
    '-',
    { label: 'Reload', icon: 'refresh', run: () => t.frame.contentWindow?.location.reload() },
    { label: 'Duplicate', icon: 'copy', run: () => duplicate(t), disabled: !t.profileKey },
    { label: t.pinned ? 'Unpin' : 'Pin', icon: 'pin', run: () => togglePin(t) },
    '-',
    { label: 'Close', icon: 'x', kbd: KEYS.close, run: () => close(t.id) },
    { label: 'Close other tabs', icon: 'x', run: () => closeOthers(t), disabled: tabs.length < 2 },
    { label: 'Close tabs to the right', icon: 'x', run: () => closeRight(t), disabled: i === tabs.length - 1 },
    '-',
    { label: 'Reopen closed tab', icon: 'restart', kbd: KEYS.reopen, run: reopen, disabled: !closed.length },
  ];
  closeMenu();
  menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items
    .map((it, k) =>
      it === '-'
        ? '<div class="ctx-sep"></div>'
        : `<button class="ctx-item" data-k="${k}" role="menuitem"${it.disabled ? ' disabled' : ''}>${icon(it.icon)}<span>${esc(it.label)}</span>${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}</button>`,
    )
    .join('');
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(e.clientX, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(e.clientY, innerHeight - r.height - 8))}px`;
  menu.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-k]');
    if (!b || b.disabled) return;
    const it = items[Number(b.dataset.k)];
    closeMenu();
    it.run();
  });
  menu.querySelector('.ctx-item:not([disabled])')?.focus({ preventScroll: true });
});

// ------------------------------------------------------------------ tab search (⇧⌘A)

let search = null;
function openSearch() {
  if (search) return search.close();
  const pop = document.createElement('div');
  pop.className = 'tab-search-pop';
  pop.innerHTML = `<div class="ss-search">${icon('search')}<input type="text" placeholder="Search tabs" spellcheck="false" autocomplete="off" /></div><div class="tsp-list"></div>`;
  document.body.appendChild(pop);
  const input = $('input', pop);
  const list = $('.tsp-list', pop);
  let rows = [];
  let at = 0;
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const match = (x) => !q || `${x.title} ${x.sub}`.toLowerCase().includes(q);
    const open = tabs.filter(match).map((t) => ({ kind: 'open', t }));
    const recent = [...closed].reverse().filter(match).slice(0, 8).map((c) => ({ kind: 'closed', c }));
    rows = [...open, ...recent];
    at = Math.min(at, Math.max(0, rows.length - 1));
    list.innerHTML =
      (open.length ? '<div class="ss-group">Open tabs</div>' : '') +
      rows
        .map((r, k) => {
          const x = r.t || r.c;
          const head = r.kind === 'closed' && (k === 0 || rows[k - 1].kind === 'open') ? '<div class="ss-group">Recently closed</div>' : '';
          return `${head}<div class="tsp-row${k === at ? ' active' : ''}${r.t?.id === activeId ? ' current' : ''}" data-k="${k}">
            <span class="tab-fav">${r.t ? favicon(r.t) : icon('restart')}</span>
            <span class="tsp-text"><span>${esc(x.title)}</span>${x.sub ? `<small>${esc(x.sub)}</small>` : ''}</span>
            ${r.t ? `<button class="icon-btn" data-close="${esc(r.t.id)}" title="Close tab">${icon('x')}</button>` : ''}
          </div>`;
        })
        .join('') || '<div class="ss-empty">No tabs match</div>';
  };
  const pick = (k) => {
    const r = rows[k];
    if (!r) return;
    done();
    if (r.t) select(r.t.id);
    else {
      closed = closed.filter((c) => c !== r.c);
      createTab({ ...r.c, activate: true });
    }
  };
  const done = () => {
    pop.remove();
    removeEventListener('pointerdown', outside, true);
    search = null;
  };
  const outside = (e) => !pop.contains(e.target) && !e.target.closest('#tab-search') && done();
  addEventListener('pointerdown', outside, true);
  input.addEventListener('input', () => {
    at = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      at = (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % Math.max(1, rows.length);
      draw();
    } else if (e.key === 'Enter') pick(at);
    else if (e.key === 'Escape') done();
  });
  list.addEventListener('click', (e) => {
    const c = e.target.closest('[data-close]');
    if (c) {
      close(c.dataset.close);
      return setTimeout(draw, 0);
    }
    const r = e.target.closest('[data-k]');
    if (r) pick(Number(r.dataset.k));
  });
  search = { close: done };
  draw();
  input.focus();
}

// ------------------------------------------------------------------ keys, theme, start

installTabKeys(run, { fallbacks: !desktop, windows: !!desktop });
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menu) closeMenu();
});

// Follow the theme chosen in any tab.
const applyTheme = () => {
  try {
    const t = JSON.parse(localStorage.getItem('sdc.prefs') || '{}').theme || 'system';
    const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch { /* keep */ }
};
addEventListener('storage', (e) => e.key === 'sdc.prefs' && applyTheme());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// In a web browser, the browser itself owns ⌘W / Ctrl+W: ask before that closes every open server.
if (!desktop) {
  addEventListener('beforeunload', (e) => {
    if (tabs.filter((t) => t.status === 'connected').length > 1) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

const saved = restore();
closed = Array.isArray(saved?.closed) ? saved.closed.slice(-MAX_CLOSED) : [];
if (saved?.tabs?.length) {
  for (const t of saved.tabs) createTab({ ...t, activate: false });
  select(byId(saved.active) ? saved.active : tabs[0].id);
} else {
  createTab({ auto: autoFirst });
}
if (isMac) document.documentElement.classList.add('mac');

// ------------------------------------------------------------------ app updates (desktop only)

// The main process asks this before restarting for an update: an upload or an unsaved file in any tab holds it back.
window.__sdcShellBusy = () => tabs.some((t) => {
  try {
    return Boolean(t.frame.contentWindow?.__sdcBusy?.());
  } catch {
    return false;
  }
});

if (desktop?.update) {
  const U = desktop.update;
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.id = 'update-pill';
  pill.className = 'update-pill';
  pill.hidden = true;
  $('#tabbar').insertBefore(pill, $('#tab-search'));
  let pop = null;
  let st = { state: 'idle' };
  let lastState = 'idle';

  const mb = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`);
  const closePop = () => {
    pop?.remove();
    pop = null;
  };

  function pillHtml() {
    switch (st.state) {
      case 'available': return [`${icon('download')}<span>Update to ${esc(st.version)}</span>`, 'available'];
      case 'downloading': return [`${icon('download')}<span>Downloading ${st.percent ?? 0}%</span>`, 'busy'];
      case 'installing': return [`${icon('restart', 'spinning')}<span>Installing…</span>`, 'busy'];
      case 'ready':
        if (st.countdown) return [`${icon('restart')}<span>Restarting in ${st.countdown}…</span>`, 'ready'];
        return [`${icon('restart')}<span>Restart to update</span>`, 'ready'];
      case 'error': return [`${icon('alert')}<span>Update failed</span>`, 'error'];
      default: return null;
    }
  }

  function popHtml() {
    const head = (title, sub) => `<div class="up-head"><div class="up-icon">${icon('download')}</div><div><strong>${title}</strong><div class="up-sub">${sub}</div></div></div>`;
    const bar = (pct) => `<div class="up-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>`;
    const notes = st.notes ? `<div class="up-notes">${esc(st.notes)}</div>` : '';
    switch (st.state) {
      case 'available':
        return head(`ssh-console ${esc(st.version)} is available`, `You have ${esc(st.current)}${st.size ? ` · ${mb(st.size)} download` : ''}`) + notes +
          (st.canInstall
            ? `<p class="up-text">The update downloads in the background, then ssh-console restarts. Open SSH sessions and terminals are closed by the restart.</p>
               <div class="up-actions"><button class="btn small ghost" data-u="close">Later</button><button class="btn small primary" data-u="start">${icon('download')}Update</button></div>`
            : `<p class="up-text">${esc(st.why || '')}</p>
               <div class="up-actions"><button class="btn small ghost" data-u="close">Later</button><button class="btn small primary" data-u="release">${icon('external')}Download</button></div>`);
      case 'downloading': {
        const pct = st.percent ?? 0;
        return head(`Downloading ${esc(st.version)}…`, `${pct}%${st.total ? ` · ${mb(st.received || 0)} of ${mb(st.total)}` : ''}`) + bar(pct) +
          `<div class="up-actions"><button class="btn small ghost" data-u="cancel">Cancel</button></div>`;
      }
      case 'installing':
        return head(`Installing ${esc(st.version)}…`, 'Checking the download') + bar(100);
      case 'ready':
        if (st.countdown) {
          return head(`Restarting in ${st.countdown}…`, `ssh-console ${esc(st.version)} is ready`) +
            `<p class="up-text">Open SSH sessions and terminals will be closed.</p>
             <div class="up-actions"><button class="btn small ghost" data-u="later">Cancel</button><button class="btn small primary" data-u="restart">${icon('restart')}Restart now</button></div>`;
        }
        return head(`ssh-console ${esc(st.version)} is ready`, st.blocked ? 'Waiting: an upload is running or a file has unsaved changes' : 'Restart to finish updating') +
          `<p class="up-text">${st.blocked ? 'Finish the upload or save your files, then restart. ' : ''}If you don't restart now, the update is applied the next time ssh-console starts.</p>
           <div class="up-actions"><button class="btn small ghost" data-u="close">Later</button><button class="btn small primary" data-u="restart">${icon('restart')}Restart now</button></div>`;
      case 'error':
        return head("The update didn't finish", esc(st.version ? `ssh-console ${st.version}` : '')) +
          `<p class="up-text up-error">${esc(st.error || 'Unknown error')}</p>
           <div class="up-actions"><button class="btn small ghost" data-u="release">${icon('external')}Download manually</button><button class="btn small primary" data-u="retry">${icon('refresh')}Try again</button></div>`;
      default:
        return '';
    }
  }

  function openPop() {
    if (!pop) {
      pop = document.createElement('div');
      pop.className = 'update-pop';
      pop.setAttribute('role', 'dialog');
      pop.setAttribute('aria-label', 'App update');
      document.body.appendChild(pop);
    }
    pop.innerHTML = popHtml();
  }

  function render(next) {
    st = next || st;
    const p = pillHtml();
    pill.hidden = !p;
    if (p) {
      pill.innerHTML = p[0];
      pill.className = `update-pill ${p[1]}`;
      pill.style.setProperty('--p', `${st.state === 'downloading' ? st.percent || 0 : 0}%`);
      pill.title = st.state === 'available' ? `ssh-console ${st.version} is available (you have ${st.current})` : '';
    }
    // The countdown and a finished download show themselves; everything else waits for a click.
    const show = (st.state === 'ready' && st.state !== lastState) || (st.state === 'error' && lastState !== 'error');
    lastState = st.state;
    if (!p) closePop();
    else if (show) openPop();
    else if (pop) pop.innerHTML = popHtml();
  }

  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pop) closePop();
    else openPop();
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('.update-pop [data-u]');
    if (!b) {
      if (pop && !e.target.closest?.('.update-pop') && !(st.state === 'ready' && st.countdown)) closePop();
      return;
    }
    const a = b.dataset.u;
    if (a === 'start') U.start();
    else if (a === 'cancel') U.cancel();
    else if (a === 'retry') U.retry();
    else if (a === 'restart') U.restart();
    else if (a === 'release') U.openRelease();
    else if (a === 'later') U.later();
    if (a === 'close' || a === 'release') closePop();
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pop) closePop();
  });
  U.onStatus(render);
  U.status().then((s) => s && render(s)).catch(() => {});
}
