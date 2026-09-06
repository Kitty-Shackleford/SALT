#!/usr/bin/env node
// Run scanLogsForServer for a server and print results.
// Usage: node scripts/run-scan-parse.js <serverId> [userId]

const serverId = process.argv[2];
const userId = process.argv[3] || '1';
if (!serverId) {
  console.error('Usage: node scripts/run-scan-parse.js <serverId> [userId]');
  process.exit(2);
}

(async function(){
  try {
    const { initializeDatabase, closeDatabase } = require('../db/abstraction');
    const { decryptToken } = require('../utils/encryption');
    const parser = require('../routes/logParser');
    const db = await initializeDatabase();

    // find a nitrado token for the guild that owns this server
    const row = await db.get(
      `SELECT gt.token_hash, g.discord_guild_id FROM guild_tokens gt JOIN guilds g ON g.id = gt.guild_id JOIN servers s ON s.guild_id = g.id WHERE s.platform_server_id = ? AND gt.token_type = 'nitrado' LIMIT 1`,
      [String(serverId)]
    );

    let token = null;
    if (row && row.token_hash) {
      token = decryptToken(row.token_hash);
      console.log('Found token for guild', row.discord_guild_id, 'len:', token ? token.length : null);
    } else {
      console.log('No token found for server', serverId);
    }

    console.log('Calling scanLogsForServer...');
    const result = await parser.scanLogsForServer(db, userId, serverId, token);
    console.log('scanLogsForServer result:\n', JSON.stringify(result, null, 2));

    await closeDatabase();
    process.exit(0);
  } catch (err) {
    console.error('Error running scan-parse:', err && err.stack || err);
    process.exit(1);
  }
})();
