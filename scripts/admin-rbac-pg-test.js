'use strict';

const assert = require('assert');
const express = require('express');
const http = require('http');
const { Pool } = require('pg');
const { resolveActorAuthority } = require('../services/roleManagementService');
const { upsertDiscordOAuthUser } = require('../services/discordOAuthUserService');
const { reconcileConfiguredDashboardOwner } = require('../services/dashboardOwnerBootstrapService');
const roleRoutes = require('../routes/roleManagement');

function adapter(client) {
  return {
    async get(sql, params = []) {
      const result = await client.query(sql.replace(/\?/g, (_match, offset) => {
        const before = sql.slice(0, offset);
        return `$${(before.match(/\?/g) || []).length + 1}`;
      }), params);
      return result.rows[0] || null;
    },
  };
}

function routeAdapter(pool, options = {}) {
  const convert = sql => {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  };
  const forClient = client => ({
    async get(sql, params = []) {
      const result = await client.query(convert(sql), params);
      if (options.afterQuery) await options.afterQuery(sql, params, result);
      return result.rows[0] || null;
    },
    async query(sql, params = []) {
      const result = await client.query(convert(sql), params);
      if (options.afterQuery) await options.afterQuery(sql, params, result);
      return result.rows;
    },
    async run(sql, params = []) {
      const result = await client.query(convert(sql), params);
      return { changes: result.rowCount };
    },
  });
  return {
    ...forClient(pool),
    async transaction(callback) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback(forClient(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, method, path,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      }, res => {
        res.resume();
        res.on('end', () => { server.close(); resolve(res.statusCode); });
      });
      req.on('error', error => { server.close(); reject(error); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

async function expectUniqueViolation(promise, message) {
  try {
    await promise;
    assert.fail(message);
  } catch (error) {
    assert.equal(error.code, '23505', message);
  }
}

async function main() {
  const database = process.env.ADMIN_RBAC_PG_TEST_DATABASE;
  if (!database || !/(?:^|[-_])test$/i.test(database)) {
    throw new Error('ADMIN_RBAC_PG_TEST_DATABASE must name a dedicated database ending in -test or _test');
  }

  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT || 5432),
    database,
    user: process.env.POSTGRES_USER || 'dayz-dashboard',
    password: process.env.POSTGRES_PASSWORD,
    ssl: process.env.POSTGRES_SSL === 'true'
      ? { rejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED !== 'false' }
      : false,
  });

  const suffix = `${Date.now()}-${process.pid}`;
  const discordIds = [`rbac-owner-a-${suffix}`, `rbac-owner-b-${suffix}`];
  const configuredOwnerDiscordId = (
    (BigInt(Date.now()) * 100000n) + BigInt(process.pid % 100000)
  ).toString();
  let userIds = [];
  let guildId = null;
  let kickTargetId = null;
  let kickTargetDiscordId = null;
  let raceGuildId = null;
  let roleLockServerId = null;
  let raceTargetId = null;
  let raceTargetDiscordId = null;
  let releaseKickRoleLock = null;
  let raceKick = null;
  let concurrentTransfer = null;
  let createdSessionTable = false;
  const first = await pool.connect();
  const second = await pool.connect();

  try {
    const sessionTable = await pool.query("SELECT to_regclass('public.session') AS table_name");
    createdSessionTable = !sessionTable.rows[0].table_name;
    if (createdSessionTable) {
      await pool.query(`
        CREATE TABLE session (
          sid VARCHAR NOT NULL PRIMARY KEY,
          sess JSON NOT NULL,
          expire TIMESTAMPTZ NOT NULL
        )
      `);
    }
    await pool.query(`
      ALTER TABLE guilds
        DROP CONSTRAINT IF EXISTS guilds_approvedby_fkey,
        ADD CONSTRAINT guilds_approvedby_fkey
        FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE NO ACTION
    `);
    await require('../db/migrations/056_user_removal_history_fks').up(pool);
    const historicalForeignKeys = await pool.query(
      `WITH expected(table_name, column_name) AS (VALUES
         ('guilds', 'approved_by'),
         ('guilds', 'disabled_by'),
         ('guild_roles', 'assigned_by'),
         ('audit_log', 'user_id'),
         ('alt_ban_exemptions', 'exempted_by')
       )
       SELECT expected.table_name,
              expected.column_name,
              COUNT(constraint_row.oid)::int AS constraint_count,
              COUNT(constraint_row.oid) FILTER (WHERE constraint_row.confdeltype <> 'n')::int AS mismatched_count
         FROM expected
         JOIN pg_class table_row ON table_row.relname = expected.table_name
         JOIN pg_namespace namespace_row
           ON namespace_row.oid = table_row.relnamespace AND namespace_row.nspname = 'public'
         JOIN pg_attribute column_row
           ON column_row.attrelid = table_row.oid AND column_row.attname = expected.column_name
         LEFT JOIN pg_constraint constraint_row
           ON constraint_row.conrelid = table_row.oid
          AND constraint_row.contype = 'f'
          AND constraint_row.confrelid = 'users'::regclass
          AND constraint_row.conkey = ARRAY[column_row.attnum]::smallint[]
        GROUP BY expected.table_name, expected.column_name
        ORDER BY expected.table_name, expected.column_name`
    );
    assert.equal(historicalForeignKeys.rows.length, 5);
    for (const foreignKey of historicalForeignKeys.rows) {
      assert.equal(foreignKey.constraint_count, 1,
        `${foreignKey.table_name}.${foreignKey.column_name} must have exactly one user foreign key`);
      assert.equal(foreignKey.mismatched_count, 0,
        `${foreignKey.table_name}.${foreignKey.column_name} must use ON DELETE SET NULL`);
    }

    const inserted = await pool.query(
      `INSERT INTO users (discord_id, username)
       VALUES ($1, 'RBAC A'), ($2, 'RBAC B')
       RETURNING id`,
      discordIds
    );
    userIds = inserted.rows.map(row => row.id);

    await first.query('BEGIN');
    await second.query('BEGIN');
    await first.query("UPDATE users SET platform_role = 'dashboard_owner', is_admin = 1 WHERE id = $1", [userIds[0]]);
    const competingOwnerViolation = expectUniqueViolation(
      second.query(
        "UPDATE users SET platform_role = 'dashboard_owner', is_admin = 1 WHERE id = $1",
        [userIds[1]]
      ),
      'database must reject concurrent Dashboard Owner creation'
    );
    await first.query('COMMIT');
    await competingOwnerViolation;
    await second.query('ROLLBACK');

    await pool.query("UPDATE users SET platform_role = NULL, is_admin = 0 WHERE id = ANY($1::int[])", [userIds]);
    const guild = await pool.query(
      `INSERT INTO guilds (discord_guild_id, name, status)
       VALUES ($1, 'RBAC Test Guild', 'pending')
       RETURNING id`,
      [`rbac-guild-${suffix}`]
    );
    guildId = guild.rows[0].id;

    await first.query('BEGIN');
    await second.query('BEGIN');
    await first.query(
      "INSERT INTO guild_roles (guild_id, user_id, role, assigned_by) VALUES ($1, $2, 'owner', $2)",
      [guildId, userIds[0]]
    );
    const competingGuildOwnerViolation = expectUniqueViolation(
      second.query(
        "INSERT INTO guild_roles (guild_id, user_id, role, assigned_by) VALUES ($1, $2, 'owner', $2)",
        [guildId, userIds[1]]
      ),
      'database must reject concurrent guild owner creation'
    );
    await first.query('COMMIT');
    await competingGuildOwnerViolation;
    await second.query('ROLLBACK');

    await first.query('BEGIN');
    const lockedAuthority = await resolveActorAuthority(
      adapter(first),
      { id: userIds[0] },
      { guildId },
      { lockAuthority: true }
    );
    assert.equal(lockedAuthority.guildRole, 'owner');
    await second.query('BEGIN');
    const concurrentRevocation = second.query(
      "DELETE FROM guild_roles WHERE guild_id = $1 AND user_id = $2 AND role = 'owner'",
      [guildId, userIds[0]]
    );
    const blocked = await Promise.race([
      concurrentRevocation.then(() => false),
      new Promise(resolve => setTimeout(() => resolve(true), 100)),
    ]);
    assert.equal(blocked, true, 'operation-time authority lock must block concurrent revocation');
    await first.query('COMMIT');
    const revoked = await concurrentRevocation;
    assert.equal(revoked.rowCount, 1);
    await second.query('COMMIT');

    await pool.query(
      "UPDATE users SET platform_role = 'dashboard_owner', is_admin = 1 WHERE id = $1",
      [userIds[0]]
    );
    const lockOrderServer = await pool.query(
      `INSERT INTO servers (guild_id, name, platform, platform_server_id, status)
       VALUES ($1, $2, 'xbox', $3, 'active')
       RETURNING id`,
      [guildId, `RBAC Lock Order Server ${suffix}`, `rbac-lock-${suffix}`]
    );
    roleLockServerId = lockOrderServer.rows[0].id;
    const lockOrderAssignment = await pool.query(
      `INSERT INTO server_role_assignments (server_id, guild_id, user_id, role, status)
       VALUES ($1, $2, $3, 'moderator', 'active')
       RETURNING id`,
      [roleLockServerId, guildId, userIds[1]]
    );

    let reportAssignmentDiscovered;
    const assignmentDiscovered = new Promise(resolve => { reportAssignmentDiscovered = resolve; });
    const removalApp = express();
    removalApp.use(express.json());
    removalApp.use((req, _res, next) => {
      req.isAuthenticated = () => true;
      req.user = { id: userIds[0], platform_role: 'dashboard_owner', is_admin: 1 };
      req.app.locals.db = routeAdapter(pool, {
        afterQuery: async sql => {
          if (sql.includes('FROM server_role_assignments') && !sql.includes('FOR UPDATE')) {
            reportAssignmentDiscovered();
          }
        },
      });
      next();
    });
    removalApp.use('/api', roleRoutes);

    await first.query('BEGIN');
    await first.query("SET LOCAL lock_timeout = '2s'");
    await first.query(
      `SELECT s.id
         FROM servers s JOIN guilds g ON g.id = s.guild_id
        WHERE s.id = $1
        FOR UPDATE OF g, s`,
      [roleLockServerId]
    );
    const concurrentRoleRemoval = request(
      removalApp,
      'DELETE',
      `/api/users/${userIds[1]}/roles/${lockOrderAssignment.rows[0].id}`,
      { assignmentType: 'server' }
    );
    await Promise.race([
      assignmentDiscovered,
      new Promise((_, reject) => setTimeout(() => reject(new Error('role removal did not discover assignment')), 2000)),
    ]);
    await new Promise(resolve => setTimeout(resolve, 100));
    const shopEvidenceLock = await first.query(
      `SELECT id FROM server_role_assignments
        WHERE id = $1 AND server_id = $2 AND status = 'active'
        FOR UPDATE`,
      [lockOrderAssignment.rows[0].id, roleLockServerId]
    );
    assert.equal(shopEvidenceLock.rowCount, 1,
      'shop-style parent-first locking must acquire authority evidence without deadlocking role removal');
    await first.query('COMMIT');
    assert.equal(await concurrentRoleRemoval, 204,
      'role removal must complete after the parent-first shop-style transaction releases its locks');
    const revokedAssignment = await pool.query(
      'SELECT status FROM server_role_assignments WHERE id = $1',
      [lockOrderAssignment.rows[0].id]
    );
    assert.equal(revokedAssignment.rows[0].status, 'revoked');
    await pool.query(
      'UPDATE users SET platform_role = NULL, is_admin = 0 WHERE id = $1',
      [userIds[0]]
    );

    await first.query('BEGIN');
    await first.query(
      `SELECT id FROM guilds
        WHERE id = $1 AND status IN ('pending', 'approved')
        FOR UPDATE`,
      [guildId]
    );
    await second.query('BEGIN');
    const concurrentDisable = second.query(
      "UPDATE guilds SET status = 'disabled' WHERE id = $1",
      [guildId]
    );
    const disableBlocked = await Promise.race([
      concurrentDisable.then(() => false),
      new Promise(resolve => setTimeout(() => resolve(true), 100)),
    ]);
    assert.equal(disableBlocked, true, 'operation-time scope lock must block concurrent guild disable');
    await first.query('COMMIT');
    const disabled = await concurrentDisable;
    assert.equal(disabled.rowCount, 1);
    await second.query('COMMIT');

    const reconciliationColumns = await pool.query(
      `SELECT issue_code, status, resolved_by_user_id
         FROM guild_ownership_reconciliation
        WHERE false`
    );
    assert.deepStrictEqual(reconciliationColumns.fields.map(field => field.name),
      ['issue_code', 'status', 'resolved_by_user_id']);

    const oauthIdentity = {
      discordId: configuredOwnerDiscordId,
      username: 'Concurrent OAuth Owner',
      avatar: 'oauth-avatar',
    };
    const botIdentity = {
      discordId: configuredOwnerDiscordId,
      username: 'Concurrent Bot Owner',
      avatar: 'bot-avatar',
    };
    const [oauthResult, botResult] = await Promise.all([
      (async () => {
        await upsertDiscordOAuthUser(adapter(pool), oauthIdentity);
        return reconcileConfiguredDashboardOwner(pool, oauthIdentity, {
          configuredDiscordId: configuredOwnerDiscordId,
          source: 'discord_oauth',
        });
      })(),
      reconcileConfiguredDashboardOwner(pool, botIdentity, {
        configuredDiscordId: configuredOwnerDiscordId,
        source: 'discord_guild_membership',
        guildDiscordId: `concurrent-guild-${suffix}`,
      }),
    ]);
    assert.deepStrictEqual(
      [oauthResult.status, botResult.status].sort(),
      ['assigned', 'existing'],
      'simultaneous OAuth and bot bootstrap must assign exactly one owner idempotently'
    );

    const concurrentOwner = await pool.query(
      `SELECT id, platform_role, is_admin
         FROM users
        WHERE discord_id = $1`,
      [configuredOwnerDiscordId]
    );
    assert.equal(concurrentOwner.rowCount, 1, 'concurrent bootstrap must create one user');
    assert.equal(concurrentOwner.rows[0].platform_role, 'dashboard_owner');
    assert.equal(concurrentOwner.rows[0].is_admin, 1);

    const concurrentAudit = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM security_audit_events
        WHERE action = 'platform_role.bootstrap_env'
          AND target_type = 'user'
          AND target_id = $1`,
      [String(concurrentOwner.rows[0].id)]
    );
    assert.equal(concurrentAudit.rows[0].count, 1, 'concurrent bootstrap must create one audit event');

    kickTargetDiscordId = `rbac-kick-target-${suffix}`;
    const kickTarget = await pool.query(
      `INSERT INTO users (discord_id, username)
       VALUES ($1, 'RBAC Kick Target')
       RETURNING id`,
      [kickTargetDiscordId]
    );
    kickTargetId = kickTarget.rows[0].id;
    await pool.query(
      `INSERT INTO session (sid, sess, expire)
       VALUES ($1, $2::json, NOW() + INTERVAL '1 hour')`,
      [`rbac-kick-session-${suffix}`, JSON.stringify({ passport: { user: kickTargetDiscordId } })]
    );
    await pool.query(
      `INSERT INTO sessions (sid, sess, expire)
       VALUES ($1, $2, $3)`,
      [`rbac-kick-legacy-${suffix}`, JSON.stringify({ passport: { user: kickTargetDiscordId } }), Date.now() + 3600000]
    );

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.isAuthenticated = () => true;
      req.user = { id: concurrentOwner.rows[0].id, platform_role: 'dashboard_owner', is_admin: 1 };
      req.app.locals.db = routeAdapter(pool);
      next();
    });
    app.use('/api', roleRoutes);

    raceTargetDiscordId = `rbac-kick-race-target-${suffix}`;
    const raceTarget = await pool.query(
      `INSERT INTO users (discord_id, username)
       VALUES ($1, 'RBAC Kick Race Target')
       RETURNING id`,
      [raceTargetDiscordId]
    );
    raceTargetId = raceTarget.rows[0].id;
    const raceGuild = await pool.query(
      `INSERT INTO guilds (discord_guild_id, name, status)
       VALUES ($1, 'RBAC Kick Race Guild', 'pending')
       RETURNING id`,
      [`rbac-kick-race-guild-${suffix}`]
    );
    raceGuildId = raceGuild.rows[0].id;
    await pool.query(
      'UPDATE guilds SET approved_by = $1, disabled_by = $1 WHERE id = $2',
      [raceTargetId, raceGuildId]
    );
    await pool.query(
      `INSERT INTO guild_roles (guild_id, user_id, role, assigned_by)
       VALUES ($1, $2, 'owner', $3), ($1, $3, 'admin', $2)`,
      [raceGuildId, userIds[0], raceTargetId]
    );

    let reportKickRoleLock;
    const kickRoleLockHeld = new Promise(resolve => { reportKickRoleLock = resolve; });
    const holdKickRoleLock = new Promise(resolve => { releaseKickRoleLock = resolve; });
    const raceKickApp = express();
    raceKickApp.use(express.json());
    raceKickApp.use((req, _res, next) => {
      req.isAuthenticated = () => true;
      req.user = { id: concurrentOwner.rows[0].id, platform_role: 'dashboard_owner', is_admin: 1 };
      req.app.locals.db = routeAdapter(pool, {
        afterQuery: async (sql, params) => {
          if (sql.includes('SELECT guild_id, role') && sql.includes('FROM guild_roles') &&
              Number(params[0]) === raceTargetId) {
            reportKickRoleLock();
            await holdKickRoleLock;
          }
        },
      });
      next();
    });
    raceKickApp.use('/api', roleRoutes);

    raceKick = request(raceKickApp, 'DELETE', `/api/users/${raceTargetId}`);
    await Promise.race([
      kickRoleLockHeld,
      new Promise((_, reject) => setTimeout(() => reject(new Error('kick did not acquire target role lock')), 2000)),
    ]);
    concurrentTransfer = request(
      app,
      'POST',
      `/api/guilds/${raceGuildId}/transfer-owner`,
      { targetUserId: raceTargetId }
    );
    const transferBlocked = await Promise.race([
      concurrentTransfer.then(() => false),
      new Promise(resolve => setTimeout(() => resolve(true), 100)),
    ]);
    assert.equal(transferBlocked, true, 'ownership transfer must block behind the kick target role lock');
    releaseKickRoleLock();
    assert.equal(await raceKick, 204, 'kick must complete while a transfer waits on the target role');
    assert.equal(await concurrentTransfer, 400, 'waiting transfer must revalidate the deleted target as ineligible');

    const raceState = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM users WHERE id = $1) AS target_users,
         (SELECT COUNT(*)::int FROM guild_roles WHERE guild_id = $2 AND user_id = $3 AND role = 'owner') AS original_owners,
         (SELECT COUNT(*)::int FROM guild_roles WHERE guild_id = $2 AND role = 'owner') AS total_owners`,
      [raceTargetId, raceGuildId, userIds[0]]
    );
    assert.deepStrictEqual(raceState.rows[0], { target_users: 0, original_owners: 1, total_owners: 1 },
      'concurrent transfer versus kick must retain exactly the original guild owner');

    const kickStatus = await request(app, 'DELETE', `/api/users/${kickTargetId}`);
    assert.equal(kickStatus, 204, 'Dashboard Owner kick route must succeed against PostgreSQL');

    const removedState = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM users WHERE id = $1) AS users,
         (SELECT COUNT(*)::int FROM session WHERE sess::jsonb #>> '{passport,user}' = $2) AS sessions,
         (SELECT COUNT(*)::int FROM sessions WHERE sess::jsonb #>> '{passport,user}' = $2) AS legacy_sessions,
         (SELECT COUNT(*)::int FROM security_audit_events
           WHERE action = 'user.kicked' AND target_type = 'user' AND target_id = $1::text) AS audits`,
      [kickTargetId, kickTargetDiscordId]
    );
    assert.deepStrictEqual(removedState.rows[0], { users: 0, sessions: 0, legacy_sessions: 0, audits: 1 },
      'kick must atomically remove the user and sessions while retaining its audit event');

    console.log('✅ PostgreSQL Admin RBAC race and schema tests passed');
  } finally {
    if (releaseKickRoleLock) releaseKickRoleLock();
    await Promise.allSettled([raceKick, concurrentTransfer].filter(Boolean));
    await first.query('ROLLBACK').catch(() => {});
    await second.query('ROLLBACK').catch(() => {});
    first.release();
    second.release();
    if (guildId) await pool.query('DELETE FROM guilds WHERE id = $1', [guildId]).catch(() => {});
    if (raceGuildId) await pool.query('DELETE FROM guilds WHERE id = $1', [raceGuildId]);
    await pool.query(
      `DELETE FROM security_audit_events
        WHERE action = 'platform_role.bootstrap_env'
          AND target_type = 'user'
          AND target_id IN (
            SELECT id::text FROM users WHERE discord_id = $1
          )`,
      [configuredOwnerDiscordId]
    );
    await pool.query('DELETE FROM users WHERE discord_id = $1', [configuredOwnerDiscordId]);
    if (kickTargetId) {
      await pool.query(
        "DELETE FROM security_audit_events WHERE action = 'user.kicked' AND target_id = $1",
        [String(kickTargetId)]
      ).catch(() => {});
    }
    if (raceTargetId) {
      await pool.query(
        "DELETE FROM security_audit_events WHERE action = 'user.kicked' AND target_id = $1",
        [String(raceTargetId)]
      );
    }
    if (raceTargetDiscordId) {
      await pool.query('DELETE FROM users WHERE discord_id = $1', [raceTargetDiscordId]);
    }
    if (kickTargetDiscordId) {
      await pool.query("DELETE FROM session WHERE sess::jsonb #>> '{passport,user}' = $1", [kickTargetDiscordId]).catch(() => {});
      await pool.query("DELETE FROM sessions WHERE sess::jsonb #>> '{passport,user}' = $1", [kickTargetDiscordId]).catch(() => {});
      await pool.query('DELETE FROM users WHERE discord_id = $1', [kickTargetDiscordId]).catch(() => {});
    }
    if (userIds.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]).catch(() => {});
    if (createdSessionTable) await pool.query('DROP TABLE session');
    await pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
