// Security features in the page: disconnect after inactivity, and the activity (audit) log viewer.
import { $, esc, rpc, state, prefs, toast, downloadBlob } from './core.js';
import { icon } from './icons.js';
import { openModal } from './ui.js';

// ------------------------------------------------------------------ idle disconnect

let lastActivity = Date.now();
let warned = false;

/**
 * opts.disconnect(message): ends the SSH session; opts.busy(): true while uploads run or edits are
 * unsaved (then the session is kept and the user is told why).
 */
export function initIdleGuard(opts) {
  const touch = () => {
    lastActivity = Date.now();
    warned = false;
  };
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, touch, { capture: true, passive: true });
  setInterval(() => {
    const minutes = Number(prefs.get('idleMinutes')) || 0;
    if (!minutes || !state.connected) return touch();
    const idle = Date.now() - lastActivity;
    const limit = minutes * 60000;
    if (idle >= limit) {
      if (opts.busy()) {
        if (!warned) toast('Still connected despite inactivity: uploads are running or a file has unsaved changes', 'warn');
        warned = true;
        return;
      }
      touch();
      opts.disconnect(`Disconnected after ${minutes >= 60 ? `${minutes / 60} hour${minutes > 60 ? 's' : ''}` : `${minutes} minutes`} without activity. Connect again to continue.`);
    } else if (idle >= limit - 60000 && !warned) {
      warned = true;
      toast('No activity: disconnecting in 1 minute. Move the mouse or press a key to stay connected.', 'warn');
    }
  }, 15000);
}

// ------------------------------------------------------------------ activity log

const EVENT_LABEL = {
  connect: 'Connected',
  reconnect: 'Reconnected',
  disconnect: 'Disconnected',
  'docker.fixAccess': 'Docker access fix',
  action: 'Container action',
  actionMany: 'Container group action',
  'docker.imageRemove': 'Image removed',
  'docker.imagePrune': 'Images pruned',
  'files.write': 'File saved',
  'files.mkdir': 'Folder created',
  'files.rename': 'Renamed',
  'files.move': 'Moved',
  'files.remove': 'Deleted',
  download: 'Download',
  upload: 'Upload',
  'db.query': 'Database query',
  'sys.serviceAction': 'Service',
  'sys.kill': 'Process signalled',
  'sys.run': 'Command run',
  'sys.sudoCheck': 'sudo password entered',
  'profiles.delete': 'Saved connection deleted',
  'profiles.forgetSecret': 'Saved secret forgotten',
  'profiles.setAutoConnect': 'Auto-connect changed',
  'term:open': 'Terminal opened',
};
const SKIP = new Set(['t', 'user', 'ssh', 'event', 'ok', 'error']);
const TRUST = {
  pinned: 'pinned key',
  known_hosts: 'known_hosts',
  'accepted-new': 'new key trusted',
  'accepted-change': 'CHANGED key accepted',
};

function details(e) {
  const parts = [];
  for (const [k, v] of Object.entries(e)) {
    if (SKIP.has(k) || v === undefined || v === null || v === '' || v === false) continue;
    if (k === 'hostKeyTrust') parts.push(`<span class="al-tag${v === 'accepted-change' ? ' bad' : v === 'accepted-new' ? ' warn' : ''}">${esc(TRUST[v] || v)}</span>`);
    else parts.push(`<span class="al-k">${esc(k)}</span> ${esc(Array.isArray(v) ? v.join(', ') : v === true ? 'yes' : v)}`);
  }
  return parts.join(' · ');
}

export async function openAuditLog() {
  const { el } = openModal({
    title: 'Activity log',
    size: 'xl',
    content: `
      <p class="muted tiny al-intro">${icon('lock')} Kept on this computer, readable only by your user account. Passwords, keys, file contents and SQL text are never recorded.</p>
      <div class="toolbar al-bar">
        <div class="search-box sm">${icon('search')}<input type="search" placeholder="Filter by server, event or path" data-al-q /></div>
        <label class="check"><input type="checkbox" data-al-fail /> Failures only</label>
        <span class="spacer"></span>
        <button class="btn ghost small" data-al-export>${icon('download')}Export</button>
      </div>
      <div class="al-list"><div class="list-msg">Loading…</div></div>`,
  });
  let rows = [];
  try {
    rows = await rpc('audit.list', { limit: 2000 });
  } catch (err) {
    $('.al-list', el).innerHTML = `<div class="alert error inset">${esc(err.message)}</div>`;
    return;
  }
  const render = () => {
    const q = $('[data-al-q]', el).value.trim().toLowerCase();
    const failOnly = $('[data-al-fail]', el).checked;
    const shown = rows.filter((e) => (!failOnly || e.ok === false) && (!q || JSON.stringify(e).toLowerCase().includes(q))).slice(0, 500);
    $('.al-list', el).innerHTML = shown.length
      ? `<table class="tbl al-tbl"><thead><tr><th>When</th><th>Server</th><th>What</th><th>Details</th><th></th></tr></thead><tbody>${shown
          .map((e) => {
            const d = new Date(e.t);
            return `<tr class="${e.ok === false ? 'fail' : ''}">
              <td class="nowrap muted" title="${esc(e.t)} · ${esc(e.user)}">${esc(d.toLocaleDateString())} ${esc(d.toLocaleTimeString())}</td>
              <td class="mono tiny">${esc(e.ssh || '—')}</td>
              <td class="nowrap"><strong>${esc(EVENT_LABEL[e.event] || e.event)}</strong></td>
              <td class="al-details">${details(e)}${e.error ? `<div class="al-err">${esc(e.error)}</div>` : ''}</td>
              <td>${e.ok === false ? icon('error') : icon('check')}</td>
            </tr>`;
          })
          .join('')}</tbody></table>`
      : '<div class="list-msg">No activity recorded yet.</div>';
  };
  $('[data-al-q]', el).addEventListener('input', render);
  $('[data-al-fail]', el).addEventListener('change', render);
  $('[data-al-export]', el).addEventListener('click', () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadBlob(`ssh-console-activity-${stamp}.jsonl`, [...rows].reverse().map((r) => JSON.stringify(r)).join('\n') + '\n', 'application/x-ndjson');
    toast('Activity log exported', 'success');
  });
  render();
}

/** Human description of how the current server's host key is trusted. */
export function hostKeyTrustLabel(info) {
  return {
    pinned: 'Pinned: matches the key saved for this server',
    known_hosts: 'Matches your ~/.ssh/known_hosts',
    'accepted-new': 'Trusted on first use (confirmed by you)',
    'accepted-change': 'Changed key accepted by you',
  }[info?.hostKeyTrust] || '';
}
