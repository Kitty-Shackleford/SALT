/*
 * DayZ Dashboard
 * Copyright (C) 2026
 * GNU Affero General Public License
 *
 * Casino Statistics Dashboard — fetches /api/casino/admin-stats and renders
 * summary cards, per-game breakdown, top winners/losers, and recent activity.
 */

let currentGuildId = null;

// ─────────────────────────────────────────────────────────────────────────────
// Initialisation
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  await loadGuilds();

  document.getElementById('guildSelect').addEventListener('change', function() {
    currentGuildId = this.value;
    if (currentGuildId) loadStats();
    else showNoGuild();
  });

  document.getElementById('daysSelect').addEventListener('change', function() {
    if (currentGuildId) loadStats();
  });

  document.getElementById('refreshBtn').addEventListener('click', function() {
    if (currentGuildId) loadStats();
  });
}

/** Populate the guild selector from the user's approved guilds. */
async function loadGuilds() {
  try {
    const res  = await fetch('/api/user/guilds');
    const data = await res.json();
    const guilds = data.guilds || [];

    const select = document.getElementById('guildSelect');
    select.innerHTML = '<option value="">— Select community —</option>' +
      guilds.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');

    if (guilds.length === 1) {
      select.value = guilds[0].id;
      currentGuildId = guilds[0].id;
      loadStats();
    } else if (guilds.length === 0) {
      showNoGuild();
    }
  } catch (err) {
    console.error('Failed to load guilds:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Data loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadStats() {
  if (!currentGuildId) return;

  const days = document.getElementById('daysSelect').value;

  document.getElementById('no-guild').classList.add('hidden');
  document.getElementById('main-content').classList.add('hidden');
  document.getElementById('loading-state').classList.remove('hidden');

  try {
    const params = new URLSearchParams({ guildId: currentGuildId, days });
    const res  = await fetch('/api/casino/admin-stats?' + params);
    const data = await res.json();

    document.getElementById('loading-state').classList.add('hidden');

    if (!data.ok) {
      showError(data.error || 'Failed to load stats');
      return;
    }

    renderSummary(data.summary);
    renderByGame(data.byGame);
    renderTopPlayers('top-winners-container', data.topWinners, true);
    renderTopPlayers('top-losers-container', data.topLosers, false);
    renderRecent(data.recent);

    document.getElementById('main-content').classList.remove('hidden');
  } catch (err) {
    document.getElementById('loading-state').classList.add('hidden');
    console.error('Casino stats error:', err);
    showError('Failed to fetch statistics');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Render helpers
// ─────────────────────────────────────────────────────────────────────────────

function renderSummary(s) {
  document.getElementById('stat-total-games').textContent   = s.total_games.toLocaleString();
  document.getElementById('stat-total-wagered').textContent = fmtMoney(s.total_wagered);
  document.getElementById('stat-total-payout').textContent  = fmtMoney(s.total_payout);
  document.getElementById('stat-house-profit').textContent  = fmtMoney(s.house_profit);
}

function renderByGame(rows) {
  const tbody = document.getElementById('by-game-body');
  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center py-6 text-gray-400">No games played</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => {
    const profitClass = r.house_profit >= 0 ? 'text-green-400' : 'text-red-400';
    return `<tr class="border-t border-gray-700 hover:bg-gray-750">
      <td class="px-4 py-3 font-medium">${esc(r.game_type)}</td>
      <td class="px-4 py-3 text-right">${r.games.toLocaleString()}</td>
      <td class="px-4 py-3 text-right">${fmtMoney(r.wagered)}</td>
      <td class="px-4 py-3 text-right">${fmtMoney(r.payout)}</td>
      <td class="px-4 py-3 text-right">${r.win_rate != null ? r.win_rate + '%' : '—'}</td>
      <td class="px-4 py-3 text-right ${profitClass}">${fmtMoney(r.house_profit)}</td>
    </tr>`;
  }).join('');
}

/** Render top winners or top losers as a simple ranked list. */
function renderTopPlayers(containerId, players, isWinners) {
  const el = document.getElementById(containerId);
  if (!players || players.length === 0) {
    el.innerHTML = '<div class="text-center text-gray-400 py-4">No data</div>';
    return;
  }

  const maxAbs = Math.abs(players[0].net) || 1;

  el.innerHTML = players.map((p, i) => {
    const net       = Number(p.net);
    const pct       = Math.round((Math.abs(net) / maxAbs) * 100);
    const netStr    = (net >= 0 ? '+' : '') + fmtMoney(net);
    const netClass  = net >= 0 ? 'text-green-400' : 'text-red-400';
    const barColor  = isWinners ? 'bg-green-500' : 'bg-red-500';

    return `<div class="mb-3">
      <div class="flex justify-between text-sm mb-1">
        <span class="text-gray-200 font-medium">#${i + 1} ${esc(p.gamertag)}</span>
        <span class="${netClass} font-bold">${netStr}</span>
      </div>
      <div class="h-2 bg-gray-700 rounded">
        <div class="h-2 ${barColor} rounded bar-fill" style="width:${pct}%"></div>
      </div>
      <div class="text-xs text-gray-500 mt-1">${p.games_played} games</div>
    </div>`;
  }).join('');
}

function renderRecent(rows) {
  const tbody = document.getElementById('recent-body');
  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-gray-400">No recent games</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const net      = Number(r.net);
    const netStr   = (net >= 0 ? '+' : '') + fmtMoney(net);
    const netClass = net >= 0 ? 'text-green-400' : 'text-red-400';
    const ts       = r.played_at ? new Date(r.played_at).toLocaleString() : '—';
    return `<tr class="border-t border-gray-700 hover:bg-gray-750 text-sm">
      <td class="px-4 py-2 font-medium">${esc(r.gamertag)}</td>
      <td class="px-4 py-2 text-gray-300">${esc(r.game_type)}</td>
      <td class="px-4 py-2 text-right">${fmtMoney(r.wager)}</td>
      <td class="px-4 py-2 text-right">${fmtMoney(r.payout)}</td>
      <td class="px-4 py-2 text-right ${netClass}">${netStr}</td>
      <td class="px-4 py-2">${esc(r.result || '—')}</td>
      <td class="px-4 py-2 text-gray-400 text-xs">${ts}</td>
    </tr>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

function showNoGuild() {
  document.getElementById('no-guild').classList.remove('hidden');
  document.getElementById('main-content').classList.add('hidden');
  document.getElementById('loading-state').classList.add('hidden');
}

function showError(msg) {
  document.getElementById('main-content').innerHTML =
    `<div class="bg-red-900 border border-red-700 p-6 rounded-lg text-center">
       <p class="text-red-300 font-semibold">❌ ${esc(msg)}</p>
     </div>`;
  document.getElementById('main-content').classList.remove('hidden');
}

/** Format a number as currency with comma separators. */
function fmtMoney(n) {
  const num = Number(n);
  if (isNaN(num)) return '—';
  return num.toLocaleString();
}

/** HTML-escape a string to prevent XSS. */
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.addEventListener('DOMContentLoaded', init);
