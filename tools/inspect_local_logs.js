#!/usr/bin/env node
// Quick local log inspector for ADM/RPT files.
// Reads files under /bin/dayzxb/config and runs key parse logic (kill, cleanup, RPT/ADM ids)
// Prints counts and up to 5 samples per event type.

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'bin', 'dayzxb', 'config');

function toLines(content) { return Array.isArray(content) ? content : content.split('\n'); }

// --- parseRPTLog (extract platformUserId, dpnid, deviceId)
function parseRPTLog(content) {
  const lines = toLines(content);
  const connectedRegex = /Player (\S+) \(id=([A-F0-9]+)\) has connected\./;
  const loginRegex = /\[Login\]: Adding (?:prioritized )?player (\S+) \((\d+)\) to login queue/;
  const deviceRegex = /\[MAM\] :: \[NetworkServer::CheckMAMData\] :: device: ([A-Za-z0-9+/=_-]+) \| account: ([A-F0-9]+)/;

  const playerMap = new Map();
  const deviceMap = new Map();
  const dpnidMap = new Map();

  for (const line of lines) {
    const deviceMatch = line.match(deviceRegex);
    if (deviceMatch) deviceMap.set(deviceMatch[2], deviceMatch[1]);
    const loginMatch = line.match(loginRegex);
    if (loginMatch) dpnidMap.set(loginMatch[1], loginMatch[2]);
  }

  for (const line of lines) {
    const connMatch = line.match(connectedRegex);
    if (connMatch) {
      const playerName = connMatch[1];
      const platformUserId = connMatch[2];
      if (!playerMap.has(platformUserId)) {
        playerMap.set(platformUserId, {
          playerName,
          platformUserId,
          dpnid: dpnidMap.get(playerName) || null,
          deviceId: deviceMap.get(platformUserId) || null
        });
      }
    }
  }
  return Array.from(playerMap.values());
}

// --- parseADMLog (connection lines)
function parseADMLog(content) {
  const players = [];
  const lines = toLines(content);
  const connectionRegex = /Player "([^"]+)"\s*\(id=([A-Fa-f0-9]+|Unknown)\)\s*is connected/;
  for (const line of lines) {
    const match = line.match(connectionRegex);
    if (match && match[2] !== 'Unknown') {
      players.push({ playerName: match[1], platformUserId: match[2].toUpperCase(), dpnid: null, deviceId: null });
    }
  }
  return players;
}

// --- parseCleanupEvents (RPT cleanup)
function parseCleanupEvents(content, logDate) {
  const lines = toLines(content);
  const regex = /\d{1,2}:\d{2}:\d{2}[\d.]* <cleanup> Depleted:"([^"]+)" at \[(\d+),(\d+)\] damage=([\d.]+)/;
  const events = [];
  for (const line of lines) {
    const m = line.match(regex);
    if (!m) continue;
    events.push({ itemClass: m[1], posX: parseInt(m[2],10), posZ: parseInt(m[3],10), damage: parseFloat(m[4]), logDate });
  }
  return events;
}

// --- parseKillEvents (ADM)
function parseKillEvents(content, logDate) {
  const lines = toLines(content);
  const killRegex = /(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(DEAD\) \(id=([A-F0-9]+) pos=<([\d.]+), ([\d.]+), ([\d.]+)>\)(?:\[HP: [\d.]+\])? killed by Player "([^"]+)" \(id=([A-F0-9]+)(?: pos=<([\d.]+), ([\d.]+), ([\d.]+)>)?\) with (\S+)(?: from ([\d.]+) meters)?/;
  const events = [];
  for (const line of lines) {
    const match = line.match(killRegex);
    if (!match) continue;
    const [, time, victimName, victimId, victimX, victimY, victimZ, killerName, killerId, killerX, killerY, killerZ, weapon, distance] = match;
    let computedDistance = null;
    if (distance) computedDistance = parseFloat(distance);
    else if (killerX && killerY && killerZ && victimX && victimY && victimZ) {
      try { const kx = parseFloat(killerX), ky = parseFloat(killerY), kz = parseFloat(killerZ);
            const vx = parseFloat(victimX), vy = parseFloat(victimY), vz = parseFloat(victimZ);
            computedDistance = Math.sqrt((kx-vx)**2 + (ky-vy)**2 + (kz-vz)**2);
      } catch(e) { computedDistance = null; }
    }
    events.push({ timestamp: time, victimName, victimId, victimPos: `${victimX},${victimY},${victimZ}`, killerName, killerId, killerPos: killerX?`${killerX},${killerY},${killerZ}`:null, weapon, distance: computedDistance });
  }
  return events;
}

function findLogFiles(dir) {
  const adm = [], rpt = [];
  function walk(d) {
    let names = [];
    try { names = fs.readdirSync(d); } catch(e) { return; }
    for (const name of names) {
      const p = path.join(d, name);
      try {
        const s = fs.statSync(p);
        if (s.isDirectory()) walk(p);
        else if (/\.ADM$/i.test(name)) adm.push(p);
        else if (/\.RPT$/i.test(name)) rpt.push(p);
      } catch(e) { continue; }
    }
  }
  walk(dir);
  return { adm, rpt };
}

(async function main(){
  console.log('Inspecting logs in', LOG_DIR);
  const { adm, rpt } = findLogFiles(LOG_DIR);
  console.log(`Found ${adm.length} ADM files and ${rpt.length} RPT files\n`);

  const summary = {
    admFiles: adm.length,
    rptFiles: rpt.length,
    admPlayers: 0,
    rptPlayers: 0,
    killEvents: 0,
    killWithDistance: 0,
    cleanupEvents: 0
  };

  const samples = { admPlayers: [], rptPlayers: [], kills: [], cleanups: [] };

  for (const f of adm) {
    const content = fs.readFileSync(f,'utf8');
    const players = parseADMLog(content);
    summary.admPlayers += players.length;
    for (const p of players.slice(0,5)) samples.admPlayers.push({file: path.basename(f), ...p});

    const kills = parseKillEvents(content, null);
    summary.killEvents += kills.length;
    for (const k of kills) {
      if (k.distance !== null) summary.killWithDistance++;
      if (samples.kills.length < 5) samples.kills.push({file: path.basename(f), ...k});
    }
  }

  for (const f of rpt) {
    const content = fs.readFileSync(f,'utf8');
    const players = parseRPTLog(content);
    summary.rptPlayers += players.length;
    for (const p of players.slice(0,5)) samples.rptPlayers.push({file: path.basename(f), ...p});

    const cleanups = parseCleanupEvents(content, null);
    summary.cleanupEvents += cleanups.length;
    for (const c of cleanups.slice(0,5)) samples.cleanups.push({file: path.basename(f), ...c});
  }

  console.log('Summary:');
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nSamples:');
  console.log('ADM players sample:', samples.admPlayers);
  console.log('RPT players sample:', samples.rptPlayers);
  console.log('Kill events sample:', samples.kills);
  console.log('Cleanup events sample:', samples.cleanups);

})();
