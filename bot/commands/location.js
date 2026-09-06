/*
 * bot/commands/location.js
 *
 * /location <gamertag> — show a player's last known position on the server.
 *
 * Primary source: player_health_status (updated by the ADM log scanner).
 * Fallback:       player_position_snapshots (most recent snapshot row).
 *
 * The reply is ephemeral — only the user who ran the command can see it.
 * Note: consider restricting this to admin-only if you don't want all members
 * to be able to look up other players' positions during active sessions.
 */

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const pool = require('../db');
const { getServerCreds } = require('../utils/nitrado');
const { admTupleToWorld } = require('../../utils/dayzCoordinates');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('location')
    .setDescription("Show a player's last known location on the server")
    .addStringOption(opt =>
      opt
        .setName('gamertag')
        .setDescription('Gamertag of the player to look up')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('server').setDescription('Server ID').setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const gamertag      = interaction.options.getString('gamertag').trim();
    const requestedServer = interaction.options.getString('server');

    // Resolve the guild's active server DB id.
    let serverDbId, serverName;
    try {
      const creds = await getServerCreds(interaction.guild.id, requestedServer, interaction.authorizedServerId);
      if (!creds) {
        return interaction.editReply('❌ No active server found. Run `/register-token` first.');
      }
      serverDbId = creds.serverId;
      serverName = creds.serverName;
    } catch (err) {
      console.error('❌ /location server lookup error:', err);
      return interaction.editReply(`❌ Database error: ${err.message}`);
    }

    // Find the player's identity on this server via their gamertag.
    let identityId;
    try {
      const res = await pool.query(
        `SELECT identity_id
           FROM player_gamertags
          WHERE server_id = $1
            AND LOWER(gamertag) = LOWER($2)
          ORDER BY last_seen DESC NULLS LAST
          LIMIT 1`,
        [serverDbId, gamertag]
      );

      if (!res.rows[0]) {
        return interaction.editReply(`❌ No player found with gamertag **${gamertag}** on this server.`);
      }

      identityId = res.rows[0].identity_id;
    } catch (err) {
      console.error('❌ /location identity lookup error:', err);
      return interaction.editReply(`❌ Database error: ${err.message}`);
    }

    // Prefer regular PlayerList snapshots for location freshness, while joining
    // the independently tracked combat status when it exists.
    let location = null;
    try {
      const res = await pool.query(
        `SELECT ps.pos_x, ps.pos_y, ps.pos_z, ps.timestamp, phs.status
           FROM player_position_snapshots ps
           LEFT JOIN player_health_status phs
             ON phs.identity_id = ps.identity_id AND phs.server_id = ps.server_id
          WHERE ps.identity_id = $1
            AND ps.server_id   = $2
            AND ps.pos_x IS NOT NULL
            AND ps.pos_y IS NOT NULL
          ORDER BY ps.timestamp DESC
          LIMIT 1`,
        [identityId, serverDbId]
      );

      if (res.rows[0]) {
        const r = res.rows[0];
        location = {
          pos_x:     r.pos_x,
          pos_y:     r.pos_y,
          pos_z:     r.pos_z,
          status:    r.status,
          timestamp: r.timestamp,
          source:    'position snapshot',
        };
      }
    } catch {
      // Fall through to the combat-derived location.
    }

    // Fallback for players whose logs have combat positions but no snapshot.
    if (!location) {
      try {
        const res = await pool.query(
          `SELECT pos_x, pos_y, pos_z, status, last_updated
             FROM player_health_status
            WHERE identity_id = $1
              AND server_id   = $2`,
          [identityId, serverDbId]
        );

        if (res.rows[0] && res.rows[0].pos_x != null && res.rows[0].pos_y != null) {
          const r = res.rows[0];
          location = {
            pos_x:     r.pos_x,
            pos_y:     r.pos_y,
            pos_z:     r.pos_z,
            status:    r.status,
            timestamp: r.last_updated,
            source:    'health status',
          };
        }
      } catch (err) {
        console.error('❌ /location health fallback error:', err);
      }
    }

    if (!location) {
      return interaction.editReply(`❌ No location data found for **${gamertag}**. They may not have been seen since log tracking began.`);
    }
    const worldPosition = admTupleToWorld(location);

    // Check if the player is currently online.
    let isOnline = false;
    try {
      const res = await pool.query(
        `SELECT 1
           FROM server_online_cache cache
           JOIN server_online_cache_snapshots snapshot
             ON snapshot.server_id = cache.server_id
          WHERE cache.server_id   = $1
            AND cache.identity_id = $2
            AND snapshot.source_observed_at >= clock_timestamp() - INTERVAL '120 minutes'
            AND snapshot.source_observed_at <= clock_timestamp() + INTERVAL '5 minutes'
          LIMIT 1`,
        [serverDbId, identityId]
      );
      isOnline = res.rows.length > 0;
    } catch {
      // Best-effort — leave isOnline as false.
    }

    const statusEmoji = statusToEmoji(location.status, isOnline);
    const tsSeconds   = location.timestamp
      ? Math.floor(new Date(location.timestamp).getTime() / 1000)
      : null;
    const elevation = worldPosition.elevation == null
      ? 'Unknown'
      : `${Math.round(worldPosition.elevation)}m`;

    const embed = new EmbedBuilder()
      .setTitle(`📍 Last Known Location — ${gamertag}`)
      .setColor(isOnline ? 0x57f287 : 0x99aab5)
      .addFields(
        {
          name:   '🗺️ Coordinates',
          value:  `\`X: ${Math.round(worldPosition.east)}  Z: ${Math.round(worldPosition.north)}  Elev: ${elevation}\``,
          inline: false,
        },
        {
          name:   '🟢 Online Now',
          value:  isOnline ? 'Yes' : 'No',
          inline: true,
        },
        {
          name:   `${statusEmoji} Status`,
          value:  formatStatus(location.status, isOnline),
          inline: true,
        },
        {
          name:   '🕐 Last Seen',
          value:  tsSeconds ? `<t:${tsSeconds}:R>` : '*Unknown*',
          inline: true,
        }
      )
      .setFooter({ text: `Server: ${serverName}` })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};

// Map the health status string to an emoji.
function statusToEmoji(status, isOnline) {
  if (isOnline)           return '🟢';
  if (!status)            return '⚫';
  switch (status.toLowerCase()) {
    case 'alive':         return '🟢';
    case 'dead':          return '💀';
    case 'unconscious':   return '😵';
    default:              return '⚫';
  }
}

function formatStatus(status, isOnline) {
  if (isOnline && (!status || status.toLowerCase() === 'alive')) return 'Online / Alive';
  if (!status) return '*Unknown*';
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
}
