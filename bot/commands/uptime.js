/*
 * bot/commands/uptime.js
 *
 * /uptime — show how long the DayZ server has been running this session.
 *
 * Start-time resolution order (most → least accurate):
 *   1. Newest local RPT log filename  (DayZServer_X1_x64_YYYY-MM-DD_HH-MM-SS.RPT)
 *      These are downloaded by the log sync service into:
 *        downloads/{guildId}/server_{platformServerId}/config/
 *   2. Nitrado gameserver.last_status_change  (fallback)
 */

const fs   = require('fs');
const path = require('path');
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getServerCreds } = require('../utils/nitrado');

// Matches RPT filenames: DayZServer_X1_x64_2025-04-01_13-22-45.RPT
const RPT_REGEX = /(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.RPT$/i;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('uptime')
    .setDescription('Show how long the DayZ server has been running this session')
    .addStringOption(opt => opt
      .setName('server')
      .setDescription('Nitrado service ID (required when this guild has multiple servers)')),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const requestedServer = interaction.options.getString('server');
    let creds;
    try {
      creds = await getServerCreds(interaction.guild.id, requestedServer, interaction.authorizedServerId);
    } catch (err) {
      return interaction.editReply(`❌ Database error: ${err.message}`);
    }
    if (!creds)              return interaction.editReply('❌ No active server found. Run `/register-token` first.');
    if (!creds.gameserver)   return interaction.editReply('❌ Could not reach Nitrado to fetch server data.');

    const { gameserver, serverName, platformServerId } = creds;
    const isOnline = gameserver.status === 'started';

    // Resolve server start time.
    const startMs = resolveStartTime(interaction.guild.id, platformServerId, gameserver);

    if (!startMs) {
      return interaction.editReply('❌ Could not determine when the server started. Log sync may not have run yet.');
    }

    const nowMs    = Date.now();
    const uptimeMs = nowMs - startMs;

    // Sanity check — if start time is in the future, data is unreliable.
    if (uptimeMs < 0) {
      return interaction.editReply('⚠️ Server start time is in the future — data may be out of sync.');
    }

    const startSeconds = Math.floor(startMs / 1000);
    const { hours, minutes, seconds } = msToHMS(uptimeMs);

    const embed = new EmbedBuilder()
      .setTitle(`⏱️ Server Uptime — ${serverName}`)
      .setColor(isOnline ? 0x57f287 : 0xed4245)
      .addFields(
        {
          name:   isOnline ? '🟢 Status' : '🔴 Status',
          value:  isOnline ? 'Online' : 'Offline',
          inline: true,
        },
        {
          name:   '⏱️ Uptime',
          value:  formatUptime(hours, minutes, seconds),
          inline: true,
        },
        {
          name:   '🕐 Started',
          value:  `<t:${startSeconds}:F>  (<t:${startSeconds}:R>)`,
          inline: false,
        }
      )
      .setTimestamp()
      .setFooter({ text: 'Start time from RPT log or Nitrado' });

    return interaction.editReply({ embeds: [embed] });
  },
};

/**
 * Tries to determine when the server started.
 * Checks the newest local RPT filename first, then falls back to
 * Nitrado's last_status_change field.
 *
 * @returns {number|null} Unix timestamp in ms, or null if unknown.
 */
function resolveStartTime(guildDiscordId, platformServerId, gameserver) {
  // 1. RPT log filename (most accurate — written by DayZ itself at boot).
  try {
    const sanitize  = s => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');
    const configDir = path.join(
      __dirname, '..', '..', 'downloads',
      sanitize(guildDiscordId),
      `server_${platformServerId}`,
      'config'
    );

    if (fs.existsSync(configDir)) {
      const newest = fs.readdirSync(configDir)
        .filter(f => RPT_REGEX.test(f))
        .sort()
        .reverse()[0];

      if (newest) {
        const m = newest.match(RPT_REGEX);
        if (m) {
          const iso  = `${m[1]}T${m[2].replace(/-/g, ':')}Z`;
          const ms   = new Date(iso).getTime();
          if (!isNaN(ms)) return ms;
        }
      }
    }
  } catch {
    // Fall through to Nitrado fallback.
  }

  // 2. Nitrado last_status_change.
  const lastChange = gameserver?.last_status_change;
  if (lastChange) {
    const ms = new Date(lastChange).getTime();
    if (!isNaN(ms)) return ms;
  }

  return null;
}

// Convert milliseconds to { hours, minutes, seconds }.
function msToHMS(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  return {
    hours:   Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

// Format uptime as "3h 22m 10s", "45m 10s", or "30s".
function formatUptime(hours, minutes, seconds) {
  if (hours > 0)   return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
