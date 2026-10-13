/**
 * Migration 096: sign-up event teleports
 *
 * Phase A — sign-up event teleport ('tp-event'):
 *   event_teleport_signups — a moderator-announced event: join by button,
 *                            destination + expiry + cap;
 *   event_signups          — per-identity join/leave ledger for one event
 *                            (UNIQUE per event+identity so a re-join after
 *                            leaving is a clean upsert, never a duplicate).
 *
 * player_identities.id is INTEGER, so event_signups.identity_id is INTEGER
 * (the task spec said BIGINT pending verification — INTEGER it is).
 */
'use strict';

async function up(pool) {
  console.log('🔄 Migration 096: Add sign-up event teleport tables');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_teleport_signups (
      id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      guild_id           INTEGER NOT NULL,
      server_id          INTEGER NOT NULL,
      event_name         TEXT NOT NULL CHECK (char_length(event_name) BETWEEN 1 AND 100),
      destination_id     BIGINT NOT NULL,
      channel_id         TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'closed', 'expired')),
      cap                INTEGER NOT NULL DEFAULT 25 CHECK (cap BETWEEN 1 AND 500),
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at         TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS event_teleport_signups_server_status_idx
      ON event_teleport_signups (server_id, status, expires_at);
    CREATE INDEX IF NOT EXISTS event_teleport_signups_guild_idx
      ON event_teleport_signups (guild_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS event_signups (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_id    BIGINT NOT NULL,
      identity_id INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'joined' CHECK (status IN ('joined', 'left')),
      joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (event_id, identity_id)
    );

    CREATE INDEX IF NOT EXISTS event_signups_event_idx
      ON event_signups (event_id, status);
  `);
  await pool.query(`
    ALTER TABLE event_teleport_signups
      ADD CONSTRAINT event_teleport_signups_guild_fk
      FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
  `);
  await pool.query(`
    ALTER TABLE event_teleport_signups
      ADD CONSTRAINT event_teleport_signups_server_fk
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  `);
  await pool.query(`
    ALTER TABLE event_teleport_signups
      ADD CONSTRAINT event_teleport_signups_destination_fk
      FOREIGN KEY (destination_id) REFERENCES teleport_destinations(id) ON DELETE CASCADE
  `);
  await pool.query(`
    ALTER TABLE event_signups
      ADD CONSTRAINT event_signups_event_fk
      FOREIGN KEY (event_id) REFERENCES event_teleport_signups(id) ON DELETE CASCADE
  `);
  await pool.query(`
    ALTER TABLE event_signups
      ADD CONSTRAINT event_signups_identity_fk
      FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE CASCADE
  `);
  console.log('✅ Migration 096: sign-up event teleport tables created');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS event_signups');
  await pool.query('DROP TABLE IF EXISTS event_teleport_signups');
}

module.exports = { up, down };
