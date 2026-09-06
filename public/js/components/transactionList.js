/**
 * Transaction List Component
 * Filterable, paginated transaction list with CSV export.
 */

(function () {
  'use strict';

  let allTransactions = [];
  let filtered = [];
  let currentPage = 1;
  const PAGE_SIZE = 20;
  let currentIdentityId = null;
  let currencySymbol = '$';
  let requestVersion = 0;

  function fmt(amount) {
    return `${escapeHtml(currencySymbol)}${Math.abs(Number(amount || 0)).toFixed(2)}`;
  }

  function relativeTime(ts) {
    if (!ts) return 'N/A';
    const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(ts).toLocaleDateString();
  }

  function txIcon(type) {
    const icons = {
      earn: '💰', deposit: '⬆️', withdraw: '⬇️',
      transfer_send: '📤', transfer_receive: '📥', penalty: '💸'
    };
    return icons[type] || '💱';
  }

  function txColorClass(type, amount) {
    if (amount > 0) return 'text-green-400';
    if (amount < 0) return 'text-red-400';
    return 'text-blue-400';
  }

  function txLabel(type) {
    const labels = {
      earn: 'Earned', deposit: 'Deposited', withdraw: 'Withdrawn',
      transfer_send: 'Sent', transfer_receive: 'Received', penalty: 'Penalty'
    };
    return escapeHtml(labels[type] || type);
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function groupByDate(transactions) {
    const groups = {};
    for (const t of transactions) {
      const date = t.timestamp ? new Date(t.timestamp).toLocaleDateString() : 'Unknown';
      if (!groups[date]) groups[date] = [];
      groups[date].push(t);
    }
    return groups;
  }

  function render() {
    const container = document.getElementById('transactionList');
    const paginationEl = document.getElementById('tl-pagination');
    if (!container) return;

    const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
    const start = (currentPage - 1) * PAGE_SIZE;
    const page = filtered.slice(start, start + PAGE_SIZE);

    if (page.length === 0) {
      container.innerHTML = '<div class="text-center py-12 text-gray-400"><p class="text-4xl mb-3">📭</p><p>No transactions found.</p></div>';
    } else {
      const groups = groupByDate(page);
      container.innerHTML = Object.entries(groups).map(([date, txs]) => `
        <div class="mb-4">
          <p class="text-xs font-semibold text-gray-500 uppercase mb-2">${date}</p>
          ${txs.map(t => `
            <div class="bg-gray-750 hover:bg-gray-700 border border-gray-700 rounded-lg p-4 mb-2 transition-colors cursor-pointer"
                 data-transaction-id="${escapeHtml(t.id)}">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-3">
                  <span class="text-2xl">${txIcon(t.transactionType)}</span>
                  <div>
                    <p class="font-semibold">${txLabel(t.transactionType)}</p>
                    <p class="text-xs text-gray-400">${escapeHtml(t.description || t.source || '')}</p>
                  </div>
                </div>
                <div class="text-right">
                  <p class="font-bold ${txColorClass(t.transactionType, t.amount)}">${t.amount >= 0 ? '+' : '-'}${fmt(t.amount)}</p>
                  <p class="text-xs text-gray-500">${relativeTime(t.timestamp)}</p>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      `).join('');
    }

    // Pagination
    if (paginationEl) {
      if (totalPages <= 1) {
        paginationEl.innerHTML = '';
      } else {
        paginationEl.innerHTML = `
          <button id="tl-prev" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded disabled:opacity-40" ${currentPage === 1 ? 'disabled' : ''}>← Prev</button>
          <span class="text-gray-400 text-sm">Page ${currentPage} of ${totalPages}</span>
          <button id="tl-next" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded disabled:opacity-40" ${currentPage === totalPages ? 'disabled' : ''}>Next →</button>
        `;
        document.getElementById('tl-prev')?.addEventListener('click', () => { currentPage--; render(); });
        document.getElementById('tl-next')?.addEventListener('click', () => { currentPage++; render(); });
      }
    }
  }

  function applyFilters() {
    const type = document.getElementById('typeFilter')?.value || 'all';
    const search = (document.getElementById('tl-search')?.value || '').toLowerCase().trim();
    const startDateVal = document.getElementById('startDate')?.value;
    const endDateVal = document.getElementById('endDate')?.value;
    const minAmt = parseFloat(document.getElementById('minAmount')?.value) || null;
    const maxAmt = parseFloat(document.getElementById('maxAmount')?.value) || null;

    const startDate = startDateVal ? new Date(startDateVal) : null;
    const endDate = endDateVal ? new Date(endDateVal + 'T23:59:59') : null;

    filtered = allTransactions.filter(t => {
      if (type !== 'all' && t.transactionType !== type) return false;
      if (search && !(t.description || '').toLowerCase().includes(search) &&
          !(t.transactionType || '').toLowerCase().includes(search)) return false;
      if (startDate && new Date(t.timestamp) < startDate) return false;
      if (endDate && new Date(t.timestamp) > endDate) return false;
      if (minAmt !== null && Math.abs(t.amount) < minAmt) return false;
      if (maxAmt !== null && Math.abs(t.amount) > maxAmt) return false;
      return true;
    });

    currentPage = 1;
    render();
  }

  function csvEscape(val) {
    const str = String(val === null || val === undefined ? '' : val);
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function exportCsv() {
    const rows = [['ID', 'Type', 'Amount', 'Balance After', 'Account', 'Source', 'Description', 'Timestamp']];
    for (const t of filtered) {
      rows.push([
        t.id, t.transactionType, t.amount, t.balanceAfter,
        t.accountType, t.source || '', t.description || '', t.timestamp
      ]);
    }
    const csv = rows.map(r => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transactions-${currentIdentityId}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function showDetail(id) {
    const t = allTransactions.find(x => x.id === id);
    if (!t) return;
    const modal = document.getElementById('txDetailModal');
    const body = document.getElementById('txDetailBody');
    if (!modal || !body) return;
    body.innerHTML = `
      <div class="space-y-3 text-sm">
        <div class="flex justify-between"><span class="text-gray-400">Type:</span><span class="font-semibold">${txLabel(t.transactionType)}</span></div>
        <div class="flex justify-between"><span class="text-gray-400">Amount:</span><span class="font-semibold ${txColorClass(t.transactionType, t.amount)}">${t.amount >= 0 ? '+' : '-'}${fmt(t.amount)}</span></div>
        <div class="flex justify-between"><span class="text-gray-400">Balance After:</span><span>${fmt(t.balanceAfter)}</span></div>
        <div class="flex justify-between"><span class="text-gray-400">Account:</span><span>${escapeHtml(t.accountType || '')}</span></div>
        <div class="flex justify-between"><span class="text-gray-400">Source:</span><span>${escapeHtml(t.source || '—')}</span></div>
        <div class="flex justify-between"><span class="text-gray-400">Description:</span><span>${escapeHtml(t.description || '—')}</span></div>
        <div class="flex justify-between"><span class="text-gray-400">Server:</span><span>${escapeHtml(t.serverName || '—')}</span></div>
        <div class="flex justify-between"><span class="text-gray-400">Time:</span><span>${new Date(t.timestamp).toLocaleString()}</span></div>
      </div>
    `;
    modal.classList.remove('hidden');
  }

  function showLoading() {
    const container = document.getElementById('transactionList');
    if (container) {
      container.innerHTML = '<div class="text-center py-12"><div class="inline-block w-8 h-8 border-4 border-green-600 border-t-transparent rounded-full animate-spin"></div></div>';
    }
  }

  function beginContextChange() {
    requestVersion++;
    allTransactions = [];
    filtered = [];
    currentIdentityId = null;
    currentPage = 1;
    showLoading();
  }

  async function load(identityId, options) {
    const version = ++requestVersion;
    currentIdentityId = identityId;
    currencySymbol = options?.currencySymbol || '$';
    showLoading();

    try {
      const transactions = [];
      let offset = 0;
      let snapshotId = null;
      let hasMore = true;
      while (hasMore) {
        const snapshotQuery = snapshotId === null ? '' : `&snapshotId=${encodeURIComponent(snapshotId)}`;
        const res = await fetch(`/api/economy/player/${identityId}/transactions?serverId=${encodeURIComponent(options?.serverId)}&limit=200&offset=${offset}${snapshotQuery}`);
        const data = await res.json();
        if (version !== requestVersion) return;
        if (!data.success) throw new Error(data.error || 'Failed to load');
        if (snapshotId === null) snapshotId = Number(data.snapshotId) || 0;
        transactions.push(...(data.transactions || []));
        hasMore = Boolean(data.pagination?.hasMore);
        if (hasMore) {
          const pageLimit = Number(data.pagination?.limit) || (data.transactions || []).length;
          const nextOffset = offset + pageLimit;
          if (pageLimit <= 0 || nextOffset <= offset) throw new Error('Invalid transaction pagination response');
          offset = nextOffset;
        }
      }
      allTransactions = transactions;
      filtered = [...allTransactions];
      render();
    } catch (err) {
      if (version !== requestVersion) return;
      console.error('TransactionList load error:', err);
      const container = document.getElementById('transactionList');
      if (container) container.innerHTML = '<div class="text-center py-12 text-red-400">Failed to load transactions.</div>';
    }
  }

  function setupControls() {
    document.getElementById('typeFilter')?.addEventListener('change', applyFilters);
    document.getElementById('tl-search')?.addEventListener('input', applyFilters);
    document.getElementById('startDate')?.addEventListener('change', applyFilters);
    document.getElementById('endDate')?.addEventListener('change', applyFilters);
    document.getElementById('minAmount')?.addEventListener('input', applyFilters);
    document.getElementById('maxAmount')?.addEventListener('input', applyFilters);
    document.getElementById('exportCSV')?.addEventListener('click', exportCsv);
    document.getElementById('transactionList')?.addEventListener('click', event => {
      const row = event.target.closest('[data-transaction-id]');
      if (row) showDetail(Number(row.dataset.transactionId));
    });

    const closeBtn = document.getElementById('closeTxDetail');
    closeBtn?.addEventListener('click', () => {
      document.getElementById('txDetailModal')?.classList.add('hidden');
    });
    document.getElementById('txDetailModal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
    });
  }

  window.TransactionList = { load, beginContextChange, setupControls, showDetail };
})();
