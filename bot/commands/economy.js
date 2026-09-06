/*
 * bot/commands/economy.js
 *
 * /economy — Browse the server's loot tables (types.xml).
 *
 * Parses the synced types.xml for the guild's server so players can look up
 * item spawn rates, categories, and map tier availability directly in Discord.
 *
 * Subcommands:
 *   /economy search <query> [map]
 *     Search items by name keyword. Returns up to 15 matches.
 *
 *   /economy item <name> [map]
 *     Show full details for one item (spawn counts, lifetime, usages, tiers).
 *
 * The <map> option defaults to auto-detection (first map folder found in
 * the guild's downloads directory).  Explicit choices: chernarusplus,
 * enoch (Livonia), sakhal.
 */

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getServerCreds } = require('../utils/nitrado');
const lootService = require('../services/lootService');

// Map names shown to users
const MAP_LABELS = {
  chernarusplus: 'Chernarus',
  enoch:         'Livonia',
  sakhal:        'Sakhal',
};

/** Format seconds as a human-readable duration string. */
function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('economy')
    .setDescription('Browse the server\'s loot tables')
    .addSubcommand(sub =>
      sub
        .setName('search')
        .setDescription('Search for items by name')
        .addStringOption(opt =>
          opt
            .setName('query')
            .setDescription('Item name or keyword to search for')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('map')
            .setDescription('Which map loot tables to search (default: auto-detect)')
            .addChoices(
              { name: 'Chernarus',  value: 'chernarusplus' },
              { name: 'Livonia',    value: 'enoch' },
              { name: 'Sakhal',     value: 'sakhal' },
            )
        )
        .addStringOption(opt => opt
          .setName('server')
          .setDescription('Nitrado service ID (required when this guild has multiple servers)'))
    )
    .addSubcommand(sub =>
      sub
        .setName('item')
        .setDescription('Show full details for a specific item')
        .addStringOption(opt =>
          opt
            .setName('name')
            .setDescription('Exact item class name (e.g. AK101, M4A1)')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('map')
            .setDescription('Which map loot tables to use (default: auto-detect)')
            .addChoices(
              { name: 'Chernarus',  value: 'chernarusplus' },
              { name: 'Livonia',    value: 'enoch' },
              { name: 'Sakhal',     value: 'sakhal' },
            )
        )
        .addStringOption(opt => opt
          .setName('server')
          .setDescription('Nitrado service ID (required when this guild has multiple servers)'))
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Resolve server credentials for the guild.
    const requestedServer = interaction.options.getString('server');
    let creds;
    try {
      creds = await getServerCreds(interaction.guild.id, requestedServer, interaction.authorizedServerId);
    } catch (err) {
      return interaction.editReply(`❌ Could not load server credentials: ${err.message}`);
    }

    if (!creds) {
      return interaction.editReply('❌ No Nitrado server configured for this guild.');
    }

    const { platformServerId } = creds;
    const guildDiscordId = interaction.guild.id;

    // Resolve map: explicit choice > auto-detect.
    const mapChoice = interaction.options.getString('map');
    const mapName   = mapChoice || lootService.detectMap(guildDiscordId, platformServerId);
    const mapLabel  = MAP_LABELS[mapName] || mapName;

    const sub = interaction.options.getSubcommand();
    if (sub === 'search') return handleSearch(interaction, guildDiscordId, platformServerId, mapName, mapLabel);
    if (sub === 'item')   return handleItem(interaction, guildDiscordId, platformServerId, mapName, mapLabel);
  },
};

// ─── /economy search ──────────────────────────────────────────────────────────

async function handleSearch(interaction, guildDiscordId, serverId, mapName, mapLabel) {
  const query = interaction.options.getString('query').trim();

  let results;
  try {
    results = await lootService.searchItems(
      mapName,
      { q: query },
      15,
      guildDiscordId,
      serverId
    );
  } catch (err) {
    console.error('❌ /economy search error:', err);
    return interaction.editReply(
      `❌ Failed to read loot tables. Make sure the server files have been synced.\n\`${err.message}\``
    );
  }

  const embed = new EmbedBuilder()
    .setTitle(`🎒 Loot Search — "${query}"`)
    .setColor(0x57f287)
    .setFooter({ text: `Map: ${mapLabel}` })
    .setTimestamp();

  if (results.length === 0) {
    embed.setDescription(`*No items found matching \`${query}\`.*\nTry a partial name like \`AK\` or \`Rifle\`.`);
    return interaction.editReply({ embeds: [embed] });
  }

  const lines = results.map(item => {
    const cat    = item.category[0] ?? '—';
    const usages = item.usages.length ? item.usages.join(', ') : '—';
    return `**${item.name}** · ${cat} · nominal **${item.nominal}** · \`${usages}\``;
  });

  embed.setDescription(lines.join('\n'));
  if (results.length === 15) {
    embed.setFooter({ text: `Map: ${mapLabel} · Showing first 15 results — refine your search for more specifics` });
  }

  return interaction.editReply({ embeds: [embed] });
}

// ─── /economy item ────────────────────────────────────────────────────────────

async function handleItem(interaction, guildDiscordId, serverId, mapName, mapLabel) {
  const itemName = interaction.options.getString('name').trim();

  let item;
  try {
    item = await lootService.getItem(mapName, itemName, guildDiscordId, serverId);
  } catch (err) {
    console.error('❌ /economy item error:', err);
    return interaction.editReply(
      `❌ Failed to read loot tables. Make sure the server files have been synced.\n\`${err.message}\``
    );
  }

  if (!item) {
    // Try case-insensitive fallback search to suggest the correct name.
    let suggestions = [];
    try {
      suggestions = await lootService.searchItems(mapName, { q: itemName }, 5, guildDiscordId, serverId);
    } catch {
      // ignore
    }

    let reply = `❌ No item found with class name \`${itemName}\`.`;
    if (suggestions.length > 0) {
      reply += `\n\n**Did you mean?**\n${suggestions.map(s => `• \`${s.name}\``).join('\n')}`;
    }
    return interaction.editReply(reply);
  }

  const embed = new EmbedBuilder()
    .setTitle(`📦 ${item.name}`)
    .setColor(0x5865f2)
    .setFooter({ text: `Map: ${mapLabel}` })
    .setTimestamp();

  // Core spawn fields
  embed.addFields(
    { name: 'Category',      value: item.category.join(', ') || '—',    inline: true },
    { name: 'Nominal',       value: String(item.nominal),                inline: true },
    { name: 'Minimum',       value: String(item.min),                    inline: true },
    { name: 'Lifetime',      value: formatDuration(item.lifetime),       inline: true },
    { name: 'Restock',       value: formatDuration(item.restock),        inline: true },
    { name: 'Quantity',      value: item.quantmin === -1
        ? 'N/A'
        : `${item.quantmin} – ${item.quantmax}`,                          inline: true },
  );

  if (item.usages.length) {
    embed.addFields({ name: 'Spawn Zones', value: item.usages.join(', '), inline: false });
  }
  if (item.values.length) {
    embed.addFields({ name: 'Map Tiers', value: item.values.join(', '), inline: false });
  }
  if (item.tags.length) {
    embed.addFields({ name: 'Tags', value: item.tags.join(', '), inline: false });
  }

  // Spawn flags
  const flags = item.flags ?? {};
  const flagLines = [
    `Count in cargo: **${flags.count_in_cargo === '1' ? 'Yes' : 'No'}**`,
    `Count in hoarder: **${flags.count_in_hoarder === '1' ? 'Yes' : 'No'}**`,
    `Count in map: **${flags.count_in_map === '1' ? 'Yes' : 'No'}**`,
    `Count on player: **${flags.count_in_player === '1' ? 'Yes' : 'No'}**`,
    `Crafted: **${flags.crafted === '1' ? 'Yes' : 'No'}**`,
    `Deloot: **${flags.deloot === '1' ? 'Yes' : 'No'}**`,
  ];
  embed.addFields({ name: 'Spawn Flags', value: flagLines.join('\n'), inline: false });

  return interaction.editReply({ embeds: [embed] });
}
