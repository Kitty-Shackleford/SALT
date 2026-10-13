'use strict';

/**
 * Per-guild feature toggles stored in `guild_features`.
 *
 * The table is a key-value store: (guild_id, feature_name) -> { enabled, config }.
 * A missing row means the feature is OFF by default, so enabling any Phase 1
 * feature is an explicit opt-in per guild (no changes to existing behavior
 * unless an admin opts in).
 *
 * Feature names:
 *   welcome   — config { channel_id, message } ; posts when members join
 *   goodbye   — config { channel_id, message } ; posts when members leave
 *
 * Message placeholders: {user} (mention), {username} (display name),
 *   {guild} (guild name), {count} (member count when available).
 */

const pool = require('../db');

async function getFeatureConfig(discordGuildId, featureName, database = pool) {
  const result = await database.query(
    `SELECT gf.enabled, gf.config
     FROM guilds g
     JOIN guild_features gf ON gf.guild_id = g.id
     WHERE g.discord_guild_id = $1
       AND gf.feature_name = $2
     LIMIT 1`,
    [String(discordGuildId), featureName]
  );
  const row = result.rows[0];
  if (!row || !row.enabled) return null;
  let config = {};
  if (row.config) {
    try {
      config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    } catch (err) {
      console.warn(`⚠️ [guild_features] bad config json for ${featureName} in guild ${discordGuildId}: ${err.message}`);
      config = {};
    }
  }
  return { enabled: true, config };
}

async function setFeatureConfig(discordGuildId, featureName, config, enabled = true, updatedByDiscordId = null, database = pool) {
  const json = JSON.stringify(config || {});
  await database.query(
    `INSERT INTO guild_features (guild_id, feature_name, enabled, config, updated_at)
     SELECT g.id, $2, $3, $4, NOW()
     FROM guilds g
     WHERE g.discord_guild_id = $1
     ON CONFLICT (guild_id, feature_name)
     DO UPDATE SET enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = NOW()`,
    [String(discordGuildId), featureName, enabled, json]
  );
  return { discordGuildId: String(discordGuildId), featureName, enabled, config: config || {}, updatedByDiscordId };
}

/**
 * Resolve a welcome/goodbye config into a { channelId, message, placeholder }
 * shape. Returns null when the feature is off or misconfigured.
 */
function resolvePostConfig(featureConfig, requiredChannelId) {
  if (!featureConfig || !featureConfig.enabled) return null;
  const config = featureConfig.config || {};
  const channelId = config.channel_id || requiredChannelId || null;
  const message = config.message || null;
  if (!channelId) return null;
  return {
    channelId: String(channelId),
    message,
  };
}

/**
 * Substitute placeholders in a template string.
 *
 * Known keys ({user}, {username}, {guild}, {count}) are filled from `values`;
 * any other `{token}` is dropped so a mistyped placeholder doesn't show raw
 * braces in the posted message.
 */
function fillPlaceholders(template, values = {}) {
  if (!template) return null;
  return template.replace(/\{([a-z_]+)\}/gi, (match, key) => {
    const value = values[String(key).toLowerCase()];
    return value === undefined || value === null ? '' : String(value);
  });
}

module.exports = {
  getFeatureConfig,
  setFeatureConfig,
  resolvePostConfig,
  fillPlaceholders,
};
