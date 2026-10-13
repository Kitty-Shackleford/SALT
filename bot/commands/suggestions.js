/*
 * bot/commands/suggestions.js
 *
 * /suggestions — the per-guild suggestion box.
 *
 * Subcommands:
 *   /suggestions setup channel <channel>      (admin)
 *     Register the suggestions channel for this server.
 *   /suggestions send suggestion <text>       (any member)
 *     Post your suggestion as an embed with Accept/Deny buttons in the
 *     configured channel. The submitter is DMed when a moderator decides.
 *
 * The channel lives in guild_features (feature_name 'suggestions'); each
 * submission is a row in `suggestions` (migration 100) so decisions stay
 * idempotent and survive the posted message being deleted.
 *
 * Accept/Deny buttons are wired in bot/index.js via
 * services/suggestionButtonService.js; they require Manage Messages.
 */

const {
  SlashCommandBuilder,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
} = require('discord.js');
const pool = require('../db');
const { setFeatureConfig: writeFeatureConfig, getFeatureConfig } = require('../utils/guildFeatureSettings');
const { ACCEPT_BUTTON_ID, DENY_BUTTON_ID } = require('../services/suggestionButtonService');

const SUGGESTION_MAX_LENGTH = 2000;

async function fetchBindings(discordGuildId) {
  const r = await pool.query(
    `SELECT id FROM guilds WHERE discord_guild_id = $1 LIMIT 1`,
    [String(discordGuildId)]
  );
  return r.rows[0]?.id || null;
}

function decisionButtons() {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ACCEPT_BUTTON_ID)
      .setLabel('Accept')
      .setStyle(2), // Success
    new ButtonBuilder()
      .setCustomId(DENY_BUTTON_ID)
      .setLabel('Deny')
      .setStyle(4) // Danger
  );
  return [row];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('suggestions')
    .setDescription('Post and moderate server suggestions')
    .setDMPermission(false)
    .addSubcommand(sub =>
      sub.setName('setup')
        .setDescription('Register the suggestions channel for this server (admin)')
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Channel to post suggestions in')
             .setRequired(true).addChannelTypes(0)))
    .addSubcommand(sub =>
      sub.setName('send')
        .setDescription('Submit a suggestion for the server')
        .addStringOption(opt =>
          opt.setName('suggestion').setDescription('Your suggestion').setRequired(true).setMaxLength(SUGGESTION_MAX_LENGTH))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (sub === 'setup') {
      // The 'guild_admin' auth class (enforced in bot/index.js before
      // execute()) already covers Discord admins, guild owner/admin, and
      // active server admins — no additional check needed here.
      const channel = interaction.options.getChannel('channel');
      await writeFeatureConfig(interaction.guildId, 'suggestions', { channel_id: channel.id }, true, interaction.user.id);
      return interaction.editReply(`✅ Suggestions channel set to ${channel}. Use \`/suggestions send\` to submit one.`);
    }

    // sub === 'send'
    const body = interaction.options.getString('suggestion');
    const feature = await getFeatureConfig(interaction.guildId, 'suggestions');
    const channelId = feature?.config?.channel_id;
    if (!channelId) {
      return interaction.editReply('❌ This server has no suggestions channel set. An admin can register one with `/suggestions setup`.');
    }

    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased?.()) {
      return interaction.editReply('❌ The suggestions channel no longer exists. An admin should re-run `/suggestions setup`.');
    }

    const guildDbId = await fetchBindings(interaction.guildId);
    if (!guildDbId) {
      return interaction.editReply('❌ This server is not registered in the dashboard.');
    }

    const posted = await channel.send({
      content: `💡 *Suggestion by ${interaction.user}*`,
      embeds: [new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('💡 Suggestion')
        .setDescription(body)
        .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
        .setTimestamp()],
      components: decisionButtons(),
    });

    await pool.query(
      `INSERT INTO suggestions
         (guild_id, discord_channel_id, discord_message_id, body, submitter_discord_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (guild_id, discord_message_id) DO NOTHING`,
      [guildDbId, channel.id, posted.id, body, interaction.user.id]
    );

    return interaction.editReply(`✅ Suggestion posted in ${channel}. A moderator can Accept or Deny it there.`);
  },
};
