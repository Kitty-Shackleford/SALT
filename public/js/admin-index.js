/* global api, document, window */

// Check if user is admin
api.get('/api/user')
  .then(res => res.json())
  .then(data => {
    if (!data.isAdmin) {
      window.location.href = '/dashboard';
    }
  })
  .catch(() => {
    window.location.href = '/';
  });

// Utility: format relative time ("2 hours ago")
function timeAgo(timestamp) {
  if (!timestamp) return 'Unknown';
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Load overview stats
function loadStats() {
  fetch('/api/admin/overview/stats')
    .then(res => res.json())
    .then(data => {
      if (!data.success) return;
      const { guilds, servers, players } = data.stats;

      document.getElementById('stat-guilds-total').textContent = guilds.total.toLocaleString();
      document.getElementById('stat-servers-total').textContent = servers.total.toLocaleString();
      document.getElementById('stat-players-total').textContent = players.total.toLocaleString();

      document.getElementById('stat-guilds-breakdown').innerHTML = `
        <p><span class="text-green-400 font-semibold">${guilds.approved}</span> Approved</p>
        <p><span class="text-yellow-400 font-semibold">${guilds.pending}</span> Pending</p>
        <p><span class="text-red-400 font-semibold">${guilds.disabled}</span> Disabled</p>
      `;

      // Update approval button badge
      const approvalBtn = document.getElementById('approval-btn');
      if (guilds.pending > 0) {
        approvalBtn.innerHTML = `🛡️ Guild Approval <span class="bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full">${guilds.pending}</span>`;
      } else {
        approvalBtn.innerHTML = '🛡️ Guild Approval';
      }
    })
    .catch(err => console.error('Error loading stats:', err));
}

// Load health status
function loadHealth() {
  fetch('/api/admin/overview/health')
    .then(res => res.json())
    .then(data => {
      if (!data.success) return;
      const { status, checks } = data.health;

      const statusMap = {
        healthy: '✅ Healthy',
        degraded: '🟡 Degraded',
        critical: '🔴 Critical'
      };
      const statusColorMap = {
        healthy: 'text-green-400',
        degraded: 'text-yellow-400',
        critical: 'text-red-400'
      };

      const statusEl = document.getElementById('health-status');
      statusEl.textContent = statusMap[status] || status;
      statusEl.className = `text-xl font-bold mb-3 ${statusColorMap[status] || ''}`;

      const nitrado = checks.nitradoApi;
      const discord = checks.discordApi;
      const bot = checks.bot;
      const db = checks.database;
      const lastSync = checks.lastSync;

      document.getElementById('health-checks').innerHTML = `
        <p>${nitrado.status === 'connected' ? '✅' : '❌'} Nitrado: ${nitrado.status === 'connected' ? 'OK' : 'Error'}</p>
        <p>${discord.status === 'connected' ? '✅' : '❌'} Discord: ${discord.status === 'connected' ? 'OK' : 'Error'}</p>
        <p>${bot.status === 'online' ? '✅' : '❌'} Bot: ${bot.status === 'online' ? `Online · ${bot.guildCount} guild(s) · ${bot.websocketPingMs ?? '?'}ms` : 'Offline'}${bot.lastHeartbeat ? ` · ${timeAgo(bot.lastHeartbeat)}` : ''}</p>
        <p>${db.status === 'healthy' ? '✅' : '❌'} Database: ${db.status === 'healthy' ? 'OK' : 'Error'}</p>
        <p>🔄 Sync: ${lastSync ? timeAgo(lastSync) : 'Never'}</p>
      `;
    })
    .catch(err => console.error('Error loading health:', err));
}

// Load recent activity feed
function loadActivity() {
  fetch('/api/admin/overview/activity')
    .then(res => res.json())
    .then(data => {
      const container = document.getElementById('activity-feed');
      if (!data.success || data.activities.length === 0) {
        container.innerHTML = '<p class="text-gray-400 text-center py-4">No recent activity</p>';
        return;
      }

      const html = data.activities.map(item => {
        let icon, description;
        switch (item.type) {
          case 'guild_approved':
            icon = '✅';
            description = `Guild "<strong>${escapeHtml(item.guildName)}</strong>" approved by ${escapeHtml(item.adminUsername || 'admin')}`;
            break;
          case 'guild_disabled':
            icon = '❌';
            description = `Guild "<strong>${escapeHtml(item.guildName)}</strong>" disabled by ${escapeHtml(item.adminUsername || 'admin')}${item.reason ? ` — ${escapeHtml(item.reason)}` : ''}`;
            break;
          case 'guild_requested':
            icon = '🆕';
            description = `New guild request: "<strong>${escapeHtml(item.guildName)}</strong>"`;
            break;
          case 'server_registered':
            icon = '🖥️';
            description = `Server "<strong>${escapeHtml(item.serverName || 'Unknown')}</strong>" registered to "${escapeHtml(item.guildName || 'Unknown')}"`;
            break;
          default:
            icon = '📝';
            description = escapeHtml(item.type);
        }

        return `
          <div class="border-b border-gray-700 py-3 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <span class="text-2xl">${icon}</span>
              <p class="text-sm">${description}</p>
            </div>
            <span class="text-gray-400 text-xs whitespace-nowrap ml-4">${timeAgo(item.timestamp)}</span>
          </div>
        `;
      }).join('');

      container.innerHTML = html;
    })
    .catch(err => {
      console.error('Error loading activity:', err);
      document.getElementById('activity-feed').innerHTML =
        '<p class="text-red-400 text-center py-4">Failed to load activity</p>';
    });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function loadGuildHealth() {
  fetch('/api/health/guilds')
    .then(res => res.json())
    .then(data => {
      const container = document.getElementById('guild-health-summary');
      const guilds = data.guilds || [];
      if (!guilds.length) {
        container.innerHTML = '<p class="text-gray-400">No authorized active servers.</p>';
        return;
      }
      const icons = { healthy: '🟢', degraded: '🟡', offline: '🔴', unknown: '⚪' };
      container.innerHTML = guilds.map(guild => `<a href="/admin/servers?guildId=${encodeURIComponent(guild.discordGuildId)}" class="block border border-gray-700 rounded p-4 hover:bg-gray-700">
        <div class="flex justify-between gap-3"><strong>${escapeHtml(guild.name)}</strong><span>${icons[guild.state] || '⚪'} ${escapeHtml(guild.state)}</span></div>
        <p class="text-sm text-gray-400 mt-2">${guild.serverCount} server(s) · ${guild.healthy || 0} online · ${guild.offline || 0} offline · ${guild.unknown || 0} unknown</p>
      </a>`).join('');
    })
    .catch(() => {
      document.getElementById('guild-health-summary').innerHTML = '<p class="text-red-400">Failed to load guild health.</p>';
    });
}

function refreshAll() {
  loadStats();
  loadHealth();
  loadActivity();
  loadGuildHealth();
}

// Initial load
refreshAll();

// Attach refresh button listener
document.getElementById('refresh-btn').addEventListener('click', refreshAll);

// Auto-refresh intervals
setInterval(loadStats, 30000);
setInterval(loadHealth, 60000);
setInterval(loadActivity, 60000);
setInterval(loadGuildHealth, 60000);
