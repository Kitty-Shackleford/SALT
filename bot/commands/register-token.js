const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const pool = require('../db');
const { encryptToken } = require('../../utils/encryption');
const nitradoService = require('../../services/nitradoService');
const { platformLabel } = require('../../utils/dayzPlatform');
const { normalizeProviderServerName } = require('../../utils/serverNames');
const { getWebsiteLink } = require('../utils/website');
const {
  canRegisterExistingGuildToken,
  ensureAuthoritativeInitialGuildOwner,
  getDiscordSetupPermission,
  isEligibleInitialGuildOwner,
  selectInitialGuildOwner,
  resolveSetupUsersAndLock,
} = require('../services/guildSetupService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('register-token')
    .setDescription('Register your Nitrado API token for this Discord server')
    .addStringOption(option =>
      option.setName('token')
        .setDescription('Your Nitrado API token')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  
  async execute(interaction) {
    const setupPermission = await getDiscordSetupPermission(interaction);
    if (!isEligibleInitialGuildOwner(setupPermission)) {
      return interaction.reply({
        content: '❌ The Discord guild owner or a member with Administrator permission is required.',
        flags: MessageFlags.Ephemeral
      });
    }
    const initialOwner = selectInitialGuildOwner(setupPermission);
    if (!initialOwner) {
      return interaction.reply({
        content: '❌ Unable to verify the Discord guild owner. Please try again later.',
        flags: MessageFlags.Ephemeral
      });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const token = interaction.options.getString('token');
    const guildId = interaction.guild.id;
    const guildName = interaction.guild.name;
    const guildIcon = interaction.guild.iconURL();
    
    const discordId = interaction.user.id;
    const username = interaction.user.username;
    const avatar = interaction.user.avatar;

    let client;
    let releaseError;
    try {
      // Validate the token's OAuth scopes before the provider read calls so a
      // token that is valid but missing user_info/service gets a specific,
      // actionable reply instead of a confusing 502 from /user or /services.
      const tokenValidation = await nitradoService.validateRegistrationToken(token);
      if (tokenValidation.status === 'invalid') {
        return interaction.editReply({
          content: '❌ This Nitrado token could not be used to sign in to your account. ' +
            'Please check that you copied the full token and try again.',
        });
      }
      if (tokenValidation.status === 'valid' && tokenValidation.missingScopes.length > 0) {
        const scopeList = tokenValidation.missingScopes.map(scope => `\`${scope}\``).join(' and ');
        return interaction.editReply({
          content: '❌ This Nitrado token is missing the permission scope(s): ' + scopeList + '.\n\n' +
            'To fix this, go to **My Account → API Tokens** in the Nitrado panel, ' +
            'edit (or recreate) the token, and make sure the following permissions are enabled:\n' +
            '  • `user_info` — lets the bot confirm which account the token belongs to\n' +
            '  • `service` — lets the bot find your DayZ servers\n\n' +
            'Save the token, then re-run this command with the updated token.',
        });
      }

      const { dayzServers, user: nitradoUser } = await nitradoService.getRegistrationData(token);
      const nitradoUserId = nitradoUser.id;

      console.log(`✅ Found ${dayzServers.length} DayZ server(s) across all platforms`);

      if (dayzServers.length === 0) {
        return interaction.editReply({
          content: '⚠️ No DayZ servers found on this Nitrado account.'
        });
      }

      const encryptedToken = encryptToken(token);
      client = await pool.connect();
      await client.query('BEGIN');
      const setupUsers = await resolveSetupUsersAndLock(client, [
        { discordId, username, avatar }, initialOwner,
      ]);
      const userId = setupUsers.get(discordId).id;
      const ownerUserId = setupUsers.get(initialOwner.discordId).id;
      // Same guild fence as other first-time setup paths, after user fences.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(guildId)]);
      const guildBeforeSetup = await client.query(
        'SELECT id, status FROM guilds WHERE discord_guild_id = $1 FOR UPDATE',
        [guildId]
      );
      const existingGuild = guildBeforeSetup.rows[0];
      let ownerRes = { rows: [] };
      let actorRoleRes = { rows: [] };
      let existingTokenRes = { rows: [] };
      let setupStateRes = { rows: [] };
      if (existingGuild) {
        if (existingGuild.status === 'disabled') {
          throw new Error('This Discord server is disabled and cannot register a Nitrado account');
        }
        ownerRes = await client.query(
          `SELECT user_id FROM guild_roles
           WHERE guild_id = $1 AND role = 'owner' FOR UPDATE`,
          [existingGuild.id]
        );
        actorRoleRes = await client.query(
          `SELECT role FROM guild_roles
           WHERE guild_id = $1 AND user_id = $2 FOR UPDATE`,
          [existingGuild.id, userId]
        );
        if (ownerRes.rows.length > 0 &&
            !canRegisterExistingGuildToken(actorRoleRes.rows[0]?.role, ownerRes.rows.length)) {
          throw new Error('This guild is already registered; only its application owner or administrator can update the Nitrado token');
        }
      }

      if (existingGuild) {
        existingTokenRes = await client.query(
          `SELECT nitrado_user_id
           FROM guild_tokens
           WHERE guild_id = $1 AND token_type = 'nitrado'
           FOR UPDATE`,
          [existingGuild.id]
        );
        if (ownerRes.rows.length === 0) {
          setupStateRes = await client.query(
            `SELECT guild_id FROM guild_setup_state
             WHERE guild_id = $1 AND status = 'in_progress'
             FOR UPDATE`,
            [existingGuild.id]
          );
        }
      }

      const currentPermission = await getDiscordSetupPermission(interaction);
      if (!isEligibleInitialGuildOwner(currentPermission) ||
          currentPermission.authoritativeOwner?.discordId !== initialOwner.discordId ||
          String(interaction.guild?.id) !== String(guildId) ||
          String(interaction.user?.id) !== String(discordId)) {
        throw new Error('Discord identity or Administrator authority changed during registration');
      }

      const guildWrite = await client.query(
        `INSERT INTO guilds (discord_guild_id, name, icon_url, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT(discord_guild_id) DO UPDATE SET
           name = EXCLUDED.name, icon_url = EXCLUDED.icon_url`,
        [guildId, guildName, guildIcon]
      );
      if (guildWrite.rowCount !== 1) throw new Error('Unable to persist guild registration');
      const guildRes = await client.query(
        'SELECT id, status FROM guilds WHERE discord_guild_id = $1', [guildId]
      );
      const guildDbId = guildRes.rows[0].id;
      let guildStatus = guildRes.rows[0].status;
      if (!['pending', 'approved'].includes(guildStatus)) {
        throw new Error('This Discord server is disabled or unavailable for registration');
      }
      if (!existingGuild) {
        await client.query(
          `INSERT INTO guild_setup_state (guild_id, current_step, status, completed_steps)
           VALUES ($1, 'discord_connected', 'in_progress', '["discord_connected"]'::jsonb)
           ON CONFLICT (guild_id) DO NOTHING`,
          [guildDbId]
        );
        setupStateRes = await client.query(
          `SELECT guild_id FROM guild_setup_state
           WHERE guild_id = $1 AND status = 'in_progress'
           FOR UPDATE`,
          [guildDbId]
        );
        // The guild upsert and setup-state locks can wait after the early check.
        // Recheck against the same prelocked identities before tokens or grants.
        const latePermission = await getDiscordSetupPermission(interaction);
        if (!isEligibleInitialGuildOwner(latePermission) ||
            latePermission.authoritativeOwner?.discordId !== initialOwner.discordId ||
            String(interaction.guild?.id) !== String(guildId) ||
            String(interaction.user?.id) !== String(discordId)) {
          throw new Error('Discord identity or Administrator authority changed during registration');
        }
      }

      const accountOwnerRes = await client.query(
        'SELECT guild_id FROM guild_tokens WHERE nitrado_user_id = $1 AND guild_id <> $2',
        [nitradoUserId, guildDbId]
      );
      if (accountOwnerRes.rows.length > 0) {
        throw new Error('This Nitrado account is already registered to another Discord server');
      }

      const existingNitradoUserId = existingTokenRes.rows[0]?.nitrado_user_id;
      if (existingNitradoUserId && existingNitradoUserId !== nitradoUserId) {
        throw new Error('This Discord server is already bound to a different Nitrado account');
      }

      if (ownerRes.rows.length > 0) {
        await ensureAuthoritativeInitialGuildOwner(client, {
          guildId: guildDbId, actorUserId: userId, ownerUserId,
          owner: currentPermission.authoritativeOwner, assignIfMissing: false,
        });
      }

      // Bootstrap only an ownerless guild; never promote over an existing owner.
      const ownerlessGuild = ownerRes.rows.length === 0;
      if (ownerlessGuild) {
        if (setupStateRes.rows.length !== 1 || existingTokenRes.rows.length > 0) {
          throw new Error('This existing guild has no owner and requires explicit ownership reconciliation');
        }
      }

      // Insert or update token
      const tokenWrite = await client.query(
        `INSERT INTO guild_tokens (guild_id, token_hash, token_type, nitrado_user_id)
         VALUES ($1, $2, 'nitrado', $3)
         ON CONFLICT (guild_id, token_type) DO UPDATE SET
           token_hash = EXCLUDED.token_hash,
           nitrado_user_id = EXCLUDED.nitrado_user_id,
           last_used = CURRENT_TIMESTAMP
         WHERE guild_tokens.nitrado_user_id IS NULL
            OR guild_tokens.nitrado_user_id = EXCLUDED.nitrado_user_id
         RETURNING id`,
        [guildDbId, encryptedToken, nitradoUserId]
      );
      if (tokenWrite.rowCount !== 1) {
        throw new Error('This Discord guild is already bound to a different Nitrado account.');
      }
      console.log(`✅ Guild ${guildName} updated with token`);

      if (ownerlessGuild) {
        // Initial token insertion can wait on a unique lock after earlier checks.
        // Reverify the same prelocked identities before any initial role grant;
        // denial rolls back the token along with the rest of this transaction.
        const postTokenPermission = await getDiscordSetupPermission(interaction);
        if (!isEligibleInitialGuildOwner(postTokenPermission) ||
            postTokenPermission.authoritativeOwner?.discordId !== initialOwner.discordId ||
            String(interaction.guild?.id) !== String(guildId) ||
            String(interaction.user?.id) !== String(discordId)) {
          throw new Error('Discord identity or Administrator authority changed during registration');
        }
      }

      if (guildStatus === 'pending' || ownerlessGuild) {
        await ensureAuthoritativeInitialGuildOwner(client, {
          guildId: guildDbId,
          actorUserId: userId,
          ownerUserId,
          owner: initialOwner,
          assignIfMissing: ownerlessGuild,
        });
      }

      if (ownerlessGuild && userId !== ownerUserId) {
        const adminGrant = await client.query(
          `INSERT INTO guild_roles (guild_id, user_id, role, assigned_by)
           VALUES ($1, $2, 'admin', $2)
           ON CONFLICT (guild_id, user_id) DO UPDATE SET
             role = EXCLUDED.role, assigned_by = EXCLUDED.assigned_by,
             assigned_at = CURRENT_TIMESTAMP
           WHERE guild_roles.role <> 'owner'
           RETURNING user_id`,
          [guildDbId, userId]
        );
        if (adminGrant.rowCount !== 1 || adminGrant.rows[0]?.user_id !== userId) {
          throw new Error('Unable to assign the registering guild Administrator');
        }
        const grantAudit = await client.query(
          `INSERT INTO security_audit_events
             (actor_user_id, guild_id, action, result, target_type, target_id, metadata)
           VALUES ($1, $2, 'guild_setup.admin_granted', 'allowed', 'user', $3,
                   jsonb_build_object('source', 'verified_register_token',
                     'authority', 'discord_administrator', 'scope', 'guild',
                     'discordGuildId', $4::text, 'actorDiscordId', $5::text,
                     'authoritativeOwnerDiscordId', $6::text))`,
          [userId, guildDbId, String(userId), String(guildId), discordId, initialOwner.discordId]
        );
        if (grantAudit.rowCount !== 1) throw new Error('Unable to audit the guild Administrator grant');
      }

      const setupWrite = await client.query(
        `INSERT INTO guild_setup_state
           (guild_id, current_step, status, completed_steps, updated_by_user_id, updated_at)
         VALUES ($1, 'nitrado_connected', 'in_progress',
                 '["discord_connected","initial_owner_verified","nitrado_connected"]'::jsonb,
                 $2, NOW())
         ON CONFLICT (guild_id) DO UPDATE SET
           current_step = EXCLUDED.current_step,
           status = EXCLUDED.status,
           completed_steps = EXCLUDED.completed_steps,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at = EXCLUDED.updated_at,
           last_error = NULL
         WHERE guild_setup_state.status = 'in_progress'
           AND guild_setup_state.current_step IN ('discord_connected', 'initial_owner_verified', 'nitrado_connected')`,
        [guildDbId, userId]
      );

      if (ownerlessGuild && setupWrite.rowCount !== 1) throw new Error('Unable to advance initial guild setup');

      const registrationAudit = await client.query(
        `INSERT INTO security_audit_events
           (actor_user_id, guild_id, action, result, target_type, target_id, metadata)
         VALUES ($1, $2, 'guild_setup.register_token', 'allowed', 'guild', $3,
                 jsonb_build_object('discordGuildOwner', $4::boolean, 'discordAdministrator', $5::boolean))`,
        [userId, guildDbId, String(guildId), setupPermission.isGuildOwner, setupPermission.hasAdministrator]
      );

      if (registrationAudit.rowCount !== 1) throw new Error('Unable to audit token registration');

      // The command already verified the initiating member's live Discord
      // Administrator authority and resolved the authoritative guild owner.
      // Once the Nitrado identity and at least one DayZ service are verified,
      // the tenant is safe to activate without a
      // second platform-admin approval step.
      if (guildStatus === 'pending') {
        const approval = await client.query(
          `UPDATE guilds
              SET status = 'approved',
                  approved_at = CURRENT_TIMESTAMP,
                  approved_by = $2
            WHERE id = $1 AND status = 'pending'
            RETURNING id`,
          [guildDbId, userId]
        );
        if (approval.rowCount !== 1) {
          throw new Error('Guild approval state changed during setup; please retry');
        }
        guildStatus = 'approved';
        const approvalAudit = await client.query(
          `INSERT INTO security_audit_events
             (actor_user_id, guild_id, action, result, target_type, target_id, metadata)
           VALUES ($1, $2, 'guild_setup.approved', 'allowed', 'guild', $3,
                   jsonb_build_object('source', 'verified_register_token'))`,
          [userId, guildDbId, String(guildId)]
        );
        if (approvalAudit.rowCount !== 1) throw new Error('Unable to audit guild approval');
      }

      await client.query('COMMIT');

      const serverList = dayzServers.map(s => {
        const safeName = normalizeProviderServerName(s.name, s.id);
        return `  • **${safeName}** (${platformLabel(s.platform)}) - ID: ${s.id}`;
      }).join('\n');

      const dashboardUrl = getWebsiteLink();
      await interaction.editReply({
        content: `✅ **Nitrado token registered successfully!**\n\n` +
                  `🖥️ Found **${dayzServers.length}** DayZ server(s)\n` +
                  `🎮 Connected to **${guildName}**\n\n` +
                  `**Servers:**\n${serverList}\n\n` +
                  `✅ **Guild status:** Approved\n` +
                  `🔐 **Your dashboard access:** Guild ${userId === ownerUserId ? 'Owner' : 'Admin'} — only this Discord server. No platform-wide privileges are granted.\n` +
                  `Sign in to the dashboard with the **same Discord account** used for this command.\n` +
                  `The Discord guild owner remains the sole Guild Owner.\n\n` +
                  `**Next steps:**\n` +
                  (dashboardUrl ? `1. 🌐 Visit the dashboard: ${dashboardUrl}\n2. 🎚️ Guild owner: use the server toggles to enable the servers you want to manage\n` : '') +
                 `${dashboardUrl ? '3' : '1'}. 🔗 Players can link their accounts\n\n` +
                 `*Discovered servers stay disabled until the guild owner enables them on the dashboard.*`,
        allowedMentions: { parse: [] }
      });

    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          releaseError = rollbackError;
          console.error('❌ Failed to roll back token registration:', rollbackError.message);
        }
      }
      console.error('❌ Error registering token:', error);
      // Distinguish "Nitrado is having a bad moment" (5xx, timeouts, network,
      // or the 502 edge-outage body that reports as invalid_response) from a
      // token/permission problem. The former should tell users to retry rather
      // than re-copy their token.
      const transientCategories = ['upstream', 'timeout', 'network', 'invalid_response'];
      const isTransient = transientCategories.includes(error?.category);
      await interaction.editReply({
        content: isTransient
          ? '⚠️ Nitrado is temporarily unavailable — please try again in a few minutes.'
          : `❌ **Error:** ${error.message}\n\nPlease check your token and try again.`,
      });
    } finally {
      client?.release(releaseError);
    }
  }
};
