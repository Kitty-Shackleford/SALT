/*
 * bot/commands/say.js
 *
 * /say <channel> <message> — bot posts a message as itself (announcements).
 * Admin only.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('say')
    .setDescription('Have the bot post a message in a channel (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addChannelOption(opt => opt.setName('channel').setDescription('Channel to post in').setRequired(true).addChannelTypes(0))
    .addStringOption(opt => opt.setName('message').setDescription('Message to post').setRequired(true).setMaxLength(2000)),

  async execute(interaction) {
    const channel = interaction.options.getChannel('channel');
    const message = interaction.options.getString('message');
    await channel.send({ content: message, allowedMentions: { repliedUser: null } });
    return interaction.reply({ content: `✅ Posted to ${channel}.`, flags: MessageFlags.Ephemeral });
  },
};
