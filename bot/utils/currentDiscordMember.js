'use strict';

async function fetchCurrentGuildMember(guild, discordUserId) {
  try {
    return await guild.members.fetch({ user: String(discordUserId), force: true });
  } catch (cause) {
    const error = new Error('Discord member is no longer present');
    error.code = 'MEMBER_LEFT';
    error.cause = cause;
    throw error;
  }
}

module.exports = { fetchCurrentGuildMember };
