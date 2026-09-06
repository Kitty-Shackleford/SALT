/*
 * bot/commands/leaderboard.js
 *
 * Public command showing the top 10 players for a chosen stat category:
 * kills, deaths, playtime, or K/D ratio.
 */

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
// pool is required lazily inside execute() so deploy-commands.js can load this file without a DB connection.

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show the top 10 players on the server')
    .addStringOption(opt =>
      opt.setName('category')
        .setDescription('Stat to rank by')
        .setRequired(true)
        .addChoices(
          { name: '🔪 Kills',    value: 'kills'    },
          { name: '💀 Deaths',   value: 'deaths'   },
          { name: '⏱️ Playtime', value: 'playtime' },
          { name: '⚖️ K/D Ratio', value: 'kd'     }
        )
    )
    .addStringOption(opt => opt
      .setName('server')
      .setDescription('Nitrado service ID (required when this guild has multiple servers)')),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const pool = require('../db');
    const category = interaction.options.getString('category');
    const serverId = interaction.authorizedServerId;

    try {
      let rows;

      if (category === 'kills') {
        // killer_gamertag is stored directly on kill_events — no join to player_identities needed
        const res = await pool.query(`
          SELECT ke.killer_gamertag AS gamertag, COUNT(*) AS value
          FROM kill_events ke
          WHERE ke.killer_gamertag IS NOT NULL AND ke.killer_gamertag != ''
            AND ke.server_id = $1
          GROUP BY ke.killer_gamertag
          ORDER BY value DESC
          LIMIT 10
        `, [serverId]);
        rows = res.rows.map(r => ({ gamertag: r.gamertag, display: `${r.value} kills` }));

      } else if (category === 'deaths') {
        const res = await pool.query(`
          SELECT ke.victim_gamertag AS gamertag, COUNT(*) AS value
          FROM kill_events ke
          WHERE ke.victim_gamertag IS NOT NULL AND ke.victim_gamertag != ''
            AND ke.server_id = $1
          GROUP BY ke.victim_gamertag
          ORDER BY value DESC
          LIMIT 10
        `, [serverId]);
        rows = res.rows.map(r => ({ gamertag: r.gamertag, display: `${r.value} deaths` }));

      } else if (category === 'playtime') {
        const res = await pool.query(`
          SELECT
            COALESCE(pg.gamertag, pi.platform_username) AS gamertag,
            COALESCE(SUM(ps.duration), 0) AS value
          FROM player_sessions ps
          JOIN player_identities pi ON pi.id = ps.identity_id
          LEFT JOIN player_gamertags pg ON pg.identity_id = pi.id
            AND pg.server_id = ps.server_id
            AND pg.is_current_gamertag = 1
          WHERE ps.server_id = $1
          GROUP BY pi.id, COALESCE(pg.gamertag, pi.platform_username)
          HAVING COALESCE(SUM(ps.duration), 0) > 0
          ORDER BY value DESC
          LIMIT 10
        `, [serverId]);
        rows = res.rows.map(r => {
          const secs = parseInt(r.value, 10);
          const hrs = Math.floor(secs / 3600);
          const mins = Math.floor((secs % 3600) / 60);
          return { gamertag: r.gamertag, display: `${hrs}h ${mins}m` };
        });

      } else if (category === 'kd') {
        // Minimum 5 kills required; uses gamertags stored on kill_events rows
        const res = await pool.query(`
          SELECT
            gamertag,
            SUM(kills)   AS kills,
            SUM(deaths)  AS deaths
          FROM (
            SELECT killer_gamertag AS gamertag, COUNT(*) AS kills, 0 AS deaths
            FROM kill_events ke
            WHERE killer_gamertag IS NOT NULL AND killer_gamertag != ''
              AND ke.server_id = $1
            GROUP BY killer_gamertag
            UNION ALL
            SELECT victim_gamertag AS gamertag, 0 AS kills, COUNT(*) AS deaths
            FROM kill_events ke
            WHERE victim_gamertag IS NOT NULL AND victim_gamertag != ''
              AND ke.server_id = $1
            GROUP BY victim_gamertag
          ) sub
          GROUP BY gamertag
          HAVING SUM(kills) >= 5
          ORDER BY
            CASE WHEN SUM(deaths) = 0
              THEN SUM(kills)
              ELSE SUM(kills)::float / SUM(deaths)
            END DESC
          LIMIT 10
        `, [serverId]);
        rows = res.rows.map(r => {
          const k = parseInt(r.kills, 10);
          const d = parseInt(r.deaths, 10);
          const kd = d > 0 ? (k / d).toFixed(2) : '∞';
          return { gamertag: r.gamertag, display: `${kd} K/D  (${k}K / ${d}D)` };
        });
      }

      if (!rows || rows.length === 0) {
        return interaction.editReply('📭 No data yet — no players have been recorded for this stat.');
      }

      // Medal emojis for top 3
      const medals = ['🥇', '🥈', '🥉'];
      const categoryLabels = { kills: '🔪 Kills', deaths: '💀 Deaths', playtime: '⏱️ Playtime', kd: '⚖️ K/D Ratio' };

      const description = rows
        .map((row, i) => `${medals[i] || `**${i + 1}.**`} **${row.gamertag}** — ${row.display}`)
        .join('\n');

      const embed = new EmbedBuilder()
        .setTitle(`🏆 Leaderboard — ${categoryLabels[category]}`)
        .setColor(0xfaa61a)
        .setDescription(description)
        .setTimestamp();

      if (category === 'kd') {
        embed.setFooter({ text: 'Minimum 5 kills required to appear on K/D leaderboard' });
      }

      return interaction.editReply({ embeds: [embed] });

    } catch (err) {
      console.error('❌ /leaderboard error:', err);
      return interaction.editReply('❌ Error fetching leaderboard.');
    }
  }
};
