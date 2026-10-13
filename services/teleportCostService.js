/**
 * Per-teleport wallet cost (A1.4)
 *
 * A fixed in-game-currency charge deducted from the player's wallet when a
 * player-sourced teleport is queued. Refunded atomically when the teleport
 * request fails or expires.
 *
 * Money movement mirrors the established patterns:
 *   - wallet row locked FOR UPDATE, exact-cent arithmetic (utils/money),
 *   - economy_transactions ledger entry with the post-transaction balance,
 *   - idempotency via teleport_wallet_charges (UNIQUE per teleport request,
 *     'pending' -> 'refunded' state machine) — same guarantee the shop uses
 *     with financial_refund_claims, scoped to the teleport request so a
 *     crash between charge and failure-handling cannot strand money: the
 *     processor sweep (processTeleportWalletRefunds) recovers 'pending'
 *     charges whose request failed or no longer exists.
 *
 * Shop-sourced teleports never carry a wallet charge: they are paid through
 * the shop order (order_item_id -> shop refund path).
 */
'use strict';

const { parseCents, centsToDecimal, centsToAmount } = require('../utils/money');
const { getOrCreateWallet } = require('../utils/economy');

function chargeError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

/**
 * Read the per-teleport cost config for a server. Returns null when the
 * feature is off for that server: no economy config row at all, economy
 * disabled, cost flag off, or cost zero. The feature depends on the economy
 * system being live (wallets are created from the config's starting cash).
 */
async function getTeleportCostConfig(db, serverId) {
  const row = await db.get(
    `SELECT enabled, teleport_cost_enabled, teleport_cost
     FROM guild_economy_config WHERE server_id = ?`,
    [serverId]
  );
  if (!row || row.enabled !== true || row.teleport_cost_enabled !== true) return null;
  const costCents = parseCents(row.teleport_cost, 'Teleport cost');
  if (costCents <= 0) return null;
  return { serverId, costCents, costLabel: centsToAmount(costCents) };
}

/**
 * Charge the player's wallet for a queued teleport request. Callers must run
 * this inside the same transaction as the teleport_requests insert so a
 * failed charge rolls back the request atomically.
 *
 * @param {object} db
 * @param {object} input { serverId, identityId, requestId }
 * @returns {Promise<{charged: boolean, amountCents: number, requestId: number}>}
 */
async function chargeTeleportCost(db, input) {
  const serverId = Number(input.serverId);
  const identityId = Number(input.identityId);
  const requestId = Number(input.requestId);
  if (!Number.isSafeInteger(serverId) || serverId < 1
      || !Number.isSafeInteger(identityId) || identityId < 1
      || !Number.isSafeInteger(requestId) || requestId < 1) {
    throw chargeError('TELEPORT_COST_INVALID_INPUT', 'Teleport cost input is invalid', 400);
  }
  const config = await getTeleportCostConfig(db, serverId);
  if (!config) return { charged: false, amountCents: 0, requestId };

  // Idempotency first: if this request already carries a charge row, verify
  // it and return without touching the wallet. (ON CONFLICT on the insert
  // below still guards the concurrent race; the loser throws and the caller's
  // transaction rolls back its deduction.)
  const existing = await db.get(
    `SELECT amount FROM teleport_wallet_charges
     WHERE teleport_request_id = ? FOR UPDATE`,
    [requestId]
  );
  if (existing) {
    if (parseCents(existing.amount, 'Existing charge') !== config.costCents) {
      throw chargeError('TELEPORT_COST_CONFLICT', 'A different charge already exists for this request', 409);
    }
    return { charged: true, amountCents: config.costCents, requestId };
  }

  await getOrCreateWallet(db, identityId, serverId);
  const wallet = await db.get(
    'SELECT cash_on_hand FROM player_wallets WHERE identity_id = ? AND server_id = ? FOR UPDATE',
    [identityId, serverId]
  );
  if (!wallet || parseCents(wallet.cash_on_hand, 'Wallet balance') < config.costCents) {
    const error = chargeError(
      'TELEPORT_COST_INSUFFICIENT_FUNDS',
      `Teleport cost is ${config.costLabel} but your wallet has insufficient funds`,
      409
    );
    throw error;
  }

  const updated = await db.get(
    `UPDATE player_wallets SET cash_on_hand = cash_on_hand - ?, last_updated = NOW()
     WHERE identity_id = ? AND server_id = ? AND cash_on_hand >= ?
     RETURNING cash_on_hand`,
    [centsToDecimal(config.costCents), identityId, serverId, centsToDecimal(config.costCents)]
  );
  if (!updated) throw chargeError('TELEPORT_COST_INSUFFICIENT_FUNDS', 'Wallet deduction failed', 409);
  const newBalanceCents = parseCents(updated.cash_on_hand, 'Wallet balance');

  await db.run(
    `INSERT INTO economy_transactions
     (identity_id, server_id, transaction_type, amount, balance_after, account_type,
      source, description, metadata, timestamp)
     VALUES (?, ?, 'debit', ?, ?, 'wallet', 'teleport_cost', 'Teleport request cost', ?, NOW())`,
    [identityId, serverId, centsToDecimal(-config.costCents), centsToDecimal(newBalanceCents),
      JSON.stringify({ teleportRequestId: requestId })]
  );

  // Idempotent: a retrying caller with the same request id gets the existing
  // charge row, never a second deduction.
  const inserted = await db.query(
    `INSERT INTO teleport_wallet_charges (teleport_request_id, server_id, identity_id, amount)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (teleport_request_id) DO NOTHING
     RETURNING id`,
    [requestId, serverId, identityId, centsToDecimal(config.costCents)]
  );
  if (!inserted.length) {
    const existing = await db.get(
      `SELECT amount FROM teleport_wallet_charges
       WHERE teleport_request_id = ? FOR UPDATE`,
      [requestId]
    );
    if (!existing || parseCents(existing.amount, 'Existing charge') !== config.costCents) {
      throw chargeError('TELEPORT_COST_CONFLICT', 'A different charge already exists for this request', 409);
    }
  }
  return { charged: true, amountCents: config.costCents, requestId };
}

/**
 * Refund one pending charge: restore the wallet balance, mark the charge
 * 'refunded', stamp the request's refunded_at provenance marker, and write
 * the ledger entry. Each leg is idempotent, so this is safe to call from
 * failure paths and the crash-recovery sweep alike. The charge row itself
 * carries the identity, so callers do not need to pass it.
 *
 * @returns {Promise<{refunded: boolean, amountCents: number}>}
 */
async function refundTeleportWalletCharge(db, { requestId, serverId, reason = 'teleport_failed' }) {
  const charge = await db.get(
    `SELECT id, identity_id, amount FROM teleport_wallet_charges
     WHERE teleport_request_id = ? AND status = 'pending'
     FOR UPDATE`,
    [requestId]
  );
  if (!charge) return { refunded: false, amountCents: 0 };

  const identityIdNum = Number(charge.identity_id);
  const amountCents = parseCents(charge.amount, 'Teleport charge amount');
  await getOrCreateWallet(db, identityIdNum, serverId);
  const updated = await db.get(
    `UPDATE player_wallets SET cash_on_hand = cash_on_hand + ?, last_updated = NOW()
     WHERE identity_id = ? AND server_id = ?
     RETURNING cash_on_hand`,
    [centsToDecimal(amountCents), identityIdNum, serverId]
  );
  if (!updated) throw new Error('Teleport cost refund: wallet credit failed');
  const newBalanceCents = parseCents(updated.cash_on_hand, 'Wallet balance');

  await db.run(
    `INSERT INTO economy_transactions
     (identity_id, server_id, transaction_type, amount, balance_after, account_type,
      source, description, metadata, timestamp)
     VALUES (?, ?, 'credit', ?, ?, 'wallet', 'teleport_cost_refund', 'Teleport request cost refund', ?, NOW())`,
    [identityIdNum, serverId, centsToDecimal(amountCents), centsToDecimal(newBalanceCents),
      JSON.stringify({ teleportRequestId: requestId, reason })]
  );

  const marked = await db.query(
    `UPDATE teleport_wallet_charges
     SET status = 'refunded', refunded_at = NOW()
     WHERE id = ? AND status = 'pending'
     RETURNING id`,
    [charge.id]
  );
  if (!marked.length) throw new Error('Teleport cost refund: charge state changed concurrently');

  await db.query(
    `UPDATE teleport_requests SET refunded_at = NOW(), updated_at = NOW()
     WHERE id = ? AND server_id = ? AND refunded_at IS NULL`,
    [requestId, serverId]
  );
  return { refunded: true, amountCents };
}

/**
 * Crash-recovery sweep: refund 'pending' charges whose teleport request has
 * failed (final_status='failed' past its failure time) or no longer exists.
 * Returns the number of refunds applied. Intended for the teleport worker
 * loop, run after the failure-state transitions for the tick.
 */
async function processTeleportWalletRefunds(db, serverId) {
  const candidates = await db.query(
    `SELECT twc.id, twc.teleport_request_id, twc.server_id, twc.identity_id,
            tr.final_status, tr.failed_at
     FROM teleport_wallet_charges twc
     LEFT JOIN teleport_requests tr ON tr.id = twc.teleport_request_id
     WHERE twc.server_id = ? AND twc.status = 'pending'
       AND (
         tr.id IS NULL
         OR (tr.final_status = 'failed' AND tr.failed_at IS NOT NULL
             AND tr.failed_at <= clock_timestamp())
       )
     ORDER BY twc.id`,
    [serverId]
  );
  let refunded = 0;
  for (const candidate of candidates) {
    await db.transaction(async tx => {
      const reason = candidate.final_status === 'failed' ? 'teleport_failed' : 'request_missing';
      const result = await refundTeleportWalletCharge(tx, {
        requestId: candidate.teleport_request_id,
        serverId: candidate.server_id,
        reason,
      });
      if (result.refunded) refunded += 1;
    });
  }
  return refunded;
}

module.exports = {
  getTeleportCostConfig,
  chargeTeleportCost,
  refundTeleportWalletCharge,
  processTeleportWalletRefunds,
};
