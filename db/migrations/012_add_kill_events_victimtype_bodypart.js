/**
 * Migration 012: Add victimType and bodyPart columns to kill_events
 *
 * Adds victimType (e.g. 'player', 'infected') and bodyPart to support
 * achievement tracking for headshot kills and infected kills.
 */

function up(db, callback) {
  console.log('🔄 Migration 012: Add victimType and bodyPart to kill_events');

  db.serialize(() => {
    db.run(
      `ALTER TABLE kill_events ADD COLUMN victimType TEXT NOT NULL DEFAULT 'player'`,
      (err) => {
        // Ignore "duplicate column" errors in case this migration is re-run
        if (err && !err.message.includes('duplicate column')) {
          return callback(err);
        }

        db.run(
          `ALTER TABLE kill_events ADD COLUMN bodyPart TEXT`,
          (err2) => {
            if (err2 && !err2.message.includes('duplicate column')) {
              return callback(err2);
            }

            console.log('   ✅ Added victimType and bodyPart columns to kill_events');
            callback(null);
          }
        );
      }
    );
  });
}

module.exports = { up };
