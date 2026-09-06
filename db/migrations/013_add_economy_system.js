/**
 * Migration 013: Add Economy System Tables
 *
 * Creates the foundational database schema for the modular, guild-configurable
 * economy system: player wallets, bank accounts, transaction audit trail,
 * and per-guild configuration.
 */

function up(db, callback) {
  console.log('🔄 Migration 013: Add economy system tables');

  db.serialize(() => {
    // Create player_wallets table
    db.run(`CREATE TABLE IF NOT EXISTS player_wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identityId INTEGER NOT NULL UNIQUE,
      cashOnHand REAL NOT NULL DEFAULT 0,
      lastUpdated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (identityId) REFERENCES player_identities(id) ON DELETE CASCADE
    )`, (err) => {
      if (err) return callback(err);

      db.run(`CREATE INDEX IF NOT EXISTS idx_player_wallets_identity ON player_wallets(identityId)`, (err) => {
        if (err) return callback(err);

        // Create player_bank_accounts table
        db.run(`CREATE TABLE IF NOT EXISTS player_bank_accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          identityId INTEGER NOT NULL UNIQUE,
          balance REAL NOT NULL DEFAULT 0,
          lastTransaction DATETIME,
          FOREIGN KEY (identityId) REFERENCES player_identities(id) ON DELETE CASCADE
        )`, (err) => {
          if (err) return callback(err);

          db.run(`CREATE INDEX IF NOT EXISTS idx_player_bank_accounts_identity ON player_bank_accounts(identityId)`, (err) => {
            if (err) return callback(err);

            // Create economy_transactions table
            db.run(`CREATE TABLE IF NOT EXISTS economy_transactions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              identityId INTEGER NOT NULL,
              transactionType TEXT NOT NULL,
              amount REAL NOT NULL,
              balanceAfter REAL NOT NULL,
              accountType TEXT NOT NULL,
              source TEXT,
              sourceIdentityId INTEGER,
              description TEXT,
              serverId INTEGER,
              metadata TEXT,
              timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (identityId) REFERENCES player_identities(id) ON DELETE CASCADE,
              FOREIGN KEY (sourceIdentityId) REFERENCES player_identities(id) ON DELETE SET NULL,
              FOREIGN KEY (serverId) REFERENCES servers(id) ON DELETE SET NULL
            )`, (err) => {
              if (err) return callback(err);

              db.run(`CREATE INDEX IF NOT EXISTS idx_economy_transactions_identity ON economy_transactions(identityId)`, (err) => {
                if (err) return callback(err);

                db.run(`CREATE INDEX IF NOT EXISTS idx_economy_transactions_timestamp ON economy_transactions(timestamp DESC)`, (err) => {
                  if (err) return callback(err);

                  db.run(`CREATE INDEX IF NOT EXISTS idx_economy_transactions_type ON economy_transactions(transactionType)`, (err) => {
                    if (err) return callback(err);

                    // Create guild_economy_config table
                    db.run(`CREATE TABLE IF NOT EXISTS guild_economy_config (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      guildId INTEGER NOT NULL UNIQUE,
                      enabled BOOLEAN NOT NULL DEFAULT 0,
                      currencyName TEXT DEFAULT 'Dollar',
                      currencySymbol TEXT DEFAULT '$',
                      startingCash REAL DEFAULT 1000,
                      startingBank REAL DEFAULT 0,
                      monetarySystem TEXT DEFAULT 'fiat',
                      totalMoneySupply REAL DEFAULT NULL,
                      killRewardsEnabled BOOLEAN DEFAULT 1,
                      playtimeRewardsEnabled BOOLEAN DEFAULT 1,
                      achievementRewardsEnabled BOOLEAN DEFAULT 0,
                      territoryRewardsEnabled BOOLEAN DEFAULT 0,
                      killReward REAL DEFAULT 100,
                      playtimeRewardPerHour REAL DEFAULT 10,
                      achievementBonusMultiplier REAL DEFAULT 1.0,
                      territoryRewardPerHour REAL DEFAULT 5,
                      deathPenaltyEnabled BOOLEAN DEFAULT 0,
                      deathPenaltyType TEXT DEFAULT 'percentage',
                      deathPenaltyAmount REAL DEFAULT 10,
                      deathPenaltyMaxLoss REAL DEFAULT NULL,
                      deathDropsMoneyOnGround BOOLEAN DEFAULT 0,
                      transferEnabled BOOLEAN DEFAULT 1,
                      transferFeePercentage REAL DEFAULT 0,
                      transferRequireBothOnline BOOLEAN DEFAULT 0,
                      transferOfflineFeePercentage REAL DEFAULT 5,
                      transferMinAmount REAL DEFAULT 1,
                      transferMaxAmount REAL DEFAULT NULL,
                      bankEnabled BOOLEAN DEFAULT 1,
                      maxBankBalance REAL DEFAULT NULL,
                      bankDepositFeePercentage REAL DEFAULT 0,
                      bankWithdrawFeePercentage REAL DEFAULT 0,
                      bankDailyFeeEnabled BOOLEAN DEFAULT 0,
                      bankDailyFeeType TEXT DEFAULT 'percentage',
                      bankDailyFeeAmount REAL DEFAULT 0.1,
                      inactivityTaxEnabled BOOLEAN DEFAULT 0,
                      inactivityThresholdDays INTEGER DEFAULT 30,
                      inactivityTaxPercentage REAL DEFAULT 5,
                      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                      updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                      FOREIGN KEY (guildId) REFERENCES guilds(id) ON DELETE CASCADE
                    )`, (err) => {
                      if (err) return callback(err);

                      db.run(`CREATE INDEX IF NOT EXISTS idx_guild_economy_config_guild ON guild_economy_config(guildId)`, (err) => {
                        if (err) return callback(err);

                        db.run(`CREATE INDEX IF NOT EXISTS idx_guild_economy_config_enabled ON guild_economy_config(enabled)`, (err) => {
                          if (err) return callback(err);

                          console.log('   ✅ Created economy system tables');
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
      });
    });
  });
}

module.exports = { up };
