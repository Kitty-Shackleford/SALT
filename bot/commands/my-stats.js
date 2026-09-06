const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const pool = require('../db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('my-stats')
    .setDescription('View your linked game accounts and stats')
    .addStringOption(opt => opt
      .setName('server')
      .setDescription('Nitrado service ID (required when this guild has multiple servers)')),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const discordId = interaction.user.id;
    const serverId = interaction.authorizedServerId;

    try {
      // Get user's linked game accounts with live stats from kill/session event tables.
      // player_stats and players.total_* are never populated — stats come from kill_events
      // and player_sessions instead.
      const linkedRes = await pool.query(`
        SELECT DISTINCT ON (pi.id)
          pi.id,
          pg.gamertag,
          pi.platform,
          pi.last_seen as last_seen_at,
          (SELECT COUNT(*) FROM kill_events ke
           WHERE ke.killer_identity_id = pi.id AND ke.server_id = $2) AS total_kills,
          (SELECT COUNT(*) FROM kill_events ke
           WHERE ke.victim_identity_id = pi.id AND ke.server_id = $2) AS total_deaths,
          (SELECT COALESCE(SUM(duration), 0) FROM player_sessions ps
           WHERE ps.identity_id = pi.id AND ps.server_id = $2) AS total_playtime
        FROM linked_accounts la
        JOIN users u ON la.user_id = u.id
        JOIN player_identities pi ON la.identity_id = pi.id
        JOIN server_player_memberships spm
          ON spm.source_link_id = la.id
         AND spm.user_id = la.user_id
         AND spm.identity_id = la.identity_id
         AND spm.server_id = $2
         AND spm.status = 'active'
        JOIN player_gamertags pg
          ON pi.id = pg.identity_id AND pg.server_id = $2 AND pg.is_current_gamertag = 1
        WHERE u.discord_id = $1
          AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
        ORDER BY pi.id, pg.last_seen DESC NULLS LAST
      `, [discordId, serverId]);
      const linkedAccounts = linkedRes.rows;

      if (linkedAccounts.length === 0) {
        return interaction.editReply({
          content: '❌ You have no linked accounts.\n\nUse `/link <gamertag>` to link your account!'
        });
      }

      // Fetch all server activities for all linked accounts in one query
      const accountIds = linkedAccounts.map(a => a.id);
      const activityRes = await pool.query(`
        SELECT
          psa.identity_id,
          s.name as server_name,
          g.name as guild_name,
          psa.last_seen,
          psa.first_seen
        FROM player_server_activity psa
        JOIN servers s ON psa.server_id = s.id
        LEFT JOIN guilds g ON s.guild_id = g.id
        WHERE psa.identity_id = ANY($1) AND psa.server_id = $2
        ORDER BY psa.identity_id, psa.last_seen DESC
      `, [accountIds, serverId]);
      const serverActivities = activityRes.rows;

      // Group server activities by identity ID
      const activityByAccount = {};
      serverActivities.forEach(activity => {
        if (!activityByAccount[activity.identity_id]) {
          activityByAccount[activity.identity_id] = [];
        }
        activityByAccount[activity.identity_id].push(activity);
      });

      const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle('🎮 Your Linked Accounts')
        .setDescription(`You have **${linkedAccounts.length}** linked account(s)`)
        .setTimestamp();

      for (const account of linkedAccounts) {
        const lastSeen = account.last_seen_at
          ? new Date(account.last_seen_at).toLocaleDateString()
          : 'Never';

        let statsText = `**Platform:** ${account.platform}\n` +
                       `**Last Seen:** ${lastSeen}\n`;

        const kills = Number(account.total_kills) || 0;
        const deaths = Number(account.total_deaths) || 0;
        const playtime = Number(account.total_playtime) || 0;
        const kd = deaths > 0 ? (kills / deaths).toFixed(2) : kills > 0 ? kills.toFixed(2) : '0.00';

        statsText += `**Stats:**\n` +
                    `  • Kills: ${kills}\n` +
                    `  • Deaths: ${deaths}\n` +
                    `  • K/D: ${kd}\n` +
                    `  • Playtime: ${Math.round(playtime / 3600)} hrs\n`;

        const serverActivity = activityByAccount[account.id] || [];
        if (serverActivity.length > 0) {
          statsText += `\n**Servers (${serverActivity.length}):**\n`;
          serverActivity.forEach((activity, idx) => {
            const serverLastSeen = activity.last_seen
              ? new Date(activity.last_seen).toLocaleDateString()
              : 'Never';
            const guild = activity.guild_name ? ` (${activity.guild_name})` : '';
            statsText += `  ${idx + 1}. ${activity.server_name}${guild} - ${serverLastSeen}\n`;
          });
        }

        embed.addFields({
          name: `${account.gamertag}`,
          value: statsText,
          inline: false
        });
      }

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('❌ Error fetching stats:', error);
      await interaction.editReply({
        content: `❌ **Error:** ${error.message}`
      });
    }
  }
};
