/**
 * Migration 016: Add Discord Feed System
 * Adds tables for discord_feeds, feed_templates, and feed_events
 */

function up(db, callback) {
  console.log('🔄 Migration 016: Add Discord feed system tables');

  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS discord_feeds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guildId TEXT NOT NULL,
        feedType TEXT NOT NULL,
        enabled INTEGER DEFAULT 0,
        channelId TEXT,
        webhookUrl TEXT,
        settings TEXT,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guildId, feedType)
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_discord_feeds_guild ON discord_feeds(guildId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_discord_feeds_enabled ON discord_feeds(enabled)`);

    db.run(`
      CREATE TABLE IF NOT EXISTS feed_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guildId TEXT NOT NULL,
        feedType TEXT NOT NULL,
        eventType TEXT NOT NULL,
        template TEXT NOT NULL,
        embedEnabled INTEGER DEFAULT 0,
        embedColor TEXT DEFAULT '#FF0000',
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(guildId, feedType, eventType)
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_feed_templates_guild ON feed_templates(guildId)`);

    db.run(`
      CREATE TABLE IF NOT EXISTS feed_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guildId TEXT NOT NULL,
        serverId INTEGER NOT NULL,
        feedType TEXT NOT NULL,
        eventType TEXT NOT NULL,
        eventData TEXT NOT NULL,
        processed INTEGER DEFAULT 0,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processedAt TIMESTAMP
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_feed_events_pending ON feed_events(processed, createdAt)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_feed_events_guild ON feed_events(guildId)`, (err) => {
      if (err) return callback(err);
      console.log('   ✅ Discord feed tables created');
      callback(null);
    });
  });
}

function down(db, callback) {
  db.serialize(() => {
    db.run('DROP TABLE IF EXISTS feed_events');
    db.run('DROP TABLE IF EXISTS feed_templates');
    db.run('DROP TABLE IF EXISTS discord_feeds', (err) => {
      if (err) return callback(err);
      callback(null);
    });
  });
}

module.exports = { up, down };
