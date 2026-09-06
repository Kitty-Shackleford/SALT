'use strict';

const { centsToDecimal, parseCentsBigInt } = require('./money');

function canonicalInteger(value, label) {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${label} is invalid`);
  return BigInt(text);
}

async function insertOrVerifyPendingRefundClaim(db, claim) {
  const amountCents = typeof claim.amountCents === 'bigint'
    ? claim.amountCents : BigInt(claim.amountCents);
  const amount = centsToDecimal(amountCents);
  const sourceKey = String(claim.sourceKey);
  let row = await db.get(
    `INSERT INTO financial_refund_claims
     (server_id, identity_id, amount, source_type, source_key, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_type, source_key) DO NOTHING
     RETURNING id, server_id, identity_id, amount, source_type, source_key, reason, status`,
    [claim.serverId, claim.identityId, amount, claim.sourceType,
      sourceKey, claim.reason, claim.createdAt]
  );
  if (!row) {
    row = await db.get(
      `SELECT id, server_id, identity_id, amount, source_type, source_key, reason, status
       FROM financial_refund_claims
       WHERE source_type = ? AND source_key = ? FOR UPDATE`,
      [claim.sourceType, sourceKey]
    );
  }
  const equivalent = row
    && canonicalInteger(row.server_id, 'Existing refund claim server')
      === canonicalInteger(claim.serverId, 'Refund claim server')
    && canonicalInteger(row.identity_id, 'Existing refund claim identity')
      === canonicalInteger(claim.identityId, 'Refund claim identity')
    && parseCentsBigInt(row.amount, 'Existing refund claim amount') === amountCents
    && row.source_type === claim.sourceType
    && String(row.source_key) === sourceKey
    && row.reason === claim.reason
    && row.status === 'pending';
  if (!equivalent) {
    const error = new Error('Refund claim conflict does not match source settlement');
    error.status = 409;
    throw error;
  }
  const claimId = canonicalInteger(row.id, 'Refund claim');
  if (claimId > BigInt(Number.MAX_SAFE_INTEGER)) return claimId.toString();
  return Number(claimId);
}

module.exports = { insertOrVerifyPendingRefundClaim };
