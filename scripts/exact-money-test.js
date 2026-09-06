'use strict';

const assert = require('assert');
const {
  parseCents,
  checkedAddCents,
  centsToAmount,
  percentageOfCents,
  multiplyCents,
} = require('../utils/money');

assert.strictEqual(parseCents('10.25', 'Amount'), 1025);
assert.strictEqual(parseCents(0.1, 'Amount'), 10);
assert.strictEqual(centsToAmount(1025), 10.25);
for (const invalid of ['1.001', 1.001, '1e2', NaN, Infinity, true, null]) {
  assert.throws(() => parseCents(invalid, 'Amount'), /at most two decimals|valid amount/i);
}
assert.strictEqual(percentageOfCents(1001, '2.50'), 25,
  'percentage fees use deterministic half-up cent rounding');
assert.strictEqual(percentageOfCents(1010, '2.50'), 25);
assert.strictEqual(percentageOfCents(1020, '2.50'), 26);
assert.strictEqual(multiplyCents(5, 2.5), 13,
  'casino payouts use the same deterministic half-up rule');
assert.strictEqual(multiplyCents(1, 0.5), 1);

assert.strictEqual(parseCents('90071992547409.91', 'Amount'), Number.MAX_SAFE_INTEGER,
  'the exact safe-cent ceiling is accepted');
assert.throws(() => parseCents('90071992547409.92', 'Amount'), /supported exact range/i,
  'one cent above the exact safe-cent ceiling is rejected');
assert.strictEqual(
  checkedAddCents(0n, 9007199254740993n, 'NUMERIC wallet'),
  9007199254740993n,
  'BigInt wallet arithmetic must use the NUMERIC(20,2) domain rather than the JavaScript safe range'
);
assert.throws(
  () => checkedAddCents(99999999999999999999n, 1n, 'NUMERIC wallet'),
  error => error.status === 409 && /capacity exceeded/i.test(error.message),
  'BigInt wallet arithmetic must still reject values above NUMERIC(20,2)'
);

const economyRouteSource = require('fs').readFileSync(require('path').join(__dirname, '../routes/economy.js'), 'utf8');
const configValidation = economyRouteSource.slice(
  economyRouteSource.indexOf("router.post('/admin/:serverId/config'"),
  economyRouteSource.indexOf("router.get('/admin/:serverId/stats'")
);
assert.match(configValidation, /parseCents\(value, `Economy setting \$\{key\}`\)/,
  'every economy monetary setting must use the shared exact-cent parser');
assert.doesNotMatch(configValidation, /Math\.abs\(value \* 100/,
  'economy monetary validation must not use floating-point cent checks');

const casino = require('../routes/casino')._test;
assert.match(casino.parseWager('1.001', { casino_min_bet: '1.00', casino_max_bet: '100.00' }).error,
  /at most (?:two|2) decimals/i);
assert.strictEqual(casino.casinoPayout('0.05', 2.5), 0.13);
assert.strictEqual(casino.casinoSum('0.10', '0.20'), 0.3);
assert.strictEqual(casino.casinoNet('0.30', '0.10'), 0.2);

const shop = require('../services/shopFileService');
assert.strictEqual(shop.sumLineItemCents([
  { unit_price: '0.10', quantity: 3 },
  { unit_price: '1.25', quantity: 2 },
]), 280, 'shop totals sum integer cents without floating drift');
assert.strictEqual(shop.exactShopRefundAmount('2.80'), 2.8,
  'shop refunds preserve the exact persisted order total');
assert.throws(() => shop.exactShopRefundAmount('2.801'), /at most (?:two|2) decimals/i);

console.log('exact money tests passed');
