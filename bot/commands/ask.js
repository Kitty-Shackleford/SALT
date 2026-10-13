/*
 * bot/commands/ask.js
 *
 * /ask — player-facing "ask the server" (grounded Q&A over ingested data).
 *
 * - Any approved-guild member can use it (feature gate per guild).
 * - Rate-limited per member via bot_ai_user_usage (per-guild daily limit).
 * - Answers are composed from DB/config data + LLM polish only; when the
 *   data is absent the bot says so. See services/askServerService.js.
 */

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { answerQuestion } = require('../services/askServerService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask about the server — status, rules, or where to find loot')
    .setDMPermission(false)
    .addStringOption(opt =>
      opt.setName('question').setDescription('Your question (e.g. "where do I find an AKM?" or "what are the rules?")').setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const answer = await answerQuestion({
        client: interaction.client,
        guildId: interaction.guild.id,
        userId: interaction.user.id,
        question: interaction.options.getString('question'),
      });
      return interaction.editReply({ content: answer.slice(0, 4000) });
    } catch (error) {
      if (error.code === 'BOT_AI_RATE_LIMITED') {
        return interaction.editReply({ content: `⏳ ${error.message}`, flags: MessageFlags.Ephemeral });
      }
      console.error('❌ /ask error:', error);
      return interaction.editReply({
        content: '❌ Something went wrong answering that. Please try again in a moment.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }
};
