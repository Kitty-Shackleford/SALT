#!/usr/bin/env node
'use strict';

/**
 * release-ready-checks.js
 *
 * A single script that runs a collection of automated health and readiness
 * checks useful before a public release. It is intentionally non-destructive
 * and conservative: anything that would mutate production is run only in
 * dry-run or skipped unless explicitly enabled by flags.
 *
 * Usage:
 *   node scripts/release-ready-checks.js          # quick checks
 *   node scripts/release-ready-checks.js --full   # run heavier checks (db smoke, npm audit, build:css)
 *
 * Exit codes:
 *   0 - all checks passed
 *   1 - one or more checks failed
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

function runCapture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd || ROOT, shell: opts.shell || false, env: Object.assign({}, process.env, opts.env || {}) });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

async function main() {
  const args = process.argv.slice(2);
  const doFull = args.includes('--full');
  const summary = [];

  console.log('DayZ Dashboard — Release readiness checks');
  console.log(`Working directory: ${ROOT}`);

  // 1) Syntax checks (node --check) for key entry points
  const syntaxTargets = ['server.js', 'scheduler.js', 'bot/index.js'];
  for (const t of syntaxTargets) {
    const p = path.join(ROOT, t);
    if (!fs.existsSync(p)) {
      console.log(` - Skipping syntax check for missing file: ${t}`);
      continue;
    }
    const r = runCapture('node', ['--check', p]);
    if (r.status !== 0) {
      summary.push({ name: `syntax:${t}`, ok: false, msg: r.stderr.trim().split('\n').slice(-3).join('\n') });
    } else {
      summary.push({ name: `syntax:${t}`, ok: true });
    }
  }

  // 2) Lint
  if (fs.existsSync(path.join(ROOT, 'package.json'))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    if (pkg.scripts && pkg.scripts.lint) {
      const r = runCapture('npm', ['run', 'lint']);
      summary.push({ name: 'lint', ok: r.status === 0 });
    } else {
      console.log(' - No lint script defined in package.json, skipping lint check');
      summary.push({ name: 'lint', ok: true, msg: 'no-op' });
    }
  }

  // 3) Standard test gate. npm test includes the deterministic focused security
  // regression/migration suite exactly once; do not invoke it separately here.
  if (fs.existsSync(path.join(ROOT, 'scripts', 'unit-test.js'))) {
    const r = runCapture('npm', ['run', 'test']);
    summary.push({ name: 'test-suite', ok: r.status === 0, msg: 'includes security regressions' });
  } else {
    summary.push({ name: 'test-suite', ok: true, msg: 'no unit-test.js found' });
  }

  // 4) Environment validator (non-fatal — we capture failures but continue)
  try {
    const envValidator = require(path.join(ROOT, 'utils', 'envValidator'));
    try {
      envValidator.validateEnv();
      summary.push({ name: 'env-validator', ok: true });
    } catch (err) {
      summary.push({ name: 'env-validator', ok: false, msg: err && err.message ? err.message : String(err) });
    }
  } catch (err) {
    summary.push({ name: 'env-validator', ok: false, msg: 'utils/envValidator.js missing or errored on import' });
  }

  // 5) Encryption sanity check (non-destructive). Only runs if ENCRYPTION_KEY is set.
  if (process.env.ENCRYPTION_KEY) {
    try {
      const { encryptToken, decryptToken } = require(path.join(ROOT, 'utils', 'encryption'));
      const testPlain = 'release-check-token-123';
      const encrypted = encryptToken(testPlain);
      const decrypted = decryptToken(encrypted);
      if (decrypted === testPlain) {
        summary.push({ name: 'encryption', ok: true });
      } else {
        summary.push({ name: 'encryption', ok: false, msg: 'round-trip mismatch' });
      }
    } catch (err) {
      summary.push({ name: 'encryption', ok: false, msg: err && err.message ? err.message : String(err) });
    }
  } else {
    summary.push({ name: 'encryption', ok: false, msg: 'ENCRYPTION_KEY not set (skipped)'});
  }

  // 6) DB smoke test — heavy and requires Postgres. Only run with --full
  if (doFull) {
    if (fs.existsSync(path.join(ROOT, 'scripts', 'db-smoke-test.js'))) {
      console.log('\nRunning DB smoke test (this requires a reachable Postgres instance configured via env vars)');
      const r = runCapture('node', ['scripts/db-smoke-test.js']);
      summary.push({ name: 'db-smoke-test', ok: r.status === 0, msg: (r.stderr || r.stdout).slice(0, 200) });
    } else {
      summary.push({ name: 'db-smoke-test', ok: true, msg: 'no-op (script absent)' });
    }
  } else {
    summary.push({ name: 'db-smoke-test', skipped: true, msg: 'run with --full' });
  }

  // 7) NPM audit (only in --full)
  if (doFull) {
    if (fs.existsSync(path.join(ROOT, 'package.json'))) {
      console.log('\nRunning npm audit (this may be slow)');
      const r = runCapture('npm', ['audit', '--audit-level=moderate']);
      // npm audit returns non-zero on advisory found; we treat anything non-zero as a warning
      const ok = r.status === 0;
      summary.push({ name: 'npm-audit', ok, msg: ok ? 'no high/critical advisories' : 'advisories found (check output)' });
    }
  } else {
    summary.push({ name: 'npm-audit', skipped: true, msg: 'run with --full' });
  }

  // 8) Node-check for bot entry (if exists)
  const botIndex = path.join(ROOT, 'bot', 'index.js');
  if (fs.existsSync(botIndex)) {
    const r = runCapture('node', ['--check', botIndex]);
    summary.push({ name: 'bot-syntax', ok: r.status === 0 });
  } else {
    summary.push({ name: 'bot-syntax', ok: true, msg: 'no-op (no bot/)'});
  }

  // 9) Public static build verification (CSS) — optional in --full
  if (doFull && packageHasScript('build:css')) {
    const r = runCapture('npm', ['run', 'build:css']);
    summary.push({ name: 'build:css', ok: r.status === 0 });
  } else {
    summary.push({ name: 'build:css', skipped: true, msg: doFull ? 'no-op' : 'run with --full' });
  }

  // 10) Check scheduler loads without immediate crash (import test)
  try {
    // safe import: require but do not start timers. Many modules export a start function.
    const schedPath = path.join(ROOT, 'scheduler.js');
    if (fs.existsSync(schedPath)) {
      const r = runCapture('node', ['--check', schedPath]);
      summary.push({ name: 'scheduler-syntax', ok: r.status === 0 });
    } else {
      summary.push({ name: 'scheduler-syntax', ok: true, msg: 'no-op (missing)'});
    }
  } catch (err) {
    summary.push({ name: 'scheduler-load', ok: false, msg: String(err) });
  }

  // Consolidate results
  console.log('\n\nRelease readiness summary:');
  let failed = 0;
  let skipped = 0;
  for (const s of summary) {
    const status = s.skipped ? 'SKIP' : (s.ok ? 'PASS' : 'FAIL');
    console.log(` - ${s.name.padEnd(20)} ${status} ${s.msg ? ' - ' + s.msg : ''}`);
    if (s.skipped) skipped++;
    else if (!s.ok) failed++;
  }

  if (failed === 0) {
    console.log(`\n🎉 All executable checks passed${skipped ? ` (${skipped} full-only check(s) skipped)` : ''} — repository appears ready for release smoke-testing.`);
    process.exit(0);
  } else {
    console.error(`\n❗ ${failed} check(s) failed. Review the output above and fix issues before deploying.`);
    process.exit(1);
  }
}

function packageHasScript(name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return !!(pkg.scripts && pkg.scripts[name]);
  } catch (err) {
    return false;
  }
}

main();
