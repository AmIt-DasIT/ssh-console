// Status island (Kokonut UI "Dynamic Island"): one dark pill at the top of the window that
// morphs between short notices (toast) and a live activity (uploads / downloads). The pill
// animates its width, height and corner radius to fit whatever it is showing.
import { icon } from './icons.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let el = null;
let toastsEl = null;
let actEl = null;
let toastOn = false;
let toastTimer = 0;
let hovering = false;
let activity = null; // the live-activity element, or null

function init() {
  if (el) return;
  el = document.getElementById('island');
  el.innerHTML = '<div class="island-toasts"></div><div class="island-act"></div>';
  toastsEl = el.firstElementChild;
  actEl = el.lastElementChild;
  // Clicking a notice dismisses it (the activity underneath handles its own clicks).
  toastsEl.addEventListener('click', () => hideToast());
  el.addEventListener('mouseenter', () => {
    hovering = true;
    clearTimeout(toastTimer);
    el.dispatchEvent(new CustomEvent('island-hover', { detail: true }));
  });
  el.addEventListener('mouseleave', () => {
    hovering = false;
    if (toastOn) toastTimer = setTimeout(hideToast, 1800);
    el.dispatchEvent(new CustomEvent('island-hover', { detail: false }));
  });
  addEventListener('resize', layout);
}

export const islandHovered = () => hovering;
export const islandEl = () => (init(), el);

/** Size the pill to what it currently shows. */
function layout() {
  if (!el) return;
  const target = toastOn ? toastsEl.querySelector('.island-row:not(.leave)') : activity;
  el.classList.toggle('show', !!target);
  el.classList.toggle('act-mode', !toastOn && !!activity);
  el.classList.toggle('toast-mode', toastOn);
  if (!target) return;
  const w = Math.min(target.offsetWidth, innerWidth - 32);
  const h = target.offsetHeight;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.style.borderRadius = `${h > 48 ? 24 : h / 2}px`;
}

function hideToast() {
  clearTimeout(toastTimer);
  toastOn = false;
  for (const r of toastsEl.querySelectorAll('.island-row:not(.leave)')) {
    r.classList.add('leave');
    setTimeout(() => r.remove(), 350);
  }
  layout();
}

/** A short notice. kind: true/'error', 'success', 'warn' or 'info' (default). */
export function toast(text, kind = 'info') {
  init();
  const type = kind === true ? 'error' : kind || 'info';
  const busy = type === 'info' && /…$/.test(String(text));
  const ic = { error: 'error', success: 'check', warn: 'alert', info: busy ? 'refresh' : 'info' }[type];
  const row = document.createElement('div');
  row.className = `island-row ${type}${busy ? ' busy' : ''} enter`;
  row.innerHTML = `${icon(ic)}<span>${esc(text)}</span>`;
  for (const old of toastsEl.querySelectorAll('.island-row:not(.leave)')) {
    old.classList.add('leave');
    setTimeout(() => old.remove(), 350);
  }
  toastsEl.appendChild(row);
  toastOn = true;
  layout();
  requestAnimationFrame(() => requestAnimationFrame(() => row.classList.remove('enter')));
  clearTimeout(toastTimer);
  // While a live activity is running, notices are shorter so the progress comes back quickly.
  const ms = type === 'error' ? 8000 : type === 'warn' ? 6000 : activity ? 2200 : 3500;
  if (!hovering) toastTimer = setTimeout(hideToast, ms);
}

/** Show (or keep showing) a live activity element. Call relayout() after changing its size. */
export function setActivity(node) {
  init();
  if (activity !== node) {
    actEl.replaceChildren(node);
    activity = node;
  }
  layout();
}

export function clearActivity() {
  if (!el || !activity) return;
  const old = activity;
  activity = null;
  layout();
  setTimeout(() => {
    if (activity !== old) old.remove();
  }, 400);
}

export const relayout = layout;
