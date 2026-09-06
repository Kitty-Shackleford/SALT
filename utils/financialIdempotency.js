'use strict';

const crypto = require('crypto');

const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

function parseIdempotencyKey(req) {
  const value = req.get('Idempotency-Key');
  if (typeof value !== 'string' || value.length === 0) {
    const error = new Error('Idempotency-Key is required; refresh the page before retrying');
    error.status = 400;
    throw error;
  }
  if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    const error = new Error('Idempotency-Key must be 128 characters or fewer');
    error.status = 400;
    throw error;
  }
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    const error = new Error('Idempotency-Key is invalid');
    error.status = 400;
    throw error;
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function fingerprintFinancialRequest(input) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(input)))
    .digest('hex');
}

function conflict(message = 'Idempotency key conflicts with another request') {
  const error = new Error(message);
  error.status = 409;
  return error;
}

async function claimFinancialOperationInTransaction(db, scope) {
  const inserted = await db.get(
    `INSERT INTO financial_idempotency_records
     (server_id, identity_id, actor_user_id, operation, idempotency_key, request_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [scope.serverId, scope.identityId, scope.actorUserId, scope.operation,
      scope.idempotencyKey, scope.requestFingerprint]
  );
  if (inserted) return { id: inserted.id, replay: false };

  const existing = await db.get(
    `SELECT id, operation, request_fingerprint, response_status, response_body, completed_at
     FROM financial_idempotency_records
     WHERE server_id = ? AND actor_user_id = ? AND identity_id = ? AND idempotency_key = ?
     FOR UPDATE`,
    [scope.serverId, scope.actorUserId, scope.identityId, scope.idempotencyKey]
  );
  if (!existing || existing.operation !== scope.operation
      || existing.request_fingerprint !== scope.requestFingerprint) {
    throw conflict();
  }
  if (existing.response_status == null || existing.response_body == null || !existing.completed_at) {
    throw conflict('Idempotent request is still in progress');
  }
  const body = typeof existing.response_body === 'string'
    ? JSON.parse(existing.response_body) : existing.response_body;
  return { id: existing.id, replay: true, status: existing.response_status, body };
}

async function completeFinancialOperationInTransaction(db, id, status, body) {
  const result = await db.run(
    `UPDATE financial_idempotency_records
     SET response_status = ?, response_body = ?::jsonb, completed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND completed_at IS NULL`,
    [status, JSON.stringify(body), id]
  );
  if (result.changes !== 1) throw conflict('Idempotent request completion conflict');
}

module.exports = {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  parseIdempotencyKey,
  fingerprintFinancialRequest,
  claimFinancialOperationInTransaction,
  completeFinancialOperationInTransaction,
};
