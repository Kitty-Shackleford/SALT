/*
 * bot/commands/purge.js
 *
 * /purge <count> [bot-only] — delete recent messages from the current channel.
 * Moderator/Administrator only. Capped at 500 (Discord bulk-delete limit).
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('purge')
    .setDescription('Delete recent messages in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .addIntegerOption(opt =>
      opt.setName('count').setDescription('How many messages to delete (max 500)').setRequired(true)
         .setMinValue(1).setMaxValue(500))
    .addBooleanOption(opt =>
      opt.setName('bot_only').setDescription('Only delete bot messages')),

  async execute(interaction) {
    const count = Math.min(interaction.options.getInteger('count') || 1, 500);
    const botOnly = interaction.options.getBoolean('bot_only') === true;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetChannel = interaction.channel;
    if (!targetChannel || !targetChannel.isTextBased()) {
      return interaction.editReply('❌ Can only purge text channels.');
    }

    const messages = await targetChannel.messages.fetch({ limit: Math.min(count + 25, 100) });
    let deleted = 0;

    const toDelete = [...messages.values()]
      .filter(m => !m.system)
      .filter(m => (botOnly ? m.author.bot : true))
      .slice(0, count)
      .filter(m => {
        // Messages older than 14 days can't be bulk-deleted.
        return Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000;
      });

    // Bulk-delete in chunks of up to 100 (Discord limit per call).
    const ids = toDelete.map(m => m.id);
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      try {
        await targetChannel.bulkDelete(chunk, { reason: `purge by ${interaction.user.tag}` });
        deleted += chunk.length;
      } catch (err) {
        console.warn('⚠️ [purge] chunk delete failed:', err.message);
      }
    }

    return interaction.editReply(`🧹 Deleted **${deleted}** message${deleted === 1 ? '' : 's'}${botOnly ? ' (bots only)' : ''}.`);
  },
};
