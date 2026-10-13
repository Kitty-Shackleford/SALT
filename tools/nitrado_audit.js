/*
Nitrado auditing script
Usage:
  node tools/nitrado_audit.js config.json output.json

config.json format:
{
  "servers": [
    { "service_id": "12345", "token": "YOUR_TOKEN" },
    { "service_id": "67890", "token": "ANOTHER_TOKEN" }
  ]
}

This script fetches file listings, scheduled tasks, and basic server info for benchmarking/audit.
Run only on admin machines. DO NOT commit tokens to source control.
*/

const fs = require('fs');
const path = require('path');
const axios = require('../utils/nitradoHttp');

async function fetchJson(url, token) {
  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000,
    });
    return res.data;
  } catch (err) {
    return { error: err.message };
  }
}

async function auditService(service, out) {
  const id = service.service_id;
  const token = service.token;
  const base = `https://api.nitrado.net/services/${encodeURIComponent(id)}`;
  const report = { service_id: id, timestamp: new Date().toISOString() };

  // Gameserver base info
  report.gameserver = await fetchJson(`${base}/gameservers`, token);

  // File listing (root)
  report.file_server_root = await fetchJson(`${base}/file_server/list`, token);

  // Try listing common platform paths (if present in root)
  report.file_server_probe = {};
  const candidates = [
    '/noftp/dayzxb',
    '/noftp/dayzps',
    '/noftp/dayzswitch',
    '/noftp/dayz',
    '/ftproot/dayzstandalone',
  ];
  for (const p of candidates) {
    report.file_server_probe[p] = await fetchJson(`${base}/file_server/list?dir=${encodeURIComponent(p)}`, token);
  }

  // Scheduled tasks (if API supports)
  report.scheduled_tasks = await fetchJson(`${base}/task`, token);

  // download token example (not used for download) - safe to fetch one small token if available
  report.file_download_info = await fetchJson(`${base}/file_server/download?file=/readme.txt`, token);

  if (out) {
    out.push(report);
  }
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node tools/nitrado_audit.js config.json output.json');
    process.exit(2);
  }
  const cfgPath = path.resolve(args[0]);
  const outPath = path.resolve(args[1]);

  if (!fs.existsSync(cfgPath)) {
    console.error('Config file not found:', cfgPath);
    process.exit(2);
  }

  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const out = [];
  for (const s of cfg.servers || []) {
    console.log('Auditing service', s.service_id);
    try {
      // avoid crashing on one failure
      await auditService(s, out);
    } catch (err) {
      console.error('Error auditing', s.service_id, err.message);
      out.push({ service_id: s.service_id, error: err.message });
    }
  }

  fs.writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), results: out }, null, 2));
  console.log('Wrote report to', outPath);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
