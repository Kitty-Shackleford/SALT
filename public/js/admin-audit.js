/* global api, window, document, alert */

let currentEntries = [];

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// Check if user is admin
api.get('/api/user')
  .then(res => res.json())
  .then(data => {
    if (!data.isAdmin) {
      window.location.href = '/dashboard';
    }
    loadAuditLog();
  })
  .catch(() => {
    window.location.href = '/';
  });

function loadAuditLog() {
  const action = document.getElementById('actionFilter').value;
  const limit = document.getElementById('limitSelect').value;

  let url = `/api/admin/audit?limit=${limit}`;
  if (action) {
    url += `&action=${action}`;
  }

  fetch(url)
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        currentEntries = data.entries;
        displayAuditLog();
      }
    })
    .catch(err => {
      console.error('Error loading audit log:', err);
      document.getElementById('audit-container').innerHTML =
        '<p class="text-red-400 text-center py-4">Failed to load audit log</p>';
    });
}

function displayAuditLog() {
  if (currentEntries.length === 0) {
    document.getElementById('audit-container').innerHTML =
      '<p class="text-gray-400 text-center py-4">No audit entries found</p>';
    return;
  }

  const html = `
    <div class="overflow-x-auto">
      <table class="w-full">
        <thead class="bg-gray-700">
          <tr>
            <th class="p-3 text-left">Timestamp</th>
            <th class="p-3 text-left">Admin User</th>
            <th class="p-3 text-left">Action</th>
            <th class="p-3 text-left">Target Type</th>
            <th class="p-3 text-left">Target ID</th>
            <th class="p-3 text-left">Details</th>
          </tr>
        </thead>
        <tbody>
          ${currentEntries.map(entry => {
            const date = new Date(entry.timestamp);
            const actionLabel = entry.action.replace(/_/g, ' ');
            const icon = getActionIcon(entry.action);
            const detailsStr = formatDetails(entry.details);

            return `
              <tr class="border-b border-gray-700 hover:bg-gray-750">
                <td class="p-3 text-sm">${esc(date.toLocaleString())}</td>
                <td class="p-3">
                  <div class="flex items-center gap-2">
                    ${entry.avatar ?
                      `<img src="https://cdn.discordapp.com/avatars/${encodeURIComponent(entry.userId)}/${encodeURIComponent(entry.avatar)}.png"
                           class="w-6 h-6 rounded-full" />` :
                      '<div class="w-6 h-6 rounded-full bg-gray-600"></div>'
                    }
                    <span>${esc(entry.username || 'Unknown')}</span>
                  </div>
                </td>
                <td class="p-3">
                  <span class="flex items-center gap-2">
                    <span class="text-xl">${icon}</span>
                    <span class="font-semibold">${esc(actionLabel)}</span>
                  </span>
                </td>
                <td class="p-3 text-gray-400">${esc(entry.targetType || '-')}</td>
                <td class="p-3 text-sm text-gray-400">${esc(entry.targetId || '-')}</td>
                <td class="p-3 text-sm text-gray-400">${esc(detailsStr)}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('audit-container').innerHTML = html;
}

function getActionIcon(action) {
  const icons = {
    'ADD_GUILD': '➕',
    'REMOVE_GUILD': '❌',
    'DELETE_SERVER': '🗑️',
    'PROMOTE_USER': '⬆️',
    'DEMOTE_USER': '⬇️'
  };
  return icons[action] || '📝';
}

function formatDetails(details) {
  if (!details || typeof details !== 'object') return '-';

  const entries = Object.entries(details)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ');

  return entries || '-';
}

function exportCSV() {
  if (currentEntries.length === 0) {
    alert('No data to export');
    return;
  }

  const headers = ['Timestamp', 'Admin User', 'Action', 'Target Type', 'Target ID', 'Details'];
  const rows = currentEntries.map(entry => [
    new Date(entry.timestamp).toISOString(),
    entry.username || 'Unknown',
    entry.action,
    entry.targetType || '',
    entry.targetId || '',
    JSON.stringify(entry.details || {})
  ]);

  const csvCell = value => {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = [
    headers.join(','),
    ...rows.map(row => row.map(csvCell).join(','))
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-log-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  window.URL.revokeObjectURL(url);
}

// Event listeners
document.getElementById('loadAuditLogBtn').addEventListener('click', loadAuditLog);
document.getElementById('exportCSVBtn').addEventListener('click', exportCSV);
