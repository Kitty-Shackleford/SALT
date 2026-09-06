/* global Chart */

let currentServerId = null;
let moneyFlowChartInstance = null;
let txVolumeChartInstance = null;
let sourcesChartInstance = null;
let sinksChartInstance = null;

const CHART_COLORS = [
  '#f97316', '#3b82f6', '#10b981', '#f59e0b',
  '#8b5cf6', '#ef4444', '#06b6d4', '#84cc16',
  '#ec4899', '#14b8a6'
];

function fmt(n) {
  if (n == null || isNaN(n)) return '0';
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function sourceLabel(key) {
  const labels = {
    kill: '⚔️ Kill Reward',
    playtime: '⏱️ Playtime',
    achievement: '🏆 Achievement',
    territory: '🏰 Territory',
    admin: '👑 Admin',
    transfer_receive: '📥 Transfer Received',
    transfer_send: '📤 Transfer Sent',
    bank_deposit: '🏦 Bank Deposit',
    wallet_withdraw: '💵 Withdrawal',
    bank_fee: '🏦 Bank Fee',
    deposit_fee: '🏦 Deposit Fee',
    withdraw_fee: '💵 Withdraw Fee',
    transfer_fee: '💸 Transfer Fee',
    death_penalty: '💀 Death Penalty',
    inactivity_tax: '💤 Inactivity Tax',
    earn: '💰 Earn',
    deposit: '🏦 Deposit',
    withdraw: '💵 Withdraw',
    transfer: '💸 Transfer'
  };
  return labels[key] || key;
}

function destroyChart(instance) {
  if (instance) {
    try {
      instance.destroy();
    } catch (error) {
      console.warn('Unable to destroy analytics chart:', error);
    }
  }
}

function renderRankingList(container, players, amountKey, amountPrefix, amountClass, emptyMessage) {
  container.replaceChildren();
  if (!Array.isArray(players) || players.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-gray-500 text-sm';
    empty.textContent = emptyMessage;
    container.appendChild(empty);
    return;
  }

  players.forEach((player, index) => {
    const row = document.createElement('div');
    row.className = 'flex justify-between items-center bg-gray-700 px-3 py-2 rounded';
    const name = document.createElement('span');
    name.className = 'text-sm';
    name.textContent = `#${index + 1} ${player.gamertag || 'Unknown player'}`;
    const amount = document.createElement('span');
    amount.className = `${amountClass} font-semibold text-sm`;
    amount.textContent = `${amountPrefix}$${fmt(player[amountKey])}`;
    row.append(name, amount);
    container.appendChild(row);
  });
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

async function loadAnalytics() {
  if (!currentServerId) return;
  const days = document.getElementById('dateRange').value || 7;

  document.getElementById('noGuildState').classList.add('hidden');
  document.getElementById('mainDashboard').classList.add('hidden');
  document.getElementById('loadingState').classList.remove('hidden');

  try {
    const res = await fetch(`/api/economy/admin/${currentServerId}/analytics?days=${days}`, { credentials: 'same-origin' });
    const data = await res.json();

    if (!data.success) {
      document.getElementById('loadingState').classList.add('hidden');
      document.getElementById('noGuildState').classList.remove('hidden');
      return;
    }

    const a = data.analytics;

    // Overview cards
    document.getElementById('ovTotalMoney').textContent = '$' + fmt(a.overview.totalMoney);
    document.getElementById('ovPlayerCount').textContent = a.overview.playerCount;
    document.getElementById('ovAvgWealth').textContent = '$' + fmt(a.overview.avgWealthPerPlayer);
    document.getElementById('ovVelocity').textContent = '$' + fmt(a.overview.moneyVelocity);

    // Money flow chart
    const flowData = a.moneyFlow.daily || [];
    destroyChart(moneyFlowChartInstance);
    moneyFlowChartInstance = new Chart(document.getElementById('moneyFlowChart'), {
      type: 'line',
      data: {
        labels: flowData.map(d => d.date),
        datasets: [
          {
            label: 'Earned',
            data: flowData.map(d => d.earned),
            borderColor: '#10b981',
            backgroundColor: 'rgba(16,185,129,0.1)',
            fill: true,
            tension: 0.3
          },
          {
            label: 'Spent',
            data: flowData.map(d => d.spent),
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239,68,68,0.1)',
            fill: true,
            tension: 0.3
          },
          {
            label: 'Net',
            data: flowData.map(d => d.net),
            borderColor: '#f97316',
            backgroundColor: 'rgba(249,115,22,0.05)',
            fill: false,
            borderDash: [5, 5],
            tension: 0.3
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#d1d5db' } } },
        scales: {
          x: { ticks: { color: '#9ca3af' }, grid: { color: '#374151' } },
          y: { ticks: { color: '#9ca3af' }, grid: { color: '#374151' } }
        }
      }
    });

    // Transaction volume chart
    const volData = a.transactionVolume || [];
    destroyChart(txVolumeChartInstance);
    txVolumeChartInstance = new Chart(document.getElementById('txVolumeChart'), {
      type: 'bar',
      data: {
        labels: volData.map(d => d.date),
        datasets: [{
          label: 'Transactions',
          data: volData.map(d => d.count),
          backgroundColor: '#3b82f6',
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#d1d5db' } } },
        scales: {
          x: { ticks: { color: '#9ca3af' }, grid: { color: '#374151' } },
          y: { ticks: { color: '#9ca3af' }, grid: { color: '#374151' }, beginAtZero: true }
        }
      }
    });

    // Sources pie chart
    const srcEntries = Object.entries(a.sources || {}).sort((a, b) => b[1] - a[1]);
    destroyChart(sourcesChartInstance);
    sourcesChartInstance = null;
    const sourcesEmpty = document.getElementById('sourcesEmpty');
    const sourcesCanvas = document.getElementById('sourcesChart');
    if (srcEntries.length > 0) {
      sourcesCanvas.classList.remove('hidden');
      sourcesEmpty.classList.add('hidden');
      sourcesChartInstance = new Chart(sourcesCanvas, {
        type: 'pie',
        data: {
          labels: srcEntries.map(([k]) => sourceLabel(k)),
          datasets: [{
            data: srcEntries.map(([, v]) => v),
            backgroundColor: CHART_COLORS
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'right', labels: { color: '#d1d5db', boxWidth: 12 } } }
        }
      });
    } else {
      sourcesCanvas.classList.add('hidden');
      sourcesEmpty.classList.remove('hidden');
    }

    // Sinks pie chart
    const sinkEntries = Object.entries(a.sinks || {}).sort((a, b) => b[1] - a[1]);
    destroyChart(sinksChartInstance);
    sinksChartInstance = null;
    const sinksEmpty = document.getElementById('sinksEmpty');
    const sinksCanvas = document.getElementById('sinksChart');
    if (sinkEntries.length > 0) {
      sinksCanvas.classList.remove('hidden');
      sinksEmpty.classList.add('hidden');
      sinksChartInstance = new Chart(sinksCanvas, {
        type: 'pie',
        data: {
          labels: sinkEntries.map(([k]) => sourceLabel(k)),
          datasets: [{
            data: sinkEntries.map(([, v]) => v),
            backgroundColor: CHART_COLORS
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { position: 'right', labels: { color: '#d1d5db', boxWidth: 12 } } }
        }
      });
    } else {
      sinksCanvas.classList.add('hidden');
      sinksEmpty.classList.remove('hidden');
    }

    // Top earners
    renderRankingList(
      document.getElementById('topEarnersList'),
      a.topEarners,
      'totalEarned',
      '+',
      'text-green-400',
      'No earner data for this period.'
    );

    // Top spenders
    renderRankingList(
      document.getElementById('topSpendersList'),
      a.topSpenders,
      'totalSpent',
      '-',
      'text-red-400',
      'No spender data for this period.'
    );

    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('mainDashboard').classList.remove('hidden');

  } catch (err) {
    console.error('Error loading analytics:', err);
    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('noGuildState').classList.remove('hidden');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadGuilds();

  document.getElementById('guildSelect').addEventListener('change', async (e) => {
    currentServerId = e.target.value || null;
    document.getElementById('exportBtn').disabled = !currentServerId;
    if (currentServerId) {
      await loadAnalytics();
    } else {
      document.getElementById('mainDashboard').classList.add('hidden');
      document.getElementById('noGuildState').classList.remove('hidden');
    }
  });

  document.getElementById('dateRange').addEventListener('change', async () => {
    if (currentServerId) await loadAnalytics();
  });

  document.getElementById('exportBtn').addEventListener('click', () => {
    if (!currentServerId) return;
    const selectedDays = document.getElementById('dateRange').value;
    const days = ['7', '30', '90'].includes(selectedDays) ? selectedDays : '30';
    const serverId = encodeURIComponent(currentServerId);
    window.location.assign(`/api/economy/admin/${serverId}/export?days=${days}`);
  });
});
