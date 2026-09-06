#!/usr/bin/env node
// Integration test: run performLogSync once for a server that has a stored Nitrado token
// Usage: node scripts/run-integration-logsync.js

(async function(){
  try {
    const { initializeDatabase, closeDatabase } = require('../db/abstraction');
    const { decryptToken } = require('../utils/encryption');
    const logSync = require('../services/logSyncService');

    const db = await initializeDatabase();
    try {
      const rows = await db.query(`SELECT s.platform_server_id AS platform_server_id, g.id AS guild_id, gt.token_hash
        FROM servers s
        JOIN guilds g ON g.id = s.guild_id
        JOIN guild_tokens gt ON gt.guild_id = g.id AND gt.token_type='nitrado'
        LIMIT 1`);

      if (!rows || rows.length === 0) {
        console.error('No servers with nitrado tokens found');
        process.exit(2);
      }

      const row = rows[0];
      console.log('Selected server:', row.platform_server_id, 'guild_id:', row.guild_id);

      const roleRows = await db.query('SELECT user_id FROM guild_roles WHERE guild_id = $1 LIMIT 1', [row.guild_id]);
      const userId = roleRows && roleRows[0] && roleRows[0].user_id ? roleRows[0].user_id : null;
      if (!userId) {
        console.error('No guild role user found for guild', row.guild_id);
        process.exit(2);
      }

      const token = decryptToken(row.token_hash);
      console.log('Decrypted token: [REDACTED], length:', token ? token.length : 0);

      console.log('Running performLogSync for server', row.platform_server_id);
      const res = await logSync.performLogSync(db, userId, token, [row.platform_server_id]);
      console.log('performLogSync result:', JSON.stringify(res, null, 2));

    } finally {
      await closeDatabase();
    }
  } catch (err) {
    console.error('Integration test failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
