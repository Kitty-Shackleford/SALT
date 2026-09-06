#!/usr/bin/env node
// Inspect parsed players across all ADM/RPT files for a configured server.
(async function(){
  try{
    const fs = require('fs');
    const path = require('path');
    const { initializeDatabase, closeDatabase } = require('../db/abstraction');
    const { resolveGuildDiscordId, getGuildDownloadPath } = require('../services/logSyncService');

    const serverPlatformId = process.argv[2];
    const userId = process.argv[3];
    if (!serverPlatformId || !userId) {
      console.error('Usage: node scripts/inspect-parsed-players.js <platform-server-id> <user-id>');
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

      const filesAll = fs.readdirSync(configPath).filter(f=>/\.(ADM|RPT)$/i.test(f)).map(f=>({ name: f, mtime: fs.statSync(path.join(configPath,f)).mtimeMs})).sort((a,b)=>a.mtime-b.mtime);
      console.log('Found', filesAll.length, 'log files in config');

      function toLines(content){ return Array.isArray(content)?content:content.split('\n'); }

      function parseADMLog(content){
        const players = [];
        const lines = toLines(content);
        const connectionRegex = /Player \"([^\"]+)\"\s*\(id=([A-Fa-f0-9]+|Unknown)\)\s*is connected/;
        const altConn = /Player \"([^\"]+)\"\s*\(id=([A-Fa-f0-9]+|Unknown)\)\s*has connected/;
        for(const line of lines){
          const m = line.match(connectionRegex) || line.match(altConn);
          if(m && m[2] && m[2] !== 'Unknown'){
            players.push({ playerName: m[1], platformUserId: m[2].toUpperCase(), source: 'ADM' });
          }
        }
        return players;
      }

      function parseRPTLog(content){
        const lines = toLines(content);
        const playerMap = new Map();
        const deviceMap = new Map();
        const dpnidMap = new Map();

        const deviceRegex = /\[MAM\] .* device: ([A-Za-z0-9+/=_-]+) \| account: ([A-F0-9]+)/;
        const setClientRegex = /SetClientState .*\bdpid=(\d+)\b.*\bname=([^\s]+)/;
        const stateMachineRegex = /Player ([^\s]+) \(dpnid (\d+) uid ([A-F0-9]+)\)/; // variation
        const loginRegex = /Login: Player ([^\s]+) \((\d+)\) preloading/;
        const addedRegex = /server: Player dpid=(\d+) added/;
        const removedRegex = /Player info removed - name ([^,]+), id (\d+)/;

        for(const line of lines){
          let m = line.match(deviceRegex);
          if(m) deviceMap.set(m[2], m[1]);
          m = line.match(setClientRegex);
          if(m) {
            const dpid = m[1];
            const name = m[2];
            playerMap.set(dpid, { playerName: name, platformUserId: dpid, dpnid: dpid, deviceId: deviceMap.get(dpid) || null, source: 'RPT:SetClientState' });
          }
          m = line.match(loginRegex);
          if(m) {
            const name = m[1];
            const id = m[2];
            playerMap.set(id, { playerName: name, platformUserId: id, dpnid: id, deviceId: deviceMap.get(id) || null, source: 'RPT:Login' });
          }
          m = line.match(addedRegex);
          if(m) {
            const id = m[1];
            if(!playerMap.has(id)) playerMap.set(id, { playerName: null, platformUserId: id, dpnid: id, deviceId: deviceMap.get(id)||null, source: 'RPT:Added' });
          }
          m = line.match(removedRegex);
          if(m) {
            const name = m[1];
            const id = m[2];
            playerMap.set(id, { playerName: name, platformUserId: id, dpnid: id, deviceId: deviceMap.get(id)||null, source: 'RPT:Removed' });
          }
          m = line.match(stateMachineRegex);
          if(m) {
            const name = m[1];
            const dpid = m[2];
            playerMap.set(dpid, { playerName: name, platformUserId: dpid, dpnid: dpid, deviceId: deviceMap.get(dpid)||null, source: 'RPT:StateMachine' });
          }
        }

        return Array.from(playerMap.values());
      }

      const accum = new Map();
      for(const fi of filesAll){
        const filePath = path.join(configPath, fi.name);
        let content = null;
        try{ content = fs.readFileSync(filePath, 'utf8'); } catch(e){ console.warn('Could not read', filePath, e.message); continue; }
        let parsed = [];
        if(/\.ADM$/i.test(fi.name)) parsed = parseADMLog(content);
        else if(/\.RPT$/i.test(fi.name)) parsed = parseRPTLog(content);
        for(const p of parsed){
          const key = p.platformUserId || p.dpnid || p.playerName;
          if(!key) continue;
          accum.set(key, Object.assign({}, accum.get(key)||{}, p));
        }
      }

      const uniquePlayers = Array.from(accum.values());
      console.log('Parsed unique players across all files:', uniquePlayers.length);
      uniquePlayers.forEach(p=> console.log(JSON.stringify(p)));

    } finally {
      await closeDatabase();
    }
  }catch(err){
    console.error('Script failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
