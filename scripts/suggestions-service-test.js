'use strict';

/*
 * scripts/suggestions-service-test.js
 *
 * Suggestions feature (bot/services/suggestionButtonService.js +
 * bot/commands/suggestions.js + migration 100):
 *   1. customId guard (sugg_accept / sugg_deny only).
 *   2. decideSuggestion(): pending -> accepted/denied idempotently;
 *      a second decision on the same row reports the existing status.
 *   3. handleSuggestionClick(): accept path edits + replies; already-decided
 *      path refuses; non-suggestion button is a no-op.
 *   4. Command wiring: subcommands + auth classes (send=general,
 *      setup=guild_admin) + commandAuthorizationKey routing.
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

const {
  ACCEPT_BUTTON_ID,
  DENY_BUTTON_ID,
  isSuggestionButton,
  getSuggestionByMessage,
  decideSuggestion,
  handleSuggestionClick,
} = require(path.join(root, 'bot', 'services', 'suggestionButtonService.js'));

// ─── 1. guard ────────────────────────────────────────────────────────────

function fakeInteraction({ customId, messageId = '777', type = 3, isButton = true, manageMessages = true } = {}) {
  const replies = [];
  const interaction = {
    type,
    customId,
    isButton: () => isButton,
    user: { id: '555', username: 'Mod' },
    replied: false,
    deferred: false,
    memberPermissions: { has: () => manageMessages },
    message: { id: messageId, edit: async () => {} },
    guild: { id: '9001', name: 'TestGuild' },
    client: { users: { fetch: async () => null } },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (opts) => { replies.push(opts.content); },
  };
  return { interaction, replies };
}

async function testGuard() {
  assert.strictEqual(isSuggestionButton(fakeInteraction({ customId: ACCEPT_BUTTON_ID }).interaction), true);
  assert.strictEqual(isSuggestionButton(fakeInteraction({ customId: DENY_BUTTON_ID }).interaction), true);
  assert.strictEqual(isSuggestionButton(fakeInteraction({ customId: 'ticket_open' }).interaction), false);
  assert.strictEqual(isSuggestionButton(fakeInteraction({ type: 2, customId: ACCEPT_BUTTON_ID }).interaction), false);
  assert.strictEqual(isSuggestionButton(null), false);
}

// ─── 2. decideSuggestion (mock DB) ───────────────────────────────────────

function fakeDb({ rows }) {
  const calls = [];
  return {
    calls,
    rows,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  };
}

async function testDecideIdempotent() {
  const row = { id: 42, guild_id: 1, discord_message_id: '777', body: 'more loot', submitter_discord_id: '111', status: 'pending' };
  // First decision: UPDATE ... RETURNING returns the row -> ok.
  let db = fakeDb({ rows: [row] });
  let r = await decideSuggestion(row, 'accept', '555', db);
  assert.strictEqual(r.ok, true);
  assert.match(db.calls[0].sql, /status = \$1/);
  assert.strictEqual(db.calls[0].params[0], 'accepted');
  assert.strictEqual(db.calls[0].params[3], 42);

  // Second decision on a row already accepted: rowCount 0 -> already.
  db = { ...fakeDb({ rows: [] }), async query() { return { rows: [], rowCount: 0 }; } };
  r = await decideSuggestion({ ...row, status: 'accepted' }, 'deny', '555', db);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.already, 'accepted');
}

// ─── 3. handleSuggestionClick ────────────────────────────────────────────

function suggestionDb({ found = true, updates = 1 } = {}) {
  const row = found
    ? { id: 42, guild_id: 1, discord_message_id: '777', body: 'more loot', submitter_discord_id: '111', status: 'pending' }
    : null;
  return {
    async query(sql) {
      if (/UPDATE suggestions/i.test(sql)) {
        return { rows: found ? [{ id: 42 }] : [], rowCount: updates };
      }
      return { rows: found ? [row] : [] };
    },
  };
}

async function testClickAccept() {
  const { interaction, replies } = fakeInteraction({ customId: ACCEPT_BUTTON_ID });
  await handleSuggestionClick(interaction, { database: suggestionDb() });
  assert.strictEqual(interaction.deferred, true);
  assert.match(replies[0], /accepted/i);
}

async function testClickDeny() {
  const { interaction, replies } = fakeInteraction({ customId: DENY_BUTTON_ID });
  await handleSuggestionClick(interaction, { database: suggestionDb() });
  assert.match(replies[0], /denied/i);
}

async function testClickAlreadyDecided() {
  const { interaction, replies } = fakeInteraction({ customId: ACCEPT_BUTTON_ID });
  // update rowCount 0 => already decided
  await handleSuggestionClick(interaction, { database: suggestionDb({ updates: 0 }) });
  assert.match(replies[0], /already/);
}

async function testClickUntrackedMessage() {
  const { interaction, replies } = fakeInteraction({ customId: ACCEPT_BUTTON_ID });
  await handleSuggestionClick(interaction, { database: suggestionDb({ found: false }) });
  assert.match(replies[0], /not a tracked suggestion/i);
}

async function testClickNoPermission() {
  const { interaction, replies } = fakeInteraction({ customId: ACCEPT_BUTTON_ID, manageMessages: false });
  await handleSuggestionClick(interaction, { database: suggestionDb() });
  assert.match(replies[0], /Manage Messages/);
}

async function testClickNonSuggestionNoOp() {
  const { interaction, replies } = fakeInteraction({ customId: 'rr_btn:x:1' });
  await handleSuggestionClick(interaction, { database: suggestionDb() });
  assert.strictEqual(replies.length, 0);
  assert.strictEqual(interaction.deferred, false);
}

// ─── 4. command wiring ───────────────────────────────────────────────────

async function testCommandWiring() {
  const command = require(path.join(root, 'bot', 'commands', 'suggestions.js'));
  const names = command.data.options.map(o => o.name).sort();
  assert.deepStrictEqual(names, ['send', 'setup']);

  const { COMMAND_CLASSES, commandAuthorizationKey } = require(path.join(root, 'bot', 'utils', 'commandAuthorization.js'));
  assert.strictEqual(commandAuthorizationKey('suggestions', 'send'), 'suggestions:send');
  assert.strictEqual(commandAuthorizationKey('suggestions', 'setup'), 'suggestions:setup');
  assert.strictEqual(COMMAND_CLASSES['suggestions:send'], 'general');
  assert.strictEqual(COMMAND_CLASSES['suggestions:setup'], 'guild_admin');
}

// ─── 5. migration parses ─────────────────────────────────────────────────

async function testMigrationShape() {
  const migration = require(path.join(root, 'db', 'migrations', '100_add_suggestions.js'));
  assert.strictEqual(typeof migration.up, 'function');
  assert.strictEqual(typeof migration.down, 'function');
  const calls = [];
  const fakePool = { async query(sql) { calls.push(sql); } };
  await migration.up(fakePool);
  assert.ok(calls.some(sql => /CREATE TABLE IF NOT EXISTS suggestions/.test(sql)));
  assert.ok(calls.some(sql => /UNIQUE \(guild_id, discord_message_id\)/.test(sql)));
}

(async () => {
  console.log('🧪 suggestions tests\n');
  console.log('1. button guard');
  await test('accepts only sugg_accept/sugg_deny', testGuard);

  console.log('2. decideSuggestion');
  await test('pending flip + idempotent second decision', testDecideIdempotent);

  console.log('3. handleSuggestionClick');
  await test('accept path replies + defers', testClickAccept);
  await test('deny path replies', testClickDeny);
  await test('already-decided is refused', testClickAlreadyDecided);
  await test('untracked message is refused', testClickUntrackedMessage);
  await test('missing Manage Messages permission is refused', testClickNoPermission);
  await test('non-suggestion button no-op', testClickNonSuggestionNoOp);

  console.log('4. command wiring');
  await test('subcommands + auth classes', testCommandWiring);

  console.log('5. migration');
  await test('up() creates suggestions table', testMigrationShape);

  console.log('');
  if (failed > 0) {
    console.error(`❌ ${failed} suggestion test(s) failed`);
    process.exit(1);
  }
  console.log(`✅ All ${passed} suggestion tests passed`);
})();
