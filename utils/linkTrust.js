'use strict';

const { lockUserRoleMutations } = require('./roleMutationLocks');

const TRUSTED_LINK_METHODS = new Set([
  'emote_challenge',
  'admin_approved',
]);

const FINANCIAL_LINK_METHODS = new Set([
  ...TRUSTED_LINK_METHODS,
  'self_asserted',
]);

function isTrustedLinkMethod(method) {
  return TRUSTED_LINK_METHODS.has(String(method || ''));
}

function trustedLinkMethods() {
  return [...TRUSTED_LINK_METHODS];
}

function isFinancialLinkMethod(method) {
  return FINANCIAL_LINK_METHODS.has(String(method || ''));
}

function financialLinkMethods() {
  return [...FINANCIAL_LINK_METHODS];
}

async function lockTrustedFinancialIdentity(db, { userId, identityId, serverId }) {
  const methods = financialLinkMethods();
  await lockUserRoleMutations(db, [userId]);
  const scope = await db.get(
    'SELECT guild_id FROM servers WHERE id = ?', [serverId]
  );
  if (!scope) return null;
  const guild = await db.get(
    "SELECT id FROM guilds WHERE id = ? AND status = 'approved' FOR UPDATE", [scope.guild_id]
  );
  if (!guild) return null;
  const server = await db.get(
    "SELECT id FROM servers WHERE id = ? AND guild_id = ? AND status = 'active' FOR NO KEY UPDATE",
    [serverId, scope.guild_id]
  );
  if (!server) return null;
  await db.get(
    'SELECT server_id FROM guild_economy_config WHERE server_id = ? FOR UPDATE',
    [serverId]
  );
  const discovered = await db.get(
    `SELECT id, source_link_id
     FROM server_player_memberships
     WHERE server_id = ? AND user_id = ? AND identity_id = ? AND status = 'active'`,
    [serverId, userId, identityId]
  );
  if (!discovered) return null;

  const proof = await db.get(
    `SELECT id FROM linked_accounts
     WHERE id = ? AND user_id = ? AND identity_id = ?
       AND verification_method IN (${methods.map(() => '?').join(', ')})
     FOR UPDATE`,
    [discovered.source_link_id, userId, identityId, ...methods]
  );
  if (!proof) return null;

  return db.get(
    `SELECT id FROM server_player_memberships
     WHERE id = ? AND server_id = ? AND user_id = ? AND identity_id = ?
       AND source_link_id = ? AND status = 'active'
     FOR UPDATE`,
    [discovered.id, serverId, userId, identityId, proof.id]
  );
}

module.exports = {
  TRUSTED_LINK_METHODS,
  FINANCIAL_LINK_METHODS,
  isTrustedLinkMethod,
  trustedLinkMethods,
  isFinancialLinkMethod,
  financialLinkMethods,
  lockTrustedFinancialIdentity,
};
