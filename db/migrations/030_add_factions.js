/**
 * Migration 030: Faction System
 *
 * Adds three tables that power the per-guild player faction feature:
 *
 *   factions        — the faction itself (name, tag, emblem, join mode)
 *   faction_members — who belongs to each faction with a rank
 *   faction_invites — pending invitations for invite-only factions
 *
 * Factions are scoped to a guild so each community has its own roster.
 * A player may belong to at most one faction per guild.
 */
async function up(pool) {
  console.log('⚔️  Migration 030: Faction system');

  // Core faction record.
  // `tag` is a short 3-5 character identifier displayed next to player names.
  // `is_open` controls whether anyone can join directly (true) or only via
  // invite (false).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factions (
      id                      SERIAL PRIMARY KEY,
      guild_id                INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      name                    TEXT    NOT NULL,
      tag                     TEXT    NOT NULL,
      description             TEXT,
      emblem                  TEXT    NOT NULL DEFAULT '⚔️',
      is_open                 BOOLEAN NOT NULL DEFAULT TRUE,
      created_by_identity_id  INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(guild_id, tag),
      UNIQUE(guild_id, name)
    )
  `);

  // One row per faction member.  Ranks: 'leader' | 'officer' | 'member'.
  // The unique constraint enforces the one-faction-per-player-per-guild rule
  // when combined with application-level checks (a player can only appear once
  // across *all* factions in a guild, enforced in route logic).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS faction_members (
      id          SERIAL PRIMARY KEY,
      faction_id  INTEGER NOT NULL REFERENCES factions(id) ON DELETE CASCADE,
      identity_id INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
      rank        TEXT    NOT NULL DEFAULT 'member'
                          CHECK (rank IN ('leader', 'officer', 'member')),
      joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(faction_id, identity_id)
    )
  `);

  // Pending invitations.  Expires after 7 days.
  // The unique constraint prevents duplicate pending invites to the same player.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS faction_invites (
      id                    SERIAL PRIMARY KEY,
      faction_id            INTEGER NOT NULL REFERENCES factions(id) ON DELETE CASCADE,
      inviter_identity_id   INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
      invitee_identity_id   INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at            TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
      UNIQUE(faction_id, invitee_identity_id)
    )
  `);

  // Indexes for the most common query patterns.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_factions_guild
      ON factions (guild_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_faction_members_identity
      ON faction_members (identity_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_faction_invites_invitee
      ON faction_invites (invitee_identity_id, expires_at)
  `);

  console.log('✅ Migration 030 complete');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS faction_invites');
  await pool.query('DROP TABLE IF EXISTS faction_members');
  await pool.query('DROP TABLE IF EXISTS factions');
}

module.exports = { up, down };
