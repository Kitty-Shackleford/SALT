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
      classList: { _classes: new Set(), add(c) { this._classes.add(c); }, remove(c) { this._classes.delete(c); }, toggle() {}, contains(c) { return this._classes.has(c); } },
      addEventListener() {}, querySelectorAll: () => [],
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    api: { get: () => new Promise(() => {}) },
    document: { body: { appendChild() {} }, getElementById: element, addEventListener() {}, querySelectorAll: () => [], createElement: () => ({ className: '', textContent: '', remove() {} }) },
    window: {}, console, alert() {}, confirm: () => false,
    fetch: () => new Promise(() => {}),
    fetchWithCsrf: () => new Promise(() => {}),
    setTimeout, clearTimeout, encodeURIComponent,
    ...overrides,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public/js', file), 'utf8'), context);
  return { context, element };
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
  assert.ok(html.includes('Owner details unavailable'), 'installation-only guild must explain missing ownership instead of Unknown');
  assert.ok(html.includes('/register-token'), 'missing owner needs an actionable registration step');
  assert.ok(html.includes('does not identify the installer'), 'bot presence must not imply installer identity');
  assert.ok(html.includes('Setup incomplete'), 'installation-only guild must be labeled as incomplete setup');
  assert.ok(!html.includes('data-action="approve"'), 'installation-only guild must not offer manual approval');
  const named = approval.context.renderGuildCard({ ...shell, ownerUsername: '<script>owner</script>' });
  assert.ok(named.includes('&lt;script&gt;owner&lt;/script&gt;'));
  assert.ok(!named.includes('<script>owner</script>'));
  const identified = approval.context.renderGuildCard({ ...shell, ownerDiscordId: '123456789012345678' });
  assert.ok(identified.includes('123456789012345678'), 'known owner ID survives a missing username');

  // Visible "remove guild" affordance: the management page must offer
  // removal for BOTH live states — disabled guilds were previously
  // unreachable (only Re-enable), and approved guilds only had Disable.
  const approvedCard = approval.context.renderGuildCard({ ...shell, status: 'approved' });
  assert.ok(approvedCard.includes('data-action="disable"'), 'approved guild still offers Disable');
  assert.ok(approvedCard.includes('data-action="remove"'), 'approved guild must offer Remove');
  const disabledCard = approval.context.renderGuildCard({ ...shell, status: 'disabled' });
  assert.ok(disabledCard.includes('data-action="enable"'), 'disabled guild still offers Re-enable');
  assert.ok(disabledCard.includes('data-action="remove"'), 'disabled guild must offer Remove (previously unreachable)');
  assert.ok(!html.includes('data-action="remove"'), 'pending guilds must not offer Remove');

  // Full remove flow: confirm modal → DELETE /api/admin/guilds/:id
  const removeRequests = [];
  approval.context.document.createElement = () => ({ className: '', textContent: '', remove() {} });
  approval.context.fetchWithCsrf = (url, options) => {
    removeRequests.push({ url, options });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
  };
  approval.context.showConfirmModal('remove', { guild_id: 'rm-1', guildName: 'Doomed', status: 'disabled' });
  assert.equal(approval.element('modalTitle').textContent, 'Remove Guild');
  assert.match(approval.element('modalMessage').innerHTML, /leave the Discord server/);
  await approval.context.executeAction();
  assert.equal(removeRequests.length, 1);
  assert.equal(removeRequests[0].url, '/api/admin/guilds/rm-1');
  assert.equal(removeRequests[0].options.method, 'DELETE');
  assert.equal(removeRequests[0].options.body, undefined, 'the DELETE route takes no body');
  assert.ok(approval.element('confirmModal').classList.contains('hidden'),
    'modal closes after a successful remove');

  const listing = harness('admin-guilds.js');
  listing.context.api.get = async () => ({ json: async () => ({ success: true, guilds: [shell] }) });
  listing.context.loadGuilds();
  await new Promise(resolve => setImmediate(resolve));
  const listHtml = listing.element('guilds-container').innerHTML;
  assert.ok(listHtml.includes('Owner details unavailable'), 'guild table must also explain an installation-only shell');
  assert.ok(listHtml.includes('/register-token'));

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
  console.log('Admin onboarding UI tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
