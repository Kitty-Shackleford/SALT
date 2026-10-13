/**
 * Migration 099: guild theme settings (B1.2)
 *
 * Per-guild theme layer on top of the B1.1 design tokens:
 *   guild_theme_settings.theme_default   — 'dark' | 'light'; the base theme
 *                                          applied when a user has no personal
 *                                          choice and no holiday window is active.
 *   guild_theme_settings.accent_color    — nullable hex (#rrggbb); overrides
 *                                          --dzc-accent for that guild. NULL =
 *                                          use the theme's default (olive).
 *   guild_theme_settings.holiday_theme   — nullable; name of a static holiday
 *                                          pack (see public/css/holiday-themes.json)
 *                                          plus its active window. NULL = off.
 *
 * Users also get a personal choice (dark/light) in users.theme_preference,
 * independent of the guild default — mirrors the "user-level theme toggle" in
 * the roadmap. The holiday window always wins over both when active.
 */
'use strict';

async function up(pool) {
  console.log('🔄 Migration 099: Add guild theme settings + user theme preference');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_theme_settings (
      guild_id       INTEGER PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
      theme_default  TEXT NOT NULL DEFAULT 'dark'
        CHECK (theme_default IN ('dark', 'light')),
      accent_color   TEXT
        CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9a-fA-F]{6}$'),
      holiday_theme  TEXT,
      holiday_start  DATE,
      holiday_end    DATE,
      updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS theme_preference TEXT
        CHECK (theme_preference IS NULL OR theme_preference IN ('dark', 'light'));
  `);
}

module.exports = { up };
