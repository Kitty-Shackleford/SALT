'use strict';

/**
 * Birthday announcement worker.
 *
 * Ticks every 60s but only acts when the local calendar date has changed
 * since the last run (lastRunDate). For each approved guild it finds
 * identities with an active birthday on today's month/day and posts a
 * tasteful embed to the guild's birthday channel, deduplicating through
 * the birthday_announcements unique (identity_id, guild_id, business_date)
 * constraint so a concurrent tick can never double-announce.
 *
 * Mirrors workers/casinoExpiryProcessor.js: injectable timers/date and
 * unref'd handles so tests (and the process) can shut down cleanly.
 *
 * Channel resolution (guild order):
 *   1. guilds.birthday_announce_channel_id (configured)
 *   2. a 'general' channel
 *   3. the first text-based channel in the guild
 *
 * TODO(party-role): ping a "party" role for the day's birthdays. No role
 * config store exists yet (see guild_features pattern); wire one when a
 * guild opts in to role pings.
 */

const birthdayService = require('../services/birthdayService');
const { postViaBot, fetchGuildChannels } = require('../utils/discordPoster');

function toDateOnly(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Build the announcement embed for one birthday entry.
 * In-character age is always safe to show; the IRL line only appears when
 * the owner's visibility allows it.
 */
function buildBirthdayEmbed(entry) {
  const name = entry.name || `identity ${entry.identity_id}`;
  const lines = [];
  if (entry.charAge != null) {
    lines.push(`Survivor **${name}** has survived **${entry.charAge}** years in Chernarus.`);
  }
  // The worker announces to the whole guild, so the IRL age line only goes
  // out when the owner chose 'full' visibility ('irl_date' shares the
  // date in /birthday view but not the age line in a guild-wide post).
  const irlAllowed = entry.visibility === 'full';
  if (entry.irlAge != null && irlAllowed) {
    lines.push(`Happy **${entry.irlAge}**. birthday!`);
  }
  if (lines.length === 0) {
    lines.push('🎂 A survivor celebrates their birthday in Chernarus!');
  }
  // discord.js EmbedBuilder is bot-only; keep the payload a plain object so
  // the worker stays testable and transport-agnostic.
  return {
    title: '🎂 A birthday in Chernarus',
    color: 0xf5c542,
    description: lines.join('\n'),
  };
}

/**
 * Pick the announcement channel for a guild.
 * @param {object} guild { discord_guild_id, birthday_announce_channel_id }
 * @param {(discordGuildId: string) => Promise<Array<{id, name, type}>>} listGuildChannels
 */
async function resolveAnnouncementChannel(guild, listGuildChannels) {
  if (guild.birthday_announce_channel_id) return guild.birthday_announce_channel_id;
  let channels = [];
  try {
    channels = (await listGuildChannels(guild.discord_guild_id)) || [];
  } catch (error) {
    console.warn(`[Birthday] Could not list channels for guild ${guild.discord_guild_id}: ${error.message}`);
    return null;
  }
  const textChannels = channels.filter(channel => [0, 5].includes(channel.type));
  const general = textChannels.find(channel => String(channel.name).toLowerCase() === 'general');
  return (general && general.id) || (textChannels[0] && textChannels[0].id) || null;
}

/**
 * One announcement pass. Race-safe: the per-guild/per-identity claim is a
 * unique-constraint INSERT ... ON CONFLICT DO NOTHING inside a transaction;
 * only the winner posts.
 *
 * @param {object} db - dashboard db adapter (query/get/transaction/run)
 * @param {object} options
 *   today            - Date (defaults to now)
 *   postMessage      - async (channelId, embedPayload) => boolean
 *   listGuildChannels - async (discordGuildId) => [{ id, name, type }]
 */
async function announceBirthdays(db, options = {}) {
  const today = options.today || new Date();
  const businessDate = toDateOnly(today);
  const postMessage = options.postMessage || (async (channelId, embed) => postViaBot(channelId, embed, true));
  const listGuildChannels = options.listGuildChannels || (id => fetchGuildChannels(id));
  const logger = options.logger || console;

  const guilds = await db.query(
    `SELECT id, discord_guild_id, birthday_announce_channel_id
     FROM guilds
     WHERE status = 'approved'
     ORDER BY id`
  );

  let candidates = 0;
  let announced = 0;

  for (const guild of guilds || []) {
    const entries = await birthdayService.collectTodaysBirthdays(db, {
      guildId: guild.id,
      date: businessDate,
    });
    candidates += entries.length;

    const channelId = entries.length ? await resolveAnnouncementChannel(guild, listGuildChannels) : null;

    for (const entry of entries) {
      const claimed = await db.transaction(async transactionDb => {
        const result = await transactionDb.run(
          `INSERT INTO birthday_announcements (identity_id, guild_id, business_date)
           VALUES (?, ?, ?)
           ON CONFLICT (identity_id, guild_id, business_date) DO NOTHING`,
          [entry.identity_id, guild.id, businessDate]
        );
        return (result?.changes ?? 0) > 0;
      });
      if (!claimed) continue;
      if (!channelId) {
        logger.warn(`[Birthday] No postable channel for guild ${guild.discord_guild_id}; announcement claimed but not posted`);
        continue;
      }
      const ok = await postMessage(channelId, buildBirthdayEmbed(entry));
      if (ok) announced += 1;
      else logger.warn(`[Birthday] Failed to post for identity ${entry.identity_id} in guild ${guild.id}`);
    }
  }

  return { businessDate, candidates, announced };
}

/**
 * Start the recurring announcement worker.
 * @param {object} db - dashboard db adapter
 * @param {object} options - same as announceBirthdays plus startupDelayMs,
 *   intervalMs (default 60000), setTimeoutFn/setIntervalFn/clearTimeoutFn/
 *   clearIntervalFn, dateFn (test seam for "now"), logger
 */
function startBirthdayAnnouncer(db, options = {}) {
  const startupDelayMs = options.startupDelayMs ?? 5000;
  const intervalMs = options.intervalMs ?? 60000;
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const logger = options.logger || console;
  const dateFn = options.dateFn || (() => new Date());
  let running = false;
  let stopped = false;
  let lastRunDate = null;

  async function run() {
    if (running || stopped) return { announced: 0, skipped: running };
    running = true;
    try {
      const today = dateFn();
      const businessDate = toDateOnly(today);
      if (lastRunDate === businessDate) {
        return { businessDate, announced: 0, skipped: 'same-day' };
      }
      const result = await announceBirthdays(db, {
        today,
        postMessage: options.postMessage,
        listGuildChannels: options.listGuildChannels,
        logger,
      });
      if (result.announced > 0) {
        logger.info(`[Birthday] Announced ${result.announced} birthday(s) for ${result.businessDate}`);
      }
      lastRunDate = businessDate;
      return result;
    } catch (error) {
      logger.error('[Birthday] Announcement pass failed:', error);
      return { announced: 0, error };
    } finally {
      running = false;
    }
  }

  const startupTimer = setTimeoutFn(run, startupDelayMs);
  const intervalTimer = setIntervalFn(run, intervalMs);
  startupTimer?.unref?.();
  intervalTimer?.unref?.();

  return {
    run,
    stop() {
      stopped = true;
      clearTimeoutFn(startupTimer);
      clearIntervalFn(intervalTimer);
    },
  };
}

module.exports = {
  toDateOnly,
  buildBirthdayEmbed,
  resolveAnnouncementChannel,
  announceBirthdays,
  startBirthdayAnnouncer,
};
