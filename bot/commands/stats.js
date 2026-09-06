/*
 * bot/commands/stats.js
 *
 * Public command to look up stats for any player by gamertag.
 * Shows kills, deaths, K/D ratio, playtime, last seen, and alt account count.
 */

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
// pool is required lazily inside execute() so deploy-commands.js can load this file without a DB connection.

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Look up stats for a DayZ player')
    .addStringOption(opt =>
      opt.setName('gamertag')
        .setDescription('Xbox gamertag to look up')
        .setRequired(true)
    )
    .addStringOption(opt => opt
      .setName('server')
      .setDescription('Nitrado service ID (required when this guild has multiple servers)')),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const pool = require('../db');
    const gamertag = interaction.options.getString('gamertag').trim();
    const serverId = interaction.authorizedServerId;

    try {
      // Find the player by gamertag — gamertags live in player_gamertags, not player_identities
      const identityRes = await pool.query(
        `SELECT pi.id, COALESCE(pg.gamertag, pi.platform_username) AS gamertag,
                pi.platform, pi.platform_user_id, pi.player_id
         FROM player_gamertags pg
         JOIN player_identities pi ON pi.id = pg.identity_id
         WHERE LOWER(pg.gamertag) = LOWER($1)
           AND pg.is_current_gamertag = 1
           AND pg.server_id = $2
         LIMIT 1`,
        [gamertag, serverId]
      );

      if (identityRes.rows.length === 0) {
        return interaction.editReply(`❌ No player found with gamertag **${gamertag}**.\nThey may not have joined the server yet.`);
      }

      const identity = identityRes.rows[0];

      // Fetch kills, deaths, playtime, and last seen in one query
      const statsRes = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM kill_events ke
            WHERE ke.killer_identity_id = $1 AND ke.server_id = $2) AS kills,
           (SELECT COUNT(*) FROM kill_events ke
            WHERE ke.victim_identity_id = $1 AND ke.server_id = $2) AS deaths,
           (SELECT COALESCE(SUM(ps.duration), 0) FROM player_sessions ps
            WHERE ps.identity_id = $1 AND ps.server_id = $2) AS playtime_seconds,
           (SELECT MAX(ps.ended_at) FROM player_sessions ps
            WHERE ps.identity_id = $1 AND ps.server_id = $2) AS last_seen`,
        [identity.id, serverId]
      );

      const stats = statsRes.rows[0];
      const kills = parseInt(stats.kills, 10);
      const deaths = parseInt(stats.deaths, 10);
      const playtimeSecs = parseInt(stats.playtime_seconds, 10);
      const kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills > 0 ? '∞' : '0.00';

      // Format playtime into hours and minutes
      const playtimeHrs = Math.floor(playtimeSecs / 3600);
      const playtimeMins = Math.floor((playtimeSecs % 3600) / 60);
      const playtimeDisplay = playtimeSecs > 0
        ? `${playtimeHrs}h ${playtimeMins}m`
        : 'No sessions recorded';

      // Last seen formatting
      const lastSeenDisplay = stats.last_seen
        ? `<t:${Math.floor(new Date(stats.last_seen).getTime() / 1000)}:R>`
        : 'Never';

      // Count alt accounts linked to the same player record
      let altCount = 0;
      if (identity.player_id) {
        const altRes = await pool.query(
          `SELECT COUNT(DISTINCT pi.id) AS cnt
           FROM player_identities pi
           JOIN player_gamertags pg ON pg.identity_id = pi.id
           WHERE pi.player_id = $1 AND pi.id != $2 AND pg.server_id = $3`,
          [identity.player_id, identity.id, serverId]
        );
        altCount = parseInt(altRes.rows[0].cnt, 10);
      }

      const embed = new EmbedBuilder()
        .setTitle(`🎮 ${identity.gamertag}`)
        .setColor(0x5865f2)
        .addFields(
          { name: '🔪 Kills',      value: `${kills}`,            inline: true },
          { name: '💀 Deaths',     value: `${deaths}`,           inline: true },
          { name: '⚖️ K/D',        value: `${kd}`,               inline: true },
          { name: '⏱️ Playtime',   value: playtimeDisplay,       inline: true },
          { name: '🕒 Last Seen',  value: lastSeenDisplay,       inline: true },
          { name: '👥 Alt Accounts', value: `${altCount}`,       inline: true }
        )
        .setFooter({ text: `Platform: ${identity.platform || 'Xbox'}` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });

    } catch (err) {
      console.error('❌ /player error:', err);
      return interaction.editReply('❌ Error fetching player stats.');
    }
  }
};
