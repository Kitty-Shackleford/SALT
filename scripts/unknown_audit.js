#!/usr/bin/env node
// Improved audit: fuzzy-match territory_events with structure_type='unknown' to ADM lines
// Heuristics:
// - Scan last N ADM files in downloads for the server
// - Match action verbs: placed, built, dismantled, mounted, unmounted, folded, "has raised"
// - Prefer exact HH:MM:SS match, else fuzzy ±30s window
// - Prefer matches with nearby world position (meters)
// - Output best match (file, lineNumber, text, matchType, deltaSeconds, distanceMeters)

const fs = require('fs');
const path = require('path');
const Postgres = require('../db/abstraction/postgres');

const VERBS = ['placed', 'built', 'dismantled', 'mounted', 'unmounted', 'folded', 'has raised'];
const MAX_FILES = 200; // lookback ADM files
const TIME_FUZZ_SECONDS = 30; // expanded fuzzy window

function hhmmssFromIso(iso) {
  try { return new Date(iso).toISOString().substr(11, 8); } catch (e) { return null; }
}

function timeToSeconds(hhmmss) {
  const p = hhmmss.split(':').map(n => parseInt(n,10));
  if (p.length !== 3) return null;
  return p[0]*3600 + p[1]*60 + p[2];
}

function parsePositionFromLine(line) {
  if (!line) return null;
  const m = line.match(/([-+]?\d+\.\d+)\s*,\s*([-+]?\d+\.\d+)\s*,\s*([-+]?\d+\.\d+)/);
  if (m) return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
  const m2 = line.match(/\b([-+]?\d+\.\d+)\s+([-+]?\d+\.\d+)\s+([-+]?\d+\.\d+)\b/);
  if (m2) return [parseFloat(m2[1]), parseFloat(m2[2]), parseFloat(m2[3])];
  return null;
}

function distanceMeters(p1, p2) {
  if (!p1 || !p2) return null;
  const dx = p1[0]-p2[0];
  const dy = p1[1]-p2[1];
  const dz = (p1[2]||0)-(p2[2]||0);
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

(async ()=>{
  const db = new Postgres();
  try {
    await db.connect();

    const rows = await db.query(
      `SELECT id, server_id, position, timestamp, log_source FROM territory_events WHERE structure_type=$1 ORDER BY id DESC LIMIT 500`,
      ['unknown']
    );

    const downloadsBaseRoot = '/home/salt/dayz-dashboard/downloads';
    const results = [];

    for (const r of rows) {
      const serverGlob = `server_${r.server_id}`;
      const owners = fs.readdirSync(downloadsBaseRoot).filter(d => fs.existsSync(path.join(downloadsBaseRoot, d)));
      let confDir = null;
      for (const owner of owners) {
        const candidate = path.join(downloadsBaseRoot, owner, serverGlob, 'config');
        if (fs.existsSync(candidate)) { confDir = candidate; break; }
      }

      const targetHH = hhmmssFromIso(r.timestamp);
      const targetSec = targetHH ? timeToSeconds(targetHH) : null;

      // parse event position if available (string like "x,y,z")
      let eventPos = null;
      if (r.position) {
        const p = r.position.toString().split(',').map(s => parseFloat(s));
        if (p.length >= 3 && !Number.isNaN(p[0])) eventPos = [p[0], p[1], p[2]];
      }

      let best = null;
      if (confDir) {
        const files = fs.readdirSync(confDir).filter(f => f.toUpperCase().endsWith('.ADM')).sort().reverse().slice(0, MAX_FILES);
        for (const fn of files) {
          const full = path.join(confDir, fn);
          const data = fs.readFileSync(full, 'utf8');
          const lines = data.split('\n');

          for (let i=0;i<lines.length;i++) {
            const line = lines[i];
            let verbFound = false;
            for (const v of VERBS) { if (line.toLowerCase().indexOf(v) !== -1) { verbFound = true; break; } }
            if (!verbFound) continue;

            const timeMatch = line.match(/^(\d{2}:\d{2}:\d{2})\s*\|/);
            let lineSec = null;
            if (timeMatch) lineSec = timeToSeconds(timeMatch[1]);

            let matchType = null;
            let delta = null;
            if (targetSec !== null && lineSec !== null) {
              delta = Math.abs(targetSec - lineSec);
              if (delta === 0) matchType = 'exact';
              else if (delta <= TIME_FUZZ_SECONDS) matchType = 'fuzzy';
              else matchType = 'distant';
            } else {
              matchType = 'verb-only';
            }

            const linePos = parsePositionFromLine(line);
            const dist = distanceMeters(eventPos, linePos);

            // score base on time proximity and then position
            let score = 5000;
            if (matchType === 'exact') score = 0;
            else if (matchType === 'fuzzy') score = 10 + (delta || 0);
            else if (matchType === 'distant') score = 1000 + (delta || 9999);
            else if (matchType === 'verb-only') score = 3000;

            // prefer closer positions
            if (dist !== null) {
              // subtract small amount to prefer close matches; closer distance => better (lower) score
              if (dist <= 5) score -= 50;
              else if (dist <= 25) score -= 20;
              else if (dist <= 75) score -= 5;
              else score += Math.min(200, Math.floor(dist/10));
            }

            if (!best || score < best.score) {
              best = { file: full, lineNumber: i+1, text: line, matchType, deltaSeconds: delta, distanceMeters: dist, score };
              if (score <= 0) break;
            }
          }
          if (best && best.score <= 0) break;
        }
      }

      results.push({ eventId: r.id, serverId: r.server_id, timestamp: r.timestamp, position: r.position, logSource: r.log_source, match: best });
    }

    const outPath = path.join('logs', 'unknown_audit.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log('Wrote', outPath);
  } catch (err) {
    console.error('ERROR', err && err.stack || err);
    process.exit(1);
  } finally {
    try { await db.close(); } catch(_){}
  }
})();
