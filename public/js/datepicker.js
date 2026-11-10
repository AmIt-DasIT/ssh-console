// Date picker in the style of Kokonut UI's calendar (shadcn/ui-based): a trigger with a calendar
// icon opens a card with month navigation, a month/year view (click the title), weekday row, round
// day cells, today marker and range highlighting. Fully keyboard operable.
//
// Every <input type="date"> is enhanced in place: the input keeps its value (YYYY-MM-DD), so code
// keeps reading and setting .value and listening for 'input' / 'change'. Two inputs inside an
// element with [data-range-group], marked data-range="start" and data-range="end", act as one
// range: the days between them are highlighted, the end can't be before the start, and picking a
// start opens the end. Opt out with <input type="date" data-native>.
import { icon } from './icons.js';

const VALUE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d, n) => {
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  return new Date(t.getFullYear(), t.getMonth(), Math.min(d.getDate(), new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()));
};
const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const fmtLong = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTitle = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const fmtMonth = new Intl.DateTimeFormat(undefined, { month: 'short' });
const fmtAria = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

// First day of the week from the user's locale (Sunday when unknown).
const firstDow = (() => {
  try {
    const loc = new Intl.Locale(navigator.language);
    const info = loc.getWeekInfo?.() || loc.weekInfo;
    return (info?.firstDay ?? 7) % 7;
  } catch {
    return 0;
  }
})();
const WEEKDAYS = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2024, 0, 7 + ((firstDow + i) % 7))).slice(0, 2));

let current = null;

function partnerOf(input) {
  const role = input.dataset.range;
  if (!role) return null;
  const group = input.closest('[data-range-group]');
  return group?.querySelector(`input[data-range="${role === 'start' ? 'end' : 'start'}"]`) || null;
}

/** Turn one <input type="date"> into a calendar picker. Safe to call more than once. */
export function enhanceDate(input) {
  if (input.dataset.dp || input.type !== 'date' || input.hasAttribute('data-native')) return;
  input.dataset.dp = '1';
  const wrap = document.createElement('span');
  wrap.className = 'dp';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dp-trigger';
  btn.setAttribute('aria-haspopup', 'dialog');
  input.before(wrap);
  wrap.append(btn, input);
  input.classList.add('dp-native');
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');

  const refresh = () => {
    const d = parse(VALUE.get.call(input));
    btn.innerHTML = `${icon('calendar')}<span class="dp-value${d ? '' : ' placeholder'}">${esc(d ? fmtLong.format(d) : input.placeholder || 'Pick a date')}</span>`;
    btn.disabled = input.disabled;
    if (current?.input === input) current.render();
    // A range partner redraws too (its highlighted band changes).
    const p = partnerOf(input);
    if (p && current?.input === p) current.render();
  };
  input._dpRefresh = refresh;
  Object.defineProperty(input, 'value', {
    configurable: true,
    get() {
      return VALUE.get.call(this);
    },
    set(v) {
      VALUE.set.call(this, v);
      refresh();
    },
  });
  input.addEventListener('change', refresh);
  input.addEventListener('input', refresh);
  btn.addEventListener('click', () => (current?.input === input ? close() : open(input, btn)));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open(input, btn);
    }
  });
  refresh();
}

function close(refocus = false) {
  if (!current) return;
  const { btn, pop, cleanup } = current;
  current = null;
  cleanup();
  btn.classList.remove('open');
  pop.classList.remove('in');
  setTimeout(() => pop.remove(), 140);
  if (refocus) btn.focus();
}

function open(input, btn) {
  close();
  const pop = document.createElement('div');
  pop.className = 'dp-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Choose a date');
  document.body.appendChild(pop);
  btn.classList.add('open');

  const partner = partnerOf(input);
  const role = input.dataset.range || '';
  const today = new Date();
  const selected = () => parse(VALUE.get.call(input));
  const other = () => (partner ? parse(VALUE.get.call(partner)) : null);
  const bounds = () => {
    let min = parse(input.min);
    let max = parse(input.max);
    const o = other();
    if (o && role === 'end' && (!min || o > min)) min = o;
    if (o && role === 'start' && (!max || o < max)) max = o;
    return { min, max };
  };
  let focus = selected() || other() || today;
  let view = new Date(focus.getFullYear(), focus.getMonth(), 1);
  let mode = 'days'; // or 'months'
  let hover = null;
  let slide = '';

  const disabled = (d) => {
    const { min, max } = bounds();
    return (min && d < min) || (max && d > max);
  };

  const render = () => {
    const sel = selected();
    const o = other();
    if (mode === 'months') {
      const y = view.getFullYear();
      pop.innerHTML = `
        <div class="dp-head">
          <button type="button" class="dp-nav" data-nav="-12" aria-label="Previous year">${icon('chevronLeft')}</button>
          <button type="button" class="dp-title" data-mode>${y}</button>
          <button type="button" class="dp-nav" data-nav="12" aria-label="Next year">${icon('chevronRight')}</button>
        </div>
        <div class="dp-months">${Array.from({ length: 12 }, (_, m) => {
          const cur = sel && sel.getFullYear() === y && sel.getMonth() === m;
          const now = today.getFullYear() === y && today.getMonth() === m;
          return `<button type="button" class="dp-month${cur ? ' selected' : ''}${now ? ' today' : ''}" data-month="${m}">${esc(fmtMonth.format(new Date(y, m, 1)))}</button>`;
        }).join('')}</div>`;
      return;
    }
    // Range band: start..end, or start..hover while choosing the end (and the reverse).
    let a = null;
    let b = null;
    if (role === 'start') [a, b] = [hover || sel, o];
    else if (role === 'end') [a, b] = [o, hover || sel];
    const inRange = (d) => a && b && d > a && d < b;
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const lead = (first.getDay() - firstDow + 7) % 7;
    const start = addDays(first, -lead);
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const out = d.getMonth() !== view.getMonth();
      const cls = ['dp-day'];
      if (out) cls.push('outside');
      if (sameDay(d, today)) cls.push('today');
      if (sameDay(d, sel)) cls.push('selected');
      if (role && (sameDay(d, a) || sameDay(d, b)) && a && b) cls.push(sameDay(d, a) ? 'range-start' : 'range-end');
      if (role && !sameDay(d, sel) && sameDay(d, o)) cls.push('anchor');
      if (inRange(d)) cls.push('in-range');
      if (sameDay(d, hover) && !sameDay(d, sel)) cls.push('preview');
      const dis = disabled(d);
      if (dis) cls.push('disabled');
      const isFocus = sameDay(d, focus);
      cells.push(
        `<button type="button" class="${cls.join(' ')}" data-d="${iso(d)}" tabindex="${isFocus ? 0 : -1}" aria-label="${esc(fmtAria.format(d))}"${sameDay(d, sel) ? ' aria-selected="true"' : ''}${dis ? ' aria-disabled="true"' : ''}><span>${d.getDate()}</span></button>`,
      );
    }
    pop.innerHTML = `
      <div class="dp-head">
        <button type="button" class="dp-nav" data-nav="-1" aria-label="Previous month">${icon('chevronLeft')}</button>
        <button type="button" class="dp-title" data-mode aria-label="Choose month and year">${esc(fmtTitle.format(view))}${icon('chevronDown')}</button>
        <button type="button" class="dp-nav" data-nav="1" aria-label="Next month">${icon('chevronRight')}</button>
      </div>
      <div class="dp-week">${WEEKDAYS.map((w) => `<span>${esc(w)}</span>`).join('')}</div>
      <div class="dp-grid ${slide}" role="grid">${cells.join('')}</div>
      <div class="dp-foot">
        <button type="button" class="dp-link" data-today>Today</button>
        ${role && o ? `<span class="dp-hint">${role === 'start' ? 'Until' : 'From'} ${esc(fmtLong.format(o))}</span>` : '<span></span>'}
        <button type="button" class="dp-link" data-clear>Clear</button>
      </div>`;
    slide = '';
  };

  const focusDay = () => pop.querySelector('.dp-day[tabindex="0"]')?.focus();
  const moveTo = (d) => {
    const before = view;
    focus = d;
    if (d.getMonth() !== view.getMonth() || d.getFullYear() !== view.getFullYear()) {
      view = new Date(d.getFullYear(), d.getMonth(), 1);
      slide = view > before ? 'slide-l' : 'slide-r';
    }
    render();
    focusDay();
  };
  const choose = (s) => {
    const d = parse(s);
    if (!d || disabled(d)) return;
    VALUE.set.call(input, s);
    input._dpRefresh();
    partner?._dpRefresh?.();
    close(true);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // Picking a start: go straight on to the end if it's missing.
    if (role === 'start' && partner && !VALUE.get.call(partner)) setTimeout(() => partner.previousElementSibling?.click(), 160);
  };

  pop.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.d) return choose(t.dataset.d);
    if (t.dataset.nav) {
      const n = Number(t.dataset.nav);
      slide = n > 0 ? 'slide-l' : 'slide-r';
      view = addMonths(view, n);
      focus = new Date(view.getFullYear(), view.getMonth(), Math.min(focus.getDate(), 28));
      return render();
    }
    if (t.hasAttribute('data-mode')) {
      mode = mode === 'days' ? 'months' : 'days';
      return render();
    }
    if (t.dataset.month) {
      view = new Date(view.getFullYear(), Number(t.dataset.month), 1);
      focus = new Date(view.getFullYear(), view.getMonth(), Math.min(focus.getDate(), 28));
      mode = 'days';
      render();
      return focusDay();
    }
    if (t.hasAttribute('data-today')) {
      if (!disabled(today)) return choose(iso(today));
      return moveTo(today);
    }
    if (t.hasAttribute('data-clear')) {
      VALUE.set.call(input, '');
      input._dpRefresh();
      partner?._dpRefresh?.();
      close(true);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  pop.addEventListener('pointerover', (e) => {
    if (!role) return;
    const t = e.target.closest('.dp-day:not(.disabled)');
    const d = t ? parse(t.dataset.d) : null;
    if (!sameDay(d, hover)) {
      hover = d;
      // Only update classes (re-rendering would steal focus from the hovered button).
      const sel = selected();
      const o = other();
      const [a, b] = role === 'start' ? [hover || sel, o] : [o, hover || sel];
      for (const el of pop.querySelectorAll('.dp-day')) {
        const x = parse(el.dataset.d);
        el.classList.toggle('in-range', !!(a && b && x > a && x < b));
        el.classList.toggle('range-start', !!(a && b && sameDay(x, a)));
        el.classList.toggle('range-end', !!(a && b && sameDay(x, b)));
        el.classList.toggle('preview', sameDay(x, hover) && !sameDay(x, sel));
      }
    }
  });
  pop.addEventListener('keydown', (e) => {
    if (mode !== 'days' || !e.target.closest('.dp-day')) return;
    const k = e.key;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[k];
    if (step) {
      e.preventDefault();
      return moveTo(addDays(focus, step));
    }
    if (k === 'PageUp' || k === 'PageDown') {
      e.preventDefault();
      return moveTo(addMonths(focus, (k === 'PageUp' ? -1 : 1) * (e.shiftKey ? 12 : 1)));
    }
    if (k === 'Home' || k === 'End') {
      e.preventDefault();
      const dow = (focus.getDay() - firstDow + 7) % 7;
      return moveTo(addDays(focus, k === 'Home' ? -dow : 6 - dow));
    }
  });

  const place = () => {
    if (!btn.isConnected || !btn.offsetParent) return close();
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth || 292;
    const h = pop.offsetHeight || 360;
    const left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
    const up = innerHeight - r.bottom < h + 16 && r.top > innerHeight - r.bottom;
    pop.style.left = `${left}px`;
    pop.style.top = up ? `${Math.max(8, r.top - h - 6)}px` : `${r.bottom + 6}px`;
    pop.classList.toggle('up', up);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (mode === 'months') {
        mode = 'days';
        render();
        return focusDay();
      }
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
    input,
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
  requestAnimationFrame(() => {
    place();
    pop.classList.add('in');
  });
  focusDay();
}

/** Enhance every date input now and whenever new ones appear (dialogs, panels). */
export function enhanceDatesEverywhere() {
  document.querySelectorAll('input[type="date"]').forEach(enhanceDate);
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches('input[type="date"]')) enhanceDate(n);
        else n.querySelectorAll?.('input[type="date"]').forEach(enhanceDate);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}
