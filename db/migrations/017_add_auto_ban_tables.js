/**
 * Migration 017: Add Auto-Ban Alt Accounts Tables
 * Adds server_settings (per-server toggles) and alt_ban_exemptions (protected players)
 */

function up(db, callback) {
  console.log('🔄 Migration 017: Add auto-ban alt accounts tables');

  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS server_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        serverId INTEGER NOT NULL UNIQUE,
        autoBanAlts INTEGER DEFAULT 0,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (serverId) REFERENCES servers(id) ON DELETE CASCADE
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS alt_ban_exemptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        serverId INTEGER NOT NULL,
        gamertag TEXT NOT NULL,
        exemptedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        exemptedBy INTEGER,
        UNIQUE(serverId, gamertag),
        FOREIGN KEY (serverId) REFERENCES servers(id) ON DELETE CASCADE,
        FOREIGN KEY (exemptedBy) REFERENCES users(id)
      )
    `);

    db.run(`CREATE INDEX IF NOT EXISTS idx_server_settings_server ON server_settings(serverId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_alt_ban_exemptions_server ON alt_ban_exemptions(serverId)`, (err) => {
      if (err) return callback(err);
      console.log('   ✅ Auto-ban alt accounts tables created');
      callback(null);
    });
  });
}

function down(db, callback) {
  db.serialize(() => {
    db.run('DROP TABLE IF EXISTS alt_ban_exemptions');
    db.run('DROP TABLE IF EXISTS server_settings', (err) => {
      if (err) return callback(err);
      callback(null);
    });
  });
}

module.exports = { up, down };
