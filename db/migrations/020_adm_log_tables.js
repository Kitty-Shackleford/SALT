'use strict';

async function up(db) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(`CREATE TABLE IF NOT EXISTS player_death_events (
      id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      server_id INTEGER NOT NULL,
      identity_id INTEGER,
      player_gamertag TEXT,
      death_type TEXT NOT NULL,
      killed_by TEXT,
      water_level REAL,
      energy_level REAL,
      bleed_sources INTEGER,
      pos_x REAL,
      pos_y REAL,
      pos_z REAL,
      timestamp TIMESTAMPTZ NOT NULL,
      log_source TEXT DEFAULT 'adm_log',
      UNIQUE(server_id, identity_id, timestamp, death_type),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (identity_id) REFERENCES player_identities(id)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS player_unconscious_events (
      id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      server_id INTEGER NOT NULL,
      identity_id INTEGER,
      player_gamertag TEXT,
      event_type TEXT NOT NULL,
      pos_x REAL,
      pos_y REAL,
      pos_z REAL,
      timestamp TIMESTAMPTZ NOT NULL,
      log_source TEXT DEFAULT 'adm_log',
      UNIQUE(server_id, identity_id, timestamp, event_type),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (identity_id) REFERENCES player_identities(id)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS player_respawn_events (
      id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      server_id INTEGER NOT NULL,
      identity_id INTEGER,
      player_gamertag TEXT,
      pos_x REAL,
      pos_y REAL,
      pos_z REAL,
      timestamp TIMESTAMPTZ NOT NULL,
      log_source TEXT DEFAULT 'adm_log',
      UNIQUE(server_id, identity_id, timestamp),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (identity_id) REFERENCES player_identities(id)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS player_position_snapshots (
      id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      server_id INTEGER NOT NULL,
      identity_id INTEGER,
      player_gamertag TEXT NOT NULL,
      pos_x REAL NOT NULL,
      pos_y REAL NOT NULL,
      pos_z REAL NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL,
      log_source TEXT DEFAULT 'adm_log',
      UNIQUE(server_id, identity_id, timestamp),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (identity_id) REFERENCES player_identities(id)
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS player_emote_events (
      id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      server_id INTEGER NOT NULL,
      identity_id INTEGER,
      player_gamertag TEXT,
      emote_type TEXT NOT NULL,
      item_name TEXT,
      pos_x REAL,
      pos_y REAL,
      pos_z REAL,
      timestamp TIMESTAMPTZ NOT NULL,
      log_source TEXT DEFAULT 'adm_log',
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (identity_id) REFERENCES player_identities(id)
    )`);

    await client.query('ALTER TABLE territory_events ADD COLUMN IF NOT EXISTS structure_part TEXT');
    await client.query('ALTER TABLE territory_events ADD COLUMN IF NOT EXISTS tool_used TEXT');

    // Death events indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_death_events_server ON player_death_events(server_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_death_events_identity ON player_death_events(identity_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_death_events_timestamp ON player_death_events(timestamp DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_death_events_type ON player_death_events(death_type)');
    // Unconscious events indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_unconscious_events_server ON player_unconscious_events(server_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_unconscious_events_identity ON player_unconscious_events(identity_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_unconscious_events_timestamp ON player_unconscious_events(timestamp DESC)');
    // Respawn events indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_respawn_events_server ON player_respawn_events(server_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_respawn_events_identity ON player_respawn_events(identity_id)');
    // Position snapshots indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_position_snapshots_server ON player_position_snapshots(server_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_position_snapshots_identity ON player_position_snapshots(identity_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_position_snapshots_timestamp ON player_position_snapshots(timestamp DESC)');
    // Emote events indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_emote_events_server ON player_emote_events(server_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_emote_events_identity ON player_emote_events(identity_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_emote_events_type ON player_emote_events(emote_type)');

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function down(db) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query('DROP TABLE IF EXISTS player_death_events');
    await client.query('DROP TABLE IF EXISTS player_unconscious_events');
    await client.query('DROP TABLE IF EXISTS player_respawn_events');
    await client.query('DROP TABLE IF EXISTS player_position_snapshots');
    await client.query('DROP TABLE IF EXISTS player_emote_events');
    await client.query('ALTER TABLE territory_events DROP COLUMN IF EXISTS structure_part');
    await client.query('ALTER TABLE territory_events DROP COLUMN IF EXISTS tool_used');

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { up, down };
