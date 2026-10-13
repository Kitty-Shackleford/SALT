#!/usr/bin/env node
/*
Benchmark parser functions against sample files.
Usage:
  node tools/benchmark_parser.js path/to/sample.ADM

Outputs a JSON summary to stdout.

This script attempts to use exported parser functions from routes/logParser.js
It measures wall time and memory before/after and reports counts.
*/

const fs = require('fs');
const path = require('path');

async function measureAsync(fn) {
  const start = process.hrtime.bigint();
  const memBefore = process.memoryUsage();
  const res = await fn();
  const memAfter = process.memoryUsage();
  const end = process.hrtime.bigint();
  const elapsedMs = Number(end - start) / 1e6;
  return { result: res, elapsedMs, memBefore, memAfter };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: node tools/benchmark_parser.js sample.ADM [sample.RPT]');
    process.exit(2);
  }
  const admPath = path.resolve(args[0]);
  const rptPath = args[1] ? path.resolve(args[1]) : null;

  if (!fs.existsSync(admPath)) {
    console.error('ADM sample not found:', admPath); process.exit(2);
  }

  // Try to require the parser module
  let parserModule;
  try {
    parserModule = require('../routes/logParser');
  } catch (err) {
    console.error('Failed to require routes/logParser.js:', err.message);
    process.exit(1);
  }

  const summary = { sample: { adm: admPath, rpt: rptPath }, tests: [] };

  // Benchmark parseADMFileStream if available
  if (parserModule.parseADMFileStream) {
    console.log('Running parseADMFileStream benchmark...');
    const run = async () => {
      // parseADMFileStream may be an async function returning an array or an async generator
      const out = { counts: { players: 0, kills: 0, events: 0 } };
      const gen = await parserModule.parseADMFileStream(admPath, null);
      if (gen && typeof gen[Symbol.asyncIterator] === 'function') {
        for await (const ev of gen) {
          out.counts.events++;
          if (ev.type === 'player') out.counts.players++;
          if (ev.type === 'kill') out.counts.kills++;
        }
      } else if (Array.isArray(gen)) {
        // older API: returned array of events
        for (const ev of gen) {
          out.counts.events++;
          if (ev.type === 'player') out.counts.players++;
          if (ev.type === 'kill') out.counts.kills++;
        }
      } else if (gen && typeof gen === 'object') {
        // maybe {players:[], kills:[], events:[]}
        out.counts.players = (gen.players && gen.players.length) || 0;
        out.counts.kills = (gen.kills && gen.kills.length) || 0;
        out.counts.events = (gen.events && gen.events.length) || 0;
      }
      return out;
    };

    const res = await measureAsync(run);
    summary.tests.push({ name: 'parseADMFileStream', elapsedMs: res.elapsedMs, memBefore: res.memBefore, memAfter: res.memAfter, counts: res.result.counts });
  } else {
    console.warn('parseADMFileStream not exported from routes/logParser.js');
  }

  // Benchmark parseRPTLog if available and a sample provided
  if (rptPath && parserModule.parseRPTLog) {
    console.log('Running parseRPTLog benchmark...');
    const runRpt = async () => {
      const txt = fs.readFileSync(rptPath, 'utf8');
      const parsed = await parserModule.parseRPTLog(txt, rptPath);
      // try to count kills/cleanups
      const counts = { kills: 0, cleanups: 0 };
      if (Array.isArray(parsed)) {
        for (const ev of parsed) {
          if (ev.type === 'kill') counts.kills++;
          if (ev.type === 'cleanup' || ev.type === 'despawn') counts.cleanups++;
        }
      } else if (parsed && typeof parsed === 'object') {
        counts.kills = (parsed.kills && parsed.kills.length) || 0;
        counts.cleanups = (parsed.cleanup && parsed.cleanup.length) || 0;
      }
      return counts;
    };
    const res = await measureAsync(runRpt);
    summary.tests.push({ name: 'parseRPTLog', elapsedMs: res.elapsedMs, memBefore: res.memBefore, memAfter: res.memAfter, counts: res.result });
  }

  console.log('\nBenchmark summary (JSON):\n');
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
