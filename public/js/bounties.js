/* DayZ Dashboard — player bounty board */
'use strict';

let bountyGeneration = 0;
let bountyBoardRequestId = 0;
let bountyPlayerSearchRequestId = 0;
let bountyContext = null;
let bountyOptions = null;
const bountyPendingCommands = new Map();
const BOUNTY_PENDING_STORAGE_KEY = 'dayz:bounty-pending-commands:v1';

function loadBountyPendingCommands() {
  try {
    const rows = JSON.parse(sessionStorage.getItem(BOUNTY_PENDING_STORAGE_KEY) || '[]');
    if (!Array.isArray(rows)) return;
    for (const row of rows.slice(-20)) {
      if (!Array.isArray(row) || row.length !== 2) continue;
      const [commandKey, command] = row;
      if (typeof commandKey !== 'string' || commandKey.length > 2048
          || typeof command?.body !== 'string' || command.body.length > 1024
          || typeof command?.idempotencyKey !== 'string' || command.idempotencyKey.length > 128) continue;
      bountyPendingCommands.set(commandKey, command);
    }
  } catch (_error) {
    // Storage can be disabled; the in-memory retry contract remains available.
  }
}

function persistBountyPendingCommands() {
  try {
    const rows = Array.from(bountyPendingCommands.entries()).slice(-20);
    sessionStorage.setItem(BOUNTY_PENDING_STORAGE_KEY, JSON.stringify(rows));
  } catch (_error) {
    // Storage can be disabled; do not turn a financial retry into a fresh command.
  }
}

loadBountyPendingCommands();

function bountyCommandContextKey(context) {
  return `${context.serverId}:${context.identityId}`;
}

function bountyEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function bountyMoney(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00';
}

function bountyTargetLabel(bounty) {
  if (bounty.targetType === 'faction') {
    return `[${bountyEscape(bounty.targetFactionTag)}] ${bountyEscape(bounty.targetFactionName)}`;
  }
  return bountyEscape(bounty.targetGamertag || `Player #${bounty.targetIdentityId}`);
}

function renderBountyCards(bounties) {
  if (!bounties.length) return '<p class="text-gray-400">No active bounties.</p>';
  return bounties.map(bounty => {
    const factionProgress = bounty.targetType === 'faction'
      ? `<p class="text-sm text-gray-300 mt-2">Objective: ${bounty.requiredKills} unique eligible members · ${bounty.eligibleMemberCount} snapshotted targets</p>`
      : '';
    const sponsor = bounty.creatorType === 'faction'
      ? `<span class="text-xs text-gray-400">Sponsored by [${bountyEscape(bounty.creatorFactionTag)}] ${bountyEscape(bounty.creatorFactionName)} · personally funded</span>`
      : '';
    const cancel = bounty.canCancel
      ? `<button class="bounty-cancel mt-3 bg-red-700 hover:bg-red-600 px-3 py-1 rounded text-sm" data-bounty-id="${bounty.id}">Cancel</button>`
      : '';
    return `<article class="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div class="flex justify-between gap-4"><h3 class="font-bold text-lg">${bountyTargetLabel(bounty)}</h3><strong>$${bountyMoney(bounty.amount)}</strong></div>
      ${sponsor}<p class="text-gray-300 mt-2">${bountyEscape(bounty.reason || 'No reason supplied')}</p>
      ${factionProgress}<p class="text-xs text-gray-500 mt-2">Expires ${bountyEscape(new Date(bounty.expiresAt).toLocaleString())}</p>${cancel}
    </article>`;
  }).join('');
}

function renderBountyForm(options) {
  const canFaction = Boolean(options.canSponsorFactionBounty);
  const factionChoices = options.factions.map(faction =>
    `<option value="${faction.id}">${bountyEscape(`[${faction.tag}] ${faction.name}`)} (${faction.eligibleMemberCount} eligible)</option>`
  ).join('');
  return `<form id="bounty-create-form" class="bg-gray-800 rounded-lg p-5 mb-6 space-y-4">
    <div class="flex justify-between items-center"><h2 class="text-xl font-bold">Post a bounty</h2><span class="text-xs text-gray-400">Funds are reserved from your wallet</span></div>
    <div class="grid md:grid-cols-2 gap-4">
      <label>Target type<select id="bounty-target-type" class="block w-full mt-1 bg-gray-700 rounded p-2"><option value="player">Player</option>${canFaction ? '<option value="faction">Faction</option>' : ''}</select></label>
      <label id="bounty-player-wrap">Player gamertag<input id="bounty-player-search" autocomplete="off" class="block w-full mt-1 bg-gray-700 rounded p-2" placeholder="Search exact-server players"><select id="bounty-player-target" class="block w-full mt-2 bg-gray-700 rounded p-2" required><option value="">Search for a player</option></select></label>
      <label id="bounty-faction-wrap" class="hidden">Target faction<select id="bounty-faction-target" class="block w-full mt-1 bg-gray-700 rounded p-2"><option value="">Choose a faction</option>${factionChoices}</select></label>
      <label>Amount<input id="bounty-amount" type="number" min="0.01" step="0.01" required class="block w-full mt-1 bg-gray-700 rounded p-2"></label>
      <label>Expiry (hours)<input id="bounty-expiry" type="number" min="1" step="1" class="block w-full mt-1 bg-gray-700 rounded p-2" placeholder="Server default"></label>
    </div>
    <label>Reason<textarea id="bounty-reason" maxlength="500" class="block w-full mt-1 bg-gray-700 rounded p-2"></textarea></label>
    ${canFaction ? `<p class="text-sm text-gray-400">Faction posts are attributed to ${bountyEscape(options.sponsorFaction.name)}, personally funded, and require ${options.factionKillsRequired || 'the configured number of'} unique snapshotted member kills by one hunter.</p>` : ''}
    <p id="bounty-form-message" class="text-sm"></p>
    <button class="bg-red-700 hover:bg-red-600 px-4 py-2 rounded font-semibold" type="submit">Reserve funds and post</button>
  </form>`;
}

async function bountyJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

async function loadBountyBoard(context) {
  const generation = context.generation;
  const requestId = ++bountyBoardRequestId;
  let list;
  let options;
  try {
    [list, options] = await Promise.all([
      bountyJson(`/api/bounties/${context.serverId}`),
      bountyJson(`/api/bounties/${context.serverId}/options`),
    ]);
  } catch (error) {
    if (requestId !== bountyBoardRequestId || !bountyContext
        || bountyContext.generation !== generation || bountyContext.serverId !== context.serverId) return;
    throw error;
  }
  if (requestId !== bountyBoardRequestId || !bountyContext
      || bountyContext.generation !== generation || bountyContext.serverId !== context.serverId) return;
  bountyOptions = options;
  const container = document.getElementById('bounties-tab');
  container.innerHTML = `${renderBountyForm(bountyOptions)}<div class="flex justify-between items-center mb-3"><h2 class="text-2xl font-bold">Active bounties</h2><button id="bounty-refresh" class="bg-gray-700 px-3 py-2 rounded">Refresh</button></div><div id="bounty-list" class="grid gap-3">${renderBountyCards(list.bounties)}</div>`;
  bindBountyControls(context);
}

async function searchBountyPlayers(context, text) {
  const generation = context.generation;
  const requestId = ++bountyPlayerSearchRequestId;
  let data;
  try {
    data = await bountyJson(`/api/economy/search-players?serverId=${encodeURIComponent(context.serverId)}&query=${encodeURIComponent(text)}`);
  } catch (error) {
    if (requestId !== bountyPlayerSearchRequestId || !bountyContext
        || bountyContext.generation !== generation || bountyContext.serverId !== context.serverId) return;
    throw error;
  }
  if (requestId !== bountyPlayerSearchRequestId || !bountyContext
      || bountyContext.generation !== generation || bountyContext.serverId !== context.serverId) return;
  const select = document.getElementById('bounty-player-target');
  if (!select) return;
  select.innerHTML = '<option value="">Choose a player</option>' + data.players
    .filter(player => Number(player.identity_id) !== Number(context.identityId))
    .map(player => `<option value="${Number(player.identity_id)}">${bountyEscape(player.gamertag)}</option>`).join('');
}

function bindBountyControls(context) {
  const type = document.getElementById('bounty-target-type');
  type.addEventListener('change', () => {
    document.getElementById('bounty-player-wrap').classList.toggle('hidden', type.value !== 'player');
    document.getElementById('bounty-faction-wrap').classList.toggle('hidden', type.value !== 'faction');
  });
  let searchTimer;
  document.getElementById('bounty-player-search').addEventListener('input', event => {
    clearTimeout(searchTimer);
    const text = event.target.value.trim();
    if (text.length < 2) {
      bountyPlayerSearchRequestId += 1;
      document.getElementById('bounty-player-target').innerHTML = '<option value="">Search for a player</option>';
      return;
    }
    searchTimer = setTimeout(() => searchBountyPlayers(context, text).catch(() => {}), 250);
  });
  document.getElementById('bounty-refresh').addEventListener('click', () => {
    loadBountyBoard(context).catch(error => {
      if (bountyContext?.generation === context.generation) alert(error.message);
    });
  });
  document.querySelectorAll('.bounty-cancel').forEach(button => button.addEventListener('click', () => cancelBounty(context, button.dataset.bountyId)));
  document.getElementById('bounty-create-form').addEventListener('submit', event => postBounty(event, context));
}

async function postBounty(event, context) {
  event.preventDefault();
  if (!bountyContext || bountyContext.generation !== context.generation
      || bountyContext.serverId !== context.serverId) return;
  const message = document.getElementById('bounty-form-message');
  const targetType = document.getElementById('bounty-target-type').value;
  const body = {
    targetType,
    amount: Number(document.getElementById('bounty-amount').value),
    reason: document.getElementById('bounty-reason').value,
  };
  const expiry = document.getElementById('bounty-expiry').value;
  if (expiry) body.expiryHours = Number(expiry);
  if (targetType === 'faction') body.targetFactionId = Number(document.getElementById('bounty-faction-target').value);
  else body.targetIdentityId = Number(document.getElementById('bounty-player-target').value);
  const requestBody = JSON.stringify(body);
  const commandKey = `${bountyCommandContextKey(context)}:${requestBody}`;
  const pendingCommand = bountyPendingCommands.get(commandKey);
  const idempotencyKey = pendingCommand?.idempotencyKey || crypto.randomUUID();
  bountyPendingCommands.set(commandKey, { body: requestBody, idempotencyKey });
  persistBountyPendingCommands();
  try {
    message.className = 'text-sm text-gray-400'; message.textContent = 'Posting…';
    await bountyJson(`/api/bounties/${context.serverId}`, {
      method: 'POST',
      headers: { ...getCsrfHeaders(), 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: requestBody,
    });
    const completedCommand = bountyPendingCommands.get(commandKey);
    if (completedCommand?.idempotencyKey === idempotencyKey) {
      bountyPendingCommands.delete(commandKey);
      persistBountyPendingCommands();
    }
    if (bountyContext?.generation === context.generation) await loadBountyBoard(context);
  } catch (error) {
    if (bountyContext?.generation === context.generation) {
      message.className = 'text-sm text-red-400'; message.textContent = error.message;
    }
  }
}

async function cancelBounty(context, bountyId) {
  if (!bountyContext || bountyContext.generation !== context.generation
      || bountyContext.serverId !== context.serverId) return;
  if (!confirm('Request cancellation? Funds remain reserved until authoritative log coverage reaches the cutoff.')) return;
  try {
    await bountyJson(`/api/bounties/${context.serverId}/${bountyId}/cancel`, {
      method: 'POST', headers: { ...getCsrfHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'cancelled_by_poster' }),
    });
    if (bountyContext?.generation === context.generation) await loadBountyBoard(context);
  } catch (error) {
    if (bountyContext?.generation === context.generation) alert(error.message);
  }
}

function resetBountiesContext() {
  bountyGeneration += 1;
  bountyBoardRequestId += 1;
  bountyPlayerSearchRequestId += 1;
  bountyContext = null;
  bountyOptions = null;
  const container = document.getElementById('bounties-tab');
  if (container) container.replaceChildren();
}

function initBounties(serverId, guildId, identityId) {
  bountyGeneration += 1;
  bountyContext = { serverId: Number(serverId), guildId: String(guildId), identityId: Number(identityId), generation: bountyGeneration };
  const context = bountyContext;
  const container = document.getElementById('bounties-tab');
  container.innerHTML = '<p class="text-gray-400">Loading bounties…</p>';
  loadBountyBoard(context).catch(error => {
    if (bountyContext?.generation === context.generation) {
      container.textContent = `Failed to load bounties: ${error.message}`;
      container.className = 'container mx-auto p-6 max-w-5xl text-red-400';
    }
  });
}
