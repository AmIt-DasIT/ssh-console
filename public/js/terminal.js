// xterm.js wrappers: read-only viewers (logs) and interactive sessions (host / container / database).
import { send, onStream, uid, prefs, esc, toast } from './core.js';
import { icon } from './icons.js';
import { confirmDialog } from './ui.js';

/** Most interactive terminals one panel (the host, or one container) can have open at once. */
export const MAX_TERMS = 5;

// Search highlights (the search addon wants #RRGGBB colours).
const FIND_DECOR = {
  matchBackground: '#4d3c0b',
  matchBorder: '#8a6d1a',
  matchOverviewRuler: '#d29922',
  activeMatchBackground: '#b7791f',
  activeMatchBorder: '#fafafa',
  activeMatchColorOverviewRuler: '#fafafa',
};
const FIND_LIMIT = 2000;

const THEME = {
  background: '#09090b',
  foreground: '#e4e4e7',
  cursor: '#fafafa',
  cursorAccent: '#09090b',
  selectionBackground: '#3f3f46',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#ffffff',
};

/** opts.find: add a find bar, opened with Ctrl+F / ⌘F while the terminal has focus. */
export function makeXterm(mount, opts = {}) {
  const { find = false, ...xtermOpts } = opts;
  const el = document.createElement('div');
  el.className = 'term-host';
  mount.appendChild(el);
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: Number(prefs.get('fontSize')) || 13,
    scrollback: 20000,
    theme: THEME,
    allowProposedApi: true,
    ...xtermOpts,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  let search = null;
  if (window.SearchAddon) {
    search = new SearchAddon.SearchAddon({ highlightLimit: FIND_LIMIT });
    term.loadAddon(search);
  }
  if (window.WebLinksAddon) term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(el);
  const finder = find && search ? makeFinder(el, term, search) : null;
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // Ctrl/Cmd+C copies when text is selected instead of sending ^C.
    if ((e.ctrlKey || e.metaKey) && e.key === 'c' && term.hasSelection()) {
      navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
      return false;
    }
    // Ctrl+F / ⌘F opens the find bar instead of reaching the shell or the browser.
    if (finder && isFindKey(e)) {
      e.preventDefault();
      finder.open();
      return false;
    }
    return true;
  });
  const doFit = () => {
    if (!el.offsetParent || !el.clientWidth || !el.clientHeight) return;
    try {
      fit.fit();
    } catch { /* not visible yet */ }
  };
  const ro = new ResizeObserver(() => requestAnimationFrame(doFit));
  ro.observe(el);
  doFit();
  const view = {
    el,
    term,
    search,
    finder,
    doFit,
    dispose() {
      ro.disconnect();
      finder?.dispose();
      term.dispose();
      el.remove();
      views.delete(view);
    },
  };
  views.add(view);
  return view;
}

const views = new Set(); // every xterm instance (interactive and read-only)

const isFindKey = (e) => (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyF' || e.key.toLowerCase() === 'f');

/** The floating find bar of one terminal. */
function makeFinder(host, term, search) {
  const bar = document.createElement('div');
  bar.className = 'term-find';
  bar.hidden = true;
  bar.innerHTML = `${icon('search')}
    <input type="text" spellcheck="false" autocomplete="off" placeholder="Find in terminal" aria-label="Find in terminal" />
    <span class="tf-count" aria-live="polite"></span>
    <button type="button" class="tf-btn tf-case" title="Match case" aria-pressed="false">Aa</button>
    <button type="button" class="tf-btn" data-dir="prev" title="Previous match (Shift+Enter)" aria-label="Previous match">${icon('chevron-up')}</button>
    <button type="button" class="tf-btn" data-dir="next" title="Next match (Enter)" aria-label="Next match">${icon('chevron-up', 'flip')}</button>
    <button type="button" class="tf-btn" data-close title="Close (Esc)" aria-label="Close find">${icon('x')}</button>`;
  host.appendChild(bar);
  const input = bar.querySelector('input');
  const count = bar.querySelector('.tf-count');
  const caseBtn = bar.querySelector('.tf-case');
  let caseSensitive = false;

  const setCount = (text, none = false) => {
    count.textContent = text;
    bar.classList.toggle('none', none);
  };
  const run = (dir = 'next', incremental = false) => {
    const q = input.value;
    if (!q) {
      search.clearDecorations();
      term.clearSelection();
      return setCount('');
    }
    const o = { caseSensitive, incremental, decorations: FIND_DECOR };
    const found = dir === 'prev' ? search.findPrevious(q, o) : search.findNext(q, o);
    if (!found) setCount('No results', true);
  };
  const sub = search.onDidChangeResults(({ resultIndex, resultCount }) => {
    if (!input.value) return setCount('');
    if (!resultCount) return setCount('No results', true);
    setCount(resultIndex < 0 ? `${FIND_LIMIT}+ matches` : `${resultIndex + 1} of ${resultCount}`);
  });

  input.addEventListener('input', () => run('next', true));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      run(e.shiftKey ? 'prev' : 'next');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (isFindKey(e)) {
      e.preventDefault();
      input.select();
    }
  });
  // Buttons keep the focus in the input, so Enter keeps working after a click.
  bar.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) e.preventDefault();
  });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b === caseBtn) {
      caseSensitive = !caseSensitive;
      caseBtn.classList.toggle('on', caseSensitive);
      caseBtn.setAttribute('aria-pressed', String(caseSensitive));
      search.clearDecorations();
      run('next', true);
    } else if (b.dataset.dir) run(b.dataset.dir);
    else if ('close' in b.dataset) close();
  });

  function open() {
    const sel = term.hasSelection() ? term.getSelection() : '';
    if (sel && !sel.includes('\n') && sel.length < 200) input.value = sel;
    bar.hidden = false;
    input.focus();
    input.select();
    if (input.value) run('next', true);
  }
  function close() {
    bar.hidden = true;
    search.clearDecorations();
    setCount('');
    term.focus();
  }
  return { open, close, get isOpen() { return !bar.hidden; }, dispose: () => sub.dispose() };
}

export function setTerminalFontSize(size) {
  for (const v of views) {
    v.term.options.fontSize = size;
    v.doFit();
  }
}

const registry = new Map(); // termId -> TermSession
onStream('term:data', (m) => registry.get(m.termId)?.onData(m.data));
onStream('term:exit', (m) => registry.get(m.termId)?.onExit(m));

/**
 * An interactive terminal backed by an SSH channel.
 * spec: { kind: 'host' } | { kind: 'container', id, shell } | { kind: 'db', db: {...connection params} }
 */
export class TermSession {
  /**
   * adopt: { termId, buffer } re-attaches to a shell that is still running on the server
   * (after a page reload) and replays its scrollback, instead of opening a new one.
   */
  constructor(mount, spec, label = 'shell', adopt = null) {
    this.termId = adopt ? adopt.termId : uid('t');
    this.alive = true;
    this.ready = !!adopt; // the remote shell has produced output (so it is accepting input)
    this.queue = [];
    this.exitHint = 'Use "New session" to reconnect.';
    this.onRestart = null; // set by TermTabs: Enter after the shell ended starts a new one
    this.onExitHook = null;
    Object.assign(this, makeXterm(mount, { find: true }));
    registry.set(this.termId, this);
    this.term.onData((data) => {
      if (this.alive) send({ type: 'term:input', termId: this.termId, data });
      else if (data === '\r' && this.onRestart) this.onRestart();
    });
    this.term.onResize(({ cols, rows }) => send({ type: 'term:resize', termId: this.termId, cols, rows }));
    if (adopt) {
      if (adopt.buffer) this.term.write(adopt.buffer);
      this.needsResize = true; // tell the server our size once we're visible
    } else {
      this.term.write(`\x1b[90mOpening ${label}…\x1b[0m\r\n`);
      send({ type: 'term:open', termId: this.termId, ...spec, cols: this.term.cols, rows: this.term.rows });
    }
  }
  onData(data) {
    this.term.write(data);
    if (!this.ready) {
      this.ready = true;
      // Give the shell a moment to print its prompt before queued input arrives.
      setTimeout(() => {
        for (const q of this.queue.splice(0)) send({ type: 'term:input', termId: this.termId, data: q });
      }, 150);
    }
  }
  /** Type text into the shell (queued until the shell has started). */
  type(text) {
    if (!this.alive) return false;
    if (this.ready) send({ type: 'term:input', termId: this.termId, data: text });
    else this.queue.push(text);
    return true;
  }
  show(v) {
    this.el.hidden = !v;
    if (v) requestAnimationFrame(() => {
      this.doFit();
      if (this.needsResize && this.el.offsetParent) {
        this.needsResize = false;
        send({ type: 'term:resize', termId: this.termId, cols: this.term.cols, rows: this.term.rows });
      }
      this.term.focus();
    });
  }
  onExit(m) {
    this.alive = false;
    const why = m.error ? `: ${m.error}` : m.code != null ? ` (exit code ${m.code})` : '';
    this.term.write(`\r\n\x1b[90m[session closed${why}. ${this.exitHint}]\x1b[0m\r\n`);
    this.onExitHook?.();
  }
  close() {
    send({ type: 'term:close', termId: this.termId });
    registry.delete(this.termId);
    this.dispose();
  }
}

export function closeAllTerminals() {
  for (const t of [...registry.values()]) t.close();
}

/**
 * Up to MAX_TERMS interactive terminals as tabs, sharing one mount.
 * opts: { spec: () => term:open spec for a new tab, label: 'host shell', describe?: (spec) => tooltip,
 *         canAdd?: () => '' or the reason a new shell can't open now, onChange?: (tabs) => void }
 */
export class TermTabs {
  constructor(mount, opts) {
    this.opts = opts;
    this.tabs = []; // { n, s: TermSession, spec, title }
    this.active = null;
    this.visible = false;
    this.root = document.createElement('div');
    this.root.className = 'tt';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="tt-bar" role="tablist" aria-label="Terminals"></div>
      <div class="tt-stack"></div>
      <div class="tt-empty" hidden>
        <p>No terminal open.</p>
        <button type="button" class="btn small" data-tt-new>${icon('plus')}New terminal</button>
      </div>`;
    mount.appendChild(this.root);
    this.bar = this.root.querySelector('.tt-bar');
    this.stack = this.root.querySelector('.tt-stack');
    this.root.addEventListener('click', (e) => {
      if (e.target.closest('[data-tt-new]')) return void this.add();
      const x = e.target.closest('[data-tt-close]');
      if (x) return void this.close(this.byN(Number(x.dataset.ttClose)));
      const t = e.target.closest('[data-tt]');
      if (t) this.select(this.byN(Number(t.dataset.tt)));
    });
    // Middle-click closes a tab, as in a browser.
    this.bar.addEventListener('mousedown', (e) => {
      if (e.button === 1 && e.target.closest('[data-tt]')) e.preventDefault();
    });
    this.bar.addEventListener('auxclick', (e) => {
      const t = e.button === 1 && e.target.closest('[data-tt]');
      if (t) {
        e.preventDefault();
        this.close(this.byN(Number(t.dataset.tt)));
      }
    });
    this.bar.addEventListener('keydown', (e) => {
      const t = e.target.closest('[data-tt]');
      if (!t) return;
      const i = this.tabs.indexOf(this.byN(Number(t.dataset.tt)));
      let next = null;
      if (e.key === 'ArrowRight') next = this.tabs[(i + 1) % this.tabs.length];
      else if (e.key === 'ArrowLeft') next = this.tabs[(i - 1 + this.tabs.length) % this.tabs.length];
      else if (e.key === 'Enter' || e.key === ' ') next = this.tabs[i];
      else if (e.key === 'Delete') return void this.close(this.tabs[i]);
      if (!next) return;
      e.preventDefault();
      this.select(next, false);
      this.bar.querySelector(`[data-tt="${next.n}"]`)?.focus();
    });
  }

  get size() { return this.tabs.length; }
  get full() { return this.tabs.length >= MAX_TERMS; }
  byN(n) { return this.tabs.find((t) => t.n === n); }

  /** Open a new terminal tab, or (adopt = { termId, buffer }) take over one still running on the server. */
  add({ spec, adopt = null } = {}) {
    if (adopt) {
      const same = this.tabs.find((t) => t.s.termId === adopt.termId);
      if (same) return same;
    }
    if (!adopt && this.blocked()) return null;
    if (this.full) {
      toast(`At most ${MAX_TERMS} terminals can be open here. Close one to open another.`, 'warn');
      return null;
    }
    let n = 1;
    while (this.byN(n)) n++;
    const tab = { n, spec: spec || this.opts.spec(), title: '', s: null };
    tab.s = new TermSession(this.stack, tab.spec, this.opts.label, adopt);
    this.wire(tab);
    const at = this.tabs.findIndex((t) => t.n > n);
    this.tabs.splice(at < 0 ? this.tabs.length : at, 0, tab);
    if (!adopt || !this.active) this.select(tab, !adopt);
    else {
      tab.s.show(false);
      this.render();
    }
    return tab;
  }

  wire(tab) {
    const s = tab.s;
    s.exitHint = 'Press Enter to start a new shell in this tab.';
    s.onRestart = () => this.restart(tab);
    s.onExitHook = () => this.render();
    s.term.onTitleChange((title) => {
      tab.title = title;
      this.render();
    });
  }

  /** Why a new shell can't be opened right now (shown as a toast), or false. */
  blocked() {
    const why = this.opts.canAdd?.();
    if (why) toast(why, 'warn');
    return !!why;
  }

  /** Replace a tab's ended shell with a fresh one, in the same place. */
  restart(tab) {
    if (this.blocked()) return null;
    tab.s.close();
    tab.s = new TermSession(this.stack, tab.spec, this.opts.label);
    tab.title = '';
    this.wire(tab);
    tab.s.show(this.visible && this.active === tab);
    this.render();
    return tab.s;
  }

  select(tab, focus = true) {
    if (!tab) return;
    this.active = tab;
    for (const t of this.tabs) if (t !== tab) t.s.show(false);
    if (this.visible) {
      tab.s.show(true);
      if (!focus) requestAnimationFrame(() => this.bar.querySelector(`[data-tt="${tab.n}"]`)?.focus());
    } else tab.s.show(false);
    this.render();
  }

  async close(tab, ask = true) {
    if (!tab || !this.tabs.includes(tab)) return;
    if (ask && tab.s.alive && !(await confirmDialog({
      icon: 'terminal',
      title: `Close Terminal ${tab.n}?`,
      message: 'Its shell is ended: anything still running in it is stopped and its scrollback is lost.',
      confirmLabel: 'Close terminal',
    }))) return;
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    tab.s.close();
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[i] || this.tabs[i - 1];
      if (next) return this.select(next);
    }
    this.render();
  }

  /** A shell that accepts input: the active tab's (restarted if it ended), or a new tab. */
  live() {
    if (this.active?.s.alive) return this.active.s;
    if (this.active) return this.restart(this.active);
    return this.add()?.s || null;
  }

  show(v) {
    this.visible = v;
    this.root.hidden = !v;
    if (v && !this.active && this.tabs.length) return this.select(this.tabs[0]);
    this.active?.s.show(v);
    this.render();
  }

  destroy() {
    for (const t of this.tabs) t.s.close();
    this.tabs = [];
    this.active = null;
    this.root.remove();
  }

  render() {
    const describe = this.opts.describe || (() => '');
    this.bar.innerHTML = this.tabs.map((t) => {
      const on = t === this.active;
      const tip = [`Terminal ${t.n}`, describe(t.spec), t.title, t.s.alive ? '' : 'ended: press Enter in it to restart'].filter(Boolean).join(' · ');
      return `<div class="tt-tab${on ? ' active' : ''}${t.s.alive ? '' : ' ended'}" role="tab" aria-selected="${on}" tabindex="${on ? 0 : -1}" data-tt="${t.n}" title="${esc(tip)}">
        ${icon('terminal')}<span class="tt-name">Terminal ${t.n}</span>
        <button type="button" class="tt-x" data-tt-close="${t.n}" tabindex="-1" title="Close terminal" aria-label="Close Terminal ${t.n}">${icon('x')}</button>
      </div>`;
    }).join('') + `
      <button type="button" class="tt-add${this.full ? ' full' : ''}" data-tt-new title="${this.full ? `At most ${MAX_TERMS} terminals` : 'New terminal'}" aria-label="New terminal">${icon('plus')}</button>
      <span class="tt-count" title="Open terminals">${this.tabs.length}/${MAX_TERMS}</span>`;
    this.root.querySelector('.tt-empty').hidden = this.tabs.length > 0;
    this.opts.onChange?.(this);
  }
}
