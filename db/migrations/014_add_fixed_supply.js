/**
 * Migration 014: Add Fixed Money Supply Tracking
 *
 * Adds fixed supply enforcement columns to guild_economy_config and
 * creates the economy_supply_log audit table for faucet/sink monitoring.
 */

function up(db, callback) {
  console.log('🔄 Migration 014: Add fixed money supply tracking');

  db.serialize(() => {
    db.run(`ALTER TABLE guild_economy_config ADD COLUMN fixedSupplyEnabled INTEGER DEFAULT 0`, (err) => {
      if (err && !err.message.includes('duplicate column')) return callback(err);

      db.run(`ALTER TABLE guild_economy_config ADD COLUMN maxMoneySupply REAL DEFAULT NULL`, (err) => {
        if (err && !err.message.includes('duplicate column')) return callback(err);

        db.run(`ALTER TABLE guild_economy_config ADD COLUMN currentMoneySupply REAL DEFAULT 0`, (err) => {
          if (err && !err.message.includes('duplicate column')) return callback(err);

          db.run(`ALTER TABLE guild_economy_config ADD COLUMN lastSupplyUpdate TEXT`, (err) => {
            if (err && !err.message.includes('duplicate column')) return callback(err);

            db.run(`CREATE TABLE IF NOT EXISTS economy_supply_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              guildId INTEGER NOT NULL,
              changeType TEXT NOT NULL,
              source TEXT NOT NULL,
              amount REAL NOT NULL,
              supplyBefore REAL NOT NULL,
              supplyAfter REAL NOT NULL,
              identityId INTEGER,
              serverId INTEGER,
              timestamp TEXT NOT NULL,
              metadata TEXT,
              FOREIGN KEY (guildId) REFERENCES guilds(id),
              FOREIGN KEY (identityId) REFERENCES player_identities(id),
              FOREIGN KEY (serverId) REFERENCES servers(id)
            )`, (err) => {
              if (err) return callback(err);

              db.run(`CREATE INDEX IF NOT EXISTS idx_supply_log_guild ON economy_supply_log(guildId)`, (err) => {
                if (err) return callback(err);

                db.run(`CREATE INDEX IF NOT EXISTS idx_supply_log_timestamp ON economy_supply_log(timestamp)`, (err) => {
                  if (err) return callback(err);

                  db.run(`CREATE INDEX IF NOT EXISTS idx_supply_log_type ON economy_supply_log(changeType)`, (err) => {
                    if (err) return callback(err);

                    console.log('   ✅ Added fixed supply columns and economy_supply_log table');
                    callback(null);
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

module.exports = { up };
