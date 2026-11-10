// Live charts, number tweening and skeleton loaders.
//
// LiveChart draws a scrolling time series in an SVG sized 1:1 to its box (so strokes and dots stay
// crisp). Every frame is computed in one requestAnimationFrame loop: the series slides left by
// exactly one sample over the measured time between samples, so motion is continuous and lines up
// with real arrivals; the "now" dot sits on the right edge at the exact interpolated value; and
// the y axis eases to a new scale instead of jumping.
import { esc } from './core.js';

const NS = 'http://www.w3.org/2000/svg';
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
let chartSeq = 0;

/** A "nice" axis maximum ≥ v: 1, 2, 2.5, 5 × 10^n. */
export function niceCeil(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v - 1e-9) return m * p;
  return 10 * p;
}

export class LiveChart {
  /**
   * opts:
   *   series   [{ key, label, color }]  (color is any CSS colour, e.g. 'var(--blue)')
   *   capacity samples kept / shown (default 60)
   *   height   px (default 120)
   *   format   value → label (axis, tooltip, legend)
   *   floor    smallest axis maximum (default 1)
   *   fixedMax fixed axis maximum (disables auto-scaling)
   *   legend   show a legend with live values (default: when more than one series)
   */
  constructor(mount, opts) {
    this.o = { capacity: 60, height: 120, floor: 1, format: (v) => v.toFixed(1), ...opts };
    this.o.legend ??= this.o.series.length > 1;
    this.samples = []; // { t, v: { key: value } }
    this.yMax = null;
    this.yFrom = null;
    this.yTo = null;
    this.yStart = 0;
    this.slideFrom = 0; // px offset at the start of the current slide
    this.slideStart = 0;
    this.slideDur = 0;
    this.raf = 0;
    this.hoverX = null;
    this.id = `lc${++chartSeq}`;

    const root = (this.root = document.createElement('div'));
    root.className = 'lc';
    root.style.height = `${this.o.height}px`;
    root.innerHTML = `
      <svg class="lc-svg" xmlns="${NS}">
        <defs>
          ${this.o.series
            .map(
              (s, i) => `<linearGradient id="${this.id}g${i}" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" style="stop-color:${s.color};stop-opacity:.32"/>
                <stop offset=".75" style="stop-color:${s.color};stop-opacity:.04"/>
                <stop offset="1" style="stop-color:${s.color};stop-opacity:0"/></linearGradient>`,
            )
            .join('')}
          <clipPath id="${this.id}c"><rect class="lc-clip" x="0" y="0" width="0" height="0"/></clipPath>
        </defs>
        <g class="lc-grid"></g>
        <g clip-path="url(#${this.id}c)">
          ${this.o.series.map((s, i) => `<path class="lc-area" fill="url(#${this.id}g${i})"/>`).join('')}
          ${this.o.series.map((s) => `<path class="lc-line" pathLength="1" style="stroke:${s.color}"/>`).join('')}
        </g>
        <line class="lc-cross" y1="0" x1="0" x2="0" y2="0"/>
        ${this.o.series.map((s) => `<circle class="lc-halo" r="7" style="fill:${s.color}"/><circle class="lc-dot" r="3.25" style="fill:${s.color}"/>`).join('')}
      </svg>
      <div class="lc-y"><span class="lc-y-top"></span><span class="lc-y-mid"></span></div>
      <div class="lc-tip" hidden></div>
      <div class="lc-wait"><span class="lc-wait-bar"></span><span>Collecting samples…</span></div>`;
    if (this.o.legend) {
      this.legend = document.createElement('div');
      this.legend.className = 'lc-legend';
      this.legend.innerHTML = this.o.series
        .map((s) => `<span data-k="${esc(s.key)}"><i style="background:${s.color}"></i>${esc(s.label)} <b>—</b></span>`)
        .join('');
      mount.appendChild(this.legend);
    }
    mount.appendChild(root);

    this.svg = root.querySelector('svg');
    this.areas = [...root.querySelectorAll('.lc-area')];
    this.lines = [...root.querySelectorAll('.lc-line')];
    this.dots = [...root.querySelectorAll('.lc-dot')];
    this.halos = [...root.querySelectorAll('.lc-halo')];
    this.cross = root.querySelector('.lc-cross');
    this.tip = root.querySelector('.lc-tip');
    this.grid = root.querySelector('.lc-grid');
    this.clip = root.querySelector('.lc-clip');
    this.wait = root.querySelector('.lc-wait');

    this.ro = new ResizeObserver(() => this.measure());
    this.ro.observe(root);
    root.addEventListener('pointermove', (e) => {
      const r = this.svg.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.frame();
    });
    root.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.frame();
    });
    this.measure();
  }

  measure() {
    const w = Math.round(this.root.clientWidth);
    const h = Math.round(this.root.clientHeight);
    if (!w || !h || (w === this.W && h === this.H)) return;
    this.W = w;
    this.H = h;
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svg.setAttribute('width', w);
    this.svg.setAttribute('height', h);
    this.clip.setAttribute('width', w - 5); // the line ends exactly at the "now" dot
    this.clip.setAttribute('height', h);
    this.cross.setAttribute('y2', h);
    // Gridlines at 0, ½ and the top (where the axis labels are).
    const pad = this.pad();
    this.grid.innerHTML = [0, 0.5, 1]
      .map((f) => {
        const y = (pad.top + (h - pad.top - pad.bottom) * (1 - f)).toFixed(1);
        return `<line x1="0" x2="${w}" y1="${y}" y2="${y}" class="${f === 0 ? 'base' : ''}"/>`;
      })
      .join('');
    this.frame();
  }

  pad() {
    return { top: 10, bottom: 2 };
  }

  /** Right edge of the plot: the "now" dot sits here, fully visible. */
  get R() {
    return this.W - 5;
  }

  get step() {
    return this.R / (this.o.capacity - 1);
  }

  /**
   * Values for every series at this moment: { key: number }.
   *
   * Until the window is full the series spans the whole width: each new sample slides in from
   * the right while the others compress to make room. Once full, the series scrolls left by
   * exactly one sample per sample. Both motions last the measured time between samples, so the
   * chart is always moving at the speed data really arrives.
   */
  push(values) {
    const now = performance.now();
    const prev = this.samples[this.samples.length - 1];
    this.samples.push({ t: Date.now(), v: values });
    if (this.samples.length > this.o.capacity + 1) this.samples.shift();
    const n = this.samples.length;

    // After a long pause (tab hidden, stats tab reopened) the new point just appears.
    const gap = now - (this.lastPush || now);
    const animate = prev && gap < 10000 && !reduceMotion() && !document.hidden;
    if (n <= this.o.capacity) {
      const target = 1 / Math.max(n - 1, 1);
      this.fFrom = animate && n > 2 ? this.currentFrac(now) : target;
      this.fTo = target;
      this.slideFrom = 0;
    } else {
      this.slideFrom = animate ? this.currentOffset(now) + this.step : 0;
      this.fFrom = this.fTo = 1 / (this.o.capacity - 1);
    }
    this.slideDur = animate ? Math.min(Math.max(gap, 400), 8000) : 0;
    this.slideStart = now;
    this.lastPush = now;

    // Scale: the busiest visible value plus headroom, rounded to a nice number; eased in.
    let peak = 0;
    for (const s of this.samples) for (const se of this.o.series) peak = Math.max(peak, Number(s.v[se.key]) || 0);
    const target = this.o.fixedMax ?? Math.max(this.o.floor, niceCeil(peak * 1.15));
    if (this.yMax === null) this.yMax = this.yTo = target;
    else if (target !== this.yTo) {
      this.yFrom = this.yMax;
      this.yTo = target;
      this.yStart = now;
    }
    this.updateLabels(values);

    if (n >= 2 && !this.drawn) {
      this.drawn = true;
      if (!reduceMotion()) {
        for (const l of this.lines) l.classList.add('draw');
        for (const a of this.areas) a.classList.add('draw');
        setTimeout(() => {
          for (const l of this.lines) l.classList.remove('draw');
          for (const a of this.areas) a.classList.remove('draw');
        }, 1300);
      }
    }
    this.wait.hidden = n >= 2;
    this.loop();
  }

  /** Replace the history at once (e.g. when a tab is reopened). */
  load(samples) {
    for (const s of samples) this.push(s);
    this.slideDur = 0;
    this.slideFrom = 0;
    this.fFrom = this.fTo;
  }

  progress(now) {
    return this.slideDur ? Math.min(1, (now - this.slideStart) / this.slideDur) : 1;
  }

  currentOffset(now) {
    return this.slideFrom * (1 - this.progress(now));
  }

  currentFrac(now) {
    if (this.fTo == null) return 1;
    return this.fFrom + (this.fTo - this.fFrom) * this.progress(now);
  }

  loop() {
    if (this.raf) return;
    const tick = () => {
      this.raf = 0;
      const busy = this.frame();
      if (busy) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Draw one frame. Returns true while something is still moving. */
  frame() {
    if (!this.W || !this.samples.length) return false;
    const now = performance.now();
    let moving = this.progress(now) < 1;

    if (this.yFrom !== null) {
      const p = Math.min(1, (now - this.yStart) / 500);
      this.yMax = this.yFrom + (this.yTo - this.yFrom) * easeOut(p);
      if (p >= 1) this.yFrom = null;
      else moving = true;
    }

    const { H, R } = this;
    const pad = this.pad();
    const plotH = H - pad.top - pad.bottom;
    const n = this.samples.length;
    let xOf;
    if (n === 1) xOf = () => R;
    else if (n <= this.o.capacity) {
      const f = this.currentFrac(now);
      xOf = (i) => i * f * R;
    } else {
      const off = this.currentOffset(now);
      const step = this.step;
      xOf = (i) => R - (n - 1 - i) * step + off;
    }
    const yOf = (v) => pad.top + plotH * (1 - Math.min(Math.max(v / this.yMax, 0), 1.04));

    this.o.series.forEach((se, si) => {
      const pts = this.samples.map((s, i) => [xOf(i), yOf(Number(s.v[se.key]) || 0)]);
      if (pts.length >= 2) {
        const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join('');
        this.lines[si].setAttribute('d', line);
        this.areas[si].setAttribute('d', `${line}L${pts[pts.length - 1][0].toFixed(2)},${H}L${pts[0][0].toFixed(2)},${H}Z`);
      }
      // "Now" dot: exactly where the line crosses the right edge of the plot.
      let y = pts[pts.length - 1][1];
      for (let i = pts.length - 1; i > 0; i--) {
        const [x1, y1] = pts[i - 1];
        const [x2, y2] = pts[i];
        if (x1 <= R && x2 >= R) {
          y = x2 === x1 ? y2 : y1 + ((R - x1) / (x2 - x1)) * (y2 - y1);
          break;
        }
      }
      const cx = R.toFixed(2);
      this.dots[si].setAttribute('cx', cx);
      this.dots[si].setAttribute('cy', y.toFixed(2));
      this.halos[si].setAttribute('cx', cx);
      this.halos[si].setAttribute('cy', y.toFixed(2));
    });

    this.drawHover(xOf);
    return moving;
  }

  drawHover(xOf) {
    const n = this.samples.length;
    if (this.hoverX === null || n < 2) {
      this.cross.style.opacity = '0';
      this.tip.hidden = true;
      return;
    }
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(xOf(i) - this.hoverX);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const x = xOf(best);
    if (x < 0 || x > this.R + 0.5) {
      this.cross.style.opacity = '0';
      this.tip.hidden = true;
      return;
    }
    const s = this.samples[best];
    this.cross.setAttribute('x1', x.toFixed(2));
    this.cross.setAttribute('x2', x.toFixed(2));
    this.cross.style.opacity = '1';
    const ago = Math.max(0, Math.round((Date.now() - s.t) / 1000));
    this.tip.innerHTML =
      `<div class="lc-tip-t">${ago ? `${ago}s ago` : 'now'}</div>` +
      this.o.series
        .map((se) => `<div><i style="background:${se.color}"></i>${esc(se.label)}<b>${esc(this.o.format(Number(s.v[se.key]) || 0))}</b></div>`)
        .join('');
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth;
    const left = x + 12 + tw > this.W ? x - 12 - tw : x + 12;
    this.tip.style.transform = `translate(${Math.max(0, left).toFixed(0)}px, 6px)`;
  }

  updateLabels(values) {
    const top = this.root.querySelector('.lc-y-top');
    const mid = this.root.querySelector('.lc-y-mid');
    top.textContent = this.o.format(this.yTo);
    mid.textContent = this.o.format(this.yTo / 2);
    if (this.legend) {
      for (const se of this.o.series) {
        const b = this.legend.querySelector(`[data-k="${CSS.escape(se.key)}"] b`);
        if (b) b.textContent = this.o.format(Number(values[se.key]) || 0);
      }
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.root.remove();
    this.legend?.remove();
  }
}

/** Small static sparkline (table cells). */
export function miniSpark(values, color = 'var(--blue)', max = null) {
  if (!values || values.length < 2) return '<svg class="mspark" viewBox="0 0 80 22"></svg>';
  const W = 80;
  const H = 22;
  const top = max ?? Math.max(niceCeil(Math.max(...values) * 1.1), 1);
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => [i * step, H - 1.5 - (Math.min(v, top) / top) * (H - 4)]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  return `<svg class="mspark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${line}L${W},${H}L0,${H}Z" style="fill:${color};opacity:.14"/>
    <path d="${line}" fill="none" style="stroke:${color}" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

/**
 * Animate a number shown in el from its previous value to `to`. format(v) renders the text.
 * Text that isn't numeric is set directly.
 */
export function tween(el, to, format, dur = 650) {
  if (!el) return;
  const from = typeof el._tv === 'number' ? el._tv : null;
  el._tv = to;
  cancelAnimationFrame(el._traf);
  if (from === null || from === to || reduceMotion() || !Number.isFinite(to)) {
    el.textContent = format(to);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    el.textContent = format(from + (to - from) * easeOut(p));
    if (p < 1) el._traf = requestAnimationFrame(step);
  };
  el._traf = requestAnimationFrame(step);
}

// ------------------------------------------------------------------ skeleton loaders
// Shapes match the real layout, so nothing jumps when the content arrives.

const sk = (cls = '', style = '') => `<span class="sk ${cls}" style="${style}"></span>`;

export function skeletonStats(n = 4, withChart = false) {
  return `<div class="stat-grid sk-wrap">${Array.from(
    { length: n },
    (_, i) => `<div class="stat sk-card" style="--i:${i}">
      ${sk('sk-label')}${sk('sk-value')}${sk('sk-sub')}${withChart ? sk('sk-chart') : sk('sk-bar')}
    </div>`,
  ).join('')}</div>`;
}

export function skeletonCards(n = 4) {
  return `<div class="cards sk-wrap">${Array.from(
    { length: n },
    (_, i) => `<section class="card sk-card" style="--i:${i + 4}">${sk('sk-h')}
      ${Array.from({ length: 5 }, (_, r) => `<div class="sk-row">${sk('sk-k')}${sk('sk-v', `width:${42 + ((i * 7 + r * 13) % 40)}%`)}</div>`).join('')}
    </section>`,
  ).join('')}</div>`;
}

export function skeletonTable(rows = 6, cols = 5) {
  return `<div class="cards sk-wrap"><section class="card full sk-card">${sk('sk-h')}
    ${Array.from(
      { length: rows },
      (_, r) => `<div class="sk-trow" style="--i:${r}">${Array.from({ length: cols }, (_, c) => sk('sk-cell', `flex:${c === 0 ? 2.2 : 1}`)).join('')}</div>`,
    ).join('')}
  </section></div>`;
}

export function skeletonGrid(n = 12) {
  return `<div class="fx-grid sk-wrap">${Array.from(
    { length: n },
    (_, i) => `<div class="fx-tile sk-card" style="--i:${i}">${sk('sk-thumb')}${sk('sk-name')}${sk('sk-meta')}</div>`,
  ).join('')}</div>`;
}

export function skeletonList(n = 10) {
  return `<div class="fx-list sk-wrap">${Array.from(
    { length: n },
    (_, i) => `<div class="fx-row sk-card" style="--i:${i}">${sk('sk-ricon')}${sk('sk-cell', `flex:none;width:${30 + ((i * 17) % 35)}%`)}<span class="spacer"></span>${sk('sk-cell', 'flex:none;width:60px')}${sk('sk-cell', 'flex:none;width:80px')}</div>`,
  ).join('')}</div>`;
}
