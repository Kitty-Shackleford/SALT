let currentServerId = null;
let currentPage = 0;
const PAGE_SIZE = 50;

function fmt(n) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function sourceLabel(source) {
  const labels = {
    kill: '⚔️ Kill Reward',
    playtime: '⏱️ Playtime Reward',
    achievement: '🏆 Achievement',
    territory: '🏰 Territory',
    admin: '👑 Admin',
    death_penalty: '💀 Death Penalty',
    bank_fee: '🏦 Bank Fee',
    transfer_fee: '💸 Transfer Fee',
    inactivity_tax: '💤 Inactivity Tax'
  };
  return labels[source] || source;
}

async function loadGuilds() {
  try {
    const res = await fetch('/api/admin/guilds', { credentials: 'same-origin' });
    const data = await res.json();
    const select = document.getElementById('guildSelect');
    select.innerHTML = '<option value="">-- Select a server --</option>';
    for (const guild of (data.guilds || data)) {
      const serversRes = await fetch(`/api/guilds/${guild.id}/servers`, { credentials: 'same-origin' });
      const serversData = await serversRes.json();
      for (const server of (serversData.servers || [])) {
        const opt = document.createElement('option');
        opt.value = server.id;
        opt.textContent = `${guild.name || 'Guild'} — ${server.name || `Server ${server.id}`}`;
        select.appendChild(opt);
      }
    }
  } catch (err) {
    document.getElementById('guildSelect').innerHTML = '<option value="">-- Error loading servers --</option>';
  }
}

async function loadSupplyStats() {
  if (!currentServerId) return;
  const days = document.getElementById('timeRange').value || 7;

  try {
    const res = await fetch(`/api/economy/admin/${currentServerId}/supply-stats?days=${days}`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.success) return;

    const sym = '$'; // use default; config not available here

    document.getElementById('totalSupply').textContent = sym + fmt(data.currentSupply || 0);
    document.getElementById('supplyCap').textContent = data.maxSupply != null
      ? sym + fmt(data.maxSupply) : 'Unlimited';
    document.getElementById('supplyPercent').textContent = data.utilizationPercent != null
      ? data.utilizationPercent.toFixed(1) + '%' : '—';

    const net = data.netChange7d || 0;
    const netEl = document.getElementById('netChange');
    netEl.textContent = (net >= 0 ? '+' : '') + sym + fmt(Math.abs(net));
    netEl.className = 'font-bold text-lg ' + (net >= 0 ? 'text-green-400' : 'text-red-400');

    // Faucets
    const faucetBySource = data.faucets?.bySource || {};
    const faucetList = document.getElementById('faucetList');
    const faucetEntries = Object.entries(faucetBySource).sort((a, b) => b[1] - a[1]);
    if (faucetEntries.length > 0) {
      faucetList.innerHTML = faucetEntries.map(([src, total]) => `
        <div class="flex justify-between items-center bg-gray-700 px-3 py-2 rounded">
          <span class="text-sm">${sourceLabel(src)}</span>
          <span class="text-green-400 font-semibold text-sm">${sym}${fmt(total)}</span>
        </div>
      `).join('');
    } else {
      faucetList.innerHTML = '<p class="text-gray-500 text-sm">No faucet activity in this period.</p>';
    }
    document.getElementById('faucetTotal').textContent = sym + fmt(data.faucets?.total7d || 0);

    // Sinks
    const sinkBySource = data.sinks?.bySource || {};
    const sinkList = document.getElementById('sinkList');
    const sinkEntries = Object.entries(sinkBySource).sort((a, b) => b[1] - a[1]);
    if (sinkEntries.length > 0) {
      sinkList.innerHTML = sinkEntries.map(([src, total]) => `
        <div class="flex justify-between items-center bg-gray-700 px-3 py-2 rounded">
          <span class="text-sm">${sourceLabel(src)}</span>
          <span class="text-red-400 font-semibold text-sm">${sym}${fmt(total)}</span>
        </div>
      `).join('');
    } else {
      sinkList.innerHTML = '<p class="text-gray-500 text-sm">No sink activity in this period.</p>';
    }
    document.getElementById('sinkTotal').textContent = sym + fmt(data.sinks?.total7d || 0);

  } catch (err) {
    console.error('Error loading supply stats:', err);
  }
}

async function loadLog(page = 0) {
  if (!currentServerId) return;
  currentPage = page;
  const offset = page * PAGE_SIZE;
  const changeType = document.getElementById('logTypeFilter').value;
  const typeParam = changeType ? `&changeType=${encodeURIComponent(changeType)}` : '';

  const logEl = document.getElementById('supplyLog');
  logEl.innerHTML = '<p class="text-gray-500 text-sm text-center py-4">Loading...</p>';

  try {
    const res = await fetch(
      `/api/economy/admin/${currentServerId}/supply-log?limit=${PAGE_SIZE}&offset=${offset}${typeParam}`,
      { credentials: 'same-origin' }
    );
    const data = await res.json();
    if (!data.success) { logEl.innerHTML = '<p class="text-red-400 text-sm text-center py-4">Error loading log.</p>'; return; }

    const sym = '$';
    if (data.log.length === 0) {
      logEl.innerHTML = '<p class="text-gray-500 text-sm text-center py-4">No supply changes found.</p>';
      document.getElementById('logPagination').classList.add('hidden');
      return;
    }

    logEl.innerHTML = data.log.map(entry => {
      const isFaucet = entry.changeType === 'faucet';
      const arrow = isFaucet ? '↑' : '↓';
      const colorClass = isFaucet ? 'text-green-400' : 'text-red-400';
      const date = new Date(entry.timestamp).toLocaleString();
      return `
        <div class="flex justify-between items-start bg-gray-700 px-3 py-2 rounded text-sm">
          <div>
            <span class="${colorClass} font-bold mr-2">${arrow} ${sourceLabel(entry.source)}</span>
            ${entry.gamertag ? `<span class="text-gray-300">${entry.gamertag}</span>` : ''}
            ${entry.serverName ? `<span class="text-gray-500 text-xs ml-1">(${entry.serverName})</span>` : ''}
            <p class="text-gray-500 text-xs mt-0.5">${date} · ${sym}${fmt(entry.supplyBefore)} → ${sym}${fmt(entry.supplyAfter)}</p>
          </div>
          <span class="${colorClass} font-bold whitespace-nowrap ml-2">${isFaucet ? '+' : '-'}${sym}${fmt(entry.amount)}</span>
        </div>
      `;
    }).join('');

    // Pagination
    const total = data.pagination.total;
    const totalPages = Math.ceil(total / PAGE_SIZE);
    if (totalPages > 1) {
      document.getElementById('logPagination').classList.remove('hidden');
      document.getElementById('pageInfo').textContent = `Page ${page + 1} of ${totalPages} (${total} entries)`;
      document.getElementById('prevPage').disabled = page === 0;
      document.getElementById('nextPage').disabled = page >= totalPages - 1;
    } else {
      document.getElementById('logPagination').classList.add('hidden');
    }

  } catch (err) {
    logEl.innerHTML = '<p class="text-red-400 text-sm text-center py-4">Error loading log.</p>';
  }
}

async function showDashboard(guildId) {
  currentServerId = guildId;
  document.getElementById('noGuildState').classList.add('hidden');
  document.getElementById('mainDashboard').classList.add('hidden');
  document.getElementById('loadingState').classList.remove('hidden');

  await Promise.all([loadSupplyStats(), loadLog(0)]);

  document.getElementById('loadingState').classList.add('hidden');
  document.getElementById('mainDashboard').classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadGuilds();

  document.getElementById('guildSelect').addEventListener('change', async (e) => {
    const guildId = e.target.value;
    if (guildId) {
      await showDashboard(guildId);
    } else {
      currentServerId = null;
      document.getElementById('mainDashboard').classList.add('hidden');
      document.getElementById('noGuildState').classList.remove('hidden');
    }
  });

  document.getElementById('timeRange').addEventListener('change', async () => {
    if (currentServerId) await loadSupplyStats();
  });

  document.getElementById('logTypeFilter').addEventListener('change', async () => {
    if (currentServerId) await loadLog(0);
  });

  document.getElementById('refreshLogBtn').addEventListener('click', async () => {
    if (currentServerId) await loadLog(currentPage);
  });

  document.getElementById('prevPage').addEventListener('click', async () => {
    if (currentPage > 0) await loadLog(currentPage - 1);
  });

  document.getElementById('nextPage').addEventListener('click', async () => {
    await loadLog(currentPage + 1);
  });
});
