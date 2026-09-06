/*
 * DayZ Dashboard — Factions Frontend Module
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * Provides the full UI for the Factions tab in the Player Portal.
 * Entry point: initFactions(guildId, identityId) — called from player-portal.js
 * after a guild is selected.
 *
 * Views rendered inside #factions-tab:
 *   - Pending invites banner (shown at top when invites exist)
 *   - Faction list (default view)
 *   - Faction detail (member roster, management controls)
 *   - Create / Edit form
 */

// ---------------------------------------------------------------------------
// DayZ flag catalogue
// All images sourced from the DayZ Wiki (static.wikia.nocookie.net).
// The backend validates that flag_url starts with this same origin.
// ---------------------------------------------------------------------------

const DAYZ_FLAGS = [
  { name: 'Altis',         url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/e/ee/Flag_alti_co.png/revision/latest?cb=20200820222622' },
  { name: 'APA',           url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/c/c2/Flag_apa_co.png/revision/latest?cb=20200820222623' },
  { name: 'Bear',          url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/e/e1/Flag_bear_co.png/revision/latest?cb=20200820222626' },
  { name: 'Bohemia',       url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/e/ee/Flag_bi_co.png/revision/latest?cb=20200820222627' },
  { name: 'BrainZ',        url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/7/7d/Flag_brain_co.png/revision/latest?cb=20200820222628' },
  { name: 'CDF',           url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/d/d6/Flag_cdf_co.png/revision/latest?cb=20200820222629' },
  { name: 'Chernarus',     url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/e/ef/Flag_chern_co.png/revision/latest?cb=20200820222632' },
  { name: 'CMC',           url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/d/da/Flag_cmc_co.png/revision/latest?cb=20200820222634' },
  { name: 'Rooster',       url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/4/44/Flag_cock_co.png/revision/latest?cb=20200820222635' },
  { name: 'DayZ',          url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/b/b2/Flag_dayz_co.png/revision/latest?cb=20200820222636' },
  { name: 'Drosdov',       url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/2/24/Flag_dros_co.png/revision/latest?cb=20200820222637' },
  { name: 'Fawn',          url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/d/d2/Flag_fawn_co.png/revision/latest?cb=20200820222639' },
  { name: 'Jolly Roger',   url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/a/ab/Flag_jolly_co.png/revision/latest?cb=20200820222643' },
  { name: 'Jolly Roger B', url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/4/42/Flag_jolly_c_co.png/revision/latest?cb=20200820222641' },
  { name: 'KOS',           url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/a/a1/Flag_kos_co.png/revision/latest?cb=20200820222644' },
  { name: 'LDF',           url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/c/c1/Flag_ldf_co.png/revision/latest?cb=20200820222645' },
  { name: 'Livonia',       url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/e/e6/Flag_livo_co.png/revision/latest?cb=20200820222647' },
  { name: 'NAPA',          url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/e/e4/Flag_napa_co.png/revision/latest?cb=20200820222648' },
  { name: 'Police',        url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/6/63/Flag_police_co.png/revision/latest?cb=20200820222649' },
  { name: 'TEC',           url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/e/ea/Flag_tec_co.png/revision/latest?cb=20200820222650' },
  { name: 'UEC',           url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/c/ca/Flag_uec_co.png/revision/latest?cb=20200820222651' },
  { name: 'White',         url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/d/d3/Flag_white_co.png/revision/latest?cb=20200820222652' },
  { name: 'Zenit',         url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/0/05/Flag_zenit_co.png/revision/latest?cb=20200820222654' },
  { name: 'ZHunters',      url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/9/97/Flag_zhunters_co.png/revision/latest?cb=20200820222621' },
  { name: 'RSTA',          url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/2/20/Flag_rsta_co.png/revision/latest?cb=20210216191221' },
  { name: 'Refuge',        url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/8/8e/Flag_refuge_co.png/revision/latest?cb=20210216191205' },
  { name: 'Snake',         url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/5/54/Flag_snake_co.png/revision/latest?cb=20210216191234' },
  { name: 'Zagorky',       url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/7/75/Flag_zagorky_co.png/revision/latest?cb=20230619164704' },
  { name: 'Crook',         url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/c/c8/Flag_crook_co.png/revision/latest?cb=20230619164705' },
  { name: 'Rex',           url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/c/c5/Flag_rex_co.png/revision/latest?cb=20230619164706' },
  { name: 'Wolf',          url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/b/b2/Flag_wolf_co.png/revision/latest?cb=20200820222653' },
];

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

// Current Discord guild ID and linked identity for the logged-in user.
let _guildId    = null;
let _identityId = null;

// Which faction the current user belongs to in this guild (null = none).
let _callerFactionId = null;

// Flag URL selected in the create/edit form picker (null = no flag chosen).
let _selectedFlagUrl = null;

function escapeFactionHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeFactionFlagUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    const queryEntries = [...parsed.searchParams.entries()];
    const hasAllowedCacheBust = queryEntries.length === 0 || (
      queryEntries.length === 1
      && queryEntries[0][0] === 'cb'
      && /^\d{14}$/.test(queryEntries[0][1])
    );
    if (parsed.origin !== 'https://static.wikia.nocookie.net') return null;
    if (!parsed.pathname.startsWith('/dayz_gamepedia/images/')) return null;
    if (parsed.username || parsed.password || !hasAllowedCacheBust || parsed.hash) return null;
    return parsed.href;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

/**
 * Loads all factions for the guild and renders the list view.
 */
async function loadFactions() {
  const container = document.getElementById('factions-tab');
  if (!container) return;

  container.innerHTML = '<p class="text-gray-400">Loading factions…</p>';

  try {
    const res = await fetch(`/api/factions/${_guildId}`);
    const data = await res.json();

    if (!data.success) {
      container.innerHTML = `<p class="text-red-400">Error: ${escapeFactionHtml(data.error)}</p>`;
      return;
    }

    _callerFactionId = data.callerFactionId;
    // Keep window in sync so player-portal.js can read it for the map URL
    window.callerFactionId = _callerFactionId;

    const invitesBanner = await fetchInvitesBanner();
    container.innerHTML = invitesBanner + renderFactionList(data.factions, data.callerFactionId);
    attachListEventListeners();
  } catch (err) {
    console.error('loadFactions error:', err);
    const container2 = document.getElementById('factions-tab');
    if (container2) container2.innerHTML = '<p class="text-red-400">Failed to load factions.</p>';
  }
}

/**
 * Loads a single faction and renders the detail view.
 */
async function loadFactionDetail(factionId) {
  const container = document.getElementById('factions-tab');
  if (!container) return;

  container.innerHTML = '<p class="text-gray-400">Loading faction…</p>';

  try {
    const res = await fetch(`/api/factions/${_guildId}/${factionId}`);
    const data = await res.json();

    if (!data.success) {
      container.innerHTML = `<p class="text-red-400">Error: ${escapeFactionHtml(data.error)}</p>`;
      return;
    }

    container.innerHTML = renderFactionDetail(data.faction, data.members, data.callerRank);
    attachDetailEventListeners(data.faction, data.members, data.callerRank);
  } catch (err) {
    console.error('loadFactionDetail error:', err);
    const container2 = document.getElementById('factions-tab');
    if (container2) container2.innerHTML = '<p class="text-red-400">Failed to load faction.</p>';
  }
}

/**
 * Fetches pending invites for the current user and returns an HTML banner string.
 * Returns an empty string if there are no invites or the user has no linked account.
 */
async function fetchInvitesBanner() {
  try {
    const res = await fetch(`/api/factions/${_guildId}/invites/pending`);
    const data = await res.json();
    if (!data.success || !data.invites || data.invites.length === 0) return '';

    const items = data.invites.map(inv => `
      <div class="flex items-center justify-between bg-gray-700 rounded p-3 mb-2">
        <span>
          ${escapeFactionHtml(inv.faction_emblem)} <strong>${escapeFactionHtml(inv.faction_name)}</strong>
          [${escapeFactionHtml(inv.faction_tag)}] — invited by ${escapeFactionHtml(inv.inviter_name)}
        </span>
        <div class="flex gap-2">
          <button class="invite-accept-btn bg-green-600 hover:bg-green-500 px-3 py-1 rounded text-sm"
                  data-invite-id="${Number(inv.id)}">Accept</button>
          <button class="invite-decline-btn bg-gray-600 hover:bg-gray-500 px-3 py-1 rounded text-sm"
                  data-invite-id="${Number(inv.id)}">Decline</button>
        </div>
      </div>
    `).join('');

    return `
      <div class="bg-blue-900 border border-blue-600 rounded-lg p-4 mb-6">
        <h3 class="text-lg font-bold text-blue-300 mb-3">📬 Pending Faction Invites</h3>
        ${items}
      </div>
    `;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Render: Faction List
// ---------------------------------------------------------------------------

/**
 * Renders the full faction list view HTML.
 * @param {Array} factions - Faction rows from the API (includes member_count).
 * @param {number|null} callerFactionId - The faction ID the caller belongs to, or null.
 */
function renderFactionList(factions, callerFactionId) {
  const createBtn = _identityId && !callerFactionId
    ? `<button id="create-faction-btn"
         class="bg-red-700 hover:bg-red-600 px-4 py-2 rounded font-semibold">
         ⚔️ Create Faction
       </button>`
    : '';

  const header = `
    <div class="flex items-center justify-between mb-6">
      <h2 class="text-2xl font-bold">⚔️ Factions</h2>
      ${createBtn}
    </div>
  `;

  if (!factions || factions.length === 0) {
    return header + `
      <div class="bg-gray-800 rounded-lg p-8 text-center text-gray-400">
        <p class="text-4xl mb-4">⚔️</p>
        <p>No factions yet. Be the first to create one!</p>
      </div>
    `;
  }

  const cards = factions.map(f => {
    const isOwn = callerFactionId === f.id;
    const factionId = Number(f.id);
    const flagUrl = safeFactionFlagUrl(f.flag_url);
    const name = escapeFactionHtml(f.name);
    const tag = escapeFactionHtml(f.tag);
    const emblem = escapeFactionHtml(f.emblem);
    const description = escapeFactionHtml(f.description);
    const memberCount = Number(f.member_count) || 0;
    const joinBtn = !callerFactionId && f.is_open && _identityId
      ? `<button class="faction-join-btn bg-green-700 hover:bg-green-600 px-3 py-1 rounded text-sm"
                data-faction-id="${factionId}">Join</button>`
      : '';
    const ownBadge = isOwn
      ? `<span class="bg-blue-700 text-blue-200 text-xs px-2 py-0.5 rounded">Your Faction</span>`
      : '';
    const openBadge = f.is_open
      ? `<span class="bg-green-800 text-green-200 text-xs px-2 py-0.5 rounded">Open</span>`
      : `<span class="bg-gray-600 text-gray-300 text-xs px-2 py-0.5 rounded">Invite Only</span>`;

    return `
      <div class="bg-gray-800 rounded-lg p-5 flex flex-col gap-3">
        ${flagUrl ? `<img src="${escapeFactionHtml(flagUrl)}" alt="${name} flag" class="w-full h-16 object-contain rounded mb-1">` : ''}
        <div class="flex items-start justify-between">
          <div>
            <span class="text-3xl mr-2">${emblem}</span>
            <span class="text-xl font-bold">${name}</span>
            <span class="text-gray-400 ml-2 text-sm">[${tag}]</span>
          </div>
          <div class="flex gap-1 flex-wrap justify-end">${openBadge} ${ownBadge}</div>
        </div>
        ${f.description ? `<p class="text-gray-300 text-sm">${description}</p>` : ''}
        <div class="flex items-center justify-between mt-auto">
          <span class="text-gray-400 text-sm">👥 ${memberCount} member${memberCount !== 1 ? 's' : ''}</span>
          <div class="flex gap-2">
            ${joinBtn}
            <button class="faction-view-btn bg-gray-600 hover:bg-gray-500 px-3 py-1 rounded text-sm"
                    data-faction-id="${factionId}">View</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  return header + `<div class="grid grid-cols-1 md:grid-cols-2 gap-4">${cards}</div>`;
}

// ---------------------------------------------------------------------------
// Render: Faction Detail
// ---------------------------------------------------------------------------

/**
 * Renders the faction detail view with member roster and management controls.
 * @param {Object} faction - Faction row from the API.
 * @param {Array} members - Member rows (identity_id, rank, joined_at, player_name).
 * @param {string|null} callerRank - The caller's rank, or null if not a member.
 */
function renderFactionDetail(faction, members, callerRank) {
  const factionId = Number(faction.id);
  const flagUrl = safeFactionFlagUrl(faction.flag_url);
  const name = escapeFactionHtml(faction.name);
  const tag = escapeFactionHtml(faction.tag);
  const emblem = escapeFactionHtml(faction.emblem);
  const description = escapeFactionHtml(faction.description);
  const isLeader = callerRank === 'leader';
  const isOfficer = callerRank === 'officer';
  const isMember = !!callerRank;

  const canManage = isLeader || isOfficer;
  const canJoin = !isMember && !_callerFactionId && faction.is_open && _identityId;

  // Action buttons bar
  const actions = [];
  if (canJoin) {
    actions.push(`<button id="detail-join-btn" data-faction-id="${factionId}"
      class="bg-green-700 hover:bg-green-600 px-4 py-2 rounded">Join Faction</button>`);
  }
  if (isMember && !isLeader) {
    actions.push(`<button id="detail-leave-btn" data-faction-id="${factionId}"
      class="bg-gray-600 hover:bg-gray-500 px-4 py-2 rounded">Leave Faction</button>`);
  }
  if (isLeader) {
    actions.push(`<button id="detail-edit-btn" data-faction-id="${factionId}"
      class="bg-blue-700 hover:bg-blue-600 px-4 py-2 rounded">Edit</button>`);
    actions.push(`<button id="detail-disband-btn" data-faction-id="${factionId}"
      class="bg-red-800 hover:bg-red-700 px-4 py-2 rounded">Disband</button>`);
  }
  if (canManage) {
    actions.push(`<button id="detail-invite-btn" data-faction-id="${factionId}"
      class="bg-yellow-700 hover:bg-yellow-600 px-4 py-2 rounded">Invite Player</button>`);
  }

  // Member roster
  const rankLabel = { leader: '👑 Leader', officer: '⭐ Officer', member: '🗡️ Member' };
  const memberRows = members.map(m => {
    const controls = [];
    const identityId = Number(m.identity_id);
    const playerName = escapeFactionHtml(m.player_name);
    const displayRank = escapeFactionHtml(rankLabel[m.rank] || m.rank);
    if (canManage && m.rank !== 'leader' && m.identity_id !== _identityId) {
      if (isLeader && m.rank === 'member') {
        controls.push(`<button class="member-promote-btn text-xs bg-yellow-700 hover:bg-yellow-600 px-2 py-1 rounded"
          data-identity-id="${identityId}" data-rank="officer">Promote</button>`);
      }
      if (isLeader && m.rank === 'officer') {
        controls.push(`<button class="member-demote-btn text-xs bg-gray-600 hover:bg-gray-500 px-2 py-1 rounded"
          data-identity-id="${identityId}" data-rank="member">Demote</button>`);
      }
      if (!(isOfficer && m.rank === 'officer')) {
        controls.push(`<button class="member-kick-btn text-xs bg-red-800 hover:bg-red-700 px-2 py-1 rounded"
          data-identity-id="${identityId}">Kick</button>`);
      }
    }
    return `
      <div class="flex items-center justify-between py-2 border-b border-gray-700 last:border-0">
        <div>
          <span class="font-medium">${playerName}</span>
          <span class="text-gray-400 text-sm ml-2">${displayRank}</span>
        </div>
        <div class="flex gap-2">${controls.join('')}</div>
      </div>
    `;
  }).join('');

  const openBadge = faction.is_open
    ? `<span class="bg-green-800 text-green-200 text-sm px-2 py-0.5 rounded">Open</span>`
    : `<span class="bg-gray-600 text-gray-300 text-sm px-2 py-0.5 rounded">Invite Only</span>`;

  return `
    <button id="back-to-list-btn" class="text-gray-400 hover:text-white mb-4 flex items-center gap-1">
      ← Back to Factions
    </button>

    <div class="bg-gray-800 rounded-lg p-6 mb-4">
      ${flagUrl ? `<img src="${escapeFactionHtml(flagUrl)}" alt="${name} flag" class="w-full max-h-28 object-contain rounded mb-4">` : ''}
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center gap-3">
          <span class="text-4xl">${emblem}</span>
          <div>
            <h2 class="text-2xl font-bold">${name}
              <span class="text-gray-400 text-lg">[${tag}]</span>
            </h2>
            ${openBadge}
          </div>
        </div>
      </div>
      ${faction.description ? `<p class="text-gray-300 mt-3">${description}</p>` : ''}
      <div class="flex gap-2 mt-4 flex-wrap">
        ${actions.join('')}
      </div>
    </div>

    <div class="bg-gray-800 rounded-lg p-6">
      <h3 class="text-lg font-bold mb-4">👥 Members (${members.length})</h3>
      ${memberRows || '<p class="text-gray-400">No members found.</p>'}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Event listener attachment: List view
// ---------------------------------------------------------------------------

function attachListEventListeners() {
  const container = document.getElementById('factions-tab');
  if (!container) return;

  container.querySelectorAll('.faction-view-btn').forEach(btn => {
    btn.addEventListener('click', () => loadFactionDetail(btn.dataset.factionId));
  });

  container.querySelectorAll('.faction-join-btn').forEach(btn => {
    btn.addEventListener('click', () => joinFaction(btn.dataset.factionId));
  });

  const createBtn = container.querySelector('#create-faction-btn');
  if (createBtn) createBtn.addEventListener('click', showCreateForm);

  container.querySelectorAll('.invite-accept-btn').forEach(btn => {
    btn.addEventListener('click', () => acceptInvite(btn.dataset.inviteId));
  });

  container.querySelectorAll('.invite-decline-btn').forEach(btn => {
    btn.addEventListener('click', () => declineInvite(btn.dataset.inviteId));
  });
}

// ---------------------------------------------------------------------------
// Event listener attachment: Detail view
// ---------------------------------------------------------------------------

function attachDetailEventListeners(faction, members, callerRank) {
  const container = document.getElementById('factions-tab');
  if (!container) return;

  const backBtn = container.querySelector('#back-to-list-btn');
  if (backBtn) backBtn.addEventListener('click', loadFactions);

  const joinBtn = container.querySelector('#detail-join-btn');
  if (joinBtn) joinBtn.addEventListener('click', () => joinFaction(faction.id));

  const leaveBtn = container.querySelector('#detail-leave-btn');
  if (leaveBtn) leaveBtn.addEventListener('click', () => leaveFaction(faction.id));

  const editBtn = container.querySelector('#detail-edit-btn');
  if (editBtn) editBtn.addEventListener('click', () => showEditForm(faction));

  const disbandBtn = container.querySelector('#detail-disband-btn');
  if (disbandBtn) disbandBtn.addEventListener('click', () => disbandFaction(faction.id));

  const inviteBtn = container.querySelector('#detail-invite-btn');
  if (inviteBtn) inviteBtn.addEventListener('click', () => showInviteForm(faction.id));

  container.querySelectorAll('.member-promote-btn, .member-demote-btn').forEach(btn => {
    btn.addEventListener('click', () =>
      updateMemberRank(faction.id, btn.dataset.identityId, btn.dataset.rank)
    );
  });

  container.querySelectorAll('.member-kick-btn').forEach(btn => {
    btn.addEventListener('click', () => kickMember(faction.id, btn.dataset.identityId));
  });
}

// ---------------------------------------------------------------------------
// Faction action handlers
// ---------------------------------------------------------------------------

async function joinFaction(factionId) {
  if (!confirm('Join this faction?')) return;
  try {
    const res = await fetch(`/api/factions/${_guildId}/${factionId}/join`, {
      method: 'POST',
      headers: getCsrfHeaders(),
    });
    const data = await res.json();
    if (!data.success) { alert(data.error); return; }
    _callerFactionId = factionId;
    window.callerFactionId = factionId;
    loadFactionDetail(factionId);
  } catch { alert('Failed to join faction.'); }
}

async function leaveFaction(factionId) {
  if (!confirm('Leave this faction?')) return;
  try {
    const res = await fetch(`/api/factions/${_guildId}/${factionId}/leave`, {
      method: 'POST',
      headers: getCsrfHeaders(),
    });
    const data = await res.json();
    if (!data.success) { alert(data.error); return; }
    _callerFactionId = null;
    window.callerFactionId = null;
    loadFactions();
  } catch { alert('Failed to leave faction.'); }
}

async function disbandFaction(factionId) {
  if (!confirm('Disband this faction? This cannot be undone.')) return;
  try {
    const res = await fetch(`/api/factions/${_guildId}/${factionId}`, {
      method: 'DELETE',
      headers: getCsrfHeaders(),
    });
    const data = await res.json();
    if (!data.success) { alert(data.error); return; }
    _callerFactionId = null;
    window.callerFactionId = null;
    loadFactions();
  } catch { alert('Failed to disband faction.'); }
}

async function updateMemberRank(factionId, identityId, rank) {
  try {
    const res = await fetch(`/api/factions/${_guildId}/${factionId}/members/${identityId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
      body: JSON.stringify({ rank }),
    });
    const data = await res.json();
    if (!data.success) { alert(data.error); return; }
    loadFactionDetail(factionId);
  } catch { alert('Failed to update rank.'); }
}

async function kickMember(factionId, identityId) {
  if (!confirm('Kick this member from the faction?')) return;
  try {
    const res = await fetch(`/api/factions/${_guildId}/${factionId}/members/${identityId}`, {
      method: 'DELETE',
      headers: getCsrfHeaders(),
    });
    const data = await res.json();
    if (!data.success) { alert(data.error); return; }
    loadFactionDetail(factionId);
  } catch { alert('Failed to kick member.'); }
}

async function acceptInvite(inviteId) {
  try {
    const res = await fetch(`/api/factions/invites/${inviteId}/accept`, {
      method: 'POST',
      headers: getCsrfHeaders(),
    });
    const data = await res.json();
    if (!data.success) { alert(data.error); return; }
    loadFactions();
  } catch { alert('Failed to accept invite.'); }
}

async function declineInvite(inviteId) {
  try {
    const res = await fetch(`/api/factions/invites/${inviteId}`, {
      method: 'DELETE',
      headers: getCsrfHeaders(),
    });
    const data = await res.json();
    if (!data.success) { alert(data.error); return; }
    loadFactions();
  } catch { alert('Failed to decline invite.'); }
}

// ---------------------------------------------------------------------------
// Create / Edit form
// ---------------------------------------------------------------------------

function showCreateForm() {
  _selectedFlagUrl = null;
  const container = document.getElementById('factions-tab');
  if (!container) return;
  container.innerHTML = renderFactionForm(null);
  attachFormEventListeners(null);
}

function showEditForm(faction) {
  _selectedFlagUrl = faction.flag_url || null;
  const container = document.getElementById('factions-tab');
  if (!container) return;
  container.innerHTML = renderFactionForm(faction);
  attachFormEventListeners(faction);
}

/**
 * Renders a scrollable grid of DayZ flag thumbnails for the faction form.
 * The currently selected flag gets a red ring highlight.
 */
function renderFlagPicker(selectedUrl) {
  const safeSelectedUrl = safeFactionFlagUrl(selectedUrl);
  const noneClass = !safeSelectedUrl
    ? 'ring-2 ring-red-500'
    : 'ring-1 ring-gray-600';

  const noneBtn = `
    <button type="button" class="flag-pick-btn flex flex-col items-center p-1 rounded hover:bg-gray-600 ${noneClass}"
            data-flag-url="">
      <div class="w-full h-10 flex items-center justify-center bg-gray-600 rounded text-gray-400 text-xs">None</div>
    </button>
  `;

  const flagBtns = DAYZ_FLAGS.map(f => {
    const isSelected = safeSelectedUrl === f.url;
    const ringClass  = isSelected ? 'ring-2 ring-red-500' : 'ring-1 ring-gray-600';
    return `
      <button type="button" class="flag-pick-btn flex flex-col items-center p-1 rounded hover:bg-gray-600 ${ringClass}"
              data-flag-url="${f.url}" title="${f.name}">
        <img src="${f.url}" alt="${f.name}" loading="lazy"
             class="w-full h-10 object-contain rounded">
        <span class="text-xs text-gray-400 mt-0.5 truncate w-full text-center leading-tight">${f.name}</span>
      </button>
    `;
  }).join('');

  return `
    <div class="mb-5">
      <label class="block text-gray-300 mb-2">🚩 Faction Flag <span class="text-gray-500 text-sm font-normal">(optional)</span></label>
      ${safeSelectedUrl ? `
        <div class="mb-2 flex items-center gap-3">
          <img src="${escapeFactionHtml(safeSelectedUrl)}" alt="Selected flag" class="h-10 object-contain rounded">
          <span class="text-gray-300 text-sm">${escapeFactionHtml(DAYZ_FLAGS.find(f => f.url === safeSelectedUrl)?.name ?? 'Custom')}</span>
        </div>
      ` : ''}
      <div class="max-h-56 overflow-y-auto bg-gray-700 rounded p-2 grid grid-cols-4 sm:grid-cols-6 gap-1">
        ${noneBtn}
        ${flagBtns}
      </div>
    </div>
  `;
}

/**
 * Renders a create or edit form. Pass null for `faction` to render the create form.
 */
function renderFactionForm(faction) {
  const isEdit = !!faction;
  const name = escapeFactionHtml(isEdit ? faction.name : '');
  const tag = escapeFactionHtml(isEdit ? faction.tag : '');
  const emblem = escapeFactionHtml(isEdit ? faction.emblem : '⚔️');
  const description = escapeFactionHtml(isEdit && faction.description ? faction.description : '');
  const title = isEdit ? `Edit ${name}` : '⚔️ Create Faction';
  const submitLabel = isEdit ? 'Save Changes' : 'Create Faction';

  return `
    <button id="form-back-btn" class="text-gray-400 hover:text-white mb-4 flex items-center gap-1">
      ← Back
    </button>
    <div class="bg-gray-800 rounded-lg p-6 max-w-lg">
      <h2 class="text-2xl font-bold mb-6">${title}</h2>
      <form id="faction-form">
        <div class="mb-4">
          <label class="block text-gray-300 mb-1">Faction Name *</label>
          <input id="ff-name" type="text" maxlength="40" required
            class="w-full bg-gray-700 rounded px-3 py-2 text-white"
            value="${name}">
        </div>
        <div class="mb-4">
          <label class="block text-gray-300 mb-1">Tag (2–5 chars) *</label>
          <input id="ff-tag" type="text" minlength="2" maxlength="5" required
            class="w-full bg-gray-700 rounded px-3 py-2 text-white uppercase"
            value="${tag}">
        </div>
        <div class="mb-4">
          <label class="block text-gray-300 mb-1">Emblem (emoji)</label>
          <input id="ff-emblem" type="text" maxlength="4"
            class="w-full bg-gray-700 rounded px-3 py-2 text-white"
            value="${emblem}">
        </div>
        <div class="mb-4">
          <label class="block text-gray-300 mb-1">Description</label>
          <textarea id="ff-description" rows="3" maxlength="300"
            class="w-full bg-gray-700 rounded px-3 py-2 text-white">${description}</textarea>
        </div>
        <div id="ff-flag-picker-wrap">
          ${renderFlagPicker(_selectedFlagUrl)}
        </div>
        <div class="mb-6 flex items-center gap-3">
          <input id="ff-is-open" type="checkbox" class="w-4 h-4"
            ${isEdit ? (faction.is_open ? 'checked' : '') : 'checked'}>
          <label for="ff-is-open" class="text-gray-300">Open (anyone can join without an invite)</label>
        </div>
        <div id="faction-form-error" class="text-red-400 mb-4 hidden"></div>
        <button type="submit"
          class="bg-red-700 hover:bg-red-600 px-6 py-2 rounded font-semibold w-full">
          ${submitLabel}
        </button>
      </form>
    </div>
  `;
}

function attachFormEventListeners(faction) {
  const container = document.getElementById('factions-tab');
  if (!container) return;

  const backBtn = container.querySelector('#form-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () =>
      faction ? loadFactionDetail(faction.id) : loadFactions()
    );
  }

  // Use event delegation so that clicks on flag thumbnails still work after
  // the picker section is re-rendered (the container element persists).
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('.flag-pick-btn');
    if (!btn) return;
    _selectedFlagUrl = btn.dataset.flagUrl || null;
    const wrap = container.querySelector('#ff-flag-picker-wrap');
    if (wrap) wrap.innerHTML = renderFlagPicker(_selectedFlagUrl);
  });

  const form = container.querySelector('#faction-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name:        document.getElementById('ff-name').value.trim(),
      tag:         document.getElementById('ff-tag').value.trim(),
      emblem:      document.getElementById('ff-emblem').value.trim() || '⚔️',
      description: document.getElementById('ff-description').value.trim() || null,
      is_open:     document.getElementById('ff-is-open').checked,
      flag_url:    _selectedFlagUrl || null,
    };

    const errEl = document.getElementById('faction-form-error');
    errEl.classList.add('hidden');

    try {
      const url = faction
        ? `/api/factions/${_guildId}/${faction.id}`
        : `/api/factions/${_guildId}`;
      const method = faction ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!data.success) {
        errEl.textContent = data.error;
        errEl.classList.remove('hidden');
        return;
      }

      if (faction) {
        loadFactionDetail(faction.id);
      } else {
        _callerFactionId = data.faction.id;
        loadFactionDetail(data.faction.id);
      }
    } catch {
      errEl.textContent = 'An error occurred. Please try again.';
      errEl.classList.remove('hidden');
    }
  });
}

// ---------------------------------------------------------------------------
// Invite form (send invite to a player by identity ID)
// ---------------------------------------------------------------------------

function showInviteForm(factionId) {
  const container = document.getElementById('factions-tab');
  if (!container) return;

  container.innerHTML = `
    <button id="invite-back-btn" class="text-gray-400 hover:text-white mb-4 flex items-center gap-1">
      ← Back to Faction
    </button>
    <div class="bg-gray-800 rounded-lg p-6 max-w-lg">
      <h2 class="text-2xl font-bold mb-6">📬 Invite Player</h2>
      <p class="text-gray-400 mb-4">Enter the player's identity ID to send them an invite.</p>
      <div class="mb-4">
        <label class="block text-gray-300 mb-1">Identity ID</label>
        <input id="invite-identity-id" type="number" min="1"
          class="w-full bg-gray-700 rounded px-3 py-2 text-white"
          placeholder="e.g. 42">
      </div>
      <div id="invite-error" class="text-red-400 mb-4 hidden"></div>
      <button id="invite-send-btn"
        class="bg-yellow-700 hover:bg-yellow-600 px-6 py-2 rounded font-semibold w-full">
        Send Invite
      </button>
    </div>
  `;

  container.querySelector('#invite-back-btn').addEventListener('click', () =>
    loadFactionDetail(factionId)
  );

  container.querySelector('#invite-send-btn').addEventListener('click', async () => {
    const identityId = parseInt(document.getElementById('invite-identity-id').value, 10);
    const errEl = document.getElementById('invite-error');
    errEl.classList.add('hidden');

    if (!identityId) {
      errEl.textContent = 'Please enter a valid identity ID.';
      errEl.classList.remove('hidden');
      return;
    }

    try {
      const res = await fetch(`/api/factions/${_guildId}/${factionId}/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
        body: JSON.stringify({ identityId }),
      });
      const data = await res.json();
      if (!data.success) {
        errEl.textContent = data.error;
        errEl.classList.remove('hidden');
        return;
      }
      loadFactionDetail(factionId);
    } catch {
      errEl.textContent = 'Failed to send invite.';
      errEl.classList.remove('hidden');
    }
  });
}

// ---------------------------------------------------------------------------
// CSRF helper — reads the token injected by csrf-helper.js if available
// ---------------------------------------------------------------------------

function getCsrfHeaders() {
  // csrf-helper.js exposes window.getCsrfToken() when loaded
  if (typeof window.getCsrfToken === 'function') {
    return { 'X-CSRF-Token': window.getCsrfToken() };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Initialises the factions module for a given guild and user identity.
 * Called by player-portal.js after the user selects a guild.
 *
 * @param {string} guildId      - Discord guild ID (string)
 * @param {number|null} identityId - Linked player identity ID, or null if none
 */
function initFactions(guildId, identityId) {
  _guildId = guildId;
  _identityId = identityId || null;
  _callerFactionId = null;
  // Expose faction context on window so player-portal.js can pass it to the map URL
  window.callerFactionId = null;
  window.callerFactionGuildId = guildId;
  loadFactions();
}
