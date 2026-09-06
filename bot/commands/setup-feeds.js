/*
 * bot/commands/setup-feeds.js
 *
 * /setup-feeds — Configure Discord feeds for kills, deaths, and faction wars
 *
 * Subcommands:
 *   /setup-feeds killfeed enable [channel]
 *     Enable the killfeed and post to the specified channel
 *
 *   /setup-feeds killfeed disable
 *     Disable the killfeed
 *
 *   /setup-feeds killfeed status
 *     Show current killfeed configuration
 *
 *   /setup-feeds faction enable [channel]
 *     Enable faction war feed
 *
 *   /setup-feeds faction disable
 *     Disable faction war feed
 */

const { SlashCommandBuilder, EmbedBuilder, ChannelType, MessageFlags } = require('discord.js');
const pool = require('../db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-feeds')
    .setDescription('Configure Discord feeds for server events')
    .setDefaultMemberPermissions(8) // Require Administrator
    .addSubcommandGroup(group =>
      group
        .setName('killfeed')
        .setDescription('Configure the killfeed')
        .addSubcommand(sub =>
          sub
            .setName('enable')
            .setDescription('Enable killfeed in a channel')
            .addChannelOption(opt =>
              opt
                .setName('channel')
                .setDescription('Channel to post kills to')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
            )
            .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
        )
        .addSubcommand(sub =>
          sub
            .setName('disable')
            .setDescription('Disable the killfeed')
            .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
        )
        .addSubcommand(sub =>
          sub
            .setName('status')
            .setDescription('Show killfeed configuration')
            .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName('faction')
        .setDescription('Configure faction war feed')
        .addSubcommand(sub =>
          sub
            .setName('enable')
            .setDescription('Enable faction war feed in a channel')
            .addChannelOption(opt =>
              opt
                .setName('channel')
                .setDescription('Channel to post faction wars to')
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
            )
            .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
        )
        .addSubcommand(sub =>
          sub
            .setName('disable')
            .setDescription('Disable the faction war feed')
            .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
        )
        .addSubcommand(sub =>
          sub
            .setName('status')
            .setDescription('Show faction war feed configuration')
            .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
        )
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guild.id;
    const serverId = interaction.authorizedServerId;
    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();

    if (!serverId) return interaction.editReply('❌ Select an active server you are authorized to manage.');

    if (group === 'killfeed') {
      if (sub === 'enable') return handleKillfeedEnable(interaction, guildId, serverId);
      if (sub === 'disable') return handleKillfeedDisable(interaction, guildId, serverId);
      if (sub === 'status') return handleKillfeedStatus(interaction, guildId, serverId);
    }

    if (group === 'faction') {
      if (sub === 'enable') return handleFactionEnable(interaction, guildId, serverId);
      if (sub === 'disable') return handleFactionDisable(interaction, guildId, serverId);
      if (sub === 'status') return handleFactionStatus(interaction, guildId, serverId);
    }
  },
};

// ─── Killfeed Handlers ───────────────────────────────────────────────────────

async function handleKillfeedEnable(interaction, guildId, serverId) {
  const channel = interaction.options.getChannel('channel');
  if (channel.guildId !== guildId) {
    return interaction.editReply('❌ The feed channel must belong to this Discord server.');
  }
  const channelId = channel.id;

  try {
    const defaultSettings = JSON.stringify({
      showPlayers: true,
      minDistance: 0,
      useEmbed: true,
      embedColor: '#FF0000'
    });

    await pool.query(
      `INSERT INTO discord_feeds (guild_id, server_id, feed_type, enabled, channel_id, settings, updated_at)
       VALUES ($1, $2, 'kill_feed', 1, $3, $4, NOW())
       ON CONFLICT (server_id, feed_type) DO UPDATE SET
         guild_id = EXCLUDED.guild_id,
         enabled = 1,
         channel_id = EXCLUDED.channel_id,
         settings = EXCLUDED.settings,
         updated_at = NOW()`,
      [guildId, serverId, channelId, defaultSettings]
    );

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Killfeed Enabled')
      .setDescription(`Player kills will be posted to <#${channelId}>`)
      .addFields(
        { name: 'Filter', value: 'All kills (any distance)', inline: true },
        { name: 'Format', value: 'Rich embeds', inline: true }
      );

    return interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('❌ Killfeed enable error:', err);
    return interaction.editReply(`❌ Failed to enable killfeed: ${err.message}`);
  }
}

async function handleKillfeedDisable(interaction, guildId, serverId) {
  try {
    await pool.query(
      `UPDATE discord_feeds SET enabled = 0, updated_at = NOW()
       WHERE guild_id = $1 AND server_id = $2 AND feed_type = 'kill_feed'`,
      [guildId, serverId]
    );

    return interaction.editReply('✅ Killfeed has been disabled. Previous kills in the queue will not be posted.');
  } catch (err) {
    console.error('❌ Killfeed disable error:', err);
    return interaction.editReply(`❌ Failed to disable killfeed: ${err.message}`);
  }
}

async function handleKillfeedStatus(interaction, guildId, serverId) {
  try {
    const result = await pool.query(
      `SELECT enabled, channel_id, settings, updated_at FROM discord_feeds
       WHERE guild_id = $1 AND server_id = $2 AND feed_type = 'kill_feed'`,
      [guildId, serverId]
    );

    const feed = result.rows[0];
    const embed = new EmbedBuilder()
      .setTitle('📋 Killfeed Configuration')
      .setTimestamp();

    if (!feed) {
      embed
        .setColor(0x99aab5)
        .setDescription('Killfeed is **not configured**.\n\nRun `/setup-feeds killfeed enable #channel` to set it up.');
    } else {
      const status = feed.enabled ? '🟢 Enabled' : '🔴 Disabled';
      const settings = JSON.parse(feed.settings || '{}');
      const updatedTs = Math.floor(new Date(feed.updated_at).getTime() / 1000);

      embed
        .setColor(feed.enabled ? 0x57f287 : 0x99aab5)
        .addFields(
          { name: 'Status', value: status, inline: true },
          { name: 'Channel', value: `<#${feed.channel_id}>`, inline: true },
          { name: 'Min Distance', value: `${settings.minDistance || 0}m`, inline: true },
          { name: 'Format', value: settings.useEmbed ? 'Rich Embed' : 'Plain Text', inline: true },
          { name: 'Last Updated', value: `<t:${updatedTs}:R>`, inline: false }
        );
    }

    return interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('❌ Killfeed status error:', err);
    return interaction.editReply(`❌ Failed to fetch killfeed status: ${err.message}`);
  }
}

// ─── Faction Feed Handlers ───────────────────────────────────────────────────

async function handleFactionEnable(interaction, guildId, serverId) {
  const channel = interaction.options.getChannel('channel');
  if (channel.guildId !== guildId) {
    return interaction.editReply('❌ The feed channel must belong to this Discord server.');
  }
  const channelId = channel.id;

  try {
    const defaultSettings = JSON.stringify({
      useEmbed: true,
      embedColor: '#8B0000'
    });

    await pool.query(
      `INSERT INTO discord_feeds (guild_id, server_id, feed_type, enabled, channel_id, settings, updated_at)
       VALUES ($1, $2, 'faction_feed', 1, $3, $4, NOW())
       ON CONFLICT (server_id, feed_type) DO UPDATE SET
         guild_id = EXCLUDED.guild_id,
         enabled = 1,
         channel_id = EXCLUDED.channel_id,
         settings = EXCLUDED.settings,
         updated_at = NOW()`,
      [guildId, serverId, channelId, defaultSettings]
    );

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Faction War Feed Enabled')
      .setDescription(`Faction war kills will be posted to <#${channelId}>`)
      .addFields(
        { name: 'Trigger', value: 'PvP kills between different factions', inline: true },
        { name: 'Format', value: 'Rich embeds', inline: true }
      );

    return interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('❌ Faction feed enable error:', err);
    return interaction.editReply(`❌ Failed to enable faction feed: ${err.message}`);
  }
}

async function handleFactionDisable(interaction, guildId, serverId) {
  try {
    await pool.query(
      `UPDATE discord_feeds SET enabled = 0, updated_at = NOW()
       WHERE guild_id = $1 AND server_id = $2 AND feed_type = 'faction_feed'`,
      [guildId, serverId]
    );

    return interaction.editReply('✅ Faction war feed has been disabled.');
  } catch (err) {
    console.error('❌ Faction feed disable error:', err);
    return interaction.editReply(`❌ Failed to disable faction feed: ${err.message}`);
  }
}

async function handleFactionStatus(interaction, guildId, serverId) {
  try {
    const result = await pool.query(
      `SELECT enabled, channel_id, settings, updated_at FROM discord_feeds
       WHERE guild_id = $1 AND server_id = $2 AND feed_type = 'faction_feed'`,
      [guildId, serverId]
    );

    const feed = result.rows[0];
    const embed = new EmbedBuilder()
      .setTitle('📋 Faction War Feed Configuration')
      .setTimestamp();

    if (!feed) {
      embed
        .setColor(0x99aab5)
        .setDescription('Faction war feed is **not configured**.\n\nRun `/setup-feeds faction enable #channel` to set it up.');
    } else {
      const status = feed.enabled ? '🟢 Enabled' : '🔴 Disabled';
      const updatedTs = Math.floor(new Date(feed.updated_at).getTime() / 1000);

      embed
        .setColor(feed.enabled ? 0x57f287 : 0x99aab5)
        .addFields(
          { name: 'Status', value: status, inline: true },
          { name: 'Channel', value: `<#${feed.channel_id}>`, inline: true },
          { name: 'Last Updated', value: `<t:${updatedTs}:R>`, inline: false }
        );
    }

    return interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('❌ Faction feed status error:', err);
    return interaction.editReply(`❌ Failed to fetch faction feed status: ${err.message}`);
  }
}
