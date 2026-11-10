// Searchable dropdowns, styled after Kokonut UI's Action Search Bar: a trigger button that opens a
// floating card with a search field, grouped items (icon, label, muted description, right-hand
// hint), a check on the current choice and a keyboard footer. Items fade and slide in.
//
// Every native <select> is enhanced in place, so code keeps using the select as before: reading and
// setting .value / .selectedIndex, replacing its options and listening for 'change' all work.
// Optional per-option attributes: data-desc (second line), data-hint (right side), data-icon,
// data-tone (a CSS colour for the icon).
// Opt out with <select data-native>.
import { icon } from './icons.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
const INDEX = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');

let current = null; // the open dropdown: { sel, btn, pop, cleanup }

function highlight(text, words) {
  if (!words.length) return esc(text);
  const lower = text.toLowerCase();
  const marks = new Array(text.length).fill(false);
  for (const w of words) {
    let i = lower.indexOf(w);
    while (i >= 0) {
      for (let k = i; k < i + w.length; k++) marks[k] = true;
      i = lower.indexOf(w, i + w.length);
    }
  }
  let out = '';
  let on = false;
  for (let i = 0; i < text.length; i++) {
    if (marks[i] !== on) {
      out += marks[i] ? '<mark>' : '</mark>';
      on = marks[i];
    }
    out += esc(text[i]);
  }
  return on ? `${out}</mark>` : out;
}

/** Turn one <select> into a searchable dropdown. Safe to call more than once. */
export function enhanceSelect(sel) {
  if (sel.dataset.ss || sel.multiple || sel.hasAttribute('data-native') || sel.closest('.monaco-editor')) return;
  sel.dataset.ss = '1';
  const wrap = document.createElement('span');
  wrap.className = 'ss';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ss-trigger';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  if (sel.title) btn.title = sel.title;
  const label = sel.getAttribute('aria-label');
  if (label) btn.setAttribute('aria-label', label);
  sel.before(wrap);
  // The button comes first so clicking a surrounding <label> opens the dropdown.
  wrap.append(btn, sel);
  sel.classList.add('ss-native');
  sel.tabIndex = -1;
  sel.setAttribute('aria-hidden', 'true');

  const refresh = () => {
    const o = sel.options[INDEX.get.call(sel)];
    const text = o ? o.label || o.text : sel.dataset.placeholder || 'Select…';
    const tone = o?.dataset.tone ? ` style="--tone:${esc(o.dataset.tone)}"` : '';
    btn.innerHTML = `${o?.dataset.icon ? icon(o.dataset.icon).replace('<svg ', `<svg${tone} `) : ''}<span class="ss-value${o && o.value !== '' ? '' : ' placeholder'}">${esc(text)}</span>${icon('chevronDown')}`;
    btn.disabled = sel.disabled;
    wrap.hidden = sel.hidden;
    if (current?.sel === sel) current.render?.();
  };
  sel._ssRefresh = refresh;
  Object.defineProperty(sel, 'value', {
    configurable: true,
    get() {
      return VALUE.get.call(this);
    },
    set(v) {
      VALUE.set.call(this, v);
      refresh();
    },
  });
  Object.defineProperty(sel, 'selectedIndex', {
    configurable: true,
    get() {
      return INDEX.get.call(this);
    },
    set(v) {
      INDEX.set.call(this, v);
      refresh();
    },
  });
  sel.addEventListener('change', refresh);
  new MutationObserver(refresh).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'selected', 'label'] });
  btn.addEventListener('click', () => (current?.sel === sel ? close() : open(sel, btn)));
  btn.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      open(sel, btn);
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      open(sel, btn, e.key);
    }
  });
  refresh();
}

function close(refocus = false) {
  if (!current) return;
  const { btn, pop, cleanup } = current;
  current = null;
  cleanup();
  btn.setAttribute('aria-expanded', 'false');
  btn.classList.remove('open');
  pop.classList.remove('in');
  setTimeout(() => pop.remove(), 140);
  if (refocus) btn.focus();
}

function open(sel, btn, initial = '') {
  close();
  const pop = document.createElement('div');
  pop.className = 'ss-pop';
  pop.setAttribute('role', 'dialog');
  pop.innerHTML = `
    <div class="ss-search">${icon('search')}<input type="text" spellcheck="false" autocomplete="off" placeholder="${esc(sel.dataset.search || 'Search…')}" aria-label="Search options" /></div>
    <div class="ss-list" role="listbox"></div>
    <div class="ss-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> select</span><span><kbd>esc</kbd> close</span></div>`;
  document.body.appendChild(pop);
  const input = pop.querySelector('input');
  const list = pop.querySelector('.ss-list');
  input.value = initial;
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('open');

  let shown = []; // option indexes currently listed
  let active = -1;
  let animate = true;

  const render = () => {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const opts = [...sel.options];
    const selIdx = INDEX.get.call(sel);
    shown = [];
    let html = '';
    let lastGroup = null;
    opts.forEach((o, i) => {
      if (o.hidden) return;
      const text = o.label || o.text;
      const hay = `${text} ${o.value} ${o.dataset.desc || ''} ${o.dataset.hint || ''} ${o.parentElement.label || ''}`.toLowerCase();
      if (words.length && !words.every((w) => hay.includes(w))) return;
      const group = o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : '';
      if (group !== lastGroup) {
        if (group) html += `<div class="ss-group">${esc(group)}</div>`;
        lastGroup = group;
      }
      const n = shown.length;
      shown.push(i);
      html += `<div class="ss-item${i === selIdx ? ' selected' : ''}${o.disabled ? ' disabled' : ''}" role="option" data-i="${i}" aria-selected="${i === selIdx}" style="--d:${Math.min(n, 12)}">
        ${o.dataset.icon ? `<span class="ss-icon"${o.dataset.tone ? ` style="--tone:${esc(o.dataset.tone)}"` : ''}>${icon(o.dataset.icon)}</span>` : ''}
        <span class="ss-text"><span class="ss-label">${highlight(text, words) || '&nbsp;'}</span>${o.dataset.desc ? `<span class="ss-desc">${highlight(o.dataset.desc, words)}</span>` : ''}</span>
        ${o.dataset.hint ? `<span class="ss-hint">${esc(o.dataset.hint)}</span>` : ''}
        <span class="ss-check">${i === selIdx ? icon('tick') : ''}</span>
      </div>`;
    });
    list.innerHTML = html || `<div class="ss-empty">No matches${input.value ? ` for “${esc(input.value)}”` : ''}</div>`;
    list.classList.toggle('anim', animate);
    animate = false;
    const keep = shown.indexOf(selIdx);
    setActive(words.length ? firstEnabled(0, 1) : keep >= 0 ? keep : firstEnabled(0, 1), true);
  };
  const firstEnabled = (from, dir) => {
    for (let k = from; k >= 0 && k < shown.length; k += dir) if (!sel.options[shown[k]].disabled) return k;
    return -1;
  };
  const setActive = (k, center = false) => {
    active = k;
    list.querySelectorAll('.ss-item.active').forEach((x) => x.classList.remove('active'));
    const el = k >= 0 ? list.querySelector(`.ss-item[data-i="${shown[k]}"]`) : null;
    if (el) {
      el.classList.add('active');
      el.scrollIntoView({ block: center ? 'center' : 'nearest' });
    }
  };
  const choose = (i) => {
    const o = sel.options[i];
    if (!o || o.disabled) return;
    const changed = INDEX.get.call(sel) !== i;
    INDEX.set.call(sel, i);
    sel._ssRefresh();
    close(true);
    if (changed) {
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  const place = () => {
    if (!btn.isConnected || !btn.offsetParent) return close();
    const r = btn.getBoundingClientRect();
    const vw = innerWidth;
    const vh = innerHeight;
    const width = Math.min(Math.max(r.width, 280), 460, vw - 16);
    const left = Math.min(Math.max(8, r.left), vw - width - 8);
    const below = vh - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 260 && above > below;
    const room = Math.max(160, Math.min(380, up ? above : below));
    pop.style.width = `${width}px`;
    pop.style.left = `${left}px`;
    pop.style.top = up ? '' : `${r.bottom + 6}px`;
    pop.style.bottom = up ? `${vh - r.top + 6}px` : '';
    pop.classList.toggle('up', up);
    list.style.maxHeight = `${room - 92}px`;
  };

  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      const next = firstEnabled(active + dir, dir);
      if (next >= 0) setActive(next);
    } else if (e.key === 'Home' || e.key === 'End') {
      if (input.value) return;
      e.preventDefault();
      setActive(e.key === 'Home' ? firstEnabled(0, 1) : firstEnabled(shown.length - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0) choose(shown[active]);
    } else if (e.key === 'Tab') {
      close();
    }
  });
  list.addEventListener('pointermove', (e) => {
    const it = e.target.closest('.ss-item:not(.disabled)');
    if (it) {
      const k = shown.indexOf(Number(it.dataset.i));
      if (k !== active) setActive(k);
    }
  });
  list.addEventListener('click', (e) => {
    const it = e.target.closest('.ss-item');
    if (it) choose(Number(it.dataset.i));
  });

  // Escape closes only the dropdown, not a dialog around it: listen on window, which runs before
  // the dialog's own document-level handler.
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close(true);
    }
  };
  const onDown = (e) => {
    if (!pop.contains(e.target) && !btn.contains(e.target)) close();
  };
  const onScroll = (e) => {
    if (!pop.contains(e.target)) place();
  };
  addEventListener('keydown', onKey, true);
  addEventListener('pointerdown', onDown, true);
  addEventListener('scroll', onScroll, true);
  addEventListener('resize', place);
  current = {
    sel,
    btn,
    pop,
    render,
    cleanup: () => {
      removeEventListener('keydown', onKey, true);
      removeEventListener('pointerdown', onDown, true);
      removeEventListener('scroll', onScroll, true);
      removeEventListener('resize', place);
    },
  };
  render();
  place();
  requestAnimationFrame(() => pop.classList.add('in'));
  input.focus();
  if (initial) input.setSelectionRange(initial.length, initial.length);
}

/** Enhance every select now and whenever new ones appear (panels, dialogs). */
export function enhanceSelectsEverywhere() {
  document.querySelectorAll('select').forEach(enhanceSelect);
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches('select')) enhanceSelect(n);
        else n.querySelectorAll?.('select').forEach(enhanceSelect);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}
