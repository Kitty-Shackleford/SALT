'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const teleportService = require('../services/teleportService');
const linkTrust = require('../utils/linkTrust');
const moneySupplyManager = require('../utils/moneySupplyManager');
const spawnExclusionService = require('../services/spawnExclusionService');
const radarService = require('../services/radarService');

let eligibilityError = null;
const lifecycle = [];
teleportService.lockPlayerTeleportEligibility = async () => {
  lifecycle.push('eligibility');
  if (eligibilityError) throw eligibilityError;
  return {};
};
teleportService.requestPlayerTeleport = async (_db, input) => {
  lifecycle.push('request');
  return { id: 90, order_item_id: input.orderItemId };
};
linkTrust.lockTrustedFinancialIdentity = async () => ({});
moneySupplyManager.lockSupplyForUpdate = async () => ({ fixed_supply_enabled: false });
spawnExclusionService.assertEventPlacementsAllowed = async () => {};
radarService.activateRadarCapabilities = async () => {};

const {
  processCheckout,
  processRefund,
  cancelRefundableTeleportRequests,
  validateProvisioningItem,
} = require('../services/shopFileService');

function checkoutDb(itemOverrides = {}) {
  const writes = [];
  const reads = [];
  const order = { id: 10, server_id: 1, identity_id: 5, status: 'cart' };
  const item = {
    id: 11,
    order_id: 10,
    shop_item_id: 20,
    spawn_method: 'capability',
    capability_config: { capability: 'teleport', destinationId: 7 },
    item_type: 'permanent',
    quantity: 1,
    unit_price: '25.00',
    catalog_server_id: 1,
    catalog_is_active: true,
    ...itemOverrides,
  };
  return {
    writes,
    reads,
    async acquireTransactionAdvisoryLock() {},
    onTransactionRollback() {},
    async get(sql) {
      reads.push(sql);
      if (/SELECT \* FROM shop_orders/.test(sql)) return order;
      if (/COUNT\(\*\).*shop_order_items/.test(sql)) return { cart_line_count: 1 };
      if (/player_wallets/.test(sql)) return { cash_on_hand: '100.00' };
      throw new Error(`Unexpected checkout get: ${sql}`);
    },
    async query(sql, params) {
      if (/SELECT soi\.\*/.test(sql)) return [{ ...item }];
      writes.push({ sql, params });
      lifecycle.push(/UPDATE player_wallets/.test(sql) ? 'debit' : 'write');
      return [];
    },
  };
}

(async () => {
  const shopSource = fs.readFileSync(path.join(__dirname, '../services/shopFileService.js'), 'utf8');
  assert.match(shopSource, /teleportItems\.length === 1 && items\.length !== 1/,
    'teleport orders must be isolated so an expiry can refund the exact purchase');

  assert.doesNotThrow(() => validateProvisioningItem({
    spawn_method: 'cfgEffectArea',
    item_class: 'ContaminatedArea_Static',
  }), 'explicit EffectArea-class products must remain provisionable');
  for (const itemClass of ['Flag_APA', 'AKM', 'ContaminatedArea_Dynamic']) {
    assert.doesNotThrow(() => validateProvisioningItem({
      spawn_method: 'cfgEffectArea',
      item_class: itemClass,
    }), `cfgEffectArea compatibility mode must accept ${itemClass}`);
  }
  assert.throws(() => validateProvisioningItem({
    spawn_method: 'cfgEffectArea',
    item_class: ' Survivor ',
  }), /Shop item class is required for provisioning/,
  'cfgEffectArea must reject whitespace-padded class names');
  assert.throws(() => validateProvisioningItem({
    spawn_method: 'cfgEffectArea',
    item_class: 'bad class name',
  }), /Shop item class is required for provisioning/);

  const deniedDb = checkoutDb();
  const restriction = new Error('Active PRA restriction prevents this teleport');
  restriction.code = 'PRA_RESTRICTED';
  eligibilityError = restriction;
  await assert.rejects(processCheckout(deniedDb, 10, 6), error => error.code === 'PRA_RESTRICTED');
  assert(!deniedDb.writes.some(call => /UPDATE player_wallets|UPDATE player_bank_accounts/.test(call.sql)));

  lifecycle.length = 0;
  eligibilityError = null;
  const allowedDb = checkoutDb();
  const result = await processCheckout(allowedDb, 10, 6);
  assert.deepStrictEqual(result, { success: true, totalCharged: 25 });
  assert(lifecycle.indexOf('eligibility') >= 0);
  assert(lifecycle.indexOf('debit') > lifecycle.indexOf('eligibility'));
  assert(lifecycle.indexOf('request') > lifecycle.indexOf('debit'));
  assert(allowedDb.writes.some(call => /UPDATE shop_orders SET status/.test(call.sql)));

  const refundCalls = [];
  const refundDb = {
    async query(sql, params) {
      refundCalls.push({ sql, params });
      if (/SELECT tr\./.test(sql)) {
        return [{ id: 90, guild_id: 2, server_id: 1, identity_id: 5,
          requested_by_user_id: 6, order_item_id: 11, status: 'waiting_disconnect' }];
      }
      return [];
    },
  };
  await cancelRefundableTeleportRequests(refundDb, 1, [11]);
  assert(refundCalls.some(call => /UPDATE teleport_requests/.test(call.sql) && /cancelled/.test(call.sql)));
  assert(refundCalls.some(call => /INSERT INTO teleport_events/.test(call.sql)));

  for (const status of ['armed', 'cleanup_pending', 'cleanup_processing', 'cleanup_restart_pending']) {
    await assert.rejects(cancelRefundableTeleportRequests({
      async query(sql) {
        if (/SELECT tr\./.test(sql)) {
          return [{ id: 91, server_id: 1, order_item_id: 12, status }];
        }
        throw new Error(`Unexpected irreversible refund query: ${sql}`);
      },
    }, 1, [12]), error => error.code === 'TELEPORT_REFUND_UNAVAILABLE');
  }

  const overflowCalls = [];
  let refundFixtureAmount = '25.00';
  let refundFixtureWallet = '999999999999999999.99';
  const overflowOrder = {
    id: 70, server_id: 1, identity_id: 5, status: 'completed', total_price: refundFixtureAmount,
  };
  const overflowRefundDb = {
    async acquireTransactionAdvisoryLock() {},
    async get(sql, params) {
      overflowCalls.push({ method: 'get', sql, params });
      if (/SELECT \* FROM shop_orders/.test(sql)) return { ...overflowOrder, total_price: refundFixtureAmount };
      if (/SELECT cash_on_hand FROM player_wallets/.test(sql)) {
        return { cash_on_hand: refundFixtureWallet };
      }
      if (/SELECT clock_timestamp\(\) AS observed_at/.test(sql)) {
        return { observed_at: '2026-08-31T15:00:00.000Z' };
      }
      if (/INSERT INTO financial_refund_claims/.test(sql)) {
        return {
          id: 700, server_id: 1, identity_id: 5, amount: refundFixtureAmount,
          source_type: 'shop_order_refund', source_key: '70',
          reason: 'destination_wallet_capacity_exceeded', status: 'pending',
        };
      }
      if (/INSERT INTO economy_transactions/.test(sql)) return { id: 701 };
      throw new Error(`Unexpected overflow-refund get: ${sql}`);
    },
    async query(sql, params) {
      overflowCalls.push({ method: 'query', sql, params });
      if (/INSERT INTO player_wallets|UPDATE player_wallets/.test(sql)) return [];
      if (/SELECT soi\.id, soi\.quantity/.test(sql)) {
        return [{ id: 11, quantity: 1, unit_price: refundFixtureAmount, restarts_remaining: null,
          is_active: true, item_type: 'permanent' }];
      }
      if (/SELECT account_type, amount/.test(sql) && /shop_order_payment_allocations/.test(sql)) {
        return [{ account_type: 'wallet', amount: refundFixtureAmount }];
      }
      if (/SELECT order_item_id, previous_restarts_remaining/.test(sql) &&
          /shop_rental_consumption_events/.test(sql)) return [];
      if (/SELECT id FROM shop_order_items/.test(sql)) return [];
      if (/INSERT INTO shop_refund_decisions/.test(sql)) return [];
      throw new Error(`Unexpected overflow-refund query: ${sql}`);
    },
    async run(sql, params) {
      overflowCalls.push({ method: 'run', sql, params });
      if (/UPDATE shop_orders SET status = 'refunded'/.test(sql)) return { changes: 1 };
      throw new Error(`Unexpected overflow-refund run: ${sql}`);
    },
  };
  const overflowRefund = await processRefund(overflowRefundDb, 70, 1, {
    approvedByUserId: 6,
    reasonCode: 'provider_failure',
    adminNote: '',
    approvedAmount: '25.00',
    override: false,
  });
  assert.deepStrictEqual(overflowRefund, {
    success: true, refunded: '25.00', deferred: true, claimId: 700,
  });
  assert(overflowCalls.some(call => /INSERT INTO financial_refund_claims/.test(call.sql)),
    'wallet-capacity overflow must create one durable exact-server refund obligation');
  assert(!overflowCalls.some(call => /UPDATE player_wallets SET cash_on_hand/.test(call.sql)),
    'a deferred refund must not write an overflowing wallet balance');
  assert(!overflowCalls.some(call => /INSERT INTO economy_transactions/.test(call.sql)),
    'a deferred refund must not claim that the wallet was credited');
  assert(overflowCalls.some(call => /UPDATE shop_orders SET status = 'refunded'/.test(call.sql)),
    'a deferred claim must terminalize the source order for replay safety');

  refundFixtureAmount = '90071992547409.93';
  refundFixtureWallet = '0.00';
  overflowCalls.length = 0;
  const exactBoundaryRefund = await processRefund(overflowRefundDb, 70, 1, {
    approvedByUserId: 6,
    reasonCode: 'provider_failure',
    adminNote: '',
    approvedAmount: refundFixtureAmount,
    override: false,
  });
  assert.deepStrictEqual(exactBoundaryRefund, {
    success: true, refunded: '90071992547409.93',
  }, 'refund API results must preserve exact NUMERIC(20,2) text beyond JavaScript safe cents');
  assert(!overflowCalls.some(call => /INSERT INTO financial_refund_claims/.test(call.sql)),
    'an exact refund that fits NUMERIC(20,2) must credit the wallet immediately');
  const boundaryWallet = overflowCalls.find(call => /UPDATE player_wallets/.test(call.sql));
  assert.strictEqual(boundaryWallet.params[2], '90071992547409.93',
    'wallet credit must receive the exact boundary amount');
  const boundaryLedger = overflowCalls.find(call => /INSERT INTO economy_transactions/.test(call.sql));
  assert.strictEqual(boundaryLedger.params[2], '90071992547409.93',
    'refund ledger must receive the exact boundary amount');

  console.log('✅ Teleport shop checkout tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
