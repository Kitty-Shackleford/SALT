/**
 * Migration 051: Bind feeds, templates, restart preferences, player alerts,
 * and status configuration to an exact DayZ server.
 *
 * Legacy rows are assigned only when their Discord guild has exactly one
 * registered server. Ambiguous rows remain unassigned and are disabled.
 */
async function up(pool) {
  console.log('🔄 Migration 051: Add exact-server runtime configuration');

  await pool.query(`
    ALTER TABLE discord_feeds
      ADD COLUMN IF NOT EXISTS server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE;
    ALTER TABLE feed_templates
      ADD COLUMN IF NOT EXISTS server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE;
    ALTER TABLE restart_notify_prefs
      ADD COLUMN IF NOT EXISTS server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE;
    ALTER TABLE player_count_alerts
      ADD COLUMN IF NOT EXISTS server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE;
    ALTER TABLE player_reports
      ADD COLUMN IF NOT EXISTS server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE;
  `);

  await pool.query(`
    WITH singleton_servers AS (
      SELECT g.discord_guild_id, MIN(s.id) AS server_id
      FROM guilds g
      JOIN servers s ON s.guild_id = g.id
      GROUP BY g.id, g.discord_guild_id
      HAVING COUNT(*) = 1
    )
    UPDATE discord_feeds f
       SET server_id = singleton_servers.server_id
      FROM singleton_servers
     WHERE f.server_id IS NULL
       AND f.guild_id = singleton_servers.discord_guild_id;

    WITH singleton_servers AS (
      SELECT g.discord_guild_id, MIN(s.id) AS server_id
      FROM guilds g
      JOIN servers s ON s.guild_id = g.id
      GROUP BY g.id, g.discord_guild_id
      HAVING COUNT(*) = 1
    )
    UPDATE feed_templates t
       SET server_id = singleton_servers.server_id
      FROM singleton_servers
     WHERE t.server_id IS NULL
       AND t.guild_id = singleton_servers.discord_guild_id;

    WITH singleton_servers AS (
      SELECT g.discord_guild_id, MIN(s.id) AS server_id
      FROM guilds g
      JOIN servers s ON s.guild_id = g.id
      GROUP BY g.id, g.discord_guild_id
      HAVING COUNT(*) = 1
    )
    UPDATE restart_notify_prefs p
       SET server_id = singleton_servers.server_id
      FROM singleton_servers
     WHERE p.server_id IS NULL
       AND p.guild_id = singleton_servers.discord_guild_id;

    WITH singleton_servers AS (
      SELECT g.discord_guild_id, MIN(s.id) AS server_id
      FROM guilds g
      JOIN servers s ON s.guild_id = g.id
      GROUP BY g.id, g.discord_guild_id
      HAVING COUNT(*) = 1
    )
    UPDATE player_count_alerts a
       SET server_id = singleton_servers.server_id
      FROM singleton_servers
     WHERE a.server_id IS NULL
       AND a.guild_id = singleton_servers.discord_guild_id;

    WITH singleton_servers AS (
      SELECT g.discord_guild_id, MIN(s.id) AS server_id
      FROM guilds g
      JOIN servers s ON s.guild_id = g.id
      GROUP BY g.id, g.discord_guild_id
      HAVING COUNT(*) = 1
    )
    UPDATE player_reports r
       SET server_id = singleton_servers.server_id
      FROM singleton_servers
     WHERE r.server_id IS NULL
       AND r.guild_id = singleton_servers.discord_guild_id;

    UPDATE discord_feeds SET enabled = 0 WHERE server_id IS NULL;
    UPDATE restart_notify_prefs SET enabled = FALSE WHERE server_id IS NULL;
    UPDATE player_count_alerts SET enabled = FALSE WHERE server_id IS NULL;
  `);

  await pool.query(`
    ALTER TABLE discord_feeds
      DROP CONSTRAINT IF EXISTS discord_feeds_guild_id_feed_type_key;
    ALTER TABLE feed_templates
      DROP CONSTRAINT IF EXISTS feed_templates_guild_id_feed_type_event_type_key;
    ALTER TABLE restart_notify_prefs
      DROP CONSTRAINT IF EXISTS restart_notify_prefs_guild_id_discord_user_id_key;

    CREATE UNIQUE INDEX IF NOT EXISTS discord_feeds_server_type_uq
      ON discord_feeds(server_id, feed_type);
    CREATE UNIQUE INDEX IF NOT EXISTS feed_templates_server_type_event_uq
      ON feed_templates(server_id, feed_type, event_type);
    CREATE UNIQUE INDEX IF NOT EXISTS restart_notify_server_user_uq
      ON restart_notify_prefs(server_id, discord_user_id);

    CREATE INDEX IF NOT EXISTS discord_feeds_server_enabled_idx
      ON discord_feeds(server_id, enabled);
    CREATE INDEX IF NOT EXISTS feed_templates_server_idx
      ON feed_templates(server_id);
    CREATE INDEX IF NOT EXISTS restart_notify_server_enabled_idx
      ON restart_notify_prefs(server_id, enabled);
    CREATE INDEX IF NOT EXISTS player_count_alerts_server_enabled_idx
      ON player_count_alerts(server_id, enabled);
    CREATE INDEX IF NOT EXISTS player_reports_server_created_idx
      ON player_reports(server_id, created_at DESC);

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'discord_feeds_enabled_server_ck'
          AND conrelid = 'discord_feeds'::regclass
      ) THEN
        ALTER TABLE discord_feeds
          ADD CONSTRAINT discord_feeds_enabled_server_ck
          CHECK (enabled = 0 OR server_id IS NOT NULL) NOT VALID;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'restart_notify_enabled_server_ck'
          AND conrelid = 'restart_notify_prefs'::regclass
      ) THEN
        ALTER TABLE restart_notify_prefs
          ADD CONSTRAINT restart_notify_enabled_server_ck
          CHECK (enabled = FALSE OR server_id IS NOT NULL) NOT VALID;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'player_count_alerts_enabled_server_ck'
          AND conrelid = 'player_count_alerts'::regclass
      ) THEN
        ALTER TABLE player_count_alerts
          ADD CONSTRAINT player_count_alerts_enabled_server_ck
          CHECK (enabled = FALSE OR server_id IS NOT NULL) NOT VALID;
      END IF;
    END $$;

    ALTER TABLE discord_feeds
      VALIDATE CONSTRAINT discord_feeds_enabled_server_ck;
    ALTER TABLE restart_notify_prefs
      VALIDATE CONSTRAINT restart_notify_enabled_server_ck;
    ALTER TABLE player_count_alerts
      VALIDATE CONSTRAINT player_count_alerts_enabled_server_ck;
  `);

  await pool.query(`
    WITH singleton_servers AS (
      SELECT g.id AS guild_id, MIN(s.id) AS server_id
      FROM guilds g
      JOIN servers s ON s.guild_id = g.id
      GROUP BY g.id
      HAVING COUNT(*) = 1
    )
    INSERT INTO server_features (server_id, feature_name, enabled, config, updated_at)
    SELECT singleton_servers.server_id,
           'server_status',
           gf.enabled,
           gf.config,
           gf.updated_at
      FROM guild_features gf
      JOIN singleton_servers ON singleton_servers.guild_id = gf.guild_id
     WHERE gf.feature_name = 'server_status'
    ON CONFLICT (server_id, feature_name) DO NOTHING;

    UPDATE guild_features
       SET enabled = 0,
           updated_at = NOW()
     WHERE feature_name = 'server_status';
  `);

  console.log('✅ Migration 051 complete');
}

async function down() {
  throw new Error(
    'Migration 051 is irreversible: multiple server configurations cannot be collapsed safely to guild scope'
  );
}

module.exports = { up, down };
