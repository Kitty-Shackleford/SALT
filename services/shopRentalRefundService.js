'use strict';

const { parseCentsBigInt } = require('../utils/money');

const MAX_NUMERIC_20_2_CENTS = 99999999999999999999n;

const REFUND_REASON_CODES = new Set([
  'provider_failure',
  'service_outage',
  'accidental_purchase',
  'duplicate_order',
  'goodwill',
  'other',
]);

function refundInputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw refundInputError(`${label} must be a non-negative integer`);
  return parsed;
}

function exactRefundCents(value, label) {
  let cents;
  try {
    cents = typeof value === 'bigint'
      ? value
      : (typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : null);
  } catch {
    cents = null;
  }
  if (cents === null || cents < 0n || cents > MAX_NUMERIC_20_2_CENTS) {
    throw refundInputError(`${label} is invalid`);
  }
  return cents;
}

function calculateProratedRentalRefund({ unitPrice, quantity, purchasedRestarts, remainingRestarts }) {
  let unitPriceCents;
  try {
    unitPriceCents = parseCentsBigInt(unitPrice, 'Rental unit price');
  } catch (error) {
    if (!error.status) error.status = 400;
    throw error;
  }
  const purchased = positiveInteger(purchasedRestarts, 'Purchased restarts');
  const remaining = positiveInteger(remainingRestarts, 'Remaining restarts');
  const units = positiveInteger(quantity, 'Rental quantity');
  if (purchased < 1 || units !== purchased) {
    throw refundInputError('Purchased restarts must match the rental quantity');
  }
  if (remaining > purchased) throw refundInputError('Remaining restarts cannot exceed purchased restarts');
  const paidCents = unitPriceCents * BigInt(units);
  const maximumRefundCents = unitPriceCents * BigInt(remaining);
  if (paidCents > MAX_NUMERIC_20_2_CENTS || maximumRefundCents > MAX_NUMERIC_20_2_CENTS) {
    throw refundInputError('Rental value exceeds the supported monetary range');
  }
  return {
    paidCents,
    maximumRefundCents,
    consumedRestarts: purchased - remaining,
  };
}

function validateRefundDecision({
  calculatedRefundCents,
  requestedRefundCents,
  paidCents = MAX_NUMERIC_20_2_CENTS,
  reasonCode,
  adminNote,
  override,
  requiresEvidenceOverride = false,
}) {
  if (!REFUND_REASON_CODES.has(reasonCode)) throw refundInputError('A valid refund reason is required');
  const calculated = exactRefundCents(calculatedRefundCents, 'Calculated refund');
  const requested = exactRefundCents(requestedRefundCents, 'Refund amount');
  const paid = exactRefundCents(paidCents, 'Paid amount');
  if (requested > paid) throw refundInputError('Refund amount is invalid');
  if (requested === 0n) throw refundInputError('This order has no refundable value remaining');
  const amountOverride = requested !== calculated;
  const overrideApplied = amountOverride || requiresEvidenceOverride;
  if (requiresEvidenceOverride && override !== true) {
    throw refundInputError('Incomplete evidence requires an explicit administrator override');
  }
  if (amountOverride && override !== true) throw refundInputError('A refund amount override must be explicitly confirmed');
  const note = typeof adminNote === 'string' ? adminNote.trim() : '';
  if (overrideApplied && note.length < 10) throw refundInputError('A documented administrator note is required for an override');
  if (note.length > 1000) throw refundInputError('Administrator note must be 1000 characters or fewer');
  return { overrideApplied, adminNote: note };
}

module.exports = {
  REFUND_REASON_CODES,
  calculateProratedRentalRefund,
  validateRefundDecision,
};
