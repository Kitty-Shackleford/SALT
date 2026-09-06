/* global api, document, window, fetchWithCsrf, alert */

let currentTab = 'pending';
let guilds = [];
let pendingAction = null;

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// Check if user is admin
api.get('/api/user')
  .then(r => r.json())
  .then(user => {
    if (!user.isAdmin) {
      document.body.innerHTML = `
        <div class="container mx-auto p-6 max-w-2xl">
          <div class="bg-red-900 border border-red-600 p-8 rounded-lg text-center">
            <h2 class="text-3xl font-bold mb-4">⛔ Access Denied</h2>
            <p class="mb-4">You do not have admin access to this page.</p>
            <a href="/dashboard" class="bg-blue-600 hover:bg-blue-700 px-6 py-3 rounded inline-block">
              Back to Dashboard
            </a>
          </div>
        </div>
      `;
    } else {
      loadGuilds();
    }
  })
  .catch(() => {
    window.location.href = '/';
  });

// Load guilds on page load
document.addEventListener('DOMContentLoaded', () => {
  // Tab switching
  document.getElementById('tab-pending').addEventListener('click', () => switchTab('pending'));
  document.getElementById('tab-approved').addEventListener('click', () => switchTab('approved'));
  document.getElementById('tab-disabled').addEventListener('click', () => switchTab('disabled'));

  // Modal buttons
  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  document.getElementById('confirmBtn').addEventListener('click', executeAction);
});

function switchTab(tab) {
  currentTab = tab;

  // Update tab styles
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.className = 'tab-btn bg-gray-700 hover:bg-gray-600 px-6 py-3 rounded';
  });

  const colors = {
    pending: 'bg-yellow-600',
    approved: 'bg-green-600',
    disabled: 'bg-red-600'
  };

  document.getElementById(`tab-${tab}`).className = `tab-btn ${colors[tab]} px-6 py-3 rounded font-semibold`;

  loadGuilds();
}

function loadGuilds() {
  const endpoint = currentTab === 'pending' ? '/api/admin/guilds/pending' : '/api/admin/guilds';

  fetch(endpoint)
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        guilds = data.guilds.filter(g => {
          if (currentTab === 'pending') return true;
          if (currentTab === 'approved') return g.status === 'approved';
          if (currentTab === 'disabled') return g.status === 'disabled';
        });
        displayGuilds();
      }
    })
    .catch(err => {
      console.error('Error loading guilds:', err);
      document.getElementById('guilds-container').innerHTML =
        '<p class="text-red-400 text-center py-4">Failed to load guilds</p>';
    });
}

function displayGuilds() {
  if (guilds.length === 0) {
    document.getElementById('guilds-container').innerHTML =
      `<p class="text-gray-400 text-center py-8">No ${currentTab} guilds found</p>`;
    return;
  }

  const html = `
    <div class="space-y-4">
      ${guilds.map(guild => renderGuildCard(guild)).join('')}
    </div>
  `;

  document.getElementById('guilds-container').innerHTML = html;

  // Add event listeners
  attachEventListeners();
}

function renderGuildCard(guild) {
  const createdDate = new Date(guild.addedAt || guild.created_at).toLocaleString();
  const guildId = esc(guild.guild_id);
  const guildName = esc(guild.guildName || 'Unknown Guild');
  const statusBadge = {
    pending: '<span class="bg-yellow-600 px-3 py-1 rounded text-sm">⏳ Pending</span>',
    approved: '<span class="bg-green-600 px-3 py-1 rounded text-sm">✅ Approved</span>',
    disabled: '<span class="bg-red-600 px-3 py-1 rounded text-sm">🚫 Disabled</span>'
  }[guild.status];

  let actions = '';
  if (guild.status === 'pending') {
    actions = `
      <button data-action="approve" data-guild-id="${guildId}"
              class="bg-green-600 hover:bg-green-700 px-4 py-2 rounded">
        ✅ Approve
      </button>
      <button data-action="deny" data-guild-id="${guildId}"
              class="bg-red-600 hover:bg-red-700 px-4 py-2 rounded">
        ❌ Deny
      </button>
    `;
  } else if (guild.status === 'approved') {
    actions = `
      <button data-action="disable" data-guild-id="${guildId}"
              class="bg-red-600 hover:bg-red-700 px-4 py-2 rounded">
        🚫 Disable
      </button>
    `;
  } else if (guild.status === 'disabled') {
    actions = `
      <button data-action="enable" data-guild-id="${guildId}"
              class="bg-green-600 hover:bg-green-700 px-4 py-2 rounded">
        ✅ Re-enable
      </button>
    `;
  }

  return `
    <div class="bg-gray-700 p-6 rounded-lg">
      <div class="flex items-start justify-between">
        <div class="flex items-center gap-4 flex-1">
          ${guild.icon_url ?
            `<img src="${esc(guild.icon_url)}" class="w-16 h-16 rounded" alt="" />` :
            '<div class="w-16 h-16 rounded bg-gray-600 flex items-center justify-center text-3xl">🛡️</div>'
          }
          <div class="flex-1">
            <div class="flex items-center gap-3 mb-2">
              <h3 class="text-2xl font-bold">${guildName}</h3>
              ${statusBadge}
            </div>
            <p class="text-gray-400 text-sm mb-1">Guild ID: ${guildId}</p>
            <p class="text-gray-400 text-sm mb-1">Owner: ${esc(guild.ownerUsername || guild.addedByUsername || 'Unknown')}</p>
            <p class="text-gray-400 text-sm">Registered: ${esc(createdDate)}</p>
            <p class="text-gray-400 text-sm">Servers: ${Number(guild.serverCount) || 0}</p>
            ${guild.disabledReason ? `<p class="text-red-400 text-sm mt-2">Reason: ${esc(guild.disabledReason)}</p>` : ''}
          </div>
        </div>
        <div class="flex gap-2">
          ${actions}
        </div>
      </div>
    </div>
  `;
}

function attachEventListeners() {
  document.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', function() {
      const action = this.getAttribute('data-action');
      const guildId = this.getAttribute('data-guild-id');
      const guild = guilds.find(g => g.guild_id === guildId);

      if (guild) {
        showConfirmModal(action, guild);
      }
    });
  });
}

function showConfirmModal(action, guild) {
  const modal = document.getElementById('confirmModal');
  const title = document.getElementById('modalTitle');
  const message = document.getElementById('modalMessage');
  const reasonInput = document.getElementById('reasonInput');
  const confirmBtn = document.getElementById('confirmBtn');

  const guildName = esc(guild.guildName || 'Unknown Guild');
  const configs = {
    approve: {
      title: 'Approve Guild',
      message: `Approve <strong>${guildName}</strong>? They will be able to use all features.`,
      showReason: false,
      btnClass: 'bg-green-600 hover:bg-green-700',
      btnText: '✅ Approve'
    },
    deny: {
      title: 'Deny Guild Request',
      message: `Deny <strong>${guildName}</strong>? This will remove their registration.`,
      showReason: true,
      btnClass: 'bg-red-600 hover:bg-red-700',
      btnText: '❌ Deny'
    },
    disable: {
      title: 'Disable Guild',
      message: `Disable <strong>${guildName}</strong>? They will lose access to all features.`,
      showReason: true,
      btnClass: 'bg-red-600 hover:bg-red-700',
      btnText: '🚫 Disable'
    },
    enable: {
      title: 'Re-enable Guild',
      message: `Re-enable <strong>${guildName}</strong>? They will regain access.`,
      showReason: false,
      btnClass: 'bg-green-600 hover:bg-green-700',
      btnText: '✅ Re-enable'
    }
  };

  const config = configs[action];

  title.textContent = config.title;
  message.innerHTML = config.message;
  reasonInput.style.display = config.showReason ? 'block' : 'none';
  confirmBtn.className = `${config.btnClass} px-4 py-2 rounded`;
  confirmBtn.textContent = config.btnText;

  pendingAction = { action, guildId: guild.guild_id };
  modal.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('confirmModal').classList.add('hidden');
  document.getElementById('actionReason').value = '';
  pendingAction = null;
}

async function executeAction() {
  if (!pendingAction) return;

  const { action, guildId } = pendingAction;
  const reason = document.getElementById('actionReason').value;

  const endpoint = `/api/admin/guilds/${guildId}/${action}`;

  try {
    const response = await fetchWithCsrf(endpoint, {
      method: 'POST',
      body: JSON.stringify({ reason })
    });

    const data = await response.json();

    if (data.success) {
      closeModal();
      loadGuilds(); // Reload
      // Show success message
      const successMsg = document.createElement('div');
      successMsg.className = 'fixed top-4 right-4 bg-green-600 px-6 py-3 rounded shadow-lg z-50';
      successMsg.textContent = '✅ Action completed successfully!';
      document.body.appendChild(successMsg);
      setTimeout(() => successMsg.remove(), 3000);
    } else {
      alert('❌ Error: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('Error executing action:', err);
    alert('❌ Failed to execute action');
  }
}
