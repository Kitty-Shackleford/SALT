/*
 * DayZ Dashboard — Boost Manager Client Module
 * Copyright (C) 2026
 *
 * Manages the boost settings form and boost history table.
 * Handles pagination for the history feed.
 */

let currentServerId = null;
let currentPage = 1;
let boostEnabled = false;
let csrfToken = null;

// --- Initialisation ---

document.addEventListener('DOMContentLoaded', async () => {
  const tokenResponse = await fetch('/api/csrf-token');
  const tokenData = await tokenResponse.json();
  csrfToken = tokenData.csrfToken;
  if (!tokenResponse.ok || !csrfToken) throw new Error('Could not initialize request protection');
  loadServers();
  document.getElementById('serverSelect').addEventListener('change', onServerChange);
  document.getElementById('boostSettingsForm').addEventListener('submit', onSaveSettings);
  document.getElementById('toggleBoostBtn').addEventListener('click', onToggleBoost);
  document.getElementById('paginationWrap').addEventListener('click', event => {
    const button = event.target.closest('button[data-page]');
    if (button) loadBoostHistory(Number(button.dataset.page));
  });
});

async function loadServers() {
  try {
    const res = await fetch('/api/nitrado/registered-servers');
    const data = await res.json();
    const select = document.getElementById('serverSelect');
    select.innerHTML = '<option value="">Select a server…</option>';
    (data.servers || []).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.server_name || s.name;
      select.appendChild(opt);
    });
  } catch {
    showBanner('Could not load servers.', 'error');
  }
}

function onServerChange() {
  currentServerId = document.getElementById('serverSelect').value;
  if (!currentServerId) {
    document.getElementById('boostContent').classList.add('hidden');
    document.getElementById('emptyState').classList.remove('hidden');
    return;
  }
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('boostContent').classList.remove('hidden');
  currentPage = 1;
  loadBoostSettings();
  loadBoostHistory(1);
}

// --- Boost Settings ---

async function loadBoostSettings() {
  try {
    const res = await fetch(`/api/boost/${currentServerId}/settings`);
    const data = await res.json();
    if (data.status !== 'success') throw new Error(data.message || 'API error');
    renderBoostSettings(data.data.boosting);
  } catch (err) {
    showBanner(`Failed to load boost settings: ${err.message}`, 'error');
  }
}

function renderBoostSettings(boosting) {
  boostEnabled = boosting.enabled;

  const badge = document.getElementById('boostEnabledBadge');
  badge.textContent = boosting.enabled ? '✅ Boosting Enabled' : '❌ Boosting Disabled';
  badge.className = `px-3 py-1 rounded-full text-sm font-semibold ${boosting.enabled ? 'bg-green-700 text-green-100' : 'bg-red-800 text-red-100'}`;

  document.getElementById('boostCode').textContent = boosting.code || '—';

  const link = document.getElementById('boostLink');
  if (boosting.code) {
    const url = `https://server.nitrado.net/en/gameserver/boost/${boosting.code}`;
    link.href = url;
    link.textContent = url;
  } else {
    link.textContent = '—';
    link.href = '#';
  }

  document.getElementById('boostMessage').value = boosting.message || '';
  document.getElementById('boostWelcome').value = boosting.welcome_message || '';

  const toggleBtn = document.getElementById('toggleBoostBtn');
  if (boosting.enabled) {
    toggleBtn.textContent = '🔴 Disable Boosting';
    toggleBtn.className = 'bg-red-700 hover:bg-red-600 px-4 py-2 rounded text-sm font-semibold';
  } else {
    toggleBtn.textContent = '🟢 Enable Boosting';
    toggleBtn.className = 'bg-green-700 hover:bg-green-600 px-4 py-2 rounded text-sm font-semibold';
  }
}

async function onSaveSettings(e) {
  e.preventDefault();
  const statusEl = document.getElementById('settingsSaveStatus');
  statusEl.className = 'text-sm text-gray-400';
  statusEl.textContent = 'Saving…';
  statusEl.classList.remove('hidden');

  try {
    const body = {
      message: document.getElementById('boostMessage').value,
      welcome_message: document.getElementById('boostWelcome').value,
    };
    const res = await fetch(`/api/boost/${currentServerId}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || data.status === 'error') throw new Error(data.message || 'Save failed');
    statusEl.textContent = '✅ Settings saved!';
    statusEl.className = 'text-sm text-green-400';
    setTimeout(() => statusEl.classList.add('hidden'), 3000);
    loadBoostSettings();
  } catch (err) {
    statusEl.textContent = `❌ ${err.message}`;
    statusEl.className = 'text-sm text-red-400';
  }
}

async function onToggleBoost() {
  try {
    const body = { enabled: !boostEnabled };
    const res = await fetch(`/api/boost/${currentServerId}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || data.status === 'error') throw new Error(data.message || 'Toggle failed');
    loadBoostSettings();
  } catch (err) {
    showBanner(`Failed to toggle boosting: ${err.message}`, 'error');
  }
}

// --- Boost History ---

async function loadBoostHistory(page) {
  currentPage = page;
  const wrap = document.getElementById('historyWrap');
  wrap.innerHTML = '<p class="text-gray-400 text-sm">Loading…</p>';

  try {
    const res = await fetch(`/api/boost/${currentServerId}/history?page=${page}`);
    const data = await res.json();
    if (data.status !== 'success') throw new Error(data.message || 'API error');
    renderBoostHistory(data.data);
  } catch (err) {
    wrap.innerHTML = `<p class="text-red-400 text-sm">❌ ${err.message}</p>`;
  }
}

function renderBoostHistory(data) {
  const wrap = document.getElementById('historyWrap');
  const countBadge = document.getElementById('boostCountBadge');
  countBadge.textContent = `${data.boosts_count} total boost${data.boosts_count !== 1 ? 's' : ''}`;

  if (!data.boosts || data.boosts.length === 0) {
    wrap.innerHTML = '<p class="text-gray-400 text-sm">No boosts yet. Share your boost code to get started!</p>';
    document.getElementById('paginationWrap').classList.add('hidden');
    return;
  }

  const rows = data.boosts.map(b => {
    // extended_for is seconds — convert to human-readable
    const hours = Math.round(b.extended_for / 3600);
    const date = new Date(b.boosted_at).toLocaleString();
    const avatarUrl = safeHttpsUrl(b.avatar);
    const avatar = avatarUrl
      ? `<img src="${escHtml(avatarUrl)}" class="w-8 h-8 rounded-full inline-block mr-2" alt="">`
      : '<span class="w-8 h-8 rounded-full bg-gray-600 inline-block mr-2 align-middle"></span>';

    return `
      <tr class="border-t border-gray-700">
        <td class="px-4 py-3">${avatar}<span class="align-middle">${escHtml(b.username || 'Anonymous')}</span></td>
        <td class="px-4 py-3 text-yellow-400 font-semibold">${escHtml(b.amount || '—')}</td>
        <td class="px-4 py-3 text-blue-300">+${hours}h</td>
        <td class="px-4 py-3 text-gray-300 italic text-sm">${b.message ? escHtml(b.message) : '<span class="text-gray-500">—</span>'}</td>
        <td class="px-4 py-3 text-gray-400 text-sm">${date}</td>
      </tr>
    `;
  }).join('');

  wrap.innerHTML = `
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-gray-400 border-b border-gray-600">
            <th class="px-4 py-2">Player</th>
            <th class="px-4 py-2">Amount</th>
            <th class="px-4 py-2">Extended By</th>
            <th class="px-4 py-2">Message</th>
            <th class="px-4 py-2">Date</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  renderPagination(data.current_page, data.page_count);
}

function renderPagination(current, total) {
  const wrap = document.getElementById('paginationWrap');
  if (total <= 1) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  const buttons = [];

  if (current > 1) {
    buttons.push(`<button data-page="${current - 1}"
      class="bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-sm">← Prev</button>`);
  }

  // Show up to 5 page buttons around current
  const start = Math.max(1, current - 2);
  const end = Math.min(total, current + 2);
  for (let p = start; p <= end; p++) {
    const active = p === current ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600';
    buttons.push(`<button data-page="${p}"
      class="${active} px-3 py-1 rounded text-sm">${p}</button>`);
  }

  if (current < total) {
    buttons.push(`<button data-page="${current + 1}"
      class="bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-sm">Next →</button>`);
  }

  wrap.innerHTML = buttons.join('');
}

// --- Helpers ---

function showBanner(message, type) {
  const el = document.getElementById('statusBanner');
  el.textContent = message;
  el.className = `mb-4 p-4 rounded-lg text-sm ${type === 'error' ? 'bg-red-800 text-red-100' : 'bg-green-800 text-green-100'}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch (_) {
    return '';
  }
}
