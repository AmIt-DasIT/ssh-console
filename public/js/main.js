// App bootstrap: connect screen, host dashboard, container views, theme, settings, ⌘K palette,
// keyboard shortcuts and session restore.
import { enhanceSelectsEverywhere } from './searchselect.js';
import { enhanceDatesEverywhere } from './datepicker.js';
import { installTabKeys, KEYS as TAB_KEYS } from './tabkeys.js';
import { $, $$, esc, rpc, state, on, emit, onStream, toast, closeSocket, ensureSocket, tileStyle, enhanceSegsEverywhere, withTransition, animateIn, storage, prefs, desktop, firstName, dbEngineOf, containerById, copyText, sleep, serverOutdated, inTab, tabSession, reportTab, tabCommand } from './core.js';
import { icon, hydrateIcons } from './icons.js';
import { openPalette, openModal, isModalOpen, confirmDialog, promptDialog, setProductionCheck } from './ui.js';
import { initConnect, loadProfiles, connectProfile, prefillProfile, getProfiles, setAutoConnect, forgetSecret } from './connect.js';
import { initHost, showHost, leaveHost, resetHost, adoptHostTerm, refreshHost } from './host.js';
import { commandPaletteItems } from './system.js';
import { initIdleGuard, openAuditLog, hostKeyTrustLabel } from './security.js';
import {
  initContainers, loadContainers, renderList, selectContainer, leaveContainer, resetContainers, resumeStats,
  availableActions, runAction, openTab, currentTab, CONTAINER_TABS, adoptContainerTerm, refreshContainer,
} from './containers.js';
import { closeAllTerminals, setTerminalFontSize } from './terminal.js';
import { unsavedWork } from './files.js';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || desktop?.platform === 'darwin';
const isMobile = () => matchMedia('(max-width: 800px)').matches;
let refreshTimer = null;

// ------------------------------------------------------------------ production servers
// A server marked as production gets a red marker everywhere, and every risky confirmation asks
// for its name to be typed (stored per saved connection, in this browser).
const serverName = (info = state.info) => (info ? info.label || info.hostname || info.host : '');
const isProduction = (key = state.info?.profileKey) => Boolean(key) && storage.get('sdc.production', []).includes(key);
setProductionCheck(() => (state.connected && isProduction() ? serverName() : null));
function applyProductionUi() {
  const on = state.connected && isProduction();
  document.documentElement.classList.toggle('is-production', on);
  let badge = $('#prod-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'prod-badge';
    badge.className = 'prod-badge';
    badge.innerHTML = `${icon('lock')}Production`;
    badge.title = 'Risky actions on this server ask you to type its name';
    $('#conn-title').after(badge);
  }
  badge.hidden = !on;
  if (state.connected) reportTab({ production: on });
}
async function setProduction(on) {
  const key = state.info?.profileKey;
  if (!key) return false;
  const name = serverName();
  const ok = on
    ? await confirmDialog({
        icon: 'lock',
        title: `Mark ${name} as a production server?`,
        message: 'It gets a red Production marker, and every risky action on it (stopping or removing containers, deleting files, running commands, changing the database, restoring…) asks you to type its name first.',
        confirmLabel: 'Mark as production',
      })
    : await confirmDialog({
        tone: 'warn',
        icon: 'lock',
        title: `Remove the production marker from ${name}?`,
        message: 'Risky actions will no longer ask for the server name.',
        typeToConfirm: name,
        production: false,
        confirmLabel: 'Remove marker',
      });
  if (!ok) return false;
  const list = storage.get('sdc.production', []).filter((k) => k !== key);
  if (on) list.push(key);
  storage.set('sdc.production', list);
  applyProductionUi();
  toast(on ? `${name} is marked as production` : `${name} is no longer marked as production`, 'success');
  return true;
}
let restoring = false;

hydrateIcons();
applyTheme();
enhanceSegsEverywhere();
enhanceSelectsEverywhere();
enhanceDatesEverywhere();
if (!isMac) $('#palette-kbd').textContent = 'Ctrl K';
if (desktop) $('#new-window-btn').hidden = false;

initConnect(onConnected);
initHost();
initContainers();
boot();

// ------------------------------------------------------------------ outdated server check

let serverChecked = false;
async function checkServer() {
  if (serverChecked) return;
  serverChecked = true;
  if (!(await serverOutdated())) return;
  const b = $('#server-banner');
  $('#server-banner-text').innerHTML = desktop
    ? '<strong>The app needs a restart.</strong> Its built-in server is running older code than this window, so some features (like Files) won\'t work. Quit the app (⌘Q) and open it again.'
    : '<strong>The console server is out of date.</strong> It was started before the app was updated and is still running the old code, so some features (like Files) won\'t work. Stop it (Ctrl+C in its terminal), run <code>npm start</code> again, then reload this page.';
  b.hidden = false;
}
$('#server-banner-close').addEventListener('click', () => ($('#server-banner').hidden = true));

async function boot() {
  ensureSocket().then(checkServer, () => {});
  // A reload of a connected page: pick the server-side session (and its open shells) back up.
  const token = tabSession.get('sdc.resume');
  if (token) {
    const info = await tryResume(token);
    if (info) {
      onConnected(info);
      document.documentElement.classList.remove('resuming');
      loadProfiles();
      return;
    }
    tabSession.remove('sdc.resume');
  }
  const auto = await loadProfiles();
  const manual = tabSession.get('sdc.manualDisconnect');
  // The session is gone (e.g. the console server restarted): log straight back in when the
  // password is saved; the last container and tab are restored as usual.
  const last = token && !manual ? getProfiles().profiles.find((p) => p.key === tabSession.get('sdc.lastProfile')) : null;
  document.documentElement.classList.remove('resuming');
  if (last?.hasSecret) {
    toast('Reconnecting…');
    return connectProfile(last.key);
  }
  if (last) {
    const box = $('#connect-error');
    box.hidden = false;
    box.textContent = 'Your previous session has ended. Enter the password to reconnect.';
  }
  const params = new URLSearchParams(location.search);
  // "Duplicate tab": connect to the same server (straight away when its password is saved).
  const dup = params.get('profile') && getProfiles().profiles.find((p) => p.key === params.get('profile'));
  if (dup) return dup.hasSecret ? connectProfile(dup.key) : prefillProfile(dup.key);
  const wantsAuto = params.get('auto') === '1';
  if (auto && wantsAuto && !manual) connectProfile(auto.key);
  else $('#connect-form').host.value ? null : $('#connect-form').host.focus();
}

/** Resume a session; retries briefly while the console server is unreachable. */
async function tryResume(token) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await ensureSocket();
    } catch {
      await sleep(400 * (attempt + 1));
      continue;
    }
    try {
      return await rpc('resume', { token });
    } catch (err) {
      if (/ended/i.test(err.message)) return null; // the server says the session is gone
      await sleep(300);
    }
  }
  return null;
}

// ------------------------------------------------------------------ connect / disconnect

function onConnected(info) {
  state.connected = true;
  state.info = info;
  tabSession.remove('sdc.manualDisconnect');
  if (info.resumeToken) tabSession.set('sdc.resume', info.resumeToken);
  if (info.profileKey) tabSession.set('sdc.lastProfile', info.profileKey);
  $('#connect-screen').hidden = true;
  $('#app').hidden = false;
  $('#app').classList.remove('entering');
  void $('#app').offsetWidth; // restart the entrance animation
  $('#app').classList.add('entering');
  const name = info.label || info.hostname || info.host;
  $('#conn-title').textContent = name;
  $('#conn-sub').textContent = `${info.username}@${info.host}:${info.port} · ${info.dockerVersion ? `Docker ${info.dockerVersion}` : 'Docker unavailable'}`;
  $('.conn-pill').title = info.fingerprint ? `Host key ${info.fingerprint}` : '';
  $('#host-name').textContent = name;
  $('#view-host .c-avatar.host').setAttribute('style', tileStyle(info.profileKey));
  $('#host-meta').innerHTML = [
    `${icon('user')} ${esc(info.username)}@${esc(info.host)}:${esc(info.port)}`,
    info.hostname && info.hostname !== name ? `${icon('server')} ${esc(info.hostname)}` : '',
    info.dockerVersion ? `${icon('docker')} Docker ${esc(info.dockerVersion)}` : '',
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join('');
  document.title = `${name} · ssh-console`;
  applyProductionUi();
  reportTab({ status: 'connected', title: name, sub: `${info.username}@${info.host}:${info.port}`, tile: tileStyle(info.profileKey), profileKey: info.profileKey || '' });

  renderDockerWarning(info);

  // Shells that survived a reload come back with their scrollback.
  for (const t of info.terms || []) {
    if (t.kind === 'host') adoptHostTerm(t);
    else if (t.kind === 'container') adoptContainerTerm(t);
  }

  restoring = true;
  showHostView('overview');
  if (isMobile() && !info.resumed) $('#sidebar').classList.add('open');
  animateIn($('#container-list'), 1600);
  loadContainers()
    .then(() => restoreSession(info.resumed))
    .finally(() => (restoring = false));
  if (info.resumed) toast('Session restored', 'success');
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => !document.hidden && loadContainers(true), 10000);
}

// ------------------------------------------------------------------ Docker permission problems

function renderDockerWarning(info) {
  const box = $('#docker-warning');
  box.hidden = !info.dockerError;
  if (!info.dockerError) return;
  const fx = info.dockerFix;
  if (!fx?.permissionDenied) {
    box.className = 'alert warn inset';
    box.textContent = `Docker isn't usable as "${info.dockerCmd}": ${info.dockerError}\nIs Docker installed and running on this server? The host terminal still works.`;
    return;
  }
  const user = esc(fx.user || info.username);
  const cmd = `sudo usermod -aG docker ${fx.user || info.username}`;
  const why = fx.inGroup
    ? `<code>${user}</code> is already in the <code>docker</code> group, but the Docker socket still refuses it, so the socket's permissions are probably wrong.`
    : `The user <code>${user}</code> isn't allowed to use Docker on this server. Only root and members of the <code>docker</code> group can.`;
  box.className = 'docker-fix inset';
  box.innerHTML = `
    <div class="df-head">
      <div class="modal-icon warn">${icon('lock')}</div>
      <div>
        <strong>Docker needs permission on this server</strong>
        <p>${why} Containers can't be listed until this is fixed. The host terminal still works.</p>
        ${fx.socket ? `<code class="df-socket">${esc(fx.socket)}</code>` : ''}
      </div>
    </div>
    <div class="df-options">
      ${
        fx.inGroup
          ? `<div class="df-opt"><div><strong>Fix the socket permissions</strong><span>Run in the Terminal tab: <code>sudo chown root:docker /var/run/docker.sock</code> (or restart Docker), then reconnect.</span></div>
             <button class="btn small" data-fix="reconnect">${icon('refresh')}Reconnect</button></div>`
          : `<div class="df-opt"><div><strong>Add ${user} to the docker group</strong><span>Recommended, one-time change. Runs <code>${esc(cmd)}</code> with sudo, then reconnects.</span></div>
             <button class="btn small primary" data-fix="group">${icon('zap')}Fix it</button></div>`
      }
      ${
        fx.sudoNoPassword
          ? `<div class="df-opt"><div><strong>Or use sudo for Docker</strong><span>${user} can run sudo without a password, so the app can run <code>sudo -n docker</code>. Saved for this server.</span></div>
             <button class="btn small" data-fix="sudo">Use sudo</button></div>`
          : ''
      }
      <div class="df-opt"><div><strong>Or do it yourself</strong><span>Run <code>${esc(cmd)}</code> in the Terminal tab, then reconnect.</span></div>
        <div class="df-btns"><button class="btn small ghost" data-fix="copy">${icon('copy')}Copy</button><button class="btn small ghost" data-fix="terminal">${icon('terminal')}Terminal</button><button class="btn small ghost" data-fix="reconnect">${icon('refresh')}Reconnect</button></div></div>
    </div>`;
  box.onclick = (e) => {
    const b = e.target.closest('[data-fix]');
    if (b) dockerFixAction(b.dataset.fix, info, cmd, b);
  };
}

async function dockerFixAction(action, info, cmd, btn) {
  if (action === 'copy') return copyText(cmd, 'Command copied');
  if (action === 'terminal') return showHostView('terminal');
  if (action === 'reconnect') return reconnect({}, 'Reconnecting…');
  if (action === 'sudo') return reconnect({ dockerCmd: 'sudo -n docker' }, 'Reconnecting with sudo…');
  if (action !== 'group') return;

  const user = info.dockerFix.user || info.username;
  const ok = await confirmDialog({
    tone: 'warn',
    icon: 'lock',
    title: `Add ${user} to the docker group?`,
    message:
      'This runs the command below with sudo on the server and then reconnects. Members of the docker group can control every container, which effectively gives them root access to the server.',
    detail: cmd,
    confirmLabel: 'Add and reconnect',
  });
  if (!ok) return;

  let password = info.dockerFix.hasLoginPassword ? '' : null;
  if (password === null) {
    password = await promptDialog({ title: 'Sudo password', message: `Enter the sudo password for ${user} on this server.`, type: 'password', confirmLabel: 'Continue' });
    if (password === null) return;
  }
  btn.disabled = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rpc('docker.fixAccess', { password });
      toast(`${user} was added to the docker group`, 'success');
      return reconnect({}, 'Reconnecting…');
    } catch (err) {
      if (!err.message.startsWith('SUDO_PASSWORD|')) {
        btn.disabled = false;
        return toast(err.message, true);
      }
      password = await promptDialog({
        title: 'Sudo password',
        message: attempt === 0 && info.dockerFix.hasLoginPassword ? `sudo didn't accept your login password. Enter the sudo password for ${user}.` : 'That password was not accepted. Try again.',
        type: 'password',
        confirmLabel: 'Continue',
      });
      if (password === null) {
        btn.disabled = false;
        return;
      }
    }
  }
  btn.disabled = false;
}

/** Log in again with the same credentials (new login = new group membership). */
async function reconnect(opts, label) {
  toast(label);
  try {
    const info = await rpc('reconnect', opts);
    resetContainers();
    resetHost();
    closeAllTerminals();
    onConnected(info);
    if (info.dockerError) toast(`Still no Docker access: ${info.dockerError.split('\n')[0]}`, 'warn');
    else toast(`Docker ${info.dockerVersion} is ready`, 'success');
  } catch (err) {
    toast(`Reconnect failed: ${err.message}`, true);
  }
}

function onDisconnected(message) {
  if (!state.connected && !message) return;
  state.connected = false;
  if (message) tabSession.remove('sdc.resume');
  clearInterval(refreshTimer);
  resetContainers();
  resetHost();
  closeAllTerminals();
  document.title = 'ssh-console';
  document.documentElement.classList.remove('is-production');
  reportTab({ status: message ? 'lost' : 'idle', production: false, title: 'New tab', sub: message || '', tile: '', profileKey: '' });
  $('#app').hidden = true;
  $('#connect-screen').hidden = false;
  animateIn($('#saved-list'));
  const errBox = $('#connect-error');
  errBox.hidden = !message;
  errBox.textContent = message || '';
  loadProfiles();
}

async function disconnect() {
  if (unsavedWork()) {
    const ok = await confirmDialog({
      tone: 'warn',
      icon: 'power',
      title: 'Disconnect now?',
      message: 'Uploads are still running or a file has unsaved changes. Disconnecting stops them.',
      confirmLabel: 'Disconnect',
    });
    if (!ok) return;
  }
  tabSession.set('sdc.manualDisconnect', '1');
  tabSession.remove('sdc.resume');
  tabSession.remove('sdc.lastProfile');
  try {
    await rpc('disconnect');
  } catch { /* ignore */ }
  onDisconnected();
}

/** Inactivity timeout: end the session without the usual questions (nothing unsaved is at stake). */
async function idleDisconnect(message) {
  tabSession.set('sdc.manualDisconnect', '1');
  tabSession.remove('sdc.resume');
  try {
    await rpc('disconnect');
  } catch { /* ignore */ }
  onDisconnected(message);
}
initIdleGuard({ disconnect: idleDisconnect, busy: () => unsavedWork() });

onStream('ssh:closed', () => onDisconnected('The SSH connection was closed.'));
onStream('ssh:error', (m) => toast(`SSH error: ${m.error}`, true));
// While the page is unloading (reload), a closing socket is expected: keep the resume token.
// (pagehide, not beforeunload: a beforeunload can still be cancelled.)
let unloading = false;
addEventListener('pagehide', () => (unloading = true));
addEventListener('pageshow', () => (unloading = false));
on('disconnected', (message) => {
  if (unloading) return;
  closeSocket();
  onDisconnected(message);
});
// Another tab or window (e.g. a duplicated tab) took this session over.
onStream('session:moved', () => {
  if (unloading) return;
  tabSession.remove('sdc.resume');
  closeSocket();
  onDisconnected('This session was opened in another tab or window. Connect again to use it here.');
});
// Leaving with uploads running or unsaved edits asks first (the desktop app shows a dialog).
addEventListener('beforeunload', (e) => {
  if (state.connected && unsavedWork()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ------------------------------------------------------------------ views + session restore

const uiKey = () => `sdc.ui.${state.info?.profileKey || 'default'}`;

on('nav', (d) => {
  if (!restoring && state.connected) storage.set(uiKey(), d);
});

function restoreSession(force = false) {
  if (!force && !prefs.get('restoreSession')) return showHost();
  const ui = storage.get(uiKey(), null);
  if (ui?.view === 'container') {
    const c = state.containers.find((x) => firstName(x.Names) === ui.name);
    if (c) return showContainerView(c.ID, ui.tab);
  }
  showHostView(ui?.view === 'host' ? ui.tab : 'overview');
}

function setView(view) {
  state.view = view;
  $('#view-host').hidden = view !== 'host';
  $('#view-container').hidden = view !== 'container';
  renderList();
}

function showHostView(tab) {
  leaveContainer();
  setView('host');
  showHost(tab);
  $('#sidebar').classList.remove('open');
}

function showContainerView(id, tab) {
  leaveHost();
  setView('container');
  selectContainer(id, tab);
  renderList();
  $('#sidebar').classList.remove('open');
}

on('show-host', () => showHostView());

/** ⌘R / Ctrl+R / F5: refresh what is on screen. The page is not reloaded, so nothing is lost. */
let lastSoftRefresh = 0;
function softRefresh() {
  if (!state.connected) return;
  const now = Date.now();
  if (now - lastSoftRefresh < 600) return;
  lastSoftRefresh = now;
  loadContainers(true);
  if (state.view === 'container') refreshContainer();
  else refreshHost();
  const btn = state.view === 'host' ? $('#host-refresh') : null;
  btn?.classList.add('spin');
  setTimeout(() => btn?.classList.remove('spin'), 700);
  toast('Refreshed', 'success');
}
desktop?.onSoftRefresh?.(softRefresh);
on('profiles', () => {
  if (!state.connected) return;
  $('#view-host .c-avatar.host').setAttribute('style', tileStyle(state.info.profileKey));
  renderList();
});
on('select-container', (d) => {
  const { id, tab } = typeof d === 'string' ? { id: d } : d;
  showContainerView(id, tab);
});

// ------------------------------------------------------------------ theme + settings

function resolvedTheme() {
  const t = prefs.get('theme');
  return t === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t;
}

function applyTheme() {
  const t = resolvedTheme();
  document.documentElement.dataset.theme = t;
  $('#theme-btn').innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
  $('#theme-btn').title = t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
const toggleTheme = () => {
  prefs.set('theme', resolvedTheme() === 'dark' ? 'light' : 'dark');
  withTransition(applyTheme);
};

function openSettings() {
  const p = prefs.all();
  const { profiles, canSaveSecrets, autoKey } = getProfiles();
  const key = state.info?.profileKey;
  const prof = profiles.find((x) => x.key === key);
  const seg = (name, opts, cur) =>
    `<div class="seg seg-sm" data-pref="${name}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(cur) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const sw = (name, on, attrs = '') => `<label class="switch"><input type="checkbox" data-pref="${name}" ${on ? 'checked' : ''} ${attrs}/><i></i></label>`;
  const mod = isMac ? '⌘' : 'Ctrl';
  const { el, close } = openModal({
    title: 'Settings',
    wide: true,
    content: `<div class="settings-grid">
      <div class="setting"><div><strong>Appearance</strong><span>Follow the system or pick a theme.</span></div>
        ${seg('theme', [['system', `${icon('monitor')}System`], ['light', `${icon('sun')}Light`], ['dark', `${icon('moon')}Dark`]], p.theme)}</div>
      <div class="setting"><div><strong>Terminal font size</strong><span>Applies to shells, database shells and logs.</span></div>
        ${seg('fontSize', [[12, '12'], [13, '13'], [14, '14'], [15, '15'], [16, '16']], p.fontSize)}</div>
      <div class="setting"><div><strong>Container alerts</strong><span>Notify when a container stops, keeps restarting or becomes unhealthy.</span></div>${sw('notify', p.notify)}</div>
      <div class="setting"><div><strong>Restore session</strong><span>Reopen the last container and tab when connecting to a server.</span></div>${sw('restoreSession', p.restoreSession)}</div>
      <div class="setting"><div><strong>Highlight log levels</strong><span>Colour ERROR, WARN, INFO and DEBUG in logs.</span></div>${sw('logLevels', p.logLevels)}</div>
      ${
        desktop && prof
          ? `<div class="setting"><div><strong>Auto-connect to this server</strong><span>${
              prof.hasSecret ? 'Connect to it automatically when the app opens.' : 'Save the password for this server first (tick "Remember" when connecting).'
            }</span></div>${sw('autoConnect', autoKey === key, prof.hasSecret && canSaveSecrets ? '' : 'disabled')}</div>`
          : ''
      }
      ${
        prof?.hasSecret
          ? `<div class="setting"><div><strong>Saved ${prof.authMode === 'key' ? 'key' : 'password'}</strong><span>Stored encrypted for ${esc(key)}.</span></div><button class="btn small danger-ghost" id="forget-secret">${icon('trash')}Forget</button></div>`
          : ''
      }
      <div class="settings-head">${icon('lock')} Security</div>
      ${
        state.info?.profileKey
          ? `<div class="setting"><div><strong>Production server</strong><span>Mark ${esc(serverName())} with a red Production badge, and ask for its name before any risky action.</span></div>${sw('production', isProduction())}</div>`
          : ''
      }
      <div class="setting"><div><strong>Disconnect when idle</strong><span>End the SSH session after this long without keyboard or mouse activity.</span></div>
        ${seg('idleMinutes', [[0, 'Never'], [15, '15m'], [30, '30m'], [60, '1h'], [240, '4h']], p.idleMinutes)}</div>
      ${
        state.info
          ? `<div class="setting"><div><strong>This server's identity</strong><span>${esc(hostKeyTrustLabel(state.info))}${state.info.fingerprint ? `<br><code class="fp">${esc(state.info.hostKeyType || '')} ${esc(state.info.fingerprint)}</code>` : ''}<br>${
              state.info.legacyAlgorithms ? 'Legacy algorithms allowed for this server.' : 'Modern algorithms only (no SHA-1, no CBC).'
            }</span></div></div>`
          : ''
      }
      <div class="setting"><div><strong>Activity log</strong><span>Connections, changes and commands, recorded on this computer. Never includes passwords, keys or file contents.</span></div><button class="btn small" id="open-audit">${icon('list')}View</button></div>
      <div class="setting"><div><strong>Keyboard shortcuts</strong><span>
        <kbd>${mod}</kbd> <kbd>K</kbd> command palette · <kbd>/</kbd> filter containers · <kbd>${mod}</kbd> <kbd>B</kbd> sidebar ·
        <kbd>⌥</kbd> <kbd>1</kbd>…<kbd>9</kbd> sections · <kbd>${mod}</kbd> <kbd>T</kbd> / <kbd>W</kbd> new / close tab · <kbd>${mod}</kbd> <kbd>1</kbd>…<kbd>9</kbd> tabs · <kbd>${mod}</kbd> <kbd>R</kbd> refresh view (the page is not reloaded) · <kbd>${mod}</kbd> <kbd>,</kbd> settings${desktop ? ` · <kbd>${mod}</kbd> <kbd>N</kbd> new window` : ''}
      </span></div></div>
    </div>`,
  });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pref] button[data-v]');
    if (b) {
      const name = b.parentElement.dataset.pref;
      const v = name === 'fontSize' || name === 'idleMinutes' ? Number(b.dataset.v) : b.dataset.v;
      prefs.set(name, v);
      $$('button', b.parentElement).forEach((x) => x.classList.toggle('active', x === b));
      if (name === 'theme') withTransition(applyTheme);
      if (name === 'fontSize') setTerminalFontSize(v);
    }
    if (e.target.closest('#open-audit')) {
      close();
      openAuditLog();
      return;
    }
    if (e.target.closest('#forget-secret')) {
      const ok = await confirmDialog({
        tone: 'warn',
        icon: 'key',
        title: `Forget the saved ${prof?.authMode === 'key' ? 'key' : 'password'}?`,
        message: 'It is deleted from this computer. You will have to type it again to connect, and auto-connect stops working.',
        facts: [['Connection', key]],
        confirmLabel: 'Forget',
      });
      if (!ok) return;
      await forgetSecret(key);
      toast('Saved credentials removed', 'success');
      close();
    }
  });
  el.addEventListener('change', async (e) => {
    const input = e.target.closest('input[data-pref]');
    if (!input) return;
    const name = input.dataset.pref;
    if (name === 'production') {
      if (!(await setProduction(input.checked))) input.checked = !input.checked;
      return;
    }
    if (name === 'autoConnect') {
      const ok = await confirmDialog({
        icon: 'plug',
        title: input.checked ? `Connect to ${key} automatically?` : 'Turn off auto-connect?',
        message: input.checked
          ? 'When the app opens, it connects to this server with the saved password straight away. Any other server set to auto-connect is replaced.'
          : 'The app will open on the connection screen.',
        confirmLabel: input.checked ? 'Turn on' : 'Turn off',
      });
      if (!ok) {
        input.checked = !input.checked;
        return;
      }
      await setAutoConnect(input.checked ? key : null);
      toast(input.checked ? 'This server will connect automatically when the app opens' : 'Auto-connect turned off', 'success');
      return;
    }
    prefs.set(name, input.checked);
    if (name === 'logLevels') $('#logs-levels').checked = input.checked;
    if (name === 'notify' && input.checked && !desktop && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  });
}

// ------------------------------------------------------------------ command palette

function paletteItems() {
  const items = [];
  const c = state.view === 'container' ? containerById(state.selected) : null;
  if (c) {
    const name = firstName(c.Names);
    for (const a of availableActions()) {
      items.push({ group: `${name}: actions`, label: `${a.label} container`, hint: name, icon: a.icon, run: () => runAction(a.action) });
    }
    for (const [tab, label, ic] of CONTAINER_TABS) {
      if (tab === 'database' && !dbEngineOf(c.Image)) continue;
      items.push({ group: `${name}: go to`, label, hint: tab === currentTab() ? 'current' : '', icon: ic, run: () => openTab(tab) });
    }
  }
  for (const x of [...state.containers].sort((a, b) => (b.State === 'running') - (a.State === 'running'))) {
    const eng = dbEngineOf(x.Image);
    items.push({
      group: 'Containers',
      label: firstName(x.Names),
      hint: `${x.State} · ${x.Image}`,
      keywords: eng || '',
      icon: eng ? 'database' : 'box',
      run: () => showContainerView(x.ID),
    });
    if (eng) items.push({ group: 'Databases', label: `${firstName(x.Names)} database console`, hint: eng, keywords: 'sql query db', icon: 'database', run: () => showContainerView(x.ID, 'database') });
  }
  const hostTabs = [['overview', 'Host overview', 'layers'], ['containers', 'Live stats for all containers', 'activity'], ['images', 'Images', 'image'], ['volumes', 'Volumes', 'drive'], ['networks', 'Networks', 'network'], ['database', 'Host database client', 'database'], ['files', 'Host files (gallery)', 'folder'], ['terminal', 'Host terminal', 'terminal'], ['services', 'Services (systemd)', 'settings', 'systemctl daemon unit start stop restart enable journal'], ['processes', 'Processes', 'cpu', 'ps top kill pid'], ['ports', 'Listening ports', 'plug', 'ss netstat socket open'], ['commands', 'Commands', 'zap', 'run snippet script']];
  for (const [tab, label, ic, keywords] of hostTabs) items.push({ group: 'Host', label, icon: ic, keywords, run: () => showHostView(tab) });
  items.push(...commandPaletteItems());
  items.push({ group: 'Host', label: 'Pull an image', icon: 'download', keywords: 'docker pull registry', run: () => (showHostView('images'), $('#images-pull').click()) });
  items.push(
    { group: 'App', label: 'Refresh view', hint: isMac ? '⌘R' : 'Ctrl+R', icon: 'refresh', run: softRefresh },
    { group: 'App', label: `Switch to ${resolvedTheme() === 'dark' ? 'light' : 'dark'} theme`, icon: resolvedTheme() === 'dark' ? 'sun' : 'moon', run: toggleTheme },
    { group: 'App', label: 'Settings', icon: 'settings', run: openSettings },
    { group: 'App', label: 'Activity log', icon: 'list', keywords: 'audit security history log', run: openAuditLog },
    { group: 'App', label: 'Toggle sidebar', icon: 'sidebar', run: toggleSidebar },
  );
  if (state.info?.profileKey) {
    items.push(
      isProduction()
        ? { group: 'Server', label: 'Remove production marker', hint: serverName(), icon: 'lock', run: () => setProduction(false) }
        : { group: 'Server', label: 'Mark as production server', hint: 'type the name before risky actions', icon: 'lock', keywords: 'protect safe guard', run: () => setProduction(true) },
    );
  }
  if (inTab) {
    items.push(
      { group: 'Tabs', label: 'New tab', hint: `${TAB_KEYS.new} · open another server alongside`, icon: 'plus', keywords: 'vm server session', run: () => tabCommand('new') },
      { group: 'Tabs', label: 'Duplicate tab', hint: 'another session to this server', icon: 'copy', run: () => tabCommand('duplicate') },
      { group: 'Tabs', label: 'Reopen closed tab', hint: TAB_KEYS.reopen, icon: 'restart', run: () => tabCommand('reopen') },
      { group: 'Tabs', label: 'Search tabs', hint: TAB_KEYS.search, icon: 'search', run: () => tabCommand('search') },
      { group: 'Tabs', label: 'Close tab', hint: TAB_KEYS.close, icon: 'x', run: () => tabCommand('close') },
    );
  }
  if (desktop) items.push({ group: 'App', label: 'New window', hint: 'connect to another server', icon: 'window', run: () => desktop.newWindow() });
  items.push({ group: 'App', label: 'Disconnect', icon: 'power', run: disconnect });
  return items;
}

// ------------------------------------------------------------------ chrome + shortcuts

function toggleSidebar() {
  if (isMobile()) $('#sidebar').classList.toggle('open');
  else {
    $('#sidebar').classList.toggle('collapsed');
    storage.set('sdc.sidebarCollapsed', $('#sidebar').classList.contains('collapsed'));
  }
}
if (storage.get('sdc.sidebarCollapsed', false)) $('#sidebar').classList.add('collapsed');

/** Compact view headers (host + container): hides meta/ports and shrinks actions so panels get more room. */
function setHeadCompact(on) {
  $('#main').classList.toggle('head-compact', on);
  $$('.head-toggle').forEach((b) => {
    b.setAttribute('aria-expanded', String(!on));
    b.title = on ? 'Expand header' : 'Collapse header (more room below)';
    b.setAttribute('aria-label', on ? 'Expand header' : 'Collapse header');
  });
  storage.set('sdc.headCompact', on);
}
setHeadCompact(storage.get('sdc.headCompact', false));
$$('.head-toggle').forEach((b) => b.addEventListener('click', () => setHeadCompact(!$('#main').classList.contains('head-compact'))));

$('#disconnect-btn').addEventListener('click', disconnect);
$('#host-shell-btn').addEventListener('click', () => showHostView('terminal'));
$('#sidebar-toggle').addEventListener('click', toggleSidebar);
$('#sidebar-scrim').addEventListener('click', () => $('#sidebar').classList.remove('open'));
$('#theme-btn').addEventListener('click', toggleTheme);
$('#settings-btn').addEventListener('click', openSettings);
$('#palette-btn').addEventListener('click', () => openPalette(paletteItems));
$('#new-window-btn').addEventListener('click', () => desktop?.newWindow());

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !state.connected) return;
  if (state.view === 'container') resumeStats();
  else showHost();
});

document.addEventListener('keydown', (e) => {
  if (!state.connected) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();
  // Reload keys refresh the view instead of reloading the page. (A focused terminal gets Ctrl+R
  // and F5 itself: xterm consumes them before they reach here.) Shift+⌘R still really reloads.
  if ((mod && key === 'r' && !e.shiftKey && !e.altKey) || (e.key === 'F5' && !e.shiftKey && !e.ctrlKey && !e.metaKey)) {
    e.preventDefault();
    if (!isModalOpen()) softRefresh();
    return;
  }
  if (isModalOpen()) return;
  const typing = e.target.closest('input, textarea, select');
  if (mod && key === 'k') {
    e.preventDefault();
    return openPalette(paletteItems);
  }
  if (mod && key === ',') {
    e.preventDefault();
    return openSettings();
  }
  if (mod && key === 'b') {
    e.preventDefault();
    return toggleSidebar();
  }
  // ⌥1…9 (Alt+1…9): this page's own sub-tabs. ⌘1…9 select browser-style tabs, as in Chrome.
  if (e.altKey && !e.metaKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code) && !(typing && !e.target.closest('.xterm'))) {
    const key = e.code.slice(5);
    const nav = state.view === 'container' ? '#c-tabs' : '#host-tabs';
    const btns = $$(`${nav} button[data-tab]`).filter((b) => !b.hidden);
    const b = btns[Number(key) - 1];
    if (b) {
      e.preventDefault();
      b.click();
    }
    return;
  }
  if (e.key === '/' && !typing && !e.target.closest('.xterm')) {
    e.preventDefault();
    if (isMobile()) $('#sidebar').classList.add('open');
    else $('#sidebar').classList.remove('collapsed');
    $('#filter').focus();
  }
});

// ------------------------------------------------------------------ as a tab of the tab bar

if (inTab) {
  // Chrome's tab shortcuts work wherever the focus is (terminal, editor, dialogs): ask the tab bar.
  installTabKeys(tabCommand, { fallbacks: !desktop, windows: !!desktop });
  // The tab bar asks before closing a tab that is uploading or has unsaved edits.
  window.__sdcBusy = () => state.connected && unsavedWork();
  if (!state.connected) reportTab({ status: 'idle', title: 'New tab', sub: '', tile: '', profileKey: '' });
}
// A theme picked in one tab applies to the tab bar and every other tab.
addEventListener('storage', (e) => {
  if (e.key === 'sdc.prefs') applyTheme();
});

emit('ready');
