/*
 * bot/commands/ban-list.js
 *
 * /ban-list — Publicly view the server's active ban list.
 *
 * Any member can use this command.  Unlike /ban (admin-only), this is
 * intentionally visible to everyone so the community can see who has been
 * removed from the server.
 *
 * Options:
 *   /ban-list [search] — optional gamertag filter (case-insensitive substring)
 *   /ban-list [page]   — page number for large lists (25 entries per page)
 */

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getServerCreds, getFilePaths, readNitradoList } = require('../utils/nitrado');

const PAGE_SIZE = 25;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban-list')
    .setDescription('View the active ban list for this server')
    .addStringOption(opt =>
      opt
        .setName('search')
        .setDescription('Filter by gamertag (partial match)')
    )
    .addIntegerOption(opt =>
      opt
        .setName('page')
        .setDescription(`Page number (${PAGE_SIZE} entries per page, default: 1)`)
        .setMinValue(1)
    )
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
    if (!creds) return interaction.editReply('❌ No active server configured. Ask an admin to run `/register-token`.');

    let ftpBase;
    try {
      ({ ftpBase } = getFilePaths(creds.gameserver));
    } catch (_) {
      return interaction.editReply('❌ Could not reach Nitrado to determine server file paths.');
    }
    const filePath = `${ftpBase}ban.txt`;

    let allBanned;
    try {
      allBanned = await readNitradoList(creds.token, creds.platformServerId, filePath);
    } catch (err) {
      console.error('❌ /ban-list fetch error:', err);
      return interaction.editReply(`❌ Failed to fetch ban list: ${err.message}`);
    }

    // Apply search filter.
    const searchQuery = (interaction.options.getString('search') ?? '').trim().toLowerCase();
    const filtered = searchQuery
      ? allBanned.filter(g => g.toLowerCase().includes(searchQuery))
      : allBanned;

    const page     = interaction.options.getInteger('page') ?? 1;
    const total    = filtered.length;
    const maxPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(page, maxPages);
    const start    = (safePage - 1) * PAGE_SIZE;
    const slice    = filtered.slice(start, start + PAGE_SIZE);

    const embed = new EmbedBuilder()
      .setTitle(`🔨 Ban List — ${creds.serverName}`)
      .setColor(0xed4245)
      .setTimestamp();

    // Build footer with context.
    const footerParts = [`${total} banned player${total !== 1 ? 's' : ''}`];
    if (searchQuery) footerParts.push(`Filter: "${searchQuery}"`);
    if (maxPages > 1) footerParts.push(`Page ${safePage}/${maxPages}`);
    embed.setFooter({ text: footerParts.join(' · ') });

    if (total === 0) {
      embed.setDescription(
        searchQuery
          ? `*No banned players match \`${searchQuery}\`.*`
          : '*No players are currently banned.*'
      );
      return interaction.editReply({ embeds: [embed] });
    }

    // Format list with entry numbers relative to the full filtered list.
    const lines = slice.map((gamertag, i) => `\`${start + i + 1}.\` ${gamertag}`);
    embed.setDescription(lines.join('\n'));

    // Hint if there are more pages.
    if (safePage < maxPages) {
      embed.addFields({
        name: '\u200b',
        value: `*Use \`/ban-list page:${safePage + 1}\` to see the next page.*`,
      });
    }

    return interaction.editReply({ embeds: [embed] });
  },
};
