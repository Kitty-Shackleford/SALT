#!/usr/bin/env node
// Quick verification script: parse newest ADM/RPT in dayzxb config and show parser output summary
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (!process.env.ENCRYPTION_KEY) {
  // generate a transient key so modules that require utils/encryption don't throw
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
}

try {
  const parser = require('../routes/logParser');
  const baseConfigDir = '/home/salt/Documents/GitHub/dayzxb/config';

  function newestFile(dir, ext) {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(f => f.toUpperCase().endsWith(ext.toUpperCase()));
    if (files.length === 0) return null;
    files.sort((a,b) => fs.statSync(path.join(dir,b)).mtimeMs - fs.statSync(path.join(dir,a)).mtimeMs);
    return path.join(dir, files[0]);
  }

  const adm = newestFile(baseConfigDir, '.ADM');
  const rpt = newestFile(baseConfigDir, '.RPT');

  console.log('Sample paths:');
  console.log('  ADM ->', adm || 'none');
  console.log('  RPT ->', rpt || 'none');

  if (adm && fs.existsSync(adm)) {
    const admContent = fs.readFileSync(adm, 'utf8');
    const admPlayers = parser.parseADMLog(admContent);
    console.log(`Parsed ADM players: ${admPlayers.length}`);
    console.log('ADM sample (first 5):', JSON.stringify(admPlayers.slice(0,5), null, 2));
  }

  if (rpt && fs.existsSync(rpt)) {
    const rptContent = fs.readFileSync(rpt, 'utf8');
    const rptPlayers = parser.parseRPTLog(rptContent);
    console.log(`Parsed RPT players: ${rptPlayers.length}`);
    console.log('RPT sample (first 5):', JSON.stringify(rptPlayers.slice(0,5), null, 2));
  }

} catch (err) {
  console.error('Script error:', err && err.stack ? err.stack : err);
  process.exit(2);
}
