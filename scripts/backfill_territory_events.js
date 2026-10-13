#!/usr/bin/env node
// Backfill territory_events.log_source and (optionally) structure_type using
// the audit results written to logs/unknown_audit.json by scripts/unknown_audit.js

const fs = require('fs');
const path = require('path');
const Postgres = require('../db/abstraction/postgres');

function extractClassNameFromLine(line) {
  if (!line) return null;
  // look for <ClassName> or < SomeClass > variants
  const m = line.match(/<\s*([A-Za-z0-9_:\-\.]+)\s*>/);
  if (m) return m[1];
  // fallback: look for words immediately after 'placed' or 'Built' that contain letters
  const placed = line.match(/(?:placed|Built|Dismantled|Mounted|Unmounted)\s+([^<\n\r]+)/i);
  if (placed && placed[1]) {
    // strip trailing punctuation
    const s = placed[1].trim().split(/[\s,\(\[]./)[0];
    // prefer CamelCase-like tokens
    const token = s.match(/[A-Za-z][A-Za-z0-9_]+/);
    if (token) return token[0];
  }
  return null;
}

(async ()=>{
  const auditPath = path.join('logs','unknown_audit.json');
  if (!fs.existsSync(auditPath)) {
    console.error('Audit file not found:', auditPath);
    process.exit(2);
  }

  const data = JSON.parse(fs.readFileSync(auditPath,'utf8'));
  const db = new Postgres();
  try {
    await db.connect();
    let updated = 0;
    for (const entry of data) {
      if (!entry.match) continue;
      const evtId = entry.eventId;
      const file = entry.match.file;
      const lineNumber = entry.match.lineNumber;
      const text = entry.match.text;
      const logSourceVal = `${file}:${lineNumber}`;
      const classGuess = extractClassNameFromLine(text);

      try {
        if (classGuess) {
          const res = await db.run(
            `UPDATE territory_events SET log_source = ?, structure_type = ? WHERE id = ? AND structure_type = ?`,
            [logSourceVal, classGuess, evtId, 'unknown']
          );
          if (res && res.changes > 0) updated += res.changes;
        } else {
          const res = await db.run(
            `UPDATE territory_events SET log_source = ? WHERE id = ? AND structure_type = ?`,
            [logSourceVal, evtId, 'unknown']
          );
          if (res && res.changes > 0) updated += res.changes;
        }
      } catch (err) {
        console.error('DB update failed for event', evtId, err && err.message || err);
      }
    }

    console.log('Backfill complete. Rows updated:', updated);
  } catch (err) {
    console.error('ERROR', err && err.stack || err);
    process.exit(1);
  } finally {
    try { await db.close(); } catch(_){}
  }
})();
