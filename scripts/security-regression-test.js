#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TESTS = Object.freeze([
  'scripts/automation-logsync-loot-auth-test.js',
  'scripts/casino-atomic-settlement-test.js',
  'scripts/casino-escrow-accounting-test.js',
  'scripts/casino-session-security-test.js',
  'scripts/command-auth-test.js',
  'scripts/economy-admin-capability-test.js',
  'scripts/economy-initial-supply-test.js',
  'scripts/economy-server-scope-test.js',
  'scripts/link-lifecycle-test.js',
  'scripts/link-policy-dashboard-test.js',
  'scripts/link-admin-command-test.js',
  'scripts/link-security-behavior-test.js',
  'scripts/linked-account-consumers-test.js',
  'scripts/player-portal-membership-test.js',
  'scripts/private-data-authorization-test.js',
  'scripts/runtime-server-scope-test.js',
  'scripts/server-id-confusion-test.js',
  'scripts/shop-idor-test.js',
  'scripts/tenant-bypass-test.js',
]);

let failed = 0;
for (const test of TESTS) {
  console.log(`\n▶ ${test}`);
  const result = spawnSync(process.execPath, [test], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    failed++;
    console.error(`✗ ${test}: ${result.error.message}`);
  } else if (result.status !== 0) {
    failed++;
    console.error(`✗ ${test}: exited ${result.status}`);
  }
}

if (failed) {
  console.error(`\n❌ Security regression suite failed: ${failed}/${TESTS.length}`);
  process.exit(1);
}

console.log(`\n✅ Security regression suite passed: ${TESTS.length}/${TESTS.length}`);
