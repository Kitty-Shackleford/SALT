/*
 * bot/events/messageCreate.js
 *
 * Anti-spam guard: deletes a message that trips the per-guild burst rate
 * limit (services/antiSpamService.js) and posts a short moderator notice in
 * the channel.
 *
 * Anti-spam is OFF by default per guild — this is a no-op until an admin
 * opts in with /setup-antispam enable.
 *
 * Requires the `GuildMessages` intent (enabled in bot/index.js).
 */

const { Events, EmbedBuilder } = require('discord.js');
const { handleMessageCreate } = require('../services/antiSpamService');

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    try {
      const tripped = await handleMessageCreate(message);
      if (!tripped) return;

      await message.delete().catch(() => {});
      await message.channel.send({
        content: `@${message.author}`,
        embeds: [new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle('Anti-spam')
          .setDescription('Excessive message spam detected — the message was removed. '
            + 'Slow down or you may be timed out.')],
      }).catch(() => {});
    } catch (err) {
      console.warn(`⚠️ [antispam] handler error: ${err.message}`);
    }
  },
};
