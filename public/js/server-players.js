/* global document, window */
/* global fetchWithCsrf */

// ─── State ────────────────────────────────────────────────────────────────────
let currentServerId = null;
let currentPage     = 1;
let pageSize        = 50;
let totalFiltered   = 0;
let sortCol         = 'lastSeen';
let sortDir         = 'desc';
let searchTerm      = '';
let filterMode      = '';
let searchTimer     = null;

// ─── Formatting helpers ───────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Human-readable relative time (e.g. "3h ago", "12d ago") */
function relativeTime(isoStr) {
  if (!isoStr) return '—';
  const diff = Date.now() - new Date(isoStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)   return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30)   return `${d}d ago`;
  return new Date(isoStr).toLocaleDateString();
}

/** Compact playtime format: "4h 30m" or "45m" */
function formatPlaytime(seconds) {
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Colored platform badge */
function platformBadge(platform) {
  const p = (platform || '').toLowerCase();
  if (p.includes('xbox'))
    return '<span class="bg-green-900 text-green-300 text-xs px-1.5 py-px rounded font-medium">XB</span>';
  if (p.includes('ps') || p.includes('playstation'))
    return '<span class="bg-blue-900 text-blue-300 text-xs px-1.5 py-px rounded font-medium">PS</span>';
  if (p.includes('switch2') || p.includes('switch 2') || p.includes('dayzswitch'))
    return '<span class="bg-red-900 text-red-300 text-xs px-1.5 py-px rounded font-medium">NS2</span>';
  if (p.includes('steam') || p.includes('pc'))
    return '<span class="bg-gray-600 text-gray-300 text-xs px-1.5 py-px rounded font-medium">PC</span>';
  return `<span class="bg-gray-700 text-gray-400 text-xs px-1.5 py-px rounded font-medium">${escHtml(platform || '?')}</span>`;
}

// ─── Toast notifications ──────────────────────────────────────────────────────

function showToast(msg, color = 'green') {
  const area = document.getElementById('toastArea');
  const colors = {
    green:  'bg-green-900 border-green-700 text-green-200',
    red:    'bg-red-900 border-red-700 text-red-200',
    yellow: 'bg-yellow-900 border-yellow-700 text-yellow-200',
  };
  const el = document.createElement('div');
  el.className = `pointer-events-auto border rounded px-4 py-2 text-sm shadow-lg ${colors[color] || colors.green}`;
  el.textContent = msg;
  area.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ─── Sort indicators ──────────────────────────────────────────────────────────

function updateSortIndicators() {
  document.querySelectorAll('.sort-indicator').forEach(el => {
    const col = el.dataset.col;
    el.textContent = col === sortCol ? (sortDir === 'asc' ? '↑' : '↓') : '';
  });
  document.querySelectorAll('[data-sort]').forEach(th => {
    th.classList.toggle('text-gray-200', th.dataset.sort === sortCol);
    th.classList.toggle('text-gray-500', th.dataset.sort !== sortCol);
  });
}

// ─── Pagination controls ──────────────────────────────────────────────────────

function updatePagination(total) {
  totalFiltered = total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total > 0 ? (currentPage - 1) * pageSize + 1 : 0;
  const to   = Math.min(currentPage * pageSize, total);

  document.getElementById('showingText').textContent =
    total > 0 ? `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}` : 'No results';
  document.getElementById('pageIndicator').textContent = `Page ${currentPage} / ${totalPages}`;

  const atFirst = currentPage <= 1;
  const atLast  = currentPage >= totalPages;
  document.getElementById('firstBtn').disabled = atFirst;
  document.getElementById('prevBtn').disabled  = atFirst;
  document.getElementById('nextBtn').disabled  = atLast;
  document.getElementById('lastBtn').disabled  = atLast;
}

// ─── Server list ──────────────────────────────────────────────────────────────

async function loadServers() {
  try {
    const res = await fetch('/api/owner/servers');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      document.getElementById('serverSelect').innerHTML =
        `<option value="">Error: ${escHtml(err.error || 'Could not load servers (status ' + res.status + ')')}</option>`;
      return;
    }
    const data = await res.json();
    const select = document.getElementById('serverSelect');
    if (data.success && data.servers?.length) {
      select.innerHTML = '<option value="">— Select a server —</option>' +
        data.servers.map(s =>
          `<option value="${s.id}">${escHtml(s.name)} (${escHtml(s.guildName || '')})</option>`
        ).join('');
    } else {
      select.innerHTML = '<option value="">No servers found — contact your admin</option>';
    }
  } catch (err) {
    console.error('Failed to load servers:', err);
    document.getElementById('serverSelect').innerHTML = '<option value="">Failed to load servers</option>';
  }
}

// ─── Player list (paginated, sorted, filtered) ────────────────────────────────

async function loadPlayers() {
  if (!currentServerId) return;

  const tbody = document.getElementById('playerTableBody');
  tbody.innerHTML = `<tr><td colspan="7" class="text-gray-500 py-8 text-center text-sm">Loading...</td></tr>`;

  const params = new URLSearchParams({ page: currentPage, limit: pageSize, sort: sortCol, dir: sortDir });
  if (searchTerm) params.set('search', searchTerm);
  if (filterMode) params.set('filter', filterMode);

  try {
    const res  = await fetch(`/api/owner/servers/${currentServerId}/players?${params}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Unknown error');

    // Update stats bar
    if (data.stats) {
      document.getElementById('statTotal').textContent  = (data.stats.total  || 0).toLocaleString();
      document.getElementById('statAlts').textContent   = (data.stats.alts   || 0).toLocaleString();
      document.getElementById('statLinked').textContent = (data.stats.linked || 0).toLocaleString();
    }

    updatePagination(data.total || 0);
    renderTable(data.players || []);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-red-400 py-8 text-center text-sm">❌ ${escHtml(err.message)}</td></tr>`;
  }
}

// ─── Table rendering ──────────────────────────────────────────────────────────

function renderTable(players) {
  const tbody = document.getElementById('playerTableBody');
  if (!players.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-gray-500 py-8 text-center text-sm">No players found.</td></tr>`;
    return;
  }

  const grouped = players;

  tbody.innerHTML = grouped.map(p => {
    const gt         = escHtml(p.gamertag || '—');
    const gtData     = escHtml(p.gamertag || '');
    const identityId = escHtml(String(p.id || ''));
    const isAlt      = Number(p.is_alt) === 1;
    const isGrouped  = false;

    const altBadge = isAlt
      ? ' <span class="bg-red-900 text-red-300 text-xs px-1 py-px rounded font-medium leading-none">ALT</span>'
      : '';

    const lastSeen = relativeTime(p.lastSeen);
    const playtime = formatPlaytime(Number(p.totalPlaytime) || 0);
    const kills    = p.totalKills  ?? 0;
    const deaths   = p.totalDeaths ?? 0;

    const discord = p.linkedUsername
      ? `<span class="text-blue-400 text-xs">${escHtml(p.linkedUsername)}</span>`
      : '<span class="text-gray-700 text-xs">—</span>';

    // Nested alt rows get a left indent, a subtle connector line, and a dimmer background
    const rowCls = isGrouped
      ? 'border-b border-gray-700/40 bg-red-950/10 hover:bg-red-950/25'
      : (isAlt
          ? 'border-b border-gray-700/60 hover:bg-red-950/20'
          : 'border-b border-gray-700/60 hover:bg-gray-700/20');

    // Gamertag cell — indent nested rows with a tree connector
    const nameCell = isGrouped
      ? `<td class="px-3 py-1.5 font-medium whitespace-nowrap">
           <span class="inline-flex items-center gap-1">
             <span class="text-gray-600 text-xs select-none">└─</span>
             ${gt}${altBadge}
           </span>
         </td>`
      : `<td class="px-3 py-1.5 font-medium whitespace-nowrap">${gt}${altBadge}</td>`;

    return `<tr class="${rowCls}">
      ${nameCell}
      <td class="px-3 py-1.5">${platformBadge(p.platform)}</td>
      <td class="px-3 py-1.5 text-gray-400 text-xs whitespace-nowrap" title="${escHtml(p.lastSeen || '')}">${lastSeen}</td>
      <td class="px-3 py-1.5 text-gray-400 text-xs whitespace-nowrap">${playtime}</td>
      <td class="px-3 py-1.5 text-gray-300 text-xs whitespace-nowrap tabular-nums">${kills} / ${deaths}</td>
      <td class="px-3 py-1.5 text-gray-500 text-xs font-mono whitespace-nowrap" title="${escHtml(p.platform_user_id || '')}">${p.platform_user_id ? escHtml(p.platform_user_id.slice(0, 12)) + (p.platform_user_id.length > 12 ? '…' : '') : '—'}</td>
      <td class="px-3 py-1.5 whitespace-nowrap">${discord}</td>
      <td class="px-3 py-1.5 whitespace-nowrap">
        <div class="flex gap-1">
          <button data-action="blacklist"    data-gamertag="${gtData}" title="Blacklist" class="bg-red-800 hover:bg-red-700 px-1.5 py-0.5 rounded text-xs leading-none">🚫</button>
          <button data-action="whitelist"    data-gamertag="${gtData}" title="Whitelist" class="bg-green-800 hover:bg-green-700 px-1.5 py-0.5 rounded text-xs leading-none">✅</button>
          <button data-action="prioritylist" data-gamertag="${gtData}" title="Priority"  class="bg-yellow-700 hover:bg-yellow-600 px-1.5 py-0.5 rounded text-xs leading-none">⭐</button>
          <button data-action="wipe-player"  data-identity-id="${identityId}" data-gamertag="${gtData}" title="Wipe player data" class="bg-orange-900 hover:bg-orange-800 px-1.5 py-0.5 rounded text-xs leading-none">🗑</button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ─── List actions (ban / whitelist / priority) ────────────────────────────────

async function listAction(listType, action, gamertag) {
  if (!currentServerId) return;
  try {
    const res  = await fetchWithCsrf(`/api/owner/servers/${currentServerId}/list/${listType}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ gamertag }),
    });
    const data = await res.json();
    showToast(data.success ? `✅ ${data.message}` : `❌ ${data.error}`, data.success ? 'green' : 'red');
    // Refresh the list panel section if it's currently open
    if (data.success && !document.getElementById('listPanelContent').classList.contains('hidden')) {
      await loadListSection(listType);
    }
  } catch (err) {
    showToast(`❌ Error: ${err.message}`, 'red');
  }
}

// ─── Player wipe ─────────────────────────────────────────────────────────────

async function wipePlayerAction(identityId, gamertag) {
  if (!currentServerId || !identityId) return;
  if (!window.confirm(
    `⚠️ FULL WIPE — "${gamertag}"\n\n` +
    'Permanently deletes ALL tracked data (stats, economy, achievements).\n\n' +
    'This action cannot be undone. Proceed?'
  )) return;
  try {
    const res  = await fetchWithCsrf(
      `/api/owner/servers/${currentServerId}/players/${encodeURIComponent(identityId)}/wipe`,
      { method: 'POST' }
    );
    const data = await res.json();
    if (data.success) { showToast(`🗑️ ${gamertag} wiped`, 'yellow'); await loadPlayers(); }
    else showToast(`❌ ${data.error}`, 'red');
  } catch (err) {
    showToast(`❌ Error: ${err.message}`, 'red');
  }
}

// ─── Server wipe ──────────────────────────────────────────────────────────────

async function wipeServerAction() {
  if (!currentServerId) return;
  if (!window.confirm('⚠️⚠️ FULL SERVER WIPE ⚠️⚠️\n\nPermanently deletes ALL player data for EVERY player on this server. THIS CANNOT BE UNDONE.')) return;
  if (!window.confirm('FINAL CONFIRMATION: Click OK to permanently wipe all player data from this server.')) return;
  try {
    const res  = await fetchWithCsrf(`/api/owner/servers/${currentServerId}/wipe`, { method: 'POST' });
    const data = await res.json();
    if (data.success) { showToast(`🗑️ ${data.message}`, 'yellow'); currentPage = 1; await loadPlayers(); }
    else showToast(`❌ ${data.error}`, 'red');
  } catch (err) {
    showToast(`❌ Error: ${err.message}`, 'red');
  }
}

// ─── List Management panel ────────────────────────────────────────────────────

const LIST_COLORS = {
  whitelist:    { item: 'bg-green-900/30 text-green-200 border-green-900', remove: 'text-green-500 hover:text-red-400' },
  blacklist:    { item: 'bg-red-900/30 text-red-200 border-red-900',       remove: 'text-red-500 hover:text-red-300' },
  prioritylist: { item: 'bg-yellow-900/30 text-yellow-200 border-yellow-900', remove: 'text-yellow-500 hover:text-red-400' },
};

/**
 * Fetch and render the entries for one list type.
 * Updates the count badge and fills the item container.
 */
async function loadListSection(listType) {
  if (!currentServerId) return;
  const countEl = document.getElementById(`${listType}Count`);
  const itemsEl = document.getElementById(`${listType}Items`);
  if (!itemsEl) return;

  itemsEl.innerHTML = '<span class="text-gray-600 italic">Loading…</span>';
  if (countEl) countEl.textContent = '';

  try {
    const res  = await fetch(`/api/owner/servers/${currentServerId}/list/${listType}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Failed to load');

    const entries = data.entries || [];
    if (countEl) countEl.textContent = `(${entries.length})`;

    const colors = LIST_COLORS[listType] || LIST_COLORS.whitelist;
    if (!entries.length) {
      itemsEl.innerHTML = '<span class="text-gray-600 italic">Empty</span>';
      return;
    }
    itemsEl.innerHTML = entries.map(gt => `
      <div class="flex items-center justify-between rounded px-2 py-0.5 border ${colors.item}">
        <span class="truncate" title="${escHtml(gt)}">${escHtml(gt)}</span>
        <button data-remove-list="${listType}" data-gamertag="${escHtml(gt)}"
          class="${colors.remove} ml-2 shrink-0 text-sm leading-none font-bold" title="Remove">×</button>
      </div>
    `).join('');
  } catch (err) {
    itemsEl.innerHTML = `<span class="text-red-400 text-xs">❌ ${escHtml(err.message)}</span>`;
  }
}

/** Load all three lists simultaneously */
async function loadAllLists() {
  await Promise.all([
    loadListSection('whitelist'),
    loadListSection('blacklist'),
    loadListSection('prioritylist'),
  ]);
}

/** Add a gamertag to a list and refresh that section */
async function listAdd(listType, gamertag) {
  if (!gamertag.trim()) return;
  try {
    const res  = await fetchWithCsrf(`/api/owner/servers/${currentServerId}/list/${listType}/add`, {
      method: 'POST',
      body: JSON.stringify({ gamertag: gamertag.trim() }),
    });
    const data = await res.json();
    showToast(data.success ? `✅ ${data.message}` : `❌ ${data.error}`, data.success ? 'green' : 'red');
    if (data.success) {
      document.getElementById(`${listType}Input`).value = '';
      await loadListSection(listType);
    }
  } catch (err) {
    showToast(`❌ ${err.message}`, 'red');
  }
}

/** Clear all entries from a list after confirmation */
async function listClear(listType) {
  const names = { whitelist: 'Whitelist', blacklist: 'Banlist', prioritylist: 'Priority List' };
  if (!window.confirm(`⚠️ Clear entire ${names[listType] || listType}?\n\nThis will remove ALL entries from the file on the server. This cannot be undone.`)) return;
  try {
    const res  = await fetchWithCsrf(`/api/owner/servers/${currentServerId}/list/${listType}/clear`, {
      method: 'POST',
    });
    const data = await res.json();
    showToast(data.success ? `🗑️ ${names[listType]} cleared` : `❌ ${data.error}`, data.success ? 'yellow' : 'red');
    if (data.success) await loadListSection(listType);
  } catch (err) {
    showToast(`❌ ${err.message}`, 'red');
  }
}

/** Remove a gamertag from a list and refresh that section */
async function listRemove(listType, gamertag) {
  try {
    const res  = await fetchWithCsrf(`/api/owner/servers/${currentServerId}/list/${listType}/remove`, {
      method: 'POST',
      body: JSON.stringify({ gamertag }),
    });
    const data = await res.json();
    showToast(data.success ? `🗑️ ${gamertag} removed` : `❌ ${data.error}`, data.success ? 'yellow' : 'red');
    if (data.success) await loadListSection(listType);
  } catch (err) {
    showToast(`❌ ${err.message}`, 'red');
  }
}

// ─── Possible-alt review panel ────────────────────────────────────────────────

function confidenceBadge(confidence) {
  const styles = {
    confirmed: 'bg-red-900 text-red-200',
    likely: 'bg-orange-900 text-orange-200',
    possible: 'bg-yellow-900 text-yellow-200',
  };
  return `<span class="${styles[confidence] || styles.possible} px-2 py-0.5 rounded text-xs font-semibold uppercase">${escHtml(confidence)}</span>`;
}

async function saveAltReview(identityIds, status, notes = '') {
  const res = await fetchWithCsrf(`/api/owner/servers/${currentServerId}/alts/review`, {
    method: 'POST',
    body: JSON.stringify({
      identityIdA: identityIds[0],
      identityIdB: identityIds[1],
      status,
      notes,
    }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Failed to save review');
  showToast(`Review marked ${status}`, status === 'dismissed' ? 'green' : 'yellow');
  await Promise.all([runAltDetection(), loadPlayers()]);
}

async function runAltDetection() {
  const status = document.getElementById('altStatus');
  const scanText = document.getElementById('altScanStatus');
  const container = document.getElementById('altGroups');
  if (status) status.textContent = 'Evaluating evidence…';
  container.innerHTML = '';

  try {
    const res = await fetch(`/api/owner/servers/${currentServerId}/alts`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    const candidates = data.candidates || [];
    if (scanText) scanText.textContent = 'Updated just now';

    if (!candidates.length) {
      status.textContent = 'No account pairs currently meet the review thresholds.';
      return;
    }

    status.textContent = `${candidates.length} candidate pair(s). Behavioral evidence never triggers automatic enforcement.`;
    container.innerHTML = candidates.map(candidate => {
      const accountLabels = candidate.accounts.map(account =>
        `<div class="flex items-center gap-2">${platformBadge(account.platform)}<span class="text-sm text-gray-100">${escHtml(account.gamertag)}</span></div>`
      ).join('');
      const evidence = candidate.evidence.map(item => {
        const count = item.count == null ? '' : ` (${Number(item.count).toLocaleString()})`;
        return `<li>${escHtml(item.label)}${count}</li>`;
      }).join('');
      const reviewStatus = candidate.review?.status || 'pending';
      const notes = candidate.review?.notes || '';
      const ids = escHtml(JSON.stringify(candidate.identityIds));
      const reviewNotes = escHtml(notes);
      const reviewControls = data.canReview ? `
          <div class="flex gap-2 justify-end">
            <button data-review-status="dismissed" data-review-notes="${reviewNotes}" data-identity-ids="${ids}" class="bg-gray-600 hover:bg-gray-500 px-2 py-1 rounded text-xs">Dismiss</button>
            <button data-review-status="pending" data-review-notes="${reviewNotes}" data-identity-ids="${ids}" class="bg-yellow-800 hover:bg-yellow-700 px-2 py-1 rounded text-xs">Pending</button>
            <button data-review-status="confirmed" data-review-notes="${reviewNotes}" data-identity-ids="${ids}" class="bg-red-800 hover:bg-red-700 px-2 py-1 rounded text-xs">Confirm Link</button>
          </div>` : '';

      return `
        <div class="bg-gray-700 rounded border border-gray-600 p-3" data-candidate-ids="${ids}">
          <div class="flex items-start justify-between gap-3 mb-2">
            <div class="space-y-1">${accountLabels}</div>
            <div class="text-right">
              ${confidenceBadge(candidate.confidence)}
              <div class="text-xs text-gray-400 mt-1">Review: ${escHtml(reviewStatus)}</div>
            </div>
          </div>
          <ul class="list-disc ml-5 text-xs text-gray-300 space-y-0.5 mb-3">${evidence}</ul>
          ${notes ? `<div class="text-xs text-gray-400 mb-2">Note: ${escHtml(notes)}</div>` : ''}
          ${reviewControls}
        </div>`;
    }).join('');
  } catch (err) {
    if (status) status.textContent = `❌ Error: ${err.message}`;
  }
}

// ─── Reset UI to "no server selected" state ───────────────────────────────────

function resetUI() {
  ['statsBar', 'controlsBar', 'playerSection', 'altPanel', 'listPanel'].forEach(id =>
    document.getElementById(id).classList.add('hidden')
  );
  document.getElementById('wipeServerBtn').classList.add('hidden');
  document.getElementById('playerTableBody').innerHTML =
    `<tr><td colspan="8" class="text-gray-500 py-8 text-center text-sm">Select a server above to view players.</td></tr>`;
}

// ─── DOMContentLoaded ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {

  // Player table — event delegation for row action buttons
  document.getElementById('playerTableBody').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const { action, gamertag, identityId } = btn.dataset;
    if (action === 'wipe-player') wipePlayerAction(identityId, gamertag);
    else if (action && gamertag) listAction(action, 'add', gamertag);
  });

  // Possible-alt review decisions
  document.getElementById('altGroups').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-review-status]');
    if (!btn) return;
    try {
      const identityIds = JSON.parse(btn.dataset.identityIds);
      await saveAltReview(identityIds, btn.dataset.reviewStatus, btn.dataset.reviewNotes || '');
    } catch (err) {
      showToast(`❌ ${err.message}`, 'red');
    }
  });

  // Sortable column headers
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      // Same column → flip direction; new column → sensible default
      if (sortCol === col) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortCol = col;
        sortDir = ['gamertag', 'platform'].includes(col) ? 'asc' : 'desc';
      }
      currentPage = 1;
      updateSortIndicators();
      loadPlayers();
    });
  });

  // Search (300 ms debounce)
  document.getElementById('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTerm  = e.target.value.trim();
      currentPage = 1;
      loadPlayers();
    }, 300);
  });

  // Filter dropdown
  document.getElementById('filterSelect').addEventListener('change', (e) => {
    filterMode  = e.target.value;
    currentPage = 1;
    loadPlayers();
  });

  // Page size dropdown
  document.getElementById('pageSizeSelect').addEventListener('change', (e) => {
    pageSize    = parseInt(e.target.value) || 50;
    currentPage = 1;
    loadPlayers();
  });

  // Pagination buttons
  document.getElementById('firstBtn').addEventListener('click', () => { currentPage = 1; loadPlayers(); });
  document.getElementById('prevBtn').addEventListener('click',  () => { if (currentPage > 1) { currentPage--; loadPlayers(); } });
  document.getElementById('nextBtn').addEventListener('click',  () => {
    const totalPages = Math.ceil(totalFiltered / pageSize);
    if (currentPage < totalPages) { currentPage++; loadPlayers(); }
  });
  document.getElementById('lastBtn').addEventListener('click',  () => {
    currentPage = Math.max(1, Math.ceil(totalFiltered / pageSize));
    loadPlayers();
  });

  // Wipe server
  document.getElementById('wipeServerBtn').addEventListener('click', wipeServerAction);

  // Alt stat card → filter to alts
  document.getElementById('altStatCard').addEventListener('click', () => {
    document.getElementById('filterSelect').value = 'alts';
    filterMode  = 'alts';
    currentPage = 1;
    loadPlayers();
  });

  // List panel expand/collapse
  document.getElementById('listPanelToggle').addEventListener('click', () => {
    const content  = document.getElementById('listPanelContent');
    const icon     = document.getElementById('listPanelIcon');
    const expanded = content.classList.toggle('hidden');
    icon.textContent = expanded ? '▶ Expand' : '▼ Collapse';
    if (!expanded && currentServerId) loadAllLists();
  });

  // List panel — reload buttons
  document.getElementById('listPanelContent').addEventListener('click', (e) => {
    const reloadBtn = e.target.closest('[data-reload-list]');
    if (reloadBtn) { loadListSection(reloadBtn.dataset.reloadList); return; }

    // Clear entire list
    const clearBtn = e.target.closest('[data-clear-list]');
    if (clearBtn) { listClear(clearBtn.dataset.clearList); return; }

    // Remove entry button
    const removeBtn = e.target.closest('[data-remove-list]');
    if (removeBtn) { listRemove(removeBtn.dataset.removeList, removeBtn.dataset.gamertag); return; }

    // Add entry button
    const addBtn = e.target.closest('[data-add-list]');
    if (addBtn) {
      const listType = addBtn.dataset.addList;
      const input    = document.getElementById(`${listType}Input`);
      if (input?.value.trim()) listAdd(listType, input.value.trim());
    }
  });

  // List panel — Enter key in inputs
  ['whitelist', 'blacklist', 'prioritylist'].forEach(lt => {
    document.getElementById(`${lt}Input`).addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.value.trim()) listAdd(lt, e.target.value.trim());
    });
  });

  // Alt panel expand/collapse
  document.getElementById('altPanelToggle').addEventListener('click', () => {
    const content  = document.getElementById('altPanelContent');
    const icon     = document.getElementById('altPanelIcon');
    const expanded = content.classList.toggle('hidden');
    icon.textContent = expanded ? '▶ Expand' : '▼ Collapse';
    if (!expanded && currentServerId) runAltDetection();
  });

  // Server select — reset state and load new server
  document.getElementById('serverSelect').addEventListener('change', async (e) => {
    currentServerId = e.target.value;

    // Reset all filter/sort/pagination state
    currentPage = 1;
    searchTerm  = '';
    filterMode  = '';
    sortCol     = 'lastSeen';
    sortDir     = 'desc';
    document.getElementById('searchInput').value    = '';
    document.getElementById('filterSelect').value   = '';
    document.getElementById('pageSizeSelect').value = String(pageSize);
    updateSortIndicators();

    if (!currentServerId) { resetUI(); return; }

    // Show panels
    ['statsBar', 'controlsBar', 'playerSection', 'altPanel', 'listPanel'].forEach(id =>
      document.getElementById(id).classList.remove('hidden')
    );
    document.getElementById('wipeServerBtn').classList.remove('hidden');

    // Collapse alt panel on server switch
    document.getElementById('altPanelContent').classList.add('hidden');
    document.getElementById('altPanelIcon').textContent = '▶ Expand';
    document.getElementById('altGroups').innerHTML = '';
    document.getElementById('altStatus').textContent = '';
    document.getElementById('altScanStatus').textContent = '';

    // Collapse list panel on server switch
    document.getElementById('listPanelContent').classList.add('hidden');
    document.getElementById('listPanelIcon').textContent = '▶ Expand';

    // Reset stats to loading state
    ['statTotal', 'statAlts', 'statLinked'].forEach(id => {
      document.getElementById(id).textContent = '—';
    });

    await loadPlayers();
  });

  // Initial setup
  updateSortIndicators();
  loadServers();
});
