const fs = require('fs');
const path = process.argv[2];
const targetPlayerId = process.argv[3] || null;
if (!path) {
  console.error('Usage: node scripts/test-rpt-regexes.js <rpt-path> [player-id]');
  process.exit(2);
}
const content = fs.readFileSync(path,'utf8');
const lines = content.split(/\r?\n/);
const setClientStateRegex = /SetClientState[^\n]*dpid=(\d+)[^\n]*name=(?:"([^"]+)"|([^\s>]+))/i;
const stateMachineRegex = /\[StateMachine\]: Player\s+"?([^\(]+?)"?\s*\(dpnid\s*(\d+)/i;
const networkLoginRegex = /Login:\s*Player\s+"?([^\(]+?)"?\s*\((\d+)\)\s*preloading/i;
const serverPlayerRegex = /server:\s*Player\s+dpid=(\d+)\b/i;
const worldStateIdRegex = /sending World state to remote player[\s\S]*id=(\d+)/i;
const playerKickedRegex = /Player\s+"?([^\(]+?)"?\s*\((\d+)\)\s*kicked from server/i;
const identityRemovedRegex = /Identity removed - name\s*"?([^\",]+?)"?,?\s*id\s*=?\s*(\d+)/i;

console.log('Testing file:', path);
for (let i=0;i<lines.length;i++){
  const L=lines[i];
  if(targetPlayerId && L.includes(targetPlayerId)) console.log('TARGET',i+1, L);
  let m;
  m = L.match(setClientStateRegex); if(m) console.log('SET',i+1,m.slice(1));
  m = L.match(stateMachineRegex); if(m) console.log('STATE',i+1,m.slice(1));
  m = L.match(networkLoginRegex); if(m) console.log('LOGIN',i+1,m.slice(1));
  m = L.match(serverPlayerRegex); if(m) console.log('SRVPLAYER',i+1,m.slice(1));
  m = L.match(worldStateIdRegex); if(m) console.log('WORLD',i+1,m.slice(1));
  m = L.match(playerKickedRegex); if(m) console.log('KICK',i+1,m.slice(1));
  m = L.match(identityRemovedRegex); if(m) console.log('IDENTREMOVED',i+1,m.slice(1));
}
console.log('Done');
