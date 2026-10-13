/*
 * bot/commands/setup-welcome.js
 *
 * /setup-welcome — configure the per-guild welcome and goodbye messages.
 *
 * Subcommands:
 *   /setup-welcome welcome channel <channel> [message]   (admin)
 *   /setup-welcome goodbye channel <channel> [message]   (admin)
 *   /setup-welcome disable                               (admin)
 *
 * Messages support placeholders: {user}, {username}, {guild}, {count}.
 * Stored in guild_features (feature_name: welcome | goodbye).
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const { DEFAULT_WELCOME_MESSAGE, DEFAULT_GOODBYE_MESSAGE } = require('../services/memberPostService');
const { setFeatureConfig: writeFeatureConfig } = require('../utils/guildFeatureSettings');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-welcome')
    .setDescription('Configure welcome (join) and goodbye (leave) messages for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand(sub =>
      sub.setName('welcome')
        .setDescription('Set the welcome message posted when a member joins')
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Channel to post in').setRequired(true)
             .addChannelTypes(0))
        .addStringOption(opt =>
          opt.setName('message')
             .setDescription('Template. Placeholders: {user} {username} {guild} {count}')
             .setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('goodbye')
        .setDescription('Set the goodbye message posted when a member leaves')
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Channel to post in').setRequired(true)
             .addChannelTypes(0))
        .addStringOption(opt =>
          opt.setName('message')
             .setDescription('Template. Placeholders: {user} {username} {guild}')
             .setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('disable').setDescription('Disable welcome and goodbye messages for this server')
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (sub === 'disable') {
      await writeFeatureConfig(interaction.guildId, 'welcome', null, false, interaction.user.id);
      await writeFeatureConfig(interaction.guildId, 'goodbye', null, false, interaction.user.id);
      return interaction.editReply('✅ Welcome and goodbye messages disabled for this server.');
    }

    const channel = interaction.options.getChannel('channel');
    const message = interaction.options.getString('message');
    const featureName = sub; // 'welcome' | 'goodbye'
    const defaultTemplate = featureName === 'welcome' ? DEFAULT_WELCOME_MESSAGE : DEFAULT_GOODBYE_MESSAGE;

    await writeFeatureConfig(
      interaction.guildId,
      featureName,
      { channel_id: channel.id, message: message || defaultTemplate },
      true,
      interaction.user.id
    );

    const sample = featureName === 'welcome'
      ? (message || defaultTemplate)
          .replace('{user}', `<@${interaction.user.id}>`)
          .replace('{username}', interaction.user.username)
          .replace('{guild}', interaction.guild.name)
          .replace('{count}', String(interaction.guild.memberCount))
      : (message || defaultTemplate)
          .replace('{user}', `<@${interaction.user.id}>`)
          .replace('{username}', interaction.user.username)
          .replace('{guild}', interaction.guild.name);

    return interaction.editReply(
      `✅ \`${featureName}\` enabled → ${channel}\n` +
      `Template: \`${message || defaultTemplate}\`\n` +
      `Preview: ${sample}`
    );
  },
};
