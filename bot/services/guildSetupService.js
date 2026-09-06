'use strict';

const { PermissionFlagsBits } = require('discord.js');

function isEligibleInitialGuildOwner(permission) {
  return Boolean(permission && (permission.isGuildOwner || permission.hasAdministrator));
}

function canRegisterExistingGuildToken(role, ownerCount) {
  return ownerCount === 1 && (role === 'owner' || role === 'admin');
}

async function getDiscordSetupPermission(interaction) {
  const actorDiscordId = String(interaction?.user?.id || '');
  const guildId = String(interaction?.guild?.id || '');
  if (!actorDiscordId || !guildId) {
    throw new Error('Discord guild membership context is unavailable');
  }
  const refreshedGuild = await interaction?.client?.guilds.fetch({
    guild: interaction?.guild?.id,
    force: true,
    cache: false,
  });
  if (String(refreshedGuild?.id || '') !== guildId) {
    throw new Error('Discord returned an unexpected guild identity');
  }
  const ownerDiscordId = String(refreshedGuild?.ownerId || '');
  if (!ownerDiscordId) {
    throw new Error('Discord guild owner context is unavailable');
  }
  const [member, ownerMember] = await Promise.all([
    refreshedGuild.members.fetch({ user: actorDiscordId, force: true, cache: false }),
    refreshedGuild.members.fetch({ user: ownerDiscordId, force: true, cache: false }),
  ]);
  if (String(member?.user?.id || member?.id || '') !== actorDiscordId ||
      String(ownerMember?.user?.id || ownerMember?.id || '') !== ownerDiscordId) {
    throw new Error('Discord returned an unexpected guild member identity');
  }
  return {
    isGuildOwner: ownerDiscordId === actorDiscordId,
    hasAdministrator: Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator)),
    authoritativeOwner: ownerMember?.user ? {
      discordId: String(ownerMember.user.id),
      username: ownerMember.user.username,
      avatar: ownerMember.user.avatar || null,
    } : null,
  };
}

function selectInitialGuildOwner(permission) {
  return permission?.authoritativeOwner || null;
}

async function ensureAuthoritativeInitialGuildOwner(client, {
  guildId,
  actorUserId,
  owner,
  assignIfMissing,
}) {
  if (!client || !guildId || !actorUserId || !owner?.discordId) {
    throw new Error('Authoritative guild owner assignment context is incomplete');
  }

  if (assignIfMissing) {
    const ownerUserRes = await client.query(
      `INSERT INTO users (discord_id, username, avatar)
       VALUES ($1, $2, $3)
       ON CONFLICT (discord_id) DO UPDATE SET
         username = EXCLUDED.username,
         avatar = EXCLUDED.avatar
       RETURNING id`,
      [owner.discordId, owner.username, owner.avatar]
    );
    const ownerUserId = ownerUserRes.rows[0]?.id;
    if (!ownerUserId) {
      throw new Error('Unable to persist the authoritative Discord guild owner');
    }
    const roleWrite = await client.query(
      `INSERT INTO guild_roles (guild_id, user_id, role, assigned_by)
       VALUES ($1, $2, 'owner', $3)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET
         role = EXCLUDED.role,
         assigned_by = EXCLUDED.assigned_by,
         assigned_at = CURRENT_TIMESTAMP
       RETURNING user_id`,
      [guildId, ownerUserId, actorUserId]
    );
    if (roleWrite.rowCount !== 1 || roleWrite.rows[0]?.user_id !== ownerUserId) {
      throw new Error('Unable to assign the authoritative Discord guild owner');
    }
  }

  const ownerRows = await client.query(
    `SELECT gr.user_id, u.discord_id
       FROM guild_roles gr
       JOIN users u ON u.id = gr.user_id
      WHERE gr.guild_id = $1 AND gr.role = 'owner'
      FOR UPDATE OF gr`,
    [guildId]
  );
  if (ownerRows.rows.length !== 1 ||
      String(ownerRows.rows[0].discord_id) !== String(owner.discordId)) {
    throw new Error('Tenant ownership does not match the authoritative Discord guild owner');
  }
  return ownerRows.rows[0].user_id;
}

module.exports = {
  canRegisterExistingGuildToken,
  ensureAuthoritativeInitialGuildOwner,
  getDiscordSetupPermission,
  isEligibleInitialGuildOwner,
  selectInitialGuildOwner,
};
