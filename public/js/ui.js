// Modal dialogs (confirm / prompt / generic) and the ⌘K command palette.
import { esc } from './core.js';
import { icon } from './icons.js';

let openCount = 0;
const stack = []; // open modals, topmost last: Escape only closes the top one

function mountModal(inner, { className = '', onClose } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal ${className}" role="dialog" aria-modal="true">${inner}</div>`;
  document.body.appendChild(backdrop);
  openCount++;
  stack.push(backdrop);
  void backdrop.offsetWidth; // flush styles so the entrance always animates
  backdrop.classList.add('open');
  const prevFocus = document.activeElement;
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    openCount--;
    stack.splice(stack.indexOf(backdrop), 1);
    backdrop.classList.remove('open');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => backdrop.remove(), 150);
    prevFocus?.focus?.();
    onClose?.(result);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && stack[stack.length - 1] === backdrop) {
      e.preventDefault();
      e.stopImmediatePropagation();
      close(undefined);
    }
  };
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close(undefined);
  });
  return { el: backdrop.firstElementChild, close };
}

export const isModalOpen = () => openCount > 0;

// Production servers: every risky confirmation also asks for the server's name to be typed.
let protectedName = () => null;
/** fn() → the current server's name when it is marked as production, else null. */
export function setProductionCheck(fn) {
  protectedName = fn;
}

const factsHtml = (facts) =>
  facts?.length
    ? `<dl class="modal-facts">${facts
        .filter(Boolean)
        .map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd class="${esc(cls || '')}">${esc(v)}</dd>`)
        .join('')}</dl>`
    : '';
const warningsHtml = (list) => (list?.length ? list.filter(Boolean).map((w) => `<div class="modal-warn">${icon('alert')}<span>${esc(w)}</span></div>`).join('') : '');

/**
 * Ask before doing something. Resolves true only when the user explicitly confirms.
 * opts: {
 *   title, message, detail (pre-formatted text), confirmLabel, icon,
 *   tone: 'primary' (a click) | 'warn' | 'danger' (press and hold),
 *   facts: [[label, value, class?]]   a summary of exactly what will happen,
 *   warnings: [text]                   highlighted risks,
 *   pending: Promise<{ facts?, warnings? }>  more facts that arrive after the dialog opens
 *                                      (e.g. how many rows a query will change),
 *   typeToConfirm: text the user must type first (production servers set this automatically
 *                                      for warn / danger confirmations; pass production: false to opt out)
 * }
 */
export function confirmDialog(opts) {
  const tone = opts.tone || 'primary';
  // Risky actions (warn / danger) need a press-and-hold, so a stray click or Enter can't trigger them.
  const hold = tone !== 'primary' && opts.hold !== false;
  const label = opts.confirmLabel || 'Confirm';
  const prod = tone !== 'primary' && opts.production !== false ? protectedName() : null;
  const typeText = opts.typeToConfirm || prod || '';
  return new Promise((resolve) => {
    const { el, close } = mountModal(
      `<div class="modal-head">
         <div class="modal-icon ${tone}">${icon(opts.icon || (tone === 'primary' ? 'info' : 'alert'))}</div>
         <div class="modal-text">
           <h3>${esc(opts.title)}</h3>
           ${opts.message ? `<p>${esc(opts.message)}</p>` : ''}
           ${factsHtml(opts.facts)}
           <div class="modal-pending">${opts.pending ? `<div class="modal-loading"><span class="db-spin"></span>Checking…</div>` : ''}</div>
           ${warningsHtml(opts.warnings)}
           ${opts.detail ? `<div class="modal-detail">${esc(opts.detail)}</div>` : ''}
           ${
             typeText
               ? `<label class="modal-type">${prod ? `<span class="prod-badge">${icon('lock')}Production</span> ` : ''}Type <b>${esc(typeText)}</b> to confirm
                    <input type="text" autocomplete="off" spellcheck="false" data-type-confirm /></label>`
               : ''
           }
         </div>
       </div>
       <div class="modal-actions">
         ${hold ? '<span class="hold-hint">Press and hold to confirm</span>' : ''}
         <button class="btn ghost" data-r="0">Cancel</button>
         ${hold ? '' : `<button class="btn primary" data-r="1">${esc(label)}</button>`}
       </div>`,
      { className: 'confirm', onClose: (r) => resolve(r === true) },
    );
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (b && !b.disabled) close(b.dataset.r === '1');
    });
    let confirmBtn;
    if (hold) {
      confirmBtn = holdButton({ label: opts.holdLabel || `Hold to ${label.charAt(0).toLowerCase()}${label.slice(1)}`, tone, icon: opts.icon, onComplete: () => close(true) });
      el.querySelector('.modal-actions').appendChild(confirmBtn);
    } else {
      confirmBtn = el.querySelector('[data-r="1"]');
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.dataset.r !== '0' && !confirmBtn.disabled) {
          e.preventDefault();
          close(true);
        }
      });
    }
    const typeIn = el.querySelector('[data-type-confirm]');
    if (typeIn) {
      const sync = () => (confirmBtn.disabled = typeIn.value.trim() !== typeText);
      typeIn.addEventListener('input', sync);
      sync();
      typeIn.focus();
    } else confirmBtn.focus();
    opts.pending
      ?.then((more) => {
        const box = el.querySelector('.modal-pending');
        if (box) box.innerHTML = factsHtml(more?.facts) + warningsHtml(more?.warnings);
      })
      .catch(() => {
        const box = el.querySelector('.modal-pending');
        if (box) box.innerHTML = '';
      });
  });
}

/**
 * Hold-to-confirm button (port of Kokonut UI's Hold Button). The fill tracks the hold, drains
 * back at a steady speed when released early, and on completion turns solid with a check.
 * Works with pointer (mouse / touch) and keyboard (hold Space or Enter).
 */
export function holdButton({ label, tone = 'danger', icon: ic, duration = 1200, onComplete }) {
  const DRAIN_MS = 600; // time a full fill takes to drain
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `hold-btn ${tone}`;
  b.setAttribute('aria-label', `${label} (press and hold)`);
  b.innerHTML = `<span class="hold-fill"></span><span class="hold-label">${icon(ic || 'alert')}<span>${esc(label)}</span></span>`;
  let p = 0;
  let raf = 0;
  let holding = false;
  let done = false;
  let from = 0;
  let start = 0;
  const set = (v) => {
    p = v;
    b.style.setProperty('--p', v.toFixed(4));
  };
  const complete = () => {
    done = true;
    holding = false;
    set(1);
    b.dataset.complete = '';
    b.querySelector('.hold-label').innerHTML = `${icon('check')}<span>Confirmed</span>`;
    navigator.vibrate?.(12);
    setTimeout(() => onComplete?.(), 380);
  };
  const tick = (now) => {
    if (holding) {
      set(Math.min(1, from + (now - start) / duration));
      if (p >= 1) return complete();
    } else {
      set(Math.max(0, from - (now - start) / DRAIN_MS));
      if (p <= 0) {
        raf = 0;
        return;
      }
    }
    raf = requestAnimationFrame(tick);
  };
  const run = (h) => {
    if (done || holding === h) return;
    holding = h;
    from = p;
    start = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  };
  b.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    b.setPointerCapture?.(e.pointerId);
    run(true);
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) b.addEventListener(ev, () => run(false));
  b.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault();
      run(true);
    } else if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
  });
  b.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') run(false);
  });
  b.addEventListener('click', (e) => e.preventDefault());
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  return b;
}

/** Single text input. Resolves the string, or null when cancelled. */
export function promptDialog({ title, message = '', label = '', value = '', placeholder = '', confirmLabel = 'Save', type = 'text' }) {
  return new Promise((resolve) => {
    const { el, close } = mountModal(
      `<div class="modal-text"><h3>${esc(title)}</h3>${message ? `<p>${esc(message)}</p>` : ''}</div>
       <label class="modal-field">${esc(label)}<input type="${type === 'password' ? 'password' : 'text'}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" /></label>
       <div class="modal-actions">
         <button class="btn ghost" data-r="0">Cancel</button>
         <button class="btn primary" data-r="1">${esc(confirmLabel)}</button>
       </div>`,
      { onClose: (r) => resolve(typeof r === 'string' ? r : null) },
    );
    const input = el.querySelector('input');
    // Passwords are used exactly as typed; other answers are trimmed.
    const ok = () => close(type === 'password' ? input.value : input.value.trim());
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (b) (b.dataset.r === '1' ? ok() : close(undefined));
    });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && ok());
    input.focus();
    input.select();
  });
}

/**
 * Generic modal with a title and arbitrary HTML content. Returns { el, close }.
 * size: 'wide' (560px) or 'xl' (980px). onClose runs once, however the modal is closed.
 */
export function openModal({ title, content, wide = false, size, onClose }) {
  const m = mountModal(
    `<div class="modal-title"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
     <div class="modal-content">${content}</div>`,
    { className: size || (wide ? 'wide' : ''), onClose },
  );
  m.el.querySelector('[data-close]').addEventListener('click', () => m.close());
  return m;
}

// ------------------------------------------------------------------ command palette

/**
 * getItems() → [{ group, label, hint, icon, keywords, run }]
 */
export function openPalette(getItems) {
  if (isModalOpen()) return;
  const items = getItems();
  const { el, close } = mountModal(
    `<div class="palette-input">${icon('search')}<input placeholder="Search containers, tabs and actions…" spellcheck="false" /><kbd>esc</kbd></div>
     <div class="palette-list" role="listbox"></div>
     <div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span></div>`,
    { className: 'palette' },
  );
  const input = el.querySelector('input');
  const list = el.querySelector('.palette-list');
  let shown = [];
  let active = 0;

  const score = (it, words) => {
    const hay = `${it.label} ${it.hint || ''} ${it.keywords || ''} ${it.group}`.toLowerCase();
    let s = 0;
    for (const w of words) {
      const i = hay.indexOf(w);
      if (i < 0) return -1;
      s += i === 0 ? 3 : hay[i - 1] === ' ' ? 2 : 1;
    }
    return s;
  };

  const render = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = (words.length
      ? items.map((it) => [it, score(it, words)]).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]).map(([it]) => it)
      : items
    ).slice(0, 60);
    active = Math.min(active, Math.max(shown.length - 1, 0));
    let lastGroup = null;
    list.innerHTML = shown.length
      ? shown
          .map((it, i) => {
            const head = it.group !== lastGroup ? `<div class="palette-group">${esc(it.group)}</div>` : '';
            lastGroup = it.group;
            return `${head}<div class="palette-item${i === active ? ' active' : ''}" data-i="${i}" role="option">
              ${icon(it.icon || 'chevronRight')}<span class="pl-label">${esc(it.label)}</span>${it.hint ? `<span class="pl-hint">${esc(it.hint)}</span>` : ''}</div>`;
          })
          .join('')
      : '<div class="palette-empty">No matches</div>';
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };

  const run = (i) => {
    const it = shown[i];
    if (!it) return;
    close();
    setTimeout(() => it.run(), 0);
  };

  input.addEventListener('input', () => {
    active = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(active + 1, shown.length - 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(active - 1, 0);
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(active);
    }
  });
  list.addEventListener('mousemove', (e) => {
    const it = e.target.closest('.palette-item');
    if (it && Number(it.dataset.i) !== active) {
      active = Number(it.dataset.i);
      list.querySelectorAll('.palette-item').forEach((x) => x.classList.toggle('active', Number(x.dataset.i) === active));
    }
  });
  list.addEventListener('click', (e) => {
    const it = e.target.closest('.palette-item');
    if (it) run(Number(it.dataset.i));
  });
  render();
  input.focus();
}
