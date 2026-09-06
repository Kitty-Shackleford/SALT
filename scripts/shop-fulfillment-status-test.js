'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  projectShopFulfillmentStatus,
} = require('../services/shopFulfillmentStatusService');

function main() {
  const spawned = projectShopFulfillmentStatus({
    spawn_method: 'event',
    item_type: 'event_rental',
    event_name: 'VehicleRental203',
    restarts_remaining: 2,
    is_active: true,
    checked_out_at: '2026-09-01T22:30:00.000Z',
  }, new Map([['VehicleRental203', {
    status: 'spawned',
    successfulInstances: 1,
    refusals: 0,
    failures: 0,
    lastSuccess: { observedAt: '2026-09-01T22:35:23.000Z' },
  }]]), { evidenceAvailable: true, chronologyVerified: true });
  assert.deepStrictEqual(spawned, {
    state: 'spawn_confirmed',
    label: 'Spawn confirmed',
    confirmed: true,
    observedAt: '2026-09-01T22:35:23.000Z',
    confirmedAt: '2026-09-01T22:35:23.000Z',
    respawnsRemaining: 2,
  });

  const refused = projectShopFulfillmentStatus({
    spawn_method: 'event', item_type: 'event_rental', event_name: 'VehicleRental204',
    restarts_remaining: 1, is_active: true, checked_out_at: '2026-09-01T22:30:00.000Z',
  }, new Map([['VehicleRental204', {
    status: 'warning', successfulInstances: 0, refusals: 1, failures: 0,
    lastAttempt: { observedAt: '2026-09-01T22:35:23.000Z' },
    lastRefusal: { observedAt: '2026-09-01T22:35:24.000Z' },
  }]]), { evidenceAvailable: true, chronologyVerified: true });
  assert.strictEqual(refused.state, 'spawn_refused');
  assert.strictEqual(refused.label, 'Spawn refused');
  assert.strictEqual(refused.confirmed, false);
  assert.strictEqual(refused.observedAt, '2026-09-01T22:35:24.000Z');
  assert.strictEqual(refused.respawnsRemaining, 1);

  const awaiting = projectShopFulfillmentStatus({
    spawn_method: 'event', item_type: 'event_rental', event_name: 'VehicleRental205',
    restarts_remaining: 3, is_active: true,
  }, new Map([['VehicleRental205', {
    status: 'spawned', successfulInstances: 1,
    lastSuccess: { observedAt: '2026-09-01T22:35:23.000Z' },
  }]]), { evidenceAvailable: true, chronologyVerified: true });
  assert.strictEqual(awaiting.state, 'awaiting_spawn_evidence');
  assert.strictEqual(awaiting.respawnsRemaining, 3);

  const staleAggregateRefusal = projectShopFulfillmentStatus({
    spawn_method: 'event', item_type: 'event_rental', event_name: 'VehicleRental207',
    restarts_remaining: 1, is_active: true, checked_out_at: '2026-09-01T22:30:00.000Z',
  }, new Map([['VehicleRental207', {
    status: 'warning', attempts: 2, refusals: 1, failures: 0,
    lastAttempt: { observedAt: '2026-09-01T22:35:23.000Z' },
    lastRefusal: { observedAt: '2026-09-01T22:20:00.000Z' },
  }]]), { evidenceAvailable: true, chronologyVerified: true });
  assert.strictEqual(staleAggregateRefusal.state, 'spawn_attempted');

  const laterFailure = projectShopFulfillmentStatus({
    spawn_method: 'event', item_type: 'event_rental', event_name: 'VehicleRentalLatest',
    restarts_remaining: 1, is_active: true, checked_out_at: '2026-09-01T22:30:00.000Z',
  }, new Map([['VehicleRentalLatest', {
    successfulInstances: 1, failures: 1, refusals: 0, attempts: 2,
    lastSuccess: { observedAt: '2026-09-01T22:35:00.000Z' },
    lastFailure: { observedAt: '2026-09-01T22:40:00.000Z' },
    lastAttempt: { observedAt: '2026-09-01T22:39:59.000Z' },
  }]]), { evidenceAvailable: true, chronologyVerified: true });
  assert.strictEqual(laterFailure.state, 'spawn_failed',
    'fulfillment must project the newest post-checkout outcome, not success precedence');

  const sameTimestampLaterLine = projectShopFulfillmentStatus({
    spawn_method: 'event', item_type: 'event_rental', event_name: 'VehicleRentalSameClock',
    restarts_remaining: 1, is_active: true, checked_out_at: '2026-09-01T22:30:00.000Z',
  }, new Map([['VehicleRentalSameClock', {
    successfulInstances: 1, failures: 1, refusals: 0, attempts: 2,
    lastSuccess: { observedAt: '2026-09-01T22:35:00.000Z', sourceLine: 10 },
    lastFailure: { observedAt: '2026-09-01T22:35:00.000Z', sourceLine: 20 },
  }]]), { evidenceAvailable: true, chronologyVerified: true });
  assert.strictEqual(sameTimestampLaterLine.state, 'spawn_failed',
    'equal-clock fulfillment outcomes must use the later authoritative source line');

  const unverifiedChronology = projectShopFulfillmentStatus({
    spawn_method: 'event', item_type: 'event_rental', event_name: 'VehicleRental208',
    restarts_remaining: 1, is_active: true, checked_out_at: '2026-09-01T22:30:00.000Z',
  }, new Map([['VehicleRental208', {
    status: 'spawned', successfulInstances: 1,
    lastSuccess: { observedAt: '2026-09-01T22:35:23.000Z' },
  }]]), { evidenceAvailable: true, chronologyVerified: false });
  assert.strictEqual(unverifiedChronology.state, 'evidence_unavailable');

  const unavailable = projectShopFulfillmentStatus({
    spawn_method: 'event', item_type: 'event_rental', event_name: 'VehicleRental209',
    restarts_remaining: 1, is_active: true, checked_out_at: '2026-09-01T22:30:00.000Z',
  }, new Map(), { evidenceAvailable: false, chronologyVerified: false });
  assert.strictEqual(unavailable.state, 'evidence_unavailable');

  const inactive = projectShopFulfillmentStatus({
    spawn_method: 'event', item_type: 'event_rental', event_name: 'VehicleRental206',
    restarts_remaining: 0, is_active: false,
  }, new Map());
  assert.strictEqual(inactive.state, 'inactive');
  assert.strictEqual(inactive.respawnsRemaining, 0);

  const virtualItem = projectShopFulfillmentStatus({
    spawn_method: 'capability', item_type: 'item', is_active: true,
  }, new Map());
  assert.strictEqual(virtualItem.state, 'activated');
  assert.strictEqual(virtualItem.respawnsRemaining, null);

  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'shop.js'), 'utf8');
  const player = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'shop.js'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'shop-admin.js'), 'utf8');
  const adminPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard', 'shop-admin.html'), 'utf8');

  const fulfillmentService = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'shopFulfillmentStatusService.js'), 'utf8'
  );
  assert.match(fulfillmentService, /SHOP_EVIDENCE_WAIT_MS\s*=\s*2 \* 1000/,
    'ordinary shop reads must not wait for the full RPT worker timeout');
  assert.match(route, /attachShopFulfillmentStatuses/,
    'shop APIs must project authoritative runtime evidence onto order lines');
  assert.match(player, /Spawn confirmed/,
    'player shop must render spawn confirmation');
  assert.match(player, /scheduled restarts remaining/i,
    'player shop must preserve the scheduled-restart counter semantics');
  assert.match(admin, /Spawn confirmed/,
    'admin shop must render spawn confirmation');
  assert.match(player, /let shopContextGeneration = 0/,
    'player shop must invalidate async fulfillment loads when selectors change');
  assert.match(player, /generation !== shopContextGeneration/,
    'player shop must reject stale fulfillment responses');
  for (const loader of ['loadBalance', 'loadCart', 'refreshCartBadge']) {
    const body = player.match(new RegExp(`async function ${loader}\\([^]*?\\n}`))?.[0] || '';
    assert.match(body, /generation !== shopContextGeneration/,
      `player ${loader} must reject stale selector responses`);
  }
  const loadItemsBody = player.match(/async function loadItems\([^]*?\n}/)?.[0] || '';
  assert.match(loadItemsBody, /serverId !== currentServerId/,
    'server-scoped catalog loads must reject responses for another server');
  for (const loader of ['loadItems', 'loadBalance', 'loadCart', 'refreshCartBadge',
    'loadActiveRentals', 'loadOrders']) {
    const body = player.match(new RegExp(`async function ${loader}\\([^]*?\\n}`))?.[0] || '';
    assert.match(body, /requestId/,
      `player ${loader} must reject older same-context responses`);
  }
  const mapPicker = player.match(/async function openMapPicker\(\)[^]*?\n}/)?.[0] || '';
  assert.match(mapPicker, /generation !== shopContextGeneration/,
    'map picker must reject responses from a previous selector context');
  assert.match(mapPicker, /requestId/,
    'map picker must reject older same-context responses and delayed initialization');
  for (const mutation of ['confirmAddToCart', 'updateCartItemQty', 'removeCartItem', 'checkout']) {
    const body = player.match(new RegExp(`async function ${mutation}\\([^]*?\\n}`))?.[0] || '';
    assert.match(body, /generation !== shopContextGeneration/,
      `player ${mutation} must reject stale mutation continuations`);
  }
  assert.match(player, /function onSelectorsChange\(\)[^]*?items-grid[^]*?Select a server to browse items/,
    'blank player server selection must synchronously clear the prior catalog');
  assert.match(player, /cartItems = \[\]/,
    'selector changes must clear stale cart controls immediately');
  assert.match(admin, /let adminContextGeneration = 0/,
    'admin shop must invalidate async fulfillment loads when servers change');
  assert.match(admin, /generation !== adminContextGeneration/,
    'admin shop must reject stale fulfillment responses');
  const adminItemsLoader = admin.match(/async function loadItems\(\)[^]*?\n}/)?.[0] || '';
  assert.match(adminItemsLoader, /generation !== adminContextGeneration/,
    'admin item loads must reject stale server responses');
  for (const loader of ['loadPresets', 'loadRadarAudit', 'loadAnalytics']) {
    const body = admin.match(new RegExp(`async function ${loader}\\([^]*?\\n}`))?.[0] || '';
    assert.match(body, /generation !== adminContextGeneration/,
      `admin ${loader} must reject stale server responses`);
  }
  for (const loader of ['loadItems', 'loadPresets', 'loadRadarAudit', 'loadAnalytics',
    'loadOrders', 'loadRentals']) {
    const body = admin.match(new RegExp(`async function ${loader}\\([^]*?\\n}`))?.[0] || '';
    assert.match(body, /requestId/,
      `admin ${loader} must reject older same-context responses`);
  }
  for (const mutation of ['runBulkAction', 'toggleItemActive', 'saveItem', 'deleteItem',
    'addPreset', 'deletePreset', 'refundOrder']) {
    const body = admin.match(new RegExp(`async function ${mutation}\\([^]*?\\n}`))?.[0] || '';
    assert.match(body, /Generation !== adminContextGeneration/,
      `admin ${mutation} must reject stale mutation continuations`);
  }
  assert.match(admin, /saveItemId !== editingItemId/,
    'a late save response must not cancel a newer same-server item editor');
  assert.match(admin, /saveEditorToken !== editingEditorToken/,
    'a late save response must not cancel a reopened editor for the same item');
  assert.match(player, /let atcModalToken = 0/,
    'add-to-cart modal openings must have distinct lifecycle identity');
  const addMutation = player.match(/async function confirmAddToCart\(\)[^]*?\n}/)?.[0] || '';
  assert.match(addMutation, /modalToken !== atcModalToken/,
    'a late add response must not close a reopened modal for the same item');
  const qtyMutation = player.match(/async function updateCartItemQty\([^]*?\n}/)?.[0] || '';
  assert.match(qtyMutation, /!res\.ok/,
    'cart quantity updates must reject non-success HTTP responses');
  assert.match(qtyMutation, /loadCart\(\)/,
    'rejected cart quantity updates must restore authoritative cart state');
  assert.match(qtyMutation, /alert\(/,
    'rejected cart quantity updates must inform the player');
  assert.match(fulfillmentService, /expectedSourceFile/,
    'fulfillment chronology must bind the restart anchor to an exact RPT artifact');
  assert.match(admin, /function onServerChange\(\)[^]*?radar-activation-summary[^]*?stat-revenue/,
    'admin server changes must synchronously clear radar and analytics surfaces');
  assert.match(admin, /function onServerChange\(\)[^]*?cancelEdit\(\)/,
    'admin server changes must cancel an editor opened for the previous server');
  assert.match(route, /CASE WHEN soi\.snapshot_schema_version = 1 THEN soi\.event_name_snapshot ELSE si\.event_name END AS event_name/g,
    'every fulfillment query must project a legacy catalog event-name fallback');
  assert.ok((route.match(/CASE WHEN soi\.snapshot_schema_version = 1 THEN soi\.event_name_snapshot ELSE si\.event_name END AS event_name/g) || []).length >= 4,
    'admin order items, admin rentals, player orders, and player rentals need event-name fallback');
  assert.match(fulfillmentService,
    /WHERE server_id = \?[\s\S]*provider_started_at IS NOT NULL[\s\S]*evidence_source_file IS NOT NULL[\s\S]*ORDER BY provider_started_at DESC/,
    'fulfillment chronology must require an exact-server provider boundary and RPT artifact');
  assert.match(adminPage, /Scheduled Restarts Remaining/,
    'admin rental table must preserve the scheduled-restart counter semantics');

  console.log('Shop fulfillment status regression test passed.');
}

main();
