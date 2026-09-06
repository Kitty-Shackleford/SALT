#!/usr/bin/env node
// One-off: parse all ADM/RPT files for a configured server and upsert identities/gamertags.
(async function(){
  try{
    const fs = require('fs');
    const path = require('path');
    const { initializeDatabase, closeDatabase } = require('../db/abstraction');
    const { resolveGuildDiscordId, getGuildDownloadPath } = require('../services/logSyncService');

    const serverPlatformId = process.argv[2];
    const userId = process.argv[3];
    if (!serverPlatformId || !userId) {
      console.error('Usage: node scripts/parse-and-save-players.js <platform-server-id> <user-id>');
      process.exit(2);
    }
    console.log('Target server platform id:', serverPlatformId);

    const db = await initializeDatabase();
    try{
      const guildDiscordId = await resolveGuildDiscordId(db, userId, serverPlatformId);
      console.log('Resolved guild discord id:', guildDiscordId);
      const serverPath = getGuildDownloadPath(guildDiscordId, serverPlatformId);
      const configPath = path.join(serverPath, 'config');
      console.log('Server config path:', configPath);
      if(!fs.existsSync(configPath)){
        console.error('Config path not found:', configPath);
        process.exit(2);
      }

      // gather all ADM/RPT files sorted by mtime (oldest first)
      const filesAll = fs.readdirSync(configPath).filter(f=>/\.(ADM|RPT)$/i.test(f)).map(f=>({ name: f, mtime: fs.statSync(path.join(configPath,f)).mtimeMs})).sort((a,b)=>a.mtime-b.mtime);
      console.log('Found', filesAll.length, 'log files in config');
      if(filesAll.length === 0){ process.exit(0); }

      function toLines(content){ return Array.isArray(content)?content:content.split('\n'); }

      function parseADMLog(content){
        const players = [];
        const lines = toLines(content);
        const connectionRegex = /Player \"([^\"]+)\"\s*\(id=([A-Fa-f0-9]+|Unknown)\)\s*is connected/;
        for(const line of lines){
          const m = line.match(connectionRegex);
          if(m && m[2] !== 'Unknown'){
            players.push({ playerName: m[1], platformUserId: m[2].toUpperCase(), dpnid: null, deviceId: null, source: 'ADM' });
          }
        }
        return players;
      }

      function parseRPTLog(content){
        const lines = toLines(content);
        const connectedRegex = /Player (\S+) \(id=([A-F0-9]+)\) has connected\./;
        const loginRegex = /\[Login\]: Adding (?:prioritized )?player (\S+) \((\d+)\) to login queue/;
        const deviceRegex = /\[MAM\] :: \[NetworkServer::CheckMAMData\] :: device: ([A-Za-z0-9+/=_-]+) \| account: ([A-F0-9]+)/;
        const playerMap = new Map();
        const deviceMap = new Map();
        const dpnidMap = new Map();
        for(const line of lines){
          const dm = line.match(deviceRegex);
          if(dm) deviceMap.set(dm[2], dm[1]);
          const lm = line.match(loginRegex);
          if(lm) dpnidMap.set(lm[1], lm[2]);
        }
        for(const line of lines){
          const cm = line.match(connectedRegex);
          if(cm){
            const playerName = cm[1];
            const platformUserId = cm[2];
            if(!playerMap.has(platformUserId)){
              playerMap.set(platformUserId, { playerName, platformUserId, dpnid: dpnidMap.get(playerName) || null, deviceId: deviceMap.get(platformUserId) || null, source: 'RPT' });
            }
          }
        }
        return Array.from(playerMap.values());
      }

      // accumulate players across all files, preferring later files' data for same platformUserId
      const accum = new Map();
      for(const fi of filesAll){
        const filePath = path.join(configPath, fi.name);
        let content = null;
        try{ content = fs.readFileSync(filePath, 'utf8'); } catch(e){ console.warn('Could not read', filePath, e.message); continue; }
        let parsed = [];
        if(/\.ADM$/i.test(fi.name)) parsed = parseADMLog(content);
        else if(/\.RPT$/i.test(fi.name)) parsed = parseRPTLog(content);
        for(const p of parsed){
          // always overwrite with later file (we iterate oldest->newest)
          accum.set(p.platformUserId, Object.assign({}, accum.get(p.platformUserId)||{}, p));
        }
      }

      const uniquePlayers = Array.from(accum.values());
      console.log('Parsed unique players across all files:', uniquePlayers.length);
      uniquePlayers.slice(0,200).forEach(p=> console.log(' ', p.platformUserId, p.playerName, p.dpnid || '', p.deviceId?'<device>':''));

      // Upsert into DB
      const serverRow = await db.get('SELECT id FROM servers WHERE platform_server_id = ?', [serverPlatformId]);
      if(!serverRow){ console.error('Server not found in DB for platform id', serverPlatformId); process.exit(2); }
      const dbServerId = serverRow.id;

      let createdIdentities = 0, insertedGamertags = 0, updatedGamertags = 0;

      for(const player of uniquePlayers){
        const platformUserId = player.platformUserId || player.dpnid;
        if(!platformUserId) continue;

        // find existing identity by platform_user_id or dpnid
        const existingIdentity = await db.get('SELECT id, player_id FROM player_identities WHERE platform_user_id = ? OR dpnid = ?', [platformUserId, player.dpnid || null]);
        let identityId;
        if(existingIdentity && existingIdentity.id){ identityId = existingIdentity.id; }
        else{
          const pr = await db.run('INSERT INTO players (primary_identity_id) VALUES (NULL) RETURNING id', []);
          const playerId = pr.lastID;
          const ir = await db.run('INSERT INTO player_identities (player_id, platform, platform_user_id, device_id, dpnid) VALUES (?, ?, ?, ?, ?) RETURNING id', [playerId, 'unknown', platformUserId, player.deviceId || null, player.dpnid || null]);
          identityId = ir.lastID;
          await db.run('UPDATE players SET primary_identity_id = ? WHERE id = ?', [identityId, playerId]);
          createdIdentities++;
        }

        // upsert gamertag
        const existingGamertag = await db.get('SELECT id FROM player_gamertags WHERE identity_id = ? AND server_id = ?', [identityId, dbServerId]);
        if(existingGamertag && existingGamertag.id){
          await db.run('UPDATE player_gamertags SET gamertag = ?, last_seen = CURRENT_TIMESTAMP, is_current_gamertag = 1 WHERE id = ?', [player.playerName, existingGamertag.id]);
          updatedGamertags++;
        } else {
          await db.run('INSERT INTO player_gamertags (identity_id, server_id, gamertag, is_current_gamertag, last_seen) VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)', [identityId, dbServerId, player.playerName]);
          insertedGamertags++;
        }
      }

      console.log('Summary: createdIdentities=', createdIdentities, 'insertedGamertags=', insertedGamertags, 'updatedGamertags=', updatedGamertags);


    } finally {
      await closeDatabase();
    }
  }catch(err){
    console.error('Script failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
