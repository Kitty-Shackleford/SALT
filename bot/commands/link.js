const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const pool = require('../db');
const { getWebsiteLink } = require('../utils/website');
const {
  createEmoteChallengeSequence,
  evaluateEmoteChallenge,
  formatEmoteSequence,
} = require('../../services/playerLinkChallengeService');
const { getLinkSettings } = require('../utils/linkSettings');
const {
  enqueueRoleReconciliationJob,
  runRoleReconciliationJob,
} = require('../../utils/linkRoleReconciler');
const { isTrustedLinkMethod } = require('../../utils/linkTrust');
const { lockPgUserRoleMutations } = require('../../utils/roleMutationLocks');

const LINK_CHALLENGE_TTL_MS = 30 * 60 * 1000;

async function lockActiveLinkTenant(client, serverId, guildId) {
  const tenant = await client.query(
    `SELECT s.id, s.guild_id
       FROM guilds g
       JOIN servers s ON s.guild_id = g.id
      WHERE s.id = $1 AND s.guild_id = $2
        AND s.status = 'active' AND g.status = 'approved'
      FOR UPDATE OF g, s`,
    [serverId, guildId]
  );
  if (tenant.rows.length !== 1) {
    const error = new Error('Player-link scope changed');
    error.code = 'LINK_SCOPE_CHANGED';
    throw error;
  }
  return tenant.rows[0];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your in-game account to Discord')
    .addStringOption(option =>
      option.setName('gamertag')
        .setDescription('Your in-game gamertag')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('server')
        .setDescription('Server ID (required when the gamertag exists on multiple servers)')
        .setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const gamertag = interaction.options.getString('gamertag');
    const requestedServer = interaction.options.getString('server');
    const authorizedServerId = interaction.authorizedServerId;
    const guildId = interaction.guild.id;
    const discordId = interaction.user.id;
    const username = interaction.user.username;

    try {
      // Check if guild has token registered
      const guildRes = await pool.query(
        'SELECT * FROM guilds WHERE discord_guild_id = $1',
        [guildId]
      );
      const guild = guildRes.rows[0];

      if (!guild) {
        return interaction.editReply({
          content: '❌ This Discord server has not been registered yet.\n' +
                   'Server admins need to run `/register-token` first.'
        });
      }

      // Check if guild has a token
      const tokenRes = await pool.query(
        `SELECT id FROM guild_tokens
         WHERE guild_id = $1 AND token_type = $2 AND nitrado_user_id IS NOT NULL`,
        [guild.id, 'nitrado']
      );
      const hasToken = tokenRes.rows.length > 0;

      if (!hasToken) {
        return interaction.editReply({
          content: '❌ This Discord server has not registered a Nitrado token yet.\n' +
                   'Server admins need to run `/register-token` first.'
        });
      }

      // Search for matching game accounts in this guild's servers.
      // Route through player_gamertags.server_id (not player_server_activity) so
      // players whose activity row was wiped by a reset still appear.
      const accountsRes = await pool.query(`
        SELECT
          pi.id,
          pg.gamertag,
          pi.platform,
          psa.last_seen,
          s.id AS server_id,
          s.platform_server_id,
          s.guild_id,
          s.name AS server_name,
          la.id AS linked_account_id,
          la.user_id AS linked_user_id,
          la.verification_method AS linked_verification_method,
          spm.status AS membership_status,
          spm.user_id AS membership_user_id
        FROM player_identities pi
        JOIN player_gamertags pg ON pi.id = pg.identity_id AND pg.is_current_gamertag = 1
        JOIN servers s ON pg.server_id = s.id
        LEFT JOIN player_server_activity psa ON pi.id = psa.identity_id AND psa.server_id = s.id
        LEFT JOIN linked_accounts la ON pi.id = la.identity_id
        LEFT JOIN server_player_memberships spm
          ON spm.identity_id = pi.id AND spm.server_id = s.id
        WHERE s.guild_id = $1
          AND LOWER(pg.gamertag) = LOWER($2)
          AND s.status = 'active'
          AND s.id = $3
        ORDER BY psa.last_seen DESC NULLS LAST, pi.id, s.id
      `, [guild.id, gamertag, authorizedServerId]);
      const accounts = accountsRes.rows;

      if (accounts.length === 0) {
        return interaction.editReply({
          content: `❌ No accounts found with gamertag **${gamertag}** on this server's DayZ servers.\n\n` +
                   `Make sure you've played recently and the server has synced.`
        });
      }

      if (accounts.length > 1) {
        const serverIds = new Set(accounts.map(account => account.server_id));
        if (!requestedServer && serverIds.size > 1) {
          return interaction.editReply({
            content: '❌ More than one server has that gamertag. Run `/link` again with the exact `server` ID.'
          });
        }
        return interaction.editReply({
          content: '❌ More than one platform identity uses that gamertag. Use the website account picker to select the exact identity.'
        });
      }

      const account = accounts[0];
      const linkSettings = await getLinkSettings(pool, account.server_id);
      if (!account.linked_user_id && linkSettings.verificationMode === 'admin_approval') {
        return interaction.editReply(
          '❌ Linking a new gamertag requires administrator or moderator approval on this server. ' +
          'Ask staff to use `/link-admin force-link`.'
        );
      }

      // Create a dashboard user only after exact-server policy permits the claim.
      const userRes = await pool.query(
        'SELECT id FROM users WHERE discord_id = $1',
        [discordId]
      );
      let userId;
      if (userRes.rows.length > 0) {
        userId = userRes.rows[0].id;
      } else {
        const newUserRes = await pool.query(
          'INSERT INTO users (discord_id, username, avatar) VALUES ($1, $2, $3) RETURNING id',
          [discordId, username, interaction.user.avatar]
        );
        userId = newUserRes.rows[0].id;
      }
      if (account.linked_user_id && account.linked_user_id !== userId) {
        return interaction.editReply({
          content: '❌ This gamertag is already linked to another user. ' +
                   'If this is your account, contact a server admin.'
        });
      }
      const ownsExistingLink = account.linked_user_id === userId;
      const hasExistingProof = ownsExistingLink &&
        isTrustedLinkMethod(account.linked_verification_method);
      const hasSelfAssertedOwnership = ownsExistingLink &&
        account.linked_verification_method === 'self_asserted';
      if (ownsExistingLink && !hasExistingProof && !hasSelfAssertedOwnership) {
        return interaction.editReply('❌ This legacy link is not trusted ownership proof. Contact a server administrator for review.');
      }
      if (hasSelfAssertedOwnership && linkSettings.verificationMode === 'admin_approval') {
        return interaction.editReply(
          '❌ This server requires administrator or moderator approval. Ask staff to use `/link-admin force-link`.'
        );
      }
      if (hasExistingProof && account.membership_status === 'active' && account.membership_user_id === userId) {
        return interaction.editReply({ content: `✅ Your account **${gamertag}** is already linked to this server!` });
      }

      let challenge = null;
      let verificationMethod = hasExistingProof ? 'existing_verified_link' : null;
      if (!hasExistingProof && linkSettings.verificationMode === 'open') {
        verificationMethod = 'self_asserted';
      }

      if (!hasExistingProof && linkSettings.verificationMode === 'emote') {
        verificationMethod = 'emote_challenge';
        const now = new Date();
        let challengeRes = await pool.query(
          `SELECT id, user_id, guild_id, server_id, sequence, created_at, expires_at
           FROM player_link_challenges
           WHERE identity_id = $1 AND status = 'pending'
           ORDER BY created_at DESC
           LIMIT 1`,
          [account.id]
        );
        challenge = challengeRes.rows[0];

        if (challenge && new Date(challenge.expires_at) <= now) {
          const expired = await pool.query(
            "UPDATE player_link_challenges SET status = 'expired' WHERE id = $1 AND status = 'pending'",
            [challenge.id]
          );
          if (expired.rowCount !== 1) {
            return interaction.editReply('❌ Ownership challenge changed; run the command again.');
          }
          challenge = null;
        }
        if (challenge && challenge.user_id !== userId) {
          return interaction.editReply('❌ This game identity already has a pending ownership challenge.');
        }
        if (challenge &&
            (String(challenge.guild_id) !== String(account.guild_id)
             || String(challenge.server_id) !== String(account.server_id))) {
          return interaction.editReply('❌ This ownership challenge belongs to another server or Discord guild.');
        }

        if (!challenge) {
          const sequence = createEmoteChallengeSequence();
          const expiresAt = new Date(now.getTime() + LINK_CHALLENGE_TTL_MS);
          challengeRes = await pool.query(
            `INSERT INTO player_link_challenges
               (user_id, identity_id, guild_id, server_id, sequence, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, user_id, sequence, created_at, expires_at`,
            [userId, account.id, guild.id, account.server_id, JSON.stringify(sequence), expiresAt]
          );
          challenge = challengeRes.rows[0];
        }

        const eventsRes = await pool.query(
          `SELECT emote_type, timestamp
           FROM player_emote_events
           WHERE identity_id = $1 AND server_id = $2
             AND timestamp >= $3 AND timestamp <= $4
           ORDER BY timestamp ASC, id ASC`,
          [account.id, account.server_id, challenge.created_at, challenge.expires_at]
        );
        const challengeResult = evaluateEmoteChallenge(
          challenge.sequence,
          eventsRes.rows,
          challenge.created_at,
          challenge.expires_at
        );

        if (!challengeResult.verified) {
          const steps = formatEmoteSequence(challenge.sequence)
            .map(step => `${step.position}. **${step.label}**`)
            .join('\n');
          return interaction.editReply({
            content: `🔐 **Ownership check required**\n\nJoin **${account.server_name}** as **${gamertag}** and perform these emotes in order:\n${steps}\n\nWait for the next log sync, then run \`/link gamertag:${gamertag} server:${account.platform_server_id}\` again. This challenge expires in 30 minutes.`
          });
        }
      }

      if (!verificationMethod) {
        return interaction.editReply('❌ The selected server has an invalid player-link verification policy.');
      }

      const client = await pool.connect();
      let roleJob;
      try {
        await client.query('BEGIN');
        await lockPgUserRoleMutations(client, [userId]);
        await lockActiveLinkTenant(client, account.server_id, account.guild_id);
        if (!hasExistingProof) {
          const currentSettings = await getLinkSettings(client, account.server_id, { forUpdate: true });
          const expectedMode = verificationMethod === 'self_asserted' ? 'open' : 'emote';
          if (currentSettings.verificationMode !== expectedMode) {
            const policyChanged = new Error('Player-link policy changed');
            policyChanged.code = 'LINK_POLICY_CHANGED';
            throw policyChanged;
          }
        }
        let linkedAccountId = account.linked_account_id;
        if (linkedAccountId) {
          const lockedProofResult = await client.query(
            `SELECT id, user_id, verification_method
               FROM linked_accounts
              WHERE id = $1 AND identity_id = $2
              FOR UPDATE`,
            [linkedAccountId, account.id]
          );
          const lockedProof = lockedProofResult.rows[0];
          const methodStillValid = hasExistingProof
            ? isTrustedLinkMethod(lockedProof?.verification_method)
            : lockedProof?.verification_method === 'self_asserted';
          if (!lockedProof || Number(lockedProof.user_id) !== Number(userId) || !methodStillValid) {
            const conflict = new Error('Ownership changed while linking');
            conflict.code = 'OWNERSHIP_CONFLICT';
            throw conflict;
          }
        }
        if (!hasExistingProof) {
          if (hasSelfAssertedOwnership) {
            if (verificationMethod === 'emote_challenge') {
              await client.query(
                `UPDATE linked_accounts
                    SET verification_method = 'emote_challenge', verified_by_guild_id = $2
                  WHERE id = $1 AND user_id = $3 AND identity_id = $4`,
                [linkedAccountId, guild.id, userId, account.id]
              );
            }
          } else {
            const linkedResult = await client.query(
              `INSERT INTO linked_accounts (user_id, identity_id, verified_by_guild_id, verification_method)
               VALUES ($1, $2, $3, $4)
               RETURNING id`,
              [userId, account.id, guild.id, verificationMethod]
            );
            linkedAccountId = linkedResult.rows[0].id;
          }
        }
        await client.query(
          `INSERT INTO server_player_memberships
             (server_id, guild_id, identity_id, user_id, source_link_id, verification_method, verified_by_user_id, status, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', CURRENT_TIMESTAMP)
           ON CONFLICT (server_id, identity_id) DO UPDATE SET
             guild_id = EXCLUDED.guild_id,
             user_id = EXCLUDED.user_id,
             source_link_id = EXCLUDED.source_link_id,
             verification_method = EXCLUDED.verification_method,
             verified_by_user_id = EXCLUDED.verified_by_user_id,
             status = 'active',
             updated_at = CURRENT_TIMESTAMP`,
          [account.server_id, account.guild_id, account.id, userId, linkedAccountId, verificationMethod, userId]
        );
        if (challenge) {
          const challengeUpdate = await client.query(
            "UPDATE player_link_challenges SET status = 'verified', verified_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'pending'",
            [challenge.id]
          );
          if (challengeUpdate.rowCount !== 1) {
            const conflict = new Error('Ownership challenge was already consumed');
            conflict.code = 'CHALLENGE_CONSUMED';
            throw conflict;
          }
        }
        roleJob = await enqueueRoleReconciliationJob(client, {
          discordGuildId: guildId,
          discordUserId: discordId,
          userId,
        });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      try {
        await runRoleReconciliationJob({
          db: pool,
          job: roleJob,
          member: interaction.member,
        });
      } catch (roleError) {
        console.warn(`⚠️ Account linked, but Discord role automation failed: ${roleError.message}`);
      }

      const playerPortalUrl = getWebsiteLink('/player-portal');
      await interaction.editReply({
        content: `✅ **${verificationMethod === 'emote_challenge' ? 'Ownership verified and account linked' : 'Account linked'}!**` +
          (playerPortalUrl ? `\n\nView your stats on the dashboard:\n🔗 ${playerPortalUrl}` : '')
      });

    } catch (error) {
      console.error('❌ Error linking account:', error);
      const message = error.code === 'LINK_POLICY_CHANGED'
        ? 'Link verification settings changed. Run the command again.'
        : error.code === '23505' || error.code === 'CHALLENGE_CONSUMED' || error.code === 'OWNERSHIP_CONFLICT'
          ? 'This account is already linked or its ownership challenge was already used.'
          : 'Unable to link this account right now. Please try again.';
      await interaction.editReply({
        content: `❌ **Error:** ${message}`
      });
    }
  },
  lockActiveLinkTenant,
};
