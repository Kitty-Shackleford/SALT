'use strict';

const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();

const assert = require('assert');
const {
  getTeleportCostConfig,
  chargeTeleportCost,
  refundTeleportWalletCharge,
  processTeleportWalletRefunds,
} = require('../services/teleportCostService');

/**
 * Fake DB that mirrors the minimal state machine the cost service needs:
 * guild_economy_config, player_wallets, economy_transactions,
 * teleport_wallet_charges. `transaction` runs the callback in place
 * (the real adapter wraps it; idempotency guarantees must hold anyway).
 */
function fakeDb({
  costEnabled = true,
  economyEnabled = true,
  costValue = '2.50',
  walletBalance = '10.00',
  preexistingCharges = [],
} = {}) {
  const state = {
    config: costEnabled || costValue
      ? {
        enabled: economyEnabled,
        teleport_cost_enabled: costEnabled,
        teleport_cost: costValue,
        starting_cash: 0,
      }
      : null,
    wallet: walletBalance === null ? null : walletBalance,
    ledger: [],
    charges: preexistingCharges.map(charge => ({ ...charge })),
    nextChargeId: preexistingCharges.length + 1,
    refundCalls: [],
    walletUpdates: [],
    nextRequestIdSeen: null,
  };
  const db = {
    state,
    async get(sql, params) {
      if (/FROM guild_economy_config/.test(sql)) return state.config;
      if (/FROM servers/.test(sql)) return { id: 1, guild_id: 2 };
      if (/UPDATE player_wallets SET cash_on_hand = cash_on_hand - /.test(sql)) {
        const current = Number(state.wallet || 0);
        const amount = Number(params[0]);
        if (state.wallet == null || current < amount) return null;
        state.wallet = (current - amount).toFixed(2);
        state.walletUpdates.push('debit');
        return { cash_on_hand: state.wallet };
      }
      if (/UPDATE player_wallets SET cash_on_hand = cash_on_hand \+/.test(sql)) {
        const current = Number(state.wallet || 0);
        state.wallet = (current + Number(params[0])).toFixed(2);
        state.walletUpdates.push('credit');
        return { cash_on_hand: state.wallet };
      }
      if (/FROM player_wallets/.test(sql)) {
        return state.wallet == null ? null : { cash_on_hand: state.wallet };
      }
      if (/FROM teleport_wallet_charges/.test(sql)) {
        for (const charge of state.charges) {
          if (charge.status === 'pending' && Number(charge.teleport_request_id) === Number(params[0])) {
            return { id: charge.id, identity_id: charge.identity_id, amount: charge.amount };
          }
        }
        return null;
      }
      throw new Error(`Unexpected get: ${sql}`);
    },
    async query(sql, params) {
      if (/INSERT INTO teleport_wallet_charges/.test(sql)) {
        const requestId = params[0];
        if (state.charges.some(charge => charge.teleport_request_id === requestId)) {
          return []; // ON CONFLICT (teleport_request_id) DO NOTHING
        }
        const id = state.nextChargeId++;
        state.charges.push({
          id,
          teleport_request_id: requestId,
          server_id: params[1],
          identity_id: params[2],
          amount: params[3],
          status: 'pending',
        });
        return [{ id }];
      }
      if (/UPDATE teleport_wallet_charges/.test(sql)) {
        const charge = state.charges.find(item => item.id === params[0]);
        if (!charge || charge.status !== 'pending') return [];
        charge.status = 'refunded';
        return [{ id: charge.id }];
      }
      if (/UPDATE teleport_requests SET refunded_at/.test(sql)) {
        state.requestRefunded = true;
        return [];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run(sql, params) {
      if (/INSERT INTO player_wallets/.test(sql)) {
        if (state.wallet == null) {
          state.wallet = '0.00';
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      if (/INSERT INTO economy_supply_log/.test(sql)) return { changes: 1 };
      if (/INSERT INTO economy_transactions/.test(sql)) {
        state.ledger.push({
          type: /debit/.test(sql) ? 'debit' : /credit/.test(sql) ? 'credit' : 'other',
          amount: params[2],
        });
        return { changes: 1 };
      }
      throw new Error(`Unexpected run: ${sql}`);
    },
    async transaction(callback) {
      return callback(db);
    },
    getWallets() { return state.wallet; },
    getCharges() { return state.charges; },
    getLedger() { return state.ledger; },
  };
  return db;
}

(async () => {
  // Config gate: feature off -> no charge.
  const offDb = fakeDb({ costEnabled: false });
  assert.deepStrictEqual(await chargeTeleportCost(offDb, {
    serverId: 1, identityId: 5, requestId: 100,
  }), { charged: false, amountCents: 0, requestId: 100 });
  assert.strictEqual(offDb.getLedger().length, 0);

  // No config row at all -> no charge.
  const noConfigDb = fakeDb({ costEnabled: false, costValue: null });
  noConfigDb.state.config = null;
  assert.deepStrictEqual(await chargeTeleportCost(noConfigDb, {
    serverId: 1, identityId: 5, requestId: 100,
  }), { charged: false, amountCents: 0, requestId: 100 });

  // Enabled: charge deducts exactly, writes ledger + charge row.
  const db = fakeDb();
  const first = await chargeTeleportCost(db, { serverId: 1, identityId: 5, requestId: 100 });
  assert.deepStrictEqual(first, { charged: true, amountCents: 250, requestId: 100 });
  assert.strictEqual(db.getWallets(), '7.50');
  assert.strictEqual(db.getLedger().length, 1);
  assert.strictEqual(db.getLedger()[0].amount, '-2.50');
  assert.strictEqual(db.getCharges().length, 1);
  assert.strictEqual(db.getCharges()[0].status, 'pending');

  // Idempotent retry with the same request id: no second deduction.
  const retry = await chargeTeleportCost(db, { serverId: 1, identityId: 5, requestId: 100 });
  assert.deepStrictEqual(retry, { charged: true, amountCents: 250, requestId: 100 });
  assert.strictEqual(db.getWallets(), '7.50');
  assert.strictEqual(db.getLedger().length, 1);
  assert.strictEqual(db.getCharges().length, 1);

  // Insufficient funds: 409, no ledger entry, no charge row.
  const poorDb = fakeDb({ walletBalance: '1.00' });
  await assert.rejects(
    chargeTeleportCost(poorDb, { serverId: 1, identityId: 5, requestId: 101 }),
    error => error.code === 'TELEPORT_COST_INSUFFICIENT_FUNDS' && error.status === 409
  );
  assert.strictEqual(poorDb.getLedger().length, 0);
  assert.strictEqual(poorDb.getCharges().length, 0);

  // Refund: restores balance, flips charge state, writes credit ledger,
  // and stamps the request.
  const refunded = await refundTeleportWalletCharge(db, {
    requestId: 100, serverId: 1, identityId: 5, reason: 'teleport_failed',
  });
  assert.deepStrictEqual(refunded, { refunded: true, amountCents: 250 });
  assert.strictEqual(db.getWallets(), '10.00');
  assert.strictEqual(db.getLedger().length, 2);
  assert.strictEqual(db.getLedger()[1].amount, '2.50');
  assert.strictEqual(db.getCharges()[0].status, 'refunded');
  assert.strictEqual(db.state.requestRefunded, true);

  // Refund is idempotent: a second call is a no-op.
  const again = await refundTeleportWalletCharge(db, {
    requestId: 100, serverId: 1, identityId: 5,
  });
  assert.deepStrictEqual(again, { refunded: false, amountCents: 0 });
  assert.strictEqual(db.getWallets(), '10.00');
  assert.strictEqual(db.getLedger().length, 2);

  // Config reader shapes.
  assert.deepStrictEqual(await getTeleportCostConfig(db, 1), {
    serverId: 1, costCents: 250, costLabel: 2.5,
  });
  assert.strictEqual(await getTeleportCostConfig(offDb, 1), null);
  const zeroDb = fakeDb({ costEnabled: true, costValue: '0.00' });
  assert.strictEqual(await getTeleportCostConfig(zeroDb, 1), null);

  // Crash-recovery sweep refunds pending charges for failed requests and
  // orphans, exactly once each.
  const sweepDb = fakeDb({ walletBalance: '5.00', preexistingCharges: [
    { id: 1, teleport_request_id: 100, server_id: 1, identity_id: 5, amount: '2.50', status: 'pending' },
    { id: 2, teleport_request_id: 101, server_id: 1, identity_id: 5, amount: '2.50', status: 'pending' },
    { id: 3, teleport_request_id: 102, server_id: 1, identity_id: 5, amount: '2.50', status: 'refunded' },
  ] });
  // Intercept ONLY the sweep's candidate lookup; everything else uses the
  // real fake behavior.
  const originalQuery = sweepDb.query.bind(sweepDb);
  sweepDb.query = async (sql, params) => {
    if (/FROM teleport_wallet_charges twc/.test(sql)) {
      return [
        { id: 1, teleport_request_id: 100, server_id: 1, identity_id: 5, final_status: 'failed', failed_at: new Date() },
        { id: 2, teleport_request_id: 101, server_id: 1, identity_id: 5, final_status: null, failed_at: null },
      ];
    }
    return originalQuery(sql, params);
  };
  const sweepRefunds = await processTeleportWalletRefunds(sweepDb, 1);
  assert.strictEqual(sweepRefunds, 2, 'sweep refunds exactly the two recoverable charges');
  assert.strictEqual(sweepDb.getWallets(), '10.00');
  assert.strictEqual(sweepDb.getLedger().length, 2);
  const statuses = sweepDb.getCharges()
    .filter(charge => charge.teleport_request_id !== 102)
    .map(charge => charge.status).sort();
  assert.deepStrictEqual(statuses, ['refunded', 'refunded']);

  console.log('✅ Teleport cost service tests passed');
})().catch(error => {
  console.error('❌ Teleport cost service test failed:', error);
  process.exit(1);
});
