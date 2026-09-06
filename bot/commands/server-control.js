/*
 * bot/commands/server-control.js
 *
 * Admin-only command to start, stop, or restart the DayZ server via Nitrado.
 * Shows current server status before and after the action.
 */

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('server-control')
    .setDescription('Start, stop, or restart the DayZ game server')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
      opt.setName('action')
        .setDescription('What to do with the server')
        .setRequired(true)
        .addChoices(
          { name: '🔄 Restart', value: 'restart' },
          { name: '▶️ Start',   value: 'start'   },
          { name: '⏹️ Stop',    value: 'stop'    }
        )
    )
    .addStringOption(opt => opt
      .setName('server')
      .setDescription('Nitrado service ID (required when this guild has multiple servers)')),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return interaction.editReply(
      '❌ [PROVIDER_MUTATION_DISABLED] Server lifecycle controls are temporarily unavailable pending durable provider mutation support.'
    );
  }
};
