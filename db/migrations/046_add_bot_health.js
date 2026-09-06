'use strict';

async function up(pool) {
  console.log('🔄 Migration 046: Add bot health heartbeat');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_health (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      status TEXT NOT NULL DEFAULT 'offline',
      started_at TIMESTAMPTZ,
      last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      guild_count INTEGER NOT NULL DEFAULT 0,
      websocket_ping_ms INTEGER,
      process_uptime_seconds INTEGER NOT NULL DEFAULT 0
    )
  `);
  console.log('✅ Migration 046 complete');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS bot_health');
}

module.exports = { up, down };
