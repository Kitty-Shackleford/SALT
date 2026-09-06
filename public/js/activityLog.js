/*
 * public/js/activityLog.js
 *
 * Client-side module for the Service Activity Log page (/dashboard/activity-log).
 * Displays paginated Nitrado service logs in a filterable table.
 *
 * API endpoint used:
 *   GET /api/activity/:serverId?page=N
 */

let currentServerId = null;
let currentPage = 1;
let totalPages = 1;

function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function showBanner(msg, type = 'error') {
  const el = document.getElementById('statusBanner');
  el.className = `mb-4 p-4 rounded-lg text-sm ${type === 'error' ? 'bg-red-900 text-red-200 border border-red-700' : 'bg-blue-900 text-blue-200 border border-blue-700'}`;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideBanner() {
  document.getElementById('statusBanner').classList.add('hidden');
}

// Populate the server dropdown
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
      data.servers.map(s => `<option value="${s.id}">${escHtml(s.server_name)} (${s.platform})</option>`).join('');
    select.addEventListener('change', onServerChange);
  } catch (err) {
    select.innerHTML = '<option value="">Error loading servers</option>';
    console.error('loadServers error:', err);
  }
}

async function onServerChange() {
  currentServerId = document.getElementById('serverSelect').value || null;
  currentPage = 1;
  if (!currentServerId) {
    document.getElementById('logWrap').innerHTML = '<p class="text-gray-400">Select a server to view its activity log.</p>';
    return;
  }
  await loadLogs();
}

// Severity → badge colour map
const SEVERITY_CLASS = {
  info:    'bg-blue-800 text-blue-200',
  warning: 'bg-yellow-800 text-yellow-200',
  error:   'bg-red-800 text-red-200',
  debug:   'bg-gray-700 text-gray-300',
};

function severityBadge(sev) {
  const cls = SEVERITY_CLASS[sev] || 'bg-gray-700 text-gray-300';
  return `<span class="inline-block px-2 py-0.5 rounded text-xs font-semibold ${cls}">${escHtml(sev || 'info')}</span>`;
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'medium' });
  } catch {
    return iso;
  }
}

async function loadLogs(page = 1) {
  if (!currentServerId) return;
  hideBanner();
  currentPage = page;

  document.getElementById('logWrap').innerHTML = '<p class="text-gray-400 animate-pulse">Loading logs…</p>';

  try {
    const res = await fetch(`/api/activity/${currentServerId}?page=${page}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    totalPages = data.pageCount || 1;
    renderTable(data);
  } catch (err) {
    showBanner(`Failed to load logs: ${err.message}`);
    document.getElementById('logWrap').innerHTML = '<p class="text-gray-400">Could not load activity log.</p>';
  }
}

function renderTable(data) {
  const { logs, currentPage: pg, pageCount, logCount } = data;

  if (!logs || !logs.length) {
    document.getElementById('logWrap').innerHTML = '<p class="text-gray-400">No log entries found.</p>';
    return;
  }

  const rows = logs.map(log => `
    <tr class="border-t border-gray-700 hover:bg-gray-750">
      <td class="px-4 py-2 text-xs text-gray-400 whitespace-nowrap">${escHtml(formatDate(log.created_at))}</td>
      <td class="px-4 py-2">${severityBadge(log.severity)}</td>
      <td class="px-4 py-2">
        <span class="bg-gray-700 text-gray-300 px-2 py-0.5 rounded text-xs">${escHtml(log.category || '')}</span>
      </td>
      <td class="px-4 py-2 text-xs text-gray-400">${escHtml(log.user || '—')}</td>
      <td class="px-4 py-2 text-sm">${escHtml(log.message || '')}</td>
    </tr>
  `).join('');

  // Pagination controls
  const pages = `
    <div class="flex items-center gap-3">
      <button data-log-page="${pg - 1}" ${pg <= 1 ? 'disabled' : ''}
        class="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 px-3 py-1 rounded text-sm">← Prev</button>
      <span class="text-sm text-gray-400">Page ${pg} of ${pageCount} (${logCount.toLocaleString()} total)</span>
      <button data-log-page="${pg + 1}" ${pg >= pageCount ? 'disabled' : ''}
        class="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 px-3 py-1 rounded text-sm">Next →</button>
    </div>
  `;

  document.getElementById('logWrap').innerHTML = `
    <div class="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
      <div class="p-4 border-b border-gray-700 flex justify-between items-center flex-wrap gap-3">
        <h2 class="font-semibold text-lg">Log Entries</h2>
        ${pages}
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="bg-gray-700 text-gray-300 text-left">
              <th class="px-4 py-2 font-semibold">Time</th>
              <th class="px-4 py-2 font-semibold">Severity</th>
              <th class="px-4 py-2 font-semibold">Category</th>
              <th class="px-4 py-2 font-semibold">User</th>
              <th class="px-4 py-2 font-semibold">Message</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-700">${rows}</tbody>
        </table>
      </div>
      <div class="p-4 border-t border-gray-700 flex justify-end">${pages}</div>
    </div>
  `;
}

document.getElementById('logWrap').addEventListener('click', event => {
  const button = event.target.closest('button[data-log-page]');
  if (button && !button.disabled) loadLogs(Number(button.dataset.logPage));
});

loadServers();
