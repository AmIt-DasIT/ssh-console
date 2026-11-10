// Chrome's tab shortcuts, shared by the tab bar and every tab's page. (The Mac app also matches
// these in desktop/main.js, before any page sees the key, so terminals and editors can't swallow
// them; keep the two lists in sync.)
//
//   New tab                ⌘T            Ctrl+T
//   Close tab              ⌘W            Ctrl+W, Ctrl+F4
//   Reopen closed tab      ⇧⌘T           Ctrl+Shift+T
//   Next tab               ⌃Tab, ⌥⌘→, ⇧⌘]   Ctrl+Tab, Ctrl+PageDown
//   Previous tab           ⌃⇧Tab, ⌥⌘←, ⇧⌘[  Ctrl+Shift+Tab, Ctrl+PageUp
//   Tab 1…8 / last tab     ⌘1…⌘8 / ⌘9    Ctrl+1…8 / Ctrl+9
//   Move tab left / right  ⌃⇧PageUp / ⌃⇧PageDown
//   Search tabs            ⇧⌘A           Ctrl+Shift+A
//   New window             ⌘N            Ctrl+N (Mac app)
//
// In a web browser, the browser keeps ⌘T, ⌘W, ⇧⌘T, ⌘N and Ctrl+Tab for its own tabs, so these work
// there as well: ⌥T new tab, ⌥W close tab, ⌥⇧T reopen, ⌥PageDown / ⌥PageUp next / previous.

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The tab command for a keydown, or null. fallbacks: also accept the ⌥ versions (web browsers). */
export function tabCommand(e, { fallbacks = false, windows = false } = {}) {
  if (e.isComposing) return null;
  const { code, key } = e;
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (mod && !e.altKey) {
    if (code === 'KeyT') return e.shiftKey ? 'reopen' : 'new';
    if (code === 'KeyW' && !e.shiftKey) return 'close';
    if (code === 'KeyA' && e.shiftKey) return 'search';
    if (code === 'KeyN' && !e.shiftKey && windows) return 'newWindow';
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(code);
    if (digit && !e.shiftKey) return digit[1] === '9' ? 'last' : `select:${digit[1]}`;
    if (isMac && e.shiftKey && (code === 'BracketRight' || code === 'BracketLeft')) return code === 'BracketRight' ? 'next' : 'prev';
  }
  if (isMac && e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey && (key === 'ArrowRight' || key === 'ArrowLeft')) return key === 'ArrowRight' ? 'next' : 'prev';
  if (e.ctrlKey && !e.metaKey && !e.altKey) {
    if (key === 'Tab') return e.shiftKey ? 'prev' : 'next';
    if (key === 'PageDown' || key === 'PageUp') {
      if (e.shiftKey) return key === 'PageDown' ? 'moveRight' : 'moveLeft';
      return key === 'PageDown' ? 'next' : 'prev';
    }
    if (key === 'F4' && !e.shiftKey && !isMac) return 'close';
  }
  if (fallbacks && e.altKey && !e.ctrlKey && !e.metaKey) {
    if (code === 'KeyT') return e.shiftKey ? 'reopen' : 'new';
    if (code === 'KeyW' && !e.shiftKey) return 'close';
    if (key === 'PageDown' || key === 'PageUp') return key === 'PageDown' ? 'next' : 'prev';
  }
  return null;
}

/** Run tab shortcuts before anything else on the page (terminals, the code editor) can take them. */
export function installTabKeys(run, opts) {
  addEventListener(
    'keydown',
    (e) => {
      const cmd = tabCommand(e, opts);
      if (!cmd) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      run(cmd);
    },
    true,
  );
}

/** Shortcut labels for menus and tooltips. */
export const KEYS = isMac
  ? { new: '⌘T', close: '⌘W', reopen: '⇧⌘T', next: '⌃⇥', prev: '⌃⇧⇥', search: '⇧⌘A', moveLeft: '⌃⇧⇞', moveRight: '⌃⇧⇟' }
  : { new: 'Ctrl+T', close: 'Ctrl+W', reopen: 'Ctrl+Shift+T', next: 'Ctrl+Tab', prev: 'Ctrl+Shift+Tab', search: 'Ctrl+Shift+A', moveLeft: 'Ctrl+Shift+PgUp', moveRight: 'Ctrl+Shift+PgDn' };
