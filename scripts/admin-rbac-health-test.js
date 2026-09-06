'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function testRoleGrantPolicy() {
  const { canGrantRole, canRemoveRole } = require('../services/roleManagementService');

  const dashboardOwner = { userId: 1, platformRole: 'dashboard_owner' };
  const dashboardAdmin = { userId: 2, platformRole: 'dashboard_admin' };
  const guildOwner = { userId: 3, guildRole: 'owner', guildId: 10 };
  const guildAdmin = { userId: 4, guildRole: 'admin', guildId: 10 };
  const serverAdmin = { userId: 5, serverRole: 'admin', guildId: 10, serverId: 100 };
  const moderator = { userId: 6, serverRole: 'moderator', guildId: 10, serverId: 100 };
  const player = { userId: 7, player: true, guildId: 10, serverId: 100 };

  assert.equal(canGrantRole(dashboardOwner, { role: 'dashboard_admin', targetUserId: 8 }), true);
  assert.equal(canGrantRole(dashboardAdmin, { role: 'dashboard_owner', targetUserId: 8 }), false);
  assert.equal(canGrantRole(dashboardAdmin, { role: 'dashboard_admin', targetUserId: 8 }), false);
  assert.equal(canGrantRole(dashboardOwner, { role: 'dashboard_owner', targetUserId: 1 }), false,
    'self-promotion/owner creation must use transfer, not generic grant');

  assert.equal(canGrantRole(guildOwner, { role: 'guild_admin', guildId: 10, targetUserId: 8 }), true);
  assert.equal(canGrantRole(guildAdmin, { role: 'guild_admin', guildId: 10, targetUserId: 8 }), false);
  assert.equal(canGrantRole(guildAdmin, { role: 'moderator', guildId: 10, serverId: 100, targetUserId: 8 }), true);
  assert.equal(canGrantRole(serverAdmin, { role: 'moderator', guildId: 10, serverId: 100, targetUserId: 8 }), true);
  assert.equal(canGrantRole(serverAdmin, { role: 'moderator', guildId: 10, serverId: 101, targetUserId: 8 }), false);
  assert.equal(canGrantRole(moderator, { role: 'moderator', guildId: 10, serverId: 100, targetUserId: 6 }), false);
  assert.equal(canGrantRole(moderator, { role: 'player', guildId: 10, serverId: 100, targetUserId: 6 }), true);
  assert.equal(canGrantRole(moderator, { role: 'player', guildId: 10, serverId: 101, targetUserId: 6 }), false);
  assert.equal(canGrantRole(player, { role: 'moderator', guildId: 10, serverId: 100, targetUserId: 7 }), false);
  assert.equal(canGrantRole(guildAdmin, { role: 'moderator', guildId: 11, serverId: 100, targetUserId: 8 }), false);

  assert.equal(canRemoveRole(guildOwner, { role: 'guild_admin', guildId: 10, targetUserId: 8 }), true);
  assert.equal(canRemoveRole(serverAdmin, { role: 'moderator', guildId: 10, serverId: 100, targetUserId: 8 }), true);
  assert.equal(canRemoveRole(moderator, { role: 'admin', guildId: 10, serverId: 100, targetUserId: 5 }), false);
  assert.equal(canRemoveRole(moderator, { role: 'player', guildId: 10, serverId: 100, targetUserId: 5 }), true);
}

function testGlobalAdminMiddlewareSupportsExplicitPlatformRoles() {
  const { ensureAdmin } = require('../middleware/auth');
  let advanced = false;
  ensureAdmin(
    { isAuthenticated: () => true, user: { platform_role: 'dashboard_owner', is_admin: 0 } },
    {},
    () => { advanced = true; }
  );
  assert.strictEqual(advanced, true, 'explicit Dashboard Owner should pass global Admin middleware');
}

async function testDiscordSetupQualification() {
  const {
    isEligibleInitialGuildOwner,
    getDiscordSetupPermission,
    canRegisterExistingGuildToken,
    ensureAuthoritativeInitialGuildOwner,
    selectInitialGuildOwner,
  } = require('../bot/services/guildSetupService');
  assert.equal(isEligibleInitialGuildOwner({ isGuildOwner: true, hasAdministrator: false }), true);
  assert.equal(isEligibleInitialGuildOwner({ isGuildOwner: false, hasAdministrator: true }), true);
  assert.equal(isEligibleInitialGuildOwner({ isGuildOwner: false, hasAdministrator: false }), false);
  const fetched = [];
  const fetchedGuilds = [];
  const permission = await getDiscordSetupPermission({
    user: { id: 'user-1' },
    guild: {
      id: 'guild-1',
      ownerId: 'stale-owner',
      members: { fetch: async options => {
        throw new Error(`cached guild member manager must not be used: ${options.user}`);
      } },
    },
    client: {
      guilds: {
        fetch: async options => {
          fetchedGuilds.push(options);
          return {
            id: 'guild-1',
            ownerId: 'owner-2',
            members: { fetch: async memberOptions => {
              fetched.push(memberOptions);
              if (memberOptions.user === 'owner-2') {
                return { user: { id: 'owner-2', username: 'Owner', avatar: 'avatar' } };
              }
              return { user: { id: 'user-1' }, permissions: { has: () => true } };
            } },
          };
        },
      },
    },
  });
  assert.deepStrictEqual(fetchedGuilds, [
    { guild: 'guild-1', force: true, cache: false },
  ], 'setup authorization must refresh the guild before trusting its owner ID');
  assert.deepStrictEqual(fetched, [
    { user: 'user-1', force: true, cache: false },
    { user: 'owner-2', force: true, cache: false },
  ], 'setup authorization must force-fetch the actor and authoritative owner server-side');
  assert.equal(permission.hasAdministrator, true);
  assert.deepStrictEqual(selectInitialGuildOwner(permission), {
    discordId: 'owner-2', username: 'Owner', avatar: 'avatar',
  }, 'a Discord Administrator setup must still assign the authoritative Discord guild owner');
  assert.equal(canRegisterExistingGuildToken('owner', 1), true);
  assert.equal(canRegisterExistingGuildToken('admin', 1), true);
  assert.equal(canRegisterExistingGuildToken(null, 1), false, 'Discord permission alone must not overwrite an established tenant token');
  assert.equal(canRegisterExistingGuildToken('owner', 2), false, 'ambiguous multiple-owner guilds require reconciliation');
  assert.equal(isEligibleInitialGuildOwner(null), false);

  const ownerQueries = [];
  const ownerClient = {
    async query(sql, params) {
      ownerQueries.push({ sql, params });
      if (sql.includes('INSERT INTO users')) return { rows: [{ id: 77 }], rowCount: 1 };
      if (sql.includes('INSERT INTO guild_roles')) return { rows: [{ user_id: 77 }], rowCount: 1 };
      if (sql.includes("gr.role = 'owner'")) {
        return { rows: [{ user_id: 77, discord_id: 'owner-2' }], rowCount: 1 };
      }
      throw new Error(`unexpected owner query: ${sql}`);
    },
  };
  const ownerUserId = await ensureAuthoritativeInitialGuildOwner(ownerClient, {
    guildId: 10,
    actorUserId: 11,
    owner: permission.authoritativeOwner,
    assignIfMissing: true,
  });
  assert.equal(ownerUserId, 77);
  const roleUpsert = ownerQueries.find(entry => entry.sql.includes('INSERT INTO guild_roles'));
  assert(roleUpsert.sql.includes('ON CONFLICT (guild_id, user_id) DO UPDATE SET'),
    'an existing admin role for the Discord owner must be promoted rather than ignored');
  assert(roleUpsert.sql.includes("role = EXCLUDED.role"));

  const mismatchClient = {
    async query(sql) {
      if (sql.includes("gr.role = 'owner'")) {
        return { rows: [{ user_id: 88, discord_id: 'former-owner' }], rowCount: 1 };
      }
      throw new Error('owner assignment must not run when an owner already exists');
    },
  };
  await assert.rejects(
    ensureAuthoritativeInitialGuildOwner(mismatchClient, {
      guildId: 10,
      actorUserId: 11,
      owner: permission.authoritativeOwner,
      assignIfMissing: false,
    }),
    /authoritative Discord guild owner/
  );
}

async function testConfiguredDashboardOwnerBootstrap() {
  const {
    configuredDashboardOwnerId,
    isConfiguredDashboardOwner,
  } = require('../utils/configuredDashboardOwner');
  const { reconcileConfiguredDashboardOwner } = require('../services/dashboardOwnerBootstrapService');
  const { bootstrapConfiguredDashboardOwner } = require('../bot/services/dashboardOwnerBootstrapService');
  const bootstrapSource = read('services/dashboardOwnerBootstrapService.js');
  assert(bootstrapSource.includes("jsonb_build_object('guildDiscordId', $2::text"),
    'Dashboard Owner bootstrap audit metadata must type its Discord guild ID parameter for PostgreSQL');
  const configuredId = '900000000000000006';
  assert.equal(configuredDashboardOwnerId(configuredId), configuredId);
  assert.equal(configuredDashboardOwnerId('invalid'), null);
  assert.equal(isConfiguredDashboardOwner(configuredId, configuredId), true);
  assert.equal(isConfiguredDashboardOwner('900000000000000001', configuredId), false);
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes("platform_role = 'dashboard_owner'") && sql.includes('FOR UPDATE')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO users')) return { rows: [{ id: 44 }], rowCount: 1 };
      if (sql.includes("UPDATE users SET platform_role = 'dashboard_owner'")) return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO security_audit_events')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const db = { connect: async () => client };
  const fetchedIds = [];
  const guild = {
    id: '900000000000000002',
    name: 'Configured Owner Guild',
    members: {
      fetch: async options => {
        fetchedIds.push(options);
        return { user: { id: options.user, username: 'Configured Owner', avatar: 'avatar' } };
      },
    },
  };

  const result = await bootstrapConfiguredDashboardOwner(guild, db, configuredId);
  assert.equal(result.status, 'assigned');
  assert.deepStrictEqual(fetchedIds, [{ user: configuredId, force: true, cache: false }],
    'configured owner must be resolved through a forced authoritative Discord membership fetch');
  assert(queries.some(entry => entry.sql.includes('pg_advisory_xact_lock')),
    'configured Dashboard Owner bootstrap must serialize owner creation');
  assert(queries.some(entry => entry.sql.includes("UPDATE users SET platform_role = 'dashboard_owner'")),
    'configured Discord owner was not granted the Dashboard Owner role');

  const absent = await bootstrapConfiguredDashboardOwner({
    ...guild,
    members: { fetch: async () => { throw new Error('Unknown Member'); } },
  }, db, configuredId);
  assert.equal(absent.status, 'not_member',
    'configured owner must not be created from an ID alone when absent from the Discord guild');

  const websiteResult = await reconcileConfiguredDashboardOwner(db, {
    discordId: configuredId,
    username: 'OAuth Owner',
    avatar: null,
  }, { configuredDiscordId: configuredId, source: 'discord_oauth' });
  assert.equal(websiteResult.status, 'assigned',
    'trusted Discord OAuth identity must bootstrap the configured owner without the bot');
  assert.equal(await reconcileConfiguredDashboardOwner(db, {
    discordId: '900000000000000001', username: 'Other User', avatar: null,
  }, { configuredDiscordId: configuredId, source: 'discord_oauth' }).then(value => value.status), 'not_configured_owner',
  'an authenticated user whose immutable Discord ID does not match the environment must not bootstrap');

  const conflictQueries = [];
  const conflictDb = { connect: async () => ({
    async query(sql) {
      conflictQueries.push(sql);
      if (sql.includes("platform_role = 'dashboard_owner'") && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: 99, discord_id: '900000000000000001' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  }) };
  const conflict = await reconcileConfiguredDashboardOwner(conflictDb, {
    discordId: configuredId, username: 'Replacement', avatar: null,
  }, { configuredDiscordId: configuredId, source: 'discord_oauth' });
  assert.equal(conflict.status, 'owner_conflict');
  assert.equal(conflictQueries.some(sql => sql.includes('INSERT INTO users')), false,
    'changing the environment owner must not silently transfer ownership');

  const existingQueries = [];
  const existingDb = { connect: async () => ({
    async query(sql) {
      existingQueries.push(sql);
      if (sql.includes("platform_role = 'dashboard_owner'") && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: 44, discord_id: configuredId }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO users')) return { rows: [{ id: 44 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  }) };
  const existing = await reconcileConfiguredDashboardOwner(existingDb, {
    discordId: configuredId, username: 'Existing Owner', avatar: null,
  }, { configuredDiscordId: configuredId, source: 'discord_oauth' });
  assert.equal(existing.status, 'existing');
  assert.equal(existingQueries.some(sql => sql.includes('INSERT INTO security_audit_events')), false,
    'idempotent owner reconciliation must not emit a duplicate grant audit event');

  await assert.rejects(
    reconcileConfiguredDashboardOwner(db, {
      discordId: configuredId, username: 'Untrusted', avatar: null,
    }, { configuredDiscordId: configuredId, source: 'frontend_request' }),
    /trusted Discord identity source/
  );
}

function testHealthClassifiersAndStaleness() {
  const { classifyGameServerStatus, classifyNitradoError, applyStaleness } = require('../services/serverHealthService');
  assert.deepStrictEqual(classifyGameServerStatus({ status: 'started', query: { player_current: 2 } }),
    { state: 'healthy', detail: 'online' });
  assert.deepStrictEqual(classifyGameServerStatus({ status: 'restarting' }),
    { state: 'degraded', detail: 'starting' });
  assert.deepStrictEqual(classifyGameServerStatus({ status: 'stopped' }),
    { state: 'offline', detail: 'offline' });
  assert.deepStrictEqual(classifyGameServerStatus({}), { state: 'unknown', detail: 'unknown' });
  assert.equal(classifyNitradoError({ statusCode: 401 }).detail, 'authentication_error');
  assert.equal(classifyNitradoError({ statusCode: 429 }).detail, 'rate_limited');
  assert.equal(classifyNitradoError({ statusCode: 503 }).state, 'offline');
  assert.equal(applyStaleness({ state: 'healthy', checkedAt: new Date(Date.now() - 20 * 60 * 1000) }, 10 * 60 * 1000).stale, true);
}

function testRequiredSecurityContractsExist() {
  const roleRoute = read('routes/roleManagement.js');
  const roleService = read('services/roleManagementService.js');
  const roleLocks = read('utils/roleMutationLocks.js');
  const healthRoute = read('routes/health.js');
  const healthMonitor = read('bot/services/serverHealthMonitor.js');
  const registerToken = read('bot/commands/register-token.js');
  assert(registerToken.includes("jsonb_build_object('discordGuildOwner', $4::boolean, 'discordAdministrator', $5::boolean)"),
    'Token registration audit metadata must type boolean parameters for PostgreSQL');
  const reconciliation = read('bot/services/guildOwnershipReconciliationService.js');
  const ready = read('bot/events/ready.js');
  const guildCreate = read('bot/events/guildCreate.js');
  const migration = read('db/migrations/055_admin_rbac_health.js');
  const userRemovalMigration = read('db/migrations/056_user_removal_history_fks.js');
  const schema = read('db/schema-v2.js');
  const adminRoute = read('routes/admin.js');
  const setAdmin = read('scripts/set-admin.js');
  const envExample = read('.env.example');
  const envValidator = read('utils/envValidator.js');
  const configuredOwner = read('utils/configuredDashboardOwner.js');
  const passportMiddleware = read('src/app/registerMiddleware.js');
  const oauthUserService = read('services/discordOAuthUserService.js');

  for (const fragment of [
    'resolveActorAuthority',
    'canGrantRole',
    'canRemoveRole',
    'security_audit_events',
    'guild_id = ?',
    'server_id = ?',
    'transfer-owner',
    'FOR UPDATE',
  ]) assert(roleRoute.includes(fragment), `role API missing ${fragment}`);
  assert(roleRoute.includes('ROLE_CONFLICT') && roleRoute.includes('LAST_GUILD_ADMIN'),
    'role API lacks duplicate-role and final-guild-administrator invariants');
  assert(roleRoute.includes('lockUserRoleMutations') &&
    roleLocks.includes('ACTOR_ROLE_LOCK_NAMESPACE = 2147483001') &&
    roleLocks.includes('.sort((left, right) => left - right)'),
    'role mutations do not share the deterministic actor/target advisory-lock layer');
  assert(!roleRoute.includes('UPDATE guilds SET approved_by = NULL') &&
    !roleRoute.includes('UPDATE guilds SET disabled_by = NULL') &&
    !roleRoute.includes('UPDATE guild_roles SET assigned_by = NULL'),
  'user removal still takes late historical-reference locks instead of relying on SET NULL foreign keys');
  assert((roleRoute.match(/lockAuthority: true/g) || []).length >= 3 &&
    roleService.includes('SELECT id, platform_role, is_admin FROM users WHERE id = ?') &&
    roleService.includes('WHERE guild_id = ? AND user_id = ?${lockClause}') &&
    roleService.includes("status = 'active'${lockClause}"),
  'role mutations must lock/re-check platform, guild, and server authority at operation time');
  assert((roleRoute.match(/lockScope: true/g) || []).length >= 3 &&
    roleRoute.includes('FOR UPDATE OF s, g') &&
    roleRoute.includes("status IN ('pending', 'approved')${lockClause}"),
  'role mutations must lock/re-check exact guild/server lifecycle state at operation time');

  for (const fragment of [
    'server_health_status',
    'req.user.id',
    'guild_roles',
    'server_role_assignments',
    'server_player_memberships',
    "s.status = 'active'",
    "g.status = 'approved'",
  ]) assert(healthRoute.includes(fragment), `health API missing ${fragment}`);
  assert(healthMonitor.includes('getRawGameserver(token, server.platform_server_id)'),
    'health monitor must use the hardened Nitrado service with token-first argument order');
  assert(healthMonitor.includes('requested_at <= $2') &&
    !healthMonitor.includes("DELETE FROM server_health_refresh_requests');"),
  'health monitor can delete refresh requests that arrived during a running check');

  assert(registerToken.includes('isEligibleInitialGuildOwner'), 'register-token does not use authoritative setup qualification');
  assert(registerToken.includes('pg_advisory_xact_lock'), 'register-token lacks serialized initial-owner setup');
  assert(registerToken.includes("if (guildStatus === 'pending' || ownerlessGuild)"),
    'approved guilds with an in-progress ownerless setup cannot recover through authoritative token registration');
  assert(registerToken.includes("action, result"), 'initial setup does not create a security audit event');
  const setupProgression = registerToken.slice(
    registerToken.indexOf('INSERT INTO guild_setup_state', registerToken.indexOf('// Bootstrap only an ownerless guild')),
    registerToken.indexOf('INSERT INTO security_audit_events')
  );
  assert(setupProgression.includes('ON CONFLICT (guild_id) DO UPDATE SET') &&
    setupProgression.includes('current_step = EXCLUDED.current_step') &&
    setupProgression.includes('completed_steps = EXCLUDED.completed_steps') &&
    setupProgression.includes('updated_by_user_id = EXCLUDED.updated_by_user_id') &&
    setupProgression.includes('updated_at = EXCLUDED.updated_at') &&
    setupProgression.includes('last_error = NULL') &&
    setupProgression.includes("guild_setup_state.status = 'in_progress'") &&
    setupProgression.includes("guild_setup_state.current_step IN ('discord_connected', 'initial_owner_verified', 'nitrado_connected')"),
  'successful token registration must advance an existing Discord-connected setup state');
  assert(reconciliation.includes('owner_not_in_discord') && reconciliation.includes('owner_missing_discord_permission'),
    'existing guild ownership reconciliation does not verify Discord membership and permission');
  assert(reconciliation.includes('issue_code') && reconciliation.includes("status = 'resolved'"),
    'ownership reconciliation service does not match the reconciliation schema');
  assert(!reconciliation.includes("role = 'owner'\n"), 'reconciliation must not silently assign ownership');
  assert(ready.includes('startGuildOwnershipReconciliation'), 'bot does not run ownership reconciliation');
  assert(ready.includes('bootstrapConfiguredDashboardOwner') &&
    guildCreate.includes('bootstrapConfiguredDashboardOwner'),
  'configured Dashboard Owner is not bootstrapped on initial join and idempotently on bot startup');
  assert(envExample.includes('DASHBOARD_OWNER_DISCORD_ID') &&
    envValidator.includes('configuredDashboardOwnerId') &&
    configuredOwner.includes("DASHBOARD_OWNER_ENV = 'DASHBOARD_OWNER_DISCORD_ID'"),
  'configured Dashboard Owner Discord ID is not documented and validated');
  assert(passportMiddleware.includes('reconcileConfiguredDashboardOwner') &&
    passportMiddleware.includes('discord_oauth'),
  'website Discord OAuth does not reconcile the configured Dashboard Owner');
  assert(passportMiddleware.includes('upsertDiscordOAuthUser') &&
    oauthUserService.includes('ON CONFLICT (discord_id) DO UPDATE SET'),
    'website OAuth user creation must be atomic with concurrent bot/website owner bootstrap');
  assert(migration.includes('platform_role'), 'global dashboard role schema is missing');
  assert(migration.includes('server_health_status'), 'server health cache schema is missing');
  assert(migration.includes('guild_ownership_reconciliation'), 'existing-guild reconciliation schema is missing');
  assert(setAdmin.includes('--role') && setAdmin.includes('platform_role'),
    'explicit out-of-band Dashboard Owner/Admin reconciliation is missing');
  assert(migration.includes('users_one_dashboard_owner_idx') && migration.includes("platform_role = 'dashboard_owner'"),
    'database does not enforce a singleton Dashboard Owner');
  assert(migration.includes('enforce_single_guild_owner') && migration.includes('guild_roles_single_owner_guard'),
    'database does not serialize and enforce one owner per Discord guild');
  for (const column of ['approved_by', 'disabled_by', 'assigned_by', 'user_id', 'exempted_by']) {
    assert(userRemovalMigration.includes(column), `user-removal migration does not cover ${column}`);
  }
  assert(userRemovalMigration.includes("replaceForeignKeys(pool, 'ON DELETE SET NULL')"),
    'user-removal migration must preserve all legacy historical references with ON DELETE SET NULL');
  assert(userRemovalMigration.includes('pg_constraint') &&
    userRemovalMigration.includes('pg_attribute') &&
    userRemovalMigration.includes('confrelid'),
  'user-removal migration must discover historical foreign keys independent of constraint names');
  for (const fragment of [
    'FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL',
    'FOREIGN KEY (disabled_by) REFERENCES users(id) ON DELETE SET NULL',
    'FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL',
    'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL',
    'FOREIGN KEY (exempted_by) REFERENCES users(id) ON DELETE SET NULL',
  ]) assert(schema.includes(fragment), `fresh schema lacks ${fragment}`);
  assert(setAdmin.includes("pg_advisory_xact_lock(hashtext('dashboard_owner'))"),
    'Dashboard Owner changes are not serialized when the owner set is initially empty');
  assert(setAdmin.includes('Cannot unset the Dashboard Owner; use --transfer-owner'),
    'CLI can remove the final Dashboard Owner without an explicit transfer');
  assert(setAdmin.includes('A Discord ID is required when creating a new user'),
    'CLI still attempts to create fresh users without the schema-required Discord ID');
  assert(adminRoute.includes("'guild_setup_state'"),
    'tracked-data reset can delete an in-progress guild setup state');

  const promote = adminRoute.slice(adminRoute.indexOf("router.post('/users/:userId/promote'"), adminRoute.indexOf("router.post('/users/:userId/demote'"));
  assert(!promote.includes('UPDATE users SET is_admin = 1'), 'legacy promote endpoint still permits peer global-admin grants');
  const reportMutations = adminRoute.slice(adminRoute.indexOf("router.post('/reports/:id/resolve'"));
  assert(reportMutations.includes("AND status = 'open'") && reportMutations.includes('REPORT_RESOLVED'),
    'Admin report transitions are not concurrency-safe and audited');
  const guildLifecycle = adminRoute.slice(adminRoute.indexOf("router.post('/guilds/:guildId/approve'"), adminRoute.indexOf("router.get('/overview/stats'"));
  assert(guildLifecycle.includes("WHERE discord_guild_id = ? AND status = 'pending'") &&
    guildLifecycle.includes("WHERE discord_guild_id = ? AND status = 'disabled'"),
  'Admin guild lifecycle transitions are not conditional/concurrency-safe');
}

function testAdminFrontendContracts() {
  const users = read('public/js/admin-users.js');
  const servers = read('public/js/admin-servers.js');
  const index = read('public/js/admin-index.js');
  assert(users.includes('/api/roles/'), 'Admin users page does not use scoped role-management API');
  assert(users.includes('availableGrants'), 'Admin users page does not filter role choices server-side');
  assert(users.includes('Remove Role'), 'Admin users page lacks role-removal UX');
  assert(users.includes('transfer-owner'), 'Admin users page lacks explicit guild ownership transfer UX');
  assert(users.includes('targetUserId: selectedUser.id'), 'ownership transfer UI payload does not match the API');
  assert(users.includes("roleContext.actor?.platformRole === 'dashboard_owner'") && users.includes('kick-user-btn'),
    'Admin users page must expose account removal only to the Dashboard Owner');
  assert(users.includes("method: 'DELETE'") && users.includes('/api/roles/users/'),
    'Admin users page kick action does not call the owner-only user removal API');
  assert(users.includes('This removes their dashboard account, roles, links, private app data, and active sessions'),
    'Admin users page lacks an explicit destructive account-removal warning');
  assert(servers.includes('/api/health/servers'), 'Admin servers page does not load authorized cached health');
  assert(servers.includes('healthFilter'), 'Admin servers page lacks health filtering');
  assert(index.includes('/api/health/guilds'), 'Admin overview lacks authorized guild health summaries');
}

async function testOnboardingRateLimitIsolation() {
  const express = require('express');
  const http = require('http');
  const {
    apiLimiter,
    apiMutationLimiter,
    onboardingLimiter,
  } = require('../middleware/rateLimiter');
  assert.equal(typeof onboardingLimiter, 'function', 'onboarding endpoints need a dedicated limiter');

  const routeRegistration = read('src/app/registerRoutes.js');
  assert(routeRegistration.includes("app.use('/admin/*', apiLimiter, ensureAuthenticated, ensureAdmin)"),
    'read-only descendant admin HTML pages must apply the general read limiter before authorization');
  assert(routeRegistration.includes("app.get('/admin', apiLimiter, ensureAuthenticated, ensureAdmin"),
    'the exact admin root must apply the general read limiter before authorization');
  assert(!routeRegistration.includes("app.use('/admin/*', strictLimiter"),
    'admin HTML navigation must not exhaust the sensitive-operation limiter');
  assert.equal((routeRegistration.match(/app\.get\('\/api\/config', onboardingLimiter/g) || []).length, 1,
    'public config must use the dedicated onboarding limiter exactly once');
  assert.equal((routeRegistration.match(/app\.get\('\/api\/access\/setup', onboardingLimiter/g) || []).length, 1,
    'only the exact setup-status GET must use the onboarding limiter');
  assert(!routeRegistration.includes("app.use('/api/feeds', apiLimiter"),
    'feeds must not double-count the globally mounted read limiter');
  assert(!routeRegistration.includes("app.use('/api/discord', apiLimiter"),
    'Discord APIs must not double-count the globally mounted read limiter');
  for (const routerPath of [
    'routes/admin.js',
    'routes/economy.js',
    'routes/lootFinder.js',
    'routes/mapHeatmap.js',
  ]) {
    assert(!/\bapiLimiter\b/.test(read(routerPath)),
      `${routerPath} must not double-count the globally mounted read limiter`);
  }
  const middlewareRegistration = read('src/app/registerMiddleware.js');
  assert(middlewareRegistration.includes("app.use('/api/', apiLimiter, apiMutationLimiter)"),
    'production APIs must mount independent read and mutation buckets');

  const app = express();
  app.use('/api/', apiLimiter, apiMutationLimiter);
  app.get('/api/other', (req, res) => res.json({ ok: true }));
  app.get('/api/config', onboardingLimiter, (req, res) => res.json({ ok: true }));
  app.get('/api/access/setup', onboardingLimiter, (req, res) => res.json({ ok: true }));
  app.all('/api/access/setup/child', (req, res) => res.json({ ok: true }));
  app.post('/api/access/setup', (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = (pathName, method = 'GET') => new Promise((resolve, reject) => {
    const requestHandle = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: pathName,
      method,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        response.body = body;
        resolve(response);
      });
    });
    requestHandle.on('error', reject);
    requestHandle.end();
  });

  try {
    const config = await request('/api/config');
    assert.equal(config.statusCode, 200);
    assert.equal(config.headers['ratelimit-limit'], '120');
    const firstGeneral = await request('/api/other');
    assert.equal(firstGeneral.statusCode, 200);
    assert.equal(firstGeneral.headers['ratelimit-limit'], '600',
      'normal dashboard polling needs a usable general API budget');
    for (let index = 1; index < 600; index += 1) {
      const response = await request('/api/other');
      assert.equal(response.statusCode, 200);
    }
    const exhausted = await request('/api/other');
    assert.equal(exhausted.statusCode, 429, 'general API bucket should be exhausted');
    assert.match(exhausted.headers['content-type'] || '', /^application\/json\b/,
      'API rate-limit responses must remain JSON for browser response parsing');
    assert.equal(JSON.parse(exhausted.body).error,
      'Too many requests from this IP, please try again later.');
    const setup = await request('/api/access/setup');
    assert.equal(setup.statusCode, 200,
      'ordinary API traffic must not exhaust the setup-status bucket');
    const setupWithTrailingSlash = await request('/api/access/setup/');
    assert.equal(setupWithTrailingSlash.statusCode, 200,
      'the equivalent trailing-slash setup URL must use only the onboarding bucket');
    const setupWithQuery = await request('/api/access/setup?refresh=1');
    assert.equal(setupWithQuery.statusCode, 200,
      'setup query strings must use only the onboarding bucket');
    assert.equal((await request('/API/ACCESS/SETUP')).statusCode, 200,
      'case-equivalent setup routes must use only the onboarding bucket');
    assert.equal((await request('/api/access/setup', 'HEAD')).statusCode, 200,
      'HEAD setup requests handled by the GET route must use only the onboarding bucket');
    const configWithQuery = await request('/api/config?refresh=1');
    assert.equal(configWithQuery.statusCode, 200,
      'public config query strings must use only the onboarding bucket');
    assert.equal((await request('/api/access/setup/child')).statusCode, 429,
      'descendant setup paths must not bypass the general API bucket');
    assert.equal((await request('/api/access/setup//')).statusCode, 429,
      'unmatched repeated-slash setup paths must not bypass the general API bucket');
    assert.equal((await request('/api/config//')).statusCode, 429,
      'unmatched repeated-slash config paths must not bypass the general API bucket');
    const firstMutation = await request('/api/access/setup', 'POST');
    assert.equal(firstMutation.statusCode, 200);
    assert.equal(firstMutation.headers['ratelimit-limit'], '100',
      'mutations must retain a lower independent API budget');
    for (let index = 1; index < 100; index += 1) {
      assert.equal((await request('/api/access/setup', 'POST')).statusCode, 200);
    }
    assert.equal((await request('/api/access/setup', 'POST')).statusCode, 429,
      'non-GET setup requests must be limited by the mutation bucket');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testCasinoStrictLimiterReturnsJson() {
  const express = require('express');
  const http = require('http');
  const { strictLimiter } = require('../middleware/rateLimiter');

  const casinoRoutes = read('routes/casino.js');
  assert(casinoRoutes.includes("router.post('/play/slots', strictLimiter"),
    'casino play routes must use the strict limiter');

  const app = express();
  app.post('/api/casino/play/slots', strictLimiter, (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = () => new Promise((resolve, reject) => {
    const requestHandle = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: '/api/casino/play/slots',
      method: 'POST',
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ response, body }));
    });
    requestHandle.on('error', reject);
    requestHandle.end();
  });

  try {
    for (let index = 0; index < 10; index += 1) {
      const { response } = await request();
      assert.equal(response.statusCode, 200);
    }
    const { response, body } = await request();
    assert.equal(response.statusCode, 429, 'casino strict limiter should be exhausted');
    assert.match(response.headers['content-type'] || '', /^application\/json\b/,
      'casino rate-limit responses must remain JSON for browser response parsing');
    assert.deepStrictEqual(JSON.parse(body), { error: 'Too many requests, please slow down.' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  testRoleGrantPolicy();
  testGlobalAdminMiddlewareSupportsExplicitPlatformRoles();
  await testDiscordSetupQualification();
  await testConfiguredDashboardOwnerBootstrap();
  testHealthClassifiersAndStaleness();
  testRequiredSecurityContractsExist();
  testAdminFrontendContracts();
  await testOnboardingRateLimitIsolation();
  await testCasinoStrictLimiterReturnsJson();
  console.log('✅ Admin RBAC, setup, health, and isolation tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
