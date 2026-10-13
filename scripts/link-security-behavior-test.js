'use strict';

const assert = require('assert');
const {
  mutateBotLinkSettings,
} = require('../bot/utils/linkSettings');
const {
  fetchCurrentGuildMember,
  assertActorCanModerate,
  performForceLinkTransaction,
  ensureUsersAndLockRoleMutations,
} = require('../bot/commands/link-admin');

function result(rows = []) {
  return { rows };
}

async function testSettingsMutationUsesLockedCurrentStateAndAudits() {
  const events = [];
  const currentConfig = {
    verificationMode: 'open',
    roles: {
      assignOnJoin: [],
      assignOnLink: ['current-role'],
      removeOnLink: [],
      removeOnLeave: [],
    },
  };
  let savedConfig;
  const client = {
    async query(sql, params = []) {
      events.push(sql.trim().replace(/\s+/g, ' '));
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result();
      if (sql.includes('SELECT id FROM users WHERE discord_id')) return result([{ id: 41 }]);
      if (sql.includes('INSERT INTO users')) return result([{ id: 41 }]);
      if (sql.includes('FROM servers s') && sql.includes('FOR UPDATE OF s, g')) {
        return result([{ server_id: 7, guild_id: 3 }]);
      }
      if (sql.includes('pg_advisory_xact_lock')) return result();
      if (sql.includes('FROM guild_roles')) return result([{ role: 'admin' }]);
      if (sql.includes('FROM server_role_assignments')) return result([]);
      if (sql.includes('FROM server_features') && sql.includes("feature_name = 'player_linking'") &&
          sql.includes('FOR UPDATE')) {
        return result([{ enabled: true, config: currentConfig }]);
      }
      if (sql.includes('sf.server_id <>')) return result([]);
      if (sql.includes('INSERT INTO server_features')) {
        savedConfig = JSON.parse(params[1]);
        return result();
      }
      if (sql.includes('INSERT INTO discord_role_reconciliation_jobs')) return result([]);
      if (sql.includes('INSERT INTO security_audit_events')) return result();
      if (sql.includes('INSERT INTO discord_link_role_policy_history')) return result();
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() { events.push('RELEASE'); },
  };
  const db = { async connect() { return client; } };

  await mutateBotLinkSettings(db, {
    serverId: 7,
    discordGuildId: '123456789012345678',
    actor: { discordId: '223456789012345678', username: 'actor', avatar: null },
    resolveNativePermissions: async () => ({ administrator: false, manageRoles: true }),
    change: { type: 'verification', mode: 'admin_approval' },
    runRoleJob: async () => {},
  });

  assert.equal(savedConfig.verificationMode, 'admin_approval');
  assert.deepStrictEqual(savedConfig.roles.assignOnLink, ['current-role'],
    'a verification update must preserve roles from the locked current row, not stale command state');
  const scopeLock = events.findIndex(event => event.includes('FOR UPDATE OF s, g'));
  const guildLock = events.findIndex((event, index) =>
    index > scopeLock && event.includes('pg_advisory_xact_lock'));
  const currentLock = events.findIndex(event => event.includes("feature_name = 'player_linking'") && event.includes('FOR UPDATE'));
  const write = events.findIndex(event => event.includes('INSERT INTO server_features'));
  const audit = events.findIndex(event => event.includes('INSERT INTO security_audit_events'));
  assert.ok(scopeLock > events.indexOf('BEGIN'));
  assert.ok(guildLock > scopeLock && currentLock > guildLock && write > currentLock && audit > write,
    'scope, guild policy, current row, write, and audit must be ordered inside one transaction');
}

async function testRoleSettingsMutationPrunesDeletedGuildRoles() {
  const liveRole = '333333333333333333';
  const staleRole = '444444444444444444';
  const freshieRole = '555555555555555555';
  let savedConfig;
  let deletedHistoryRoleIds = [];
  const client = {
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return result();
      if (sql.includes('SELECT id FROM users WHERE discord_id')) return result([{ id: 41 }]);
      if (sql.includes('INSERT INTO users')) return result([{ id: 41 }]);
      if (sql.includes('FROM servers s') && sql.includes('FOR UPDATE OF s, g')) {
        return result([{ server_id: 7, guild_id: 3 }]);
      }
      if (sql.includes('pg_advisory_xact_lock')) return result();
      if (sql.includes('FROM guild_roles')) return result([{ role: 'admin' }]);
      if (sql.includes('FROM server_role_assignments')) return result([]);
      if (sql.includes('FROM server_features') && sql.includes("feature_name = 'player_linking'") &&
          sql.includes('FOR UPDATE')) {
        return result([{
          enabled: true,
          config: {
            verificationMode: 'open',
            roles: {
              assignOnJoin: [staleRole],
              assignOnLink: [staleRole, liveRole],
              removeOnLink: [],
              removeOnLeave: [staleRole],
            },
          },
        }]);
      }
      if (sql.includes('sf.server_id <>')) return result([]);
      if (sql.includes('INSERT INTO server_features')) {
        savedConfig = JSON.parse(params[1]);
        return result();
      }
      if (sql.includes('INSERT INTO discord_role_reconciliation_jobs')) return result([]);
      if (sql.includes('INSERT INTO security_audit_events')) return result();
      if (sql.includes('INSERT INTO discord_link_role_policy_history')) return result();
      if (sql.includes('DELETE FROM discord_link_role_policy_history')) {
        deletedHistoryRoleIds = params[1] || [];
        return result();
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {},
  };

  await mutateBotLinkSettings({ async connect() { return client; } }, {
    serverId: 7,
    discordGuildId: '123456789012345678',
    actor: { discordId: '223456789012345678', username: 'actor', avatar: null },
    resolveNativePermissions: async () => ({ administrator: false, manageRoles: true }),
    availableRoleIds: new Set([liveRole, freshieRole]),
    change: {
      type: 'role',
      operation: 'add',
      roleKey: 'removeOnLink',
      roleId: freshieRole,
    },
    runRoleJob: async () => {},
  });

  assert.deepStrictEqual(savedConfig.roles, {
    assignOnJoin: [],
    assignOnLink: [liveRole],
    removeOnLink: [freshieRole],
    removeOnLeave: [],
  }, 'a role settings mutation must remove deleted guild-role references before saving');
  assert.deepStrictEqual(deletedHistoryRoleIds, [staleRole],
    'stale assignment history must be removed so reconciliation does not keep retrying a deleted role');
}

async function testLinkSettingsRoleMutationUsesCurrentGuildRoleInventory() {
  const linkSettingsPath = require.resolve('../bot/utils/linkSettings');
  const botDbPath = require.resolve('../bot/db');
  const commandPath = require.resolve('../bot/commands/link-settings');
  const originalLinkSettings = require.cache[linkSettingsPath];
  const originalBotDb = require.cache[botDbPath];
  const originalCommand = require.cache[commandPath];
  let mutationOptions;
  let fetchedRoles = false;
  const roles = new Map([
    ['333333333333333333', { id: '333333333333333333', managed: false, editable: true }],
    ['555555555555555555', { id: '555555555555555555', managed: false, editable: true }],
  ]);

  require.cache[linkSettingsPath] = {
    id: linkSettingsPath,
    filename: linkSettingsPath,
    loaded: true,
    exports: {
      async mutateBotLinkSettings(_db, options) { mutationOptions = options; },
      async getLinkSettings() { throw new Error('status path must not run'); },
    },
  };
  require.cache[botDbPath] = { id: botDbPath, filename: botDbPath, loaded: true, exports: {} };
  delete require.cache[commandPath];

  try {
    const command = require(commandPath);
    const replies = [];
    await command.execute({
      authorizedServerId: 7,
      guild: {
        id: '123456789012345678',
        roles: {
          async fetch() {
            fetchedRoles = true;
            return roles;
          },
        },
      },
      user: { id: '223456789012345678', username: 'actor', avatar: null },
      options: {
        getSubcommand() { return 'role-add'; },
        getRole() { return roles.get('555555555555555555'); },
        getString(name) { return name === 'action' ? 'remove_on_link' : null; },
      },
      async deferReply() {},
      async editReply(reply) { replies.push(reply); },
    });
    assert.equal(fetchedRoles, true,
      'role settings mutations must refresh the guild role inventory before saving');
    assert.deepStrictEqual([...mutationOptions.availableRoleIds].sort(), [...roles.keys()].sort(),
      'role settings mutations must pass the current guild role inventory into the locked mutation');
    assert.ok(replies.some(reply => String(reply).includes('Added')));
  } finally {
    delete require.cache[commandPath];
    if (originalCommand) require.cache[commandPath] = originalCommand;
    if (originalLinkSettings) require.cache[linkSettingsPath] = originalLinkSettings;
    else delete require.cache[linkSettingsPath];
    if (originalBotDb) require.cache[botDbPath] = originalBotDb;
    else delete require.cache[botDbPath];
  }
}

async function testSettingsMutationFailsClosedAfterAuthorityRevocation() {
  let wrote = false;
  const client = {
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return result();
      if (sql.includes('SELECT id FROM users WHERE discord_id')) return result([{ id: 41 }]);
      if (sql.includes('INSERT INTO users')) return result([{ id: 41 }]);
      if (sql.includes('FROM servers s') && sql.includes('FOR UPDATE OF s, g')) {
        return result([{ server_id: 7, guild_id: 3 }]);
      }
      if (sql.includes('pg_advisory_xact_lock')) return result();
      if (sql.includes('FROM guild_roles') || sql.includes('FROM server_role_assignments')) return result([]);
      if (sql.includes('INSERT INTO server_features')) wrote = true;
      return result();
    },
    release() {},
  };
  await assert.rejects(
    mutateBotLinkSettings({ async connect() { return client; } }, {
      serverId: 7,
      discordGuildId: '123456789012345678',
      actor: { discordId: '223456789012345678', username: 'actor', avatar: null },
      resolveNativePermissions: async () => ({ administrator: false, manageRoles: false }),
      change: { type: 'verification', mode: 'open' },
      runRoleJob: async () => {},
    }),
    error => error.code === 'AUTHORITY_REVOKED'
  );
  assert.equal(wrote, false, 'revoked authority must perform no settings write');
}

async function testCurrentDiscordMemberFetchRejectsDepartureAndRefreshesAdministrator() {
  const calls = [];
  const guild = {
    members: {
      async fetch(options) {
        calls.push(options);
        if (options.user === 'departed') {
          const error = new Error('Unknown Member');
          error.code = 10007;
          throw error;
        }
        return {
          permissions: {
            has(permission) {
              return permission === 'Administrator';
            },
          },
        };
      },
    },
  };

  await assert.rejects(fetchCurrentGuildMember(guild, 'departed'), error => error.code === 'MEMBER_LEFT');
  const member = await fetchCurrentGuildMember(guild, 'current');
  assert.equal(member.permissions.has('Administrator'), true);
  assert.deepStrictEqual(calls, [
    { user: 'departed', force: true },
    { user: 'current', force: true },
  ]);
}

async function testModeratorAuthorityIgnoresStaleInteractionAdministratorSnapshot() {
  const identity = { server_id: 7, guild_id: 3 };
  const client = {
    async query(sql) {
      if (sql.includes('FROM servers s')) return result([{ id: 7 }]);
      if (sql.includes('FROM guild_roles') || sql.includes('FROM server_role_assignments')) return result([]);
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const interaction = {
    user: { id: 'actor' },
    memberPermissions: { has() { return true; } },
    guild: {
      id: '123456789012345678',
      members: {
        async fetch() {
          return { permissions: { has() { return false; } } };
        },
      },
    },
  };
  await assert.rejects(
    assertActorCanModerate(client, 41, identity, interaction),
    error => error.code === 'AUTHORITY_REVOKED',
    'a stale interaction Administrator snapshot must not authorize force-link'
  );
  interaction.guild.members.fetch = async () => ({ permissions: { has() { return true; } } });
  await assertActorCanModerate(client, 41, identity, interaction);
}

function forceLinkFixture(memberFetch) {
  let linkedAccountWrite = false;
  let userInsertCount = 0;
  const client = {
    async query(sql) {
      if (sql.includes('SELECT id, discord_id FROM users')) return result([
        { id: 41, discord_id: 'actor' },
        { id: 42, discord_id: 'target' },
      ]);
      if (sql.includes('pg_advisory_xact_lock') || sql.includes('UPDATE users')) return result();
      if (sql.includes('INSERT INTO users')) {
        userInsertCount += 1;
        return result([{ id: userInsertCount === 1 ? 41 : 42 }]);
      }
      if (sql.includes('FROM servers s')) return result([{ id: 7 }]);
      if (sql.includes('FROM guild_roles')) return result([{ role: 'admin' }]);
      if (sql.includes('FROM server_role_assignments')) return result([]);
      if (sql.includes('linked_accounts') || sql.includes('server_player_memberships')) {
        linkedAccountWrite = true;
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return {
    client,
    interaction: {
      user: { id: 'actor', username: 'actor', avatar: null },
      guild: {
        id: '123456789012345678',
        members: { fetch: memberFetch },
      },
    },
    identity: { server_id: 7, guild_id: 3, identity_id: 9, gamertag: 'Survivor' },
    target: { id: 'target', username: 'target', avatar: null },
    wroteLink() { return linkedAccountWrite; },
  };
}

async function testForceLinkTransactionRejectsTargetDepartureBeforeLinkWrites() {
  const fetched = [];
  const fixture = forceLinkFixture(async options => {
    fetched.push(options);
    if (options.user === 'target') throw new Error('Unknown Member');
    return { permissions: { has() { return false; } } };
  });
  await assert.rejects(
    performForceLinkTransaction(fixture.client, {
      interaction: fixture.interaction,
      identity: fixture.identity,
      target: fixture.target,
      serverId: 7,
    }),
    error => error.code === 'MEMBER_LEFT'
  );
  assert.deepStrictEqual(fetched, [
    { user: 'actor', force: true },
    { user: 'target', force: true },
  ]);
  assert.equal(fixture.wroteLink(), false,
    'a departed target must be rejected before ownership or membership writes');
}

async function testForceLinkTransactionRejectsRevokedActorBeforeTargetLookup() {
  const fetched = [];
  const fixture = forceLinkFixture(async options => {
    fetched.push(options);
    return { permissions: { has() { return false; } } };
  });
  fixture.client.query = async sql => {
    if (sql.includes('SELECT id, discord_id FROM users')) return result([
      { id: 41, discord_id: 'actor' },
      { id: 42, discord_id: 'target' },
    ]);
    if (sql.includes('pg_advisory_xact_lock') || sql.includes('UPDATE users')) return result();
    if (sql.includes('INSERT INTO users')) {
      testForceLinkTransactionRejectsRevokedActorBeforeTargetLookup.userId =
        (testForceLinkTransactionRejectsRevokedActorBeforeTargetLookup.userId || 40) + 1;
      return result([{ id: testForceLinkTransactionRejectsRevokedActorBeforeTargetLookup.userId }]);
    }
    if (sql.includes('FROM servers s')) return result([{ id: 7 }]);
    if (sql.includes('FROM guild_roles') || sql.includes('FROM server_role_assignments')) return result([]);
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  await assert.rejects(
    performForceLinkTransaction(fixture.client, {
      interaction: fixture.interaction,
      identity: fixture.identity,
      target: fixture.target,
      serverId: 7,
    }),
    error => error.code === 'AUTHORITY_REVOKED'
  );
  assert.deepStrictEqual(fetched, [{ user: 'actor', force: true }],
    'revoked operation-time authority must fail before target lookup or link mutation');
}

async function testSuccessfulForceLinkTransactionExecutesCompleteMutationPath() {
  const events = [];
  let userInsertCount = 0;
  const client = {
    async query(sql, params = []) {
      const normalized = sql.trim().replace(/\s+/g, ' ');
      events.push({ sql: normalized, params });
      if (sql.includes('SELECT id, discord_id FROM users')) return result([
        { id: 41, discord_id: 'actor' },
        { id: 42, discord_id: 'target' },
      ]);
      if (sql.includes('pg_advisory_xact_lock') || sql.includes('UPDATE users')) return result();
      if (sql.includes('INSERT INTO users')) {
        userInsertCount += 1;
        return result([{ id: 42 + userInsertCount, discord_id: params[0] }]);
      }
      if (sql.includes('FROM servers s')) return result([{ id: 7 }]);
      if (sql.includes('FROM guild_roles')) return result([{ role: 'admin' }]);
      if (sql.includes('FROM server_role_assignments')) return result([]);
      if (sql.includes('SELECT id, user_id FROM linked_accounts')) return result([]);
      if (sql.includes('INSERT INTO linked_accounts')) return result([{ id: 77 }]);
      if (sql.includes('INSERT INTO server_player_memberships')) return result();
      if (sql.includes('INSERT INTO security_audit_events')) return result();
      if (sql.includes('INSERT INTO discord_role_reconciliation_jobs')) {
        return result([{
          id: 88,
          discord_guild_id: '123456789012345678',
          discord_user_id: 'target',
          user_id: 42,
          generation: 1,
        }]);
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const fetched = [];
  const interaction = {
    user: { id: 'actor', username: 'actor', avatar: null },
    guild: {
      id: '123456789012345678',
      members: {
        async fetch(options) {
          fetched.push(options);
          return { permissions: { has() { return false; } } };
        },
      },
    },
  };
  const resultValue = await performForceLinkTransaction(client, {
    interaction,
    identity: { server_id: 7, guild_id: 3, identity_id: 9, gamertag: 'Survivor' },
    target: { id: 'target', username: 'target', avatar: null },
    serverId: 7,
  });

  assert.deepStrictEqual(fetched, [
    { user: 'actor', force: true },
    { user: 'target', force: true },
  ]);
  const ownershipLock = events.findIndex(event =>
    event.sql.includes('SELECT id, user_id FROM linked_accounts') && event.sql.includes('FOR UPDATE'));
  const actorLock = events.findIndex(event => event.sql.includes('pg_advisory_xact_lock'));
  const scopeLock = events.findIndex(event => event.sql.includes('FOR UPDATE OF s, g'));
  const ownershipInsert = events.findIndex(event => event.sql.includes('INSERT INTO linked_accounts'));
  const membershipUpsert = events.findIndex(event => event.sql.includes('INSERT INTO server_player_memberships'));
  const auditInsert = events.findIndex(event => event.sql.includes('INSERT INTO security_audit_events'));
  const reconciliationInsert = events.findIndex(event =>
    event.sql.includes('INSERT INTO discord_role_reconciliation_jobs'));
  assert.ok(actorLock >= 0 && scopeLock > actorLock && ownershipLock > scopeLock &&
    ownershipInsert > ownershipLock &&
    membershipUpsert > ownershipInsert && auditInsert > membershipUpsert &&
    reconciliationInsert > auditInsert,
  'force-link must lock actor/target before scope, then ownership, membership, audit, and reconciliation');
  assert.deepStrictEqual(events[membershipUpsert].params, [7, 3, 9, 42, 77, 41]);
  assert.equal(events[auditInsert].params[0], 41);
  assert.equal(events[auditInsert].params[1], 3);
  assert.equal(events[auditInsert].params[2], 7);
  assert.equal(resultValue.roleJob.id, 88);
  assert.ok(resultValue.targetMember);
}

async function testForceMutationsLockActorAndTargetInDeterministicOrder() {
  const locks = [];
  const client = {
    async query(sql, params) {
      if (sql.includes('SELECT id, discord_id FROM users')) return result([
        { id: 90, discord_id: 'actor' },
        { id: 12, discord_id: 'target' },
      ]);
      if (sql.includes('pg_advisory_xact_lock')) {
        locks.push(params);
        return result();
      }
      if (sql.includes('UPDATE users')) return result();
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  await ensureUsersAndLockRoleMutations(client, [
    { discordId: 'actor', username: 'actor' },
    { discordId: 'target' },
  ]);
  assert.deepStrictEqual(locks, [
    [2147483001, 12],
    [2147483001, 90],
  ], 'force mutations must use the shared deterministic actor/target advisory-lock order');
}

async function testMissingForceMutationUsersResolveInDeterministicOrder() {
  const inserts = [];
  let nextId = 100;
  const client = {
    async query(sql, params) {
      if (sql.includes('SELECT id, discord_id FROM users WHERE discord_id = ANY')) return result();
      if (sql.includes('INSERT INTO users')) {
        inserts.push(params[0]);
        nextId += 1;
        return result([{ id: nextId, discord_id: params[0] }]);
      }
      if (sql.includes('pg_advisory_xact_lock') || sql.includes('UPDATE users')) return result();
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  await ensureUsersAndLockRoleMutations(client, [
    { discordId: '900000000000000002', username: 'later' },
    { discordId: '100000000000000001', username: 'earlier' },
  ]);
  assert.deepStrictEqual(inserts, [
    '100000000000000001',
    '900000000000000002',
  ], 'missing identities must be inserted in a caller-independent order');
}

async function main() {
  await testSettingsMutationUsesLockedCurrentStateAndAudits();
  await testRoleSettingsMutationPrunesDeletedGuildRoles();
  await testLinkSettingsRoleMutationUsesCurrentGuildRoleInventory();
  await testSettingsMutationFailsClosedAfterAuthorityRevocation();
  await testCurrentDiscordMemberFetchRejectsDepartureAndRefreshesAdministrator();
  await testModeratorAuthorityIgnoresStaleInteractionAdministratorSnapshot();
  await testForceLinkTransactionRejectsTargetDepartureBeforeLinkWrites();
  await testForceLinkTransactionRejectsRevokedActorBeforeTargetLookup();
  await testSuccessfulForceLinkTransactionExecutesCompleteMutationPath();
  await testForceMutationsLockActorAndTargetInDeterministicOrder();
  await testMissingForceMutationUsersResolveInDeterministicOrder();
  console.log('✅ Link settings and force-link executable security behavior tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
