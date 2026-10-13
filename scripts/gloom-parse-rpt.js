#!/usr/bin/env node
// Gloom — parse DayZ RPT logs for crashes and produce a short report

const fs = require('fs');
const path = require('path');

const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || 'downloads';
const MAX_TAIL_BYTES = 64 * 1024; // read last 64KB of each file
const gha = Boolean(process.env.GITHUB_ACTIONS);

const crashPatterns = [
  /segmentation fault/i,
  /segfault/i,
  /unhandled exception/i,
  /exception: /i,
  /assertion failed/i,
  /fatal error/i,
  /crash report/i,
  /stack trace/i,
  /UnhandledPromiseRejectionWarning/i,
  /ERROR:.*memory/i
];

function tailFile(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(maxBytes, size));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (e) {
    return '';
  }
}

function findRptFiles(dir) {
  const res = [];
  try {
    const guilds = fs.readdirSync(dir, { withFileTypes: true });
    for (const g of guilds) {
      if (!g.isDirectory()) continue;
      const serverDir = path.join(dir, g.name);
      // find .RPT files recursively under serverDir
      const stack = [serverDir];
      while (stack.length) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
        for (const e of entries) {
          const p = path.join(cur, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (e.isFile() && e.name.toLowerCase().endsWith('.rpt')) res.push(p);
        }
      }
    }
  } catch (e) {
    // directory missing or unreadable
  }
  return res;
}

function annotate(file, level, title, msg) {
  const prefix = level === 'high' ? 'error' : level === 'medium' ? 'warning' : 'notice';
  if (gha) console.log(`::${prefix} file=${file},title=Gloom ${title}::${msg}`);
  console.log(`${level.toUpperCase()}: ${title} in ${file} — ${msg}`);
}

(async () => {
  console.log('Gloom: scanning downloads for .RPT files');
  const rptFiles = findRptFiles(DOWNLOADS_DIR);
  console.log(`Gloom: found ${rptFiles.length} .RPT files`);

  let findings = [];

  for (const f of rptFiles) {
    const tail = tailFile(f, MAX_TAIL_BYTES);
    if (!tail) continue;
    for (const pat of crashPatterns) {
      if (pat.test(tail)) {
        // capture excerpt around first match
        const m = tail.match(pat);
        const idx = m ? tail.indexOf(m[0]) : 0;
        const excerptStart = Math.max(0, idx - 200);
        const excerpt = tail.slice(excerptStart, excerptStart + 800).replace(/\n/g, ' ');
        findings.push({ file: f, pattern: pat.toString(), excerpt });
        break; // report first matching pattern per file
      }
    }
  }

  if (findings.length === 0) {
    console.log('Gloom: no crash signatures detected in recent RPT files');
    process.exit(0);
  }

  console.log(`Gloom: detected ${findings.length} file(s) with possible crashes`);
  for (const it of findings) {
    annotate(it.file, 'high', 'crash-detected', `${it.pattern} — excerpt: ${it.excerpt.slice(0,200)}`);
  }

  // Exit non-zero to mark a failing check when run in CI
  process.exit(2);
})();
