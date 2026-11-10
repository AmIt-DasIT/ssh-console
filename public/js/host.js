// Host dashboard: system overview, live container stats, images, volumes, networks, host DB client, host terminal.
import {
  $, $$, esc, rpc, state, toast, sleep, tabs, kv, card, table, bar, msg, errorBox,
  fmtBytes, fmtDuration, shortId, firstName, emit, on, dbEngineOf, dbFlavorOf, dbBadge, ENGINE_LABEL, storage,
} from './core.js';
import { DbPanel } from './database.js';
import { icon } from './icons.js';
import { confirmDialog, promptDialog } from './ui.js';
import { TermTabs } from './terminal.js';
import { FilesPanel } from './files.js';
import { skeletonStats, skeletonCards, skeletonTable, tween, miniSpark } from './charts.js';
import { hostKeyTrustLabel } from './security.js';
import { initSystem, stopSystem, resetSystem, loadServices, startProcesses, loadPorts, renderCommands, runInModal } from './system.js';


let ctl;
let hostTerms = null; // TermTabs of host shells
let hostDb = null;
let hostFiles = null; // Files tab (gallery)
let sideFiles = null; // file panel beside the host terminal
let homeDir = null;
let statsLoop = 0;
let lastStats = [];
let lastStatsAt = 0;
const statHist = new Map(); // container id -> { cpu: [], mem: [] }
let sortKey = 'name';
let sortDir = 1;
let images = [];
const tweenPrev = new Map(); // overview number key -> last shown value

export function initHost() {
  ctl = tabs($('#host-tabs'), $('#host-panels'), onTab);
  initSystem({ showTab: (t) => ctl.show(t) });
  on('browse-host', (path) => browseHost(path));
  $('#images-pull').addEventListener('click', pullImage);

  $('#host-term-new').addEventListener('click', () => hostTabs().add());
  $('#host-term-files').addEventListener('click', () => setSideFiles(!sideOpen()));
  wireSideResize();
  $('#volumes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-browse]');
    if (b) browseHost(b.dataset.browse);
  });
  $('#host-refresh').addEventListener('click', () => onTab(ctl.current));
  $('#images-filter').addEventListener('input', renderImages);
  $('#images-prune').addEventListener('click', pruneImages);
  $('#images').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rmi]');
    if (!b) return;
    const ref = b.dataset.rmi;
    const ok = await confirmDialog({
      tone: 'danger',
      icon: 'trash',
      title: `Remove image ${ref}?`,
      message: 'The image is deleted from the server. It can be pulled or built again later.',
      confirmLabel: 'Remove image',
    });
    if (!ok) return;
    b.disabled = true;
    try {
      await rpc('docker.imageRemove', { ref });
      toast(`Removed ${ref}`);
      loadImages();
    } catch (err) {
      toast(err.message, true);
      b.disabled = false;
    }
  });
  $('#host-containers').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (th) {
      sortDir = sortKey === th.dataset.sort ? -sortDir : 1;
      sortKey = th.dataset.sort;
      return renderContainerStats();
    }
    const row = e.target.closest('tr[data-id]');
    if (row) emit('select-container', row.dataset.id);
  });
}

export function showHost(tab) {
  ctl.show(tab || ctl.current || 'overview');
}

/** ⌘R / F5: reload what the current host tab shows, without leaving it. */
export function refreshHost() {
  switch (ctl.current) {
    case 'terminal':
      sideFiles?.refresh();
      return;
    case 'files':
      return hostFiles?.refresh();
    case 'database':
      return;
    default:
      return onTab(ctl.current);
  }
}

/** Open the host Files tab at a folder. */
export async function browseHost(path) {
  ctl.show('files');
  const panel = await ensureHostFiles();
  if (path) panel.open(path);
}

export function leaveHost() {
  statsLoop++;
  stopSystem();
}

export function resetHost() {
  statsLoop++;
  hostTerms?.destroy();
  hostTerms = null;
  hostDb?.destroy();
  hostDb = null;
  hostFiles?.destroy();
  hostFiles = null;
  sideFiles?.destroy();
  sideFiles = null;
  homeDir = null;
  images = [];
  lastStats = [];
  statHist.clear();
  tweenPrev.clear();
  resetSystem();
  for (const id of ['host-overview', 'host-containers', 'images', 'volumes', 'networks']) $(`#${id}`).innerHTML = '';
}

function onTab(name) {
  statsLoop++;
  stopSystem();
  emit('nav', { view: 'host', tab: name });
  $('#host-refresh').hidden = name === 'terminal' || name === 'database' || name === 'files' || name === 'commands';
  hostFiles?.show(name === 'files');
  switch (name) {
    case 'overview': return loadOverview();
    case 'containers': return runStatsLoop();
    case 'images': return loadImages();
    case 'volumes': return loadVolumes();
    case 'networks': return loadNetworks();
    case 'services': return loadServices();
    case 'processes': return startProcesses();
    case 'ports': return loadPorts();
    case 'commands': return renderCommands();
    case 'database':
      if (!hostDb) hostDb = new DbPanel($('#host-db-mount'), { target: 'host' });
      return;
    case 'files': return ensureHostFiles().then((p) => p.show(true));
    case 'terminal':
      openHostTerm();
      if (sideOpen()) setSideFiles(true);
      return;
  }
}

// ------------------------------------------------------------------ files (gallery) + terminal side panel

async function hostHome() {
  if (homeDir) return homeDir;
  try {
    homeDir = (await rpc('files.home', { target: 'host' })).path;
  } catch {
    homeDir = '/';
  }
  return homeDir;
}

function hostPlaces(home) {
  return [
    { label: 'Server root', path: '/', icon: 'server' },
    { label: 'Home', path: home, icon: 'home' },
    { label: 'Temp', path: '/tmp', icon: 'clock' },
    { label: 'Logs', path: '/var/log', icon: 'logs' },
    { label: 'Config', path: '/etc', icon: 'settings' },
    { label: 'Opt', path: '/opt', icon: 'box' },
    { label: 'Docker volumes', path: '/var/lib/docker/volumes', icon: 'drive' },
  ];
}

const profileKey = () => state.info?.profileKey || 'default';

let hostFilesP = null;
function ensureHostFiles() {
  if (hostFiles) return Promise.resolve(hostFiles);
  hostFilesP ??= hostHome().then((home) => {
    hostFilesP = null;
    if (!hostFiles) {
      // The Files tab shows the server (VM) itself, starting at its root folder.
      hostFiles = new FilesPanel($('#host-files-mount'), {
        target: 'host',
        source: state.info?.hostname || state.info?.label || state.info?.host,
        startPath: '/',
        places: hostPlaces(home),
        stateKey: `${profileKey()}.host`,
        onTerminal: cdInTerminal,
      });
      hostFiles.show(ctl.current === 'files');
    }
    return hostFiles;
  });
  return hostFilesP;
}

const sideOpen = () => storage.get('sdc.termFiles', false);

async function setSideFiles(open) {
  storage.set('sdc.termFiles', open);
  const side = $('#host-term-side');
  side.hidden = !open;
  $('#host-term-files').classList.toggle('on', open);
  if (!open) return;
  if (!sideFiles) {
    const home = await hostHome();
    if (!sideFiles) {
      sideFiles = new FilesPanel($('#host-term-files-mount'), {
        target: 'host',
        source: state.info?.hostname || state.info?.label || state.info?.host,
        startPath: home,
        places: hostPlaces(home),
        stateKey: `${profileKey()}.hostside`,
        compact: true,
        onTerminal: cdInTerminal,
      });
    }
  }
  sideFiles.show(true);
}

function wireSideResize() {
  const handle = $('#host-term-resize');
  const side = $('#host-term-side');
  const saved = storage.get('sdc.termFilesW', 380);
  side.style.width = `${saved}px`;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = side.offsetWidth;
    const box = $('#host-term-split').getBoundingClientRect();
    document.body.classList.add('resizing');
    const move = (ev) => {
      const w = Math.max(260, Math.min(box.width - 320, startW + (startX - ev.clientX)));
      side.style.width = `${w}px`;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      storage.set('sdc.termFilesW', side.offsetWidth);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('dblclick', () => {
    side.style.width = '380px';
    storage.set('sdc.termFilesW', 380);
  });
}

/** "Open in terminal": switch to the host shell and cd into the folder. */
function cdInTerminal(path) {
  ctl.show('terminal');
  openHostTerm();
  const q = `'${String(path).replace(/'/g, `'\\''`)}'`;
  const shell = hostTabs().live();
  if (!shell) return;
  shell.type(`cd -- ${q}\r`);
  toast(`Terminal: cd ${path}`);
}

function hostTabs() {
  if (!hostTerms) {
    hostTerms = new TermTabs($('#host-term-mount'), {
      spec: () => ({ kind: 'host' }),
      label: 'host shell',
      describe: () => 'host shell',
    });
    hostTerms.show(ctl?.current === 'terminal' && state.view === 'host');
  }
  return hostTerms;
}

/** Show the host terminals, opening the first one if none is open. */
function openHostTerm() {
  const tt = hostTabs();
  tt.show(true);
  if (!tt.size) tt.add();
}

/** After a reload: take over a host shell that kept running on the server (each comes back as a tab). */
export function adoptHostTerm(meta) {
  hostTabs().add({ adopt: meta });
}

// ------------------------------------------------------------------ overview

async function loadOverview() {
  const el = $('#host-overview');
  const hadContent = !!el.querySelector('.stat-grid:not(.sk-wrap)');
  if (!el.innerHTML) el.innerHTML = skeletonStats(4) + skeletonCards(4);
  try {
    const d = await rpc('host.info');
    if (ctl.current !== 'overview') return;
    const s = d.system || {};
    const k = d.docker;
    const info = state.info || {};
    const cs = state.containers;
    const count = (st) => cs.filter((c) => c.State === st).length;
    const dbs = cs.filter((c) => dbEngineOf(c.Image));

    // Uptime-card style fleet strip: one bar per container, most urgent first.
    const health = (c) =>
      /\(unhealthy\)/.test(c.Status) || c.State === 'dead'
        ? 'bad'
        : c.State === 'restarting' || c.State === 'paused' || /health: starting/.test(c.Status)
          ? 'warn'
          : c.State === 'running'
            ? 'ok'
            : 'off';
    const rank = { bad: 0, warn: 1, ok: 2, off: 3 };
    const n = { ok: 0, warn: 0, bad: 0, off: 0 };
    for (const c of cs) n[health(c)]++;
    const fleet = [...cs].sort((a, b) => rank[health(a)] - rank[health(b)] || firstName(a.Names).localeCompare(firstName(b.Names)));
    const legend = [
      ['ok', 'running', n.ok],
      ['warn', 'starting / paused / restarting', n.warn],
      ['bad', 'unhealthy', n.bad],
      ['off', 'stopped', n.off],
    ]
      .filter(([, , v]) => v)
      .map(([k, l, v]) => `<span><i class="sw-${k}"></i>${v} ${l}</span>`)
      .join('');
    const segbar = `<div class="segbar">${['ok', 'warn', 'bad', 'off']
      .filter((k) => n[k])
      .map((k) => `<i class="sw-${k}" style="flex-grow:${n[k]}"></i>`)
      .join('')}</div>`;
    const fleetCard = cs.length
      ? `<section class="card full">
          <div class="fleet-head">
            <div><h3>${icon('activity')} Fleet health</h3>
              <div class="big">${n.ok}<small class="muted" style="font-size:15px;letter-spacing:0"> of ${cs.length} running cleanly</small></div></div>
            <div class="legend">${legend}</div>
          </div>
          <div class="fleet">${fleet
            .map((c, i) => `<a class="${health(c)}" style="--i:${i}" data-fleet="${esc(c.ID)}" title="${esc(firstName(c.Names))} · ${esc(c.Status)}" href="#"></a>`)
            .join('')}</div>
          <div class="fleet-foot"><span>Most urgent first · click a bar to open it</span><span>${Math.round((n.ok / cs.length) * 100)}% up</span></div>
        </section>`
      : '';

    const tiles = `
      <div class="stat-grid">
        <div class="stat"><div class="stat-label">${icon('box')} Containers</div>
          <div class="stat-value">${tw('running', count('running'), 'int')}<small>/${cs.length}</small></div>
          <div class="stat-sub">${count('running')} running · ${cs.length - count('running')} not running</div>${segbar}</div>
        ${s.load?.length ? tile('Load average', tw('load', s.load[0], 'fixed2'), `${s.load.map((x) => x.toFixed(2)).join(' / ')} (1/5/15m)${s.cpus ? ` · ${s.cpus} CPUs` : ''}`, s.cpus ? (s.load[0] / s.cpus) * 100 : null) : ''}
        ${s.memTotal ? tile('Memory', tw('mem', ((s.memTotal - s.memAvailable) / s.memTotal) * 100, 'pct0'), `${fmtBytes(s.memTotal - s.memAvailable)} used of ${fmtBytes(s.memTotal)}`, ((s.memTotal - s.memAvailable) / s.memTotal) * 100) : ''}
        ${s.uptimeSec ? tile('Uptime', fmtDuration(s.uptimeSec), s.os || '') : ''}
      </div>`;

    const system = kv([
      ['Hostname', esc(info.hostname)],
      ['OS', esc(s.os)],
      ['Kernel', esc(s.kernel), true],
      ['CPUs', esc(s.cpus)],
      ['Uptime', s.uptimeSec ? esc(fmtDuration(s.uptimeSec)) : ''],
      ['SSH', esc(`${info.username}@${info.host}:${info.port}`)],
      ['Host key', esc(`${info.hostKeyType ? `${info.hostKeyType} ` : ''}${info.fingerprint || ''}`), true],
      ['Key trust', esc(hostKeyTrustLabel(info))],
      ['Encryption', info.legacyAlgorithms ? '<span class="st-paused">Legacy algorithms allowed</span>' : 'Modern algorithms only'],
    ]);

    const memory = s.memTotal
      ? `${memRow('RAM', s.memTotal - s.memAvailable, s.memTotal)}${s.swapTotal ? memRow('Swap', s.swapTotal - s.swapFree, s.swapTotal) : ''}`
      : '<div class="none">Not available on this OS</div>';

    const disks = (s.disks || []).length
      ? (s.disks || []).map((x) => memRow(x.mount, x.used, x.size, x.fs)).join('')
      : '<div class="none">Not available</div>';

    const docker = k
      ? kv([
          ['Version', esc(k.version)],
          ['Containers', `${esc(k.running)} running · ${esc(k.paused)} paused · ${esc(k.stopped)} stopped`],
          ['Images', esc(k.images)],
          ['Storage driver', esc(k.driver)],
          ['Logging driver', esc(k.loggingDriver)],
          ['Root dir', esc(k.rootDir), true],
          ['Cgroup', k.cgroup ? `v${esc(k.cgroup)}` : ''],
          ['Swarm', k.swarm && k.swarm !== 'inactive' ? esc(k.swarm) : ''],
          ['Engine OS', esc(k.os)],
          ['Resources', `${esc(k.cpus)} CPUs · ${esc(fmtBytes(k.memTotal))}`],
        ])
      : `<div class="alert warn">${esc(info.dockerError || 'Docker is not available')}</div>`;

    const dfRows = (d.dockerDf || []).map((r) => [esc(r.Type), esc(r.TotalCount), esc(r.Active), esc(r.Size), esc(r.Reclaimable)]);
    const dbList = dbs.length
      ? `<div class="chips">${dbs
          .map((c) => `<button class="chip link db-chip eng-${esc(dbFlavorOf(c.Image))}" data-open-db="${esc(c.ID)}"><span class="dot st-${esc(c.State)}"></span>${esc(firstName(c.Names))}${dbBadge(c.Image)}</button>`)
          .join('')}</div>`
      : '<div class="none">No database containers detected</div>';

    el.classList.toggle('settled', hadContent);
    el.innerHTML = `
      ${tiles}
      <div class="cards">
        ${fleetCard}
        ${card(`${icon('server')} System`, system)}
        ${card(`${icon('docker')} Docker engine`, docker)}
        ${card(`${icon('layers')} Memory`, memory)}
        ${card(`${icon('drive')} Disks`, disks)}
        ${card(`${icon('database')} Databases`, `${dbList}<p class="muted tiny" style="margin-top:10px">Click one to open its database console.</p>`)}
        ${card(`${icon('activity')} Docker disk usage`, table(['Type', 'Total', 'Active', 'Size', 'Reclaimable'], dfRows, 'nowrap'))}
        ${k?.warnings?.length ? card(`${icon('alert')} Docker warnings`, `<ul class="warn-list">${k.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`, 'full') : ''}
      </div>`;
    runTweens(el);
    $$('[data-open-db]', el).forEach((b) => b.addEventListener('click', () => emit('select-container', { id: b.dataset.openDb, tab: 'database' })));
    $$('[data-fleet]', el).forEach((a) =>
      a.addEventListener('click', (e) => {
        e.preventDefault();
        emit('select-container', a.dataset.fleet);
      }),
    );
  } catch (err) {
    el.innerHTML = errorBox(err.message);
  }
}

const TW_FORMAT = {
  int: (v) => String(Math.round(v)),
  fixed2: (v) => v.toFixed(2),
  pct0: (v) => `${Math.round(v)}%`,
};

/** A number that counts from its previous value (or 0 on first show) to v. */
function tw(key, v, fmt) {
  return `<span data-tw="${key}" data-v="${v}" data-f="${fmt}">${TW_FORMAT[fmt](tweenPrev.get(key) ?? 0)}</span>`;
}
function runTweens(root) {
  for (const n of $$('[data-tw]', root)) {
    const key = n.dataset.tw;
    const v = Number(n.dataset.v);
    n._tv = tweenPrev.get(key) ?? 0;
    tween(n, v, TW_FORMAT[n.dataset.f], 900);
    tweenPrev.set(key, v);
  }
}

function tile(label, value, sub, pct) {
  const ic = { 'Load average': 'cpu', Memory: 'layers', Uptime: 'clock' }[label];
  return `<div class="stat"><div class="stat-label">${ic ? icon(ic) : ''} ${esc(label)}</div><div class="stat-value">${value}</div><div class="stat-sub">${esc(sub)}</div>${pct != null ? bar(pct) : ''}</div>`;
}

function memRow(label, used, total, sub) {
  const pct = total ? (used / total) * 100 : 0;
  return `<div class="meter-row"><div class="meter-top"><span class="mono">${esc(label)}</span><span class="muted tiny">${fmtBytes(used)} / ${fmtBytes(total)} · ${pct.toFixed(0)}%</span></div>${bar(pct)}${sub ? `<div class="muted tiny">${esc(sub)}</div>` : ''}</div>`;
}

// ------------------------------------------------------------------ containers with live stats

async function runStatsLoop() {
  const loop = ++statsLoop;
  renderContainerStats();
  while (loop === statsLoop && state.connected && !document.hidden) {
    try {
      lastStats = await rpc('docker.statsAll');
      if (loop !== statsLoop) return;
      lastStatsAt = Date.now();
      for (const c of state.containers) {
        const st = lastStats.find((x) => c.ID.startsWith(x.ID) || x.Name === firstName(c.Names));
        if (!st) continue;
        const h = statHist.get(c.ID) || { cpu: [], mem: [] };
        h.cpu.push(pct(st.CPUPerc));
        h.mem.push(pct(st.MemPerc));
        if (h.cpu.length > 30) {
          h.cpu.shift();
          h.mem.shift();
        }
        statHist.set(c.ID, h);
      }
      renderContainerStats();
    } catch (err) {
      if (loop === statsLoop) $('#host-containers').innerHTML = errorBox(err.message);
      return;
    }
    await sleep(5000);
  }
}

const pct = (s) => parseFloat(String(s || '').replace('%', '')) || 0;

function statsRows() {
  const rows = state.containers.map((c) => {
    const s = lastStats.find((x) => c.ID.startsWith(x.ID) || x.Name === firstName(c.Names));
    return { c, s, name: firstName(c.Names), state: c.State, cpu: s ? pct(s.CPUPerc) : -1, mem: s ? pct(s.MemPerc) : -1, image: c.Image };
  });
  rows.sort((a, b) => {
    const va = a[sortKey];
    const vb = b[sortKey];
    return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * sortDir;
  });
  return rows;
}

const pending = '<span class="sk sk-inline"></span>';
const barCls = (p) => (p >= 90 ? 'crit' : p >= 80 ? 'warn' : '');

function statCells({ c, s }) {
  const h = statHist.get(c.ID);
  const cpu = s ? pct(s.CPUPerc) : 0;
  const mem = s ? pct(s.MemPerc) : 0;
  // Not-running containers have no stats: a dash, not a loading placeholder.
  const wait = c.State === 'running' ? pending : '<span class="muted">—</span>';
  return {
    status: esc(c.Status),
    cpuText: s ? esc(s.CPUPerc) : wait,
    cpuPct: Math.min(cpu, 100),
    trend: s ? miniSpark(h?.cpu, 'var(--blue)') : c.State === 'running' ? pending : '',
    memText: s ? `${esc(s.MemUsage.split('/')[0].trim())} <span class="muted">(${esc(s.MemPerc)})</span>` : wait,
    memPct: Math.min(mem, 100),
    net: s ? esc(s.NetIO) : c.State === 'running' ? pending : '—',
    blk: s ? esc(s.BlockIO) : c.State === 'running' ? pending : '—',
    pids: s ? esc(s.PIDs) : c.State === 'running' ? pending : '—',
  };
}

function renderContainerStats() {
  const el = $('#host-containers');
  if (!state.containers.length) {
    el.innerHTML = msg('No containers on this host.');
    return;
  }
  const rows = statsRows();
  const order = rows.map((r) => r.c.ID).join(',');
  const running = state.containers.filter((c) => c.State === 'running').length;
  const totCpu = lastStats.reduce((a, x) => a + pct(x.CPUPerc), 0);
  const totMem = lastStats.reduce((a, x) => a + pct(x.MemPerc), 0);
  const summary = `<span class="live-dot${lastStatsAt ? '' : ' wait'}"></span>
    <span>${lastStatsAt ? 'Live' : 'Sampling…'}</span>
    <span class="muted">· ${running} running</span>
    ${lastStatsAt ? `<span class="muted">· CPU total <b class="tnum">${totCpu.toFixed(1)}%</b> · memory total <b class="tnum">${totMem.toFixed(1)}%</b></span>` : ''}`;

  // Same rows in the same order: update cells in place so bars glide to their new values.
  const tbl = el.querySelector('table.live-tbl');
  if (tbl && tbl.dataset.order === order) {
    el.querySelector('.live-summary').innerHTML = summary;
    for (const r of rows) {
      const tr = tbl.querySelector(`tr[data-id="${CSS.escape(r.c.ID)}"]`);
      if (!tr) continue;
      const v = statCells(r);
      const set = (k, html) => {
        const td = tr.querySelector(`[data-c="${k}"]`);
        if (td && td._h !== html) {
          td.innerHTML = html;
          td._h = html;
        }
      };
      set('status', v.status);
      set('cpuText', v.cpuText);
      set('trend', v.trend);
      set('memText', v.memText);
      set('net', v.net);
      set('blk', v.blk);
      set('pids', v.pids);
      for (const [k, p] of [['cpuBar', v.cpuPct], ['memBar', v.memPct]]) {
        const i = tr.querySelector(`[data-c="${k}"] > i`);
        if (i) {
          i.style.width = `${p.toFixed(1)}%`;
          i.className = barCls(p);
        }
      }
      tr.querySelector('td.st')?.setAttribute('class', `st st-${r.c.State}`);
    }
    return;
  }

  const th = (key, label) => `<th data-sort="${key}" class="sortable">${label}${sortKey === key ? (sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  el.innerHTML = `
    <div class="live-summary">${summary}</div>
    <div class="tbl-wrap"><table class="tbl clickable nowrap live-tbl" data-order="${esc(order)}">
      <thead><tr>${th('name', 'Name')}${th('state', 'State')}${th('image', 'Image')}${th('cpu', 'CPU')}<th>CPU trend</th>${th('mem', 'Memory')}<th>Net I/O</th><th>Block I/O</th><th>PIDs</th><th>Ports</th></tr></thead>
      <tbody>${rows
        .map((r, i) => {
          const { c, name } = r;
          const v = statCells(r);
          const eng = dbEngineOf(c.Image);
          return `<tr data-id="${esc(c.ID)}" style="--i:${Math.min(i, 30)}">
            <td><span class="dot st-${esc(c.State)}"></span> <strong>${esc(name)}</strong>${eng ? ` ${dbBadge(c.Image)}` : ''}</td>
            <td class="st st-${esc(c.State)}" data-c="status">${v.status}</td>
            <td class="mono muted ellip" title="${esc(c.Image)}">${esc(c.Image)}</td>
            <td class="num"><span data-c="cpuText">${v.cpuText}</span><div class="bar" data-c="cpuBar"><i class="${barCls(v.cpuPct)}" style="width:${v.cpuPct.toFixed(1)}%"></i></div></td>
            <td class="trend" data-c="trend">${v.trend}</td>
            <td class="num"><span data-c="memText">${v.memText}</span><div class="bar" data-c="memBar"><i class="${barCls(v.memPct)}" style="width:${v.memPct.toFixed(1)}%"></i></div></td>
            <td class="num muted" data-c="net">${v.net}</td>
            <td class="num muted" data-c="blk">${v.blk}</td>
            <td class="num muted" data-c="pids">${v.pids}</td>
            <td class="mono muted ellip" title="${esc(c.Ports)}">${esc(c.Ports || '')}</td>
          </tr>`;
        })
        .join('')}</tbody>
    </table></div>
    <div class="muted tiny inset-note">Live stats refresh every 5 seconds while this tab is open. Click a row to open the container; click a column to sort.</div>`;
}

// ------------------------------------------------------------------ images / volumes / networks

async function pullImage() {
  const ref = await promptDialog({
    title: 'Pull image',
    message: 'Download an image from its registry, for example nginx:latest or ghcr.io/org/app:1.2.',
    label: 'Image',
    placeholder: 'nginx:latest',
    confirmLabel: 'Pull',
  });
  if (!ref) return;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,255}$/.test(ref)) return toast('That is not a valid image name', true);
  runInModal({
    title: `Pull ${ref}`,
    kind: 'pull',
    ref,
    onDone: (ok) => {
      if (ok && ctl.current === 'images') loadImages();
    },
  });
}

async function loadImages() {
  const el = $('#images');
  if (!el.innerHTML) el.innerHTML = skeletonTable(6, 6);
  try {
    images = await rpc('docker.images');
    renderImages();
  } catch (err) {
    el.innerHTML = errorBox(err.message);
  }
}

function imageUsers(img) {
  const ref = `${img.Repository}:${img.Tag}`;
  const id = img.ID.replace(/^sha256:/, '');
  return state.containers.filter(
    (c) => c.Image === ref || (img.Tag === 'latest' && c.Image === img.Repository) || (c.Image.length >= 12 && id.startsWith(c.Image.replace(/^sha256:/, ''))),
  );
}

function renderImages() {
  const q = $('#images-filter').value.trim().toLowerCase();
  const list = images.filter((i) => !q || `${i.Repository}:${i.Tag} ${i.ID}`.toLowerCase().includes(q));
  const totalSize = images.length;
  $('#images').innerHTML =
    `<div class="muted tiny inset-note">${totalSize} images</div>` +
    `<div class="cards"><section class="card full">${table(
      ['Image', 'ID', 'Size', 'Created', 'Used by', ''],
      list.map((i) => {
        const users = imageUsers(i);
        const dangling = i.Repository === '<none>';
        const ref = dangling ? shortId(i.ID) : `${i.Repository}:${i.Tag}`;
        return [
          `<span class="mono">${esc(dangling ? '<none>' : ref)}</span>${dangling ? ' <span class="pill">dangling</span>' : ''}`,
          `<span class="mono muted">${esc(shortId(i.ID))}</span>`,
          esc(i.Size),
          `<span class="muted">${esc(i.CreatedSince)}</span>`,
          users.length ? users.map((c) => esc(firstName(c.Names))).join(', ') : '<span class="muted">unused</span>',
          `<button class="btn small danger-ghost" data-rmi="${esc(ref)}" ${users.length ? 'disabled title="In use by a container"' : ''}>Remove</button>`,
        ];
      }),
    )}</section></div>`;
}

async function pruneImages() {
  const ok = await confirmDialog({
    tone: 'warn',
    icon: 'trash',
    title: 'Prune dangling images?',
    message: 'Removes untagged images that no container uses. This frees disk space and cannot be undone.',
    confirmLabel: 'Prune',
  });
  if (!ok) return;
  try {
    const out = await rpc('docker.imagePrune', {});
    toast(out.trim().split('\n').pop() || 'Pruned');
    loadImages();
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadVolumes() {
  const el = $('#volumes');
  if (!el.innerHTML) el.innerHTML = skeletonTable(5, 4);
  try {
    const vols = await rpc('docker.volumes');
    el.innerHTML = `<div class="cards"><section class="card full"><h3>${vols.length} volumes</h3>${table(
      ['Name', 'Driver', 'Used by', 'Mountpoint', ''],
      vols.map((v) => {
        const users = state.containers.filter((c) => String(c.Mounts || '').split(',').includes(v.Name));
        return [
          `<span class="mono">${esc(v.Name.length > 40 ? shortId(v.Name) + '…' : v.Name)}</span>`,
          esc(v.Driver),
          users.length ? users.map((c) => esc(firstName(c.Names))).join(', ') : '<span class="muted">unused</span>',
          `<span class="mono muted">${esc(v.Mountpoint || '')}</span>`,
          v.Mountpoint ? `<button class="btn small ghost" data-browse="${esc(v.Mountpoint)}" title="Browse in Files (usually needs root)">${icon('folderOpen')}Browse</button>` : '',
        ];
      }),
    )}</section></div>`;
  } catch (err) {
    el.innerHTML = errorBox(err.message);
  }
}

async function loadNetworks() {
  const el = $('#networks');
  if (!el.innerHTML) el.innerHTML = skeletonTable(4, 6);
  try {
    const nets = await rpc('docker.networks');
    el.innerHTML = `<div class="cards"><section class="card full"><h3>${nets.length} networks</h3>${table(
      ['Name', 'Driver', 'Scope', 'Internal', 'Containers', 'ID'],
      nets.map((n) => {
        const users = state.containers.filter((c) => String(c.Networks || '').split(',').includes(n.Name));
        return [
          `<strong>${esc(n.Name)}</strong>`,
          esc(n.Driver),
          esc(n.Scope),
          n.Internal === 'true' ? 'yes' : '<span class="muted">no</span>',
          users.length ? users.map((c) => esc(firstName(c.Names))).join(', ') : '<span class="muted">—</span>',
          `<span class="mono muted">${esc(shortId(n.ID))}</span>`,
        ];
      }),
    )}</section></div>`;
  } catch (err) {
    el.innerHTML = errorBox(err.message);
  }
}
