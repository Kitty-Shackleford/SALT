'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../routes/shop.js'), 'utf8');

function routeBody(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Route markers must exist: ${startMarker}`);
  return source.slice(start, end);
}

const itemsRoute = routeBody("router.get('/items/:serverId'", "router.get('/cart/:identityId/:serverId'");
assert.match(itemsRoute, /shop_item_id = ANY\(\$1::bigint\[\]\)/,
  'catalog presets must load in one set query');
assert.doesNotMatch(itemsRoute, /for \(const item of purchasableItems\)[\s\S]*?await db\.query/,
  'catalog loading must not query once per item');

const ordersRoute = routeBody("router.get('/orders/:identityId'", "router.get('/servers'");
assert.match(ordersRoute, /soi\.order_id = ANY\(\$1::bigint\[\]\)/,
  'order line items must load in one set query');
assert.doesNotMatch(ordersRoute, /for \(const order of orders\)[\s\S]*?await db\.query/,
  'order history must not query once per order');

const balanceRoute = routeBody("router.get('/balance/:identityId/:serverId'", "router.get('/active-rentals/:identityId/:serverId'");
assert.strictEqual((balanceRoute.match(/await db\.get\(/g) || []).length, 1,
  'balance loading must use one query after ownership verification');

const clientSource = fs.readFileSync(path.join(__dirname, '../public/js/shop.js'), 'utf8');
assert.match(clientSource, /displayedCatalogServerId/,
  'identity-only selector changes must reuse the already-rendered server catalog');
const checkoutBody = clientSource.slice(
  clientSource.indexOf('async function checkout()'),
  clientSource.indexOf('// ── Active Rentals')
);
assert.doesNotMatch(checkoutBody, /loadCart\(\)/,
  'successful checkout must not reload the hidden cart before switching to order history');

console.log('Shop read-path query batching tests passed');
