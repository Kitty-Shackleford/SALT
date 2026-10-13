#!/usr/bin/env node
// Parse a sample RPT with exported parseRPTLog and show summary
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Ensure ENCRYPTION_KEY exists so requiring utils/encryption doesn't throw
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const parser = require('../routes/logParser');
const rptPath = process.argv[2] || '/home/salt/Documents/GitHub/dayzxb/config/DayZServer_X1_x64_2026-03-02_17-42-35.RPT';

if (!fs.existsSync(rptPath)) {
  console.error('RPT not found:', rptPath);
  process.exit(2);
}

const content = fs.readFileSync(rptPath, 'utf8');
const players = parser.parseRPTLog(content);
console.log('RPT file:', rptPath);
console.log('Parsed players count:', players.length);
console.log('Sample players (first 10):');
console.log(JSON.stringify(players.slice(0,10), null, 2));
