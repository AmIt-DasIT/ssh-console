// Login screen: saved connection cards (with optional encrypted passwords in the Mac app), the
// connection form, auto-connect and host-key change handling.
import { $, $$, esc, rpc, ensureSocket, relTime, desktop, toast, tileStyle, assignTiles, emit, reportTab, state } from './core.js';
import { icon } from './icons.js';
import { confirmDialog } from './ui.js';

let authMode = 'password';
let profiles = [];
let canSaveSecrets = false;
let autoKey = null;
let selectedKey = null;
let onConnectedCb = null;

const form = () => $('#connect-form');
const keyOf = (username, host, port) => `${username}@${host}:${Number(port) || 22}`;

export function initConnect(onConnected) {
  onConnectedCb = onConnected;
  const f = form();

  $$('.seg [data-auth]', f).forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.auth)));
  $('#key-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) f.privateKey.value = await file.text();
    e.target.value = '';
  });
  $('#form-new').addEventListener('click', () => resetForm());

  $('#saved-list').addEventListener('click', onSavedClick);
  $('#saved-list').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.classList.contains('saved-card')) e.target.click();
  });

  f.addEventListener('submit', (e) => {
    e.preventDefault();
    submitForm();
  });
}

/** Load saved profiles from the server. Returns the auto-connect profile (if usable). */
export async function loadProfiles() {
  try {
    await ensureSocket();
    const r = await rpc('profiles.list');
    profiles = r.profiles || [];
    canSaveSecrets = !!r.canSaveSecrets;
    autoKey = r.autoConnect;
  } catch {
    profiles = [];
  }
  assignTiles(profiles.map((p) => p.key));
  const first = !loadProfiles.done;
  loadProfiles.done = true;
  renderProfiles();
  if (first) {
    const list = $('#saved-list');
    list.classList.add('animate-in');
    setTimeout(() => list.classList.remove('animate-in'), 1400);
  }
  updateRememberUi();
  if (profiles[0] && !selectedKey && !form().host.value) fill(profiles[0]);
  emit('profiles');
  const auto = profiles.find((p) => p.key === autoKey);
  return auto && auto.hasSecret ? auto : null;
}

export const getProfiles = () => ({ profiles, canSaveSecrets, autoKey });

export async function connectProfile(key) {
  const p = profiles.find((x) => x.key === key);
  if (p) fill(p);
  return doConnect({ profileKey: key });
}

/** Fill the form for a saved connection without connecting (its password isn't saved). */
export function prefillProfile(key) {
  const p = profiles.find((x) => x.key === key);
  if (!p) return;
  fill(p);
  form().password?.focus();
}

export async function setAutoConnect(key) {
  autoKey = await rpc('profiles.setAutoConnect', { key });
  renderProfiles();
  return autoKey;
}

export async function forgetSecret(key) {
  await rpc('profiles.forgetSecret', { key });
  await loadProfiles();
}

// ------------------------------------------------------------------ form

function setAuthMode(mode) {
  authMode = mode;
  $$('.seg [data-auth]', form()).forEach((b) => b.classList.toggle('active', b.dataset.auth === mode));
  $$('[data-auth-panel]', form()).forEach((p) => (p.hidden = p.dataset.authPanel !== mode));
  updateRememberUi();
}

function updateRememberUi() {
  const f = form();
  const what = authMode === 'key' ? 'private key' : 'password';
  f.remember.disabled = !canSaveSecrets;
  $('#remember-label').textContent = canSaveSecrets ? `Remember ${what} (encrypted in your Keychain)` : `Remember ${what} (available in the Mac app)`;
  $('#remember-wrap').classList.toggle('muted', !canSaveSecrets);
  $('#auto-wrap').hidden = !desktop || !canSaveSecrets;
  const p = profiles.find((x) => x.key === selectedKey);
  f[authMode === 'key' ? 'privateKey' : 'password'].placeholder = p?.hasSecret && p.authMode === authMode ? 'Saved (leave empty to use it)' : '';
  $('#connect-note').textContent = desktop
    ? 'Everything runs locally in this app. Nothing is sent anywhere except to your server over SSH.'
    : 'Credentials go only to this local server and are kept in memory for the session.';
}

function fill(p) {
  const f = form();
  selectedKey = p.key;
  f.label.value = p.label || '';
  f.host.value = p.host || '';
  f.port.value = p.port || 22;
  f.username.value = p.username || '';
  f.dockerCmd.value = p.dockerCmd || 'docker';
  f.legacyAlgorithms.checked = !!p.legacyAlgorithms;
  f.password.value = '';
  f.privateKey.value = '';
  f.passphrase.value = '';
  f.remember.checked = !!p.hasSecret;
  f.autoConnect.checked = autoKey === p.key;
  setAuthMode(p.authMode || 'password');
  $('#form-title').textContent = p.label || p.host;
  $('#form-new').hidden = false;
  renderProfiles();
}

function resetForm() {
  const f = form();
  selectedKey = null;
  f.reset();
  f.port.value = 22;
  f.dockerCmd.value = 'docker';
  setAuthMode('password');
  $('#form-title').textContent = 'New connection';
  $('#form-new').hidden = true;
  $('#connect-error').hidden = true;
  renderProfiles();
  f.host.focus();
}

function submitForm() {
  const f = form();
  const payload = {
    label: f.label.value.trim(),
    host: f.host.value.trim(),
    port: f.port.value,
    username: f.username.value.trim(),
    dockerCmd: f.dockerCmd.value.trim() || 'docker',
    legacyAlgorithms: f.legacyAlgorithms.checked,
  };
  if (authMode === 'password') {
    if (f.password.value) payload.password = f.password.value;
  } else if (f.privateKey.value.trim()) {
    payload.privateKey = f.privateKey.value;
    payload.passphrase = f.passphrase.value;
  }
  const key = keyOf(payload.username, payload.host, payload.port);
  const existing = profiles.find((p) => p.key === key);
  // Nothing typed but a secret is saved for this server: use it.
  if (!payload.password && !payload.privateKey && existing?.hasSecret) payload.profileKey = key;
  if (!payload.password && !payload.privateKey && !payload.profileKey) {
    showError(authMode === 'key' ? 'Paste or load a private key.' : 'Enter the password.');
    return;
  }
  if (canSaveSecrets) payload.remember = f.remember.checked;
  return doConnect(payload, { autoConnect: f.autoConnect.checked });
}

function showError(text) {
  const box = $('#connect-error');
  box.textContent = text;
  box.hidden = !text;
}

function setBusy(busy, label = 'Connecting…') {
  const btn = $('#connect-btn');
  btn.disabled = busy;
  btn.innerHTML = busy ? `${icon('refresh', 'spinning')}<span>${esc(label)}</span>` : `${icon('plug')}<span>Connect</span>`;
  btn.classList.toggle('busy', busy);
}

async function doConnect(payload, { autoConnect } = {}) {
  showError('');
  setBusy(true);
  const label = payload.profileKey ? profiles.find((p) => p.key === payload.profileKey)?.label || payload.profileKey.split('@').pop() : payload.label || payload.host;
  reportTab({ status: 'connecting', title: label || 'Connecting…', sub: 'Connecting…', tile: '' });
  try {
    await ensureSocket();
    const info = await rpc('connect', payload);
    const f = form();
    f.password.value = '';
    f.passphrase.value = '';
    if (desktop && canSaveSecrets && autoConnect !== undefined) {
      if (autoConnect && (payload.remember || payload.profileKey)) await setAutoConnect(info.profileKey);
      else if (!autoConnect && autoKey === info.profileKey) await setAutoConnect(null);
    }
    if (info.saveError) toast(`Connected, but the connection could not be saved: ${info.saveError}`, 'warn');
    selectedKey = info.profileKey;
    onConnectedCb(info);
    loadProfiles();
  } catch (err) {
    if (err.message.startsWith('HOSTKEY_UNKNOWN|')) {
      const [, fp, type] = err.message.split('|');
      const where = `${payload.host || 'this server'}${payload.port && Number(payload.port) !== 22 ? `:${payload.port}` : ''}`;
      const ok = await confirmDialog({
        tone: 'primary',
        icon: 'lock',
        title: `First connection to ${where}`,
        message:
          'ssh-console has not seen this server before. Check that the fingerprint below matches the server, for example by running ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub on it, or ask its administrator. Nothing has been sent to the server yet.',
        detail: `${type}\n${fp}`,
        confirmLabel: 'Trust and connect',
      });
      if (ok) return doConnect({ ...payload, acceptHostKey: fp }, { autoConnect });
      showError('Not connected: the server was not trusted.');
      return;
    }
    if (err.message.startsWith('HOSTKEY_REVOKED|')) {
      const [, fp, file] = err.message.split('|');
      showError(`Refused: this server's host key (${fp}) is marked as revoked in ${file}. Nothing was sent to the server.`);
      return;
    }
    if (err.message.startsWith('HOSTKEY_CHANGED|')) {
      const [, oldFp, newFp, source] = err.message.split('|');
      const ok = await confirmDialog({
        tone: 'danger',
        icon: 'alert',
        title: "The server's identity has changed",
        message:
          `Its SSH host key is different from the one in ${source === 'saved connection' ? 'your saved connection' : source}. That is expected after a server reinstall, but it can also mean someone is intercepting the connection. Only continue if you know why it changed. Nothing was sent to the server.`,
        detail: `Expected: ${oldFp}\nNow:      ${newFp}`,
        confirmLabel: 'Trust the new key and connect',
      });
      if (ok) return doConnect({ ...payload, acceptHostKey: newFp }, { autoConnect });
      showError('Not connected: the host key changed.');
      return;
    }
    showError(err.message);
    // A saved profile whose password no longer works: let the user type it.
    if (payload.profileKey) {
      const p = profiles.find((x) => x.key === payload.profileKey);
      if (p) fill(p);
      form()[authMode === 'key' ? 'privateKey' : 'password'].focus();
    }
  } finally {
    setBusy(false);
    if (!state.connected) reportTab({ status: 'idle', title: 'New tab', sub: '', tile: '', profileKey: '' });
  }
}

// ------------------------------------------------------------------ saved cards

function renderProfiles() {
  $('#saved-wrap').hidden = !profiles.length;
  $('#saved-empty').hidden = profiles.length > 0;
  $('#saved-count').textContent = profiles.length;
  $('#saved-list').innerHTML = profiles
    .map((p, i) => {
      const isAuto = autoKey === p.key;
      const keyAuth = p.authMode === 'key';
      const secretTag = `<span class="sc-tag${p.hasSecret ? ' on' : ''}">${icon(keyAuth ? 'key' : 'lock')}${
        p.hasSecret ? (keyAuth ? 'Key saved' : 'Password saved') : keyAuth ? 'Key needed' : 'Password needed'
      }</span>`;
      return `<div class="saved-card${p.key === selectedKey ? ' selected' : ''}" data-key="${esc(p.key)}" role="button" tabindex="0"
          style="--i:${i};${tileStyle(p.key)}" title="${p.hasSecret ? 'Click to connect' : 'Click to fill in the form'}">
        <div class="sc-avatar">${icon('server')}</div>
        <div class="sc-main">
          <strong>${esc(p.label || p.host)}</strong>
          <div class="sc-addr">${esc(p.key)}</div>
        </div>
        <div class="sc-tags">
          ${secretTag}
          ${isAuto ? `<span class="sc-tag on">${icon('zap')}Auto</span>` : ''}
          ${p.lastUsed ? `<span class="sc-tag">${icon('clock')}${esc(relTime(new Date(p.lastUsed)))}</span>` : ''}
        </div>
        <div class="sc-actions">
          <button type="button" class="icon-btn" data-act="edit" title="Edit">${icon('edit')}</button>
          <button type="button" class="icon-btn" data-act="delete" title="Delete">${icon('trash')}</button>
        </div>
        <span class="sc-go">${icon('chevronRight')}</span>
      </div>`;
    })
    .join('');
}

async function onSavedClick(e) {
  const card = e.target.closest('.saved-card');
  if (!card) return;
  const p = profiles.find((x) => x.key === card.dataset.key);
  if (!p) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'delete') {
    const ok = await confirmDialog({
      tone: 'danger',
      title: `Delete "${p.label || p.host}"?`,
      message: 'The saved connection and any saved password or key are removed from this computer.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await rpc('profiles.delete', { key: p.key });
    if (selectedKey === p.key) resetForm();
    await loadProfiles();
    return;
  }
  if (act === 'edit' || !p.hasSecret) {
    fill(p);
    if (!p.hasSecret) form()[p.authMode === 'key' ? 'privateKey' : 'password'].focus();
    return;
  }
  connectProfile(p.key);
}
