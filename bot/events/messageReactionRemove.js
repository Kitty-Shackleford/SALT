/*
 * bot/events/messageReactionRemove.js
 *
 * Removes a bound role when a member removes a reaction on a reaction-role
 * setup message. See services/reactionRoleService.js for the shared logic.
 *
 * Requires the `GuildMessageReactions` intent (enabled in bot/index.js).
 */

const { Events } = require('discord.js');
const { handleReaction } = require('../services/reactionRoleService');

module.exports = {
  name: Events.MessageReactionRemove,
  async execute(reaction, user) {
    try {
      await handleReaction(reaction, user, false);
    } catch (err) {
      console.warn(`⚠️ [reaction-roles] remove error: ${err.message}`);
    }
  },
};
