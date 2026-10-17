'use strict';

// Guild removal: admin list filtering + durable bot-leave outbox.
// (a) DELETE /api/admin/guilds enqueues a pending leave job in the same transaction
// (b) GET /api/admin/guilds excludes disabled guilds by default; pending page unaffected
// (c) the bot consumer completes on leave success / guild gone, and backs off on errors
const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const express = require('express');
const adminRoutes = require('../routes/admin');
const { ensureAuthenticated, ensureAdmin } = require('../middleware/auth');
const {
  claimGuildLeaveJob,
  processGuildLeaveJob,
  runGuildLeavePass,
  isGuildGoneError,
} = require('../bot/services/guildLeaveService');

const GUILD_ID = '1234567890123456789';
const ADMIN = { id: 7, username: 'Test admin', platform_role: 'dashboard_admin', is_admin: 0 };

function adminApp(db) {
  const app = express();
  app.locals.db = db;
  app.use(express.json());
  app.use((req, _res, next) => {
    req.isAuthenticated = () => true;
    req.user = ADMIN;
    next();
  });
  app.use('/api/admin', ensureAuthenticated, ensureAdmin, adminRoutes);
  return app;
}

async function request(app, method, path) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
          catch (error) { reject(error); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

// (a) DELETE enqueues the leave job atomically with the deactivation.
test('DELETE /guilds enqueues a pending guild-leave job inside the deactivation transaction', async () => {
  const calls = [];
  const db = {
    async get(sql) {
      calls.push({ sql });
      return { id: 42, name: 'Removed guild' };
    },
    async transaction(callback) {
      calls.push({ transaction: true });
      return callback({
        async run(sql, params) {
          calls.push({ sql, params, inTransaction: true });
          return { changes: 1 };
        }
      });
    }
  };
  const result = await request(adminApp(db), 'DELETE', `/api/admin/guilds/${GUILD_ID}`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.success, true);

  const writes = calls.filter(call => call.sql?.startsWith('UPDATE') || call.sql?.startsWith('INSERT'));
  assert.equal(writes.length, 4, 'guild update, server update, leave job, audit');
  const leaveJob = writes[2];
  assert.match(leaveJob.sql, /INSERT INTO discord_guild_leave_jobs/);
  assert.match(leaveJob.sql, /VALUES \(\?, 'pending', 0, NOW\(\), NOW\(\)\)/);
  assert.match(leaveJob.sql, /ON CONFLICT \(discord_guild_id\) DO UPDATE SET/);
  assert.match(leaveJob.sql, /status = 'pending', attempts = 0, next_attempt_at = NOW\(\)/);
  assert.deepEqual(leaveJob.params, [GUILD_ID]);
  assert.equal(leaveJob.inTransaction, true, 'leave job must commit with the deactivation');
  assert.equal(calls.filter(call => call.transaction).length, 1);
});

// (b) list endpoint filtering.
function listFixture() {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return [];
    }
  };
  return { db, calls };
}

test('GET /guilds defaults to approved only', async () => {
  const { db, calls } = listFixture();
  const result = await request(adminApp(db), 'GET', '/api/admin/guilds');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.success, true);
  assert.deepEqual(calls.length, 1);
  assert.match(calls[0].sql, /WHERE g\.status = \?/);
  assert.deepEqual(calls[0].params, ['approved']);
});

test('GET /guilds?status=disabled returns disabled rows for the management page', async () => {
  const { db, calls } = listFixture();
  const result = await request(adminApp(db), 'GET', '/api/admin/guilds?status=disabled');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(calls[0].params, ['disabled']);
});

test('GET /guilds rejects unknown status values without touching the DB', async () => {
  const { db, calls } = listFixture();
  for (const status of ['pending', 'bogus', 'approved; DROP TABLE guilds']) {
    const result = await request(adminApp(db), 'GET', `/api/admin/guilds?status=${encodeURIComponent(status)}`);
    assert.equal(result.status, 400, `${status}: ${JSON.stringify(result.body)}`);
    assert.match(result.body.error, /status must be/);
  }
  assert.deepEqual(calls, []);
});

test('GET /guilds/pending keeps its own filter and is unaffected', async () => {
  const { db, calls } = listFixture();
  const result = await request(adminApp(db), 'GET', '/api/admin/guilds/pending');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.success, true);
  assert.deepEqual(calls.length, 1);
  assert.match(calls[0].sql, /WHERE g\.status = 'pending'/);
  assert.deepEqual(calls[0].params, []);
});

// (c) bot consumer.
function fakeDb(claimQueue = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^UPDATE discord_guild_leave_jobs\s+SET status = 'processing'/.test(sql)) {
        const job = claimQueue.shift() || null;
        return { rows: job ? [job] : [] };
      }
      return { rows: [] };
    }
  };
}

function fakeClient({ fetchError = null, leaveError = null } = {}) {
  const calls = { fetch: [], leave: [] };
  const guild = {
    id: GUILD_ID,
    async leave() {
      calls.leave.push(GUILD_ID);
      if (leaveError) throw leaveError;
    }
  };
  return {
    calls,
    guilds: {
      async fetch(id) {
        calls.fetch.push(id);
        if (fetchError) throw fetchError;
        return guild;
      }
    }
  };
}

function mkErr(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const JOB = { id: 11, discord_guild_id: GUILD_ID, status: 'pending', attempts: 0 };

test('claim uses FOR UPDATE SKIP LOCKED and reclaims stale processing locks', async () => {
  const db = fakeDb([JOB]);
  const job = await claimGuildLeaveJob(db);
  assert.equal(job.id, 11);
  const sql = db.calls[0].sql;
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /status = 'pending' AND next_attempt_at <= NOW\(\)/);
  assert.match(sql, /status = 'processing' AND locked_at < NOW\(\) - 300 \* INTERVAL '1 second'/);
  assert.match(sql, /SET status = 'processing', locked_at = NOW\(\)/);
});

test('consumer completes the job on a successful leave', async () => {
  const db = fakeDb();
  const client = fakeClient();
  const result = await processGuildLeaveJob(client, db, JOB);
  assert.equal(result.status, 'completed');
  assert.deepEqual(client.calls.leave, [GUILD_ID]);
  const writes = db.calls.filter(call => /UPDATE discord_guild_leave_jobs/.test(call.sql));
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /SET status = 'completed', completed_at = NOW\(\)/);
  assert.deepEqual(writes[0].params, [null, 11]);
});

test('consumer completes idempotently when the guild is gone (Discord 10006)', async () => {
  const db = fakeDb();
  const client = fakeClient({ fetchError: mkErr(10006, 'Unknown Guild') });
  const result = await processGuildLeaveJob(client, db, JOB);
  assert.equal(result.status, 'completed');
  assert.equal(result.note, 'guild-gone');
  assert.deepEqual(client.calls.leave, [], 'leave() must not be attempted for a gone guild');
  assert.match(db.calls[0].params[0], /guild not found/);
  assert.match(db.calls[0].sql, /SET status = 'completed'/);
});

test('consumer completes idempotently on HTTP 404 fetch', async () => {
  const db = fakeDb();
  const error = new Error('Not Found');
  error.httpstatus = 404;
  const client = fakeClient({ fetchError: error });
  const result = await processGuildLeaveJob(client, db, JOB);
  assert.equal(result.status, 'completed');
});

test('isGuildGoneError classification', () => {
  assert.equal(isGuildGoneError({ code: 10006 }), true);
  assert.equal(isGuildGoneError({ httpstatus: 404 }), true);
  assert.equal(isGuildGoneError({ httpStatus: 404 }), true);
  assert.equal(isGuildGoneError({ code: 50001 }), false);
  assert.equal(isGuildGoneError(null), false);
});

test('transient fetch failure rethrows without writing; the pass applies the backoff', async () => {
  const db = fakeDb([JOB]);
  const client = fakeClient({ fetchError: mkErr(50001, 'Missing Permissions') });
  const results = await runGuildLeavePass(client, db);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'pending');
  assert.match(results[0].error, /Missing Permissions/);
  const write = db.calls.find(call => !/FOR UPDATE SKIP LOCKED/.test(call.sql));
  assert.match(write.sql, /SET status = 'pending', attempts = attempts \+ 1/);
  assert.match(write.sql, /next_attempt_at = NOW\(\) \+ LEAST\(3600, POWER\(2, attempts \+ 1\)\) \* INTERVAL '1 second'/);
  assert.deepEqual(write.params, ['Missing Permissions', 11]);
});

test('leave() failure backs off with the error message kept on the row', async () => {
  const db = fakeDb([JOB]);
  const client = fakeClient({ leaveError: mkErr(40034, 'Cannot leave guild: Guild owner cannot leave') });
  const results = await runGuildLeavePass(client, db);
  assert.equal(results[0].status, 'pending');
  const write = db.calls.find(call => !/FOR UPDATE SKIP LOCKED/.test(call.sql));
  assert.match(write.sql, /attempts = attempts \+ 1/);
  assert.match(write.params[0], /Guild owner cannot leave/);
});

test('a pass drains due jobs, claims until empty, and keeps going after failures', async () => {
  const jobs = [
    { id: 1, discord_guild_id: '111', status: 'pending', attempts: 0 },
    { id: 2, discord_guild_id: '222', status: 'pending', attempts: 1 }
  ];
  const db = fakeDb(jobs);
  const leaveErrors = { 222: mkErr(50001, 'flaky gateway') };
  const client = {
    guilds: {
      async fetch(id) {
        if (leaveErrors[id]) throw leaveErrors[id];
        return { id, async leave() {} };
      }
    }
  };
  const results = await runGuildLeavePass(client, db);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { id: 1, status: 'completed' });
  assert.equal(results[1].status, 'pending');
  // 2 claims (both jobs) + 1 claim that returns empty + 2 status writes
  const claims = db.calls.filter(call => /FOR UPDATE SKIP LOCKED/.test(call.sql));
  assert.equal(claims.length, 3);
  const updates = db.calls.filter(call => !/FOR UPDATE SKIP LOCKED/.test(call.sql));
  assert.equal(updates.length, 2);
});

// The bot container's db is a raw pg Pool (bot/db.js) with no `?` → `$n`
// rewriting — every consumer query must be parameterized in Postgres style.
// A `?` placeholder used to ship here and deadlocked every job in
// 'processing' with "syntax error at or near ','" (prod incident, 2026-10-17).
test('consumer status writes use $n placeholders accepted by the raw pg pool', async () => {
  const db = fakeDb([JOB]);
  const client = fakeClient();
  await processGuildLeaveJob(client, db, JOB);
  const retryDb = fakeDb([JOB]);
  await runGuildLeavePass(fakeClient({ leaveError: mkErr(40034, 'owner cannot leave') }), retryDb);
  for (const { calls } of [db, retryDb]) {
    for (const call of calls) {
      if (/FOR UPDATE SKIP LOCKED/.test(call.sql)) continue;
      assert.match(call.sql, /\$1/, 'completed/retry write must bind $1');
      assert.match(call.sql, /WHERE id = \$2/, 'completed/retry write must bind $2');
      assert.doesNotMatch(call.sql, /=\s*\?/, 'raw pg pool rejects ? placeholders');
    }
  }
});
