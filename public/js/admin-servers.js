'use strict';
/* global api, document, fetchWithCsrf, alert */

let allServers = [];
let healthByServer = new Map();
let deleteServerId = null;

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function healthState(health) {
  if (!health || health.stale) return 'unknown';
  return health.state || 'unknown';
}

function healthBadge(health, label) {
  const state = healthState(health);
  const styles = { healthy: 'text-green-400', degraded: 'text-yellow-400', offline: 'text-red-400', unknown: 'text-gray-400' };
  const dot = { healthy: '●', degraded: '●', offline: '●', unknown: '○' }[state];
  const detail = health?.detail || 'unknown';
  return `<button class="health-detail ${styles[state]} text-left" data-component="${esc(label)}" data-detail="${esc(detail)}" data-checked="${esc(health?.checkedAt || '')}" data-message="${esc(health?.message || '')}">${dot} ${esc(detail.replace(/_/g, ' '))}${health?.stale ? ' (stale)' : ''}</button>`;
}

async function loadGuilds() {
  try {
    const response = await api.get('/api/admin/guilds');
    const data = await response.json();
    const select = document.getElementById('guildFilter');
    for (const guild of data.guilds || []) {
      const option = document.createElement('option');
      option.value = guild.guild_id;
      option.textContent = guild.guildName;
      select.appendChild(option);
    }
  } catch (error) {
    console.error('Failed to load guild list:', error);
  }
}

async function loadServers() {
  const guildId = document.getElementById('guildFilter').value;
  const url = guildId ? `/api/admin/servers?guildId=${encodeURIComponent(guildId)}` : '/api/admin/servers';
  try {
    const [serversResponse, healthResponse] = await Promise.all([
      api.get(url),
      api.get('/api/health/servers'),
    ]);
    const serversData = await serversResponse.json();
    const healthData = await healthResponse.json();
    if (!serversData.success) throw new Error(serversData.error || 'Failed to load servers');
    allServers = serversData.servers || [];
    healthByServer = new Map((healthData.servers || []).map(server => [String(server.id), server.health]));
    displayServers();
  } catch (error) {
    document.getElementById('servers-container').innerHTML =
      `<p class="text-red-400 text-center py-4">${esc(error.message)}</p>`;
  }
}

function aggregateState(health) {
  if (!health) return 'unknown';
  const states = Object.values(health).map(healthState);
  if (states.includes('offline')) return 'offline';
  if (states.includes('degraded')) return 'degraded';
  if (states.includes('unknown')) return 'unknown';
  return 'healthy';
}

function displayServers() {
  const search = document.getElementById('searchInput').value.toLowerCase();
  const healthFilter = document.getElementById('healthFilter').value;
  const filtered = allServers.filter(server => {
    const matchesSearch = !search || String(server.server_name || '').toLowerCase().includes(search);
    const matchesHealth = !healthFilter || aggregateState(healthByServer.get(String(server.id))) === healthFilter;
    return matchesSearch && matchesHealth;
  });
  const container = document.getElementById('servers-container');
  if (!filtered.length) {
    container.innerHTML = '<p class="text-gray-400 text-center py-4">No servers found</p>';
    return;
  }
  container.innerHTML = `<div class="overflow-x-auto"><table class="w-full"><thead class="bg-gray-700"><tr>
    <th class="p-3 text-left">Server</th><th class="p-3 text-left">Guild</th>
    <th class="p-3 text-left">Discord</th><th class="p-3 text-left">Nitrado</th><th class="p-3 text-left">Game Server</th>
    <th class="p-3 text-left">Checked</th><th class="p-3 text-left">Actions</th></tr></thead><tbody>
    ${filtered.map(server => {
      const health = healthByServer.get(String(server.id)) || {};
      const checks = Object.values(health).map(item => item?.checkedAt).filter(Boolean).sort();
      return `<tr class="border-b border-gray-700">
        <td class="p-3 font-semibold">${esc(server.server_name || 'Unnamed Server')}<div class="text-xs text-gray-500">${esc(server.nitrado_server_id)}</div></td>
        <td class="p-3">${esc(server.guildName || 'No Guild')}</td>
        <td class="p-3">${healthBadge(health.discord, 'Discord')}</td>
        <td class="p-3">${healthBadge(health.nitrado, 'Nitrado')}</td>
        <td class="p-3">${healthBadge(health.gameServer, 'Game Server')}</td>
        <td class="p-3 text-xs text-gray-400">${checks.length ? esc(new Date(checks[0]).toLocaleString()) : 'Never'}</td>
        <td class="p-3"><div class="flex gap-2">
          <button class="refresh-health-btn bg-blue-700 hover:bg-blue-600 px-2 py-1 rounded" data-server-id="${server.id}">Refresh Status</button>
          <button class="delete-server-btn bg-red-700 hover:bg-red-600 px-2 py-1 rounded" data-server-id="${server.id}" data-server-name="${esc(server.server_name || 'Unnamed Server')}">Delete</button>
        </div></td></tr>`;
    }).join('')}</tbody></table></div>`;

  container.querySelectorAll('.health-detail').forEach(button => button.addEventListener('click', () => {
    const checked = button.dataset.checked ? new Date(button.dataset.checked).toLocaleString() : 'Never';
    alert(`${button.dataset.component}\nStatus: ${button.dataset.detail.replace(/_/g, ' ')}\nLast checked: ${checked}\n${button.dataset.message}`);
  }));
  container.querySelectorAll('.refresh-health-btn').forEach(button => button.addEventListener('click', async () => {
    try {
      await fetchWithCsrf(`/api/health/servers/${button.dataset.serverId}/refresh`, { method: 'POST', body: '{}' });
      button.textContent = 'Refresh queued';
      button.disabled = true;
    } catch (error) { alert(error.message); }
  }));
  container.querySelectorAll('.delete-server-btn').forEach(button => button.addEventListener('click', () => {
    deleteServerId = button.dataset.serverId;
    document.getElementById('deleteServerName').textContent = button.dataset.serverName;
    document.getElementById('deleteModal').classList.remove('hidden');
  }));
}

function closeDeleteModal() {
  deleteServerId = null;
  document.getElementById('deleteModal').classList.add('hidden');
}

async function confirmDelete() {
  if (!deleteServerId) return;
  try {
    const response = await fetchWithCsrf(`/api/admin/servers/${deleteServerId}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Delete failed');
    closeDeleteModal();
    await loadServers();
  } catch (error) { alert(error.message); }
}

document.getElementById('searchInput').addEventListener('input', displayServers);
document.getElementById('healthFilter').addEventListener('change', displayServers);
document.getElementById('loadServersBtn').addEventListener('click', loadServers);
document.getElementById('confirmDeleteBtn').addEventListener('click', confirmDelete);
document.getElementById('closeDeleteModalBtn').addEventListener('click', closeDeleteModal);

loadGuilds();
loadServers();
