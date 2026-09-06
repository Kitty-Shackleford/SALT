/*
 * public/js/serverControlPanel.js
 *
 * Client-side module for the Server Control Panel (/dashboard/server-control).
 * Loads server status from Nitrado and lets admins restart/start/stop the server.
 *
 * API used:
 *   GET  /api/control/:serverId/status
 *   POST /api/control/:serverId/restart|start|stop
 */

let currentServerId = null;
let pendingAction = null;
let csrfToken = null;

const STATUS_EMOJI = {
  started:    { icon: '🟢', label: 'Online',     color: 'text-green-400' },
  stopped:    { icon: '🔴', label: 'Offline',    color: 'text-red-400'   },
  restarting: { icon: '🟡', label: 'Restarting', color: 'text-yellow-400' },
  suspended:  { icon: '⚫', label: 'Suspended',  color: 'text-gray-400'  },
};

async function initCsrf() {
  const response = await fetch('/api/csrf-token');
  const data = await response.json();
  csrfToken = data.csrfToken;
  if (!response.ok || !csrfToken) throw new Error('Could not initialize request protection');
}

async function loadServers() {
  const select = document.getElementById('serverSelect');
  try {
    const res = await fetch('/api/nitrado/registered-servers');
    const data = await res.json();
    if (!data.success || !data.servers?.length) {
      select.innerHTML = '<option value="">No servers found</option>';
      return;
    }
    select.innerHTML = '<option value="">— Pick a server —</option>' +
      data.servers.map(s =>
        `<option value="${s.id}">${escHtml(s.server_name)} (${s.platform})</option>`
      ).join('');
    select.addEventListener('change', onServerChange);
  } catch (err) {
    select.innerHTML = '<option value="">Error loading servers</option>';
  }
}

async function onServerChange() {
  const select = document.getElementById('serverSelect');
  currentServerId = select.value || null;
  cancelConfirm();

  if (!currentServerId) {
    document.getElementById('statusCard').classList.add('hidden');
    document.getElementById('controlCard').classList.add('hidden');
    document.getElementById('serviceInfoCard').classList.add('hidden');
    document.getElementById('notificationsWrap').classList.add('hidden');
    return;
  }

  document.getElementById('statusCard').classList.remove('hidden');
  document.getElementById('controlCard').classList.remove('hidden');
  // Load status, service details, and notifications in parallel
  await Promise.all([loadStatus(), loadServiceInfo()]);
}

async function loadStatus() {
  if (!currentServerId) return;

  setStatusLoading();

  try {
    const res = await fetch(`/api/control/${currentServerId}/status`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    renderStatus(data);
  } catch (err) {
    document.getElementById('statusText').textContent = 'Error: ' + err.message;
    document.getElementById('statusIndicator').textContent = '❌';
  }
}

function setStatusLoading() {
  document.getElementById('statusIndicator').textContent = '⏳';
  document.getElementById('statusText').textContent = 'Loading…';
  document.getElementById('playerCount').textContent = '—';
  document.getElementById('mapName').textContent = '—';
  document.getElementById('serverVersion').textContent = '—';
  document.getElementById('lastChanged').textContent = '';
}

function renderStatus(data) {
  const info = STATUS_EMOJI[data.status] || { icon: '❓', label: data.status, color: 'text-gray-300' };

  document.getElementById('statusIndicator').textContent = info.icon;
  const statusEl = document.getElementById('statusText');
  statusEl.textContent = info.label;
  statusEl.className = 'text-sm font-semibold ' + info.color;

  document.getElementById('playerCount').textContent = `${data.playerCurrent} / ${data.playerMax}`;
  document.getElementById('mapName').textContent = data.map;
  document.getElementById('serverVersion').textContent = data.version;

  if (data.lastStatusChange) {
    // Nitrado may return Unix seconds (< 1e12) or milliseconds
    const ts = data.lastStatusChange < 1e12 ? data.lastStatusChange * 1000 : data.lastStatusChange;
    const d = new Date(ts);
    if (!isNaN(d)) {
      document.getElementById('lastChanged').textContent = 'Status last changed: ' + d.toLocaleString();
    }
  }

  // Disable start when already online; disable restart/stop when offline
  const online = data.status === 'started';
  document.getElementById('startBtn').disabled   = online;
  document.getElementById('restartBtn').disabled = !online;
  document.getElementById('stopBtn').disabled    = !online;
}

// Stage the action — show confirmation area before actually sending
function sendAction(action) {
  pendingAction = action;
  const msgs = {
    restart: '🔄 Are you sure you want to restart the server? Online players will be disconnected.',
    start:   '▶️ Are you sure you want to start the server?',
    stop:    '⏹️ Are you sure you want to stop the server? All online players will be disconnected.',
  };
  document.getElementById('confirmMsg').textContent = msgs[action] || `Confirm: ${action}?`;
  document.getElementById('confirmArea').classList.remove('hidden');
}

async function confirmAction() {
  if (!pendingAction || !currentServerId) return;
  const action = pendingAction;
  cancelConfirm();

  setButtonsDisabled(true);
  showBanner(`Sending ${action} command…`, 'info');

  try {
    const res = await fetch(`/api/control/${currentServerId}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CSRF-Token': csrfToken }
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    showBanner(`✅ ${data.message || action + ' initiated'}. Allow 1–3 minutes to take effect.`, 'success');
    // Reload status after a short delay to reflect the change
    setTimeout(loadStatus, 5000);
  } catch (err) {
    showBanner('❌ Error: ' + err.message, 'error');
  } finally {
    setButtonsDisabled(false);
  }
}

function cancelConfirm() {
  pendingAction = null;
  document.getElementById('confirmArea').classList.add('hidden');
}

function setButtonsDisabled(disabled) {
  ['restartBtn', 'startBtn', 'stopBtn'].forEach(id => {
    document.getElementById(id).disabled = disabled;
  });
}

function showBanner(msg, type) {
  const el = document.getElementById('statusBanner');
  el.textContent = msg;
  el.className = {
    success: 'mb-4 p-4 rounded-lg text-sm bg-green-800 text-green-100',
    error:   'mb-4 p-4 rounded-lg text-sm bg-red-800 text-red-100',
    info:    'mb-4 p-4 rounded-lg text-sm bg-blue-800 text-blue-100',
  }[type] || 'mb-4 p-4 rounded-lg text-sm bg-gray-700';
  el.classList.remove('hidden');
  if (type !== 'info') setTimeout(() => el.classList.add('hidden'), 7000);
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- Service Info: notifications + expiry widget ----

/**
 * Fetch service details and notifications in parallel, then render both.
 */
async function loadServiceInfo() {
  if (!currentServerId) return;

  try {
    const [detailsRes, notifRes] = await Promise.all([
      fetch(`/api/control/${currentServerId}/details`).then(r => r.json()),
      fetch(`/api/control/${currentServerId}/notifications`).then(r => r.json()),
    ]);

    if (detailsRes.success) renderServiceDetails(detailsRes);
    renderNotifications(notifRes.success ? (notifRes.notifications || []) : []);
  } catch (err) {
    console.warn('loadServiceInfo error:', err);
  }
}

/**
 * Render the expiry / subscription info card.
 */
function renderServiceDetails(data) {
  const card = document.getElementById('serviceInfoCard');
  card.classList.remove('hidden');

  // Days until suspension
  const daysEl = document.getElementById('expiryDays');
  const dateEl = document.getElementById('expiryDate');

  if (data.suspendingIn != null) {
    const days = Math.floor(data.suspendingIn / 86400);
    daysEl.textContent = days;
    // Colour-code urgency
    daysEl.className = 'text-4xl font-bold mb-1 ' + (
      days <= 7  ? 'text-red-400' :
      days <= 30 ? 'text-yellow-400' :
                   'text-green-400'
    );
  } else {
    daysEl.textContent = '?';
    daysEl.className = 'text-4xl font-bold mb-1 text-gray-400';
  }

  if (data.suspendDate) {
    try {
      dateEl.textContent = new Date(data.suspendDate).toLocaleDateString('en-GB', { dateStyle: 'medium' });
    } catch { dateEl.textContent = data.suspendDate; }
  }

  // Auto-extension badge
  const autoEl = document.getElementById('autoExtBadge');
  if (data.autoExtension) {
    autoEl.innerHTML = '<span class="bg-green-700 text-green-100 px-3 py-1 rounded-full text-sm font-semibold">✅ ON</span>';
  } else {
    autoEl.innerHTML = '<span class="bg-red-900 text-red-200 px-3 py-1 rounded-full text-sm font-semibold">❌ OFF</span>';
  }

  document.getElementById('gameType').textContent = data.game || '—';
  document.getElementById('serverAddress').textContent = data.address || '';
}

/**
 * Render service notification banners above the status card.
 * SEVERE → red, WARNING → yellow, INFO → blue. Dismissible.
 */
function renderNotifications(notifications) {
  const wrap = document.getElementById('notificationsWrap');

  if (!notifications.length) {
    wrap.classList.add('hidden');
    wrap.innerHTML = '';
    return;
  }

  const SEVERITY_STYLE = {
    SEVERE:  'bg-red-900 border border-red-600 text-red-100',
    WARNING: 'bg-yellow-900 border border-yellow-600 text-yellow-100',
    INFO:    'bg-blue-900 border border-blue-600 text-blue-100',
  };
  const SEVERITY_ICON = { SEVERE: '🚨', WARNING: '⚠️', INFO: 'ℹ️' };

  wrap.innerHTML = notifications.map((n, i) => {
    const sev = (n.severity || 'INFO').toUpperCase();
    const cls = SEVERITY_STYLE[sev] || SEVERITY_STYLE.INFO;
    const icon = SEVERITY_ICON[sev] || 'ℹ️';
    return `
      <div id="notif-${i}" class="flex items-start justify-between p-4 rounded-lg ${cls}">
        <span>${icon} <strong>${escHtml(sev)}:</strong> ${escHtml(n.message || n.title || JSON.stringify(n))}</span>
        <button data-dismiss-notification="notif-${i}"
          class="ml-4 text-lg leading-none opacity-60 hover:opacity-100 flex-shrink-0">✕</button>
      </div>`;
  }).join('');

  wrap.classList.remove('hidden');
}

document.getElementById('notificationsWrap').addEventListener('click', event => {
  const button = event.target.closest('button[data-dismiss-notification]');
  if (button) document.getElementById(button.dataset.dismissNotification)?.remove();
});

// Init
(async () => {
  document.getElementById('refreshStatusBtn').addEventListener('click', loadStatus);
  document.querySelectorAll('button[data-server-action]').forEach(button => {
    button.addEventListener('click', () => sendAction(button.dataset.serverAction));
  });
  document.getElementById('confirmYes').addEventListener('click', confirmAction);
  document.getElementById('confirmCancel').addEventListener('click', cancelConfirm);
  await Promise.all([initCsrf(), loadServers()]);
})();
