'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Theme resolution service (B1.2, extended by card 2/9).
 *
 * Precedence for the *base* theme (livonia | chernarus | sakhal | nasadra |
 * high-contrast):
 *   1. the user's personal preference (users.theme_preference);
 *   2. the guild default (guild_theme_settings.theme_default);
 *   3. 'livonia' (the new default; was 'dark' before card 2/9).
 * An ACTIVE holiday window (guild opted in + date in the pack's window) wins
 * for the TOKENS: the pack re-declares its seasonal variables on :root above
 * the base theme, but the base theme attribute is unchanged — the pack is a
 * pure variable swap layered over whatever base theme resolves.
 * The accent is a separate, additive override (guild accent -> theme default).
 * Nothing downstream keys off theme *names*; only off the CSS variables this
 * service emits, so a holiday pack is purely a variable swap.
 *
 * Legacy names: 'dark' is a valid alias for 'livonia' and 'light' for
 * 'sakhal', so persisted B1.2-era preferences (and un-updated clients) keep
 * resolving without a data migration. normalizeThemeName maps alias -> base.
 */

const HOLIDAY_FILE = path.join(__dirname, '..', 'public', 'css', 'holiday-themes.json');
const SETTINGS_CACHE_TTL_MS = 60 * 1000;

/** The five approved base themes, in picker display order. */
const BASE_THEMES = ['livonia', 'chernarus', 'sakhal', 'nasadra', 'high-contrast'];
const DEFAULT_BASE_THEME = 'livonia';

/** B1.2-era names kept as aliases so stored values still resolve. */
const LEGACY_THEME_MAP = { dark: 'livonia', light: 'sakhal' };

let holidayPacks = null;
const settingsCache = new Map(); // guildId -> { at, row }

function loadHolidayPacks() {
  if (holidayPacks) return holidayPacks;
  holidayPacks = JSON.parse(fs.readFileSync(HOLIDAY_FILE, 'utf8')).themes;
  return holidayPacks;
}

/**
 * Map any accepted theme value to a canonical base theme.
 * Returns null when the value is not a recognized theme (new or legacy).
 */
function normalizeThemeName(value) {
  if (typeof value !== 'string') return null;
  if (BASE_THEMES.includes(value)) return value;
  if (Object.prototype.hasOwnProperty.call(LEGACY_THEME_MAP, value)) {
    return LEGACY_THEME_MAP[value];
  }
  return null;
}

function validTheme(value) {
  return normalizeThemeName(value) !== null;
}

function validHolidayPackName(name) {
  if (name == null || name === '') return false;
  return Object.prototype.hasOwnProperty.call(loadHolidayPacks(), name);
}

function isValidHex(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

// A holiday window is active when the given date falls on its configured
// month and between startDay..endDay (inclusive). Windows never span New Year.
function singleWindowActive(window, date) {
  if (!window || !date || typeof date.getUTCMonth !== 'function') return false;
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return month === window.month && day >= window.startDay && day <= window.endDay;
}

/**
 * A pack's active windows: packs may define a single `window` object or a
 * `windows` array (easter uses two to approximate the movable date — see the
 * JSON note). The pack is active when ANY window matches.
 */
function holidayWindowActive(packWindow, date) {
  if (packWindow == null || !date || typeof date.getUTCMonth !== 'function') return false;
  if (Array.isArray(packWindow)) {
    return packWindow.some((w) => singleWindowActive(w, date));
  }
  return singleWindowActive(packWindow, date);
}

/**
 * Read guild theme settings (TTL-cached). Returns null when the guild has no
 * row yet (all defaults apply). Cache is per-process and short-lived; the
 * admin save path invalidates its own guild's entry so edits show quickly.
 */
async function getGuildThemeSettings(db, guildId) {
  const cached = settingsCache.get(guildId);
  if (cached && Date.now() - cached.at < SETTINGS_CACHE_TTL_MS) {
    return cached.row;
  }
  const row = await db.get(
    `SELECT theme_default, accent_color, holiday_theme, holiday_start, holiday_end, holiday_packs
     FROM guild_theme_settings WHERE guild_id = ?`,
    [guildId]
  );
  settingsCache.set(guildId, { at: Date.now(), row });
  return row;
}

function invalidateGuildThemeSettings(guildId) {
  settingsCache.delete(guildId);
}

/**
 * The guild's opted-in holiday packs: the card 2/9 per-pack map
 * (holiday_packs, JSONB {name: true}) plus the legacy B1.2 single-select
 * (holiday_theme) so a migrated guild keeps its old pack. 'none'/unknown
 * names are ignored; 'none' never enables anything.
 */
function optedInPackNames(settingsRow) {
  if (!settingsRow) return [];
  const names = new Set();
  const map = settingsRow.holiday_packs;
  if (map && typeof map === 'object') {
    for (const [name, enabled] of Object.entries(map)) {
      if (enabled && validHolidayPackName(name) && name !== 'none') names.add(name);
    }
  }
  if (settingsRow.holiday_theme && validHolidayPackName(settingsRow.holiday_theme) && settingsRow.holiday_theme !== 'none') {
    names.add(settingsRow.holiday_theme);
  }
  return [...names];
}

/**
 * Resolve the full theme for a render: base theme, active holiday pack(s)
 * (if any), and the accent override. Pure — takes the settings row and a
 * date so it is trivially testable.
 *
 * An active pack is a guild-opted-in pack whose window (or one of its
 * windows) contains the date. Every active pack re-declares its seasonal
 * variables on :root above the base theme, in pack-definition order, so
 * packs layer cleanly over all 5 base themes; the base theme attribute is
 * never changed by a pack.
 *
 * @returns {{baseTheme: string, holidayPack: string|null, activePacks: string[],
 *            holidayVars: object|null, accentColor: string|null,
 *            overrideCss: string}}
 * baseTheme is ALWAYS a canonical base theme name (never a legacy alias).
 * holidayPack is the single active pack's name when exactly one is active
 * (the common case), null otherwise; activePacks always lists them all.
 */
function resolveTheme(settingsRow, userPreference, date) {
  const packs = loadHolidayPacks();

  // 1) Personal preference, then guild default, then the default theme.
  //    Legacy aliases (dark/light) normalize to their base theme.
  let baseTheme = normalizeThemeName(userPreference);
  if (!baseTheme && settingsRow) {
    baseTheme = normalizeThemeName(settingsRow.theme_default);
  }
  baseTheme = baseTheme || DEFAULT_BASE_THEME;

  // 2) Active holiday packs: opted-in packs whose window contains `date`.
  //    Iterate in pack-definition order so multi-pack layering is
  //    deterministic (later packs override earlier ones).
  const optedIn = optedInPackNames(settingsRow);
  const activePacks = [];
  const mergedVars = {};
  for (const name of Object.keys(packs)) {
    if (!optedIn.includes(name)) continue;
    const pack = packs[name];
    if (!holidayWindowActive(pack.window || pack.windows, date)) continue;
    activePacks.push(name);
    Object.assign(mergedVars, pack.vars || {});
  }
  const holidayPack = activePacks.length === 1 ? activePacks[0] : null;
  const holidayVars = activePacks.length > 0 ? mergedVars : null;

  // 3) Accent: explicit guild accent overrides the theme default; an active
  //    holiday pack's own accent (if present) wins over the guild accent,
  //    since the pack is a complete seasonal skin.
  let accentColor = settingsRow && isValidHex(settingsRow.accent_color)
    ? settingsRow.accent_color
    : null;
  if (holidayVars && holidayVars['--dzc-accent']) {
    accentColor = holidayVars['--dzc-accent'];
  }

  return { baseTheme, holidayPack, activePacks, holidayVars, accentColor, overrideCss: buildOverrideCss({ holidayVars, accentColor }) };
}

/**
 * Build the injected <style> body. Emits only literal token values (validated
 * at write time); no selectors beyond :root, no URLs, no script. The
 * :root:root scope (specificity 0,2,0) beats the per-theme
 * html[data-theme='x'] token blocks (0,1,1) in theme.css, so the override
 * actually wins the cascade on the rendered page — while still losing to the
 * admin preview's #themePreview scoping (1,0,0). (B1.2 shipped :root{...},
 * which silently lost that cascade; card 2/9 fixes it.)
 */
function buildOverrideCss({ holidayVars = {}, accentColor } = {}) {
  const decls = [];
  if (holidayVars) {
    for (const [token, value] of Object.entries(holidayVars)) {
      if (!token.startsWith('--dzc-') || typeof value !== 'string') continue;
      decls.push(`${token}:${value}`);
    }
  }
  if (accentColor && isValidHex(accentColor)) {
    decls.push(`--dzc-accent:${accentColor}`);
    decls.push(`--dzc-accent-hover:color-mix(in srgb, ${accentColor} 85%, #ffffff 15%)`);
  }
  if (decls.length === 0) return '';
  return `:root:root{${decls.join(';')}}`;
}

/**
 * Validate + normalise a theme settings payload from the admin API.
 * Returns the clean fields to persist, or throws a RangeError on any invalid
 * value so the route maps it to a 400. themeDefault accepts the five base
 * themes plus the legacy 'dark'/'light' aliases (persisted canonicalized).
 * holidayPacks (card 2/9) accepts an object map {name: bool} or an array of
 * names; only valid pack names are kept, 'none' never enables.
 */
function normalizeThemeSettings({ themeDefault, accentColor, holidayTheme, holidayStart, holidayEnd, holidayPacks }) {
  const fields = {};

  if (themeDefault !== undefined) {
    const canonical = normalizeThemeName(themeDefault);
    if (!canonical) {
      throw new RangeError(`themeDefault must be one of: ${BASE_THEMES.join(', ')} (or legacy "dark"/"light")`);
    }
    fields.theme_default = canonical;
  }

  if (accentColor !== undefined) {
    if (accentColor === null || accentColor === '') {
      fields.accent_color = null;
    } else if (!isValidHex(accentColor)) {
      throw new RangeError('accentColor must be a #rrggbb hex color');
    } else {
      fields.accent_color = `#${accentColor.toLowerCase().slice(1)}`;
    }
  }

  if (holidayTheme !== undefined) {
    if (holidayTheme === null || holidayTheme === '' || holidayTheme === 'none') {
      fields.holiday_theme = null;
    } else if (!validHolidayPackName(holidayTheme)) {
      throw new RangeError('holidayTheme must be a known pack name');
    } else {
      fields.holiday_theme = holidayTheme;
    }
  }

  if (holidayPacks !== undefined) {
    if (holidayPacks === null || holidayPacks === '') {
      fields.holiday_packs = {};
    } else {
      const entries = Array.isArray(holidayPacks)
        ? holidayPacks.map((name) => [name, true])
        : (holidayPacks && typeof holidayPacks === 'object'
          ? Object.entries(holidayPacks)
          : null);
      if (!entries) {
        throw new RangeError('holidayPacks must be an object or array of pack names');
      }
      const map = {};
      for (const [name, enabled] of entries) {
        if (enabled && validHolidayPackName(name) && name !== 'none') map[name] = true;
      }
      fields.holiday_packs = map;
    }
  }

  if (holidayStart !== undefined) {
    if (holidayStart === null || holidayStart === '') {
      fields.holiday_start = null;
    } else {
      const d = new Date(`${holidayStart}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) throw new RangeError('holidayStart must be a YYYY-MM-DD date');
      fields.holiday_start = holidayStart;
    }
  }

  if (holidayEnd !== undefined) {
    if (holidayEnd === null || holidayEnd === '') {
      fields.holiday_end = null;
    } else {
      const d = new Date(`${holidayEnd}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) throw new RangeError('holidayEnd must be a YYYY-MM-DD date');
      fields.holiday_end = holidayEnd;
    }
  }

  return fields;
}

module.exports = {
  BASE_THEMES,
  DEFAULT_BASE_THEME,
  LEGACY_THEME_MAP,
  normalizeThemeName,
  loadHolidayPacks,
  validHolidayPackName,
  validTheme,
  isValidHex,
  holidayWindowActive,
  optedInPackNames,
  getGuildThemeSettings,
  invalidateGuildThemeSettings,
  resolveTheme,
  buildOverrideCss,
  normalizeThemeSettings,
  SETTINGS_CACHE_TTL_MS,
};
