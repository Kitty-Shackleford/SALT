'use strict';
/* global document, fetchWithCsrf, alert, confirm */

let roleContext = { scopes: [], availableGrants: [] };
let allUsers = [];
let selectedUser = null;
let selectedAssignments = [];
let selectionGeneration = 0;
let userLoadGeneration = 0;
let searchTimer = null;

function selectionIsCurrent(generation, userId) {
  return generation === selectionGeneration && Number(selectedUser?.id) === Number(userId);
}

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function roleLabel(role) {
  return ({
    dashboard_owner: 'Dashboard Owner', dashboard_admin: 'Dashboard Admin',
    guild_owner: 'Discord / Nitrado Owner', guild_admin: 'Discord / Nitrado Admin',
    server_admin: 'Server Admin', moderator: 'Moderator', player: 'Player',
  })[role] || role;
}

async function json(url, options) {
  const response = await fetchWithCsrf(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function isAuthorizedUser(user) {
  return user.hasAccess === true || Number(user.hasAccess) === 1;
}

function userAccessLabel(user) {
  return isAuthorizedUser(user) ? 'Authorized' : 'Signed in only — no guild or server access';
}

function usersEndpoint(status, search) {
  const query = [`status=${encodeURIComponent(status)}`];
  if (search) query.push(`search=${encodeURIComponent(search)}`);
  return `/api/roles/users?${query.join('&')}`;
}

async function loadUsers() {
  const generation = ++userLoadGeneration;
  const status = document.getElementById('accessFilter').value;
  const search = document.getElementById('searchInput').value.trim();
  try {
    const data = await json(usersEndpoint(status, search));
    if (generation !== userLoadGeneration) return;
    allUsers = data.users || [];
    const headings = {
      authorized: 'Authorized Users',
      unassigned: 'Signed-in-only Accounts',
      all: 'All Accounts',
    };
    document.getElementById('users-heading').textContent = headings[status] || 'Users';
    displayUsers();
  } catch (error) {
    if (generation !== userLoadGeneration) return;
    document.getElementById('users-container').innerHTML =
      `<p class="text-red-400 text-center py-4">${esc(error.message)}</p>`;
  }
}

async function loadPage() {
  try {
    roleContext = await json('/api/roles/context');
    await loadUsers();
  } catch (error) {
    document.getElementById('users-container').innerHTML =
      `<p class="text-red-400 text-center py-4">${esc(error.message)}</p>`;
  }
}

function displayUsers() {
  const search = document.getElementById('searchInput').value.toLowerCase();
  const accessFilter = document.getElementById('accessFilter').value;
  const filtered = allUsers.filter(user => {
    const matchesAccess = accessFilter === 'all' ||
      (accessFilter === 'authorized' && isAuthorizedUser(user)) ||
      (accessFilter === 'unassigned' && !isAuthorizedUser(user));
    return matchesAccess && (!search ||
      String(user.username || '').toLowerCase().includes(search) || String(user.discord_id || '').includes(search));
  });
  const container = document.getElementById('users-container');
  if (!filtered.length) {
    const emptyLabels = {
      authorized: 'No authorized users found',
      unassigned: 'No signed-in-only accounts found',
      all: 'No accounts found',
    };
    container.innerHTML = `<p class="text-gray-400 text-center py-4">${emptyLabels[accessFilter] || 'No users found'}</p>`;
    return;
  }
  container.innerHTML = `<div class="overflow-x-auto"><table class="w-full">
    <thead class="bg-gray-700"><tr><th class="p-3 text-left">User</th><th class="p-3 text-left">Discord ID</th><th class="p-3 text-left">Access</th><th class="p-3 text-left">Global Role</th><th class="p-3 text-left">Actions</th></tr></thead>
    <tbody>${filtered.map(user => {
    const canKick = roleContext.actor?.platformRole === 'dashboard_owner' &&
      Number(user.id) !== Number(roleContext.actor.id) && user.platform_role !== 'dashboard_owner';
    return `<tr class="border-b border-gray-700">
      <td class="p-3 font-semibold">${esc(user.username || 'Unknown')}</td>
      <td class="p-3 text-gray-400">${esc(user.discord_id || '-')}</td>
      <td class="p-3"><span class="${isAuthorizedUser(user) ? 'text-green-300' : 'text-yellow-300'}">${esc(userAccessLabel(user))}</span></td>
      <td class="p-3">${esc(roleLabel(user.platform_role || (user.is_admin ? 'dashboard_admin' : '-')))}</td>
      <td class="p-3 flex gap-2 flex-wrap">
        <button class="manage-role-btn bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded" data-user-id="${user.id}">Manage Roles</button>
        ${canKick ? `<button class="kick-user-btn bg-red-800 hover:bg-red-700 px-3 py-1 rounded" data-user-id="${user.id}">Kick from Dashboard</button>` : ''}
      </td>
    </tr>`;
  }).join('')}</tbody></table></div>`;
  container.querySelectorAll('.manage-role-btn').forEach(button => {
    button.addEventListener('click', () => openRoles(Number(button.dataset.userId)));
  });
  container.querySelectorAll('.kick-user-btn').forEach(button => {
    button.addEventListener('click', () => kickUser(Number(button.dataset.userId), button));
  });
}

function scopeText(assignment) {
  if (assignment.assignment_type === 'platform') return 'Global';
  return assignment.scope_name || (assignment.server_id ? `Server ${assignment.server_id}` : `Guild ${assignment.guild_id}`);
}

function renderAssignments() {
  const container = document.getElementById('role-list');
  if (!selectedAssignments.length) {
    container.innerHTML = '<p class="text-gray-400">No current application roles.</p>';
    return;
  }
  container.innerHTML = selectedAssignments.map(assignment => {
    const removable = !['dashboard_owner', 'guild_owner'].includes(assignment.role);
    return `<div class="border border-gray-700 rounded p-3 flex justify-between gap-4">
      <div><div class="font-semibold">${esc(roleLabel(assignment.role))}</div>
      <div class="text-sm text-gray-400">Scope: ${esc(scopeText(assignment))}</div>
      <div class="text-xs text-gray-500">Granted by ${esc(assignment.granted_by || 'system/legacy')} ${assignment.granted_at ? `on ${esc(new Date(assignment.granted_at).toLocaleString())}` : ''}</div></div>
      ${removable ? `<button class="remove-role-btn bg-red-700 hover:bg-red-600 px-3 py-1 rounded h-fit" data-assignment-id="${assignment.id}">Remove Role</button>` : '<span class="text-xs text-gray-500">Transfer required</span>'}
    </div>`;
  }).join('');
  container.querySelectorAll('.remove-role-btn').forEach(button => {
    button.addEventListener('click', () => removeRole(Number(button.dataset.assignmentId)));
  });
}

function renderGrantOptions() {
  const select = document.getElementById('grant-select');
  const seen = new Set();
  const options = [];
  for (const grant of roleContext.availableGrants || []) {
    const key = `${grant.role}:${grant.guildId || ''}:${grant.serverId || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const scope = roleContext.scopes.find(item =>
      String(item.guild_id) === String(grant.guildId) && String(item.server_id || '') === String(grant.serverId || ''));
    const label = grant.scope === 'global' ? 'Global' :
      grant.serverId ? `${scope?.guild_name || 'Guild'} → ${scope?.server_name || `Server ${grant.serverId}`}` :
        scope?.guild_name || `Guild ${grant.guildId}`;
    options.push(`<option value="${esc(JSON.stringify(grant))}">${esc(roleLabel(grant.role))} — ${esc(label)}</option>`);
  }
  select.innerHTML = `<option value="">Select an allowed role and scope</option>${options.join('')}`;
  document.getElementById('grant-panel').classList.toggle('hidden', options.length === 0);

  const transferable = (roleContext.scopes || []).filter(scope =>
    roleContext.actor?.platformRole === 'dashboard_owner' || scope.guild_role === 'owner');
  const uniqueGuilds = [...new Map(transferable.map(scope => [String(scope.guild_id), scope])).values()];
  document.getElementById('transfer-owner-select').innerHTML = uniqueGuilds
    .map(scope => `<option value="${scope.guild_id}">${esc(scope.guild_name || `Guild ${scope.guild_id}`)}</option>`).join('');
  document.getElementById('ownership-transfer-panel').classList.toggle('hidden', uniqueGuilds.length === 0);
}

async function transferOwnership() {
  if (!selectedUser) return;
  const generation = selectionGeneration;
  const userId = selectedUser.id;
  const username = selectedUser.username;
  const guildId = Number(document.getElementById('transfer-owner-select').value);
  if (!guildId) return;
  const scope = roleContext.scopes.find(item => Number(item.guild_id) === guildId);
  if (!confirm(`Transfer ownership of ${scope?.guild_name || `Guild ${guildId}`} to ${username}?\n\nThe current owner will retain Guild Admin access. Ownership cannot disappear during this transaction.`)) return;
  try {
    await json(`/api/roles/guilds/${guildId}/transfer-owner`, {
      method: 'POST', body: JSON.stringify({ targetUserId: userId }),
    });
    if (!selectionIsCurrent(generation, userId)) return;
    if (await openRoles(userId)) await loadPage();
  } catch (error) {
    if (selectionIsCurrent(generation, userId)) alert(error.message);
  }
}

async function openRoles(userId) {
  const generation = ++selectionGeneration;
  try {
    const data = await json(`/api/roles/users/${userId}`);
    if (generation !== selectionGeneration) return false;
    selectedUser = data.user;
    selectedAssignments = data.assignments || [];
    document.getElementById('role-modal-title').textContent = `Roles — ${selectedUser.username || selectedUser.discord_id}`;
    renderAssignments();
    renderGrantOptions();
    document.getElementById('role-modal').classList.remove('hidden');
    return true;
  } catch (error) {
    if (generation !== selectionGeneration) return false;
    alert(error.message);
    return false;
  }
}

async function grantRole() {
  if (!selectedUser) return;
  const generation = selectionGeneration;
  const userId = selectedUser.id;
  const raw = document.getElementById('grant-select').value;
  if (!raw) return;
  const grant = JSON.parse(raw);
  if (grant.role === 'player') {
    const identityId = Number(document.getElementById('player-identity-id').value);
    if (!identityId) return alert('Enter the verified player identity ID.');
    grant.identityId = identityId;
  }
  const button = document.getElementById('grant-role-btn');
  button.disabled = true;
  try {
    await json(`/api/roles/users/${userId}`, { method: 'POST', body: JSON.stringify(grant) });
    if (!selectionIsCurrent(generation, userId)) return;
    button.disabled = false;
    if (await openRoles(userId)) await loadPage();
  } catch (error) {
    if (selectionIsCurrent(generation, userId)) alert(error.message);
  } finally {
    if (selectionIsCurrent(generation, userId)) button.disabled = false;
  }
}

async function removeRole(assignmentId) {
  const assignment = selectedAssignments.find(item => Number(item.id) === assignmentId);
  if (!assignment || !selectedUser) return;
  const generation = selectionGeneration;
  const userId = selectedUser.id;
  const username = selectedUser.username;
  const warning = `${username || 'This user'} will lose ${roleLabel(assignment.role)} access to ${scopeText(assignment)}. This may immediately remove access to moderation tools and server data.`;
  if (!confirm(`Remove ${roleLabel(assignment.role)}?\n\n${warning}`)) return;
  try {
    await json(`/api/roles/users/${userId}/roles/${assignment.id}`, {
      method: 'DELETE',
      body: JSON.stringify({
        assignmentType: assignment.assignment_type,
        role: assignment.role,
        guildId: assignment.guild_id,
        serverId: assignment.server_id,
      }),
    });
    if (!selectionIsCurrent(generation, userId)) return;
    if (await openRoles(userId)) await loadPage();
  } catch (error) {
    if (selectionIsCurrent(generation, userId)) alert(error.message);
  }
}

async function kickUser(userId, button) {
  const user = allUsers.find(item => Number(item.id) === userId);
  if (!user || roleContext.actor?.platformRole !== 'dashboard_owner') return;
  const name = user.username || user.discord_id || 'This user';
  const warning = 'This removes their dashboard account, roles, links, private app data, and active sessions. Guild ownership must be transferred first. They may sign in again later as a new unprivileged account.';
  if (!confirm(`Kick ${name} from the Dashboard?\n\n${warning}`)) return;
  button.disabled = true;
  try {
    await json(`/api/roles/users/${userId}`, { method: 'DELETE' });
    if (selectedUser?.id === userId) closeRoles();
    await loadPage();
  } catch (error) {
    alert(error.message);
    button.disabled = false;
  }
}

function closeRoles() {
  selectionGeneration++;
  selectedUser = null;
  selectedAssignments = [];
  document.getElementById('role-modal').classList.add('hidden');
}

document.getElementById('searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadUsers, 250);
});
document.getElementById('accessFilter').addEventListener('change', loadUsers);
document.getElementById('grant-role-btn').addEventListener('click', grantRole);
document.getElementById('transfer-owner-btn').addEventListener('click', transferOwnership);
document.getElementById('close-role-modal').addEventListener('click', closeRoles);
document.getElementById('grant-select').addEventListener('change', event => {
  let role = '';
  try { role = JSON.parse(event.target.value).role; } catch (_) { role = ''; }
  document.getElementById('player-identity-wrap').classList.toggle('hidden', role !== 'player');
});

loadPage();
