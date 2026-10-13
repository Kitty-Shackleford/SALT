#!/usr/bin/env node
// Dozy — Lightweight HTTP response time profiler for key endpoints

const http = require('http');
const https = require('https');

const ENDPOINTS = (process.env.ENDPOINTS || 'http://127.0.0.1:3000/').split(',').map(s=>s.trim()).filter(Boolean);
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '5000', 10);
const THRESHOLD_MS = parseInt(process.env.THRESHOLD_MS || '500', 10);

async function check(url) {
  return new Promise((resolve) => {
    const start = Date.now();
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: TIMEOUT_MS }, (res) => {
      // consume a small chunk to ensure server responded
      res.once('data', () => {});
      res.on('end', () => {});
      const elapsed = Date.now() - start;
      resolve({ url, status: res.statusCode, time: elapsed });
    });
    req.on('error', (err) => resolve({ url, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ url, error: 'timeout' }); });
  });
}

(async () => {
  console.log(`Dozy: profiling ${ENDPOINTS.length} endpoint(s)`);
  let failures = 0;
  for (const e of ENDPOINTS) {
    const r = await check(e);
    if (r.error) {
      console.error(`FAIL: ${e} - ${r.error}`);
      failures++;
      continue;
    }
    console.log(`${e} -> ${r.status} in ${r.time}ms`);
    if (r.time > THRESHOLD_MS) {
      console.error(`SLOW: ${e} response ${r.time}ms > ${THRESHOLD_MS}ms`);
      failures++;
    }
  }
  if (failures > 0) process.exit(2);
  console.log('Dozy: all endpoints within thresholds');
  process.exit(0);
})();
