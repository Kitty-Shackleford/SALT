/*
 * public/js/backupManager.js
 *
 * Client-side module for the Backup Manager page (/dashboard/backups).
 * Lists Nitrado gameserver and database backups; lets admins restore them
 * with a confirmation modal before the destructive action is sent.
 *
 * API used:
 *   GET  /api/backups/:serverId              — list all backups
 *   POST /api/backups/:serverId/gameserver   — restore gameserver backup
 *   POST /api/backups/:serverId/database     — restore database backup
 */

let currentServerId = null;
let csrfToken = null;
let pendingRestore = null; // { type: 'gameserver'|'database', payload: {} }

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
  currentServerId = document.getElementById('serverSelect').value || null;
  if (!currentServerId) {
    document.getElementById('gameserverBackupsWrap').innerHTML = '<p class="text-gray-400">Select a server to view backups.</p>';
    document.getElementById('databaseBackupsWrap').innerHTML   = '<p class="text-gray-400">Select a server to view database backups.</p>';
    return;
  }
  await loadBackups();
}

async function loadBackups() {
  if (!currentServerId) return;

  document.getElementById('gameserverBackupsWrap').innerHTML = '<p class="text-gray-400 animate-pulse">Loading…</p>';
  document.getElementById('databaseBackupsWrap').innerHTML   = '<p class="text-gray-400 animate-pulse">Loading…</p>';

  try {
    const res = await fetch(`/api/backups/${currentServerId}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    renderBackups(data.backups);
  } catch (err) {
    const msg = escHtml(err.message);
    document.getElementById('gameserverBackupsWrap').innerHTML = `<p class="text-red-400">Error: ${msg}</p>`;
    document.getElementById('databaseBackupsWrap').innerHTML   = '';
  }
}

function renderBackups(backups) {
  renderGameserverBackups(backups.gameserver || {});
  renderDatabaseBackups(backups.database || {});
}

// Gameserver backups: grouped by map/folder name
function renderGameserverBackups(gsBackups) {
  const wrap = document.getElementById('gameserverBackupsWrap');
  const folders = Object.keys(gsBackups);

  if (!folders.length) {
    wrap.innerHTML = '<p class="text-gray-400">No gameserver backups found.</p>';
    return;
  }

  let html = '';
  for (const folder of folders) {
    const entries = gsBackups[folder];
    // Sort by timestamp descending (newest first)
    entries.sort((a, b) => b.backup_timestamp - a.backup_timestamp);

    const rows = entries.map(b => {
      const date = new Date(b.backup_timestamp * 1000).toLocaleString();
      const sizeMb = b.backup_size ? (b.backup_size / 1048576).toFixed(1) + ' MB' : '—';
      return `
        <tr class="border-b border-gray-700 hover:bg-gray-750">
          <td class="py-3 px-4 text-sm">${escHtml(date)}</td>
          <td class="py-3 px-4 text-sm">${escHtml(b.backup_type || '—')}</td>
          <td class="py-3 px-4 text-sm text-gray-300">${escHtml(sizeMb)}</td>
          <td class="py-3 px-4 text-sm text-gray-400">#${b.backup_number ?? '—'}</td>
          <td class="py-3 px-4">
            <button data-restore-type="gameserver" data-folder="${escHtml(folder)}" data-backup="${escHtml(String(b.backup_timestamp))}"
              class="bg-red-700 hover:bg-red-600 px-3 py-1 rounded text-xs font-semibold">
              Restore
            </button>
          </td>
        </tr>`;
    }).join('');

    html += `
      <div class="mb-6">
        <h3 class="text-lg font-semibold mb-2 text-blue-300">📁 ${escHtml(folder)}</h3>
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead>
              <tr class="text-gray-400 text-xs border-b border-gray-700">
                <th class="pb-2 px-4">Date</th>
                <th class="pb-2 px-4">Type</th>
                <th class="pb-2 px-4">Size</th>
                <th class="pb-2 px-4">No.</th>
                <th class="pb-2 px-4">Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  wrap.innerHTML = html;
}

// Database backups: grouped by database name
function renderDatabaseBackups(dbBackups) {
  const wrap = document.getElementById('databaseBackupsWrap');
  const dbs = Object.keys(dbBackups);

  if (!dbs.length) {
    wrap.innerHTML = '<p class="text-gray-400">No database backups found.</p>';
    return;
  }

  let html = '';
  for (const dbName of dbs) {
    const entries = dbBackups[dbName];
    entries.sort((a, b) => b.backup_timestamp - a.backup_timestamp);

    const rows = entries.map(b => {
      const date = new Date(b.backup_timestamp * 1000).toLocaleString();
      const sizeMb = b.backup_size ? (b.backup_size / 1048576).toFixed(1) + ' MB' : '—';
      return `
        <tr class="border-b border-gray-700">
          <td class="py-3 px-4 text-sm">${escHtml(date)}</td>
          <td class="py-3 px-4 text-sm text-gray-300">${escHtml(sizeMb)}</td>
          <td class="py-3 px-4">
            <button data-restore-type="database" data-database="${escHtml(dbName)}" data-timestamp="${escHtml(String(b.backup_timestamp))}"
              class="bg-red-700 hover:bg-red-600 px-3 py-1 rounded text-xs font-semibold">
              Restore
            </button>
          </td>
        </tr>`;
    }).join('');

    html += `
      <div class="mb-6">
        <h3 class="text-lg font-semibold mb-2 text-blue-300">🗃️ ${escHtml(dbName)}</h3>
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead>
              <tr class="text-gray-400 text-xs border-b border-gray-700">
                <th class="pb-2 px-4">Date</th>
                <th class="pb-2 px-4">Size</th>
                <th class="pb-2 px-4">Action</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  wrap.innerHTML = html;
}

// Show confirmation modal before sending a destructive restore
function promptRestore(type, payload) {
  pendingRestore = { type, payload };
  const label = type === 'gameserver'
    ? `gameserver backup from <strong>${new Date(payload.backup * 1000).toLocaleString()}</strong> (folder: ${escHtml(payload.folder)})`
    : `database backup from <strong>${new Date(payload.timestamp * 1000).toLocaleString()}</strong> (database: ${escHtml(payload.database)})`;
  document.getElementById('confirmModalMsg').innerHTML = `You are about to restore the ${label}.`;
  document.getElementById('confirmModal').classList.remove('hidden');
  document.getElementById('confirmModalYes').onclick = executeRestore;
}

function closeModal() {
  pendingRestore = null;
  document.getElementById('confirmModal').classList.add('hidden');
}

async function executeRestore() {
  if (!pendingRestore || !currentServerId) return;
  const { type, payload } = pendingRestore;
  closeModal();

  showBanner(`Sending ${type} restore command…`, 'info');

  const url = `/api/backups/${currentServerId}/${type}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CSRF-Token': csrfToken },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    showBanner(`✅ ${data.message || 'Restore initiated'}. The server will restart automatically.`, 'success');
  } catch (err) {
    showBanner('❌ Restore failed: ' + err.message, 'error');
  }
}

// Close modal if clicking outside it
document.getElementById('confirmModal').addEventListener('click', function (e) {
  if (e.target === this) closeModal();
});
document.addEventListener('click', event => {
  const button = event.target.closest('button[data-restore-type]');
  if (!button) return;
  const type = button.dataset.restoreType;
  const payload = type === 'gameserver'
    ? { folder: button.dataset.folder, backup: button.dataset.backup }
    : { database: button.dataset.database, timestamp: button.dataset.timestamp };
  promptRestore(type, payload);
});

function showBanner(msg, type) {
  const el = document.getElementById('statusBanner');
  el.textContent = msg;
  el.className = {
    success: 'mb-4 p-4 rounded-lg text-sm bg-green-800 text-green-100',
    error:   'mb-4 p-4 rounded-lg text-sm bg-red-800 text-red-100',
    info:    'mb-4 p-4 rounded-lg text-sm bg-blue-800 text-blue-100',
  }[type] || 'mb-4 p-4 rounded-lg text-sm bg-gray-700';
  el.classList.remove('hidden');
  if (type !== 'info') setTimeout(() => el.classList.add('hidden'), 8000);
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Init
(async () => {
  document.getElementById('refreshBackupsBtn').addEventListener('click', loadBackups);
  document.getElementById('confirmModalCancel').addEventListener('click', closeModal);
  await Promise.all([initCsrf(), loadServers()]);
})();
