'use strict';

/*
 * scripts/player-ai-bot-test.js
 *
 * Player-facing Discord AI:
 *   1. /ask + /setup-ai commands load and are classified
 *      (ask: general, setup-ai: guild_admin).
 *   2. botAiRouterService: per-user daily quota (atomic increment +
 *      rollback on over-limit, limit clamping, env fallbacks).
 *   3. askServerService: grounded answers only — off-by-default gate,
 *      quota consumption, status/loot/rules fact blocks, and the
 *      "no data" answer when everything is absent (no hallucination).
 *   4. digestService: window math + due-check (state-backed, no
 *      double-post), deterministic digest content, runDigestPass
 *      end-to-end with a mock channel.
 *   5. onboardingService: off-by-default no-op, template filling,
 *      member-event recording.
 *   6. Migration 105: module shape + SQL executes against a live
 *      Postgres when env is available (skipped otherwise).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Repo convention for command-loading tests: a dummy key so modules that
// import utils/encryption (e.g. bot/commands/github.js) can load headless.
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const BOT_DIR = path.join(__dirname, '..', 'bot');

// Keep the router unconfigured for these tests unless a case opts in.
function clearRouterEnv() {
  for (const key of ['BOT_AI_ROUTER_BASE_URL', 'BOT_AI_ROUTER_API_KEY', 'BOT_AI_ROUTER_MODEL',
    'AI_SHARED_ROUTER_BASE_URL', 'AI_SHARED_ROUTER_API_KEY']) {
    delete process.env[key];
  }
}

// ─── 1. Command loading + classification ────────────────────────────────────

function testCommandsLoadAndClassify() {
  const commandsDir = path.join(BOT_DIR, 'commands');
  const ask = require(path.join(commandsDir, 'ask.js'));
  const setupAi = require(path.join(commandsDir, 'setup-ai.js'));
  assert.strictEqual(ask.data.name, 'ask');
  assert.strictEqual(setupAi.data.name, 'setup-ai');
  const questionOpt = ask.data.options.find(o => o.name === 'question');
  assert.ok(questionOpt && questionOpt.required, '/ask must require a question');

  const { COMMAND_CLASSES } = require(path.join(BOT_DIR, 'utils', 'commandAuthorization.js'));
  assert.strictEqual(COMMAND_CLASSES['ask'], 'general');
  assert.strictEqual(COMMAND_CLASSES['setup-ai'], 'guild_admin');

  // Every bot command still loads with a valid name (loader invariant).
  const files = fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'));
  for (const file of files) {
    const cmd = require(path.join(commandsDir, file));
    assert.ok(cmd.data && cmd.data.name, `command file ${file} has no name`);
  }
  assert.ok(files.length >= 30, `expected >= 30 commands, got ${files.length}`);
}

// ─── 2. botAiRouterService quota ────────────────────────────────────────────

function makeMockDb() {
  const db = {
    calls: [],
    rows: null,
    usageTable: {}, // key: discordId:guildId:day -> calls
    async query(sql, params) {
      this.calls.push({ sql: String(sql), params: params || [] });
      if (/INSERT INTO bot_ai_user_usage/i.test(sql)) {
        const [user, guild, day] = params;
        const key = `${user}:${guild}:${day}`;
        const count = (this.usageTable[key] || 0) + 1;
        this.usageTable[key] = count;
        return { rows: [{ calls: count }] };
      }
      if (/UPDATE bot_ai_user_usage SET calls = calls - 1/i.test(sql)) {
        const [user, guild, day] = params;
        const key = `${user}:${guild}:${day}`;
        this.usageTable[key] = (this.usageTable[key] || 1) - 1;
        return { rows: [] };
      }
      if (/INSERT INTO discord_member_events/i.test(sql)) {
        return { rows: [] };
      }
      if (this.rows) return { rows: this.rows };
      return { rows: [] };
    },
  };
  return db;
}

async function testRouterQuotaAndConfig() {
  clearRouterEnv();
  const svc = require(path.join(BOT_DIR, 'services', 'botAiRouterService.js'));

  assert.strictEqual(svc.isConfigured(), false, 'router must be unconfigured without env');
  assert.strictEqual(svc.routerConfig(), null);

  // Env fallback: BOT_AI_* takes priority, AI_SHARED_ROUTER_* is the fallback.
  const envShared = { AI_SHARED_ROUTER_BASE_URL: 'http://r:3001/v1', AI_SHARED_ROUTER_API_KEY: 'k-shared' };
  const cfgShared = svc.routerConfig(envShared);
  assert.strictEqual(cfgShared.baseURL, 'http://r:3001/v1');
  assert.strictEqual(cfgShared.apiKey, 'k-shared');
  const envBot = { ...envShared, BOT_AI_ROUTER_BASE_URL: 'http://r:3001/v1/', BOT_AI_ROUTER_API_KEY: 'k-bot', BOT_AI_ROUTER_MODEL: 'tiny' };
  const cfgBot = svc.routerConfig(envBot);
  assert.strictEqual(cfgBot.apiKey, 'k-bot', 'BOT_AI_* must win over the shared fallback');
  assert.strictEqual(cfgBot.baseURL, 'http://r:3001/v1', 'trailing slash must be normalized');
  assert.strictEqual(cfgBot.model, 'tiny');

  // Limit clamping.
  assert.strictEqual(svc.clampLimit(5), 5);
  assert.strictEqual(svc.clampLimit(null), svc.DEFAULT_DAILY_LIMIT);
  assert.strictEqual(svc.clampLimit(999), svc.HARD_DAILY_LIMIT);

  // Quota: consume up to the limit, then roll back.
  const db = makeMockDb();
  const day = svc.todayKey();
  for (let i = 1; i <= 20; i++) {
    const result = await svc.consumeUserCall(db, 7, 'user-1', 20, db);
    assert.strictEqual(result.count, i);
    assert.strictEqual(result.remaining, 20 - i);
  }
  assert.strictEqual(db.usageTable['user-1:7:' + day], 20);
  let overLimitError = null;
  try {
    await svc.consumeUserCall(db, 7, 'user-1', 20, db);
  } catch (error) {
    overLimitError = error;
  }
  assert.ok(overLimitError, 'the 21st call must be rejected');
  assert.strictEqual(overLimitError.code, 'BOT_AI_RATE_LIMITED');
  assert.strictEqual(db.usageTable['user-1:7:' + day], 20,
    'the over-limit increment must be rolled back so the budget is not burned');

  // Per-guild scoping: a different guild gets its own budget.
  const other = await svc.consumeUserCall(db, 8, 'user-1', 20, db);
  assert.strictEqual(other.count, 1);

  // Unconfigured router: chat() returns null without throwing.
  assert.strictEqual(await svc.chat([{ role: 'user', content: 'hi' }]), null);
}

// ─── 3. askServerService grounding ──────────────────────────────────────────

async function testAskGrounding() {
  clearRouterEnv();
  const ask = require(path.join(BOT_DIR, 'services', 'askServerService.js'));

  // Unknown guild → registration hint, no quota spend.
  {
    const db = makeMockDb();
    db.rows = []; // guilds lookup empty
    const answer = await ask.answerQuestion({ guildId: 'g-x', userId: 'u1', question: 'is the server online?', db });
    assert.match(answer, /register-token/);
    assert.strictEqual(db.calls.filter(c => /bot_ai_user_usage/.test(c.sql)).length, 0);
  }

  // Missing settings row → defaults (ask OFF) → off message, no quota spend.
  {
    const db = makeMockDb();
    db.rows = [{ id: 7, ask_enabled: null, ask_daily_limit: null }];
    const answer = await ask.answerQuestion({ guildId: 'g', userId: 'u1', question: 'hello', db });
    assert.match(answer, /not enabled/i);
    assert.strictEqual(db.calls.filter(c => /bot_ai_user_usage/.test(c.sql)).length, 0);
  }

  // Enabled + no data anywhere → grounded "no data" answer (no hallucination),
  // quota consumed exactly once.
  {
    const db = makeMockDb();
    // getAskSettings query → enabled with defaults.
    db.rows = [{ id: 7, ask_enabled: true, ask_daily_limit: null }];
    // getServerCreds → no guild row → null. getLootContext → no servers → null.
    // getRulesContext → no channel id → null.
    const answer = await ask.answerQuestion({ guildId: 'g', userId: 'u1', question: 'where do I find a rifle?', db });
    assert.match(answer, /could not find that item in the server/i);
    assert.match(answer, /loot config/i);
    assert.doesNotMatch(answer, /AKM|Kar98|M4/i, 'must not invent specific items');
    assert.strictEqual(db.calls.filter(c => /bot_ai_user_usage/i.test(c.sql) && /INSERT/.test(c.sql)).length, 1,
      'quota must be consumed exactly once per question');
  }

  // Deterministic answers from real fact blocks.
  const status = { serverName: 'SALT', online: true, players: 3, maxPlayers: 24, map: 'chernarusplus', version: '1.28' };
  const loot = 'Loot config entries matching "akm":\n- `AK_74`, nominal spawn 2';
  const rules = 'No griefing. No alts.';

  const statusAnswer = ask.deterministicAnswer('is the server online', status, null, null);
  assert.match(statusAnswer, /SALT/);
  assert.match(statusAnswer, /online/);
  assert.match(statusAnswer, /3 of 24/);

  const lootAnswer = ask.deterministicAnswer('where do I find an akm', null, loot, null);
  assert.match(lootAnswer, /AK_74/);
  assert.match(lootAnswer, /nominal spawn 2/);

  const rulesAnswer = ask.deterministicAnswer('what are the rules', null, null, rules);
  assert.match(rulesAnswer, /No griefing/);

  const generalAnswer = ask.deterministicAnswer('anything?', null, null, null);
  assert.match(generalAnswer, /no ingested data/i);

  const facts = ask.buildFactsBlock(status, loot, rules);
  assert.match(facts, /ONLINE/);
  assert.match(facts, /AK_74/);
  assert.match(facts, /No griefing/);
  const factsNoData = ask.buildFactsBlock(null, null, null);
  assert.match(factsNoData, /no registered server/i);
  assert.match(factsNoData, /no synced loot config/i);
}

// ─── 4. digestService ───────────────────────────────────────────────────────

async function testDigestWindowsAndDue() {
  clearRouterEnv();
  const digest = require(path.join(BOT_DIR, 'services', 'digestService.js'));
  const now = 1_800_000_000_000;

  assert.strictEqual(digest.windowForInterval('daily'), 24 * 60 * 60 * 1000);
  assert.strictEqual(digest.windowForInterval('weekly'), 7 * 24 * 60 * 60 * 1000);
  assert.strictEqual(digest.isDue({ interval: 'daily', state: {} }, now), true, 'fresh state is due');
  assert.strictEqual(
    digest.isDue({ interval: 'daily', state: { lastPostedMs: now - digest.windowForInterval('daily') + 1000 } }, now),
    false,
    'a daily digest posted within 24h is not due'
  );
  assert.strictEqual(
    digest.isDue({ interval: 'daily', state: { lastPostedMs: now - digest.windowForInterval('daily') - 1000 } }, now),
    true,
    'an overdue daily digest is due'
  );
  assert.strictEqual(
    digest.isDue({ interval: 'weekly', state: { lastPostedMs: now - 3 * 24 * 60 * 60 * 1000 } }, now),
    false,
    'a weekly digest is not due mid-week'
  );
}

function makeDigestDbMock(stateRef) {
  const db = {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql: String(sql), params: params || [] });
      const s = String(sql);
      if (/digest_channel_id IS NOT NULL/.test(s) && /SELECT/.test(s)) {
        // runDigestPass guild scan.
        return { rows: [{ guild_db_id: 7, discord_guild_id: 'guild-discord-1' }] };
      }
      if (/digest_state/i.test(s) && /discord_guild_id = \$1/.test(s) && /SELECT/i.test(s)) {
        // getDigestSettings.
        return { rows: [{
          guild_db_id: 7,
          digest_enabled: true,
          digest_channel_id: 'chan-1',
          digest_interval: stateRef.interval,
          digest_state: stateRef.state,
        }] };
      }
      if (/INSERT INTO guild_ai_settings/i.test(s) && /digest_state/.test(s)) {
        stateRef.state = JSON.parse(params[1]);
        return { rows: [] };
      }
      if (/FROM servers/i.test(s) && /status = 'active'/.test(s) && /ORDER BY id/.test(s)) {
        return { rows: [{ id: 11, name: 'SALT' }] };
      }
      return { rows: [] };
    },
  };
  return db;
}

async function testDigestRunPassPostsOnce() {
  clearRouterEnv();
  const digest = require(path.join(BOT_DIR, 'services', 'digestService.js'));
  const now = Date.now();

  const stateRef = { interval: 'daily', state: {} };
  const db = makeDigestDbMock(stateRef);
  const sent = [];
  const fakeChannel = {
    id: 'chan-1',
    guildId: 'guild-discord-1',
    async send(content) { sent.push(content); return 'msg-1'; },
  };
  const client = { channels: { async fetch(id) { return id === 'chan-1' ? fakeChannel : null; } } };

  const posted = await digest.runDigestPass(client, db, now);
  assert.strictEqual(posted, 1, 'a fresh-state digest must post exactly once');
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /digest/i);
  assert.ok(stateRef.state.lastPostedMs === now, 'the posted window must be recorded in state');

  // Second pass in the same window: not due → nothing posted (double-post guard).
  const postedAgain = await digest.runDigestPass(client, db, now + 60 * 1000);
  assert.strictEqual(postedAgain, 0);
  assert.strictEqual(sent.length, 1, 'the same period must never be posted twice');

  // Deterministic digest content shape.
  const data = {
    restarts: '2 scheduled',
    topKillers: '1. **alpha** — 5 kills\n2. **beta** — 3 kills',
    killsTotal: 8,
    lootTop: '- `AK_74` — 40 despawns',
    lootTotal: 40,
    joins: 3,
    leaves: 1,
    onlineNow: 5,
  };
  const content = await digest.buildDigestContent(data, 'daily', now - 86400000);
  assert.match(content, /Top killers \(8 kills\)/);
  assert.match(content, /alpha/);
  assert.match(content, /AK_74/);
  assert.match(content, /3 joined, 1 left/);
  assert.match(content, /5 player/);

  const facts = digest.buildDigestFacts(data, 'weekly', now - 7 * 86400000);
  assert.match(facts, /weekly digest/);
  assert.match(facts, /2 scheduled/);
}

// ─── 4b. opsAlertService (AI feature 7d) ─────────────────────────────────────

function makeOpsAlertDbMock(stateRef, warningRows) {
  const db = {
    calls: [],
    async query(sql, params) {
      this.calls.push({ sql: String(sql), params: params || [] });
      const s = String(sql);
      if (/ops_alert_channel_id IS NOT NULL/.test(s) && /FROM guilds g/.test(s)) {
        // runOpsAlertPass guild scan.
        return { rows: [{
          guild_db_id: 7,
          discord_guild_id: 'guild-discord-1',
          channel_id: 'chan-ops',
          ops_alert_state: stateRef.state,
        }] };
      }
      if (/FROM ops_warnings/.test(s) && /severity IN/.test(s)) {
        // New-warning query: honour the id > $2 watermark.
        const watermark = Number(params[1] || 0);
        return { rows: warningRows.filter(r => r.id > watermark) };
      }
      if (/INSERT INTO guild_ai_settings/i.test(s) && /ops_alert_state/.test(s)) {
        stateRef.state = JSON.parse(params[1]);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return db;
}

async function testOpsAlerts() {
  clearRouterEnv();
  const svc = require(path.join(BOT_DIR, 'services', 'opsAlertService.js'));

  // buildAlertContent: pattern name, severity, server, crash context, dashboard link.
  {
    const warning = {
      server_name: 'SALT',
      severity: 'high',
      precursor_id: 'ce-loop-slow',
      detected_at: new Date().toISOString(),
      payload: {
        label: 'Server tick (CE Loop) over budget',
        occurrences: 12,
        lastCrashPreceded: { atMs: Date.parse('2026-10-11T20:18:53Z'), occurrences: 10 },
      },
    };
    const content = svc.buildAlertContent(warning, { dashboardBase: 'https://dash.example.com' });
    assert.match(content, /SALT/);
    assert.match(content, /high/);
    assert.match(content, /Server tick \(CE Loop\)/);
    assert.match(content, /preceded a crash on 2026-10-11/);
    assert.match(content, /https:\/\/dash\.example\.com\/dashboard\/server-stats/);
  }

  // End-to-end pass: posts a new high warning exactly once, advances the
  // watermark, and does NOT re-post it on the next pass (24h dedupe).
  const now = Date.now();
  const stateRef = { state: {} };
  const warningRows = [{
    id: 5,
    precursor_id: 'ce-loop-slow',
    severity: 'high',
    detected_at: new Date(now - 3600 * 1000).toISOString(),
    payload: { label: 'Server tick (CE Loop) over budget', occurrences: 12, lastCrashPreceded: null },
  }];
  const db = makeOpsAlertDbMock(stateRef, warningRows);
  const sent = [];
  const client = {
    channels: {
      async fetch(id) {
        if (id !== 'chan-ops') return null;
        return { id, guildId: 'guild-discord-1', async send(content) { sent.push(content); return 'm1'; } };
      },
    },
  };

  const posted = await svc.runOpsAlertPass(client, db, now);
  assert.strictEqual(posted, 1, 'one new high warning must post exactly once');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(stateRef.state.lastId, 5, 'the watermark must advance past the posted warning id');

  const postedAgain = await svc.runOpsAlertPass(client, db, now + 60 * 1000);
  assert.strictEqual(postedAgain, 0, 'a posted warning must not be posted again within the window');
  assert.strictEqual(sent.length, 1, 'no duplicate within 24h');

  // The query must be watermark- and severity-filtered.
  const alertQuery = db.calls.find(c => /FROM ops_warnings/.test(c.sql));
  assert.ok(alertQuery, 'the new-warning query must run');
  assert.match(alertQuery.sql, /severity IN \('high', 'critical'\)/);
  assert.match(alertQuery.sql, /w\.id > \$2/);
  assert.match(alertQuery.sql, /detected_at >= \$3/);
}

// ─── 5. onboardingService ───────────────────────────────────────────────────

async function testOnboarding() {
  clearRouterEnv();
  const onboarding = require(path.join(BOT_DIR, 'services', 'onboardingService.js'));

  const member = {
    id: 'user-9',
    username: 'NewPlayer',
    guild: { id: 'guild-1', name: 'SALT Community' },
  };

  // Off by default (no settings row) → no post, no error.
  {
    const db = makeMockDb();
    db.rows = [{ onboarding_enabled: null, onboarding_channel_id: null, ask_rules_channel_id: null }];
    const client = { channels: { async fetch() { throw new Error('must not fetch when disabled'); } } };
    const id = await onboarding.postOnboarding(client, member, db);
    assert.strictEqual(id, null, 'disabled onboarding must not post');
  }

  // Enabled → posts the filled template into the configured channel.
  {
    const db = makeMockDb();
    db.rows = [{ onboarding_enabled: true, onboarding_channel_id: 'chan-2', ask_rules_channel_id: 'chan-rules' }];
    const sent = [];
    const client = {
      channels: {
        async fetch(id) {
          if (id !== 'chan-2') throw new Error('wrong channel');
          return { id, guildId: 'guild-1', async send(content) { sent.push(content); return { id: 'm2' }; } };
        },
      },
    };
    const id = await onboarding.postOnboarding(client, member, db);
    assert.strictEqual(id, 'm2');
    assert.strictEqual(sent.length, 1);
    assert.match(sent[0], /Welcome to \*\*SALT Community\*\*/);
    assert.match(sent[0], /NewPlayer/);
    assert.match(sent[0], /chan-rules/, 'rules channel pointer must be filled in');
    assert.match(sent[0], /\/link/);
    assert.match(sent[0], /\/ask/);
    // Status line present either way (graceful when Nitrado lookup fails in
    // this sandbox: getServerCreds returns null via the empty mock db).
    assert.match(sent[0], /status unavailable|is online|is offline/);
  }

  // recordMemberEvent writes a join row; failures are swallowed.
  {
    const db = makeMockDb();
    await onboarding.recordMemberEvent('guild-1', 'user-9', 'join', db);
    const insert = db.calls.find(c => /INSERT INTO discord_member_events/i.test(c.sql));
    assert.ok(insert, 'join must be recorded');
    assert.deepStrictEqual(insert.params, ['guild-1', 'user-9', 'join']);
  }
}

// ─── 6. Migration 105 ───────────────────────────────────────────────────────

async function testMigration105() {
  const migration = require(path.join(__dirname, '..', 'db', 'migrations', '105_bot_ai_player_facing.js'));
  assert.strictEqual(typeof migration.up, 'function');

  // When a local Postgres is reachable (repo db config), execute the
  // migration for real — it is idempotent (IF NOT EXISTS / no-op when
  // present). Skipped cleanly when no DB is configured on this box.
  let pool;
  try {
    pool = require(path.join(BOT_DIR, 'db.js'));
    await pool.query('SELECT 1');
  } catch (error) {
    if (pool) await pool.end().catch(() => {});
    console.log(`   (no reachable Postgres: ${String(error.message).slice(0, 60)} — live migration check skipped)`);
    return;
  }
  try {
    // Migration 105 FKs into guilds/users — only present in a fully
    // initialised app database. A bare test database (CI service,
    // throwaway) skips the live check instead of failing on the FK.
    const prereq = await pool.query(`
      SELECT (SELECT to_regclass('guilds') IS NOT NULL)  AS g,
             (SELECT to_regclass('users')  IS NOT NULL) AS u`);
    if (!prereq.rows[0].g || !prereq.rows[0].u) {
      console.log('   (prereq tables guilds/users absent — bare test DB, live migration check skipped)');
      return;
    }
    await migration.up(pool);
    const check = await pool.query(
      `SELECT (SELECT to_regclass('guild_ai_settings') IS NOT NULL) AS a,
              (SELECT to_regclass('bot_ai_user_usage') IS NOT NULL) AS b,
              (SELECT to_regclass('discord_member_events') IS NOT NULL) AS c`
    );
    assert.deepStrictEqual(check.rows[0], { a: true, b: true, c: true });
    console.log('   ✅ migration 105 executed against live Postgres (idempotent)');
  } finally {
    await pool.end().catch(() => {});
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const suites = [
    ['commands load + classify', testCommandsLoadAndClassify],
    ['botAiRouterService quota/config', testRouterQuotaAndConfig],
    ['askServerService grounding', testAskGrounding],
    ['digest windows + due-check', testDigestWindowsAndDue],
    ['digest run pass (no double post)', testDigestRunPassPostsOnce],
    ['ops alerts (once per 24h, deduped)', testOpsAlerts],
    ['onboarding', testOnboarding],
    ['migration 105', testMigration105],
  ];

  for (const [name, fn] of suites) {
    clearRouterEnv();
    process.stdout.write(`▶ ${name} ... `);
    await fn();
    console.log('ok');
  }
  console.log(`\n✅ player-ai-bot-test: all ${suites.length} suites passed`);
}

main().catch(error => {
  console.error('❌ player-ai-bot-test failed:', error);
  process.exit(1);
});
