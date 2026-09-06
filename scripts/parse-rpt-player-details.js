const fs = require('fs');
const rptPath = process.argv[2];
const targetPlayerId = process.argv[3] || null;
const targetPlayerName = process.argv[4] || null;
if (!rptPath) {
  console.error('Usage: node scripts/parse-rpt-player-details.js <rpt-path> [player-id] [player-name]');
  process.exit(2);
}
if (!fs.existsSync(rptPath)) {
  console.error('RPT not found:', rptPath);
  process.exit(2);
}
const content = fs.readFileSync(rptPath,'utf8');
const lines = content.split(/\r?\n/);

const setClientStateRegex = /SetClientState[^\n]*dpid=(\d+)[^\n]*name=(?:"([^"]+)"|([^\s,>]+))/i;
const stateMachineRegex = /\[StateMachine\]: Player\s+"?([^\(]+?)"?\s*\(dpnid\s*(\d+)(?:[^A-F0-9]*uid\s*([A-F0-9]+))?/i;
const networkLoginRegex = /Login:\s*Player\s+"?([^\(]+?)"?\s*\((\d+)\)\s*preloading/i;
const playerDpnidRegex = /player\s+([A-Fa-f0-9]{8,})\s*\(dpnid\s*=\s*(\d+)\)/i;
const genericParenRegex = /Player\s+"?([^\(]+?)"?\s*\((\d{5,12})\)/i;
const identityRemovedRegex = /Identity removed - name\s*"?([^\",]+?)"?,?\s*id\s*=?\s*(\d+)/i;
const playerKickedRegex = /Player\s+"?([^\(]+?)"?\s*\((\d+)\)\s*kicked from server/i;

const playerMap = new Map();
const dpnidMap = new Map();
const deviceMap = new Map();

// first pass dpnid lines
for (const line of lines) {
  const m = line.match(playerDpnidRegex);
  if (m) dpnidMap.set(m[1].toUpperCase(), m[2]);
}

for (let i=0;i<lines.length;i++){
  const line = lines[i];
  let m;
  m = line.match(setClientStateRegex);
  if (m) {
    const pid = String(m[1]).trim();
    const name = (m[2] || m[3] || '').trim() || null;
    const existing = playerMap.get(pid) || {};
    if (!existing.playerName && name) existing.playerName = name;
    existing.platformUserId = pid;
    existing.dpnid = existing.dpnid || (name ? dpnidMap.get(name) : null) || null;
    existing.source = existing.source || 'SetClientState';
    playerMap.set(pid, existing);
    continue;
  }
  m = line.match(stateMachineRegex);
  if (m) {
    const name = (m[1] || '').trim() || null;
    const pid = m[2] ? String(m[2]).trim() : null;
    const uid = m[3] || null;
    if (pid) {
      const existing = playerMap.get(pid) || {};
      if (!existing.playerName && name) existing.playerName = name;
      existing.platformUserId = pid;
      if (uid) existing.uid = uid;
      existing.source = existing.source || 'StateMachine';
      playerMap.set(pid, existing);
    }
    continue;
  }
  m = line.match(networkLoginRegex);
  if (m) {
    const name = (m[1] || '').trim() || null;
    const pid = m[2] ? String(m[2]).trim() : null;
    if (pid) {
      const existing = playerMap.get(pid) || {};
      if (!existing.playerName && name) existing.playerName = name;
      existing.platformUserId = pid;
      existing.source = existing.source || 'Login';
      playerMap.set(pid, existing);
    }
    continue;
  }
  m = line.match(genericParenRegex);
  if (m) {
    const name = (m[1] || '').trim() || null;
    const pid = m[2] ? String(m[2]).trim() : null;
    if (pid && !playerMap.has(pid)) {
      playerMap.set(pid, { playerName: name, platformUserId: pid, dpnid: dpnidMap.get(name) || null, source: 'Generic' });
    }
    continue;
  }
  m = line.match(playerKickedRegex) || line.match(identityRemovedRegex);
  if (m) {
    const name = (m[1] || '').trim() || null;
    const pid = m[2] ? String(m[2]).trim() : null;
    if (pid && !playerMap.has(pid)) playerMap.set(pid, { playerName: name, platformUserId: pid, source: 'Removed' });
    continue;
  }
}

const results = Array.from(playerMap.values()).filter(p=>p && p.platformUserId);
console.log('total_parsed=', results.length);
if (targetPlayerId) {
  console.log('byPlayerId=', JSON.stringify(results.find(r => r.platformUserId === targetPlayerId), null, 2));
}
if (targetPlayerName) {
  const normalizedName = targetPlayerName.toLowerCase();
  console.log('byPlayerName=', JSON.stringify(results.filter(r => r.playerName?.toLowerCase() === normalizedName), null, 2));
}
console.log('---FULL_RESULTS---');
console.log(JSON.stringify(results, null, 2));
