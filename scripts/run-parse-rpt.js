const fs = require('fs');
const lp = require('../routes/logParser');
const rptPath = process.argv[2];
const targetPlayerId = process.argv[3] || null;
const targetPlayerName = process.argv[4]?.toLowerCase() || null;
if (!rptPath) {
  console.error('Usage: node scripts/run-parse-rpt.js <rpt-path> [player-id] [player-name]');
  process.exit(2);
}
try {
  const content = fs.readFileSync(rptPath, 'utf8');
  const lines = content.split(/\r?\n/);
  let parsed = [];
  try { parsed = lp.parseRPTLog(lines); } catch (err) {
    try { parsed = lp.parseRPTLog(content); } catch (err2) { console.error('PARSE_ERROR', err.stack || err); process.exit(2); }
  }
  console.log('PARSED_COUNT:', parsed.length);
  const filtered = parsed.filter(p =>
    (targetPlayerId && (p.platformUserId === targetPlayerId || p.identityHex === targetPlayerId || p.uid === targetPlayerId)) ||
    (targetPlayerName && p.playerName?.toLowerCase() === targetPlayerName)
  );
  console.log('PARSED_FILTERED_COUNT:', filtered.length);
  console.log(JSON.stringify(filtered, null, 2));
  console.log('PARSED_FIRST_20:', JSON.stringify(parsed.slice(0,20), null, 2));
} catch (e) {
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(3);
}
