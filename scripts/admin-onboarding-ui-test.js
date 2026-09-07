'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(file, overrides = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', value: '', style: {}, className: '',
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {}, querySelectorAll: () => [],
    });
    return elements.get(id);
  };
  const appended = [];
  const context = vm.createContext({
    api: { get: () => new Promise(() => {}) },
    document: {
      getElementById: element, addEventListener() {}, querySelectorAll: () => [],
      createElement: () => ({ className: '', textContent: '', remove() {} }),
      body: { appendChild: node => appended.push(node) },
    },
    window: {}, console, alert() {}, confirm: () => false,
    fetch: () => new Promise(() => {}),
    fetchWithCsrf: () => new Promise(() => {}),
    setTimeout, clearTimeout, encodeURIComponent,
    ...overrides,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public/js', file), 'utf8'), context);
  return { context, element, appended };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

async function main() {
  const approval = harness('admin-guilds-approval.js');
  const shell = { guild_id: 'fixture-guild', guildName: 'Fixture', status: 'pending', created_at: '2026-01-01', serverCount: 0 };
  const html = approval.context.renderGuildCard(shell);
  assert.ok(html.includes('Setup incomplete'), 'installation-only guild must be labeled as incomplete setup');
  assert.ok(!html.includes('data-action="approve"'), 'installation-only guild must not offer manual approval');
  const named = approval.context.renderGuildCard({ ...shell, ownerUsername: '<script>owner</script>' });
  assert.ok(named.includes('&lt;script&gt;owner&lt;/script&gt;'));
  assert.ok(!named.includes('<script>owner</script>'));

  const users = harness('admin-users.js');
  assert.equal(users.context.isAuthorizedUser({ hasAccess: true }), true);
  assert.equal(users.context.isAuthorizedUser({ hasAccess: false }), false);
  assert.equal(users.context.userAccessLabel({ hasAccess: false }), 'Signed in only — no guild or server access');
  assert.equal(users.context.usersEndpoint('authorized', ''), '/api/roles/users?status=authorized');
  assert.equal(users.context.usersEndpoint('unassigned', 'Test User'),
    '/api/roles/users?status=unassigned&search=Test%20User');

  const tabRequests = [];
  const tabs = harness('admin-guilds-approval.js', {
    fetch() {
      const request = deferred();
      tabRequests.push(request);
      return request.promise;
    },
  });
  tabs.context.switchTab('approved');
  tabs.context.switchTab('disabled');
  tabRequests[1].resolve({ json: async () => ({
    success: true,
    guilds: [{ guild_id: 'disabled', guildName: 'Current disabled', status: 'disabled', created_at: '2026-01-01' }],
  }) });
  await flush();
  assert.match(tabs.element('guilds-container').innerHTML, /Current disabled/);
  tabRequests[0].resolve({ json: async () => ({
    success: true,
    guilds: [{ guild_id: 'approved', guildName: 'Stale approved', status: 'approved', created_at: '2026-01-01' }],
  }) });
  await flush();
  assert.match(tabs.element('guilds-container').innerHTML, /Current disabled/,
    'a stale guild-tab response must not replace the current tab');

  const roleAlerts = [];
  const roleRequests = [];
  users.context.alert = message => roleAlerts.push(message);
  users.context.fetchWithCsrf = () => {
    const body = deferred();
    roleRequests.push(body);
    return Promise.resolve({ ok: true, json: () => body.promise });
  };
  const openingA = users.context.openRoles(1);
  const openingB = users.context.openRoles(2);
  roleRequests[1].resolve({ user: { id: 2, username: 'Current user' }, assignments: [] });
  await openingB;
  assert.equal(users.element('role-modal-title').textContent, 'Roles — Current user');
  roleRequests[0].resolve({ user: { id: 1, username: 'Stale user' }, assignments: [] });
  await openingA;
  assert.equal(users.element('role-modal-title').textContent, 'Roles — Current user',
    'a stale user-role response must not replace the current selection');

  const openingC = users.context.openRoles(3);
  const openingD = users.context.openRoles(4);
  roleRequests[3].resolve({ user: { id: 4, username: 'Newest user' }, assignments: [] });
  await openingD;
  roleRequests[2].reject(new Error('stale failure'));
  await openingC;
  assert.deepEqual(roleAlerts, [], 'a stale user-role failure must not alert over the current selection');

  const mutationAlerts = [];
  const mutationBodies = [];
  const mutationUsers = harness('admin-users.js', {
    alert: message => mutationAlerts.push(message),
    confirm: () => true,
    fetchWithCsrf() {
      const body = deferred();
      mutationBodies.push(body);
      return Promise.resolve({ ok: true, json: () => body.promise });
    },
  });
  mutationUsers.element('grant-select').value = JSON.stringify({ role: 'guild_admin', guildId: 20 });
  vm.runInContext(`
    selectedUser = { id: 5, username: 'Old user' };
    selectionGeneration = 10;
    window.openCalls = 0;
    window.loadCalls = 0;
    openRoles = async () => { window.openCalls++; return true; };
    loadPage = async () => { window.loadCalls++; };
  `, mutationUsers.context);
  const staleGrant = mutationUsers.context.grantRole();
  await flush();
  mutationUsers.context.closeRoles();
  vm.runInContext("selectedUser = { id: 6, username: 'New user' }; selectionGeneration++;", mutationUsers.context);
  mutationUsers.element('grant-role-btn').disabled = true;
  mutationBodies[0].resolve({ success: true });
  await staleGrant;
  assert.equal(mutationUsers.context.window.openCalls, 0,
    'a stale role mutation success must not refresh the old selection');
  assert.equal(mutationUsers.context.window.loadCalls, 0,
    'a stale role mutation success must not reload under a newer selection');
  assert.equal(mutationUsers.element('grant-role-btn').disabled, true,
    'stale cleanup must not alter controls belonging to a newer selection');
  assert.deepEqual(mutationAlerts, []);

  const userSource = fs.readFileSync(path.join(__dirname, '..', 'public/js/admin-users.js'), 'utf8');
  for (const functionName of ['transferOwnership', 'grantRole', 'removeRole']) {
    const start = userSource.indexOf(`async function ${functionName}`);
    const end = userSource.indexOf('\nasync function ', start + 1);
    const body = userSource.slice(start, end === -1 ? undefined : end);
    assert.match(body, /selectionIsCurrent\(generation, userId\)/,
      `${functionName} must suppress stale success, error, and cleanup continuations`);
  }

  const guildAlerts = [];
  const actionBodies = [];
  const actions = harness('admin-guilds-approval.js', {
    alert: message => guildAlerts.push(message),
    fetchWithCsrf() {
      const body = deferred();
      actionBodies.push(body);
      return Promise.resolve({ json: () => body.promise });
    },
  });
  vm.runInContext("pendingAction = { action: 'disable', guildId: 'old-guild' }; guildActionGeneration = 3;", actions.context);
  const staleAction = actions.context.executeAction();
  await flush();
  actions.context.closeModal();
  vm.runInContext("pendingAction = { action: 'enable', guildId: 'new-guild' }; guildActionGeneration++;", actions.context);
  actionBodies[0].resolve({ success: true });
  await staleAction;
  assert.deepEqual(guildAlerts, [], 'a stale guild mutation must not display an alert for a newer action');
  assert.equal(actions.appended.length, 0, 'a stale guild mutation must not display a success message');
  assert.equal(vm.runInContext('pendingAction.guildId', actions.context), 'new-guild',
    'a stale guild mutation must not close the newer confirmation modal');

  console.log('Admin onboarding UI tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
