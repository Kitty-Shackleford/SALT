'use strict';

/**
 * memberPostService.js
 *
 * Posts welcome (join) and goodbye (leave) messages based on per-guild
 * `guild_features` config (feature names: `welcome`, `goodbye`).
 *
 * Config shape (per feature):
 *   { channel_id: "<id>", message: "Welcome {user} to {guild}!" }
 *
 * Placeholders: {user} (mention), {username} (display name),
 *   {guild} (guild name), {count} (member count, join events only).
 *
 * Off-by-default: a missing/disabled feature row means no post is sent, so
 * enabling it is an explicit per-guild opt-in.
 */

const {
  getFeatureConfig,
  resolvePostConfig,
  fillPlaceholders,
} = require('../utils/guildFeatureSettings');

const DEFAULT_WELCOME_MESSAGE = '👋 Welcome {user} to **{guild}**!';
const DEFAULT_GOODBYE_MESSAGE = '👋 **{username}** left **{guild}**.';

/**
 * Post a join or leave message if the feature is enabled for this guild.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').GuildMember} member
 * @param {'join'|'leave'} type
 * @param {{database?: import('pg').Pool}} [options]
 * @returns {Promise<boolean>} true if a message was posted
 */
async function postMemberEvent(client, member, type, options = {}) {
  const database = options.database || undefined;
  const featureName = type === 'join' ? 'welcome' : 'goodbye';
  const guildId = member.guild.id;

  let featureConfig;
  try {
    featureConfig = await getFeatureConfig(guildId, featureName, database);
  } catch (err) {
    console.warn(`⚠️ [member-post] could not read ${featureName} config for guild ${guildId}: ${err.message}`);
    return false;
  }

  const resolved = resolvePostConfig(featureConfig);
  if (!resolved) return false;

  const template = featureConfig.config.message
    || (type === 'join' ? DEFAULT_WELCOME_MESSAGE : DEFAULT_GOODBYE_MESSAGE);

  const values = {
    user: member.user ? `<@${member.id}>` : '',
    username: member.user?.username || member.displayName || member.id,
    guild: member.guild.name,
    count: type === 'join' ? member.guild.memberCount : '',
  };
  const content = fillPlaceholders(template, values) || template;

  try {
    const channel = await client.channels.fetch(resolved.channelId);
    if (!channel || !channel.isTextBased()) return false;
    await channel.send(content);
    return true;
  } catch (err) {
    console.warn(`⚠️ [member-post] could not post ${featureName} to ${resolved.channelId} in guild ${guildId}: ${err.message}`);
    return false;
  }
}

module.exports = {
  postMemberEvent,
  DEFAULT_WELCOME_MESSAGE,
  DEFAULT_GOODBYE_MESSAGE,
};
