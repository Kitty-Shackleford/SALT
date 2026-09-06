'use strict';

const { amountForResponse, parseCentsBigInt, centsForResponse } = require('./money');

function nullableNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function transactionAmount(row) {
  let cents = parseCentsBigInt(row.amount || 0, 'Transaction amount', { allowNegative: true });
  if (row.transaction_type === 'debit') cents = cents < 0n ? cents : -cents;
  if (row.transaction_type === 'credit') cents = cents < 0n ? -cents : cents;
  return centsForResponse(cents);
}

function serializeTransaction(row) {
  return {
    id: Number(row.id),
    identityId: Number(row.identity_id),
    serverId: Number(row.server_id),
    transactionType: row.transaction_type,
    amount: transactionAmount(row),
    balanceAfter: amountForResponse(row.balance_after || 0, 'Transaction balance'),
    accountType: row.account_type,
    sourceIdentityId: nullableNumber(row.source_identity_id),
    source: row.source || null,
    description: row.description || null,
    timestamp: row.timestamp,
  };
}

function transactionPagination(total, limit, offset) {
  const normalizedTotal = Math.max(0, Number(total) || 0);
  const normalizedLimit = Math.max(1, Number(limit) || 1);
  const normalizedOffset = Math.max(0, Number(offset) || 0);
  return {
    total: normalizedTotal,
    limit: normalizedLimit,
    offset: normalizedOffset,
    hasMore: normalizedOffset + normalizedLimit < normalizedTotal,
  };
}

module.exports = { serializeTransaction, transactionPagination };
