/**
 * Leaderboard Table Component
 * Sortable, searchable leaderboard with pagination.
 */

(function () {
  'use strict';

  let allRows = [];
  let filtered = [];
  let currentPage = 1;
  const PAGE_SIZE = 25;
  let currentSort = 'total';
  let currencySymbol = '$';
  let highlightIdentityId = null;

  function fmt(amount) {
    return `${currencySymbol}${Number(amount || 0).toFixed(2)}`;
  }

  function platformIcon(platform) {
    const icons = { xbox: '🎮', psn: '🎮', pc: '🖥️', steam: '🖥️' };
    return icons[(platform || '').toLowerCase()] || '🎮';
  }

  function rankBadge(rank) {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return `#${rank}`;
  }

  function applySort() {
    const sortFns = {
      total: (a, b) => b.totalWealth - a.totalWealth,
      cash: (a, b) => b.cashOnHand - a.cashOnHand,
      bank: (a, b) => b.bankBalance - a.bankBalance,
    };
    filtered.sort(sortFns[currentSort] || sortFns.total);
    filtered.forEach((r, i) => { r.rank = i + 1; });
  }

  function applyFilter(query) {
    const q = (query || '').toLowerCase().trim();
    filtered = q ? allRows.filter(r => (r.gamertag || '').toLowerCase().includes(q)) : [...allRows];
    applySort();
    currentPage = 1;
    render();
  }

  function render() {
    const tbody = document.getElementById('leaderboardBody');
    const paginationEl = document.getElementById('lb-pagination');
    if (!tbody) return;

    const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
    const start = (currentPage - 1) * PAGE_SIZE;
    const page = filtered.slice(start, start + PAGE_SIZE);

    if (page.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center py-8 text-gray-400">No players found.</td></tr>';
    } else {
      tbody.innerHTML = page.map(p => {
        const isHighlighted = highlightIdentityId && p.identityId === highlightIdentityId;
        return `
          <tr class="${isHighlighted ? 'bg-yellow-900 bg-opacity-30' : 'hover:bg-gray-700'} transition-colors">
            <td class="px-4 py-3 font-bold text-lg">${rankBadge(p.rank)}</td>
            <td class="px-4 py-3">
              <span class="mr-1">${platformIcon(p.platform)}</span>
              <span class="${isHighlighted ? 'text-yellow-300 font-bold' : ''}">${escapeHtml(p.gamertag || '—')}</span>
              ${isHighlighted ? '<span class="ml-2 text-xs bg-yellow-600 px-2 py-0.5 rounded">You</span>' : ''}
            </td>
            <td class="px-4 py-3 text-green-400">${fmt(p.cashOnHand)}</td>
            <td class="px-4 py-3 text-blue-400">${fmt(p.bankBalance)}</td>
            <td class="px-4 py-3 font-semibold">${fmt(p.totalWealth)}</td>
          </tr>
        `;
      }).join('');
    }

    // Pagination
    if (paginationEl) {
      if (totalPages <= 1) {
        paginationEl.innerHTML = '';
      } else {
        paginationEl.innerHTML = `
          <button id="lb-prev" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded disabled:opacity-40" ${currentPage === 1 ? 'disabled' : ''}>← Prev</button>
          <span class="text-gray-400 text-sm">Page ${currentPage} of ${totalPages}</span>
          <button id="lb-next" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded disabled:opacity-40" ${currentPage === totalPages ? 'disabled' : ''}>Next →</button>
        `;
        document.getElementById('lb-prev')?.addEventListener('click', () => { currentPage--; render(); });
        document.getElementById('lb-next')?.addEventListener('click', () => { currentPage++; render(); });
      }
    }
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async function load(serverId, options) {
    highlightIdentityId = options?.highlightIdentityId || null;
    currentSort = options?.sortBy || 'total';

    const tbody = document.getElementById('leaderboardBody');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center py-8"><div class="inline-block w-8 h-8 border-4 border-green-600 border-t-transparent rounded-full animate-spin"></div></td></tr>';
    }

    try {
      const res = await fetch(`/api/economy/${encodeURIComponent(serverId)}/leaderboard?limit=100&sortBy=${currentSort}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to load');
      currencySymbol = data.currencySymbol || '$';
      allRows = data.leaderboard || [];
      filtered = [...allRows];
      applySort();
      render();
    } catch (err) {
      console.error('Leaderboard load error:', err);
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="text-center py-8 text-red-400">Failed to load leaderboard.</td></tr>';
    }
  }

  function setupControls() {
    const searchEl = document.getElementById('lb-search');
    const sortEl = document.getElementById('sortBy');

    searchEl?.addEventListener('input', () => applyFilter(searchEl.value));

    sortEl?.addEventListener('change', () => {
      currentSort = sortEl.value;
      applySort();
      currentPage = 1;
      render();
    });
  }

  window.LeaderboardTable = { load, setupControls };
})();
