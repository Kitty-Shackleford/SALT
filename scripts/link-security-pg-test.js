'use strict';

const assert = require('assert');
const { Client, Pool } = require('pg');
const { mutateBotLinkSettings } = require('../bot/utils/linkSettings');
const { ensureUsersAndLockRoleMutations } = require('../bot/commands/link-admin');
const { lockActiveLinkTenant } = require('../bot/commands/link');
const { assertCheckoutAuthority } = require('../services/shopFileService');
const { lockAndVerifyLinkSettingsManager } = require('../services/linkSettingsAuthorization');
const { lockPgUserRoleMutations } = require('../utils/roleMutationLocks');
const migration057 = require('../db/migrations/057_player_link_verification_modes');

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function connection(database) {
  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT || 5432),
    database,
    user: process.env.POSTGRES_USER || 'dayz-dashboard',
    password: process.env.POSTGRES_PASSWORD,
    ssl: process.env.POSTGRES_SSL === 'true'
      ? { rejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : false,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function webDb(client) {
  return {
    async get(sql, params = []) {
      let index = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++index}`);
      const result = await client.query(pgSql, params);
      return result.rows[0];
    },
  };
}

async function expectCheckViolation(pool, method) {
  await assert.rejects(
    pool.query(
      `INSERT INTO server_player_memberships
        (server_id, guild_id, identity_id, user_id, source_link_id, verification_method, status)
       VALUES (1, 1, 1, 1, 1, $1, 'active')`,
      [method]
    ),
    error => error.code === '23514'
  );
}

async function createFixture(pool) {
  await pool.query(`
    CREATE TABLE users (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      discord_id TEXT NOT NULL UNIQUE,
      username TEXT,
      avatar TEXT
    );
    CREATE TABLE guilds (
      id INTEGER PRIMARY KEY,
      discord_guild_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL
    );
    CREATE TABLE servers (
      id INTEGER PRIMARY KEY,
      guild_id INTEGER NOT NULL REFERENCES guilds(id),
      status TEXT NOT NULL
    );
    CREATE TABLE guild_roles (
      guild_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      role TEXT NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE server_role_assignments (
      server_id INTEGER NOT NULL,
      guild_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (server_id, user_id)
    );
    CREATE TABLE server_features (
      server_id INTEGER NOT NULL,
      feature_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (server_id, feature_name)
    );
    CREATE TABLE discord_link_role_policy_history (
      server_id INTEGER NOT NULL,
      role_id TEXT NOT NULL,
      last_managed_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (server_id, role_id)
    );
    CREATE TABLE linked_accounts (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      identity_id INTEGER NOT NULL UNIQUE,
      verified_by_guild_id INTEGER REFERENCES guilds(id),
      verification_method TEXT NOT NULL,
      UNIQUE (id, user_id, identity_id)
    );
    CREATE TABLE server_player_memberships (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      server_id INTEGER NOT NULL,
      guild_id INTEGER NOT NULL,
      identity_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_link_id INTEGER NOT NULL,
      verification_method TEXT NOT NULL,
      status TEXT NOT NULL,
      UNIQUE (server_id, identity_id),
      FOREIGN KEY (source_link_id, user_id, identity_id)
        REFERENCES linked_accounts(id, user_id, identity_id) ON DELETE CASCADE,
      CONSTRAINT legacy_verification_check CHECK (
        verification_method IN ('emote_challenge', 'admin_approved', 'existing_verified_link')
      )
    );
    CREATE TABLE discord_role_reconciliation_jobs (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      discord_guild_id TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_attempt_at TIMESTAMPTZ,
      last_error TEXT,
      completed_at TIMESTAMPTZ,
      locked_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ,
      generation INTEGER NOT NULL,
      UNIQUE (discord_guild_id, discord_user_id, user_id)
    );
    CREATE TABLE security_audit_events (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      actor_user_id INTEGER,
      guild_id INTEGER,
      server_id INTEGER,
      action TEXT NOT NULL,
      result TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    INSERT INTO guilds (id, discord_guild_id, status)
      VALUES (1, '900000000000000002', 'approved');
    INSERT INTO servers (id, guild_id, status)
      VALUES (1, 1, 'active'), (2, 1, 'active');
    INSERT INTO users (discord_id, username)
      VALUES
        ('900000000000000003', 'operator-one'),
        ('900000000000000001', 'operator-two'),
        ('900000000000000004', 'link-deletion-target');
    INSERT INTO guild_roles (guild_id, user_id, role)
      SELECT 1, id, 'admin' FROM users
       WHERE discord_id IN ('900000000000000003', '900000000000000001');
    INSERT INTO linked_accounts
      (id, user_id, identity_id, verified_by_guild_id, verification_method)
      SELECT 1, id, 1, 1, 'emote_challenge'
        FROM users WHERE discord_id = '900000000000000003';
    INSERT INTO linked_accounts
      (id, user_id, identity_id, verified_by_guild_id, verification_method)
      SELECT 700, id, 700, 1, 'emote_challenge'
        FROM users WHERE discord_id = '900000000000000003';
    INSERT INTO server_player_memberships
      (server_id, guild_id, identity_id, user_id, source_link_id, verification_method, status)
      SELECT 1, 1, 700, id, 700, 'emote_challenge', 'active'
        FROM users WHERE discord_id = '900000000000000003';
    INSERT INTO linked_accounts
      (id, user_id, identity_id, verified_by_guild_id, verification_method)
      SELECT 701, id, 701, 1, 'emote_challenge'
        FROM users WHERE discord_id = '900000000000000004';
    INSERT INTO server_player_memberships
      (server_id, guild_id, identity_id, user_id, source_link_id, verification_method, status)
      SELECT 1, 1, 701, id, 701, 'emote_challenge', 'active'
        FROM users WHERE discord_id = '900000000000000004';
    INSERT INTO discord_role_reconciliation_jobs
      (discord_guild_id, discord_user_id, user_id, status, attempts, generation)
      SELECT '900000000000000002', discord_id, id, 'pending', 0, 1
        FROM users WHERE discord_id = '900000000000000004';
    INSERT INTO server_features (server_id, feature_name, enabled, config)
      VALUES
        (1, 'player_linking', 1, '{"verificationMode":"open","roles":{"assignOnJoin":[],"assignOnLink":["900000000000000010"],"removeOnLink":[],"removeOnLeave":[]}}'),
        (2, 'player_linking', 1, '{"verificationMode":"open","roles":{"assignOnJoin":[],"assignOnLink":[],"removeOnLink":[],"removeOnLeave":[]}}');
  `);
}

function mutation(pool, serverId, change, resolver, actorDiscordId = '900000000000000003') {
  return mutateBotLinkSettings(pool, {
    serverId,
    discordGuildId: '900000000000000002',
    actor: {
      discordId: actorDiscordId,
      username: actorDiscordId === '900000000000000003' ? 'operator-one' : 'operator-two',
      avatar: null,
    },
    resolveNativePermissions: resolver || (async () => ({ administrator: false, manageRoles: true })),
    change,
    runRoleJob: async () => {},
  });
}

async function testConcurrentSettings(pool) {
  const entered = deferred();
  const release = deferred();
  const restrictive = mutation(pool, 1, { type: 'verification', mode: 'admin_approval' }, async () => {
    entered.resolve();
    await release.promise;
    return { administrator: false, manageRoles: true };
  });
  await entered.promise;
  const roleUpdate = mutation(pool, 1, {
    type: 'role', operation: 'add', roleKey: 'assignOnLink', roleId: '900000000000000011',
  }, undefined, '900000000000000001');
  const blocked = await Promise.race([
    roleUpdate.then(() => false),
    new Promise(resolve => setTimeout(() => resolve(true), 100)),
  ]);
  assert.equal(blocked, true, 'concurrent settings mutation must block behind PostgreSQL locks');
  release.resolve();
  await Promise.all([restrictive, roleUpdate]);
  const state = await pool.query(
    "SELECT config FROM server_features WHERE server_id = 1 AND feature_name = 'player_linking'"
  );
  assert.equal(state.rows[0].config.verificationMode, 'admin_approval',
    'later role mutation must preserve the restrictive mode from its locked current row');
  assert.deepStrictEqual(
    [...state.rows[0].config.roles.assignOnLink].sort(),
    ['900000000000000010', '900000000000000011']
  );
}

async function testAuthorityRevocation(pool) {
  const entered = deferred();
  const release = deferred();
  const attempt = mutation(pool, 1, { type: 'verification', mode: 'emote' }, async () => {
    entered.resolve();
    await release.promise;
    return { administrator: false, manageRoles: false };
  });
  await entered.promise;
  await pool.query(
    `DELETE FROM guild_roles
      WHERE guild_id = 1 AND user_id = (
        SELECT id FROM users WHERE discord_id = '900000000000000003'
      )`
  );
  release.resolve();
  await assert.rejects(attempt, error => error.code === 'AUTHORITY_REVOKED');
  const state = await pool.query(
    "SELECT config FROM server_features WHERE server_id = 1 AND feature_name = 'player_linking'"
  );
  assert.equal(state.rows[0].config.verificationMode, 'admin_approval');
  await pool.query(
    `INSERT INTO guild_roles (guild_id, user_id, role)
     SELECT 1, id, 'admin' FROM users WHERE discord_id = '900000000000000003'`
  );
}

async function testSiblingPolicySerialization(pool) {
  const entered = deferred();
  const release = deferred();
  const assign = mutation(pool, 1, {
    type: 'role', operation: 'add', roleKey: 'assignOnLink', roleId: '900000000000000012',
  }, async () => {
    entered.resolve();
    await release.promise;
    return { administrator: false, manageRoles: true };
  });
  await entered.promise;
  const remove = mutation(pool, 2, {
    type: 'role', operation: 'add', roleKey: 'removeOnLink', roleId: '900000000000000012',
  }, undefined, '900000000000000001');
  const blocked = await Promise.race([
    remove.then(() => false, () => false),
    new Promise(resolve => setTimeout(() => resolve(true), 100)),
  ]);
  assert.equal(blocked, true,
    'sibling-server settings mutation must block behind the shared guild policy lock');
  release.resolve();
  await assign;
  await assert.rejects(
    remove,
    error => error.code === 'CONTRADICTORY_LINK_ROLE_RULES'
  );
  const sibling = await pool.query(
    "SELECT config FROM server_features WHERE server_id = 2 AND feature_name = 'player_linking'"
  );
  assert.deepStrictEqual(sibling.rows[0].config.roles.removeOnLink, []);
}

async function testReversedMissingUserResolutionDoesNotDeadlock(pool) {
  const actor = { discordId: '900000000000000005', username: 'new-actor' };
  const target = { discordId: '900000000000000006', username: 'new-target' };
  async function resolve(profiles) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await ensureUsersAndLockRoleMutations(client, profiles);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  await Promise.all([
    resolve([actor, target]),
    resolve([target, actor]),
  ]);
  const users = await pool.query(
    'SELECT discord_id FROM users WHERE discord_id = ANY($1::TEXT[]) ORDER BY discord_id',
    [[target.discordId, actor.discordId]]
  );
  assert.deepStrictEqual(users.rows.map(row => row.discord_id), [target.discordId, actor.discordId]);
}

async function testDashboardSettingsSerializesWithRoleRevocation(pool) {
  const actor = await pool.query(
    "SELECT id FROM users WHERE discord_id = '900000000000000003'"
  );
  const actorUserId = actor.rows[0].id;
  const entered = deferred();
  const release = deferred();
  const dashboard = (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const scope = await lockAndVerifyLinkSettingsManager(webDb(client), actorUserId, 1);
      assert.deepStrictEqual(scope, { id: 1, guild_id: 1 });
      entered.resolve();
      await release.promise;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  })();
  await entered.promise;
  const revocation = (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await lockPgUserRoleMutations(client, [actorUserId]);
      await client.query(
        'DELETE FROM guild_roles WHERE guild_id = $1 AND user_id = $2',
        [1, actorUserId]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  })();
  const blocked = await Promise.race([
    revocation.then(() => false),
    new Promise(resolve => setTimeout(() => resolve(true), 100)),
  ]);
  assert.equal(blocked, true,
    'role revocation must serialize behind the dashboard settings actor lock');
  release.resolve();
  await Promise.all([dashboard, revocation]);
  await pool.query(
    "INSERT INTO guild_roles (guild_id, user_id, role) VALUES (1, $1, 'admin')",
    [actorUserId]
  );
}

async function testShopAndPlayerLinkUseParentFirstLockOrder(pool) {
  const userResult = await pool.query(
    "SELECT id FROM users WHERE discord_id = '900000000000000003'"
  );
  const userId = userResult.rows[0].id;
  const shopClient = await pool.connect();
  const linkClient = await pool.connect();
  let linkParentLock;
  try {
    await shopClient.query('BEGIN');
    await linkClient.query('BEGIN');
    await shopClient.query("SET LOCAL lock_timeout = '2s'");
    await linkClient.query("SET LOCAL lock_timeout = '2s'");
    await shopClient.query(
      `SELECT s.id
         FROM guilds g
         JOIN servers s ON s.guild_id = g.id
        WHERE s.id = 1 AND s.guild_id = 1
        FOR UPDATE OF g, s`
    );

    linkParentLock = lockActiveLinkTenant(linkClient, 1, 1);
    const linkWaitedForParent = await Promise.race([
      linkParentLock.then(() => false),
      new Promise(resolve => setTimeout(() => resolve(true), 100)),
    ]);
    assert.equal(linkWaitedForParent, true,
      'player link must wait on the tenant parent before locking ownership proof');

    await assertCheckoutAuthority(
      webDb(shopClient),
      { identity_id: 700, server_id: 1 },
      userId
    );
    await shopClient.query('COMMIT');

    await withTimeout(linkParentLock, 2000,
      'player link did not acquire the tenant parent after shop authorization committed');
    await linkClient.query(
      'SELECT id FROM linked_accounts WHERE identity_id = 700 FOR UPDATE'
    );
    await linkClient.query(
      `SELECT id FROM server_player_memberships
        WHERE server_id = 1 AND identity_id = 700 FOR UPDATE`
    );
    await linkClient.query('COMMIT');
  } finally {
    await shopClient.query('ROLLBACK').catch(() => {});
    await linkClient.query('ROLLBACK').catch(() => {});
    await Promise.resolve(linkParentLock).catch(() => {});
    shopClient.release();
    linkClient.release();
  }
}

async function testPlayerLinkSerializesWithGlobalUserDeletion(pool) {
  const targetResult = await pool.query(
    "SELECT id FROM users WHERE discord_id = '900000000000000004'"
  );
  const targetUserId = targetResult.rows[0].id;
  const deletionClient = await pool.connect();
  const linkClient = await pool.connect();
  let linkLock;
  try {
    await deletionClient.query('BEGIN');
    await linkClient.query('BEGIN');
    await deletionClient.query("SET LOCAL lock_timeout = '2s'");
    await deletionClient.query("SET LOCAL statement_timeout = '3s'");
    await linkClient.query("SET LOCAL lock_timeout = '2s'");
    await linkClient.query("SET LOCAL statement_timeout = '3s'");

    await lockPgUserRoleMutations(deletionClient, [targetUserId]);
    linkLock = lockPgUserRoleMutations(linkClient, [targetUserId]);
    const linkWaitedForUserDeletion = await Promise.race([
      linkLock.then(() => false),
      new Promise(resolve => setTimeout(() => resolve(true), 100)),
    ]);
    assert.equal(linkWaitedForUserDeletion, true,
      'ordinary player link must wait on the same user lock as global deletion');

    const deleted = await deletionClient.query(
      'DELETE FROM users WHERE id = $1 RETURNING id',
      [targetUserId]
    );
    assert.equal(deleted.rowCount, 1,
      'global deletion must complete its linked-account, membership, and reconciliation cascades');
    await deletionClient.query('COMMIT');

    await withTimeout(linkLock, 2000,
      'player link did not acquire the user lock after global deletion committed');
    const remaining = await linkClient.query(
      'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      [targetUserId]
    );
    assert.equal(remaining.rowCount, 0,
      'link transaction must observe that the serialized user was deleted');
    await linkClient.query('ROLLBACK');
  } finally {
    await deletionClient.query('ROLLBACK').catch(() => {});
    await linkClient.query('ROLLBACK').catch(() => {});
    await Promise.resolve(linkLock).catch(() => {});
    deletionClient.release();
    linkClient.release();
  }
}

async function testMigration057(pool) {
  await expectCheckViolation(pool, 'self_asserted');
  const migrationClient = await pool.connect();
  try {
    await migrationClient.query('BEGIN');
    await migration057.up(migrationClient);
    await migrationClient.query('COMMIT');
  } catch (error) {
    await migrationClient.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    migrationClient.release();
  }
  await pool.query(
    `INSERT INTO server_player_memberships
      (server_id, guild_id, identity_id, user_id, source_link_id, verification_method, status)
     VALUES (1, 1, 1, 1, 1, 'self_asserted', 'active')`
  );
  const constraints = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'server_player_memberships'
        AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%verification_method%'`
  );
  assert.equal(constraints.rows[0].count, 1);
  await assert.rejects(migration057.down(pool), /Cannot remove open-link provenance/);
  await pool.query("DELETE FROM server_player_memberships WHERE verification_method = 'self_asserted'");
  const downClient = await pool.connect();
  try {
    await downClient.query('BEGIN');
    await migration057.down(downClient);
    await downClient.query('COMMIT');
  } catch (error) {
    await downClient.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    downClient.release();
  }
  await expectCheckViolation(pool, 'self_asserted');
  const rerunClient = await pool.connect();
  try {
    await rerunClient.query('BEGIN');
    await migration057.up(rerunClient);
    await migration057.up(rerunClient);
    await rerunClient.query('COMMIT');
  } catch (error) {
    await rerunClient.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    rerunClient.release();
  }
}

async function main() {
  const adminDatabase = process.env.POSTGRES_ADMIN_DATABASE || 'postgres';
  const database = `dayz_link_security_${Date.now()}_${process.pid}_test`;
  const admin = new Client(connection(adminDatabase));
  let pool;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
    pool = new Pool(connection(database));
    await createFixture(pool);
    await testConcurrentSettings(pool);
    await testAuthorityRevocation(pool);
    await testSiblingPolicySerialization(pool);
    await testReversedMissingUserResolutionDoesNotDeadlock(pool);
    await testDashboardSettingsSerializesWithRoleRevocation(pool);
    await testShopAndPlayerLinkUseParentFirstLockOrder(pool);
    await testPlayerLinkSerializesWithGlobalUserDeletion(pool);
    await testMigration057(pool);
    const audits = await pool.query(
      "SELECT COUNT(*)::int AS count FROM security_audit_events WHERE action = 'player_link.settings_changed'"
    );
    assert.ok(audits.rows[0].count >= 3, 'successful bot settings changes must be audited');
    console.log('✅ Disposable PostgreSQL link security concurrency and migration tests passed');
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`).catch(error => {
      console.error(`Failed to drop disposable test database: ${error.message}`);
      process.exitCode = 1;
    });
    await admin.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
