// Host control: systemd services (with a live journal), processes, listening ports, saved commands,
// and a runner that streams a command's output into a dialog (also used for `docker pull`).
import {
  $, $$, esc, rpc, send, onStream, state, toast, sleep, msg, errorBox, fmtBytes, emit, storage, uid,
  copyText, firstName,
} from './core.js';
import { icon } from './icons.js';
import { confirmDialog, promptDialog, openModal, holdButton } from './ui.js';
import { makeXterm } from './terminal.js';
import { skeletonTable, skeletonStats } from './charts.js';

let showTab = () => {};
let loop = 0; // bumped to stop the processes refresh loop

export function initSystem(opts) {
  showTab = opts.showTab;
}

/** Leaving a tab: stop live refreshes. */
export function stopSystem() {
  loop++;
}

export function resetSystem() {
  loop++;
  svc = { list: [], filter: 'all', q: '', systemd: true, root: false, loaded: false };
  proc = { ...proc, data: null, q: '' };
  portState = { data: null, q: '', proto: 'all', hideLocal: false };
  for (const id of ['sys-services', 'sys-processes', 'sys-ports', 'sys-commands']) {
    const el = $(`#${id}`);
    if (el) el.innerHTML = '';
  }
}

// ------------------------------------------------------------------ sudo

/**
 * Run fn({ sudoPassword? }). When the server says sudo needs a password, ask for it and try again.
 * Rejects with err.cancelled when the user dismisses the prompt.
 */
export async function withSudo(fn) {
  let pw = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn(pw ? { sudoPassword: pw } : {});
    } catch (err) {
      const m = /^SUDO_PASSWORD\|(.*)$/.exec(err.message || '');
      if (!m) throw err;
      pw = await promptDialog({
        title: 'Administrator password',
        message: attempt
          ? 'That password did not work. Try again.'
          : `This needs sudo. Enter the sudo password for ${m[1]}. It is kept in memory for this session only.`,
        label: 'Password',
        type: 'password',
        confirmLabel: 'Continue',
      });
      if (pw == null) {
        const e = new Error('Cancelled');
        e.cancelled = true;
        throw e;
      }
    }
  }
  throw new Error('sudo did not accept the password');
}

const report = (err) => {
  if (!err.cancelled) toast(err.message, true);
};

// ------------------------------------------------------------------ streams (journal + runs)

const streams = new Map(); // token -> { data(text), end(info) }
for (const kind of ['journal', 'run']) {
  onStream(`${kind}:data`, (m) => streams.get(m.token)?.data(m.data));
  onStream(`${kind}:end`, (m) => {
    const s = streams.get(m.token);
    streams.delete(m.token);
    s?.end(m);
  });
}
function stopStream(token) {
  if (streams.delete(token)) send({ type: 'stream:stop', token });
}

const termText = (term) => {
  const b = term.buffer.active;
  const out = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  return out.join('\n').replace(/\n+$/, '\n');
};

const fmtMs = (ms) => (ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);

// ------------------------------------------------------------------ command risk

// Commands that only read. Anything else, or anything that can't be told apart (command
// substitution, xargs, redirection into a file, sudo), is confirmed before it runs.
const READ_ONLY = new Set(('ls ll la cat tac less more head tail grep egrep fgrep rg find locate df du free uptime uname whoami id groups ' +
  'date ps pgrep pstree top htop ss netstat ping traceroute tracepath mtr dig nslookup host lsblk blkid lsof stat file wc sort uniq cut ' +
  'tr column awk jq which whereis type env printenv echo printf journalctl dmesg last lastlog w who vmstat iostat mpstat sar nproc lscpu ' +
  'lsmem lsusb lspci lsmod sensors getent history tree diff cmp md5sum sha1sum sha256sum sha512sum base64 true sleep watch nvidia-smi ' +
  'docker systemctl git kubectl curl apt apt-cache dpkg yum dnf rpm ip ifconfig hostname hostnamectl timedatectl openssl').split(' '));
const SUB_READ = {
  docker: /^(ps|images|logs|inspect|stats|info|version|top|port|diff|history|search|events|(network|volume|image|container|context|node|service|stack|secret|config)\s+(ls|inspect)|system\s+(df|info|events)|compose\s+(ps|logs|config|ls|top|images|version))\b/,
  systemctl: /^(status|list-units|list-unit-files|list-timers|list-sockets|list-dependencies|is-active|is-enabled|is-failed|show|cat|get-default)\b|^$/,
  git: /^(status|log|diff|show|branch\s*$|remote\s+-v|rev-parse|describe|blame|shortlog)\b/,
  kubectl: /^(get|describe|logs|top|explain|version|cluster-info|api-resources|config\s+view)\b/,
  apt: /^(list|show|policy|search)\b/,
  'apt-cache': /./,
  dpkg: /^-(l|L|s|S)\b/,
  yum: /^(list|info|search|history)\b/,
  dnf: /^(list|info|search|history)\b/,
  rpm: /^-q/,
  ip: /^(?!.*\b(add|del|delete|set|flush|change|replace|append|prepend)\b)/,
  ifconfig: /^\S*$/,
  hostname: /^(-[fIisA]\b.*)?$/,
  hostnamectl: /^(status)?$/,
  timedatectl: /^(status|show|list-timezones)?$/,
  openssl: /^(x509|s_client|version|req\s+-text|verify)\b/,
  journalctl: /^(?!.*--(vacuum|rotate|flush|sync|relinquish))/,
  date: /^(?!.*(-s\b|--set))/,
  find: /^(?!.*\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b)/,
  sort: /^(?!.*(\s|^)-o\b)/,
  curl: /^(?!.*(\s|^)(-o|-O|--output|--remote-name|-T|--upload-file|-d|--data\S*|-F|--form|-X\s*(POST|PUT|PATCH|DELETE)|--request\s*(POST|PUT|PATCH|DELETE))\b)/i,
};
const DANGEROUS = /\b(rm|rmdir|shred|mkfs\S*|dd|fdisk|parted|wipefs|reboot|shutdown|poweroff|halt|init\s+[06]|kill|pkill|killall|userdel|groupdel|passwd|truncate|iptables|nft|ufw|crontab\s+-r|chmod\s+-R|chown\s+-R|mv)\b|docker\s+(rm|rmi|kill|system\s+prune|volume\s+(rm|prune)|image\s+prune|container\s+prune|network\s+(rm|prune))|systemctl\s+(stop|restart|disable|mask|kill|reboot|poweroff|isolate)|apt(-get)?\s+(remove|purge|autoremove)|>\s*\/dev\/sd/;

/** True when every part of the command only reads (no redirection into files, no sudo). */
export function commandIsReadOnly(cmd) {
  const c = String(cmd || '').trim();
  if (!c || /`|\$\(|<\(|\bxargs\b|\btee\b|\bsudo\b|\bsu\b/.test(c)) return false;
  // 2>&1 and > /dev/null are harmless; any other > writes a file.
  const plain = c.replace(/\d?>\s*&\s*\d|\d?>>?\s*\/dev\/null/g, ' ');
  if (/>/.test(plain)) return false;
  return plain.split(/\|\||&&|[|;&\n]/).every((part) => {
    const words = part.trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const [first, ...rest] = words;
    if (!first) return true;
    if (!READ_ONLY.has(first)) return false;
    const rule = SUB_READ[first];
    return !rule || rule.test(rest.join(' '));
  });
}

/** Confirm a command that may change the server. Read-only commands run straight away. */
export function confirmCommand(cmd, sudo) {
  if (!sudo && commandIsReadOnly(cmd)) return Promise.resolve(true);
  const danger = DANGEROUS.test(cmd);
  const warnings = [];
  if (/\brm\b.*\s-[a-zA-Z]*r/.test(cmd)) warnings.push('rm -r deletes whole folders permanently. There is no recycle bin.');
  if (/\b(reboot|shutdown|poweroff|halt)\b/.test(cmd)) warnings.push('Restarting or shutting down disconnects everyone and stops every service on the server.');
  if (/\b(kill|pkill|killall)\b/.test(cmd)) warnings.push('Killed processes lose any work in progress.');
  if (/\b(mkfs\S*|dd|fdisk|parted|wipefs)\b/.test(cmd)) warnings.push('This touches disks directly and can destroy data.');
  if (/docker\s+(system|volume|image|container)\s+prune/.test(cmd)) warnings.push('Prune removes everything unused at once.');
  return confirmDialog({
    tone: danger ? 'danger' : 'warn',
    icon: danger ? 'alert' : 'terminal',
    title: sudo ? 'Run this command as root?' : 'Run this command?',
    message: 'It may change the server. Read-only commands (ls, cat, df, docker ps, systemctl status…) run without asking.',
    facts: [
      state.info ? ['Server', `${state.info.username}@${state.info.host}:${state.info.port}`] : null,
      ['Runs as', sudo ? 'root (sudo)' : state.info?.username || 'your SSH user'],
    ],
    warnings,
    detail: `${sudo ? '# ' : '$ '}${cmd}`,
    confirmLabel: 'Run',
  });
}

/**
 * Run a command on the host and stream its output into a dialog.
 * opts: { title, cmd, sudo, kind: 'pull', ref, onDone(ok) }
 * Commands that may change the server are confirmed first (see confirmCommand).
 */
export async function runInModal(opts) {
  if (opts.kind !== 'pull' && !(await confirmCommand(opts.cmd, opts.sudo))) return null;
  const host = state.info?.hostname || state.info?.host || 'server';
  const shown = opts.kind === 'pull' ? `docker pull ${opts.ref}` : opts.cmd;
  const { el, close } = openModal({
    title: opts.title || 'Run command',
    size: 'xl',
    content: `
      <div class="run-head">
        <span class="run-prompt">${opts.sudo ? '#' : '$'}</span>
        <code class="run-cmd" title="${esc(shown)}">${esc(shown)}</code>
        <span class="run-where">${icon('server')}${esc(host)}${opts.sudo ? ' · sudo' : ''}</span>
      </div>
      <div class="term-mount run-out"></div>
      <div class="run-foot">
        <span class="run-status"></span>
        <span class="spacer"></span>
        <button class="btn ghost small" data-run="copy">${icon('copy')}Copy output</button>
        <button class="btn ghost small" data-run="again">${icon('restart')}Run again</button>
        <button class="btn small" data-run="stop">${icon('stop')}Stop</button>
      </div>`,
    onClose: () => {
      if (token) stopStream(token);
      view.dispose();
    },
  });
  const view = makeXterm($('.run-out', el), { disableStdin: true, cursorBlink: false, convertEol: true, scrollback: 50000 });
  const status = $('.run-status', el);
  const stopBtn = $('[data-run="stop"]', el);
  let token = null;

  const setStatus = (kind, text) => {
    status.className = `run-status ${kind}`;
    status.innerHTML = `${kind === 'running' ? '<span class="live-dot"></span>' : icon(kind === 'ok' ? 'check' : kind === 'fail' ? 'error' : 'info')}<span>${esc(text)}</span>`;
  };

  const start = async () => {
    if (token) stopStream(token);
    view.term.reset();
    token = uid('r');
    const my = token;
    const t0 = Date.now();
    setStatus('running', 'Running…');
    stopBtn.hidden = false;
    streams.set(my, {
      data: (d) => view.term.write(d),
      end: (m) => {
        if (token !== my) return;
        token = null;
        stopBtn.hidden = true;
        if (m.error) setStatus('fail', m.error);
        else if (m.code === 0) setStatus('ok', `Finished in ${fmtMs(m.ms ?? Date.now() - t0)}`);
        else setStatus('fail', m.code == null ? `Stopped after ${fmtMs(Date.now() - t0)}` : `Exited with code ${m.code} after ${fmtMs(m.ms ?? Date.now() - t0)}`);
        opts.onDone?.(m.code === 0);
      },
    });
    requestAnimationFrame(view.doFit);
    try {
      await withSudo((x) =>
        rpc('sys.run', { token: my, cmd: opts.cmd, kind: opts.kind, ref: opts.ref, sudo: !!opts.sudo, cols: view.term.cols, rows: view.term.rows, ...x }),
      );
    } catch (err) {
      streams.delete(my);
      if (token !== my) return;
      token = null;
      stopBtn.hidden = true;
      setStatus('fail', err.cancelled ? 'Cancelled: no sudo password' : err.message);
    }
  };

  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-run]');
    if (!b) return;
    if (b.dataset.run === 'copy') copyText(termText(view.term), 'Output copied');
    else if (b.dataset.run === 'again') {
      if (opts.kind === 'pull') start();
      else confirmCommand(opts.cmd, opts.sudo).then((ok) => ok && start());
    }
    else if (b.dataset.run === 'stop' && token) {
      stopStream(token);
      token = null;
      stopBtn.hidden = true;
      setStatus('fail', 'Stopped');
    }
  });
  requestAnimationFrame(() => {
    view.doFit();
    start();
  });
  return { close };
}

// ------------------------------------------------------------------ services

let svc = { list: [], filter: 'all', q: '', systemd: true, root: false, loaded: false };

const svcState = (x) => (x.active === 'failed' ? 'failed' : x.active === 'active' ? 'running' : x.active === 'activating' || x.active === 'reloading' || x.active === 'deactivating' ? 'changing' : 'stopped');
const SVC_CLS = { running: 'st-running', failed: 'st-dead', changing: 'st-restarting', stopped: 'st-exited' };
const isEnabled = (x) => /^enabled/.test(x.enabled);

export async function loadServices() {
  const el = $('#sys-services');
  if (!el.dataset.ready) {
    el.dataset.ready = '1';
    el.innerHTML = `
      <div class="sys-tiles"></div>
      <div class="toolbar">
        <div class="search-box sm"><i data-icon="search"></i><input type="search" data-svc-q placeholder="Filter services" /></div>
        <div class="seg seg-sm" data-svc-filter>
          <button data-f="all" class="active">All <b></b></button>
          <button data-f="running">Running <b></b></button>
          <button data-f="failed">Failed <b></b></button>
          <button data-f="stopped">Stopped <b></b></button>
        </div>
        <span class="spacer"></span>
        <span class="muted tiny" data-svc-note></span>
      </div>
      <div class="sys-body">${skeletonTable(8, 4)}</div>`;
    hydrate(el);
    $('[data-svc-q]', el).addEventListener('input', (e) => {
      svc.q = e.target.value.toLowerCase();
      renderServices();
    });
    $('[data-svc-filter]', el).addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      svc.filter = b.dataset.f;
      $$('[data-f]', e.currentTarget).forEach((x) => x.classList.toggle('active', x === b));
      renderServices();
    });
    $('.sys-body', el).addEventListener('click', onServiceClick);
  }
  try {
    const d = await rpc('sys.services');
    svc = { ...svc, list: d.services, systemd: d.systemd, root: d.root, loaded: true };
    renderServices();
  } catch (err) {
    $('.sys-body', el).innerHTML = errorBox(err.message);
  }
}

function renderServices() {
  const el = $('#sys-services');
  const body = $('.sys-body', el);
  if (!svc.systemd) {
    $('.sys-tiles', el).innerHTML = '';
    body.innerHTML = emptyState('settings', 'No systemd on this server', 'Services are managed with systemd, which this server does not use (for example Alpine, or a container). Use the Terminal for its init system.');
    return;
  }
  const counts = { all: svc.list.length, running: 0, failed: 0, stopped: 0, changing: 0 };
  for (const x of svc.list) counts[svcState(x)]++;
  counts.stopped += counts.changing;
  $$('[data-svc-filter] [data-f]', el).forEach((b) => ($('b', b).textContent = counts[b.dataset.f] ?? ''));
  const enabled = svc.list.filter(isEnabled).length;
  $('.sys-tiles', el).innerHTML = `<div class="stat-grid">
    ${statTile('play', 'Running', counts.running, `of ${counts.all} services`)}
    ${statTile('error', 'Failed', counts.failed, counts.failed ? 'need attention' : 'all good', counts.failed ? 'bad' : 'good')}
    ${statTile('power', 'Start at boot', enabled, 'enabled services')}
    ${statTile('stop', 'Stopped', counts.stopped, 'inactive or dead')}
  </div>`;
  $('[data-svc-note]', el).textContent = svc.root ? 'Signed in as root' : 'Changes use sudo';

  const rank = { failed: 0, changing: 1, running: 2, stopped: 3 };
  const rows = svc.list
    .filter((x) => svc.filter === 'all' || svcState(x) === svc.filter || (svc.filter === 'stopped' && svcState(x) === 'changing'))
    .filter((x) => !svc.q || `${x.unit} ${x.description}`.toLowerCase().includes(svc.q))
    .sort((a, b) => rank[svcState(a)] - rank[svcState(b)] || a.unit.localeCompare(b.unit));
  if (!rows.length) {
    body.innerHTML = msg(svc.q ? 'No services match.' : 'No services here.');
    return;
  }
  body.innerHTML = `<div class="tbl-wrap"><table class="tbl clickable svc-tbl">
    <thead><tr><th>Service</th><th>State</th><th>At boot</th><th class="num">Actions</th></tr></thead>
    <tbody>${rows
      .map((x) => {
        const st = svcState(x);
        const name = x.unit.replace(/\.service$/, '');
        const actions =
          st === 'running' || st === 'changing'
            ? `${iconBtn('restart', 'restart', 'Restart')}${iconBtn('stop', 'stop', 'Stop')}`
            : iconBtn('play', 'start', 'Start');
        return `<tr data-unit="${esc(x.unit)}">
          <td><div class="svc-name"><span class="dot ${SVC_CLS[st]}"></span><div><strong>${esc(name)}</strong>${x.description ? `<span>${esc(x.description)}</span>` : ''}</div></div></td>
          <td><span class="badge ${SVC_CLS[st]}">${esc(x.active)}${x.sub && x.sub !== x.active ? ` · ${esc(x.sub)}` : ''}</span></td>
          <td>${bootPill(x.enabled)}</td>
          <td class="num"><div class="row-actions">${actions}${iconBtn('logs', 'logs', 'Details and live log')}</div></td>
        </tr>`;
      })
      .join('')}</tbody></table></div>`;
}

const bootPill = (s) =>
  s ? `<span class="boot-pill ${/^enabled/.test(s) ? 'on' : s === 'masked' ? 'masked' : ''}">${esc(s)}</span>` : '<span class="muted">—</span>';
const iconBtn = (ic, act, title) => `<button class="icon-btn sm" data-act="${act}" title="${esc(title)}" aria-label="${esc(title)}">${icon(ic)}</button>`;

function onServiceClick(e) {
  const tr = e.target.closest('tr[data-unit]');
  if (!tr) return;
  const unit = tr.dataset.unit;
  const b = e.target.closest('[data-act]');
  if (!b || b.dataset.act === 'logs') return openService(unit);
  serviceAction(unit, b.dataset.act, b);
}

const ACTION_COPY = {
  start: ['Started', 'play'],
  stop: ['Stopped', 'stop'],
  restart: ['Restarted', 'restart'],
  reload: ['Reloaded', 'refresh'],
  enable: ['Enabled at boot', 'power'],
  disable: ['Disabled at boot', 'power'],
};

async function serviceAction(unit, action, btn) {
  const name = unit.replace(/\.service$/, '');
  // start / reload / enable are confirmed with a click; stop / restart / disable with a hold.
  if (action === 'start' || action === 'reload' || action === 'enable') {
    const ok = await confirmDialog({
      icon: ACTION_COPY[action][1],
      title: `${action[0].toUpperCase()}${action.slice(1)} ${name}?`,
      message:
        action === 'start'
          ? 'The service starts now (it may still be disabled at boot).'
          : action === 'reload'
            ? 'The service re-reads its configuration without a full restart.'
            : 'The service will start automatically every time the server boots. It is not started now.',
      facts: [['Service', unit], state.info ? ['Server', `${state.info.username}@${state.info.host}`] : null],
      confirmLabel: `${action[0].toUpperCase()}${action.slice(1)}`,
    });
    if (!ok) return null;
  }
  if (action === 'stop' || action === 'restart' || action === 'disable') {
    const ok = await confirmDialog({
      tone: action === 'restart' ? 'warn' : 'danger',
      icon: ACTION_COPY[action][1],
      title: `${action[0].toUpperCase()}${action.slice(1)} ${name}?`,
      message:
        action === 'disable'
          ? 'It keeps running now but will not start the next time the server boots.'
          : action === 'stop'
            ? 'Anything that depends on this service stops working until it is started again.'
            : 'The service is stopped and started again. Connections to it may drop for a moment.',
      confirmLabel: `${action[0].toUpperCase()}${action.slice(1)}`,
    });
    if (!ok) return null;
  }
  btn?.classList.add('spin');
  if (btn) btn.disabled = true;
  try {
    const props = await withSudo((x) => rpc('sys.serviceAction', { unit, action, ...x }));
    toast(`${ACTION_COPY[action][0]}: ${name}`, 'success');
    const row = svc.list.find((x) => x.unit === unit);
    if (row && props) {
      row.active = props.ActiveState || row.active;
      row.sub = props.SubState || row.sub;
      row.enabled = props.UnitFileState || row.enabled;
      renderServices();
    }
    return props;
  } catch (err) {
    report(err);
    return null;
  } finally {
    btn?.classList.remove('spin');
    if (btn) btn.disabled = false;
  }
}

function openService(unit) {
  const name = unit.replace(/\.service$/, '');
  let token = null;
  const { el, close } = openModal({
    title: name,
    size: 'xl',
    content: `
      <div class="svc-detail">
        <div class="svc-detail-head"><div class="svc-detail-state"></div><div class="svc-detail-actions"></div></div>
        <div class="svc-props">${skeletonStats(4)}</div>
        <div class="svc-journal-bar">
          <strong>${icon('logs')} Live journal</strong>
          <label class="muted tiny">Lines
            <select data-j-lines><option>100</option><option selected>300</option><option>1000</option><option>5000</option></select>
          </label>
          <span class="spacer"></span>
          <span class="muted tiny" data-j-status></span>
        </div>
        <div class="term-mount svc-journal"></div>
      </div>`,
    onClose: () => {
      if (token) stopStream(token);
      view.dispose();
    },
  });
  const view = makeXterm($('.svc-journal', el), { disableStdin: true, cursorBlink: false, convertEol: true, scrollback: 50000 });
  const jStatus = $('[data-j-status]', el);

  const startJournal = async () => {
    if (token) stopStream(token);
    view.term.reset();
    token = uid('j');
    const my = token;
    jStatus.textContent = 'Streaming…';
    streams.set(my, {
      data: (d) => view.term.write(d),
      end: (m) => {
        if (token === my) jStatus.textContent = m.error ? `Error: ${m.error}` : 'Stream ended';
      },
    });
    requestAnimationFrame(view.doFit);
    try {
      await rpc('sys.journal', { token: my, unit, lines: $('[data-j-lines]', el).value, cols: view.term.cols, rows: view.term.rows });
    } catch (err) {
      streams.delete(my);
      jStatus.textContent = `Error: ${err.message}`;
    }
  };
  $('[data-j-lines]', el).addEventListener('change', startJournal);

  const render = (p) => {
    const st = p.ActiveState === 'failed' ? 'failed' : p.ActiveState === 'active' ? 'running' : 'stopped';
    $('.svc-detail-state', el).innerHTML = `
      <span class="badge ${SVC_CLS[st]}">${esc(p.ActiveState)}${p.SubState ? ` · ${esc(p.SubState)}` : ''}</span>
      ${bootPill(p.UnitFileState)}
      ${p.Description ? `<span class="muted">${esc(p.Description)}</span>` : ''}`;
    const running = p.ActiveState === 'active' || p.ActiveState === 'activating';
    const acts = running ? ['restart', 'reload', 'stop'] : ['start'];
    acts.push(/^enabled/.test(p.UnitFileState) ? 'disable' : 'enable');
    const actionsEl = $('.svc-detail-actions', el);
    actionsEl.innerHTML = acts
      .filter((a) => p.UnitFileState !== 'static' || (a !== 'enable' && a !== 'disable'))
      .map((a) => `<button class="btn small ${a === 'stop' || a === 'disable' ? 'danger-ghost' : a === 'start' ? 'primary' : ''}" data-sa="${a}">${icon(ACTION_COPY[a][1])}${a[0].toUpperCase()}${a.slice(1)}</button>`)
      .join('');
    const since = p.ActiveEnterTimestamp && !/^n\/a$/i.test(p.ActiveEnterTimestamp) ? p.ActiveEnterTimestamp : '';
    const mem = Number(p.MemoryCurrent);
    const cpu = Number(p.CPUUsageNSec);
    const tiles = [
      ['Main PID', p.MainPID && p.MainPID !== '0' ? p.MainPID : '—', since ? `since ${since}` : ''],
      ['Memory', Number.isFinite(mem) && mem < 2 ** 63 ? fmtBytes(mem) : '—', p.TasksCurrent && Number(p.TasksCurrent) < 2 ** 63 ? `${p.TasksCurrent} tasks` : ''],
      ['CPU time', Number.isFinite(cpu) && cpu < 2 ** 63 ? fmtMs(Math.round(cpu / 1e6)) : '—', p.User ? `runs as ${p.User}` : 'runs as root'],
      ['Restarts', p.NRestarts || '0', p.Restart ? `policy: ${p.Restart}` : ''],
    ];
    $('.svc-props', el).innerHTML = `<div class="stat-grid tight">${tiles
      .map(([l, v, sub]) => `<div class="stat"><div class="stat-label">${esc(l)}</div><div class="stat-value sm">${esc(v)}</div><div class="stat-sub">${esc(sub)}</div></div>`)
      .join('')}</div>
      ${p.FragmentPath ? `<div class="svc-file"><span class="muted tiny">Unit file</span><button class="link-btn mono" data-unit-file="${esc(p.FragmentPath)}" title="Open its folder in Files">${esc(p.FragmentPath)}</button></div>` : ''}`;
  };

  const loadProps = async () => {
    try {
      render(await rpc('sys.service', { unit }));
    } catch (err) {
      $('.svc-props', el).innerHTML = errorBox(err.message);
    }
  };

  el.addEventListener('click', async (e) => {
    const f = e.target.closest('[data-unit-file]');
    if (f) {
      const path = f.dataset.unitFile;
      close();
      emit('browse-host', path.slice(0, path.lastIndexOf('/')) || '/');
      return;
    }
    const b = e.target.closest('[data-sa]');
    if (!b) return;
    const props = await serviceAction(unit, b.dataset.sa, b);
    if (props) render(props);
  });
  loadProps();
  requestAnimationFrame(startJournal);
}

// ------------------------------------------------------------------ processes

let proc = { data: null, q: '', sort: 'cpu', dir: -1, hover: false, at: 0 };
const PROC_LIMIT = 250;

export async function startProcesses() {
  const el = $('#sys-processes');
  if (!el.dataset.ready) {
    el.dataset.ready = '1';
    el.innerHTML = `
      <div class="sys-tiles">${skeletonStats(4)}</div>
      <div class="toolbar">
        <div class="search-box sm"><i data-icon="search"></i><input type="search" data-proc-q placeholder="Filter processes" /></div>
        <span class="spacer"></span>
        <span class="live-note"></span>
      </div>
      <div class="sys-body">${skeletonTable(10, 7)}</div>`;
    hydrate(el);
    $('[data-proc-q]', el).addEventListener('input', (e) => {
      proc.q = e.target.value.trim().toLowerCase();
      renderProcesses();
    });
    const body = $('.sys-body', el);
    // Rows re-sort as CPU use changes: hold still while the pointer is over the list.
    body.addEventListener('mouseenter', () => ((proc.hover = true), renderLiveNote()));
    body.addEventListener('mouseleave', () => ((proc.hover = false), renderLiveNote()));
    body.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (th) {
        proc.dir = proc.sort === th.dataset.sort ? -proc.dir : th.dataset.sort === 'cmd' || th.dataset.sort === 'user' ? 1 : -1;
        proc.sort = th.dataset.sort;
        return renderProcesses(true);
      }
      const b = e.target.closest('[data-kill]');
      if (b) endProcess(Number(b.dataset.kill));
    });
  }
  const my = ++loop;
  while (my === loop && state.connected) {
    if (!document.hidden && !proc.hover) {
      try {
        proc.data = await rpc('sys.processes');
        proc.at = Date.now();
        if (my !== loop) return;
        renderProcesses();
      } catch (err) {
        if (my === loop) $('.sys-body', el).innerHTML = errorBox(err.message);
        return;
      }
    }
    await sleep(3000);
  }
}

/** Open the Processes tab filtered to one PID (from Ports). */
export function showProcess(pid) {
  proc.q = String(pid);
  showTab('processes');
  const input = $('#sys-processes [data-proc-q]');
  if (input) input.value = proc.q;
}

function renderLiveNote() {
  const n = $('#sys-processes .live-note');
  if (!n) return;
  n.innerHTML = proc.hover
    ? `<span class="live-dot wait"></span><span class="muted tiny">Paused while the pointer is over the list</span>`
    : `<span class="live-dot${proc.at ? '' : ' wait'}"></span><span class="muted tiny">Live · every 3 seconds</span>`;
}

function renderProcesses(force) {
  const el = $('#sys-processes');
  const d = proc.data;
  renderLiveNote();
  if (!d) return;
  const procs = d.procs;
  const memUsed = d.memTotal && d.memAvailable != null ? d.memTotal - d.memAvailable : null;
  const top = [...procs].sort((a, b) => b.cpu - a.cpu)[0];
  const running = procs.filter((p) => /^R/.test(p.stat)).length;
  const zombies = procs.filter((p) => /^Z/.test(p.stat)).length;
  $('.sys-tiles', el).innerHTML = `<div class="stat-grid">
    ${statTile('list', 'Processes', procs.length, `${running} running${zombies ? ` · ${zombies} zombie` : ''}`, zombies ? 'warn' : '')}
    ${statTile('cpu', 'Load', d.load?.length ? d.load[0].toFixed(2) : '—', d.load?.length ? `${d.load.map((x) => x.toFixed(2)).join(' / ')}${d.cpus ? ` · ${d.cpus} CPUs` : ''}` : '', d.cpus && d.load?.[0] > d.cpus ? 'warn' : '')}
    ${statTile('layers', 'Memory', memUsed != null ? `${Math.round((memUsed / d.memTotal) * 100)}%` : '—', memUsed != null ? `${fmtBytes(memUsed)} of ${fmtBytes(d.memTotal)}` : '')}
    ${statTile('zap', 'Busiest', top ? `${top.cpu.toFixed(0)}%` : '—', top ? `${cmdName(top.cmd)} (PID ${top.pid})` : '')}
  </div>`;

  const q = proc.q;
  let rows = q ? procs.filter((p) => String(p.pid) === q || p.user.toLowerCase().includes(q) || p.cmd.toLowerCase().includes(q)) : procs;
  const k = proc.sort;
  rows = [...rows].sort((a, b) => (typeof a[k] === 'number' ? a[k] - b[k] : String(a[k]).localeCompare(String(b[k]))) * proc.dir || a.pid - b.pid);
  const more = rows.length - PROC_LIMIT;
  rows = rows.slice(0, PROC_LIMIT);
  const body = $('.sys-body', el);
  const sig = `${k}${proc.dir}|${rows.map((p) => p.pid).join(',')}`;
  const tbl = $('table', body);
  // Same rows in the same order: update numbers in place so bars glide instead of the table blinking.
  if (!force && tbl && tbl.dataset.sig === sig) {
    for (const p of rows) {
      const tr = tbl.querySelector(`tr[data-pid="${p.pid}"]`);
      if (!tr) continue;
      $('[data-c="cpu"]', tr).textContent = `${p.cpu.toFixed(1)}%`;
      $('[data-c="mem"]', tr).textContent = `${p.mem.toFixed(1)}%`;
      $('[data-c="rss"]', tr).textContent = fmtBytes(p.rss);
      $('[data-c="time"]', tr).textContent = p.etime;
      setBar($('[data-c="cpuBar"] > i', tr), p.cpu / (d.cpus || 1));
      setBar($('[data-c="memBar"] > i', tr), p.mem);
    }
    return;
  }
  if (!rows.length) {
    body.innerHTML = msg('No processes match.');
    return;
  }
  const th = (key, label, cls = '') => `<th data-sort="${key}" class="sortable ${cls}">${label}${proc.sort === key ? (proc.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  body.innerHTML = `<div class="tbl-wrap"><table class="tbl nowrap proc-tbl" data-sig="${esc(sig)}">
    <thead><tr>${th('pid', 'PID', 'num')}${th('user', 'User')}${th('cpu', 'CPU', 'num')}${th('mem', 'Memory', 'num')}${th('rss', 'RSS', 'num')}${th('etime', 'Running for', 'num')}${th('cmd', 'Command')}<th></th></tr></thead>
    <tbody>${rows
      .map((p) => {
        const cpuPct = p.cpu / (d.cpus || 1);
        return `<tr data-pid="${p.pid}">
          <td class="num mono muted">${p.pid}</td>
          <td class="ellip-sm">${esc(p.user)}</td>
          <td class="num"><span data-c="cpu">${p.cpu.toFixed(1)}%</span><div class="bar" data-c="cpuBar"><i class="${barCls(cpuPct)}" style="width:${Math.min(cpuPct, 100).toFixed(1)}%"></i></div></td>
          <td class="num"><span data-c="mem">${p.mem.toFixed(1)}%</span><div class="bar" data-c="memBar"><i class="${barCls(p.mem)}" style="width:${Math.min(p.mem, 100).toFixed(1)}%"></i></div></td>
          <td class="num muted" data-c="rss">${fmtBytes(p.rss)}</td>
          <td class="num muted" data-c="time">${esc(p.etime)}</td>
          <td class="proc-cmd" title="${esc(p.cmd)}"><b>${esc(cmdName(p.cmd))}</b> <span>${esc(cmdArgs(p.cmd))}</span></td>
          <td class="num">${p.pid > 1 ? `<button class="icon-btn sm danger" data-kill="${p.pid}" title="End process" aria-label="End process ${p.pid}">${icon('x')}</button>` : ''}</td>
        </tr>`;
      })
      .join('')}</tbody></table></div>
    ${more > 0 ? `<div class="muted tiny inset-note">Showing ${PROC_LIMIT} of ${rows.length + more}. Filter to find the others.</div>` : ''}`;
}

const barCls = (p) => (p >= 90 ? 'crit' : p >= 70 ? 'warn' : '');
function setBar(i, p) {
  if (!i) return;
  i.style.width = `${Math.min(p, 100).toFixed(1)}%`;
  i.className = barCls(p);
}
const cmdName = (cmd) => {
  const first = String(cmd).split(/\s+/)[0] || cmd;
  return /^\[.*\]$/.test(first) ? first : first.split('/').pop();
};
const cmdArgs = (cmd) => String(cmd).split(/\s+/).slice(1).join(' ');

function endProcess(pid) {
  const p = proc.data?.procs.find((x) => x.pid === pid);
  const { el, close } = openModal({
    title: `End ${p ? cmdName(p.cmd) : 'process'} (PID ${pid})`,
    content: `
      <p class="muted">Ask the process to stop, or force it. Forcing gives it no chance to save its work or clean up.</p>
      ${p ? `<div class="modal-detail">${esc(p.cmd)}</div>` : ''}
      <div class="kill-opts">
        <div><strong>Terminate</strong><span>Sends SIGTERM: the polite way to stop.</span></div>
        <div><strong>Force kill</strong><span>Sends SIGKILL: stops it immediately.</span></div>
      </div>`,
  });
  const [a, b] = $$('.kill-opts > div', el);
  const go = (signal) => async () => {
    close();
    try {
      await withSudo((x) => rpc('sys.kill', { pid, signal, ...x }));
      toast(`${signal === 'KILL' ? 'Killed' : 'Sent SIGTERM to'} PID ${pid}`, 'success');
    } catch (err) {
      report(err);
    }
  };
  a.appendChild(holdButton({ label: 'Hold to terminate', tone: 'warn', icon: 'stop', onComplete: go('TERM') }));
  b.appendChild(holdButton({ label: 'Hold to force kill', tone: 'danger', icon: 'x', onComplete: go('KILL') }));
}

// ------------------------------------------------------------------ ports

let portState = { data: null, q: '', proto: 'all', hideLocal: false };

const isLoopback = (h) => /^127\.|^::1$|^localhost$/.test(h);
const isAny = (h) => h === '0.0.0.0' || h === '::' || h === '';

/** host port + protocol → containers that publish it, from `docker ps` port strings. */
function publishedPorts() {
  const map = new Map();
  for (const c of state.containers) {
    for (const m of String(c.Ports || '').matchAll(/(?:[\d.]+|\[?[0-9a-f:]*\]?):(\d+)(?:-(\d+))?->(\d+)(?:-\d+)?\/(tcp|udp)/g)) {
      const from = Number(m[1]);
      const to = Number(m[2] || m[1]);
      for (let p = from; p <= to && p - from < 2000; p++) {
        const k = `${m[4]}/${p}`;
        if (!map.has(k)) map.set(k, new Set());
        map.get(k).add(c.ID);
      }
    }
  }
  return map;
}

export async function loadPorts() {
  const el = $('#sys-ports');
  if (!el.dataset.ready) {
    el.dataset.ready = '1';
    el.innerHTML = `
      <div class="toolbar">
        <div class="search-box sm"><i data-icon="search"></i><input type="search" data-port-q placeholder="Filter ports" /></div>
        <div class="seg seg-sm" data-port-proto>
          <button data-p="all" class="active">All</button><button data-p="tcp">TCP</button><button data-p="udp">UDP</button>
        </div>
        <label class="check"><input type="checkbox" data-port-local /> Hide local-only</label>
        <span class="spacer"></span>
        <span class="muted tiny" data-port-note></span>
      </div>
      <div class="sys-body">${skeletonTable(8, 5)}</div>`;
    hydrate(el);
    $('[data-port-q]', el).addEventListener('input', (e) => {
      portState.q = e.target.value.trim().toLowerCase();
      renderPorts();
    });
    $('[data-port-proto]', el).addEventListener('click', (e) => {
      const b = e.target.closest('[data-p]');
      if (!b) return;
      portState.proto = b.dataset.p;
      $$('[data-p]', e.currentTarget).forEach((x) => x.classList.toggle('active', x === b));
      renderPorts();
    });
    $('[data-port-local]', el).addEventListener('change', (e) => {
      portState.hideLocal = e.target.checked;
      renderPorts();
    });
    $('.sys-body', el).addEventListener('click', (e) => {
      const pb = e.target.closest('[data-pid]');
      if (pb) return showProcess(pb.dataset.pid);
      const cb = e.target.closest('[data-container]');
      if (cb) emit('select-container', cb.dataset.container);
    });
  }
  try {
    portState.data = await rpc('sys.ports');
    renderPorts();
  } catch (err) {
    $('.sys-body', el).innerHTML = errorBox(err.message);
  }
}

function renderPorts() {
  const el = $('#sys-ports');
  const d = portState.data;
  if (!d) return;
  const pub = publishedPorts();
  const host = state.info?.host || '';
  const missing = d.ports.some((p) => !p.procs.length);
  $('[data-port-note]', el).textContent = `${d.ports.length} listening${!d.privileged && missing ? ' · sudo is needed to see every process' : ''}`;
  const q = portState.q;
  const rows = d.ports.filter((p) => {
    if (portState.proto !== 'all' && p.proto !== portState.proto) return false;
    if (portState.hideLocal && isLoopback(p.host)) return false;
    if (!q) return true;
    const cs = [...(pub.get(`${p.proto}/${p.port}`) || [])].map((id) => firstName(state.containers.find((c) => c.ID === id)?.Names));
    return `${p.port} ${p.host} ${p.procs.map((x) => `${x.name} ${x.pid}`).join(' ')} ${cs.join(' ')}`.toLowerCase().includes(q);
  });
  const body = $('.sys-body', el);
  if (!rows.length) {
    body.innerHTML = msg(q ? 'No ports match.' : 'Nothing is listening.');
    return;
  }
  body.innerHTML = `<div class="tbl-wrap"><table class="tbl nowrap port-tbl">
    <thead><tr><th>Port</th><th>Protocol</th><th>Reachable on</th><th>Process</th><th>Container</th><th></th></tr></thead>
    <tbody>${rows
      .map((p) => {
        const containers = [...(pub.get(`${p.proto}/${p.port}`) || [])].map((id) => state.containers.find((c) => c.ID === id)).filter(Boolean);
        const where = isAny(p.host)
          ? '<span class="reach any">All interfaces</span>'
          : isLoopback(p.host)
            ? `<span class="reach local">This server only</span> <span class="muted mono tiny">${esc(p.host)}</span>`
            : `<span class="reach">${esc(p.host)}</span>`;
        const procs = p.procs.length
          ? p.procs
              .slice(0, 3)
              .map((x) => `<button class="chip link" data-pid="${x.pid}" title="Show process ${x.pid}">${esc(x.name)} <span class="muted">${x.pid}</span></button>`)
              .join(' ')
          : '<span class="muted">—</span>';
        const cs = containers.length
          ? containers.map((c) => `<button class="chip link" data-container="${esc(c.ID)}"><span class="dot st-${esc(c.State)}"></span>${esc(firstName(c.Names))}</button>`).join(' ')
          : '';
        const open = p.proto === 'tcp' && !isLoopback(p.host) && host
          ? `<a class="icon-btn sm" href="http://${esc(host.includes(':') ? `[${host}]` : host)}:${p.port}" target="_blank" rel="noopener" title="Open in browser">${icon('external')}</a>`
          : '';
        return `<tr>
          <td><span class="port-num">${p.port}</span></td>
          <td><span class="proto ${p.proto}">${p.proto.toUpperCase()}</span></td>
          <td>${where}</td>
          <td><div class="chips">${procs}</div></td>
          <td><div class="chips">${cs}</div></td>
          <td class="num">${open}</td>
        </tr>`;
      })
      .join('')}</tbody></table></div>
    <div class="muted tiny inset-note">Click a process to see it in Processes, or a container to open it. "All interfaces" ports can be reached from other machines unless a firewall blocks them.</div>`;
}

// ------------------------------------------------------------------ saved commands

const IDEAS = [
  { name: 'Biggest folders on /', cmd: 'du -xh / --max-depth=1 2>/dev/null | sort -rh | head -20', sudo: true, icon: 'drive' },
  { name: 'Biggest log files', cmd: "find /var/log -type f -printf '%s\\t%p\\n' 2>/dev/null | sort -rn | head -20 | awk -F'\\t' '{printf \"%9.1f MB  %s\\n\", $1/1048576, $2}'", sudo: true, icon: 'logs' },
  { name: 'Failed services', cmd: 'systemctl --failed --no-pager', icon: 'error' },
  { name: 'Memory hogs', cmd: 'ps -eo pid,user,%mem,rss,comm --sort=-%mem | head -15', icon: 'layers' },
  { name: 'Recent logins', cmd: 'last -n 20 2>/dev/null || who', icon: 'user' },
  { name: 'Network interfaces', cmd: 'ip -brief address 2>/dev/null || ifconfig', icon: 'network' },
  { name: 'Kernel messages', cmd: 'dmesg --ctime 2>/dev/null | tail -60', sudo: true, icon: 'alert' },
  { name: 'Pending updates', cmd: '(apt list --upgradable 2>/dev/null || dnf -q check-update || yum -q check-update) | head -60', icon: 'download' },
  { name: 'Reboot needed?', cmd: 'if [ -f /var/run/reboot-required ]; then cat /var/run/reboot-required /var/run/reboot-required.pkgs 2>/dev/null; else echo "No reboot required"; fi', icon: 'restart' },
  { name: 'Docker disk usage', cmd: 'docker system df -v', icon: 'docker' },
];

const profileKey = () => state.info?.profileKey || 'default';
const getCommands = () => storage.get('sdc.commands', []);
const setCommands = (list) => storage.set('sdc.commands', list);
/** Commands for this server: shared ones plus those saved for this server only. */
export const commandsHere = () => getCommands().filter((c) => !c.scope || c.scope === profileKey());

/** ⌘K entries for saved commands. */
export function commandPaletteItems() {
  return commandsHere().map((c) => ({
    group: 'Commands',
    label: `Run: ${c.name}`,
    hint: c.cmd.length > 60 ? `${c.cmd.slice(0, 57)}…` : c.cmd,
    keywords: 'run command snippet',
    icon: 'zap',
    run: () => runInModal({ title: c.name, cmd: c.cmd, sudo: c.sudo }),
  }));
}

export function renderCommands() {
  const el = $('#sys-commands');
  if (!el.dataset.ready) {
    el.dataset.ready = '1';
    el.innerHTML = `
      <form class="quick-run" autocomplete="off">
        <span class="qr-prompt">$</span>
        <input data-qr-cmd spellcheck="false" placeholder="Run a command on this server…" />
        <label class="check" title="Run as root with sudo"><input type="checkbox" data-qr-sudo /> sudo</label>
        <button type="button" class="btn ghost small" data-qr-save>${icon('save')}Save</button>
        <button type="submit" class="btn primary small">${icon('play')}Run</button>
      </form>
      <div class="cmd-section"><h4>Saved commands</h4><button class="btn ghost small" data-cmd-new>${icon('plus')}New command</button></div>
      <div class="cmd-grid" data-cmd-saved></div>
      <div class="cmd-section"><h4>Ideas</h4><span class="muted tiny">Ready-made commands. Run one, or add it to your saved commands.</span></div>
      <div class="cmd-grid" data-cmd-ideas></div>`;
    $('.qr-prompt', el).textContent = '$';
    $('form.quick-run', el).addEventListener('submit', (e) => {
      e.preventDefault();
      const cmd = $('[data-qr-cmd]', el).value.trim();
      if (!cmd) return;
      const sudo = $('[data-qr-sudo]', el).checked;
      runInModal({ title: 'Run command', cmd, sudo });
    });
    $('[data-qr-sudo]', el).addEventListener('change', (e) => ($('.qr-prompt', el).textContent = e.target.checked ? '#' : '$'));
    $('[data-qr-save]', el).addEventListener('click', () => {
      const cmd = $('[data-qr-cmd]', el).value.trim();
      editCommand({ cmd, sudo: $('[data-qr-sudo]', el).checked });
    });
    $('[data-cmd-new]', el).addEventListener('click', () => editCommand({}));
    el.addEventListener('click', onCommandClick);
  }
  const host = state.info?.hostname || state.info?.label || state.info?.host || 'this server';
  $('[data-qr-cmd]', el).placeholder = `Run a command on ${host}…`;
  const saved = commandsHere();
  $('[data-cmd-saved]', el).innerHTML = saved.length
    ? saved.map((c) => commandCard(c, 'saved')).join('')
    : `<div class="cmd-empty">${icon('zap')}<div><strong>No saved commands yet</strong><span>Save the commands you run often. They also show up in ⌘K.</span></div></div>`;
  $('[data-cmd-ideas]', el).innerHTML = IDEAS.map((c, i) => commandCard({ ...c, id: `idea${i}` }, 'idea')).join('');
}

function commandCard(c, kind) {
  return `<div class="cmd-card" data-cmd-id="${esc(c.id)}" data-kind="${kind}">
    <div class="cmd-card-head">
      <span class="cmd-ic">${icon(c.icon || 'zap')}</span>
      <strong title="${esc(c.name)}">${esc(c.name)}</strong>
      ${c.sudo ? '<span class="boot-pill on">sudo</span>' : ''}
      ${c.scope ? '<span class="boot-pill">this server</span>' : ''}
    </div>
    <div class="cmd-code" title="${esc(c.cmd)}"><code>${esc(c.cmd)}</code></div>
    <div class="cmd-card-foot">
      ${kind === 'saved'
        ? `${iconBtn('edit', 'edit', 'Edit')}${iconBtn('trash', 'delete', 'Delete')}`
        : `<button class="btn ghost small" data-act="add">${icon('plus')}Save</button>`}
      <span class="spacer"></span>
      <button class="btn small" data-act="run">${icon('play')}Run</button>
    </div>
  </div>`;
}

async function onCommandClick(e) {
  const b = e.target.closest('[data-act]');
  const card = e.target.closest('.cmd-card');
  if (!b || !card) return;
  const kind = card.dataset.kind;
  const id = card.dataset.cmdId;
  const c = kind === 'idea' ? IDEAS[Number(id.slice(4))] : getCommands().find((x) => x.id === id);
  if (!c) return;
  switch (b.dataset.act) {
    case 'run':
      return runInModal({ title: c.name, cmd: c.cmd, sudo: c.sudo });
    case 'add':
      setCommands([...getCommands(), { id: uid('c'), name: c.name, cmd: c.cmd, sudo: !!c.sudo, icon: c.icon, scope: null }]);
      toast(`Saved "${c.name}"`, 'success');
      return renderCommands();
    case 'edit':
      return editCommand(c);
    case 'delete': {
      const ok = await confirmDialog({ tone: 'primary', icon: 'trash', title: `Delete "${c.name}"?`, message: 'The saved command is removed. Nothing changes on the server.', confirmLabel: 'Delete' });
      if (!ok) return;
      setCommands(getCommands().filter((x) => x.id !== id));
      return renderCommands();
    }
  }
}

function editCommand(c) {
  const isNew = !c.id;
  const { el, close } = openModal({
    title: isNew ? 'New command' : 'Edit command',
    wide: true,
    content: `
      <form class="cmd-form">
        <label>Name<input name="name" value="${esc(c.name || '')}" placeholder="Restart the web stack" required /></label>
        <label>Command<textarea name="cmd" rows="5" spellcheck="false" placeholder="cd /opt/app && docker compose up -d" required>${esc(c.cmd || '')}</textarea></label>
        <label class="check"><input type="checkbox" name="sudo" ${c.sudo ? 'checked' : ''} /> Run as root (sudo)</label>
        <label class="check"><input type="checkbox" name="scope" ${c.scope ? 'checked' : ''} /> Only for this server</label>
        <div class="modal-actions"><button type="button" class="btn ghost" data-close-form>Cancel</button><button class="btn primary">${isNew ? 'Save command' : 'Save changes'}</button></div>
      </form>`,
  });
  const form = $('form', el);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const next = {
      id: c.id || uid('c'),
      name: String(f.get('name')).trim().slice(0, 80),
      cmd: String(f.get('cmd')).trim(),
      sudo: f.get('sudo') === 'on',
      icon: c.icon,
      scope: f.get('scope') === 'on' ? c.scope || profileKey() : null,
    };
    if (!next.name || !next.cmd) return;
    const list = getCommands();
    const i = list.findIndex((x) => x.id === next.id);
    if (i >= 0) list[i] = next;
    else list.push(next);
    setCommands(list);
    close();
    toast(isNew ? `Saved "${next.name}"` : 'Command updated', 'success');
    if ($('#sys-commands')?.dataset.ready) renderCommands();
  });
  $('[data-close-form]', el).addEventListener('click', () => close());
  $(isNew && c.cmd ? '[name="name"]' : c.name ? '[name="cmd"]' : '[name="name"]', el).focus();
}

// ------------------------------------------------------------------ shared bits

function statTile(ic, label, value, sub, tone = '') {
  return `<div class="stat ${tone ? `tone-${tone}` : ''}"><div class="stat-label">${icon(ic)} ${esc(label)}</div><div class="stat-value">${esc(value)}</div><div class="stat-sub">${esc(sub)}</div></div>`;
}

function emptyState(ic, title, text) {
  return `<div class="empty-state"><div>${icon(ic, 'big')}<strong>${esc(title)}</strong><p class="muted">${esc(text)}</p></div></div>`;
}

function hydrate(root) {
  for (const n of $$('i[data-icon]', root)) n.outerHTML = icon(n.dataset.icon, n.className);
}
