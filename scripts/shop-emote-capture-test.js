'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  normalizeEmoteCaptureConfig,
  emoteEventToShopCoordinates,
  armEmoteCaptureInTransaction,
  cancelEmoteCaptureInTransaction,
  applyEmoteEventToCaptureInTransaction,
} = require('../services/shopEmoteCaptureService');

(function testConfiguredCaptureContract() {
  assert.deepStrictEqual(normalizeEmoteCaptureConfig({
    enabled: true,
    emoteType: 'EmotePoint',
    heldItem: 'Roadflare',
  }), {
    enabled: true,
    emoteType: 'EmotePoint',
    heldItem: 'Roadflare',
  });
  assert.deepStrictEqual(normalizeEmoteCaptureConfig(null), {
    enabled: false,
    emoteType: null,
    heldItem: null,
  });
  assert.throws(
    () => normalizeEmoteCaptureConfig({ enabled: false, emoteType: 'EmotePoint' }),
    /disabled configuration cannot include/i
  );
  assert.throws(
    () => normalizeEmoteCaptureConfig({ enabled: true, emoteType: 'EmotePoint', surprise: true }),
    /unsupported field/i
  );
  assert.throws(
    () => normalizeEmoteCaptureConfig({ enabled: true, emoteType: 'AnythingGoes' }),
    /supported emote/i
  );
  assert.throws(
    () => normalizeEmoteCaptureConfig({ enabled: true, emoteType: 'EmotePoint', heldItem: '../bad' }),
    /held item/i
  );
  assert.deepStrictEqual(emoteEventToShopCoordinates({ pos_x: 13616.8, pos_y: 3090.1, pos_z: 45.8 }), {
    pos_x: 13616.8,
    pos_y: 45.8,
    pos_z: 3090.1,
  });
})();

async function testMatchingEventUpdatesOnlyTheBoundEditableLine() {
  const calls = [];
  const db = {
    async get(sql, params) {
      calls.push({ type: 'get', sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('FROM player_emote_events')) {
        return {
          id: 91, server_id: 7, identity_id: 11, emote_type: 'EmotePoint',
          item_name: 'Roadflare', pos_x: '13616.8', pos_y: '3090.1', pos_z: '45.8',
          timestamp: '2026-09-06T00:47:14.000Z', source_file: 'server.ADM', source_line: 44,
        };
      }
      if (sql.includes('SELECT guild_id FROM servers')) return { guild_id: 3 };
      if (sql.includes('FROM guilds WHERE')) return { id: 3 };
      if (sql.includes('FROM servers WHERE') && sql.includes('FOR NO KEY UPDATE')) return { id: 7 };
      if (sql.includes('FROM shop_emote_capture_requests')) {
        return {
          id: 31, server_id: 7, identity_id: 11, order_id: 21, order_item_id: 22,
          requested_by_user_id: 5, expected_emote_type: 'EmotePoint', expected_item_name: 'Roadflare',
          event_high_water_id: 90, requested_at: '2026-09-06T06:45:00.000Z',
          expires_at: '2026-09-06T07:15:00.000Z', status: 'pending',
        };
      }
      if (sql.includes('FROM linked_accounts')) return { id: 41 };
      if (sql.includes('FROM server_player_memberships')) return { id: 51 };
      if (sql.includes('FROM shop_order_items')) {
        return { id: 22, order_id: 21, identity_id: 11, server_id: 7, pos_x: 1, pos_y: 2, pos_z: 3 };
      }
      throw new Error(`Unexpected get: ${sql}`);
    },
    async run(sql, params) {
      calls.push({ type: 'run', sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { changes: 1 };
    },
  };

  const result = await applyEmoteEventToCaptureInTransaction(db, 91);
  assert.equal(result.status, 'applied');
  const lineUpdate = calls.find(call => call.type === 'run' && call.sql.includes('UPDATE shop_order_items'));
  assert.deepStrictEqual(lineUpdate.params.slice(0, 3), [13616.8, 45.8, 3090.1]);
  assert.equal(calls.some(call => /wallet|provider_mutation|economy_transaction/i.test(call.sql)), false,
    'capture must not debit funds or perform provider work');
  const receipt = calls.find(call => call.type === 'run' && call.sql.includes('UPDATE shop_emote_capture_requests'));
  assert.ok(receipt);
  assert.ok(receipt.params.includes(91));
  const guildLockIndex = calls.findIndex(call => call.type === 'get' && call.sql.includes('FROM guilds WHERE'));
  const serverLockIndex = calls.findIndex(call => call.type === 'get' && call.sql.includes('FOR NO KEY UPDATE'));
  const proofLockIndex = calls.findIndex(call => call.type === 'get' && call.sql.includes('FROM linked_accounts'));
  const membershipLockIndex = calls.findIndex(call => call.type === 'get' && call.sql.includes('FROM server_player_memberships'));
  const cartLockIndex = calls.findIndex(call => call.type === 'get' && call.sql.includes('FROM shop_order_items'));
  const captureLockIndex = calls.findIndex(call => call.type === 'get' &&
    call.sql.includes('FROM shop_emote_capture_requests') && call.sql.includes('FOR UPDATE'));
  assert.ok(guildLockIndex < serverLockIndex && serverLockIndex < proofLockIndex &&
    proofLockIndex < membershipLockIndex && membershipLockIndex < cartLockIndex &&
    cartLockIndex < captureLockIndex,
  'apply lock order must be guild -> server -> proof -> membership -> cart -> capture');
  const captureReads = calls.filter(call => call.type === 'get' &&
    call.sql.includes('FROM shop_emote_capture_requests'));
  assert.equal(captureReads.length, 2);
  assert.ok(captureReads.every(call => call.sql.includes('expires_at > clock_timestamp()')),
    'capture eligibility must use the database clock rather than the ADM source timestamp');
}

async function testArmCaptureUsesExactOwnedCartLineAndHighWaterMark() {
  const calls = [];
  const db = {
    async get(sql, params) {
      calls.push({ type: 'get', sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('SELECT guild_id FROM servers')) return { guild_id: 3 };
      if (sql.includes('FROM guilds WHERE')) return { id: 3 };
      if (sql.includes('FROM servers WHERE') && sql.includes('FOR NO KEY UPDATE')) return { id: 7 };
      if (sql.includes('FROM linked_accounts')) return { id: 41 };
      if (sql.includes('FROM server_player_memberships')) return { id: 51 };
      if (sql.includes('FROM shop_order_items')) {
        return {
          id: 22, order_id: 21, identity_id: 11, server_id: 7,
          emote_capture_config: { enabled: true, emoteType: 'EmotePoint', heldItem: 'Roadflare' },
        };
      }
      if (sql.includes('MAX(id)')) return { high_water_id: 90 };
      throw new Error(`Unexpected get: ${sql}`);
    },
    async query(sql, params) {
      calls.push({ type: 'query', sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('INSERT INTO shop_emote_capture_requests')) {
        return [{ id: 31, status: 'pending', expected_emote_type: 'EmotePoint', expected_item_name: 'Roadflare' }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run(sql, params) {
      calls.push({ type: 'run', sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { changes: 1 };
    },
  };

  const result = await armEmoteCaptureInTransaction(db, {
    userId: 5, identityId: 11, serverId: 7, orderItemId: 22,
  });
  assert.equal(result.status, 'pending');
  const insert = calls.find(call => call.type === 'query' && call.sql.includes('INSERT INTO shop_emote_capture_requests'));
  assert.ok(insert);
  assert.ok(insert.params.includes(90));
  assert.ok(insert.params.includes('EmotePoint'));
  assert.ok(insert.params.includes('Roadflare'));
  assert.match(calls.find(call => call.sql.includes('FROM shop_order_items')).sql, /so\.status = 'cart'/);
}

async function testMismatchedEventHasNoCartSideEffects() {
  const calls = [];
  const db = {
    async get(sql) {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      if (sql.includes('SELECT server_id FROM player_emote_events')) return { server_id: 7 };
      if (sql.includes('SELECT guild_id FROM servers')) return { guild_id: 3 };
      if (sql.includes('FROM guilds WHERE')) return { id: 3 };
      if (sql.includes('FROM servers WHERE') && sql.includes('FOR NO KEY UPDATE')) return { id: 7 };
      if (sql.includes('FROM player_emote_events')) {
        return {
          id: 91, server_id: 7, identity_id: 11, emote_type: 'EmoteDance', item_name: 'Roadflare',
          pos_x: 1, pos_y: 2, pos_z: 3, timestamp: '2026-09-06T06:47:14.000Z',
        };
      }
      if (sql.includes('FROM shop_emote_capture_requests')) {
        return {
          id: 31, server_id: 7, identity_id: 11, expected_emote_type: 'EmotePoint',
          expected_item_name: 'Roadflare', event_high_water_id: 90,
          requested_at: '2026-09-06T06:45:00.000Z', expires_at: '2026-09-06T07:15:00.000Z',
        };
      }
      throw new Error(`Unexpected get: ${sql}`);
    },
    async run() {
      throw new Error('a mismatched event must not write');
    },
  };
  assert.deepStrictEqual(await applyEmoteEventToCaptureInTransaction(db, 91), {
    status: 'ignored', reason: 'event_does_not_match',
  });
}

async function testCancelCaptureRequiresTheBoundOwnerAndLine() {
  const calls = [];
  const db = {
    async get(sql) {
      calls.push({ type: 'get', sql: sql.replace(/\s+/g, ' ').trim() });
      if (sql.includes('SELECT guild_id FROM servers')) return { guild_id: 3 };
      if (sql.includes('FROM guilds WHERE')) return { id: 3 };
      if (sql.includes('FROM servers WHERE') && sql.includes('FOR NO KEY UPDATE')) return { id: 7 };
      if (sql.includes('FROM linked_accounts')) return { id: 41 };
      if (sql.includes('FROM server_player_memberships')) return { id: 51 };
      if (sql.includes('FROM shop_order_items')) return { id: 22, order_id: 21 };
      throw new Error(`Unexpected get: ${sql}`);
    },
    async run(sql, params) {
      calls.push({ type: 'run', sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { changes: 1 };
    },
  };
  const result = await cancelEmoteCaptureInTransaction(db, {
    userId: 5, identityId: 11, serverId: 7, orderItemId: 22,
  });
  assert.equal(result.status, 'cancelled');
  const update = calls.find(call => call.type === 'run');
  assert.match(update.sql, /server_id = \? AND identity_id = \? AND order_item_id = \?/);
  assert.deepStrictEqual(update.params, [7, 11, 22]);
}

async function testMigrationDefinesDurableExactScopeAndOneTimeClaims() {
  const migration = require('../db/migrations/083_shop_emote_capture');
  const statements = [];
  await migration.up({ async query(sql) { statements.push(sql.replace(/\s+/g, ' ').trim()); } });
  const sql = statements.join(' ');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS emote_capture_config JSONB/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS emote_capture_config_snapshot JSONB/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS shop_emote_capture_requests/);
  assert.match(sql, /emote_event_id INTEGER UNIQUE/);
  assert.match(sql, /WHERE status = 'pending'/);
  assert.match(sql, /membership_id BIGINT[\s\S]*REFERENCES server_player_memberships\(id\) ON DELETE SET NULL/);
  assert.match(sql, /server_id INTEGER NOT NULL/);
  assert.match(sql, /identity_id INTEGER NOT NULL/);
}

function testCrossLayerIntegrationContract() {
  const routeSource = fs.readFileSync(path.join(__dirname, '../routes/shop.js'), 'utf8');
  const parserSource = fs.readFileSync(path.join(__dirname, '../routes/logParser.js'), 'utf8');
  const serviceSource = fs.readFileSync(path.join(__dirname, '../services/shopEmoteCaptureService.js'), 'utf8');
  const playerSource = fs.readFileSync(path.join(__dirname, '../public/js/shop.js'), 'utf8');
  const adminSource = fs.readFileSync(path.join(__dirname, '../public/js/shop-admin.js'), 'utf8');
  const adminPage = fs.readFileSync(path.join(__dirname, '../public/dashboard/shop-admin.html'), 'utf8');
  const checkoutSource = fs.readFileSync(path.join(__dirname, '../services/shopFileService.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));

  assert.match(routeSource, /router\.post\('\/cart\/item\/:cartItemId\/emote-capture', ensurePlayerServerAccess, async \(req, res\) => \{\n\s{2}const \{ serverId, identityId \} = req\.playerServerAccess;/);
  assert.match(routeSource, /router\.delete\('\/cart\/item\/:cartItemId\/emote-capture', ensurePlayerServerAccess, async \(req, res\) => \{\n\s{2}const \{ serverId, identityId \} = req\.playerServerAccess;/);
  assert.match(routeSource, /CASE WHEN status = 'pending' AND expires_at <= clock_timestamp\(\)[\s\S]*THEN 'expired'/,
    'cart responses must project expired captures so polling terminates');
  assert.match(playerSource, /capture\?\.status === 'expired'/,
    'cart UI must render expired capture status');
  assert.match(routeSource, /emote_capture_config_snapshot/,
    'cart lines must snapshot the catalog capture policy');
  assert.ok(routeSource.indexOf('const checkoutFingerprint = buildShopCartFingerprint(cart, items);') <
    routeSource.indexOf('item.emote_capture = captureByItemId'),
  'ephemeral capture status must not alter the financial cart fingerprint');
  assert.match(routeSource, /normalizeEmoteCaptureConfig\(emote_capture_config\)/,
    'admin writes must validate one canonical capture policy');
  assert.match(serviceSource, /async function lockActiveCaptureServer[\s\S]*SELECT guild_id FROM servers WHERE id = \?[\s\S]*SELECT id FROM guilds WHERE id = \?[\s\S]*FOR UPDATE[\s\S]*SELECT id FROM servers WHERE id = \? AND guild_id = \?[\s\S]*FOR NO KEY UPDATE/,
    'capture operations must lock guild then server using the checkout lock order');
  assert.match(parserSource, /db\.transaction\(async transactionDb => \{[\s\S]*lockActiveCaptureServer\(transactionDb, dbServerId\)[\s\S]*INSERT INTO player_emote_events[\s\S]*applyEmoteEventToCaptureInTransaction\(transactionDb, result\.lastID\)/,
    'emote insertion and capture matching must share the ordered tenant lock and transaction');
  assert.match(checkoutSource, /UPDATE shop_emote_capture_requests[\s\S]*checkout_completed/,
    'checkout must terminalize unconsumed capture requests');
  assert.match(playerSource, /armEmoteCapture/);
  assert.match(playerSource, /shopContextGeneration/);
  assert.match(adminSource, /emote_capture_config/);
  assert(adminPage.includes('id="emote-ordering-hotkey"'),
    'shop admin must expose a clearly named emote ordering hotkey section');
  assert(adminPage.indexOf('id="emote-ordering-hotkey"') < adminPage.indexOf('id="event-config-panel"'),
    'emote ordering hotkeys must appear before method-specific advanced configuration');
  assert(adminPage.includes('Emote Hotkey'),
    'shop item inventory must show whether an emote ordering hotkey is configured');
  assert.match(adminSource, /formatEmoteHotkey/,
    'shop admin must summarize each configured emote hotkey in the item inventory');
  assert.match(packageJson.scripts.test, /shop-emote-capture-test\.js/);
}

(async () => {
  testCrossLayerIntegrationContract();
  await testCancelCaptureRequiresTheBoundOwnerAndLine();
  await testMigrationDefinesDurableExactScopeAndOneTimeClaims();
  await testArmCaptureUsesExactOwnedCartLineAndHighWaterMark();
  await testMismatchedEventHasNoCartSideEffects();
  await testMatchingEventUpdatesOnlyTheBoundEditableLine();
  console.log('Shop emote capture tests passed');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
