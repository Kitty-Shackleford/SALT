/*
 * bot/commands/poll.js
 *
 * /poll — create a native Discord poll with up to 10 options.
 *
 * Subcommands:
 *   /poll quick question <question> [option_a] [option_b] [option_c] [option_d]
 *     Quick poll with 2-4 fixed options (missing options are dropped).
 *   /poll custom question <question> options <opt1>,<opt2>,[opt3..] duration <minutes>
 *     Custom poll with comma-separated options (2-10) and a duration in minutes
 *     (1-4320; default 30).
 */

const { SlashCommandBuilder, PollBuilder, PollOption, MessageFlags } = require('discord.js');

const MINUTE_MS = 60 * 1000;

function parseOptions(commaList) {
  return String(commaList || '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .slice(0, 10);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create a native Discord poll')
    .setDMPermission(false)
    .addSubcommand(sub =>
      sub.setName('quick')
        .setDescription('Quick poll with 2-4 options')
        .addStringOption(opt =>
          opt.setName('question').setDescription('Poll question').setRequired(true).setMaxLength(300))
        .addStringOption(opt => opt.setName('option_a').setDescription('Option A'))
        .addStringOption(opt => opt.setName('option_b').setDescription('Option B'))
        .addStringOption(opt => opt.setName('option_c').setDescription('Option C'))
        .addStringOption(opt => opt.setName('option_d').setDescription('Option D'))
    )
    .addSubcommand(sub =>
      sub.setName('custom')
        .setDescription('Poll with 2-10 custom options')
        .addStringOption(opt =>
          opt.setName('question').setDescription('Poll question').setRequired(true).setMaxLength(300))
        .addStringOption(opt =>
          opt.setName('options')
             .setDescription('Comma-separated options, 2 to 10 (e.g. Yes,No,Maybe)')
             .setRequired(true))
        .addIntegerOption(opt =>
          opt.setName('duration')
             .setDescription('Duration in minutes (1-4320). Default 30.')
             .setMinValue(1)
             .setMaxValue(4320)
             .setRequired(false))
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    let question;
    let options;
    let durationMs;

    if (sub === 'quick') {
      question = interaction.options.getString('question');
      options = ['option_a', 'option_b', 'option_c', 'option_d']
        .map(name => interaction.options.getString(name))
        .filter(Boolean);
      durationMs = 30 * MINUTE_MS;
    } else {
      question = interaction.options.getString('question');
      options = parseOptions(interaction.options.getString('options'));
      const minutes = interaction.options.getInteger('duration') || 30;
      durationMs = minutes * MINUTE_MS;
    }

    if (options.length < 2) {
      return interaction.reply({
        content: '❌ A poll needs at least 2 options.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const poll = new PollBuilder()
      .setQuestion(question)
      .addPollOptions(options.slice(0, 10).map(text => new PollOption({ name: text })))
      .setDuration(Math.floor(durationMs / MINUTE_MS));

    await interaction.channel.send({ poll });
    await interaction.reply({
      content: `📊 Poll posted with ${options.length} option${options.length === 1 ? '' : 's'}.`,
      flags: MessageFlags.Ephemeral,
    });
  },
};
