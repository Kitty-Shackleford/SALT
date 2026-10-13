/*
 * Migration 097: birthday tracker
 *
 * Phase 3 — IRL + in-character birthdays:
 *   player_birthdays     — one row per identity (alts never double-announce)
 *   birthday_announcements — per-guild idempotency ledger (unique per
 *     identity + guild + business date) so the announcement worker can never
 *     post the same birthday twice on the same day
 *   guilds.birthday_announce_channel_id — Discord channel for daily posts
 */
'use strict';

const BIRTHDAY_SQL = `
  CREATE TABLE IF NOT EXISTS player_birthdays (
    identity_id   INTEGER PRIMARY KEY REFERENCES player_identities(id) ON DELETE CASCADE,
    month         SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
    day           SMALLINT NOT NULL CHECK (day BETWEEN 1 AND 31),
    irl_year      SMALLINT,
    char_year     SMALLINT,
    visibility    TEXT NOT NULL DEFAULT 'char_only'
      CHECK (visibility IN ('char_only', 'irl_date', 'full')),
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS player_birthdays_next_idx
    ON player_birthdays(month, day)
    WHERE active;

  CREATE TABLE IF NOT EXISTS birthday_announcements (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    identity_id   INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
    guild_id      INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    business_date DATE NOT NULL,
    message_id    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (identity_id, guild_id, business_date)
  );

  CREATE INDEX IF NOT EXISTS birthday_announcements_guild_idx
    ON birthday_announcements(guild_id, business_date);
`;

async function up(pool) {
  console.log('🔄 Migration 097: Add birthday tracker tables');
  // NOTE: PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`. The DDL above is
  // idempotent via CREATE TABLE/INDEX IF NOT EXISTS; the guilds column is
  // guarded with a DO $$ block so a *failed* migration re-run cannot
  // double-add it.
  await pool.query(BIRTHDAY_SQL);
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'guilds' AND column_name = 'birthday_announce_channel_id'
      ) THEN
        ALTER TABLE guilds
          ADD COLUMN birthday_announce_channel_id TEXT;
      END IF;
    END
    $$`);
  console.log('✅ Migration 097: birthday tracker tables created');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS birthday_announcements');
  await pool.query('DROP TABLE IF EXISTS player_birthdays');
  await pool.query('ALTER TABLE guilds DROP COLUMN IF EXISTS birthday_announce_channel_id');
}

module.exports = { up, down, BIRTHDAY_SQL };
