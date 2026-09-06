/*
 * bot/commands/online.js
 *
 * /online — show which players are currently on the server.
 *
 * Data comes from server_online_cache, which the log scanner keeps up-to-date
 * at the end of every ADM log scan. Discord mentions are shown only when an
 * online identity has a trusted active membership on this exact server.
 */

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const pool = require('../db');
const { getServerCreds } = require('../utils/nitrado');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('online')
    .setDescription('Show players currently online on the DayZ server')
    .addStringOption(opt =>
      opt.setName('server').setDescription('Server ID').setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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
      console.error('❌ /online server lookup error:', err);
      return interaction.editReply(`❌ Database error: ${err.message}`);
    }

    // Fetch online players, joining linked Discord accounts where available.
    let players;
    try {
      const res = await pool.query(
        `SELECT
           soc.gamertag,
           soc.login_at,
           u.discord_id
         FROM server_online_cache soc
         JOIN server_online_cache_snapshots snapshot
           ON snapshot.server_id = soc.server_id
         LEFT JOIN server_player_memberships spm
           ON spm.identity_id = soc.identity_id
          AND spm.server_id = soc.server_id
          AND spm.status = 'active'
         LEFT JOIN linked_accounts la
           ON la.id = spm.source_link_id
          AND la.user_id = spm.user_id
          AND la.identity_id = spm.identity_id
          AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
         LEFT JOIN users u ON u.id = la.user_id
         WHERE soc.server_id = $1
           AND snapshot.source_observed_at >= clock_timestamp() - INTERVAL '120 minutes'
           AND snapshot.source_observed_at <= clock_timestamp() + INTERVAL '5 minutes'
         ORDER BY soc.login_at ASC`,
        [serverDbId]
      );
      players = res.rows;
    } catch (err) {
      console.error('❌ /online player query error:', err);
      return interaction.editReply(`❌ Failed to fetch player list: ${err.message}`);
    }

    // Build the embed.
    const embed = new EmbedBuilder()
      .setTitle(`👥 Players Online — ${serverName}`)
      .setColor(players.length > 0 ? 0x57f287 : 0x99aab5)
      .setTimestamp()
      .setFooter({ text: `Last updated by log scanner` });

    if (players.length === 0) {
      embed.setDescription('*No players are currently reported online from fresh log evidence.*');
    } else {
      // Format each player as "Gamertag (@DiscordUser)" or just "Gamertag".
      const lines = players.map((p, i) => {
        const tag     = p.gamertag || '*Unknown*';
        const mention = p.discord_id ? ` — <@${p.discord_id}>` : '';
        const since   = p.login_at
          ? ` *(since <t:${Math.floor(new Date(p.login_at).getTime() / 1000)}:R>)*`
          : '';
        return `${i + 1}. **${tag}**${mention}${since}`;
      });

      // Discord embed descriptions cap at 4096 chars; split into chunks if needed.
      const chunks = chunkLines(lines, 4000);
      embed.setDescription(chunks[0]);

      // If there are somehow more than one chunk, add the rest as fields.
      for (let i = 1; i < chunks.length; i++) {
        embed.addFields({ name: '\u200b', value: chunks[i] });
      }

      embed.addFields({
        name: 'Total',
        value: `${players.length} player${players.length === 1 ? '' : 's'} online`,
        inline: false,
      });
    }

    return interaction.editReply({ embeds: [embed] });
  },
};

// Split an array of lines into chunks that fit within maxChars each.
function chunkLines(lines, maxChars) {
  const chunks = [];
  let current  = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxChars) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}
