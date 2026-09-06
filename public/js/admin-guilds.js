'use strict';
/* global api, document, window, fetchWithCsrf, alert */

let deleteGuildId = null;

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

api.get('/api/user')
  .then(res => res.json())
  .then(user => {
    if (!user.isAdmin) {
      document.body.innerHTML = '<div class="container mx-auto p-6"><p class="text-red-400">Admin access required.</p></div>';
      return;
    }
    loadGuilds();
  })
  .catch(() => { window.location.href = '/'; });

function loadGuilds() {
  api.get('/api/admin/guilds')
    .then(response => response.json())
    .then(data => {
      if (!data.success) throw new Error(data.error || 'Failed to load guilds');
      const guilds = data.guilds || [];
      const container = document.getElementById('guilds-container');
      if (!guilds.length) {
        container.innerHTML = '<div class="text-center py-8 text-gray-400"><p class="text-xl mb-2">No Discord servers registered.</p><p>Invite the bot, then use /register-token as the Discord guild owner or an Administrator.</p></div>';
        return;
      }
      container.innerHTML = `<div class="overflow-x-auto"><table class="w-full">
        <thead><tr class="border-b border-gray-700"><th class="text-left p-3">Server</th><th class="text-left p-3">Owner</th><th class="text-left p-3">Date</th><th class="text-center p-3">Servers</th><th class="text-center p-3">Players</th><th class="text-center p-3">Actions</th></tr></thead>
        <tbody>${guilds.map(guild => {
          const guildId = String(guild.guild_id || '');
          const guildName = guild.guildName || 'Unknown Server';
          const icon = guild.icon_url
            ? `<img src="${esc(guild.icon_url)}" alt="" class="w-10 h-10 rounded-full">`
            : `<div class="w-10 h-10 rounded-full bg-gray-600 flex items-center justify-center text-xl">${esc(guildName[0] || '?')}</div>`;
          return `<tr class="border-b border-gray-700"><td class="p-3"><div class="flex items-center gap-3">${icon}<div><div class="font-semibold">${esc(guildName)}</div><div class="text-xs text-gray-400">${esc(guildId)}</div></div></div></td>
            <td class="p-3">${esc(guild.addedByUsername || 'Unknown')}</td>
            <td class="p-3 text-sm text-gray-400">${esc(guild.addedAt ? new Date(guild.addedAt).toLocaleDateString() : '-')}</td>
            <td class="p-3 text-center"><span class="bg-blue-900 px-3 py-1 rounded-full text-sm">${Number(guild.serverCount) || 0}</span></td>
            <td class="p-3 text-center"><span class="bg-green-900 px-3 py-1 rounded-full text-sm" id="player-count-${esc(guildId)}">…</span></td>
            <td class="p-3 text-center"><div class="flex gap-2 justify-center">
              ${guild.serverCount > 0 ? `<a href="/admin/servers?guildId=${encodeURIComponent(guildId)}" class="bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded text-sm">View Servers</a>` : ''}
              <button class="bg-red-600 hover:bg-red-700 px-3 py-1 rounded text-sm delete-guild-btn" data-guild-id="${esc(guildId)}" data-guild-name="${esc(guildName)}" data-server-count="${Number(guild.serverCount) || 0}">Delete</button>
            </div></td></tr>`;
        }).join('')}</tbody></table></div>`;
      guilds.forEach(guild => loadPlayerCount(String(guild.guild_id)));
      container.querySelectorAll('.delete-guild-btn').forEach(button => button.addEventListener('click', () => {
        deleteGuildId = button.dataset.guildId;
        document.getElementById('deleteGuildName').textContent = button.dataset.guildName;
        const count = Number(button.dataset.serverCount) || 0;
        document.getElementById('deleteWarning').textContent = count
          ? `Warning: ${count} Nitrado server(s), tenant roles, and related data may be removed.` : '';
        document.getElementById('deleteModal').classList.remove('hidden');
      }));
    })
    .catch(error => {
      document.getElementById('guilds-container').innerHTML = `<p class="text-red-400 text-center py-4">${esc(error.message)}</p>`;
    });
}

function closeDeleteModal() {
  document.getElementById('deleteModal').classList.add('hidden');
  deleteGuildId = null;
}

async function confirmDelete() {
  if (!deleteGuildId) return;
  try {
    const response = await fetchWithCsrf(`/api/admin/guilds/${encodeURIComponent(deleteGuildId)}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Failed to delete guild');
    closeDeleteModal();
    loadGuilds();
  } catch (error) { alert(`Error: ${error.message}`); }
}

function loadPlayerCount(guildId) {
  fetch(`/api/admin/servers?guildId=${encodeURIComponent(guildId)}`)
    .then(response => response.json())
    .then(data => {
      const count = data.success ? (data.servers || []).reduce((sum, server) => sum + (Number(server.playerCount) || 0), 0) : 0;
      const element = document.getElementById(`player-count-${guildId}`);
      if (element) element.textContent = String(count);
    })
    .catch(() => {
      const element = document.getElementById(`player-count-${guildId}`);
      if (element) element.textContent = '0';
    });
}

document.getElementById('confirmDeleteBtn').addEventListener('click', confirmDelete);
document.getElementById('closeDeleteModalBtn').addEventListener('click', closeDeleteModal);
