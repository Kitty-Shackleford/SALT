#!/usr/bin/env node
// Sleepy maintenance script — remove old downloads and compress old logs

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { promisify } = require('util');
const pipe = promisify(pipeline);

const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || 'downloads';
const LOGS_DIR = process.env.LOGS_DIR || 'logs';
const DAYS_TO_KEEP = parseInt(process.env.DAYS_TO_KEEP || '14', 10);
const COMPRESS_AFTER_DAYS = parseInt(process.env.COMPRESS_AFTER_DAYS || '7', 10);
const DRY_RUN = Boolean(process.env.DRY_RUN && process.env.DRY_RUN !== '0');

const now = Date.now();
const msPerDay = 24 * 60 * 60 * 1000;

async function listFilesRecursive(dir) {
  const res = [];
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        res.push(...await listFilesRecursive(full));
      } else if (e.isFile()) {
        res.push(full);
      }
    }
  } catch (err) {
    // ignore missing dirs
  }
  return res;
}

async function removeOldDownloads() {
  const dir = DOWNLOADS_DIR;
  const removed = [];
  const files = await listFilesRecursive(dir);
  for (const f of files) {
    try {
      const st = await fs.promises.stat(f);
      const ageDays = (now - st.mtimeMs) / msPerDay;
      if (ageDays > DAYS_TO_KEEP) {
        if (DRY_RUN) {
          removed.push({ file: f, action: 'would-remove', ageDays: Math.floor(ageDays) });
        } else {
          await fs.promises.unlink(f);
          removed.push({ file: f, action: 'removed', ageDays: Math.floor(ageDays) });
        }
      }
    } catch (err) {
      // ignore stat/unlink errors for now
    }
  }
  return removed;
}

async function compressOldLogs() {
  const dir = LOGS_DIR;
  const compressed = [];
  const files = await listFilesRecursive(dir);
  for (const f of files) {
    if (f.endsWith('.gz')) continue; // skip already compressed
    try {
      const st = await fs.promises.stat(f);
      const ageDays = (now - st.mtimeMs) / msPerDay;
      if (ageDays > COMPRESS_AFTER_DAYS) {
        const outPath = `${f}.gz`;
        if (DRY_RUN) {
          compressed.push({ file: f, action: 'would-compress', ageDays: Math.floor(ageDays) });
        } else {
          try {
            await pipe(fs.createReadStream(f), zlib.createGzip(), fs.createWriteStream(outPath));
            // only remove original after successful compression
            await fs.promises.unlink(f);
            compressed.push({ file: f, action: 'compressed', ageDays: Math.floor(ageDays) });
          } catch (err) {
            // on error, remove partial output if exists
            try { await fs.promises.unlink(outPath); } catch(_){}
          }
        }
      }
    } catch (err) {
      // ignore
    }
  }
  return compressed;
}

async function run() {
  console.log(`Sleepy: starting maintenance (DRY_RUN=${DRY_RUN})`);
  const removals = await removeOldDownloads();
  const compressions = await compressOldLogs();

  console.log('Summary:');
  console.log(`  Downloads: ${removals.length} files affected`);
  removals.slice(0, 50).forEach(r => console.log(`    ${r.action} ${r.file} (age ${r.ageDays}d)`));
  if (removals.length > 50) console.log(`    ... ${removals.length - 50} more`);

  console.log(`  Logs: ${compressions.length} files affected`);
  compressions.slice(0, 50).forEach(r => console.log(`    ${r.action} ${r.file} (age ${r.ageDays}d)`));
  if (compressions.length > 50) console.log(`    ... ${compressions.length - 50} more`);

  console.log('Sleepy: maintenance complete.');
}

run().catch(err => {
  console.error('Sleepy: unexpected error', err);
  process.exit(2);
});
