'use strict';

/**
 * antiSpamService.js
 *
 * Per-guild anti-spam rate limiter for text messages.
 *
 * Algorithm (per user, per guild):
 *   - Messages closer than `gapMs` apart count toward the burst.
 *   - A gap of more than `gapMs` restarts the burst (and the window).
 *   - The burst window is `windowMs` from its first message.
 *   - When the burst reaches `limit` messages inside the window, the
 *     offending message is flagged for deletion (handled by the
 *     messageCreate event, which also posts the moderator notice).
 *
 * Off by default per guild: opt in with /setup-antispam enable. Config
 * lives in guild_features (feature_name 'antispam', see
 * bot/utils/guildFeatureSettings.js).
 *
 * State is in-memory (survives nothing across restarts — acceptable for a
 * rate limiter; there is nothing persistent to reconcile).
 */

const pool = require('../db');
const { getFeatureConfig } = require('../utils/guildFeatureSettings');

const DEFAULTS = Object.freeze({
  limit: 5,      // messages per burst
  windowMs: 10000, // burst window from the first message
  gapMs: 3000,    // pause that restarts the burst
});

const LIMITS = Object.freeze({
  limit: [3, 15],
  windowMs: [5000, 120000],
  gapMs: [1000, 10000],
});

function clampInt(value, [min, max], fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Coerce a stored config object into a safe { limit, windowMs, gapMs } shape.
 * Missing or out-of-range values fall back to DEFAULTS.
 */
function normalizeConfig(config) {
  const cfg = config || {};
  return {
    limit: clampInt(cfg.limit, LIMITS.limit, DEFAULTS.limit),
    windowMs: clampInt(cfg.windowMs, LIMITS.windowMs, DEFAULTS.windowMs),
    gapMs: clampInt(cfg.gapMs, LIMITS.gapMs, DEFAULTS.gapMs),
  };
}

/**
 * Pure tick of the rate limiter.
 *
 * @param {{count:number,lastTs:number,expireAt:number}|null} tracker
 * @param {number} now message createdTimestamp (ms epoch)
 * @param {{limit:number,windowMs:number,gapMs:number}} cfg
 * @returns {{tracker: object|null, action: 'limit'|null}}
 *   tracker=null with action='limit' means the burst tripped and the
 *   previous state is discarded (the next message starts a fresh burst).
 */
function tick(tracker, now, cfg) {
  if (!tracker || now > tracker.expireAt || now - tracker.lastTs > cfg.gapMs) {
    return { tracker: { count: 1, lastTs: now, expireAt: now + cfg.windowMs }, action: null };
  }
  const count = tracker.count + 1;
  if (count >= cfg.limit) return { tracker: null, action: 'limit' };
  return { tracker: { count, lastTs: now, expireAt: tracker.expireAt }, action: null };
}

// guildId -> { cfg, expiresAt }
const configCache = new Map();
const CONFIG_TTL_MS = 30000;

// `${guildId}:${userId}` -> tracker
const trackers = new Map();

function cleanupTrackers(now) {
  if (trackers.size < 2000) return;
  for (const [key, t] of trackers) {
    if (now > t.expireAt) trackers.delete(key);
  }
}

/**
 * @param {string} guildId discord guild id
 * @param {{database?: object}} [opts] database override (tests)
 * @returns {Promise<{limit:number,windowMs:number,gapMs:number}|null>} null
 *   when anti-spam is disabled or the guild is not registered.
 */
async function getConfig(guildId, { database = pool } = {}) {
  const now = Date.now();
  const cached = configCache.get(String(guildId));
  if (cached && cached.expiresAt > now) return cached.cfg;

  let cfg = null;
  try {
    const feature = await getFeatureConfig(String(guildId), 'antispam', database);
    cfg = feature ? normalizeConfig(feature.config) : null;
  } catch (err) {
    console.warn(`⚠️ [antispam] config lookup failed for guild ${guildId}: ${err.message}`);
    return null;
  }
  configCache.set(String(guildId), { cfg, expiresAt: now + CONFIG_TTL_MS });
  return cfg;
}

/**
 * Handle one text message.
 *
 * @param {import('discord.js').Message} message
 * @param {{database?: object}} [opts]
 * @returns {Promise<boolean>} true when the message tripped the limit and
 *   should be deleted + announced by the caller.
 */
async function handleMessageCreate(message, opts = {}) {
  const guild = message.guild;
  if (!guild) return false;
  const author = message.author;
  if (!author || author.bot) return false;

  const cfg = await getConfig(guild.id, opts);
  if (!cfg) return false;

  const now = Number.isFinite(message.createdTimestamp)
    ? message.createdTimestamp
    : Date.now();
  const key = `${guild.id}:${author.id}`;
  const { tracker, action } = tick(trackers.get(key) || null, now, cfg);

  if (action === 'limit') {
    trackers.delete(key);
    cleanupTrackers(now);
    return true;
  }
  trackers.set(key, tracker);
  return false;
}

/** Test helper: drop all cached state. */
function resetState() {
  configCache.clear();
  trackers.clear();
}

module.exports = {
  DEFAULTS,
  normalizeConfig,
  tick,
  getConfig,
  handleMessageCreate,
  resetState,
};
