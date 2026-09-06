/**
 * Economy Dashboard Component
 * Handles personal wealth overview, rank badge, charts and quick actions.
 */

/* global Chart, fetchWithCsrf */

(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────────────
  let currentIdentityId = null;
  let currentGuildId = null;
  let economyData = null;
  let earningsChart = null;
  let spendingChart = null;
  let currencySymbol = '$';

  // ─── Helpers ─────────────────────────────────────────────────────────────────
  function fmt(amount) {
    return `${currencySymbol}${Number(amount || 0).toFixed(2)}`;
  }

  function relativeTime(ts) {
    if (!ts) return 'N/A';
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function txIcon(type) {
    const icons = {
      earn: '💰',
      deposit: '⬆️',
      withdraw: '⬇️',
      transfer_send: '📤',
      transfer_receive: '📥',
      penalty: '💸',
      bank_fee: '🏦',
    };
    return icons[type] || '💱';
  }

  function txColor(type) {
    if (['earn', 'transfer_receive', 'withdraw'].includes(type)) return 'text-green-400';
    if (['penalty', 'transfer_send', 'bank_fee'].includes(type)) return 'text-red-400';
    return 'text-blue-400';
  }

  // ─── Render wealth cards ──────────────────────────────────────────────────────
  function renderWealthCards(wallet, bank) {
    const total = (wallet?.cashOnHand || 0) + (bank?.balance || 0);
    document.getElementById('ed-wallet').textContent = fmt(wallet?.cashOnHand);
    document.getElementById('ed-bank').textContent = fmt(bank?.balance);
    document.getElementById('ed-total').textContent = fmt(total);
  }

  // ─── Render rank badge ────────────────────────────────────────────────────────
  function renderRank(stats) {
    const el = document.getElementById('ed-rank');
    if (!el) return;
    el.textContent = `🏆 Rank #${stats.leaderboardRank} of ${stats.totalPlayers}`;
  }

  // ─── Render earnings pie chart ────────────────────────────────────────────────
  function renderEarningsChart(stats) {
    const ctx = document.getElementById('earningsChart');
    if (!ctx) return;
    if (earningsChart) earningsChart.destroy();
    const src = stats.earningsBySource || {};
    const labels = Object.keys(src).map(k => k.charAt(0).toUpperCase() + k.slice(1));
    const data = Object.values(src);
    if (data.length === 0) {
      ctx.parentElement.innerHTML = '<p class="text-gray-400 text-center py-6">No earnings data yet.</p>';
      return;
    }
    earningsChart = new Chart(ctx, {
      type: 'pie',
      data: {
        labels,
        datasets: [{ data, backgroundColor: ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'] }]
      },
      options: { plugins: { legend: { labels: { color: '#d1d5db' } } } }
    });
  }

  // ─── Render spending pie chart ────────────────────────────────────────────────
  function renderSpendingChart(stats) {
    const ctx = document.getElementById('spendingChart');
    if (!ctx) return;
    if (spendingChart) spendingChart.destroy();
    const src = stats.spendingByType || {};
    const labels = Object.keys(src).map(k => k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
    const data = Object.values(src);
    if (data.length === 0) {
      ctx.parentElement.innerHTML = '<p class="text-gray-400 text-center py-6">No spending data yet.</p>';
      return;
    }
    spendingChart = new Chart(ctx, {
      type: 'pie',
      data: {
        labels,
        datasets: [{ data, backgroundColor: ['#ef4444', '#f59e0b', '#3b82f6', '#8b5cf6', '#10b981'] }]
      },
      options: { plugins: { legend: { labels: { color: '#d1d5db' } } } }
    });
  }

  // ─── Render recent transactions ───────────────────────────────────────────────
  function renderRecentActivity(transactions) {
    const el = document.getElementById('ed-activity');
    if (!el) return;
    if (!transactions || transactions.length === 0) {
      el.innerHTML = '<p class="text-gray-400 text-center py-4">No recent transactions.</p>';
      return;
    }
    el.innerHTML = transactions.slice(0, 10).map(t => `
      <div class="flex items-center justify-between py-2 border-b border-gray-700">
        <div class="flex items-center gap-2">
          <span>${txIcon(t.transactionType)}</span>
          <div>
            <p class="text-sm font-medium">${t.description || t.transactionType}</p>
            <p class="text-xs text-gray-400">${relativeTime(t.timestamp)}</p>
          </div>
        </div>
        <span class="font-semibold ${txColor(t.transactionType)}">${t.amount >= 0 ? '+' : ''}${fmt(t.amount)}</span>
      </div>
    `).join('');
  }

  // ─── Load all data ────────────────────────────────────────────────────────────
  async function loadDashboard(identityId, serverId) {
    currentIdentityId = identityId;
    currentGuildId = serverId;

    try {
      const [walletRes, statsRes, txRes] = await Promise.all([
        fetch(`/api/economy/player/${identityId}?serverId=${encodeURIComponent(serverId)}`),
        fetch(`/api/economy/player/${identityId}/stats?serverId=${encodeURIComponent(serverId)}`),
        fetch(`/api/economy/player/${identityId}/transactions?serverId=${encodeURIComponent(serverId)}&limit=10`)
      ]);

      const walletData = await walletRes.json();
      const statsData = await statsRes.json();
      const txData = await txRes.json();

      if (!walletData.success) return;
      economyData = walletData;
      currencySymbol = walletData.currency?.symbol || '$';

      renderWealthCards(walletData.wallet, walletData.bank);

      if (statsData.success) {
        renderRank(statsData.stats);
        renderEarningsChart(statsData.stats);
        renderSpendingChart(statsData.stats);

        // Stats summary
        const el = document.getElementById('ed-stats-summary');
        if (el) {
          el.innerHTML = `
            <div class="grid grid-cols-2 gap-3 text-sm">
              <div><span class="text-gray-400">Total Earned:</span> <span class="text-green-400 font-semibold">${fmt(statsData.stats.totalEarned)}</span></div>
              <div><span class="text-gray-400">Total Spent:</span> <span class="text-red-400 font-semibold">${fmt(statsData.stats.totalSpent)}</span></div>
            </div>
          `;
        }
      }

      if (txData.success) {
        renderRecentActivity(txData.transactions);
      }

    } catch (err) {
      console.error('Error loading economy dashboard:', err);
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────────
  window.EconomyDashboard = { load: loadDashboard };
})();
