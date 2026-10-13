/**
 * Migration 107: Card 2/9 theme foundation — widen theme name domains.
 *
 * Migration 099 pinned the base-theme CHECK constraints to the B1.2 era
 * values ('dark' | 'light'). Card 2/9 replaces that pair with five base
 * themes: livonia (new default), chernarus, sakhal (the light theme),
 * nasadra, and high-contrast. 'dark'/'light' are kept as legacy aliases in
 * the service layer (dark -> livonia, light -> sakhal) so already-stored
 * values keep resolving; the DB itself now accepts either vocabulary, and
 * new writes are persisted canonicalized by the service.
 *
 *  - guild_theme_settings.holiday_packs JSONB (new): per-pack opt-in map
 *    {packName: true} — card 2/9 design: holiday packs are opt-in per guild,
 *    NOT auto-active for everyone. The legacy single-select holiday_theme
 *    column still works and is honored alongside it (a guild migrating from
 *    B1.2 keeps its configured pack active within its window until an admin
 *    changes anything).
 *
 * Constraints are replaced in place (Postgres has no ALTER COLUMN DROP
 * CHECK), so both columns keep their NOT NULL / NULL-ability from 099.
 */
'use strict';

async function up(pool) {
  console.log('🔄 Migration 107: Widen theme name domains to the 5 base themes (+legacy dark/light); add per-pack opt-in map');
  await pool.query(`
    ALTER TABLE guild_theme_settings
      DROP CONSTRAINT IF EXISTS guild_theme_settings_theme_default_check;
  `);
  await pool.query(`
    ALTER TABLE guild_theme_settings
      ADD CONSTRAINT guild_theme_settings_theme_default_check
      CHECK (theme_default IN ('livonia', 'chernarus', 'sakhal', 'nasadra', 'high-contrast', 'dark', 'light'));
  `);
  await pool.query(`
    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_theme_preference_check;
  `);
  await pool.query(`
    ALTER TABLE users
      ADD CONSTRAINT users_theme_preference_check
      CHECK (theme_preference IS NULL OR theme_preference
        IN ('livonia', 'chernarus', 'sakhal', 'nasadra', 'high-contrast', 'dark', 'light'));
  `);
  await pool.query(`
    ALTER TABLE guild_theme_settings
      ADD COLUMN IF NOT EXISTS holiday_packs JSONB NOT NULL DEFAULT '{}';
  `);
  // Seed the per-pack opt-in map from the legacy single-select so guilds
  // configured in the B1.2 era keep their pack active within its window.
  await pool.query(`
    UPDATE guild_theme_settings
       SET holiday_packs = jsonb_build_object(holiday_theme, true)
     WHERE holiday_theme IS NOT NULL
       AND holiday_theme <> 'none'
       AND NOT (COALESCE(holiday_packs, '{}'::jsonb) ? holiday_theme);
  `);
  // Backfill: canonicalize stored B1.2-era values so the DB only ever holds
  // the new vocabulary going forward.
  await pool.query(`
    UPDATE guild_theme_settings SET theme_default = 'livonia' WHERE theme_default = 'dark';
    UPDATE guild_theme_settings SET theme_default = 'sakhal' WHERE theme_default = 'light';
    UPDATE users SET theme_preference = 'livonia' WHERE theme_preference = 'dark';
    UPDATE users SET theme_preference = 'sakhal' WHERE theme_preference = 'light';
  `);
}

module.exports = { up };
