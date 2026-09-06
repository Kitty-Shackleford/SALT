/**
 * Migration 005: Add Analytics Tables
 * Adds damage_events and territory_events tables to existing databases
 */

async function migrate(db) {
  console.log('\n🔄 Running Migration 005: Add Analytics Tables...\n');

  try {
    // Check if tables already exist
    const hasDamageEvents = await db.tableExists('damage_events');
    const hasTerritoryEvents = await db.tableExists('territory_events');

    if (hasDamageEvents && hasTerritoryEvents) {
      console.log('✅ Analytics tables already exist - skipping\n');
      return { success: true, skipped: true };
    }

    // Add damage_events table
    if (!hasDamageEvents) {
      await db.run(`CREATE TABLE IF NOT EXISTS damage_events (
        id INTEGER PRIMARY KEY ${db.type === 'postgres' ? 'GENERATED ALWAYS AS IDENTITY' : 'AUTOINCREMENT'},
        serverId INTEGER NOT NULL,
        victimIdentityId INTEGER NOT NULL,
        victimGamertag TEXT NOT NULL,
        victimPosition TEXT,
        victimPosX REAL,
        victimPosY REAL,
        victimPosZ REAL,
        attackerIdentityId INTEGER,
        attackerGamertag TEXT,
        attackerType TEXT NOT NULL,
        weapon TEXT,
        bodyPart TEXT,
        bodyPartId INTEGER,
        damage REAL NOT NULL,
        hpBefore REAL,
        hpAfter REAL,
        timestamp ${db.type === 'postgres' ? 'TIMESTAMP' : 'DATETIME'} NOT NULL,
        logSource TEXT DEFAULT 'adm_log',
        FOREIGN KEY (serverId) REFERENCES servers(id) ON DELETE CASCADE,
        FOREIGN KEY (victimIdentityId) REFERENCES player_identities(id),
        FOREIGN KEY (attackerIdentityId) REFERENCES player_identities(id)
      )`);

      await db.run('CREATE INDEX IF NOT EXISTS idx_damage_events_server ON damage_events(serverId)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_damage_events_victim ON damage_events(victimIdentityId)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_damage_events_timestamp ON damage_events(timestamp DESC)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_damage_events_attacker_type ON damage_events(attackerType)');

      console.log('✅ Created damage_events table');
    }

    // Add territory_events table
    if (!hasTerritoryEvents) {
      await db.run(`CREATE TABLE IF NOT EXISTS territory_events (
        id INTEGER PRIMARY KEY ${db.type === 'postgres' ? 'GENERATED ALWAYS AS IDENTITY' : 'AUTOINCREMENT'},
        serverId INTEGER NOT NULL,
        identityId INTEGER,
        playerGamertag TEXT,
        eventType TEXT NOT NULL,
        structureType TEXT NOT NULL,
        position TEXT,
        posX REAL,
        posY REAL,
        posZ REAL,
        timestamp ${db.type === 'postgres' ? 'TIMESTAMP' : 'DATETIME'} NOT NULL,
        logSource TEXT DEFAULT 'adm_log',
        FOREIGN KEY (serverId) REFERENCES servers(id) ON DELETE CASCADE,
        FOREIGN KEY (identityId) REFERENCES player_identities(id)
      )`);

      await db.run('CREATE INDEX IF NOT EXISTS idx_territory_events_server ON territory_events(serverId)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_territory_events_identity ON territory_events(identityId)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_territory_events_timestamp ON territory_events(timestamp DESC)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_territory_events_type ON territory_events(eventType)');
      await db.run('CREATE INDEX IF NOT EXISTS idx_territory_events_structure ON territory_events(structureType)');

      console.log('✅ Created territory_events table');
    }

    console.log('\n✅ Migration 005 completed successfully!\n');
    return { success: true, skipped: false };

  } catch (error) {
    console.error('❌ Migration 005 failed:', error);
    return { success: false, error };
  }
}

module.exports = { migrate };
