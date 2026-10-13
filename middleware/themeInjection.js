'use strict';

const themeService = require('../services/themeService');

/**
 * Resolve the theme for the current request and stash it on req for the
 * render layer to inject. Runs before routing, after session+passport, so
 * req.user (when logged in) is available.
 *
 * - Anonymous visitors get the guild default / dark (no personal choice).
 * - The guild is the user's primary approved guild (the same one the
 *   dashboard uses to gate access). Multi-guild users see their primary
 *   guild's theme; per-guild theming is a B1.3 concern.
 * - On any lookup failure it fails soft: req.theme is left unset and the
 *   page renders with the base tokens. Theming must never take a page down.
 *
 * Cost model: the user -> primary-guild mapping is cached per user (5 min);
 * guild settings use themeService's 60s TTL cache; the user preference is a
 * single PK lookup. So a warm request costs ~2 indexed queries.
 */

const GUILD_LOOKUP_TTL_MS = 5 * 60 * 1000;
const guildLookupCache = new Map(); // userId -> { at, guildId|null }

async function themeInjectionMiddleware(req, res, next) {
  try {
    req.theme = await resolveRequestTheme(req);
  } catch (err) {
    req.theme = undefined;
    console.error('⚠️ themeInjectionMiddleware failed (rendering with base tokens):', err.message);
  }
  next();
}

async function resolveRequestTheme(req) {
  const db = req.app && req.app.locals && req.app.locals.db;
  if (!db || !req.user || !req.user.id) return undefined;

  const guildId = await primaryGuildId(db, req.user.id);
  if (!guildId) return undefined;

  const [settings, userPrefRow] = await Promise.all([
    themeService.getGuildThemeSettings(db, guildId),
    db.get('SELECT theme_preference FROM users WHERE id = ?', [req.user.id]),
  ]);
  const userPreference = userPrefRow ? userPrefRow.theme_preference : null;

  const resolved = themeService.resolveTheme(settings, userPreference, new Date());
  return {
    baseTheme: resolved.baseTheme,
    holidayPack: resolved.holidayPack,
    accentColor: resolved.accentColor,
    overrideCss: resolved.overrideCss,
  };
}

async function primaryGuildId(db, userId) {
  const cached = guildLookupCache.get(userId);
  if (cached && Date.now() - cached.at < GUILD_LOOKUP_TTL_MS) {
    return cached.guildId;
  }
  const row = await db.get(
    `SELECT g.id AS guild_id
     FROM guilds g
     JOIN guild_roles gr ON gr.guild_id = g.id
     WHERE gr.user_id = ? AND g.status = 'approved'
     ORDER BY g.id ASC
     LIMIT 1`,
    [userId]
  );
  const guildId = row ? row.guild_id : null;
  guildLookupCache.set(userId, { at: Date.now(), guildId });
  return guildId;
}

module.exports = { themeInjectionMiddleware, resolveRequestTheme, GUILD_LOOKUP_TTL_MS };
