/*
 * bot/commands/count.js
 *
 * /count <from> <to> — how many integers are in the range [from, to].
 * Pure utility, no DB.
 */

const { SlashCommandBuilder, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('count')
    .setDescription('Count the integers from a start to an end (inclusive)')
    .setDMPermission(false)
    .addIntegerOption(opt => opt.setName('from').setDescription('Start of the range (inclusive)').setRequired(true))
    .addIntegerOption(opt => opt.setName('to').setDescription('End of the range (inclusive)').setRequired(true)),

  async execute(interaction) {
    const from = interaction.options.getInteger('from');
    const to = interaction.options.getInteger('to');
    const count = Math.abs(to - from) + 1;
    await interaction.reply({
      content: `🔢 **${count}** integers from ${from} to ${to} (inclusive)`,
      flags: MessageFlags.None,
    });
  },
};
