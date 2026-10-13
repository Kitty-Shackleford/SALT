'use strict';

/*
 * scripts/picker-button-test.js
 *
 * Reaction-role button picker (bot/services/pickerButtonService.js):
 *   1. customId convention: build/parse round-trip + malformed input.
 *   2. isPickerButton hard guard (mirrors the ticket button guard).
 *   3. buildPickerMessages: row chunking (5/row), multi-message split at
 *      the 25-button Discord cap, empty input.
 *   4. handlePickerClick: toggle-on (role added), toggle-off (role removed),
 *      missing role, stale-panel rejection (binding deleted), DB failure
 *      fails safe, non-picker interaction no-op.
 *   5. /setup-reactions now exposes the picker subcommand.
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
  rrPickerButtonId,
  isPickerButton,
  parsePickerCustomId,
  buildPickerMessages,
  handlePickerClick,
} = require(path.join(root, 'bot', 'services', 'pickerButtonService.js'));

// ─── 1. customId convention ──────────────────────────────────────────────

async function testCustomIdRoundTrip() {
  const id = rrPickerButtonId('🎮', '123456789012345678');
  assert.strictEqual(id, 'rr_btn:🎮:123456789012345678');
  assert.deepStrictEqual(
    parsePickerCustomId(id),
    { emoji: '🎮', roleId: '123456789012345678' }
  );
  // Custom-emoji name (no colons) parses the same way.
  assert.deepStrictEqual(
    parsePickerCustomId(rrPickerButtonId('GAMER', '99')),
    { emoji: 'GAMER', roleId: '99' }
  );
}

async function testCustomIdRejection() {
  assert.strictEqual(parsePickerCustomId(null), null);
  assert.strictEqual(parsePickerCustomId(''), null);
  assert.strictEqual(parsePickerCustomId('rr_btn:'), null);          // no emoji
  assert.strictEqual(parsePickerCustomId('rr_btn:🎮:'), null);      // no roleId
  assert.strictEqual(parsePickerCustomId('rr_btn:🎮:abc'), null);   // non-numeric id
  assert.strictEqual(parsePickerCustomId('ticket_open'), null);     // other prefix
  assert.strictEqual(parsePickerCustomId('rr_btn:🎮'), null);       // missing roleId part
}

// ─── 2. isPickerButton guard ─────────────────────────────────────────────

function fakeInteraction({ type = 3, customId, isButton = true } = {}) {
  return {
    type,
    customId,
    isButton: () => isButton,
  };
}

async function testGuard() {
  assert.strictEqual(
    isPickerButton(fakeInteraction({ customId: rrPickerButtonId('🎮', '123') })),
    true, 'genuine rr_btn button must match'
  );
  assert.strictEqual(
    isPickerButton(fakeInteraction({ type: 2, customId: rrPickerButtonId('🎮', '123') })),
    false, 'chat commands (type 2) must not match'
  );
  assert.strictEqual(
    isPickerButton(fakeInteraction({ isButton: false, customId: 'rr_btn:🎮:123' })),
    false, 'non-button interactions must not match'
  );
  assert.strictEqual(
    isPickerButton(fakeInteraction({ customId: 'ticket_open' })),
    false, 'other button prefixes must not match'
  );
  assert.strictEqual(isPickerButton(null), false);
  assert.strictEqual(isPickerButton('not-an-object'), false);
  // An object without isButton() must not throw.
  assert.strictEqual(isPickerButton({ type: 3, customId: 'rr_btn:x:1' }), false);
}

// ─── 3. buildPickerMessages ──────────────────────────────────────────────

function bindings(n) {
  return Array.from({ length: n }, (_, i) => ({
    emoji: `e${i}`,
    roleId: String(1000 + i),
    roleName: `Role ${i}`,
  }));
}

function countButtons(panel) {
  return panel.components.reduce((sum, row) => sum + row.components.length, 0);
}

async function testPanelChunking() {
  assert.deepStrictEqual(buildPickerMessages([]), []);

  const one = buildPickerMessages(bindings(3));
  assert.strictEqual(one.length, 1);
  assert.strictEqual(one[0].components.length, 1);
  assert.strictEqual(countButtons(one[0]), 3);

  const twelve = buildPickerMessages(bindings(12));
  assert.strictEqual(twelve.length, 1);
  assert.strictEqual(twelve[0].components.length, 3); // 3 rows of 5,5,2
  assert.strictEqual(countButtons(twelve[0]), 12);

  const twentySix = buildPickerMessages(bindings(26));
  assert.strictEqual(twentySix.length, 2);            // 25 + 1
  assert.strictEqual(countButtons(twentySix[0]), 25);
  assert.strictEqual(countButtons(twentySix[1]), 1);

  // Labels carry the role name; customIds carry the toggle target.
  const firstButton = one[0].components[0].components[0];
  assert.strictEqual(firstButton.toJSON().label, 'Role 0');
  assert.strictEqual(firstButton.toJSON().custom_id, rrPickerButtonId('e0', '1000'));
}

// ─── 4. handlePickerClick ────────────────────────────────────────────────

function fakeToggleInteraction({ hasRole, roleId = '2000', roleName = 'TestRole', missingRole = false, live = true, dbError = false } = {}) {
  const effect = { added: false, removed: false };
  const replies = [];
  const interaction = {
    type: 3,
    customId: rrPickerButtonId('🎮', roleId),
    isButton: () => true,
    user: { id: '111' },
    replied: false,
    deferred: false,
    guild: {
      id: '9001',
      roles: {
        cache: {
          get: (id) => (id === roleId && !missingRole ? { id, name: roleName } : undefined),
        },
      },
      members: {
        fetch: async () => ({
          roles: {
            cache: {
              has: (id) => id === roleId ? hasRole : false,
            },
            add: async () => { effect.added = true; },
            remove: async () => { effect.removed = true; },
          },
        }),
      },
    },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (opts) => { replies.push(opts.content); },
  };
  const database = {
    async query() {
      if (dbError) throw new Error('db down');
      return { rows: live ? [{ '1': 1 }] : [] };
    },
  };
  return { interaction, effect, replies, database };
}

async function testToggleOn() {
  const { interaction, effect, replies, database } = fakeToggleInteraction({ hasRole: false });
  await handlePickerClick(interaction, { database });
  assert.strictEqual(effect.added, true, 'role should be added');
  assert.strictEqual(effect.removed, false);
  assert.match(replies[0], /Added \*\*TestRole\*\*/);
}

async function testToggleOff() {
  const { interaction, effect, replies, database } = fakeToggleInteraction({ hasRole: true });
  await handlePickerClick(interaction, { database });
  assert.strictEqual(effect.removed, true, 'role should be removed');
  assert.strictEqual(effect.added, false);
  assert.match(replies[0], /Removed \*\*TestRole\*\*/);
}

async function testMissingRole() {
  const { interaction, effect, replies, database } = fakeToggleInteraction({ hasRole: false, missingRole: true });
  await handlePickerClick(interaction, { database });
  assert.strictEqual(effect.added, false);
  assert.strictEqual(effect.removed, false);
  assert.match(replies[0], /no longer exists/);
}

async function testStalePanelRejected() {
  const { interaction, effect, replies, database } = fakeToggleInteraction({ hasRole: false, live: false });
  await handlePickerClick(interaction, { database });
  assert.strictEqual(effect.added, false);
  assert.strictEqual(effect.removed, false);
  assert.match(replies[0], /no longer exists/);
}

async function testDbErrorFailsSafe() {
  const { interaction, effect, replies, database } = fakeToggleInteraction({ hasRole: false, dbError: true });
  await handlePickerClick(interaction, { database });
  assert.strictEqual(effect.added, false);
  assert.strictEqual(effect.removed, false);
  assert.match(replies[0], /re-post the picker/);
}

async function testNonPickerNoOp() {
  const { interaction, replies } = fakeToggleInteraction({ hasRole: false });
  interaction.customId = 'ticket_open';
  await handlePickerClick(interaction);
  assert.strictEqual(replies.length, 0, 'non-picker buttons must be a no-op');
  assert.strictEqual(interaction.deferred, false);
}

// ─── 5. Command wiring ───────────────────────────────────────────────────

async function testCommandWiring() {
  const command = require(path.join(root, 'bot', 'commands', 'setup-reactions.js'));
  const names = command.data.options.map(o => o.name).sort();
  assert.deepStrictEqual(names, ['add', 'list', 'picker', 'remove']);
  const picker = command.data.options.find(o => o.name === 'picker');
  const channelOpt = picker.options.find(o => o.name === 'channel');
  assert.strictEqual(channelOpt.required, true);
}

(async () => {
  console.log('🧪 reaction-role picker tests\n');
  console.log('1. customId convention');
  await test('build/parse round-trip', testCustomIdRoundTrip);
  await test('malformed customIds rejected', testCustomIdRejection);

  console.log('2. isPickerButton guard');
  await test('hard guard accepts only rr_btn buttons', testGuard);

  console.log('3. buildPickerMessages');
  await test('row chunking + 25-button cap split', testPanelChunking);

  console.log('4. handlePickerClick');
  await test('click adds missing role', testToggleOn);
  await test('click removes held role', testToggleOff);
  await test('missing role reports clearly', testMissingRole);
  await test('stale panel (binding deleted) is rejected', testStalePanelRejected);
  await test('DB failure fails safe', testDbErrorFailsSafe);
  await test('non-picker button is a no-op', testNonPickerNoOp);

  console.log('5. Command wiring');
  await test('setup-reactions exposes picker subcommand', testCommandWiring);

  console.log('');
  if (failed > 0) {
    console.error(`❌ ${failed} picker test(s) failed`);
    process.exit(1);
  }
  console.log(`✅ All ${passed} picker tests passed`);
})();
