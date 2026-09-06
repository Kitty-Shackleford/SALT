/*
 * setup-status.js
 *
 * Admin-only slash command that creates and configures a "DayZ Server Status"
 * category with three channels:
 *   - #server-status  (text, pinned embed updated every 5 min)
 *   - 👥 Players: X/50  (voice, name updated by status service)
 *   - 🔄 Restart: Unknown  (voice, name updated by status service)
 *
 * Channel IDs are saved to server_features so the status
 * service can find them on every update cycle.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags
} = require('discord.js');
const pool = require('../db');
const { buildEmbed, resolveServerName, fetchServerData } = require('../services/serverStatusService');
const { getServerCreds } = require('../utils/nitrado');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-status')
    .setDescription('Create or refresh the DayZ Server Status channel for this Discord server')
    .addStringOption(opt =>
      opt.setName('server').setDescription('Server ID').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const requestedServer = interaction.options.getString('server');
    const authorizedServerId = interaction.authorizedServerId;

    if (!authorizedServerId) {
      return interaction.editReply('❌ Select an active server you are authorized to manage.');
    }

    try {
      // Resolve credentials for the same canonical server authorized by the bot.
      const creds = await getServerCreds(interaction.guild.id, requestedServer, interaction.authorizedServerId);
      if (!creds || creds.serverId !== interaction.authorizedServerId) {
        return interaction.editReply('❌ No active servers found for this guild. Run `/register-token` first.');
      }
      const server_db_id = creds.serverId;
      const platform_server_id = creds.platformServerId;
      const dbName = creds.serverName;
      const token = creds.token;

      // Fetch live server data to build the initial embed.
      const gameserver = await fetchServerData(token, platform_server_id);
      if (!gameserver) {
        return interaction.editReply('❌ Could not reach the Nitrado API. Check that your token is valid.');
      }
      const serverName = resolveServerName(dbName, gameserver);

      // Check for existing setup and remove old channels if present.
      const existingRes = await pool.query(
        `SELECT config FROM server_features
         WHERE server_id = $1 AND feature_name = 'server_status'`,
        [server_db_id]
      );
      if (existingRes.rows.length > 0) {
        const oldCfg = JSON.parse(existingRes.rows[0].config || '{}');
        // Delete old channels gracefully — ignore errors if they no longer exist
        for (const id of [oldCfg.category_id, oldCfg.text_channel_id, oldCfg.players_vc_id, oldCfg.restart_vc_id]) {
          if (!id) continue;
          try {
            const ch = await interaction.guild.channels.fetch(id).catch(() => null);
            if (ch) await ch.delete('Refreshing DayZ Server Status setup');
          } catch { /* channel already gone */ }
        }
      }

      // ── 5. Define permission overwrites ──────────────────────────────────────
      // Members can see but not send messages; bot has full control.
      const everyoneId = interaction.guild.roles.everyone.id;
      const botId = interaction.client.user.id;

      const categoryPerms = [
        { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
        { id: botId,      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] }
      ];

      const vcPerms = [
        { id: everyoneId, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.Connect] },
        { id: botId,      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels] }
      ];

      // ── 6. Create category ───────────────────────────────────────────────────
      const category = await interaction.guild.channels.create({
        name: '🎮 DayZ Server Status',
        type: ChannelType.GuildCategory,
        permissionOverwrites: categoryPerms
      });

      // ── 7. Create text channel and post + pin the initial embed ──────────────
      const textChannel = await interaction.guild.channels.create({
        name: 'server-status',
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: categoryPerms,
        topic: `Live status for ${serverName} — updated every 5 minutes`
      });

      const initialEmbed = buildEmbed(serverName, gameserver, null);
      const statusMsg = await textChannel.send({ embeds: [initialEmbed] });
      await statusMsg.pin();

      // ── 8. Create voice channels ─────────────────────────────────────────────
      const playerCurrent = gameserver.query?.player_current ?? 0;
      const playerMax = gameserver.query?.player_max ?? gameserver.slots ?? 50;

      const playersVC = await interaction.guild.channels.create({
        name: `👥 Players: ${playerCurrent}/${playerMax}`,
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: vcPerms
      });

      const restartVC = await interaction.guild.channels.create({
        name: '🔄 Restart: Unknown',
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: vcPerms
      });

      // ── 9. Save config to the exact server feature ────────────────────────────
      const config = JSON.stringify({
        category_id:      category.id,
        text_channel_id:  textChannel.id,
        players_vc_id:    playersVC.id,
        restart_vc_id:    restartVC.id,
        pinned_message_id: statusMsg.id
      });

      await pool.query(
        `INSERT INTO server_features (server_id, feature_name, enabled, config)
         VALUES ($1, 'server_status', 1, $2)
         ON CONFLICT (server_id, feature_name) DO UPDATE
           SET config = EXCLUDED.config, enabled = 1, updated_at = CURRENT_TIMESTAMP`,
        [server_db_id, config]
      );

      await interaction.editReply(
        `✅ **Server Status channels created!**\n` +
        `📋 Category: **${category.name}**\n` +
        `📝 Text: ${textChannel}\n` +
        `🔊 Player count + restart VCs created\n\n` +
        `The embed will refresh automatically every 5 minutes.`
      );

    } catch (err) {
      console.error('❌ /setup-status error:', err);
      await interaction.editReply(`❌ **Error:** ${err.message}`);
    }
  }
};
