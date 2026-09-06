'use strict';

const assert = require('assert');
const { insertOrVerifyPendingRefundClaim } = require('../utils/refundClaimManager');

function claimInput(overrides = {}) {
  return {
    serverId: 7,
    identityId: 11,
    amountCents: 2550,
    sourceType: 'bounty_award',
    sourceKey: '90',
    reason: 'destination_wallet_capacity_exceeded',
    createdAt: '2026-08-31T00:00:00.000Z',
    ...overrides,
  };
}

function storedClaim(overrides = {}) {
  return {
    id: 200,
    server_id: 7,
    identity_id: 11,
    amount: '25.50',
    source_type: 'bounty_award',
    source_key: '90',
    reason: 'destination_wallet_capacity_exceeded',
    status: 'pending',
    ...overrides,
  };
}

async function main() {
  const calls = [];
  const replayDb = {
    async get(sql, params) {
      calls.push({ sql, params });
      if (/INSERT INTO financial_refund_claims/.test(sql)) return null;
      if (/FROM financial_refund_claims/.test(sql)) return storedClaim();
      return null;
    },
  };
  assert.strictEqual(await insertOrVerifyPendingRefundClaim(replayDb, claimInput()), 200);
  assert(calls.some(call => /FOR UPDATE/.test(call.sql)),
    'an idempotent insert conflict must lock and verify the exact stored obligation');

  for (const mismatch of [
    { server_id: 8 }, { identity_id: 12 }, { amount: '25.51' },
    { reason: 'different' }, { status: 'claimed' },
  ]) {
    const db = {
      async get(sql) {
        if (/INSERT INTO financial_refund_claims/.test(sql)) return null;
        return storedClaim(mismatch);
      },
    };
    await assert.rejects(
      () => insertOrVerifyPendingRefundClaim(db, claimInput()),
      error => error.status === 409 && /conflict does not match/i.test(error.message)
    );
  }

  let persisted = null;
  const concurrentDb = {
    async get(sql) {
      if (/INSERT INTO financial_refund_claims/.test(sql)) {
        if (persisted) return null;
        persisted = storedClaim();
        return persisted;
      }
      if (/FROM financial_refund_claims/.test(sql)) return persisted;
      return null;
    },
  };
  const results = await Promise.all([
    insertOrVerifyPendingRefundClaim(concurrentDb, claimInput()),
    insertOrVerifyPendingRefundClaim(concurrentDb, claimInput()),
  ]);
  assert.deepStrictEqual(results, [200, 200]);
  assert.strictEqual(persisted.amount, '25.50', 'idempotent races retain one exact obligation');
  console.log('refund claim conflict behavior test passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
