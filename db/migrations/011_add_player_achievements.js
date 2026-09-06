/**
 * Migration 011: Add Player Achievements Table
 *
 * Adds the player_achievements table for tracking in-game accomplishments.
 */

function up(db, callback) {
  console.log('🔄 Migration 011: Add player_achievements table');

  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS player_achievements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identityId INTEGER NOT NULL,
      achievementType TEXT NOT NULL,
      achievementName TEXT NOT NULL,
      achievedAt DATETIME NOT NULL,
      metadata TEXT,
      UNIQUE(identityId, achievementType, achievementName),
      FOREIGN KEY (identityId) REFERENCES player_identities(id) ON DELETE CASCADE
    )`, (err) => {
      if (err) return callback(err);

      db.run('CREATE INDEX IF NOT EXISTS idx_player_achievements_identity ON player_achievements(identityId)', (err) => {
        if (err) return callback(err);

        console.log('   ✅ Created player_achievements table');
        callback(null);
      });
    });
  });
}

module.exports = { up };
