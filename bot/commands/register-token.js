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
    try {
      const [dayzServers, nitradoUser] = await Promise.all([
        nitradoService.listGameServers(token),
        nitradoService.getAuthenticatedUser(token),
      ]);
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
      // Serialize first-time setup by Discord guild. Concurrent eligible users
      // may retry, but only one transaction can create the initial owner.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(guildId)]);
      const guildBeforeSetup = await client.query(
        'SELECT id FROM guilds WHERE discord_guild_id = $1 FOR UPDATE',
        [guildId]
      );

      // Step 1: Create or update user in database
      const userRes = await client.query(
        'SELECT id FROM users WHERE discord_id = $1',
        [discordId]
      );
      let userId;
      if (userRes.rows.length > 0) {
        userId = userRes.rows[0].id;
        await client.query(
          'UPDATE users SET username = $1, avatar = $2 WHERE id = $3',
          [username, avatar, userId]
        );
        console.log(`✅ User ${username} (${discordId}) updated - DB ID: ${userId}`);
      } else {
        const newUserRes = await client.query(
          'INSERT INTO users (discord_id, username, avatar) VALUES ($1, $2, $3) RETURNING id',
          [discordId, username, avatar]
        );
        userId = newUserRes.rows[0].id;
        console.log(`✅ User ${username} (${discordId}) registered - DB ID: ${userId}`);
      }

      // Step 2: Insert or update guild
      await client.query(
        `INSERT INTO guilds (discord_guild_id, name, icon_url, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT(discord_guild_id) DO UPDATE SET
           name = EXCLUDED.name,
           icon_url = EXCLUDED.icon_url`,
        [guildId, guildName, guildIcon]
      );

      const guildRes = await client.query(
        'SELECT id, status FROM guilds WHERE discord_guild_id = $1',
        [guildId]
      );
      const guildDbId = guildRes.rows[0].id;
      let guildStatus = guildRes.rows[0].status || 'pending';
      await client.query('SELECT id FROM guilds WHERE id = $1 FOR UPDATE', [guildDbId]);

      if (guildBeforeSetup.rows.length === 0) {
        await client.query(
          `INSERT INTO guild_setup_state (guild_id, current_step, status, completed_steps)
           VALUES ($1, 'discord_connected', 'in_progress', '["discord_connected"]'::jsonb)
           ON CONFLICT (guild_id) DO NOTHING`,
          [guildDbId]
        );
      }

      if (guildStatus === 'disabled') {
        throw new Error('This Discord server is disabled and cannot register a Nitrado account');
      }

      const ownerRes = await client.query(
        `SELECT user_id FROM guild_roles
         WHERE guild_id = $1 AND role = 'owner'
         LIMIT 2`,
        [guildDbId]
      );
      if (ownerRes.rows.length > 0) {
        const actorRoleRes = await client.query(
          `SELECT role FROM guild_roles
           WHERE guild_id = $1 AND user_id = $2 AND role IN ('owner', 'admin')`,
          [guildDbId, userId]
        );
        if (!canRegisterExistingGuildToken(actorRoleRes.rows[0]?.role, ownerRes.rows.length)) {
          throw new Error('This guild is already registered; only its application owner or administrator can update the Nitrado token');
        }
      }

      const accountOwnerRes = await client.query(
        'SELECT guild_id FROM guild_tokens WHERE nitrado_user_id = $1 AND guild_id <> $2',
        [nitradoUserId, guildDbId]
      );
      if (accountOwnerRes.rows.length > 0) {
        throw new Error('This Nitrado account is already registered to another Discord server');
      }

      const existingTokenRes = await client.query(
        `SELECT nitrado_user_id
         FROM guild_tokens
         WHERE guild_id = $1 AND token_type = 'nitrado'
         FOR UPDATE`,
        [guildDbId]
      );
      const existingNitradoUserId = existingTokenRes.rows[0]?.nitrado_user_id;
      if (existingNitradoUserId && existingNitradoUserId !== nitradoUserId) {
        throw new Error('This Discord server is already bound to a different Nitrado account');
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

      // Bootstrap only an ownerless guild; never promote over an existing owner.
      const ownerlessGuild = ownerRes.rows.length === 0;
      if (ownerlessGuild) {
        const setupStateRes = await client.query(
          `SELECT guild_id FROM guild_setup_state
           WHERE guild_id = $1 AND status = 'in_progress'
           FOR UPDATE`,
          [guildDbId]
        );
        if (setupStateRes.rows.length !== 1) {
          throw new Error('This existing guild has no owner and requires explicit ownership reconciliation');
        }
      }

      if (guildStatus === 'pending' || ownerlessGuild) {
        await ensureAuthoritativeInitialGuildOwner(client, {
          guildId: guildDbId,
          actorUserId: userId,
          owner: initialOwner,
          assignIfMissing: ownerlessGuild,
        });
      }

      await client.query(
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

      await client.query(
        `INSERT INTO security_audit_events
           (actor_user_id, guild_id, action, result, target_type, target_id, metadata)
         VALUES ($1, $2, 'guild_setup.register_token', 'allowed', 'guild', $3,
                 jsonb_build_object('discordGuildOwner', $4::boolean, 'discordAdministrator', $5::boolean))`,
        [userId, guildDbId, String(guildId), setupPermission.isGuildOwner, setupPermission.hasAdministrator]
      );

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
        await client.query(
          `INSERT INTO security_audit_events
             (actor_user_id, guild_id, action, result, target_type, target_id, metadata)
           VALUES ($1, $2, 'guild_setup.approved', 'allowed', 'guild', $3,
                   jsonb_build_object('source', 'verified_register_token'))`,
          [userId, guildDbId, String(guildId)]
        );
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
                  `✅ **Guild status:** Approved\n\n` +
                  `**Next steps:**\n` +
                  (dashboardUrl ? `1. 🌐 Visit the dashboard: ${dashboardUrl}\n2. 🎚️ Use the server toggles to enable the servers you want to manage\n` : '') +
                 `${dashboardUrl ? '3' : '1'}. 🔗 Players can link their accounts\n\n` +
                 `*Discovered servers stay disabled until the guild owner enables them on the dashboard.*`,
        allowedMentions: { parse: [] }
      });

    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('❌ Failed to roll back token registration:', rollbackError.message);
        }
      }
      console.error('❌ Error registering token:', error);
      await interaction.editReply({
        content: `❌ **Error:** ${error.message}\n\nPlease check your token and try again.`
      });
    } finally {
      client?.release();
    }
  }
};
