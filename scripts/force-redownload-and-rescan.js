#!/usr/bin/env node
// Force redownload all logs for a configured server and rescan all logs.
(async function(){
  try{
    const path = require('path');
    const fs = require('fs');
    const { initializeDatabase, closeDatabase } = require('../db/abstraction');
    const logSync = require('../services/logSyncService');

    const targetServer = process.argv[2];
    if (!targetServer) {
      console.error('Usage: node scripts/force-redownload-and-rescan.js <platform-server-id>');
      process.exit(2);
    }

    const db = await initializeDatabase();
    try{
      // Find server row with nitrado token and matching platform_server_id
      const row = await db.get(`SELECT s.platform_server_id AS platform_server_id, g.id AS guild_id, gt.token_hash
        FROM servers s
        JOIN guilds g ON g.id = s.guild_id
        JOIN guild_tokens gt ON gt.guild_id = g.id AND gt.token_type='nitrado'
        WHERE s.platform_server_id = ?
        LIMIT 1`, [targetServer]);

      if (!row) {
        console.error('No server with nitrado token found for platform id', targetServer);
        process.exit(2);
      }

      const token = require('../utils/encryption').decryptToken(row.token_hash);
      console.log('Found server:', row.platform_server_id, 'guild_id:', row.guild_id);

      // pick a user from guild_roles to act as the caller
      const roleRow = await db.get('SELECT user_id FROM guild_roles WHERE guild_id = ? LIMIT 1', [row.guild_id]);
      const userId = roleRow && roleRow.user_id ? roleRow.user_id : null;
      if (!userId) {
        console.error('No guild role user found for guild', row.guild_id);
        process.exit(2);
      }

      // compute local download path
      const guildDiscordId = await logSync.resolveGuildDiscordId(db, userId, targetServer);
      if (!guildDiscordId) {
        console.error('Could not resolve guild discord id for server', targetServer);
        process.exit(2);
      }
      const serverPath = logSync.getGuildDownloadPath(guildDiscordId, targetServer);
      const configPath = path.join(serverPath, 'config');

      console.log('Server config path:', configPath);

      // Backup existing config directory if present
      if (fs.existsSync(configPath)) {
        const backupRoot = path.join(path.dirname(serverPath), '_backup_force_redownload');
        if (!fs.existsSync(backupRoot)) fs.mkdirSync(backupRoot, { recursive: true });
        const ts = Date.now();
        const backupPath = path.join(backupRoot, `server_${targetServer}_${ts}`);
        fs.renameSync(configPath, backupPath);
        console.log('Backed up existing config to', backupPath);
      }

      // Ensure fresh config dir
      if (!fs.existsSync(configPath)) fs.mkdirSync(configPath, { recursive: true });

      // Run concurrent full sync (this will re-download files)
      console.log('Starting performLogSyncConcurrent for server', targetServer);
      const res = await logSync.performLogSyncConcurrent(db, userId, token, [targetServer]);
      console.log('performLogSyncConcurrent result:', JSON.stringify(res, null, 2));

      // After download, run rescan using the existing script that parses all files
      console.log('Running parse-and-save-players.js to rescan and upsert players');
      const cp = require('child_process');
      const scriptPath = path.join(__dirname, 'parse-and-save-players.js');
      if (fs.existsSync(scriptPath)) {
        const out = cp.spawnSync('node', [scriptPath, targetServer, userId], { stdio: 'inherit' });
        if (out.error) console.error('Rescan script failed to start:', out.error.message);
        else console.log('Rescan script exited with status', out.status);
      } else {
        console.error('Rescan script not found at', scriptPath);
      }

    } finally {
      await closeDatabase();
    }
  }catch(err){
    console.error('Script failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
