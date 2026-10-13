/*
 * bot/services/onboardingService.js
 *
 * New-player onboarding: on member join, post a friendly intro with a rules
 * pointer and current server status. Per-guild gated (guild_ai_settings
 * onboarding_enabled, default OFF), channel + rules channel configurable.
 *
 * The intro is deterministic (no LLM needed for a reliable welcome); when
 * the shared router is available it lightly personalizes the opening line
 * but never changes the facts. A failed/missing LLM never blocks the post.
 */

'use strict';

const pool = require('../db');
const { isConfigured, chat } = require('./botAiRouterService');

const DEFAULT_ONBOARDING_MESSAGE = [
  'Welcome to **{guild}**, {username}! 👋',
  '',
  '📜 **Rules:** please read the rules before you jump in — see {rulesChannel}.',
  '🖥️ **Server:** {statusLine}',
  '🎮 Link your in-game name so your stats show up on the dashboard: `/link`',
  '❓ Questions? Ask with `/ask` — the helper answers from real server data.',
].join('\n');

async function getOnboardingSettings(guildId, db = pool) {
  const res = await db.query(
    `SELECT gf.onboarding_enabled,
            gf.onboarding_channel_id,
            gf.ask_rules_channel_id
     FROM guilds g
     LEFT JOIN guild_ai_settings gf ON gf.guild_id = g.id
     WHERE g.discord_guild_id = $1 LIMIT 1`,
    [String(guildId)]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    enabled: Boolean(row.onboarding_enabled),
    channelId: row.onboarding_channel_id || null,
    rulesChannelId: row.ask_rules_channel_id || null,
  };
}

async function postOnboarding(client, member, db = pool, template = DEFAULT_ONBOARDING_MESSAGE) {
  const guildId = member.guild.id;
  const settings = await getOnboardingSettings(guildId, db);
  if (!settings?.enabled || !settings.channelId) return null;

  const { getStatusContext } = require('./askServerService');
  const status = await getStatusContext(guildId, db);
  const statusLine = status
    ? `**${status.serverName}** is ${status.online ? 'online' : 'offline'} now — ${status.players ?? '?'} players on ${status.map}.`
    : 'status unavailable right now (check back with `/online`).';

  let text = template
    .replace(/\{username\}/g, member.username)
    .replace(/\{guild\}/g, member.guild.name)
    .replace(/\{statusLine\}/g, statusLine)
    .replace(/\{rulesChannel\}/g, settings.rulesChannelId ? `#${settings.rulesChannelId}` : 'the #rules channel');

  // Optional LLM personalization of the opening line only.
  if (isConfigured()) {
    const personalized = await chat([
      {
        role: 'system',
        content: 'Rewrite ONLY the first line of the welcome message for a new DayZ player named ' +
                 member.username + `. Keep it one short friendly sentence. Output the single line, nothing else.`,
      },
      { role: 'user', content: text.split('\n')[0] },
    ], process.env, { maxTokens: 80, temperature: 0.6 });
    if (personalized) {
      const rest = text.split('\n').slice(1).join('\n');
      text = `${personalized}\n${rest}`;
    }
  }

  const channel = await client.channels.fetch(settings.channelId);
  if (!channel || channel.guildId !== String(guildId)) return null;
  const message = await channel.send(text);
  return message.id;
}

/**
 * Record a join/leave in discord_member_events (best-effort; used by the
 * digest). Silently no-ops on any failure.
 */
async function recordMemberEvent(guildId, discordUserId, kind, db = pool) {
  try {
    await db.query(
      `INSERT INTO discord_member_events (guild_id, discord_user_id, kind)
       SELECT g.id, $2, $3 FROM guilds g WHERE g.discord_guild_id = $1`,
      [String(guildId), String(discordUserId), kind]
    );
  } catch (error) {
    console.warn(`⚠️ [onboarding] could not record member event (${kind}) for ${discordUserId}: ${error.message}`);
  }
}

module.exports = {
  getOnboardingSettings,
  postOnboarding,
  recordMemberEvent,
  DEFAULT_ONBOARDING_MESSAGE,
};
