/*
 * bot/commands/flip.js
 *
 * /flip — flip a coin (heads or tails). Pure utility, no DB.
 */

const { SlashCommandBuilder, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('flip')
    .setDescription('Flip a coin (heads or tails)')
    .setDMPermission(false),

  async execute(interaction) {
    const result = Math.random() < 0.5 ? '🪙 Heads' : '🪙 Tails';
    await interaction.reply({
      content: `${result} — <@${interaction.user.id}>`,
      flags: MessageFlags.None,
    });
  },
};
