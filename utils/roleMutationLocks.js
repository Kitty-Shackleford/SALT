'use strict';

const ACTOR_ROLE_LOCK_NAMESPACE = 2147483001;

function normalizeUserIds(userIds) {
  return [...new Set(userIds
    .map(value => Number.parseInt(value, 10))
    .filter(value => Number.isSafeInteger(value) && value > 0))]
    .sort((left, right) => left - right);
}

async function lockUserRoleMutations(db, userIds) {
  for (const userId of normalizeUserIds(userIds)) {
    await db.get(
      'SELECT pg_advisory_xact_lock(?, ?)',
      [ACTOR_ROLE_LOCK_NAMESPACE, userId]
    );
  }
}

async function lockPgUserRoleMutations(client, userIds) {
  for (const userId of normalizeUserIds(userIds)) {
    await client.query(
      'SELECT pg_advisory_xact_lock($1, $2)',
      [ACTOR_ROLE_LOCK_NAMESPACE, userId]
    );
  }
}

module.exports = {
  ACTOR_ROLE_LOCK_NAMESPACE,
  normalizeUserIds,
  lockUserRoleMutations,
  lockPgUserRoleMutations,
};
