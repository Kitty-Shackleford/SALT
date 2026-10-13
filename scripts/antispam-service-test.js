'use strict';

/*
 * scripts/antispam-service-test.js
 *
 * Anti-spam rate limiter (bot/services/antiSpamService.js):
 *   1. tick(): fresh burst, counting inside gap, restart on gap, window
 *      expiry, and the limit trip (trip resets state).
 *   2. normalizeConfig(): defaults, clamping, garbage input.
 *   3. handleMessageCreate() with a mocked database: disabled guild is a
 *      no-op, enabled guild trips at the configured limit, bot authors and
 *      DMs are ignored.
 *   4. Event + command files load and wire the right handler names.
 */

const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}

const svc = require(path.join(root, 'bot', 'services', 'antiSpamService.js'));
const { tick, normalizeConfig, DEFAULTS, handleMessageCreate, resetState } = svc;

// ─── 1. tick() ────────────────────────────────────────────────────────────

async function testTickBasics() {
  const cfg = { limit: 5, windowMs: 10000, gapMs: 3000 };
  const t0 = 1_000_000;

  // Fresh burst: first message never trips.
  let r = tick(null, t0, cfg);
  assert.strictEqual(r.action, null);
  assert.deepStrictEqual(r.tracker, { count: 1, lastTs: t0, expireAt: t0 + 10000 });

  // 3 more messages within 3s of each other and inside the window: no trip.
  r = tick(r.tracker, t0 + 1000, cfg);
  assert.strictEqual(r.action, null);
  assert.strictEqual(r.tracker.count, 2);
  r = tick(r.tracker, t0 + 2000, cfg);
  assert.strictEqual(r.action, null);
  r = tick(r.tracker, t0 + 3000, cfg);
  assert.strictEqual(r.action, null);
  assert.strictEqual(r.tracker.count, 4);

  // 5th message: trips, and the state is discarded.
  r = tick(r.tracker, t0 + 4000, cfg);
  assert.strictEqual(r.action, 'limit');
  assert.strictEqual(r.tracker, null);
}

async function testTickGapRestart() {
  const cfg = { limit: 5, windowMs: 10000, gapMs: 3000 };
  const t0 = 2_000_000;
  let r = tick(null, t0, cfg);
  r = tick(r.tracker, t0 + 2000, cfg); // count 2
  // Long pause (> gapMs): burst restarts at count 1.
  r = tick(r.tracker, t0 + 10000, cfg);
  assert.strictEqual(r.action, null);
  assert.strictEqual(r.tracker.count, 1);
  assert.strictEqual(r.tracker.expireAt, t0 + 10000 + cfg.windowMs);
}

async function testTickWindowExpiry() {
  const cfg = { limit: 5, windowMs: 10000, gapMs: 3000 };
  const t0 = 3_000_000;
  let r = tick(null, t0, cfg);
  r = tick(r.tracker, t0 + 1000, cfg);
  // 11s after the burst started: window expired -> fresh burst.
  r = tick(r.tracker, t0 + 11000, cfg);
  assert.strictEqual(r.action, null);
  assert.strictEqual(r.tracker.count, 1);
}

// ─── 2. normalizeConfig ───────────────────────────────────────────────────

async function testNormalizeConfig() {
  assert.deepStrictEqual(normalizeConfig({}), DEFAULTS);
  assert.deepStrictEqual(normalizeConfig(null), DEFAULTS);
  // Garbage values fall back to defaults.
  assert.deepStrictEqual(normalizeConfig({ limit: 'x', windowMs: NaN, gapMs: {} }), DEFAULTS);
  // Clamped to bounds.
  assert.deepStrictEqual(
    normalizeConfig({ limit: 999, windowMs: 999999, gapMs: 99999 }),
    { limit: 15, windowMs: 120000, gapMs: 10000 }
  );
  assert.deepStrictEqual(
    normalizeConfig({ limit: 1, windowMs: 100, gapMs: 1 }),
    { limit: 3, windowMs: 5000, gapMs: 1000 }
  );
  // Valid values pass through (seconds->ms conversion happens in the command).
  assert.deepStrictEqual(
    normalizeConfig({ limit: 4, windowMs: 20000, gapMs: 5000 }),
    { limit: 4, windowMs: 20000, gapMs: 5000 }
  );
}

// ─── 3. handleMessageCreate with a mocked database ────────────────────────

function fakeDb(featureRow) {
  return {
    async query(sql, params) {
      assert.ok(/guild_features/.test(sql), 'expected a guild_features query');
      assert.strictEqual(String(params[0]), '9001');
      assert.strictEqual(params[1], 'antispam');
      return { rows: featureRow ? [featureRow] : [] };
    },
  };
}

function fakeMessage({ ts, bot = false, guildId = '9001' } = {}) {
  return {
    guild: guildId ? { id: guildId } : null,
    author: { id: '111', bot },
    createdTimestamp: ts,
  };
}

async function testHandleDisabled() {
  resetState();
  const db = fakeDb(null); // no row -> off
  const out = await Promise.all(
    [0, 1000, 2000, 3000, 4000, 5000].map(ts =>
      handleMessageCreate(fakeMessage({ ts }), { database: db })
    )
  );
  assert.deepStrictEqual(out, [false, false, false, false, false, false]);
}

async function testHandleTripsAtLimit() {
  resetState();
  // limit 3 -> the 3rd quick message trips.
  const db = fakeDb({ enabled: 1, config: JSON.stringify({ limit: 3, windowMs: 10000, gapMs: 3000 }) });
  const out = await Promise.all(
    [0, 1000, 2000, 3000].map(ts =>
      handleMessageCreate(fakeMessage({ ts }), { database: db })
    )
  );
  assert.deepStrictEqual(out, [false, false, true, false]);
}

async function testHandleIgnoresBotsAndDms() {
  resetState();
  const db = fakeDb({ enabled: 1, config: JSON.stringify({ limit: 3 }) });
  // Bot author: no-op even mid-burst.
  assert.strictEqual(await handleMessageCreate(fakeMessage({ ts: 0, bot: true }), { database: db }), false);
  // DM (no guild): no-op.
  assert.strictEqual(await handleMessageCreate(fakeMessage({ ts: 0, guildId: null }), { database: db }), false);
}

async function testHandleWindowRestart() {
  resetState();
  const db = fakeDb({ enabled: 1, config: JSON.stringify({ limit: 3, windowMs: 5000, gapMs: 3000 }) });
  // 2 quick messages, then one 6s later (window expired): still only count 2
  // in the old burst, so no trip; the burst restarts.
  const out = await Promise.all([0, 1000, 6000, 7000, 8000, 9000].map(ts =>
    handleMessageCreate(fakeMessage({ ts }), { database: db })
  ));
  // old: msgs@0,1000 (count 2). msg@6000 restarts (count 1), 7000 -> 2, 8000 -> trips? limit 3: count would be 3 => trip
  assert.deepStrictEqual(out, [false, false, false, false, true, false]);
}

// ─── 4. Wiring ────────────────────────────────────────────────────────────

async function testWiring() {
  // Events.MessageCreate === 'messageCreate' in discord.js v14; avoid
  // requiring discord.js from scripts/ (it only resolves inside bot/).
  const event = require(path.join(root, 'bot', 'events', 'messageCreate.js'));
  assert.strictEqual(event.name, 'messageCreate');
  assert.strictEqual(typeof event.execute, 'function');

  const command = require(path.join(root, 'bot', 'commands', 'setup-antispam.js'));
  assert.strictEqual(command.data.name, 'setup-antispam');
  const names = command.data.options.map(o => o.name).sort();
  assert.deepStrictEqual(names, ['disable', 'enable', 'set', 'show']);

  const { COMMAND_CLASSES } = require(path.join(root, 'bot', 'utils', 'commandAuthorization.js'));
  assert.strictEqual(COMMAND_CLASSES['setup-antispam'], 'guild_admin');
}

(async () => {
  console.log('🧪 anti-spam service tests\n');
  console.log('1. tick() core behavior');
  await test('fresh burst does not trip', testTickBasics);
  await test('gap > gapMs restarts the burst', testTickGapRestart);
  await test('window expiry restarts the burst', testTickWindowExpiry);

  console.log('2. normalizeConfig()');
  await test('defaults, clamping, garbage', testNormalizeConfig);

  console.log('3. handleMessageCreate() with mocked DB');
  await test('disabled guild is a no-op', testHandleDisabled);
  await test('trips at the configured limit', testHandleTripsAtLimit);
  await test('bots and DMs are ignored', testHandleIgnoresBotsAndDms);
  await test('burst restart after window expiry', testHandleWindowRestart);

  console.log('4. Wiring');
  await test('event name + command schema + auth class', testWiring);

  console.log('');
  if (failed > 0) {
    console.error(`❌ ${failed} anti-spam test(s) failed`);
    process.exit(1);
  }
  console.log(`✅ All ${passed} anti-spam tests passed`);
})();
