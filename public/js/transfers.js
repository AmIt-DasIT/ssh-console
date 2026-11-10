// Uploads and downloads, shown as a live activity in the status island.
//
// Compact: a progress ring with an up/down arrow, what is happening ("Uploading 3 files"),
// bytes · speed · time left, and the overall percentage. Click it to expand into a list of every
// file with its own progress and a cancel button. When everything is done the island turns into
// a short summary (with "Show in Finder" for app downloads) and then gets out of the way.
//
// Downloads: in the Mac app they go through Electron's download manager (saved straight to the
// Downloads folder, progress reported over IPC). In a browser they are streamed with fetch so the
// page can show progress, then saved.
import { rpc, desktop, fmtBytes, onStream, toast } from './core.js';
import { icon } from './icons.js';
import { setActivity, clearActivity, relayout, islandHovered } from './island.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const UPLOAD_CONCURRENCY = 2;
const RING = 2 * Math.PI * 15; // circumference of the progress ring (r = 15)
const nativeDownloads = !!desktop?.download;

let seq = 0;
const jobs = []; // see newJob()
let expanded = false;
let view = null; // the activity element
let hideTimer = 0;
let raf = 0;
let listSig = '';

const isActive = (j) => j.status === 'queued' || j.status === 'active';
/** True while anything is still transferring (reload / disconnect ask first). */
export const busy = () => jobs.some(isActive);

function newJob(kind, name, total) {
  const j = { id: ++seq, kind, name, total: total ?? null, loaded: 0, status: 'queued', error: '', start: 0, end: 0, samples: [], cancel: null, url: null, saved: false };
  jobs.push(j);
  return j;
}

function progress(j, loaded, total) {
  j.loaded = loaded;
  if (total) j.total = total;
  const now = performance.now();
  j.samples.push([now, loaded]);
  while (j.samples.length > 2 && now - j.samples[0][0] > 3000) j.samples.shift();
  schedule();
}

function finish(j, status, error = '') {
  if (!isActive(j)) return;
  j.status = status;
  j.error = error;
  j.end = performance.now();
  if (status === 'done' && j.total == null) j.total = j.loaded;
  if (status === 'done') j.loaded = j.total ?? j.loaded;
  schedule(true);
}

// ------------------------------------------------------------------ uploads

let uploading = 0;
const batches = new Map(); // batch id -> { jobs, onDone }

/**
 * Upload files. items: [{ file, rel }] (rel may contain sub-folders), params: { target | id },
 * dir: destination folder. onDone({ done, failed, cancelled }) runs once the whole batch is over.
 */
export function upload(items, { params, dir, onDone }) {
  const batch = { jobs: [], onDone };
  const bid = ++seq;
  for (const { file, rel } of items) {
    const j = newJob('upload', rel, file.size);
    Object.assign(j, { file, rel, dir, params, batch: bid });
    batch.jobs.push(j);
  }
  batches.set(bid, batch);
  schedule(true);
  pumpUploads();
}

function pumpUploads() {
  while (uploading < UPLOAD_CONCURRENCY) {
    const j = jobs.find((x) => x.kind === 'upload' && x.status === 'queued');
    if (!j) break;
    uploading++;
    runUpload(j).finally(() => {
      uploading--;
      settleBatch(j.batch);
      pumpUploads();
    });
  }
}

async function runUpload(j) {
  j.status = 'active';
  j.start = performance.now();
  schedule(true);
  try {
    const { token } = await rpc('upload', { ...j.params, dir: j.dir, name: j.rel });
    if (j.status !== 'active') return; // cancelled while asking for a token
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      j.cancel = () => xhr.abort();
      xhr.open('POST', `/api/upload/${token}`);
      xhr.upload.onprogress = (ev) => progress(j, ev.loaded, ev.lengthComputable ? ev.total : j.total);
      xhr.onload = () => {
        let body = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch { /* ignore */ }
        body.ok ? resolve() : reject(new Error(body.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.onabort = () => reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      xhr.send(j.file);
    });
    finish(j, 'done');
  } catch (err) {
    finish(j, err.cancelled ? 'cancelled' : 'error', err.message);
  }
}

function settleBatch(bid) {
  const b = batches.get(bid);
  if (!b || b.jobs.some(isActive)) return;
  batches.delete(bid);
  const count = (s) => b.jobs.filter((x) => x.status === s).length;
  b.onDone?.({ done: count('done'), failed: count('error'), cancelled: count('cancelled'), errors: b.jobs.filter((x) => x.status === 'error').map((x) => x.error) });
}

// ------------------------------------------------------------------ downloads

/**
 * Download from the server. params go to the "download" request (what, target/id, path…);
 * name is shown while it runs, size (bytes) lets the island show a percentage when known.
 */
export async function download(params, { name, size = null } = {}) {
  const j = newJob('download', name || 'download', size);
  j.status = 'active';
  j.start = performance.now();
  schedule(true);
  let token;
  try {
    ({ token } = await rpc('download', params));
  } catch (err) {
    return finish(j, 'error', err.message);
  }
  if (j.status !== 'active') return;
  const url = new URL(`/api/download/${token}`, location.href).href;
  j.url = url;
  if (nativeDownloads) {
    j.cancel = () => desktop.cancelDownload(url);
    desktop.download(url);
    return;
  }
  const ctrl = new AbortController();
  j.cancel = () => ctrl.abort();
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(((await res.text()) || `Download failed (${res.status})`).slice(0, 300));
    const fname = filenameOf(res.headers.get('Content-Disposition')) || j.name;
    j.name = fname;
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      progress(j, loaded, j.total);
    }
    const blob = new Blob(chunks, { type: res.headers.get('Content-Type') || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    j.total = loaded;
    finish(j, 'done');
  } catch (err) {
    finish(j, err.name === 'AbortError' ? 'cancelled' : 'error', err.message);
  }
}

function filenameOf(cd) {
  if (!cd) return '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch { /* fall through */ }
  }
  return (/filename="([^"]*)"/i.exec(cd) || [])[1] || '';
}

// A download whose command failed part-way (a database dump): the server aborts it so no
// truncated file is kept, and says why.
onStream('transfer:error', (d) => toast(`${d.name || 'Download'} failed: ${String(d.error || '').split('\n').filter(Boolean).pop() || 'error'}`, 'error'));

// Progress of app downloads, from the Electron download manager.
desktop?.onDownloadProgress?.((d) => {
  const j = jobs.find((x) => x.url === d.url);
  if (!j) return;
  if (d.filename) j.name = d.filename;
  if (d.state === 'progressing') progress(j, d.received, d.total || j.total);
  else if (d.state === 'completed') {
    j.saved = true;
    j.total = d.received || j.total;
    finish(j, 'done');
  } else if (d.state === 'cancelled') finish(j, 'cancelled', 'Cancelled');
  else if (d.state === 'interrupted') finish(j, 'error', 'The download was interrupted');
});

// ------------------------------------------------------------------ actions

function cancelJob(j) {
  if (j.status === 'queued') finish(j, 'cancelled', 'Cancelled');
  else if (j.status === 'active') {
    if (j.cancel) j.cancel();
    else finish(j, 'cancelled', 'Cancelled');
  }
  if (j.kind === 'upload') {
    settleBatch(j.batch);
    pumpUploads();
  }
}

function clearFinished() {
  for (let i = jobs.length - 1; i >= 0; i--) if (!isActive(jobs[i])) jobs.splice(i, 1);
}

function dismiss() {
  clearTimeout(hideTimer);
  if (busy()) {
    clearFinished();
    expanded = false;
    return schedule(true);
  }
  jobs.length = 0;
  expanded = false;
  clearActivity();
  view = null;
  listSig = '';
}

// ------------------------------------------------------------------ rendering

function schedule(now = false) {
  if (now) {
    cancelAnimationFrame(raf);
    raf = 0;
    return render();
  }
  if (!raf) {
    raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
  }
}

const fmtTime = (s) => (s < 1 ? '<1 s' : s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);
function speedOf(list) {
  let v = 0;
  for (const j of list) {
    if (j.status !== 'active' || j.samples.length < 2) continue;
    const [t0, b0] = j.samples[0];
    const [t1, b1] = j.samples[j.samples.length - 1];
    if (t1 > t0) v += ((b1 - b0) / (t1 - t0)) * 1000;
  }
  return v;
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function summary() {
  const active = jobs.filter(isActive);
  const done = jobs.filter((j) => j.status === 'done');
  const failed = jobs.filter((j) => j.status === 'error');
  const kinds = new Set((active.length ? active : jobs).map((j) => j.kind));
  const kind = kinds.size === 1 ? [...kinds][0] : 'mixed';
  const verb = { upload: ['Uploading', 'Uploaded'], download: ['Downloading', 'Downloaded'], mixed: ['Transferring', 'Transferred'] }[kind];
  const relevant = jobs.filter((j) => j.status !== 'cancelled');
  const total = relevant.every((j) => j.total != null) ? relevant.reduce((s, j) => s + j.total, 0) : null;
  const loaded = relevant.reduce((s, j) => s + (j.status === 'done' ? j.total ?? j.loaded : j.loaded), 0);
  const pct = total ? Math.min(100, (loaded / total) * 100) : null;

  if (active.length) {
    const what = active.length === 1 && jobs.filter((j) => j.kind === active[0].kind && isActive(j)).length === 1 && relevant.length === 1
      ? active[0].name.split('/').pop()
      : plural(relevant.length, kind === 'mixed' ? 'item' : 'file');
    const speed = speedOf(active);
    const left = total && speed > 0 ? (total - loaded) / speed : null;
    const parts = [total ? `${fmtBytes(loaded)} of ${fmtBytes(total)}` : fmtBytes(loaded)];
    if (speed > 0) parts.push(`${fmtBytes(speed)}/s`);
    if (left != null && left > 0.5) parts.push(`${fmtTime(left)} left`);
    if (relevant.length > 1) parts.push(`${done.length}/${relevant.length} done`);
    return { state: 'active', kind, title: `${verb[0]} ${what}`, sub: parts.join(' · '), pct };
  }
  if (failed.length) {
    return {
      state: 'error', kind,
      title: failed.length === relevant.length ? `${kind === 'download' ? 'Download' : kind === 'upload' ? 'Upload' : 'Transfer'} failed` : `${plural(failed.length, 'file')} failed · ${done.length} done`,
      sub: failed[0].error || 'Something went wrong', pct: 100,
    };
  }
  const secs = Math.max(...jobs.map((j) => j.end), 0) - Math.min(...jobs.map((j) => j.start || Infinity));
  const what = done.length === 1 ? done[0].name.split('/').pop() : plural(done.length, kind === 'mixed' ? 'item' : 'file');
  const where = kind === 'download' && done.some((j) => j.saved) ? ' · saved to Downloads' : '';
  return {
    state: done.length ? 'done' : 'cancelled', kind,
    title: done.length ? `${verb[1]} ${what}` : 'Cancelled',
    sub: done.length ? `${fmtBytes(loaded)}${secs > 0 && Number.isFinite(secs) ? ` in ${fmtTime(secs / 1000)}` : ''}${where}` : 'Nothing was transferred',
    pct: 100,
  };
}

function build() {
  const v = document.createElement('div');
  v.className = 'ti';
  v.innerHTML = `
    <div class="ti-main" role="button" tabindex="0" aria-label="Transfers">
      <span class="ti-ring">
        <svg viewBox="0 0 36 36" aria-hidden="true"><circle class="ti-ring-bg" cx="18" cy="18" r="15"/><circle class="ti-ring-fg" cx="18" cy="18" r="15" stroke-dasharray="${RING}" stroke-dashoffset="${RING}"/></svg>
        <span class="ti-ic"></span>
      </span>
      <span class="ti-text"><strong class="ti-title"></strong><span class="ti-sub"></span></span>
      <span class="ti-pct"></span>
      <span class="ti-actions"></span>
    </div>
    <div class="ti-list"></div>
    <div class="ti-bar"><i></i></div>`;
  v.addEventListener('click', onClick);
  v.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('ti-main')) {
      e.preventDefault();
      toggle();
    }
  });
  return v;
}

function toggle() {
  expanded = !expanded;
  listSig = '';
  schedule(true);
}

function onClick(e) {
  const b = e.target.closest('[data-ti]');
  if (!b) {
    if (e.target.closest('.ti-main')) toggle();
    return;
  }
  e.stopPropagation();
  const act = b.dataset.ti;
  const j = jobs.find((x) => x.id === Number(b.dataset.id));
  if (act === 'cancel' && j) return cancelJob(j);
  if (act === 'reveal' && j) return desktop?.revealDownload?.(j.url);
  if (act === 'cancel-all') return jobs.filter(isActive).forEach(cancelJob);
  if (act === 'toggle') return toggle();
  if (act === 'close') return dismiss();
}

function render() {
  if (!jobs.length) return;
  if (!view) view = build();
  const s = summary();
  const v = view;
  v.className = `ti ${s.state} k-${s.kind}${expanded ? ' expanded' : ''}${s.pct == null && s.state === 'active' ? ' indeterminate' : ''}`;
  // Inside the ring: a plain glyph (the ring is already the circle).
  const ic = s.state === 'done' ? 'tick' : s.state === 'error' ? 'priority' : s.state === 'cancelled' ? 'x' : s.kind === 'download' ? 'download' : s.kind === 'upload' ? 'upload' : 'sort';
  const icEl = v.querySelector('.ti-ic');
  if (icEl.dataset.ic !== ic) {
    icEl.dataset.ic = ic;
    icEl.innerHTML = icon(ic);
    icEl.classList.remove('pop');
    void icEl.offsetWidth;
    icEl.classList.add('pop');
  }
  v.querySelector('.ti-title').textContent = s.title;
  v.querySelector('.ti-sub').textContent = s.sub;
  v.querySelector('.ti-pct').textContent = s.state === 'active' && s.pct != null ? `${Math.floor(s.pct)}%` : '';
  v.querySelector('.ti-ring-fg').style.strokeDashoffset = String(RING * (1 - (s.pct ?? (s.state === 'active' ? 25 : 100)) / 100));
  v.querySelector('.ti-bar i').style.width = `${s.pct ?? 0}%`;

  // Header buttons: expand/collapse, plus "Show in Finder" for a single finished app download.
  const single = jobs.length === 1 ? jobs[0] : null;
  const actions = [];
  if (s.state === 'done' && single?.saved && desktop?.revealDownload) {
    actions.push(`<button class="ti-btn ti-pill" data-ti="reveal" data-id="${single.id}" title="Show in Finder">${icon('reveal')}<span>Show</span></button>`);
  }
  if (s.state === 'active' && single) actions.push(`<button class="ti-btn" data-ti="cancel" data-id="${single.id}" title="Cancel">${icon('x')}</button>`);
  if (jobs.length > 1) actions.push(`<button class="ti-btn" data-ti="toggle" title="${expanded ? 'Collapse' : 'Show every file'}">${icon(expanded ? 'chevronUp' : 'chevronDown')}</button>`);
  if (s.state !== 'active') actions.push(`<button class="ti-btn" data-ti="close" title="Dismiss">${icon('x')}</button>`);
  const actHtml = actions.join('');
  const actEl = v.querySelector('.ti-actions');
  if (actEl._h !== actHtml) {
    actEl.innerHTML = actHtml;
    actEl._h = actHtml;
  }

  // Expanded list: rebuilt when its shape changes, otherwise updated in place.
  const list = v.querySelector('.ti-list');
  const shown = expanded ? jobs.slice(-60) : [];
  const sig = shown.map((j) => `${j.id}:${j.status}:${j.saved}`).join(',') + (expanded ? '|x' : '');
  if (sig !== listSig) {
    listSig = sig;
    list.innerHTML = expanded
      ? `${shown
          .map((j) => `<div class="ti-row ${j.status}" data-row="${j.id}">
              <span class="ti-row-ic">${icon(j.status === 'done' ? 'tick' : j.status === 'error' ? 'error' : j.kind === 'upload' ? 'upload' : 'download')}</span>
              <span class="ti-row-name" title="${esc(j.name)}">${esc(j.name)}</span>
              <span class="ti-row-st"></span>
              ${isActive(j) ? `<button class="ti-btn sm" data-ti="cancel" data-id="${j.id}" title="Cancel">${icon('x')}</button>` : j.status === 'done' && j.saved && desktop?.revealDownload ? `<button class="ti-btn sm" data-ti="reveal" data-id="${j.id}" title="Show in Finder">${icon('reveal')}</button>` : '<span class="ti-btn-gap"></span>'}
              <span class="ti-row-bar"><i></i></span>
            </div>`)
          .join('')}
         ${jobs.some(isActive) && jobs.filter(isActive).length > 1 ? '<div class="ti-foot"><button class="ti-link" data-ti="cancel-all">Cancel all</button></div>' : ''}`
      : '';
  }
  for (const j of shown) {
    const row = list.querySelector(`[data-row="${j.id}"]`);
    if (!row) continue;
    const p = j.total ? Math.min(100, ((j.status === 'done' ? j.total : j.loaded) / j.total) * 100) : j.status === 'done' ? 100 : null;
    row.querySelector('.ti-row-bar i').style.width = `${p ?? 0}%`;
    row.classList.toggle('indeterminate', p == null && j.status === 'active');
    row.querySelector('.ti-row-st').textContent =
      { queued: 'Waiting', active: p != null ? `${Math.floor(p)}%` : fmtBytes(j.loaded), done: fmtBytes(j.total ?? j.loaded), error: 'Failed', cancelled: 'Cancelled' }[j.status];
    if (j.status === 'error') row.title = j.error;
  }

  setActivity(v);
  relayout();

  // Finished: show the summary for a moment, then get out of the way (errors stay longer).
  clearTimeout(hideTimer);
  if (s.state !== 'active') {
    const ms = s.state === 'error' ? 12000 : 4500;
    const tick = () => {
      if (busy()) return;
      if (islandHovered() || expanded) hideTimer = setTimeout(tick, 1500);
      else dismiss();
    };
    hideTimer = setTimeout(tick, ms);
  }
}

