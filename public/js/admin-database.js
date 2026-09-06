let selectedIdentityId = null;

function setOutput(payload) {
  const pre = document.getElementById('output');
  pre.textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
}

async function apiJson(url, options = {}) {
  const response = await fetchWithCsrf(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function renderPlayers(players) {
  const container = document.getElementById('player-results');
  if (!players.length) {
    container.innerHTML = '<div class="p-3 text-gray-400 text-sm">No linked players found</div>';
    return;
  }
  container.innerHTML = players.map(player => `
    <button
      class="w-full text-left px-3 py-2 hover:bg-gray-700 border-b border-gray-700"
      data-identity-id="${player.identity_id}">
      <div class="font-semibold">${escapeHtml(player.gamertag || 'Unknown')}</div>
      <div class="text-xs text-gray-400">
        ID ${player.identity_id} • ${escapeHtml(player.platform)} • ${escapeHtml(player.platform_user_id)}
      </div>
    </button>
  `).join('');

  container.querySelectorAll('button[data-identity-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedIdentityId = parseInt(btn.dataset.identityId, 10);
      document.getElementById('identity-id').value = selectedIdentityId;
    });
  });
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

async function searchPlayers() {
  const query = document.getElementById('player-search').value.trim();
  try {
    const data = await apiJson(`/api/admin/db-reset/players?query=${encodeURIComponent(query)}`);
    renderPlayers(data.players || []);
  } catch (err) {
    setOutput(`Player search failed: ${err.message}`);
  }
}

async function resetPlayerStats() {
  const identityId = parseInt(document.getElementById('identity-id').value, 10) || selectedIdentityId;
  if (!identityId) {
    setOutput('Select or enter a valid identity ID first.');
    return;
  }
  if (!confirm(`Reset tracked stats for identity ${identityId}?`)) return;

  try {
    const data = await apiJson('/api/admin/db-reset/player-stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityId })
    });
    setOutput(data);
  } catch (err) {
    setOutput(`Player reset failed: ${err.message}`);
  }
}

async function fullReset() {
  const phrase = document.getElementById('full-reset-confirm').value.trim();
  if (phrase !== 'RESET TRACKED DATA') {
    setOutput('Confirmation phrase mismatch.');
    return;
  }
  if (!confirm('Run FULL tracked-data reset now? This cannot be undone.')) return;

  try {
    const data = await apiJson('/api/admin/db-reset/full', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: phrase })
    });
    setOutput(data);
  } catch (err) {
    setOutput(`Full reset failed: ${err.message}`);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  fetch('/api/user')
    .then(res => res.json())
    .then(data => {
      if (!data.isAdmin) window.location.href = '/dashboard';
    })
    .catch(() => {
      window.location.href = '/';
    });

  document.getElementById('player-search').addEventListener('input', searchPlayers);
  document.getElementById('reset-player-btn').addEventListener('click', resetPlayerStats);
  document.getElementById('full-reset-btn').addEventListener('click', fullReset);
  searchPlayers();
});
