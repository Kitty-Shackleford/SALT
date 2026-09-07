'use strict';

// Local HTTP regression: real router/validators/auth/audit, in-memory DB only.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');
const adminRoutes = require('../routes/admin');
const { ensureAuthenticated, ensureAdmin } = require('../middleware/auth');
const { validateGuildId } = require('../middleware/validators');

const GUILD_ID = '900000000000000001';
const OTHER_GUILD_ID = '900000000000000002';
const ADMIN = { id: 7, username: 'Test admin', platform_role: 'dashboard_admin', is_admin: 0 };

function fixture({ user = ADMIN, found = true } = {}) {
  const calls = [];
  const db = {
    async get(sql, params) {
      calls.push({ sql, params });
      if (sql === 'SELECT id, name FROM guilds WHERE discord_guild_id = ?') {
        assert.deepEqual(params, [GUILD_ID]);
        return found ? { id: 42, name: 'Test guild' } : null;
      }
      assert.equal(sql, 'SELECT COUNT(*) as count FROM servers WHERE guild_id = ?');
      assert.deepEqual(params, [42]);
      return { count: 2 };
    },
    async transaction(callback) {
      calls.push({ transaction: true });
      return callback({
        async run(sql, params) {
          calls.push({ sql, params, inTransaction: true });
          if (sql.startsWith('INSERT INTO audit_log')) {
            assert.equal(params[3], 42, 'guild audit target must use the internal integer ID');
          }
          return { changes: 1 };
        }
      });
    },
    async run(sql, params) {
      calls.push({ sql, params, inTransaction: false });
      assert.match(sql, /^INSERT INTO audit_log /);
      assert.equal(params[3], 42, 'guild audit target must use the internal integer ID');
      return { changes: 1 };
    }
  };
  const app = express();
  app.locals.db = db;
  app.use(express.json());
  app.use((req, _res, next) => {
    req.isAuthenticated = () => Boolean(user);
    req.user = user;
    next();
  });
  // Match the production admin mount without loading runtime services or .env.
  app.use('/api/admin', ensureAuthenticated, ensureAdmin, adminRoutes);
  // The account-linking sibling consumes guildId from the body, not the URL.
  app.post('/body-contract/:guildId', validateGuildId, (req, res) => {
    res.json({ guildId: req.body.guildId });
  });
  return { app, calls };
}

function lifecycleFixture(guild) {
  const calls = [];
  const db = {
    async get(sql) {
      calls.push({ sql });
      if (sql.includes('SELECT * FROM guilds WHERE discord_guild_id')) return guild;
      throw new Error('lifecycle guard must reject before dependent reads');
    },
    async run(sql) {
      calls.push({ sql, write: true });
      return { changes: 1 };
    },
    async transaction(callback) { return callback(this); },
  };
  const app = express();
  app.locals.db = db;
  app.use(express.json());
  app.use((req, _res, next) => {
    req.isAuthenticated = () => true;
    req.user = ADMIN;
    next();
  });
  app.use('/api/admin', ensureAuthenticated, ensureAdmin, adminRoutes);
  return { app, calls };
}

async function request(app, method, path, body) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    return await new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, method, path,
        headers: payload === null ? {} : {
          'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)
        }
      }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
          catch (error) { reject(error); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(payload);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function assertSoftDisable(calls) {
  const writes = calls.filter(call => call.sql?.startsWith('UPDATE') || call.sql?.startsWith('INSERT'));
  assert.equal(writes.length, 3, 'only guild/server deactivation and audit writes');
  assert.match(writes[0].sql, /UPDATE guilds\s+SET status = 'disabled'/);
  assert.match(writes[0].sql, /WHERE discord_guild_id = \?/);
  assert.deepEqual(writes[0].params, [ADMIN.id, GUILD_ID]);
  assert.equal(writes[0].inTransaction, true);
  assert.equal(writes[1].sql, "UPDATE servers SET status = 'inactive' WHERE guild_id = ? AND status = 'active'");
  assert.deepEqual(writes[1].params, [42]);
  assert.equal(writes[1].inTransaction, true);
  assert.deepEqual(writes[2].params, [ADMIN.id, 'REMOVE_GUILD', 'guild', 42,
    JSON.stringify({ guildName: 'Test guild', discordGuildId: GUILD_ID, serversAffected: 2 })]);
  assert.equal(writes[2].inTransaction, true);
  assert.equal(calls.filter(call => call.transaction).length, 1);
  assert.equal(calls.some(call => /^DELETE\b/.test(call.sql || '')), false);
}

test('dashboard bodyless DELETE validates the URL guild ID and soft-disables that guild', async () => {
  const { app, calls } = fixture();
  const result = await request(app, 'DELETE', `/api/admin/guilds/${GUILD_ID}`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.success, true);
  assert.equal(result.body.serversAffected, 2);
  assertSoftDisable(calls);
});

test('DELETE ignores conflicting body and query IDs when targeting a valid URL', async () => {
  const { app, calls } = fixture();
  const result = await request(app, 'DELETE', `/api/admin/guilds/${GUILD_ID}?guildId=${OTHER_GUILD_ID}`,
    { guildId: OTHER_GUILD_ID });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assertSoftDisable(calls);
});

for (const guildId of ['invalid', '900000000000000', '900000000000000000000',
  '+900000000000000001', '900000000000000.01', ` ${GUILD_ID}`, `${GUILD_ID}\n`]) {
  test(`malformed URL guild ID ${JSON.stringify(guildId)} cannot be rescued by body/query`, async () => {
    const { app, calls } = fixture();
    const result = await request(app, 'DELETE',
      `/api/admin/guilds/${encodeURIComponent(guildId)}?guildId=${GUILD_ID}`, { guildId: GUILD_ID });
    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.error, 'Validation failed');
    assert.ok(result.body.details.some(error => error.path === 'guildId' && error.location === 'params'));
    assert.deepEqual(calls, [], 'invalid URL must not reach the DB');
  });
}

for (const [user, status] of [[null, 401], [{ id: 9, username: 'Guild owner', is_admin: 0, role: 'owner' }, 403]]) {
  test(`DELETE preserves authorization denial (${status}) with zero DB access`, async () => {
    const { app, calls } = fixture({ user });
    const result = await request(app, 'DELETE', `/api/admin/guilds/${GUILD_ID}`);
    assert.equal(result.status, status);
    assert.deepEqual(calls, []);
  });
}

test('valid but unknown URL guild returns 404 without writes', async () => {
  const { app, calls } = fixture({ found: false });
  const result = await request(app, 'DELETE', `/api/admin/guilds/${GUILD_ID}`);
  assert.equal(result.status, 404, JSON.stringify(result.body));
  assert.equal(result.body.error, 'Guild not found');
  assert.equal(calls.length, 1);
});

test('admin POST keeps body validation and the manual-creation-disabled response', async () => {
  const { app, calls } = fixture();
  const valid = await request(app, 'POST', '/api/admin/guilds', { guildId: GUILD_ID });
  assert.equal(valid.status, 410);
  const missing = await request(app, 'POST', `/api/admin/guilds?guildId=${GUILD_ID}`, {});
  assert.equal(missing.status, 400);
  assert.ok(missing.body.details.some(error => error.location === 'body'));
  assert.deepEqual(calls, []);
});

test('manual approval is disabled because register-token performs verified activation', async () => {
  const { app, calls } = fixture();
  const result = await request(app, 'POST', `/api/admin/guilds/${GUILD_ID}/approve`, {});
  assert.equal(result.status, 410, JSON.stringify(result.body));
  assert.match(result.body.error, /register-token/);
  assert.deepEqual(calls, [], 'manual approval must not read or mutate an installation-only guild');
});

test('pending installation shells cannot be disabled into a re-enable approval path', async () => {
  const { app, calls } = lifecycleFixture({ id: 42, name: 'Shell', status: 'pending', approved_at: null });
  const result = await request(app, 'POST', `/api/admin/guilds/${GUILD_ID}/disable`, {});
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.match(result.body.error, /approved guilds/i);
  assert.equal(calls.some(call => call.write), false);
});

test('never-approved disabled shells cannot be re-enabled as approved guilds', async () => {
  const { app, calls } = lifecycleFixture({ id: 42, name: 'Shell', status: 'disabled', approved_at: null });
  const result = await request(app, 'POST', `/api/admin/guilds/${GUILD_ID}/enable`, {});
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.match(result.body.error, /register-token/);
  assert.equal(calls.some(call => call.write), false);
});

test('all admin guild audit writes use internal integer IDs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  assert.doesNotMatch(source, /logAction\([^\n]+['"]guild['"],\s*guildId\b/);
  for (const action of ['REMOVE_GUILD', 'DISABLE_GUILD', 'ENABLE_GUILD', 'DENY_GUILD']) {
    assert.match(source, new RegExp(`logAction\\([^\\n]+['"]${action}['"], ['"]guild['"], guild\\.id`));
  }
});

test('shared body validator still requires the account-linking body guild ID', async () => {
  const { app } = fixture();
  const valid = await request(app, 'POST', '/body-contract/ignored', { guildId: GUILD_ID });
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.body, { guildId: GUILD_ID });
  const missing = await request(app, 'POST', `/body-contract/${GUILD_ID}?guildId=${GUILD_ID}`, {});
  assert.equal(missing.status, 400);
  assert.ok(missing.body.details.some(error => error.location === 'body'));
});
