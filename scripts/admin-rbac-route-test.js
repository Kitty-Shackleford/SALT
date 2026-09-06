'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const roleRoutes = require('../routes/roleManagement');
const accessRoutes = require('../routes/access');
const healthRoutes = require('../routes/health');
const { ensureAuthenticated } = require('../middleware/auth');

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, method, path,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
          server.close();
          let body = null;
          if (text) {
            try { body = JSON.parse(text); } catch (_) { body = text; }
          }
          resolve({ status: res.statusCode, body });
        });
      });
      req.on('error', error => { server.close(); reject(error); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

function roleDb(actor) {
  return {
    async get(sql, params) {
      if (sql.includes('FROM users WHERE id')) return { id: Number(params[0]), username: 'Target', is_admin: 0 };
      if (sql.includes('FROM servers s')) return { id: Number(params[0]), guild_id: 20 };
      if (sql.includes('FROM guilds')) return { id: Number(params[0]), name: 'Guild B' };
      if (sql.includes('SELECT 1 FROM guild_roles') || sql.includes('SELECT 1 FROM server_role_assignments') || sql.includes('SELECT 1 FROM server_player_memberships')) return { allowed: 1 };
      if (sql.includes('SELECT role FROM guild_roles')) {
        return actor.guildId === Number(params[1]) ? { role: actor.guildRole } : null;
      }
      if (sql.includes('SELECT role FROM server_role_assignments')) {
        return actor.serverId === Number(params[1]) ? { role: actor.serverRole } : null;
      }
      return null;
    },
    async query() { return []; },
    async run() { throw new Error('denied requests must not mutate data'); },
    async transaction(callback) { return callback(this); },
  };
}

function appFor(router, user, db, options = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.isAuthenticated = () => Boolean(user);
    req.user = user;
    req.app.locals.db = db;
    if (options.verifyDiscordGuildMembership) {
      req.app.locals.verifyDiscordGuildMembership = options.verifyDiscordGuildMembership;
    }
    next();
  });
  app.use('/api', ensureAuthenticated, router);
  return app;
}

async function testRoleIdorAndEscalation() {
  let discordMemberGrantMutated = false;
  const discordMemberGrantDb = {
    async transaction(callback) {
      return callback({
        async get(sql, params) {
          if (sql.includes('pg_advisory_xact_lock')) return {};
          if (sql.includes('FROM users') && sql.includes('FOR UPDATE') && Number(params[0]) === 1) {
            return { id: 1, platform_role: 'dashboard_owner', is_admin: 1 };
          }
          if (sql.includes('FROM guilds')) {
            return { id: 20, discord_guild_id: '900000000000000001', name: 'Synthetic Test Guild' };
          }
          if (sql.includes('FROM users WHERE id') && Number(params[0]) === 8) {
            return { id: 8, discord_id: '900000000000000002' };
          }
          if (sql.includes('SELECT 1') && sql.includes('guild_roles')) return null;
          if (sql.includes('SELECT role FROM guild_roles')) return null;
          return null;
        },
        async run(sql) {
          if (sql.includes('INSERT INTO guild_roles')) discordMemberGrantMutated = true;
          return { changes: 1 };
        },
      });
    },
  };
  const verifiedDiscordMemberGrant = await request(
    appFor(
      roleRoutes,
      { id: 1, platform_role: 'dashboard_owner', is_admin: 1 },
      discordMemberGrantDb,
      { verifyDiscordGuildMembership: async (guildId, userId) =>
        guildId === '900000000000000001' && userId === '900000000000000002' }
    ),
    'POST', '/api/users/8', { role: 'guild_admin', guildId: 20 }
  );
  assert.equal(verifiedDiscordMemberGrant.status, 201,
    'an authoritative Discord guild member may receive their first scoped guild role');
  assert.equal(discordMemberGrantMutated, true,
    'verified Discord membership should permit the first guild role insert');

  const crossGuild = await request(
    appFor(roleRoutes, { id: 1, platform_role: null, is_admin: 0 }, roleDb({ guildId: 10, guildRole: 'admin' })),
    'POST', '/api/users/2', { role: 'moderator', guildId: 20, serverId: 200 }
  );
  assert.equal(crossGuild.status, 403, 'Guild A admin must not grant a Server B role');

  const moderator = await request(
    appFor(roleRoutes, { id: 1, platform_role: null, is_admin: 0 }, roleDb({ guildId: 20, guildRole: 'moderator' })),
    'POST', '/api/users/2', { role: 'guild_admin', guildId: 20 }
  );
  assert.equal(moderator.status, 403, 'moderator must not grant administrative roles');

  const selfEscalation = await request(
    appFor(roleRoutes, { id: 1, platform_role: 'dashboard_admin', is_admin: 1 }, roleDb({})),
    'POST', '/api/users/1', { role: 'dashboard_owner' }
  );
  assert.equal(selfEscalation.status, 403, 'Dashboard Admin must not grant self Dashboard Owner');

  const unauthenticated = await request(appFor(roleRoutes, null, roleDb({})), 'GET', '/api/context');
  assert.equal(unauthenticated.status, 401, 'unauthenticated role API request must be denied');

  let mutated = false;
  const forgedRemovalDb = {
    async get(sql) {
      if (sql.includes('FROM servers s JOIN guilds')) return { id: 100, guild_id: 10 };
      if (sql.includes('FROM server_role_assignments')) {
        return { id: 55, user_id: 2, guild_id: 10, server_id: 100, role: 'server_admin', status: 'active' };
      }
      if (sql.includes('FROM guilds g') && sql.includes('LEFT JOIN guild_roles')) return { id: 10, role: null };
      if (sql.includes('FROM servers s') && sql.includes('LEFT JOIN server_role_assignments')) {
        return { id: 100, role: 'admin', status: 'active' };
      }
      return null;
    },
    async transaction(callback) {
      return callback({
        get: this.get,
        async query() { return []; },
        async run() { mutated = true; return { changes: 1 }; },
      });
    },
  };
  const forgedRemoval = await request(
    appFor(roleRoutes, { id: 1, platform_role: null, is_admin: 0 }, forgedRemovalDb),
    'DELETE', '/api/users/2/roles/55',
    { assignmentType: 'server', role: 'moderator', guildId: 10, serverId: 100 }
  );
  assert.equal(forgedRemoval.status, 403,
    'server admin must not disguise a stored server-admin assignment as moderator removal');
  assert.equal(mutated, false, 'forged role removal must not mutate the assignment');

  const removalLockOrder = [];
  const orderedRemovalDb = {
    async transaction(callback) {
      return callback({
        async get(sql) {
          if (sql.includes('pg_advisory_xact_lock')) return {};
          if (sql.includes('FROM server_role_assignments')) {
            removalLockOrder.push(sql.includes('FOR UPDATE') ? 'assignment-lock' : 'assignment-discovery');
            return { id: 56, user_id: 2, guild_id: 10, server_id: 100, role: 'moderator', status: 'active' };
          }
          if (sql.includes('FROM servers s JOIN guilds')) {
            removalLockOrder.push('scope-lock');
            return { id: 100, guild_id: 10 };
          }
          if (sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
            return { id: 1, platform_role: 'dashboard_owner', is_admin: 1 };
          }
          return null;
        },
        async run(sql) {
          return { changes: sql.includes('UPDATE server_role_assignments') ? 1 : 0 };
        },
      });
    },
  };
  const orderedRemoval = await request(
    appFor(roleRoutes, { id: 1, platform_role: 'dashboard_owner', is_admin: 1 }, orderedRemovalDb),
    'DELETE', '/api/users/2/roles/56', { assignmentType: 'server' }
  );
  assert.equal(orderedRemoval.status, 204);
  assert.deepStrictEqual(
    removalLockOrder,
    ['assignment-discovery', 'scope-lock', 'assignment-lock'],
    'role removal must discover scope without locking, then lock the tenant parent before revocable evidence'
  );

  let staleGrantMutated = false;
  const staleGrantDb = {
    async get(sql) {
      if (sql.includes('FROM guilds g') && sql.includes('LEFT JOIN guild_roles')) return { id: 10, role: 'owner' };
      if (sql.includes('FROM guilds')) return { id: 10, name: 'Guild' };
      if (sql.includes('FROM users WHERE id')) return { id: 2 };
      if (sql.includes('SELECT 1') && sql.includes('guild_roles')) return { allowed: 1 };
      return null;
    },
    async transaction(callback) {
      return callback({
        async get(sql) {
          if (sql.includes('FROM guilds g') && sql.includes('LEFT JOIN guild_roles')) return { id: 10, role: null };
          if (sql.includes('FROM guilds')) return { id: 10, name: 'Guild' };
          if (sql.includes('FROM users WHERE id')) return { id: 2 };
          if (sql.includes('SELECT 1') && sql.includes('guild_roles')) return { allowed: 1 };
          return null;
        },
        async run() { staleGrantMutated = true; return { changes: 1 }; },
      });
    },
  };
  const staleGrant = await request(
    appFor(roleRoutes, { id: 1, platform_role: null, is_admin: 0 }, staleGrantDb),
    'POST', '/api/users/2', { role: 'guild_admin', guildId: 10 }
  );
  assert.equal(staleGrant.status, 403, 'role grant must re-check actor authority inside the write transaction');
  assert.equal(staleGrantMutated, false, 'revoked actor authority must prevent the grant mutation');

  let lockedAuthorityMutated = false;
  const lockedAuthorityDb = {
    async transaction(callback) {
      return callback({
        async get(sql, params) {
          if (sql.includes('FROM users') && sql.includes('FOR UPDATE') && Number(params[0]) === 1) {
            return { id: 1, platform_role: null, is_admin: 0 };
          }
          if (sql.includes('FROM guilds') && !sql.includes('guild_roles')) return { id: 10, name: 'Guild' };
          if (sql.includes('FROM guild_roles') && sql.includes('FOR UPDATE') && Number(params[1]) === 1) {
            return { role: 'owner' };
          }
          if (sql.includes('SELECT role FROM guild_roles') && Number(params[1]) === 2) return null;
          if (sql.includes('FROM users WHERE id') && Number(params[0]) === 2) return { id: 2 };
          if (sql.includes('SELECT 1') && sql.includes('guild_roles')) return { allowed: 1 };
          return null;
        },
        async run() { lockedAuthorityMutated = true; return { changes: 1 }; },
      });
    },
  };
  const lockedAuthorityGrant = await request(
    appFor(roleRoutes, { id: 1, platform_role: null, is_admin: 0 }, lockedAuthorityDb),
    'POST', '/api/users/2', { role: 'guild_admin', guildId: 10 }
  );
  assert.equal(lockedAuthorityGrant.status, 201,
    'role grant must use the locked database actor and locked exact-scope authority row');
  assert.equal(lockedAuthorityMutated, true, 'locked owner authority should permit the grant');

  let stalePlatformMutated = false;
  const stalePlatformDb = {
    async transaction(callback) {
      return callback({
        async get(sql, params) {
          if (sql.includes('FROM users') && sql.includes('FOR UPDATE') && Number(params[0]) === 1) {
            return { id: 1, platform_role: null, is_admin: 0 };
          }
          if (sql.includes('FROM guilds') && !sql.includes('guild_roles')) return { id: 10, name: 'Guild' };
          return null;
        },
        async run() { stalePlatformMutated = true; return { changes: 1 }; },
      });
    },
  };
  const stalePlatformGrant = await request(
    appFor(roleRoutes, { id: 1, platform_role: 'dashboard_owner', is_admin: 1 }, stalePlatformDb),
    'POST', '/api/users/2', { role: 'guild_admin', guildId: 10 }
  );
  assert.equal(stalePlatformGrant.status, 403,
    'role grant must reject stale session platform authority after database revocation');
  assert.equal(stalePlatformMutated, false, 'stale platform authority must not mutate roles');

  let staleTransferMutated = false;
  const staleTransferDb = {
    async get(sql) {
      if (sql.includes('FROM guilds g') && sql.includes('LEFT JOIN guild_roles')) return { id: 10, role: 'owner' };
      if (sql.includes('FROM guilds')) return { id: 10, name: 'Guild' };
      return null;
    },
    async transaction(callback) {
      return callback({
        async get(sql) {
          if (sql.includes('FROM guilds g') && sql.includes('LEFT JOIN guild_roles')) return { id: 10, role: null };
          if (sql.includes('FROM guilds')) return { id: 10, name: 'Guild' };
          if (sql.includes('SELECT 1') && sql.includes('guild_roles')) return { allowed: 1 };
          return null;
        },
        async query(sql) {
          if (sql.includes("role = 'owner'")) return [{ id: 1, user_id: 1 }];
          return [];
        },
        async run() { staleTransferMutated = true; return { changes: 1 }; },
      });
    },
  };
  const staleTransfer = await request(
    appFor(roleRoutes, { id: 1, platform_role: null, is_admin: 0 }, staleTransferDb),
    'POST', '/api/guilds/10/transfer-owner', { targetUserId: 2 }
  );
  assert.equal(staleTransfer.status, 403, 'ownership transfer must re-check owner authority after locking owners');
  assert.equal(staleTransferMutated, false, 'revoked owner authority must prevent ownership transfer');

  let ineligibleTransferMutated = false;
  const ineligibleTransferDb = {
    async transaction(callback) {
      return callback({
        async get(sql, params = []) {
          if (sql.includes('FROM users') && sql.includes('FOR UPDATE')) return { id: 1, platform_role: null, is_admin: 0 };
          if (sql.includes('FROM guilds') && !sql.includes('guild_roles')) return { id: 10, name: 'Guild' };
          if (sql.includes('FROM guild_roles') && sql.includes('FOR UPDATE') && Number(params[1]) === 1) return { role: 'owner' };
          if (sql.includes("role = 'admin' FOR UPDATE")) return null;
          return null;
        },
        async query(sql) {
          if (sql.includes("role = 'owner'")) return [{ id: 1, user_id: 1 }];
          return [];
        },
        async run() { ineligibleTransferMutated = true; return { changes: 1 }; },
      });
    },
  };
  const ineligibleTransfer = await request(
    appFor(roleRoutes, { id: 1, platform_role: null, is_admin: 0 }, ineligibleTransferDb),
    'POST', '/api/guilds/10/transfer-owner', { targetUserId: 2 }
  );
  assert.equal(ineligibleTransfer.status, 400, 'guild ownership may transfer only to an existing guild administrator');
  assert.equal(ineligibleTransferMutated, false, 'ineligible ownership target must not mutate roles');
}

async function testDashboardOwnerUserKick() {
  function kickDb({ storedActorRole = 'dashboard_owner', targetRole = null, targetIsGuildOwner = false, targetExists = true } = {}) {
    const operations = [];
    const queries = [];
    const db = {
      async transaction(callback) {
        return callback({
          async get(sql, params) {
            if (sql.includes('SELECT id, platform_role, is_admin FROM users') && sql.includes('FOR UPDATE')) {
              return { id: Number(params[0]), platform_role: storedActorRole, is_admin: storedActorRole ? 1 : 0 };
            }
            if (sql.includes('discord_id') && sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
              return targetExists
                ? { id: Number(params[0]), discord_id: 'target-discord', username: 'Target', platform_role: targetRole, is_admin: targetRole ? 1 : 0 }
                : null;
            }
            if (sql.includes('FROM guild_roles') && sql.includes("role = 'owner'")) {
              return targetIsGuildOwner ? { guild_id: 10 } : null;
            }
            return null;
          },
          async query(sql, params) {
            queries.push({ sql, params });
            if (sql.includes('FROM guild_roles') && sql.includes('FOR UPDATE')) {
              return targetIsGuildOwner ? [{ guild_id: 10, role: 'owner' }] : [];
            }
            return [];
          },
          async run(sql, params) {
            operations.push({ sql, params });
            return { changes: 1 };
          },
        });
      },
    };
    return { db, operations, queries };
  }

  const unauthenticated = await request(
    appFor(roleRoutes, null, kickDb().db),
    'DELETE', '/api/users/2'
  );
  assert.equal(unauthenticated.status, 401, 'unauthenticated user kick must be denied');

  const admin = kickDb({ storedActorRole: 'dashboard_admin' });
  const adminDenied = await request(
    appFor(roleRoutes, { id: 1, platform_role: 'dashboard_admin', is_admin: 1 }, admin.db),
    'DELETE', '/api/users/2'
  );
  assert.equal(adminDenied.status, 403, 'Dashboard Admin must not kick dashboard users');
  assert.equal(admin.operations.length, 0, 'denied Dashboard Admin kick must not mutate data');

  const stale = kickDb({ storedActorRole: null });
  const staleDenied = await request(
    appFor(roleRoutes, { id: 1, platform_role: 'dashboard_owner', is_admin: 1 }, stale.db),
    'DELETE', '/api/users/2'
  );
  assert.equal(staleDenied.status, 403, 'kick must re-check Dashboard Owner authority inside the transaction');
  assert.equal(stale.operations.length, 0, 'stale owner session must not mutate data');

  const self = kickDb();
  const selfDenied = await request(
    appFor(roleRoutes, { id: 1, platform_role: 'dashboard_owner', is_admin: 1 }, self.db),
    'DELETE', '/api/users/1'
  );
  assert.equal(selfDenied.status, 403, 'Dashboard Owner must not kick themselves');
  assert.equal(self.operations.length, 0, 'self-kick must not mutate data');

  const missing = kickDb({ targetExists: false });
  const missingDenied = await request(
    appFor(roleRoutes, { id: 1, platform_role: 'dashboard_owner', is_admin: 1 }, missing.db),
    'DELETE', '/api/users/999'
  );
  assert.equal(missingDenied.status, 404, 'missing kick target must not be disclosed as removable');
  assert.equal(missing.operations.length, 0, 'missing target must not mutate data');

  const owner = kickDb({ targetRole: 'dashboard_owner' });
  const ownerDenied = await request(
    appFor(roleRoutes, { id: 1, platform_role: 'dashboard_owner', is_admin: 1 }, owner.db),
    'DELETE', '/api/users/2'
  );
  assert.equal(ownerDenied.status, 409, 'Dashboard Owner account must be protected from deletion');
  assert.equal(owner.operations.length, 0, 'protected owner deletion must not mutate data');

  const guildOwner = kickDb({ targetIsGuildOwner: true });
  const guildOwnerDenied = await request(
    appFor(roleRoutes, { id: 1, platform_role: 'dashboard_owner', is_admin: 1 }, guildOwner.db),
    'DELETE', '/api/users/2'
  );
  assert.equal(guildOwnerDenied.status, 409, 'guild ownership must be transferred before kicking the owner');
  assert.equal(guildOwner.operations.length, 0, 'guild-owner denial must not mutate data');

  const allowed = kickDb();
  const removed = await request(
    appFor(roleRoutes, { id: 1, platform_role: 'dashboard_owner', is_admin: 1 }, allowed.db),
    'DELETE', '/api/users/2'
  );
  assert.equal(removed.status, 204, 'Dashboard Owner should be able to kick a non-owner user');
  assert(allowed.queries.some(operation => operation.sql.includes('FROM guild_roles') &&
    operation.sql.includes('WHERE user_id = ?') && !operation.sql.includes("role = 'owner'") &&
    operation.sql.includes('FOR UPDATE')),
  'kick must lock every existing target guild role before checking ownership');
  assert(allowed.operations.some(operation => operation.sql.includes('DELETE FROM session\n')),
    'kick must revoke connect-pg-simple sessions');
  assert(allowed.operations.some(operation => operation.sql.includes('DELETE FROM sessions\n')),
    'kick must revoke legacy dashboard sessions');
  assert(allowed.operations.some(operation => operation.sql.includes('DELETE FROM users')),
    'kick must delete the dashboard user record');
  assert(allowed.operations.some(operation => operation.sql.includes('INSERT INTO security_audit_events') &&
    operation.params.includes('user.kicked')), 'kick must create a security audit event');
}

async function testAccessRoleMutationRechecksAuthority() {
  let mutated = false;
  const db = {
    async get(sql) {
      if (sql.includes('SELECT s.id AS server_id')) {
        return {
          server_id: 7,
          guild_id: 3,
          platform_server_id: '7007',
          server_status: 'active',
          discord_guild_id: '900000000000000002',
          guild_status: 'approved',
          guild_role: 'admin',
          server_role: null,
          server_role_status: null,
          player_membership_id: null,
        };
      }
      if (sql.includes('SELECT id FROM users WHERE discord_id = ?')) {
        return { id: 2 };
      }
      return null;
    },
    async transaction(callback) {
      return callback({
        async get(sql) {
          if (sql.includes('pg_advisory_xact_lock')) return {};
          if (sql.includes('FOR UPDATE OF') && sql.includes('JOIN servers')) {
            return { id: 7, guild_id: 3 };
          }
          if (sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
            return { id: 1, platform_role: null, is_admin: 0 };
          }
          if (sql.includes('FROM guild_roles') || sql.includes('FROM server_role_assignments')) return null;
          return null;
        },
        async run() {
          mutated = true;
          return { changes: 1 };
        },
      });
    },
  };
  const response = await request(
    appFor(accessRoutes, { id: 1, platform_role: null, is_admin: 0 }, db),
    'POST', '/api/servers/7/roles',
    { discordId: '900000000000000003', role: 'moderator' }
  );
  assert.equal(response.status, 403,
    'server-role assignment must reject authority revoked after middleware authorization');
  assert.equal(mutated, false, 'stale server-role authority must not mutate assignments');

  let ineligibleTargetMutated = false;
  const ineligibleTargetDb = {
    async get(sql) {
      if (sql.includes('SELECT s.id AS server_id')) {
        return {
          server_id: 7,
          guild_id: 3,
          platform_server_id: '7007',
          server_status: 'active',
          discord_guild_id: '900000000000000002',
          guild_status: 'approved',
          guild_role: 'admin',
          server_role: null,
          server_role_status: null,
          player_membership_id: null,
        };
      }
      if (sql.includes('SELECT id FROM users WHERE discord_id = ?')) return { id: 2 };
      return null;
    },
    async transaction(callback) {
      return callback({
        async get(sql) {
          if (sql.includes('pg_advisory_xact_lock')) return {};
          if (sql.includes('FOR UPDATE OF') && sql.includes('JOIN servers')) {
            return { id: 7, guild_id: 3 };
          }
          if (sql.includes('SELECT id FROM users') && sql.includes('FOR UPDATE')) return { id: 1 };
          if (sql.includes('FROM guild_roles') && sql.includes("role IN ('owner', 'admin')")) {
            return { role: 'admin' };
          }
          if (sql.includes('FOR UPDATE OF u, gr')) return null;
          return null;
        },
        async run() {
          ineligibleTargetMutated = true;
          return { changes: 1 };
        },
      });
    },
  };
  const ineligibleTargetResponse = await request(
    appFor(accessRoutes, { id: 1, platform_role: null, is_admin: 0 }, ineligibleTargetDb),
    'POST', '/api/servers/7/roles',
    { discordId: '900000000000000003', role: 'moderator' }
  );
  assert.equal(ineligibleTargetResponse.status, 404,
    'server-role assignment must reject target eligibility removed before the transaction');
  assert.equal(ineligibleTargetMutated, false,
    'ineligible server-role target must not mutate assignments');

  let revoked = false;
  const revokeDb = {
    async get(sql) {
      if (sql.includes('SELECT s.id AS server_id')) {
        return {
          server_id: 7,
          guild_id: 3,
          platform_server_id: '7007',
          server_status: 'active',
          discord_guild_id: '900000000000000002',
          guild_status: 'approved',
          guild_role: 'admin',
          server_role: null,
          server_role_status: null,
          player_membership_id: null,
        };
      }
      if (sql.includes('SELECT user_id') && sql.includes('FROM server_role_assignments')) {
        return { user_id: 2 };
      }
      return null;
    },
    async transaction(callback) {
      return callback({
        async get(sql) {
          if (sql.includes('UPDATE server_role_assignments')) {
            revoked = true;
            return { user_id: 2, role: 'moderator' };
          }
          if (sql.includes('pg_advisory_xact_lock')) return {};
          if (sql.includes('FOR UPDATE OF') && sql.includes('JOIN servers')) {
            return { id: 7, guild_id: 3 };
          }
          if (sql.includes('FROM users') && sql.includes('FOR UPDATE')) {
            return { id: 1, platform_role: null, is_admin: 0 };
          }
          if (sql.includes('FROM guild_roles') || sql.includes('FROM server_role_assignments')) return null;
          return null;
        },
        async run() { return { changes: 1 }; },
      });
    },
  };
  const revokeResponse = await request(
    appFor(accessRoutes, { id: 1, platform_role: null, is_admin: 0 }, revokeDb),
    'DELETE', '/api/servers/7/roles/55'
  );
  assert.equal(revokeResponse.status, 403,
    'server-role revocation must reject authority revoked after middleware authorization');
  assert.equal(revoked, false, 'stale server-role authority must not revoke assignments');
}

async function testHealthIdor() {
  const db = {
    async get(sql, params) {
      assert(sql.includes('guild_roles') && sql.includes('server_role_assignments') && sql.includes('server_player_memberships'));
      assert.equal(params[0], 1);
      return null;
    },
    async all(sql, params) {
      assert(sql.includes('guild_roles') && sql.includes('server_role_assignments') && sql.includes('server_player_memberships'));
      assert.equal(params[0], 1);
      return [];
    },
  };
  const user = { id: 1, platform_role: null, is_admin: 0 };
  const read = await request(appFor(healthRoutes, user, db), 'GET', '/api/servers/999');
  assert.equal(read.status, 404, 'unauthorized server health read must not reveal resource existence');
  const refresh = await request(appFor(healthRoutes, user, db), 'POST', '/api/servers/999/refresh', {});
  assert.equal(refresh.status, 404, 'unauthorized server health refresh must not reveal resource existence');
}

async function main() {
  await testRoleIdorAndEscalation();
  await testDashboardOwnerUserKick();
  await testAccessRoleMutationRechecksAuthority();
  await testHealthIdor();
  console.log('✅ Admin role and health route IDOR tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
