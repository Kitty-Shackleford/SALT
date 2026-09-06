const { initializeDatabase } = require('../db/abstraction');

async function addMissingConstraints() {
  console.log('🔧 Adding missing database constraints...\n');

  try {
    const db = await initializeDatabase();

    // Add unique constraint to guild_tokens
    console.log('📝 Adding UNIQUE constraint to guild_tokens...');
    try {
      await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_guild_tokens_unique ON guild_tokens(guildId, tokenType)`);
      console.log('   ✅ guild_tokens constraint added');
    } catch (err) {
      if (err.message.includes('already exists')) {
        console.log('   ℹ️  Constraint already exists');
      } else {
        throw err;
      }
    }

    // Add unique constraint to servers
    console.log('📝 Adding UNIQUE constraint to servers...');
    try {
      await db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_unique ON servers(guildId, platformServerId)`);
      console.log('   ✅ servers constraint added');
    } catch (err) {
      if (err.message.includes('already exists')) {
        console.log('   ℹ️  Constraint already exists');
      } else {
        throw err;
      }
    }

    console.log('\n✅ All constraints added successfully!\n');
    process.exit(0);

  } catch (error) {
    console.error('❌ Error adding constraints:', error);
    process.exit(1);
  }
}

addMissingConstraints();
