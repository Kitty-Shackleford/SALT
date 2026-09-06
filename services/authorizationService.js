'use strict';

const { isFinancialLinkMethod } = require('../utils/linkTrust');

const CAPABILITIES = Object.freeze({
  PLATFORM_MANAGE: 'platform.manage',
  GUILD_VIEW: 'guild.view',
  GUILD_MANAGE: 'guild.manage',
  GUILD_AUDIT: 'guild.audit',
  SERVER_VIEW: 'server.view',
  SERVER_MANAGE: 'server.manage',
  SERVER_MODERATE: 'server.moderate',
  SERVER_OWNER: 'server.owner',
  NITRADO_MANAGE: 'nitrado.manage',
  BOT_MANAGE: 'bot.manage',
  PLAYER_SELF: 'player.self',
  PLAYER_FINANCIAL: 'player.financial',
});

const GUILD_OPERATOR_CAPABILITIES = new Set([
  CAPABILITIES.GUILD_VIEW,
  CAPABILITIES.GUILD_MANAGE,
  CAPABILITIES.GUILD_AUDIT,
  CAPABILITIES.SERVER_VIEW,
  CAPABILITIES.SERVER_MANAGE,
  CAPABILITIES.SERVER_MODERATE,
  CAPABILITIES.NITRADO_MANAGE,
  CAPABILITIES.BOT_MANAGE,
]);
const SERVER_ADMIN_CAPABILITIES = new Set([
  CAPABILITIES.SERVER_VIEW,
  CAPABILITIES.SERVER_MANAGE,
  CAPABILITIES.SERVER_MODERATE,
  CAPABILITIES.NITRADO_MANAGE,
  CAPABILITIES.BOT_MANAGE,
]);
const SERVER_MODERATOR_CAPABILITIES = new Set([
  CAPABILITIES.SERVER_VIEW,
  CAPABILITIES.SERVER_MODERATE,
]);
const PLAYER_CAPABILITIES = new Set([
  CAPABILITIES.SERVER_VIEW,
  CAPABILITIES.PLAYER_SELF,
]);

function canUseCapability(row, actor, capability) {
  if (!Object.values(CAPABILITIES).includes(capability)) return false;
  if (capability === CAPABILITIES.SERVER_OWNER) {
    return row.guild_role === 'owner';
  }
  if (row.guild_role === 'owner' || row.guild_role === 'admin') {
    return GUILD_OPERATOR_CAPABILITIES.has(capability);
  }
  if (row.server_role_status === 'active' && row.server_role === 'admin') {
    return SERVER_ADMIN_CAPABILITIES.has(capability);
  }
  if (row.server_role_status === 'active' && row.server_role === 'moderator') {
    return SERVER_MODERATOR_CAPABILITIES.has(capability);
  }
  if (row.player_membership_status === 'active' && row.player_membership_id) {
    if (capability === CAPABILITIES.PLAYER_FINANCIAL) {
      return isFinancialLinkMethod(row.player_verification_method);
    }
    return PLAYER_CAPABILITIES.has(capability);
  }
  return false;
}

/**
 * Resolve and authorize an internal dashboard server ID in one tenant-bound query.
 * Returns a canonical trusted context, or null without revealing whether a denied
 * resource exists.
 */
async function authorizeServerReference(db, actor, serverReference, capability, referenceColumn) {
  if (!db || !actor || !actor.id || !serverReference) return null;
  const referencePredicate = referenceColumn === 'platform_server_id'
    ? 'CAST(s.platform_server_id AS TEXT) = ?'
    : 's.id = ?';

  const row = await db.get(
    `SELECT s.id AS server_id,
            s.guild_id,
            s.platform_server_id,
            s.status AS server_status,
            g.discord_guild_id,
            g.status AS guild_status,
            gr.role AS guild_role,
            sra.role AS server_role,
            sra.status AS server_role_status,
            spm.id AS player_membership_id,
            spm.identity_id,
            spm.status AS player_membership_status,
            spm.verification_method AS player_verification_method
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id
     LEFT JOIN guild_roles gr
       ON gr.guild_id = g.id AND gr.user_id = ?
     LEFT JOIN server_role_assignments sra
       ON sra.server_id = s.id
      AND sra.guild_id = s.guild_id
      AND sra.user_id = ?
     LEFT JOIN LATERAL (
       SELECT membership.id, membership.identity_id, membership.status,
              account.verification_method
       FROM server_player_memberships membership
       JOIN linked_accounts account
         ON account.id = membership.source_link_id
        AND account.identity_id = membership.identity_id
        AND account.user_id = membership.user_id
       WHERE membership.server_id = s.id
         AND membership.guild_id = s.guild_id
         AND membership.user_id = ?
         AND membership.status = 'active'
         AND account.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
       ORDER BY membership.id
       LIMIT 1
     ) spm ON TRUE
     WHERE ${referencePredicate}
       AND g.status = 'approved'
       AND s.status = 'active'
     LIMIT 1`,
    [actor.id, actor.id, actor.id, serverReference]
  );

  if (!row || !canUseCapability(row, actor, capability)) return null;

  return {
    actor: {
      userId: actor.id,
      discordId: actor.discord_id || null,
      platformAdmin: Boolean(actor.is_admin),
    },
    guild: {
      id: row.guild_id,
      discordGuildId: row.discord_guild_id,
      role: row.guild_role || null,
      status: row.guild_status,
    },
    server: {
      id: row.server_id,
      platformServerId: String(row.platform_server_id),
      role: row.server_role || null,
      status: row.server_status,
    },
    player: row.player_membership_id ? {
      membershipId: row.player_membership_id,
      identityId: row.identity_id,
    } : null,
  };
}

async function authorizeServer(db, actor, serverId, capability) {
  return authorizeServerReference(db, actor, serverId, capability, 'id');
}

async function authorizePlatformServer(db, actor, platformServerId, capability) {
  return authorizeServerReference(
    db,
    actor,
    String(platformServerId),
    capability,
    'platform_server_id'
  );
}

async function stabilizeServerMutationAuthority(db, actor, candidate, capability) {
  const stabilized = await db.get(
    `SELECT s.id
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id
     WHERE s.id = ? AND s.guild_id = ?
       AND s.status = 'active' AND g.status = 'approved'
     FOR NO KEY UPDATE OF s, g`,
    [candidate.server.id, candidate.guild.id]
  );
  if (!stabilized) return null;

  await db.get(
    `SELECT id FROM guild_roles
     WHERE guild_id = ? AND user_id = ?
     FOR NO KEY UPDATE`,
    [candidate.guild.id, actor.id]
  );
  await db.get(
    `SELECT id FROM server_role_assignments
     WHERE server_id = ? AND guild_id = ? AND user_id = ?
     FOR NO KEY UPDATE`,
    [candidate.server.id, candidate.guild.id, actor.id]
  );

  return authorizeServer(db, actor, candidate.server.id, capability);
}

async function authorizeServerMutation(db, actor, serverId, capability) {
  const candidate = await authorizeServer(db, actor, serverId, capability);
  if (!candidate) return null;
  return stabilizeServerMutationAuthority(db, actor, candidate, capability);
}

async function authorizePlatformServerMutation(db, actor, platformServerId, capability) {
  const candidate = await authorizePlatformServer(db, actor, platformServerId, capability);
  if (!candidate) return null;
  return stabilizeServerMutationAuthority(db, actor, candidate, capability);
}

module.exports = {
  CAPABILITIES,
  authorizePlatformServer,
  authorizePlatformServerMutation,
  authorizeServer,
  authorizeServerMutation,
  canUseCapability,
};
