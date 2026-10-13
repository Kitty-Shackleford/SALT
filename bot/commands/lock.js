/*
 * bot/commands/lock.js
 *
 * /lock <mode> [channel] — lock or unlock a text channel for non-moderators.
 *   lock    — remove @everyone Send Messages
 *   unlock  — restore @everyone Send Messages
 * Admin/ModerateMessages.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Lock or unlock a text channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .setDMPermission(false)
    .addStringOption(opt =>
      opt.setName('mode').setDescription('Lock or unlock')
         .setRequired(true)
         .addChoices(
           { name: 'Lock', value: 'lock' },
           { name: 'Unlock', value: 'unlock' },
         ))
    .addChannelOption(opt => opt.setName('channel').setDescription('Channel (default: this one)')
      .addChannelTypes(0)),

  async execute(interaction) {
    const mode = interaction.options.getString('mode');
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    if (!channel || !channel.isTextBased()) return interaction.reply({ content: '❌ Pick a text channel.', flags: MessageFlags.Ephemeral });

    const everyone = channel.guild.roles.everyone;

    try {
      if (mode === 'lock') {
        await channel.permissionOverwrites.edit(everyone, { SendMessages: false, AddReactions: false }, { reason: `locked by ${interaction.user.tag}` });
      } else {
        await channel.permissionOverwrites.edit(everyone, { SendMessages: null, AddReactions: null }, { reason: `unlocked by ${interaction.user.tag}` });
      }
    } catch (err) {
      return interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral });
    }

    return interaction.reply(`${mode === 'lock' ? '🔒 Locked' : '🔓 Unlocked'} ${channel}.`);
  },
};
