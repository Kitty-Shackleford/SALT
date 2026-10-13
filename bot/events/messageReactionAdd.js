/*
 * bot/events/messageReactionAdd.js
 *
 * Assigns a bound role when a member adds a reaction on a reaction-role setup
 * message. See services/reactionRoleService.js for the shared logic.
 *
 * Requires the `GuildMessageReactions` intent (enabled in bot/index.js).
 */

const { Events } = require('discord.js');
const { handleReaction } = require('../services/reactionRoleService');

module.exports = {
  name: Events.MessageReactionAdd,
  async execute(reaction, user) {
    try {
      await handleReaction(reaction, user, true);
    } catch (err) {
      console.warn(`⚠️ [reaction-roles] add error: ${err.message}`);
    }
  },
};
