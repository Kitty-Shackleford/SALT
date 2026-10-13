/*
 * bot/commands/roll.js
 *
 * /roll <max> — roll a random number 1..max. Pure utility, no DB.
 */

const { SlashCommandBuilder, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roll')
    .setDescription('Roll a random number between 1 and a max')
    .setDMPermission(false)
    .addIntegerOption(opt =>
      opt.setName('max').setDescription('Roll between 1 and this number').setMinValue(2).setRequired(true)),

  async execute(interaction) {
    const max = interaction.options.getInteger('max');
    const n = 1 + Math.floor(Math.random() * max);
    await interaction.reply({
      content: `🎲 <@${interaction.user.id}> rolled **${n}** (1–${max})`,
      flags: MessageFlags.None,
    });
  },
};
