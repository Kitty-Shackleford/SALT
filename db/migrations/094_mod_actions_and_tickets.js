/*
 * Migration 094: mod_actions + tickets + ticket_messages
 *
 * Phase 2 — mod upgrade + tickets:
 *   mod_actions     — warning/moderation ladder, identity-linked (alts caught)
 *   tickets         — Discord ticket threads with archived transcripts
 *   ticket_messages — per-message transcript rows (source of truth)
 */
'use strict';

const MOD_ACTIONS_SQL = `
  CREATE TABLE IF NOT EXISTS mod_actions (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    guild_id              INTEGER NOT NULL,
    server_id             INTEGER,
    identity_id           INTEGER,
    target_discord_id     TEXT,
    action                TEXT NOT NULL
      CHECK (action IN ('warn', 'timeout', 'mute', 'kick', 'note', 'case_review')),
    level                 INTEGER NOT NULL DEFAULT 0,
    reason                TEXT NOT NULL DEFAULT '' CHECK (char_length(reason) <= 1000),
    acted_by_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    acted_by_discord_id   TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at           TIMESTAMPTZ,
    resolved_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS mod_actions_identity_idx
    ON mod_actions(identity_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS mod_actions_guild_idx
    ON mod_actions(guild_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS mod_actions_server_idx
    ON mod_actions(server_id, created_at DESC);

  ALTER TABLE mod_actions
    ADD CONSTRAINT mod_actions_guild_fk
    FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE;
  ALTER TABLE mod_actions
    ADD CONSTRAINT mod_actions_server_fk
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL;
  ALTER TABLE mod_actions
    ADD CONSTRAINT mod_actions_identity_fk
    FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE SET NULL;

  CREATE TABLE IF NOT EXISTS tickets (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    guild_id              INTEGER NOT NULL,
    channel_id            TEXT NOT NULL UNIQUE,
    subject               TEXT NOT NULL DEFAULT '',
    opened_by_discord_id  TEXT NOT NULL,
    opened_by_username    TEXT NOT NULL DEFAULT '',
    closed_at             TIMESTAMPTZ,
    closed_by_discord_id  TEXT,
    close_reason          TEXT,
    message_count         INTEGER NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS tickets_guild_idx ON tickets(guild_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS ticket_messages (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticket_id     BIGINT NOT NULL,
    channel_id    TEXT NOT NULL,
    author_id     TEXT NOT NULL,
    author_name   TEXT NOT NULL DEFAULT '',
    content       TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS ticket_messages_ticket_idx ON ticket_messages(ticket_id, created_at);
`;

async function up(pool) {
  console.log('🔄 Migration 094: Add mod_actions + tickets tables');
  // NOTE: PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`. The DDL above is
  // idempotent via CREATE TABLE/INDEX IF NOT EXISTS; constraints are added
  // unconditionally here (safe because the tables are created in the same
  // transaction, so re-runs of a *failed* migration can't double-add them, and
  // a *successful* run is never re-run — the runner tracks completed names).
  await pool.query(MOD_ACTIONS_SQL);
  await pool.query(
    `ALTER TABLE tickets
       ADD CONSTRAINT tickets_guild_fk
       FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE`
  );
  await pool.query(
    `ALTER TABLE ticket_messages
       ADD CONSTRAINT ticket_messages_ticket_fk
       FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE`
  );
  console.log('✅ Migration 094: mod_actions + tickets tables created');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS ticket_messages');
  await pool.query('DROP TABLE IF EXISTS tickets');
  await pool.query('DROP TABLE IF EXISTS mod_actions');
}

module.exports = { up, down, MOD_ACTIONS_SQL };
