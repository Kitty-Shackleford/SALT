'use strict';

const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const pool = require('../db');
const {
  enqueueRoleReconciliationJob,
  runRoleReconciliationJob,
} = require('../../utils/linkRoleReconciler');
const { fetchCurrentGuildMember } = require('../utils/currentDiscordMember');
const { lockPgUserRoleMutations, normalizeUserIds } = require('../../utils/roleMutationLocks');

async function ensureUsersAndLockRoleMutations(client, profiles) {
  const uniqueProfiles = [...new Map(profiles.map(profile => [String(profile.discordId), profile])).values()]
    .sort((left, right) => String(left.discordId).localeCompare(String(right.discordId)));
  const discordIds = uniqueProfiles.map(profile => String(profile.discordId));
  const existing = await client.query(
    'SELECT id, discord_id FROM users WHERE discord_id = ANY($1::TEXT[])',
    [discordIds]
  );
  const usersByDiscordId = new Map(
    existing.rows.map(row => [String(row.discord_id), { id: Number(row.id), discord_id: String(row.discord_id) }])
  );
  const existingIds = normalizeUserIds([...usersByDiscordId.values()].map(user => user.id));
  await lockPgUserRoleMutations(client, existingIds);
  for (const profile of uniqueProfiles) {
    const discordId = String(profile.discordId);
    if (usersByDiscordId.has(discordId)) continue;
    let inserted = await client.query(
      `INSERT INTO users (discord_id, username, avatar)
       VALUES ($1, $2, $3)
       ON CONFLICT (discord_id) DO NOTHING
       RETURNING id, discord_id`,
      [discordId, profile.username || null, profile.avatar || null]
    );
    if (!inserted.rows[0]) {
      inserted = await client.query(
        'SELECT id, discord_id FROM users WHERE discord_id = $1',
        [discordId]
      );
    }
    const user = inserted.rows[0];
    if (!user) throw new Error('Unable to resolve Discord user');
    usersByDiscordId.set(discordId, { id: Number(user.id), discord_id: discordId });
    await lockPgUserRoleMutations(client, [Number(user.id)]);
  }
  for (const profile of uniqueProfiles) {
    if (profile.username === undefined) continue;
    const user = usersByDiscordId.get(String(profile.discordId));
    await client.query(
      'UPDATE users SET username = $2 WHERE id = $1',
      [user.id, profile.username || null]
    );
  }
  return usersByDiscordId;
}

async function resolveIdentity(serverId, discordGuildId, gamertag) {
  const result = await pool.query(
    `SELECT pi.id AS identity_id, pg.gamertag, s.id AS server_id, s.guild_id,
            g.discord_guild_id, la.id AS linked_account_id, la.user_id AS linked_user_id,
            spm.id AS membership_id, spm.user_id AS membership_user_id,
            linked_user.discord_id AS linked_discord_id
       FROM player_identities pi
       JOIN player_gamertags pg
         ON pg.identity_id = pi.id
        AND pg.server_id = $1
        AND pg.is_current_gamertag = 1
       JOIN servers s ON s.id = pg.server_id
       JOIN guilds g ON g.id = s.guild_id
       LEFT JOIN linked_accounts la ON la.identity_id = pi.id
       LEFT JOIN users linked_user ON linked_user.id = la.user_id
       LEFT JOIN server_player_memberships spm
         ON spm.identity_id = pi.id
        AND spm.server_id = s.id
        AND spm.guild_id = s.guild_id
        AND spm.status = 'active'
      WHERE s.id = $1
        AND g.discord_guild_id = $2
        AND LOWER(pg.gamertag) = LOWER($3)
        AND s.status = 'active'
        AND g.status = 'approved'
      ORDER BY pi.id`,
    [serverId, String(discordGuildId), gamertag]
  );
  return result.rows || [];
}

async function runRoleJobSafely(job, member) {
  try {
    await runRoleReconciliationJob({ db: pool, job, member });
    return '';
  } catch (error) {
    console.warn(`⚠️ Player link changed, but Discord role reconciliation remains queued: ${error.message}`);
    return ' Discord role reconciliation remains queued.';
  }
}

async function assertActorCanModerate(client, actorUserId, identity, interaction) {
  const scope = await client.query(
    `SELECT s.id
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
      WHERE s.id = $1
        AND s.guild_id = $2
        AND g.discord_guild_id = $3
        AND s.status = 'active'
        AND g.status = 'approved'
      FOR UPDATE OF s, g`,
    [identity.server_id, identity.guild_id, String(interaction.guild.id)]
  );
  const guildRole = await client.query(
    'SELECT role FROM guild_roles WHERE guild_id = $1 AND user_id = $2 FOR UPDATE',
    [identity.guild_id, actorUserId]
  );
  const serverRole = await client.query(
    `SELECT role, status FROM server_role_assignments
      WHERE server_id = $1 AND guild_id = $2 AND user_id = $3 FOR UPDATE`,
    [identity.server_id, identity.guild_id, actorUserId]
  );
  const currentActorMember = await fetchCurrentGuildMember(interaction.guild, interaction.user.id);
  const nativeAdministrator = currentActorMember.permissions.has(PermissionFlagsBits.Administrator);
  const guildOperator = ['owner', 'admin'].includes(guildRole.rows[0]?.role);
  const exactServerRole = serverRole.rows[0]?.status === 'active'
    && ['admin', 'moderator'].includes(serverRole.rows[0]?.role);
  if (scope.rows.length !== 1 || (!nativeAdministrator && !guildOperator && !exactServerRole)) {
    const error = new Error('Moderator authority changed');
    error.code = 'AUTHORITY_REVOKED';
    throw error;
  }
}

async function performForceLinkTransaction(client, options) {
  const { interaction, identity, target, serverId } = options;
  const users = await ensureUsersAndLockRoleMutations(client, [
    {
      discordId: interaction.user.id,
      username: interaction.user.username,
      avatar: interaction.user.avatar,
    },
    { discordId: target.id, username: target.username, avatar: target.avatar },
  ]);
  const actorUserId = users.get(String(interaction.user.id)).id;
  const targetUserId = users.get(String(target.id)).id;
  await assertActorCanModerate(client, actorUserId, identity, interaction);
  const targetMember = await fetchCurrentGuildMember(interaction.guild, target.id);
  const linkResult = await client.query(
    'SELECT id, user_id FROM linked_accounts WHERE identity_id = $1 FOR UPDATE',
    [identity.identity_id]
  );
  let link = linkResult.rows[0];
  if (link && Number(link.user_id) !== Number(targetUserId)) {
    const conflict = new Error('Game identity ownership changed');
    conflict.code = 'OWNERSHIP_CONFLICT';
    throw conflict;
  }
  if (link) {
    await client.query(
      `UPDATE linked_accounts
          SET verification_method = 'admin_approved', verified_by_guild_id = $2
        WHERE id = $1`,
      [link.id, identity.guild_id]
    );
  } else {
    const inserted = await client.query(
      `INSERT INTO linked_accounts
        (user_id, identity_id, verified_by_guild_id, verification_method)
       VALUES ($1, $2, $3, 'admin_approved')
       RETURNING id`,
      [targetUserId, identity.identity_id, identity.guild_id]
    );
    link = inserted.rows[0];
  }
  await client.query(
    `INSERT INTO server_player_memberships
      (server_id, guild_id, identity_id, user_id, source_link_id, verification_method,
       verified_by_user_id, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'admin_approved', $6, 'active', NOW())
     ON CONFLICT (server_id, identity_id) DO UPDATE SET
       guild_id = EXCLUDED.guild_id, user_id = EXCLUDED.user_id,
       source_link_id = EXCLUDED.source_link_id,
       verification_method = 'admin_approved', verified_by_user_id = EXCLUDED.verified_by_user_id,
       status = 'active', updated_at = NOW()`,
    [serverId, identity.guild_id, identity.identity_id, targetUserId, link.id, actorUserId]
  );
  await client.query(
    `INSERT INTO security_audit_events
      (actor_user_id, guild_id, server_id, action, result, target_type, target_id, metadata)
     VALUES ($1, $2, $3, 'player_link.force_link', 'allowed', 'user', $4, $5::JSONB)`,
    [actorUserId, identity.guild_id, serverId, String(targetUserId),
      JSON.stringify({ identityId: identity.identity_id, gamertag: identity.gamertag })]
  );
  const roleJob = await enqueueRoleReconciliationJob(client, {
    discordGuildId: interaction.guild.id,
    discordUserId: target.id,
    userId: targetUserId,
  });
  return { roleJob, targetMember };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('link-admin')
    .setDescription('Moderator tools for exact-server gamertag links')
    .addSubcommand(subcommand => subcommand
      .setName('force-link')
      .setDescription('Approve and link a Discord member to a gamertag')
      .addUserOption(option => option
        .setName('user').setDescription('Discord member who owns the gamertag').setRequired(true))
      .addStringOption(option => option
        .setName('gamertag').setDescription('Exact current gamertag').setRequired(true))
      .addStringOption(option => option
        .setName('server').setDescription('Nitrado service ID when this guild has multiple servers')))
    .addSubcommand(subcommand => subcommand
      .setName('force-unlink')
      .setDescription('Revoke the exact-server membership for a gamertag')
      .addStringOption(option => option
        .setName('gamertag').setDescription('Exact current gamertag').setRequired(true))
      .addStringOption(option => option
        .setName('server').setDescription('Nitrado service ID when this guild has multiple servers'))),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const serverId = interaction.authorizedServerId;
    if (!serverId) return interaction.editReply('❌ Select an active server you are authorized to moderate.');
    const subcommand = interaction.options.getSubcommand();
    const gamertag = interaction.options.getString('gamertag', true).trim();
    if (!gamertag || gamertag.length > 100) return interaction.editReply('❌ Enter a valid gamertag.');

    try {
      const identities = await resolveIdentity(serverId, interaction.guild.id, gamertag);
      if (identities.length !== 1) {
        return interaction.editReply(identities.length
          ? '❌ More than one game identity has that gamertag on this server; resolve the ambiguity in the dashboard.'
          : '❌ That gamertag was not found on the selected active server.');
      }
      const identity = identities[0];

      if (subcommand === 'force-link') {
        const target = interaction.options.getUser('user', true);
        let targetMember;
        if (identity.linked_discord_id && String(identity.linked_discord_id) !== String(target.id)) {
          return interaction.editReply('❌ That game identity is already owned by another Discord user. Force-unlink does not transfer global ownership; review it in the dashboard.');
        }

        const client = await pool.connect();
        let roleJob;
        try {
          await client.query('BEGIN');
          ({ roleJob, targetMember } = await performForceLinkTransaction(client, {
            interaction,
            identity,
            target,
            serverId,
          }));
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
        const warning = await runRoleJobSafely(roleJob, targetMember);
        return interaction.editReply(`✅ Approved and linked **${identity.gamertag}** to ${target}.${warning}`);
      }

      if (!identity.membership_id || !identity.linked_discord_id) {
        return interaction.editReply('❌ That gamertag has no active membership on the selected server.');
      }
      const client = await pool.connect();
      let roleJob;
      try {
        await client.query('BEGIN');
        const users = await ensureUsersAndLockRoleMutations(client, [
          {
            discordId: interaction.user.id,
            username: interaction.user.username,
            avatar: interaction.user.avatar,
          },
          { discordId: identity.linked_discord_id },
        ]);
        const actorUserId = users.get(String(interaction.user.id)).id;
        await assertActorCanModerate(client, actorUserId, identity, interaction);
        const locked = await client.query(
          `SELECT id, user_id FROM server_player_memberships
            WHERE id = $1 AND server_id = $2 AND identity_id = $3 AND status = 'active'
            FOR UPDATE`,
          [identity.membership_id, serverId, identity.identity_id]
        );
        if (locked.rows.length !== 1) {
          const conflict = new Error('Player membership changed');
          conflict.code = 'MEMBERSHIP_CONFLICT';
          throw conflict;
        }
        await client.query(
          "UPDATE server_player_memberships SET status = 'revoked', updated_at = NOW() WHERE id = $1",
          [identity.membership_id]
        );
        await client.query(
          `INSERT INTO security_audit_events
            (actor_user_id, guild_id, server_id, action, result, target_type, target_id, metadata)
           VALUES ($1, $2, $3, 'player_link.force_unlink', 'allowed', 'user', $4, $5::JSONB)`,
          [actorUserId, identity.guild_id, serverId, String(locked.rows[0].user_id),
            JSON.stringify({ identityId: identity.identity_id, gamertag: identity.gamertag })]
        );
        roleJob = await enqueueRoleReconciliationJob(client, {
          discordGuildId: interaction.guild.id,
          discordUserId: identity.linked_discord_id,
          userId: locked.rows[0].user_id,
        });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      const warning = await runRoleJobSafely(roleJob);
      return interaction.editReply(`✅ Revoked **${identity.gamertag}** from the selected server.${warning}`);
    } catch (error) {
      console.error('❌ /link-admin error:', error);
      const conflict = [
        '23505', 'OWNERSHIP_CONFLICT', 'MEMBERSHIP_CONFLICT', 'AUTHORITY_REVOKED', 'MEMBER_LEFT'
      ].includes(error.code);
      return interaction.editReply(conflict
        ? '❌ The link changed while this command was running. Refresh and retry.'
        : '❌ Unable to change that player link right now.');
    }
  },
  fetchCurrentGuildMember,
  ensureUsersAndLockRoleMutations,
  assertActorCanModerate,
  performForceLinkTransaction,
};
