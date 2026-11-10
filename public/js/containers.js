// Container list (sidebar) and the per-container view with all of its tabs.
import {
  $, $$, esc, rpc, send, onStream, state, toast, sleep, uid, kv, card, table, msg, errorBox, bar,
  fmtDate, fmtBytes, cmdStr, shortId, firstName, containerById, emit, copyText,
  dbEngineOf, dbFlavorOf, dbBadge, ENGINE_LABEL, tabs, storage, prefs, notify, desktop, tileStyle,
} from './core.js';
import { icon } from './icons.js';
import { confirmDialog } from './ui.js';
import { makeXterm, TermTabs } from './terminal.js';
import { FilesPanel } from './files.js';
import { DbPanel } from './database.js';
import { download } from './transfers.js';
import { LiveChart, tween, skeletonStats } from './charts.js';

let ctl;
let inspect = null;
let statsLoop = 0;
let statsHistory = { samples: [], prev: null }; // samples: { cpu, mem, rx, tx, br, bw, pids }
let charts = null; // LiveCharts of the stats tab
let stateFilter = storage.get('sdc.stateFilter', 'all');
let prevSnapshot = null;
const collapsed = new Set(storage.get('sdc.collapsed', []));
const recentActions = new Map(); // containerId -> time of a user-initiated action (suppresses alerts)
const terms = new Map(); // containerId -> TermTabs (its shells)
const filePanels = new Map(); // containerId -> FilesPanel
const dbPanels = new Map(); // containerId -> DbPanel
const logs = { view: null, token: null, containerId: null };

export const CONTAINER_TABS = [
  ['overview', 'Overview', 'layers'],
  ['logs', 'Logs', 'logs'],
  ['terminal', 'Terminal', 'terminal'],
  ['database', 'Database', 'database'],
  ['files', 'Files', 'folder'],
  ['stats', 'Stats', 'activity'],
  ['processes', 'Processes', 'cpu'],
  ['env', 'Environment', 'key'],
  ['inspect', 'Inspect', 'file'],
];

const ACTION_INFO = {
  start: { label: 'Start', icon: 'play' },
  unpause: { label: 'Resume', icon: 'play' },
  restart: {
    label: 'Restart', icon: 'restart', tone: 'warn',
    message: 'The container is stopped and started again. Its processes restart and open connections are dropped.',
  },
  pause: {
    label: 'Pause', icon: 'pause', tone: 'warn',
    message: 'All processes in the container are frozen until you resume it. Connections stay open but get no responses.',
  },
  stop: {
    label: 'Stop', icon: 'stop', tone: 'warn',
    message: 'The container gets SIGTERM and is force-stopped after its timeout (10 s by default). Anything that depends on it loses its connection.',
  },
  remove: {
    label: 'Remove', icon: 'trash', tone: 'danger',
    message: 'The container and its writable layer are deleted permanently. Named volumes are kept.',
  },
};

export function initContainers() {
  ctl = tabs($('#c-tabs'), $('#c-panels'), onTab);

  $('#container-list').addEventListener('click', onListClick);
  $('#filter').addEventListener('input', renderList);
  $$('#state-filter [data-f]').forEach((b) => {
    b.classList.toggle('active', b.dataset.f === stateFilter);
    b.addEventListener('click', () => {
      stateFilter = b.dataset.f;
      storage.set('sdc.stateFilter', stateFilter);
      $$('#state-filter [data-f]').forEach((x) => x.classList.toggle('active', x === b));
      renderList();
    });
  });
  $('#refresh-btn').addEventListener('click', () => loadContainers());
  $('#c-id').addEventListener('click', () => copyText(state.selected, 'Container ID copied'));

  $$('.c-actions [data-action]').forEach((b) => b.addEventListener('click', () => runAction(b.dataset.action)));

  // logs toolbar
  $('#logs-levels').checked = prefs.get('logLevels');
  $('#logs-reload').addEventListener('click', startLogs);
  $('#logs-tail').addEventListener('change', startLogs);
  $('#logs-since').addEventListener('change', startLogs);
  $('#logs-ts').addEventListener('change', startLogs);
  $('#logs-levels').addEventListener('change', (e) => {
    prefs.set('logLevels', e.target.checked);
    startLogs();
  });
  $('#logs-clear').addEventListener('click', () => logs.view?.term.clear());
  $('#logs-download').addEventListener('click', () => {
    const name = $('#c-name').textContent;
    download({ what: 'logs', id: state.selected, name }, { name: `${name}.log` });
  });
  const searchOpts = { decorations: { matchOverviewRuler: '#f5b84a', activeMatchColorOverviewRuler: '#6f8bff', matchBackground: '#5a4a1a', activeMatchBackground: '#3b55c9' } };
  $('#logs-search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !logs.view?.search) return;
    const q = e.target.value;
    if (e.shiftKey) logs.view.search.findPrevious(q, searchOpts);
    else logs.view.search.findNext(q, searchOpts);
  });
  $('#logs-search').addEventListener('input', (e) => {
    if (!logs.view?.search) return;
    if (e.target.value) logs.view.search.findNext(e.target.value, { ...searchOpts, incremental: true });
    else logs.view.search.clearDecorations();
  });

  // terminal tab
  $('#term-new').addEventListener('click', () => {
    if (currentState() !== 'running') return toast("The container isn't running. Start it to open a shell.", 'warn');
    const tt = containerTabs(state.selected);
    ensureTerm();
    if (tt.size) tt.add(); // ensureTerm opens the first one itself
  });

  $('#top-refresh').addEventListener('click', loadTop);
  $('#env-filter').addEventListener('input', renderEnv);
  $('#env-reveal').addEventListener('change', renderEnv);
  $('#env').addEventListener('click', (e) => {
    if (e.target.classList.contains('masked')) {
      $('#env-reveal').checked = true;
      renderEnv();
    }
  });
  $('#inspect-copy').addEventListener('click', () => copyText(JSON.stringify(inspect, null, 2), 'Copied inspect JSON'));
}

// ------------------------------------------------------------------ container list

export async function loadContainers(silent = false) {
  const btn = $('#refresh-btn');
  btn.classList.add('spin');
  try {
    state.containers = await rpc('containers');
    detectChanges(state.containers);
    renderList();
    $('#refresh-note').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    emit('containers-updated');
    if (state.selected && state.view === 'container') {
      if (containerById(state.selected)) renderHeader();
      else {
        toast('The selected container no longer exists', 'warn');
        forgetContainer(state.selected);
        emit('show-host');
      }
    }
  } catch (err) {
    if (!silent) $('#container-list').innerHTML = `<div class="list-msg">Couldn't list containers:<br>${esc(err.message)}</div>`;
  } finally {
    btn.classList.remove('spin');
  }
}

export const projectOf = (c) => (/(?:^|,)com\.docker\.compose\.project=([^,]*)/.exec(c.Labels || '') || [])[1] || '';
const healthOf = (c) => (/\((healthy|unhealthy|health: starting)\)/.exec(c.Status || '') || [])[1] || null;
const isStopped = (c) => ['exited', 'created', 'dead'].includes(c.State);

/** Alert when containers stop, start restarting or become unhealthy on their own. */
function detectChanges(list) {
  const snap = new Map(list.map((c) => [c.ID, { state: c.State, health: healthOf(c), name: firstName(c.Names), status: c.Status }]));
  if (prevSnapshot) {
    for (const [id, cur] of snap) {
      const p = prevSnapshot.get(id);
      if (!p || (recentActions.get(id) || 0) > Date.now() - 90000) continue;
      let title = null;
      if (p.state === 'running' && (cur.state === 'exited' || cur.state === 'dead')) title = `${cur.name} stopped`;
      else if (p.state !== 'restarting' && cur.state === 'restarting') title = `${cur.name} is restarting`;
      else if (p.health !== 'unhealthy' && cur.health === 'unhealthy') title = `${cur.name} is unhealthy`;
      else if (p.health === 'unhealthy' && cur.health === 'healthy') title = `${cur.name} is healthy again`;
      if (title) {
        const ok = title.endsWith('healthy again');
        toast(`${title} · ${cur.status}`, ok ? 'success' : 'warn');
        notify(title, `${cur.status}\n${state.info?.label || state.info?.host || ''}`);
      }
    }
  }
  prevSnapshot = snap;
  const troubled = list.filter((c) => healthOf(c) === 'unhealthy' || c.State === 'restarting' || c.State === 'dead').length;
  desktop?.setBadge(troubled);
}

export function renderList() {
  const q = $('#filter').value.trim().toLowerCase();
  const all = state.containers;
  const running = all.filter((c) => c.State === 'running').length;
  $('#cnt-all').textContent = all.length;
  $('#cnt-running').textContent = running;
  $('#cnt-stopped').textContent = all.length - running;

  const info = state.info || {};
  const hostItem = `<button class="c-item host-item${state.view === 'host' ? ' active' : ''}" data-host="1">
      <span class="c-avatar host" style="${tileStyle(info.profileKey)}">${icon('server')}</span>
      <span class="c-item-body"><div class="c-item-name"><span>${esc(info.label || info.hostname || info.host || 'Host')}</span></div>
      <div class="c-item-sub">Overview · images · volumes · terminal</div></span></button>`;

  const list = all
    .filter((c) => stateFilter === 'all' || (stateFilter === 'running' ? c.State === 'running' : c.State !== 'running'))
    .filter((c) => !q || [c.Names, c.Image, c.Status, c.State, c.ID, projectOf(c), dbEngineOf(c.Image) || ''].join(' ').toLowerCase().includes(q))
    .sort((a, b) => (b.State === 'running') - (a.State === 'running') || firstName(a.Names).localeCompare(firstName(b.Names)));

  if (!list.length) {
    const empty = all.length
      ? 'No containers match.'
      : state.info?.dockerError
        ? 'Docker isn\'t accessible yet. See the fix on the host page.'
        : 'No containers on this host.';
    $('#container-list').innerHTML = hostItem + `<div class="list-msg">${empty}</div>`;
    return;
  }

  const groups = new Map();
  for (const c of list) {
    const g = projectOf(c);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
  const showGroups = keys.length > 1 || keys[0] !== '';

  $('#container-list').innerHTML =
    hostItem +
    keys
      .map((k) => {
        const items = groups.get(k);
        const isCollapsed = showGroups && collapsed.has(k) && !q;
        const up = items.filter((c) => c.State === 'running').length;
        const head = showGroups
          ? `<div class="group-label${isCollapsed ? ' collapsed' : ''}" data-group="${esc(k)}">
              ${icon('chevronDown', 'chev')}<span class="g-name" title="${esc(k || 'Standalone')}">${esc(k || 'Standalone')}</span>
              <span class="g-tail${k ? ' has-actions' : ''}">
                <span class="g-count">${up}/${items.length}</span>
                ${k ? `<span class="g-actions">
                  <button class="icon-btn" data-gact="start" title="Start all stopped">${icon('play')}</button>
                  <button class="icon-btn" data-gact="restart" title="Restart all">${icon('restart')}</button>
                  <button class="icon-btn" data-gact="stop" title="Stop all">${icon('stop')}</button>
                </span>` : ''}
              </span>
            </div>`
          : '';
        if (isCollapsed) return head;
        return (
          head +
          items
            .map((c) => {
              const eng = dbEngineOf(c.Image);
              const health = healthOf(c);
              return `
            <button class="c-item${c.ID === state.selected && state.view === 'container' ? ' active' : ''}" data-id="${esc(c.ID)}" title="${esc(firstName(c.Names))}">
              <span class="dot st-${esc(c.State)}${health === 'unhealthy' ? ' unhealthy' : ''}"></span>
              <span class="c-item-body">
                <div class="c-item-name"><span>${esc(firstName(c.Names))}</span>${eng ? dbBadge(c.Image) : ''}</div>
                <div class="c-item-sub">${esc(c.Image)}</div>
                <div class="c-item-sub${health === 'unhealthy' ? ' st-dead' : ''}">${esc(c.Status)}</div>
              </span>
            </button>`;
            })
            .join('')
        );
      })
      .join('');
}

async function onListClick(e) {
  if (e.target.closest('[data-host]')) return emit('show-host');
  const gact = e.target.closest('[data-gact]');
  const group = e.target.closest('.group-label');
  if (gact && group) return groupAction(group.dataset.group, gact.dataset.gact);
  if (group) {
    const k = group.dataset.group;
    collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k);
    storage.set('sdc.collapsed', [...collapsed]);
    return renderList();
  }
  const item = e.target.closest('.c-item[data-id]');
  if (item) emit('select-container', item.dataset.id);
}

async function groupAction(project, action) {
  const members = state.containers.filter((c) => projectOf(c) === project);
  const targets = members.filter((c) => (action === 'start' ? isStopped(c) : c.State === 'running' || (action === 'restart' && c.State !== 'paused')));
  if (!targets.length) return toast(action === 'start' ? 'Everything in this project is already running' : 'Nothing to do in this project', 'info');
  const info = ACTION_INFO[action];
  const ok = await confirmDialog({
    tone: action === 'start' ? 'primary' : 'warn',
    icon: info.icon,
    title: `${info.label} ${targets.length} container${targets.length === 1 ? '' : 's'} in "${project}"?`,
    message: info.message || '',
    detail: targets.map((c) => firstName(c.Names)).join('\n'),
    confirmLabel: `${info.label} ${targets.length}`,
  });
  if (!ok) return;
  for (const c of targets) recentActions.set(c.ID, Date.now());
  toast(`${info.label}ing ${targets.length} containers…`);
  try {
    await rpc('actionMany', { ids: targets.map((c) => c.ID), action });
    toast(`${project}: ${info.label.toLowerCase()} done`, 'success');
  } catch (err) {
    toast(`${info.label} failed: ${err.message}`, true);
  }
  await loadContainers(true);
  if (state.selected && targets.some((c) => c.ID === state.selected)) loadInspect();
}

// ------------------------------------------------------------------ selecting

export async function selectContainer(id, tab) {
  const same = state.selected === id && inspect?.Id === id;
  state.selected = id;
  if (!same) {
    inspect = null;
    statsHistory = { samples: [], prev: null };
    destroyCharts();
    $('#stats').dataset.for = '';
    $('#stats').innerHTML = '';
    stopLogs();
    logs.view?.term.reset();
    $('#logs-status').textContent = '';
    $('#processes').innerHTML = '';
    $('#overview').innerHTML = msg('Loading…');
  }
  for (const [cid, t] of terms) if (cid !== id) t.show(false); // ensureTerm shows the selected one's
  for (const [cid, p] of filePanels) p.show(cid === id && ctl.current === 'files');
  for (const [cid, p] of dbPanels) p.show(cid === id);

  const c = containerById(id);
  $('#c-tabs [data-tab=database]').hidden = !dbEngineOf(c?.Image);
  $('#c-tabs [data-tab=database]').dataset.eng = dbFlavorOf(c?.Image) || '';
  let want = tab || ctl.current || 'overview';
  if (want === 'database' && !dbEngineOf(c?.Image)) want = 'overview';
  renderHeader();
  ctl.show(want);
  if (!same) await loadInspect();
}

export function leaveContainer() {
  statsLoop++;
  for (const t of terms.values()) t.show(false);
}

export const currentTab = () => ctl.current;
export const openTab = (name) => ctl.show(name);

/** ⌘R / F5: reload what the current container tab shows, without leaving it. */
export function refreshContainer() {
  if (!state.selected) return;
  switch (ctl.current) {
    case 'files': return filePanels.get(state.selected)?.refresh();
    case 'logs': return startLogs();
    case 'processes': return loadTop();
    case 'terminal':
    case 'database':
    case 'stats':
      return;
    default:
      return loadInspect();
  }
}

async function loadInspect() {
  const id = state.selected;
  try {
    const data = await rpc('inspect', { id });
    if (id !== state.selected) return;
    inspect = data;
    renderHeader();
    renderTab();
  } catch (err) {
    if (id === state.selected) $('#overview').innerHTML = errorBox(err.message);
  }
}

const currentState = () => inspect?.State?.Status || containerById(state.selected)?.State || 'unknown';

/** Actions that make sense for the selected container right now. */
export function availableActions() {
  const st = currentState();
  return Object.entries({
    start: ['exited', 'created', 'dead'].includes(st),
    unpause: st === 'paused',
    restart: st === 'running' || st === 'exited',
    pause: st === 'running',
    stop: st === 'running' || st === 'restarting',
    remove: ['exited', 'created', 'dead'].includes(st),
  })
    .filter(([, v]) => v)
    .map(([k]) => ({ action: k, ...ACTION_INFO[k] }));
}

function parsePorts(ports) {
  const seen = new Set();
  const out = [];
  for (const part of String(ports || '').split(',')) {
    const m = /(?:([\d.]+|\[[^\]]*\]):)?(\d+)->(\d+)\/(tcp|udp)/.exec(part.trim());
    if (!m) continue;
    const [, ip = '0.0.0.0', hostPort, ctrPort, proto] = m;
    if (seen.has(`${hostPort}/${proto}`)) continue;
    seen.add(`${hostPort}/${proto}`);
    out.push({ ip, hostPort, ctrPort, proto, local: /^(127\.|\[::1\])/.test(ip) });
  }
  return out;
}

function renderHeader() {
  const c = containerById(state.selected);
  const st = currentState();
  const health = inspect?.State?.Health?.Status;
  const eng = dbEngineOf(inspect?.Config?.Image || c?.Image);
  $('#c-name').textContent = inspect ? inspect.Name.replace(/^\//, '') : firstName(c?.Names);
  $('#c-avatar').className = `c-avatar${eng ? ` is-db eng-${dbFlavorOf(inspect?.Config?.Image || c?.Image)}` : ''}${st !== 'running' ? ' stopped' : ''}`;
  $('#c-avatar').innerHTML = icon(eng ? 'database' : 'box');
  $('#c-state').className = `badge st-${st}${health === 'unhealthy' ? ' unhealthy' : ''}`;
  $('#c-state').textContent = health ? `${st} · ${health}` : st;
  $('#c-image').innerHTML = `${icon('image')} ${esc(inspect?.Config?.Image || c?.Image || '')}`;
  $('#c-id').textContent = shortId(state.selected);
  $('#c-status').textContent = c?.Status || '';

  const host = state.info?.host || 'localhost';
  $('#c-ports').innerHTML = parsePorts(c?.Ports)
    .map((p) => {
      const label = `${p.hostPort} → ${p.ctrPort}/${p.proto}`;
      if (p.proto !== 'tcp' || p.local) {
        return `<span class="chip" title="${p.local ? 'Bound to localhost on the server' : 'UDP'}">${esc(label)}</span>`;
      }
      const scheme = /^(443|8443)$/.test(p.hostPort) ? 'https' : 'http';
      return `<a class="chip" href="${scheme}://${esc(host)}:${esc(p.hostPort)}" target="_blank" rel="noopener" title="Open ${scheme}://${esc(host)}:${esc(p.hostPort)}">${icon('external')}${esc(label)}</a>`;
    })
    .join('');

  const allowed = new Set(availableActions().map((a) => a.action));
  $$('.c-actions [data-action]').forEach((b) => (b.hidden = !allowed.has(b.dataset.action)));
}

/** Run a container action. Stop / restart / pause / remove always ask first. */
export async function runAction(action) {
  const id = state.selected;
  const info = ACTION_INFO[action];
  if (!id || !info) return;
  const name = $('#c-name').textContent;
  // Every action is confirmed: start / resume with a click, the disruptive ones with a hold.
  const c = containerById(id);
  const ok = await confirmDialog({
    tone: info.tone || 'primary',
    icon: info.icon,
    title: `${info.label} "${name}"?`,
    message: info.message || (action === 'start' ? 'The container starts with its saved configuration.' : action === 'unpause' ? 'Its frozen processes continue where they stopped.' : ''),
    facts: [
      ['Container', `${name} · ${shortId(id)}`],
      c?.Image ? ['Image', c.Image] : null,
      c?.Status ? ['Now', c.Status] : null,
      state.info ? ['Server', `${state.info.username}@${state.info.host}`] : null,
    ],
    confirmLabel: info.label,
  });
  if (!ok) return;
  recentActions.set(id, Date.now());
  $$('.c-actions button').forEach((x) => (x.disabled = true));
  toast(`${info.label}: ${name}…`);
  try {
    await rpc('action', { id, action });
    toast(`${info.label}: ${name} done`, 'success');
  } catch (err) {
    toast(`${info.label} failed: ${err.message}`, true);
  } finally {
    $$('.c-actions button').forEach((x) => (x.disabled = false));
    if (action === 'remove') forgetContainer(id);
    await loadContainers(true);
    if (id === state.selected && action !== 'remove') {
      await loadInspect();
      if (ctl.current === 'logs' && !logs.token) startLogs();
    }
    if (action === 'remove') emit('show-host');
  }
}

export function forgetContainer(id) {
  terms.get(id)?.destroy();
  terms.delete(id);
  filePanels.get(id)?.destroy();
  filePanels.delete(id);
  dbPanels.get(id)?.destroy();
  dbPanels.delete(id);
  if (state.selected === id) state.selected = null;
}

export function resetContainers() {
  statsLoop++;
  stopLogs();
  for (const id of [...new Set([...terms.keys(), ...filePanels.keys(), ...dbPanels.keys()])]) forgetContainer(id);
  logs.view?.dispose();
  logs.view = null;
  inspect = null;
  prevSnapshot = null;
  desktop?.setBadge(0);
  state.selected = null;
  state.containers = [];
  $('#container-list').innerHTML = '';
}

// ------------------------------------------------------------------ tabs

function onTab(name) {
  if (name !== 'stats') statsLoop++;
  for (const [cid, p] of filePanels) p.show(name === 'files' && cid === state.selected);
  renderTab();
  const c = containerById(state.selected);
  if (c) emit('nav', { view: 'container', name: firstName(c.Names), tab: name });
}

function renderTab() {
  if (!state.selected || state.view !== 'container') return;
  switch (ctl.current) {
    case 'overview': return renderOverview();
    case 'logs':
      ensureLogsView();
      requestAnimationFrame(logs.view.doFit);
      if (logs.containerId !== state.selected) startLogs();
      return;
    case 'terminal': return ensureTerm();
    case 'files': return ensureFiles();
    case 'database': return ensureDb();
    case 'stats': return startStats();
    case 'processes': return loadTop();
    case 'env': return renderEnv();
    case 'inspect':
      if (inspect) $('#inspect-json').innerHTML = highlightJson(inspect);
  }
}

// ---- overview
function renderOverview() {
  const i = inspect;
  if (!i) return;
  const S = i.State || {};
  const C = i.Config || {};
  const H = i.HostConfig || {};
  const N = i.NetworkSettings || {};

  const general = kv([
    ['Name', esc(i.Name.replace(/^\//, ''))],
    ['Container ID', esc(i.Id), true],
    ['Image', esc(C.Image)],
    ['Image ID', esc(shortId(i.Image)), true],
    ['Created', esc(fmtDate(i.Created))],
    ['Command', esc(cmdStr([i.Path, ...(i.Args || [])])), true],
    ['Entrypoint', esc(cmdStr(C.Entrypoint)), true],
    ['Working dir', esc(C.WorkingDir), true],
    ['User', esc(C.User)],
    ['Hostname', esc(C.Hostname)],
    ['Platform', esc(i.Platform)],
    ['Restart policy', esc(H.RestartPolicy?.Name ? `${H.RestartPolicy.Name}${H.RestartPolicy.MaximumRetryCount ? ` (max ${H.RestartPolicy.MaximumRetryCount})` : ''}` : '')],
    ['Restart count', esc(i.RestartCount)],
    ['Log driver', esc(H.LogConfig?.Type)],
    ['Network mode', esc(H.NetworkMode)],
    ['Privileged', H.Privileged ? '<span class="st-dead">yes</span>' : ''],
  ]);

  const health = S.Health;
  const lastLog = health?.Log?.[health.Log.length - 1];
  const stateCard =
    kv([
      ['Status', `<span class="st-${esc(S.Status)}">${esc(S.Status)}</span>`],
      ['Health', health ? `<span class="health-${esc(health.Status)}">${esc(health.Status)}</span>${health.FailingStreak ? ` · ${esc(health.FailingStreak)} failing` : ''}` : ''],
      ['PID', S.Pid ? esc(S.Pid) : ''],
      ['Started', esc(fmtDate(S.StartedAt))],
      ['Finished', S.Running ? '' : esc(fmtDate(S.FinishedAt))],
      ['Exit code', S.Running ? '' : esc(S.ExitCode)],
      ['OOM killed', S.OOMKilled ? '<span class="st-dead">yes</span>' : ''],
      ['Error', esc(S.Error)],
    ]) + (lastLog ? `<pre class="health-log">Last health check (exit ${esc(lastLog.ExitCode)}):\n${esc(lastLog.Output)}</pre>` : '');

  const ports = [];
  for (const [cport, binds] of Object.entries(N.Ports || {})) {
    if (!binds || !binds.length) ports.push([`<span class="mono">${esc(cport)}</span>`, '<span class="muted">not published</span>']);
    else for (const b of binds) ports.push([`<span class="mono">${esc(cport)}</span>`, `<span class="mono">${esc(b.HostIp || '0.0.0.0')}:${esc(b.HostPort)}</span>`]);
  }
  const nets = Object.entries(N.Networks || {}).map(([name, n]) => [
    esc(name),
    `<span class="mono">${esc(n.IPAddress || '—')}${n.IPPrefixLen ? '/' + esc(n.IPPrefixLen) : ''}</span>`,
    `<span class="mono">${esc(n.Gateway || '—')}</span>`,
    `<span class="mono">${esc(n.MacAddress || '—')}</span>`,
    esc((n.Aliases || []).join(', ')),
  ]);
  const mounts = (i.Mounts || []).map((m) => [
    esc(m.Type),
    `<span class="mono">${esc(m.Name || m.Source)}</span>`,
    `<span class="mono">${esc(m.Destination)}</span>`,
    m.RW ? 'rw' : '<span class="st-paused">ro</span>',
  ]);
  const resources = kv([
    ['Memory limit', H.Memory ? esc(fmtBytes(H.Memory)) : 'unlimited'],
    ['Memory reservation', H.MemoryReservation ? esc(fmtBytes(H.MemoryReservation)) : ''],
    ['CPUs', H.NanoCpus ? esc(H.NanoCpus / 1e9) : H.CpuQuota > 0 ? esc((H.CpuQuota / (H.CpuPeriod || 100000)).toFixed(2)) : 'unlimited'],
    ['CPU shares', H.CpuShares ? esc(H.CpuShares) : ''],
    ['CPU set', esc(H.CpusetCpus)],
    ['PIDs limit', H.PidsLimit > 0 ? esc(H.PidsLimit) : ''],
    ['Shm size', H.ShmSize ? esc(fmtBytes(H.ShmSize)) : ''],
    ['Capabilities added', esc((H.CapAdd || []).join(', '))],
  ]);
  const labels = Object.entries(C.Labels || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [`<span class="mono">${esc(k)}</span>`, `<span class="mono">${esc(v)}</span>`]);

  const ov = $('#overview');
  ov.classList.toggle('settled', ov.dataset.for === i.Id);
  ov.dataset.for = i.Id;
  const eng = dbEngineOf(C.Image);
  const dbHint = eng
    ? `<div class="alert info inset">${icon('database')}<span>This is a ${dbBadge(C.Image)} database. Credentials are detected from its environment.</span><button class="btn small primary" id="goto-db">Open database console</button></div>`
    : '';

  $('#overview').innerHTML = `${dbHint}<div class="cards">
    ${card(`${icon('info')} General`, general)}
    ${card(`${icon('activity')} State`, stateCard)}
    ${card(`${icon('link')} Ports`, table(['Container', 'Host'], ports))}
    ${card(`${icon('cpu')} Resources`, resources)}
    ${card(`${icon('network')} Networks`, table(['Network', 'IP', 'Gateway', 'MAC', 'Aliases'], nets), 'full')}
    ${card(`${icon('drive')} Mounts &amp; volumes`, table(['Type', 'Source', 'Destination', 'Mode'], mounts), 'full')}
    ${card(`${icon('logs')} Labels (${labels.length})`, table(['Key', 'Value'], labels), 'full')}
  </div>`;
  $('#goto-db')?.addEventListener('click', () => ctl.show('database'));
}

// ---- environment
function renderEnv() {
  if (!inspect) return;
  const q = $('#env-filter').value.trim().toLowerCase();
  const reveal = $('#env-reveal').checked;
  const rows = (inspect.Config?.Env || [])
    .map((e) => {
      const idx = e.indexOf('=');
      return idx < 0 ? [e, ''] : [e.slice(0, idx), e.slice(idx + 1)];
    })
    .filter(([k, v]) => !q || k.toLowerCase().includes(q) || (reveal && v.toLowerCase().includes(q)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [
      `<span class="mono">${esc(k)}</span>`,
      reveal ? `<span class="mono">${esc(v)}</span>` : `<span class="masked" title="Click to reveal">••••••••</span>`,
    ]);
  $('#env').innerHTML = `<div class="cards" style="padding-top:0"><section class="card full">${table(['Variable', 'Value'], rows)}</section></div>`;
}

// ---- inspect
function highlightJson(obj) {
  return esc(JSON.stringify(obj, null, 2)).replace(
    /(&quot;(?:\\.|[^&\\]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (m, str, colon, bool) => {
      if (str) return colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`;
      if (bool) return `<span class="b">${m}</span>`;
      if (m === 'null') return `<span class="z">${m}</span>`;
      return `<span class="n">${m}</span>`;
    },
  );
}

// ---- processes
async function loadTop() {
  const id = state.selected;
  const el = $('#processes');
  if (!['running', 'paused'].includes(currentState())) {
    el.innerHTML = msg("The container isn't running.");
    return;
  }
  if (!el.innerHTML) el.innerHTML = msg('Loading…');
  try {
    const { titles, processes } = await rpc('top', { id });
    if (id !== state.selected) return;
    el.innerHTML = `<div class="cards" style="padding-top:0"><section class="card full"><h3>${processes.length} processes</h3>${table(
      titles,
      processes.map((p) => p.map((v, idx) => (idx === p.length - 1 ? `<span class="mono">${esc(v)}</span>` : esc(v)))),
    )}</section></div>`;
  } catch (err) {
    if (id === state.selected) el.innerHTML = errorBox(err.message);
  }
}

// ---- stats
const parsePct = (s) => parseFloat(String(s || '').replace('%', '')) || 0;
const UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5 };
/** "1.5MB" / "12.3MiB" / "0B" → bytes. */
function parseSize(str) {
  const m = /([\d.]+)\s*([a-z]*)/i.exec(String(str || ''));
  if (!m) return 0;
  return parseFloat(m[1]) * (UNITS[m[2].toLowerCase()] || 1);
}
const fmtRate = (v) => `${fmtBytes(v)}/s`;
const fmtPct = (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;

function destroyCharts() {
  if (!charts) return;
  for (const c of Object.values(charts)) c.destroy();
  charts = null;
}

function buildStats(el, id) {
  destroyCharts();
  el.dataset.for = id;
  el.innerHTML = `
    <div class="stat-grid charts">
      <div class="stat chart-card"><div class="stat-label">${icon('cpu')} CPU</div>
        <div class="stat-row"><div class="stat-value" data-k="cpu">—</div><div class="stat-sub">100% = one full core</div></div>
        <div class="chart-mount" data-chart="cpu"></div></div>
      <div class="stat chart-card"><div class="stat-label">${icon('layers')} Memory</div>
        <div class="stat-row"><div class="stat-value" data-k="mem">—</div><div class="stat-sub" data-k="memSub"></div></div>
        ${bar(0)}<div class="chart-mount" data-chart="mem"></div></div>
      <div class="stat chart-card"><div class="stat-label">${icon('network')} Network</div>
        <div class="stat-row"><div class="stat-value sm" data-k="net">—</div><div class="stat-sub" data-k="netSub"></div></div>
        <div class="chart-mount" data-chart="net"></div></div>
      <div class="stat chart-card"><div class="stat-label">${icon('drive')} Disk I/O</div>
        <div class="stat-row"><div class="stat-value sm" data-k="blk">—</div><div class="stat-sub" data-k="blkSub"></div></div>
        <div class="chart-mount" data-chart="blk"></div></div>
      <div class="stat chart-card"><div class="stat-label">${icon('activity')} Processes</div>
        <div class="stat-row"><div class="stat-value" data-k="pids">—</div><div class="stat-sub">PIDs in the container</div></div>
        <div class="chart-mount" data-chart="pids"></div></div>
    </div>
    <div class="muted tiny inset-note" data-k="note">Sampling… the first values arrive in a couple of seconds.</div>`;
  const mount = (k) => el.querySelector(`[data-chart="${k}"]`);
  charts = {
    cpu: new LiveChart(mount('cpu'), { series: [{ key: 'cpu', label: 'CPU', color: 'var(--blue)' }], format: fmtPct, floor: 2 }),
    mem: new LiveChart(mount('mem'), { series: [{ key: 'mem', label: 'Memory', color: 'var(--green)' }], format: fmtPct, floor: 5 }),
    net: new LiveChart(mount('net'), {
      series: [{ key: 'rx', label: 'Received', color: 'var(--cyan)' }, { key: 'tx', label: 'Sent', color: 'var(--orange)' }],
      format: fmtRate,
      floor: 1024,
    }),
    blk: new LiveChart(mount('blk'), {
      series: [{ key: 'br', label: 'Read', color: 'var(--blue)' }, { key: 'bw', label: 'Written', color: 'var(--yellow)' }],
      format: fmtRate,
      floor: 1024,
    }),
    pids: new LiveChart(mount('pids'), { series: [{ key: 'pids', label: 'PIDs', color: 'var(--text-2)' }], format: (v) => String(Math.round(v)), floor: 5, height: 80 }),
  };
  // Reopening the tab: the history so far draws in at once.
  if (statsHistory.samples.length) {
    for (const [k, c] of Object.entries(charts)) c.load(statsHistory.samples.map((smp) => pick(smp, k)));
    paintStats(el, statsHistory.samples[statsHistory.samples.length - 1], true);
  }
}

const CHART_KEYS = { cpu: ['cpu'], mem: ['mem'], net: ['rx', 'tx'], blk: ['br', 'bw'], pids: ['pids'] };
function pick(smp, chart) {
  const o = {};
  for (const k of CHART_KEYS[chart]) o[k] = smp[k];
  return o;
}

function paintStats(el, smp, instant = false) {
  const put = (k, v) => {
    const n = el.querySelector(`[data-k="${k}"]`);
    if (n && n.textContent !== v) n.textContent = v;
  };
  const num = (k, v, f) => {
    const n = el.querySelector(`[data-k="${k}"]`);
    if (!n) return;
    if (instant) n._tv = v;
    tween(n, v, f, 700);
  };
  num('cpu', smp.cpu, fmtPct);
  num('mem', smp.mem, fmtPct);
  put('memSub', `${smp.memUsed} of ${smp.memLimit}`);
  put('net', `↓ ${fmtRate(smp.rx)}  ↑ ${fmtRate(smp.tx)}`);
  put('netSub', `${smp.netIn} received · ${smp.netOut} sent in total`);
  put('blk', `R ${fmtRate(smp.br)}  W ${fmtRate(smp.bw)}`);
  put('blkSub', `${smp.blkIn} read · ${smp.blkOut} written in total`);
  num('pids', smp.pids, (v) => String(Math.round(v)));
  const fill = el.querySelector('.chart-card .bar > i');
  if (fill) {
    fill.style.width = `${Math.min(smp.mem, 100).toFixed(1)}%`;
    fill.className = smp.mem >= 90 ? 'crit' : smp.mem >= 80 ? 'warn' : '';
  }
  put('note', `Live · one sample every ~2–3 seconds · last ${statsHistory.samples.length} samples kept · hover a chart for exact values`);
}

async function startStats() {
  const loop = ++statsLoop;
  const id = state.selected;
  const el = $('#stats');
  if (currentState() !== 'running') {
    destroyCharts();
    el.dataset.for = '';
    el.innerHTML = msg('Live stats are only available while the container is running.');
    return;
  }
  if (el.dataset.for !== id || !charts) {
    if (!statsHistory.samples.length) el.innerHTML = skeletonStats(5, true);
    // Build after a frame so the panel has its size (charts measure themselves).
    await new Promise((r) => requestAnimationFrame(r));
    if (loop !== statsLoop || id !== state.selected) return;
    buildStats(el, id);
  }
  while (loop === statsLoop && id === state.selected && state.connected && !document.hidden) {
    try {
      const s = await rpc('stats', { id });
      if (loop !== statsLoop || id !== state.selected) return;
      const now = performance.now();
      const [memUsed, memLimit] = String(s.MemUsage || '').split('/').map((x) => x.trim());
      const [netIn, netOut] = String(s.NetIO || '').split('/').map((x) => x.trim());
      const [blkIn, blkOut] = String(s.BlockIO || '').split('/').map((x) => x.trim());
      const raw = { t: now, rx: parseSize(netIn), tx: parseSize(netOut), br: parseSize(blkIn), bw: parseSize(blkOut) };
      const prev = statsHistory.prev;
      const dt = prev ? (now - prev.t) / 1000 : 0;
      const rate = (k) => (prev && dt > 0 ? Math.max(0, (raw[k] - prev[k]) / dt) : 0);
      statsHistory.prev = raw;
      const smp = {
        cpu: parsePct(s.CPUPerc),
        mem: parsePct(s.MemPerc),
        rx: rate('rx'),
        tx: rate('tx'),
        br: rate('br'),
        bw: rate('bw'),
        pids: parseInt(s.PIDs, 10) || 0,
        memUsed, memLimit, netIn, netOut, blkIn, blkOut,
      };
      statsHistory.samples.push(smp);
      if (statsHistory.samples.length > 61) statsHistory.samples.shift();
      if (!charts || el.dataset.for !== id) buildStats(el, id);
      for (const [k, c] of Object.entries(charts)) c.push(pick(smp, k));
      paintStats(el, smp);
    } catch (err) {
      if (loop === statsLoop) {
        destroyCharts();
        el.dataset.for = '';
        el.innerHTML = errorBox(err.message);
      }
      return;
    }
    await sleep(2000);
  }
}

export function resumeStats() {
  if (state.view === 'container' && ctl.current === 'stats') startStats();
}

// ---- logs
function ensureLogsView() {
  if (!logs.view) logs.view = makeXterm($('#logs-mount'), { disableStdin: true, cursorBlink: false, convertEol: true, scrollback: 100000 });
  return logs.view;
}

function startLogs() {
  if (!state.selected) return;
  const v = ensureLogsView();
  v.term.reset();
  resetLogBuffer();
  logs.token = uid('l');
  logs.containerId = state.selected;
  $('#logs-status').textContent = 'Streaming…';
  send({
    type: 'logs:start',
    token: logs.token,
    id: state.selected,
    tail: $('#logs-tail').value,
    since: $('#logs-since').value,
    timestamps: $('#logs-ts').checked,
  });
  requestAnimationFrame(v.doFit);
}

function stopLogs() {
  if (logs.token) send({ type: 'logs:stop' });
  resetLogBuffer();
  logs.token = null;
  logs.containerId = null;
}

// Colour log levels and dim docker timestamps (only for output that has no colours of its own).
const LEVELS = [
  [/\b(ERROR|ERR|FATAL|CRITICAL|CRIT|PANIC|EMERG|ALERT|error|fatal|panic|critical|Error|Exception|Traceback)\b/g, '\x1b[1;31m'],
  [/\b(WARN|WARNING|warn|warning|Warning)\b/g, '\x1b[1;33m'],
  [/\b(INFO|NOTICE|info)\b/g, '\x1b[36m'],
  [/\b(DEBUG|TRACE|debug|trace)\b/g, '\x1b[90m'],
];
function colorizeLine(line) {
  if (line.includes('\x1b[')) return line;
  let out = line.replace(/^(\d{4}-\d\d-\d\dT[\d:.]+Z) /, '\x1b[90m$1\x1b[0m ');
  for (const [re, code] of LEVELS) out = out.replace(re, `${code}$1\x1b[0m`);
  return out;
}

// Logs are history, not a screen: drop sequences that clear the screen or scrollback, move the
// cursor or switch to the alternate screen (dev servers, progress bars, TUIs). Keep colours (m)
// and erase-in-line (K), which only touch the current line.
const SCREEN_CTL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[78cDEHMNO=>]/g;
const sanitize = (s) => s.replace(SCREEN_CTL, (seq) => (seq[1] === '[' && /[mK]$/.test(seq) ? seq : ''));

// Docker output arrives in arbitrary chunks that split lines (and escape sequences). Work on whole
// lines; a trailing partial line is held back briefly and flushed if nothing else arrives.
let carry = '';
let carryTimer = 0;
function resetLogBuffer() {
  clearTimeout(carryTimer);
  carry = '';
}
function emitLogs(text) {
  let out = sanitize(text);
  if ($('#logs-levels').checked) out = out.split('\n').map(colorizeLine).join('\n');
  logs.view?.term.write(out);
}
function writeLogs(data) {
  clearTimeout(carryTimer);
  const text = carry + data;
  const cut = text.lastIndexOf('\n') + 1;
  carry = text.slice(cut);
  if (cut) emitLogs(text.slice(0, cut));
  if (carry) {
    const token = logs.token;
    carryTimer = setTimeout(() => {
      if (logs.token !== token) return;
      const rest = carry;
      carry = '';
      emitLogs(rest);
    }, 150);
  }
}

onStream('logs:data', (m) => {
  if (m.token === logs.token) writeLogs(m.data);
});
onStream('logs:end', (m) => {
  if (m.token !== logs.token) return;
  if (carry) emitLogs(carry);
  resetLogBuffer();
  $('#logs-status').textContent = m.error
    ? `Error: ${m.error}`
    : m.code
      ? `docker logs failed (exit ${m.code}), see the output`
      : 'Stream ended (container stopped?)';
  logs.token = null;
});

// ---- container terminal
/** The terminal tabs of one container (created on first use). */
function containerTabs(id) {
  let tt = terms.get(id);
  if (!tt) {
    const name = firstName(containerById(id)?.Names) || shortId(id);
    tt = new TermTabs($('#c-term-mount'), {
      spec: () => ({ kind: 'container', id, shell: $('#shell-select').value }),
      label: `shell in ${name}`,
      canAdd: () => (id === state.selected && currentState() !== 'running' ? "The container isn't running. Start it to open a shell." : ''),
      describe: (spec) => `${spec.shell === 'auto' || !spec.shell ? 'auto shell' : spec.shell} in ${name}`,
    });
    terms.set(id, tt);
  }
  return tt;
}

function ensureTerm() {
  const id = state.selected;
  const running = currentState() === 'running';
  const has = (terms.get(id)?.size || 0) > 0;
  $('#term-not-running').hidden = running || has;
  $('#c-term-mount').hidden = !running && !has;
  for (const [cid, t] of terms) if (cid !== id) t.show(false);
  if (!running && !has) return terms.get(id)?.show(false);
  const tt = containerTabs(id);
  tt.show(true);
  if (!tt.size) tt.add();
}

/** After a reload: take over a container shell that kept running on the server (each comes back as a tab). */
export function adoptContainerTerm(meta) {
  if (!meta.id) return;
  containerTabs(meta.id).add({ spec: { kind: 'container', id: meta.id, shell: meta.shell }, adopt: meta });
}

// ---- files
function ensureFiles() {
  const id = state.selected;
  if (!filePanels.has(id)) {
    const work = inspect?.Config?.WorkingDir || '/';
    const mounts = (inspect?.Mounts || [])
      .filter((m) => m.Destination && m.Destination !== work)
      .slice(0, 8)
      .map((m) => ({ label: m.Destination.split('/').pop() || m.Destination, path: m.Destination, icon: m.Type === 'volume' ? 'drive' : 'link' }));
    const places = [
      { label: 'Working dir', path: work, icon: 'home' },
      ...(work !== '/' ? [{ label: 'Root', path: '/', icon: 'box' }] : []),
      ...mounts,
      { label: 'Temp', path: '/tmp', icon: 'clock' },
      { label: 'Config', path: '/etc', icon: 'settings' },
    ];
    const name = firstName(containerById(id)?.Names) || id;
    filePanels.set(id, new FilesPanel($('#files-mount'), {
      target: { id },
      source: name,
      startPath: work,
      places,
      stateKey: `${state.info?.profileKey || 'default'}.c.${name}`,
      onTerminal: cdInContainer,
    }));
  }
  for (const [cid, p] of filePanels) p.show(cid === id);
}

/** "Open in terminal" from the Files tab: the container shell, cd'd into the folder. */
function cdInContainer(path) {
  const id = state.selected;
  if (currentState() !== 'running') return toast("The container isn't running", 'warn');
  ctl.show('terminal');
  const cmd = `cd -- '${String(path).replace(/'/g, `'\\''`)}'\r`;
  ensureTerm();
  const shell = containerTabs(id).live();
  if (!shell) return;
  shell.type(cmd);
  toast(`Terminal: cd ${path}`);
}

// ---- database
function ensureDb() {
  const id = state.selected;
  let panel = dbPanels.get(id);
  if (!panel) {
    panel = new DbPanel($('#db-mount'), { target: 'container', id, name: firstName(containerById(id)?.Names) });
    dbPanels.set(id, panel);
  }
  for (const [cid, p] of dbPanels) p.show(cid === id);
  panel.init();
}
