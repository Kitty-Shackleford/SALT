'use strict';
/* global document */

let currentServerId = null;
let csrfToken = null;
let currentPage = 1;
const pageSize = 50;

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function showStatus(message, error = false) {
  const banner = document.getElementById('statusBanner');
  banner.textContent = message;
  banner.className = `mb-4 p-4 rounded-lg text-sm ${error ? 'bg-red-900 text-red-200 border border-red-700' : 'bg-green-900 text-green-200 border border-green-700'}`;
}

async function parseResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function initCsrf() {
  const response = await fetch('/api/csrf-token');
  const data = await parseResponse(response);
  if (!data.csrfToken) throw new Error('Could not initialize request protection');
  csrfToken = data.csrfToken;
}

async function loadServers() {
  const select = document.getElementById('serverSelect');
  const data = await parseResponse(await fetch('/api/nitrado/registered-servers'));
  const servers = data.servers || [];
  select.innerHTML = '<option value="">— Select a server —</option>' + servers.map(server =>
    `<option value="${esc(server.id)}">${esc(server.server_name || `Server ${server.id}`)} (${esc(server.platform || 'unknown')})</option>`
  ).join('');
  if (!servers.length) select.innerHTML = '<option value="">No manageable servers found</option>';
}

function statusBadge(status) {
  const style = {
    pending: 'bg-yellow-900 text-yellow-200 border-yellow-700',
    confirmed: 'bg-green-900 text-green-200 border-green-700',
    dismissed: 'bg-gray-700 text-gray-300 border-gray-600',
  }[status] || 'bg-gray-700 text-gray-300 border-gray-600';
  return `<span class="border rounded-full px-3 py-1 text-xs font-semibold ${style}">${esc(status)}</span>`;
}

function renderZones(zones) {
  const container = document.getElementById('zonesContainer');
  if (!zones.length) {
    container.innerHTML = '<p class="text-gray-400 py-6 text-center">No candidates on this page.</p>';
    return;
  }
  container.innerHTML = `<div class="grid gap-4">${zones.map(zone => `
    <article class="zone-card bg-gray-900 border border-gray-700 rounded-lg p-4" data-zone-id="${esc(zone.id)}">
      <div class="flex flex-wrap justify-between gap-3 mb-4">
        <div>
          <div class="flex flex-wrap items-center gap-2">${statusBadge(zone.status)}<strong>${esc(zone.label)}</strong></div>
          <p class="text-gray-400 text-sm mt-2">Center: ${esc(zone.center_x)}, ${esc(zone.center_z)} · Evidence: ${esc(zone.evidence_count)}</p>
          <p class="text-gray-500 text-xs mt-1">Latest evidence: ${zone.last_evidence_at ? esc(new Date(zone.last_evidence_at).toLocaleString()) : 'Unknown'}</p>
        </div>
      </div>
      <div class="grid md:grid-cols-2 gap-3 mb-4">
        <label class="text-sm text-gray-300">Label
          <input data-field="label" maxlength="120" value="${esc(zone.label)}" class="mt-1 bg-gray-700 border border-gray-600 rounded px-3 py-2 w-full">
        </label>
        <label class="text-sm text-gray-300">Protected radius (meters)
          <input data-field="radius" type="number" min="50" max="1000" value="${esc(zone.radius_m)}" class="mt-1 bg-gray-700 border border-gray-600 rounded px-3 py-2 w-full">
        </label>
      </div>
      <div class="flex flex-wrap gap-2">
        <button data-review-status="confirmed" class="bg-green-700 hover:bg-green-600 px-4 py-2 rounded font-semibold">Confirm Protection</button>
        <button data-review-status="dismissed" class="bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded">Dismiss</button>
      </div>
    </article>`).join('')}</div>`;
}

async function loadZones() {
  if (!currentServerId) return;
  const container = document.getElementById('zonesContainer');
  container.innerHTML = '<p class="text-gray-400 animate-pulse">Loading review queue…</p>';
  try {
    const params = new URLSearchParams({ page: String(currentPage), pageSize: String(pageSize) });
    const data = await parseResponse(await fetch(`/api/spawn-exclusions/${encodeURIComponent(currentServerId)}?${params}`));
    renderZones(data.zones || []);
    document.getElementById('pageLabel').textContent = `Page ${currentPage}`;
    document.getElementById('previousPageBtn').disabled = currentPage <= 1;
    document.getElementById('nextPageBtn').disabled = (data.zones || []).length < pageSize;
  } catch (error) {
    container.innerHTML = `<p class="text-red-400">${esc(error.message)}</p>`;
  }
}

async function refreshCandidates() {
  if (!currentServerId || !csrfToken) return;
  const button = document.getElementById('refreshCandidatesBtn');
  button.disabled = true;
  try {
    const response = await fetch(`/api/spawn-exclusions/${encodeURIComponent(currentServerId)}/refresh`, {
      method: 'POST', headers: { 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' }, body: '{}',
    });
    const data = await parseResponse(response);
    currentPage = 1;
    showStatus(`Flag evidence refreshed: ${data.candidateCount || 0} candidate cluster(s).`);
    await loadZones();
  } catch (error) {
    showStatus(error.message, true);
  } finally {
    button.disabled = !currentServerId;
  }
}

async function reviewZone(card, status) {
  const zoneId = card.dataset.zoneId;
  const label = card.querySelector('[data-field="label"]').value.trim();
  const radius = Number(card.querySelector('[data-field="radius"]').value);
  const buttons = card.querySelectorAll('button');
  buttons.forEach(button => { button.disabled = true; });
  try {
    const response = await fetch(`/api/spawn-exclusions/${encodeURIComponent(currentServerId)}/${encodeURIComponent(zoneId)}`, {
      method: 'PATCH',
      headers: { 'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, label, radius }),
    });
    await parseResponse(response);
    showStatus(status === 'confirmed' ? 'Protection confirmed.' : 'Candidate dismissed.');
    await loadZones();
  } catch (error) {
    showStatus(error.message, true);
    buttons.forEach(button => { button.disabled = false; });
  }
}

document.getElementById('serverSelect').addEventListener('change', event => {
  currentServerId = event.target.value || null;
  currentPage = 1;
  document.getElementById('refreshCandidatesBtn').disabled = !currentServerId || !csrfToken;
  if (currentServerId) loadZones();
  else document.getElementById('zonesContainer').innerHTML = '<p class="text-gray-400">Select a server to load candidates.</p>';
});
document.getElementById('refreshCandidatesBtn').addEventListener('click', refreshCandidates);
document.getElementById('previousPageBtn').addEventListener('click', () => { if (currentPage > 1) { currentPage -= 1; loadZones(); } });
document.getElementById('nextPageBtn').addEventListener('click', () => { currentPage += 1; loadZones(); });
document.getElementById('zonesContainer').addEventListener('click', event => {
  const button = event.target.closest('[data-review-status]');
  if (button) reviewZone(button.closest('.zone-card'), button.dataset.reviewStatus);
});

Promise.all([initCsrf(), loadServers()]).catch(error => showStatus(error.message, true));
