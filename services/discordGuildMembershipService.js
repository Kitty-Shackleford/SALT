'use strict';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DISCORD_SNOWFLAKE = /^\d{17,20}$/;

function membershipError(message, code = 'DISCORD_MEMBERSHIP_UNAVAILABLE') {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function verifyDiscordGuildMembership(guildId, userId, options = {}) {
  const normalizedGuildId = String(guildId || '');
  const normalizedUserId = String(userId || '');
  if (!DISCORD_SNOWFLAKE.test(normalizedGuildId) || !DISCORD_SNOWFLAKE.test(normalizedUserId)) {
    throw membershipError('Invalid Discord guild or user identifier', 'INVALID_DISCORD_ID');
  }

  const token = options.token || process.env.DISCORD_BOT_TOKEN;
  if (!token) throw membershipError('Discord membership verification is unavailable');
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw membershipError('Discord membership verification is unavailable');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 5000);
  try {
    const response = await fetchImpl(
      `${DISCORD_API_BASE}/guilds/${normalizedGuildId}/members/${normalizedUserId}`,
      {
        method: 'GET',
        headers: { Authorization: `Bot ${token}` },
        signal: controller.signal,
      }
    );
    if (response.status === 404) return false;
    if (!response.ok) throw membershipError('Discord membership verification is unavailable');
    const member = await response.json();
    if (String(member?.user?.id || '') !== normalizedUserId) {
      throw membershipError('Discord returned an unexpected guild member identity');
    }
    return true;
  } catch (error) {
    if (error.code === 'DISCORD_MEMBERSHIP_UNAVAILABLE') throw error;
    throw membershipError('Discord membership verification is unavailable');
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { verifyDiscordGuildMembership };
