/*
 * bot/events/guildMemberRemove.js
 *
 * Posts the per-guild goodbye message when a member leaves (off by default).
 * The GuildMemberRemove event hands us a partial member (no roles), so this
 * only needs user + guild fields.
 */

const { Events } = require('discord.js');
const pool = require('../db');
const { postMemberEvent } = require('../services/memberPostService');
const { recordMemberEvent } = require('../services/onboardingService');

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member) {
    // The client is attached to this module by the event loader in bot/index.js.
    const client = module.exports.client;
    try {
      await postMemberEvent(client, member, 'leave');
    } catch (error) {
      console.warn(`⚠️ [member-post] goodbye failed for ${member.id} in guild ${member.guild.id}: ${error.message}`);
    }
    try {
      await recordMemberEvent(member.guild.id, member.id, 'leave', pool);
    } catch (error) {
      console.warn(`⚠️ [member-events] leave record failed for ${member.id}: ${error.message}`);
    }
  },
};
