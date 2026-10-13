#!/usr/bin/env node
// Shady — vulnerability and secret scanner (lightweight)

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { stdio: 'pipe', maxBuffer: 10 * 1024 * 1024, ...opts }).toString();
  } catch (e) {
    return e.stdout ? e.stdout.toString() : '';
  }
}

const gha = Boolean(process.env.GITHUB_ACTIONS);
const baseRef = process.env.GITHUB_BASE_REF || 'origin/main';
const headRef = process.env.GITHUB_HEAD_REF || 'HEAD';

// Ensure base ref is available
if (baseRef && baseRef.startsWith('origin/') === false && baseRef !== 'origin/main') {
  try { run(`git fetch origin ${baseRef} --depth=1`); } catch (e) {}
}

let issues = [];

// 1) Dependency audit (requires package-lock.json and node_modules)
function runNpmAudit() {
  if (!fs.existsSync('package-lock.json')) {
    console.log('Shady: no package-lock.json found — skipping npm audit');
    return;
  }

  // In CI we expect dependencies to be installed (workflow will run npm ci).
  // Gate on production deps — dev-only tooling (eslint/tailwind) has known
  // advisories that do not ship to the runtime image.
  console.log('Shady: running npm audit --omit=dev --json (may be slow)');
  const out = run('npm audit --omit=dev --json');
  if (!out) return;
  let parsed;
  try { parsed = JSON.parse(out); } catch (e) { console.log('Shady: npm audit produced non-json output'); return; }

  if (parsed.errors) {
    // older npm versions show errors
    issues.push({ file: '', type: 'audit', message: `npm audit errors: ${parsed.errors}`, severity: 'high' });
    return;
  }

  if (!parsed.vulnerabilities && parsed.advisories && typeof parsed.advisories === 'object') {
    // legacy structure
    Object.values(parsed.advisories).forEach(a => {
      const sev = (a.severity || 'moderate').toLowerCase();
      issues.push({ file: '', type: 'vuln', message: `${a.module_name}: ${a.title} (${sev})`, severity: sev === 'critical' || sev === 'high' ? 'high' : sev === 'moderate' ? 'medium' : 'low' });
    });
    return;
  }

  if (parsed.vulnerabilities) {
    Object.entries(parsed.vulnerabilities).forEach(([pkg, info]) => {
      const sev = (info.severity || 'moderate').toLowerCase();
      const count = info.via ? (Array.isArray(info.via) ? info.via.length : 1) : 1;
      issues.push({ file: '', type: 'vuln', message: `${pkg}: ${count} issue(s) - severity ${sev}`, severity: sev === 'critical' || sev === 'high' ? 'high' : sev === 'moderate' ? 'medium' : 'low' });
    });
  }
}

// 2) Secret scanning (heuristics) on tracked files
function runSecretScan() {
  // limit to common text file types
  const tracked = run('git ls-files').split('\n').filter(Boolean);
  const filePatterns = ['.js', '.ts', '.json', '.env', '.pem', '.key', '.yml', '.yaml', '.md'];
  const candidates = tracked.filter(f => filePatterns.some(ext => f.endsWith(ext)));

  const sensitiveEnvNames = /(ENCRYPTION_KEY|DISCORD_CLIENT_SECRET|DISCORD_BOT_TOKEN|SESSION_SECRET|POSTGRES_PASSWORD|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID)/i;
  // Quoted 64-hex literal assigned directly to a sensitive name.
  const hex64NearSensitive = /(ENCRYPTION_KEY|DISCORD_CLIENT_SECRET|DISCORD_BOT_TOKEN|SESSION_SECRET|POSTGRES_PASSWORD|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID)["']?\s*[:=]\s*["'][0-9a-fA-F]{64}["']/i;
  const pemKey = /-----BEGIN (RSA |)PRIVATE KEY-----/;
  const awsKey = /AKIA[0-9A-Z]{16}/g;
  const slackToken = /xox[baprs]-[0-9A-Za-z]{10,}/g;
  // Discord bot token: 24 word chars . 6 . 27 — require word boundaries so
  // prose / test fixtures with dotted version strings don't trip it.
  const discordToken = /(?<![\w.])[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}(?![\w.])/g;

  // A "hardcoded secret" line is one where the value on the right side is a
  // long string literal (>= 32 chars) or high-entropy blob. Variable
  // references (env.ENCRYPTION_KEY, ENCRYPTION_KEY as an identifier),
  // placeholders, and short test values are NOT secrets.
  function hardcodedSecretValue(value) {
    const v = value.trim();
    if (!v) return false;
    // Quoted literal: only long ones are secret-looking.
    const m = v.match(/^["'](.*)["']$/);
    if (m) return m[1].length >= 32;
    // Unquoted: identifier / call / template / array / regex / regex-char
    // class are references, not literals.
    if (/^[A-Za-z_$][\w.$]*/.test(v)) return false;            // identifier (incl. ENCRYPTION_KEY, env.X)
    if (v.startsWith('[') || v.startsWith('(') || v.startsWith('{')) return false;
    if (v.startsWith('/')) return false;                        // regex literal
    if (/^(true|false|null|undefined|\d+)([,.]|\s|$)/.test(v)) return false;
    if (v.length < 40) return false;                            // short unquoted value
    return /[A-Za-z0-9+/=_-]{40,}/.test(v);                     // long high-entropy blob
  }

  for (const f of candidates) {
    let content = '';
    try { content = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }

    const isEnvFile = f.endsWith('.env');
    const isExampleFile = /(\.env\.|example|template|sample|fixture)/i.test(f);

    if (pemKey.test(content)) issues.push({ file: f, type: 'secret', message: 'Possible PEM private key block', severity: 'high' });
    if (awsKey.test(content)) issues.push({ file: f, type: 'secret', message: 'Possible AWS access key (AKIA...)', severity: 'high' });
    if (slackToken.test(content)) issues.push({ file: f, type: 'secret', message: 'Possible Slack token', severity: 'high' });
    if (discordToken.test(content)) issues.push({ file: f, type: 'secret', message: 'Possible Discord bot token', severity: 'high' });
    if (hex64NearSensitive.test(content)) issues.push({ file: f, type: 'secret', message: 'Possible 64-hex secret assigned to a sensitive variable', severity: 'high' });

    // env-like lines: sensitive name + hardcoded literal value.
    // Tracked real .env files are always suspicious; example/template files
    // and .env.example are exempt from the line rule (token regexes still apply).
    const lines = content.split('\n');
    for (let i = 0; i < Math.min(lines.length, 500); i++) {
      const line = lines[i];
      if (!sensitiveEnvNames.test(line)) continue;
      const sep = line.search(/[:=]/);
      if (sep === -1) continue;
      const value = line.slice(sep + 1).split(/[,\n]/)[0];
      let flag;
      if (isEnvFile && !isExampleFile) {
        flag = value.trim().length > 0;   // any real value in a tracked .env
      } else {
        flag = hardcodedSecretValue(value);
      }
      if (flag) issues.push({ file: f, type: 'sensitive_env', message: `Possible hardcoded sensitive env in line ${i + 1}`, severity: 'high' });
    }
  }
}

function emitSarif() {
  // Minimal SARIF v2.1.0 — uploaded to GitHub Code Scanning so results get
  // trended / deduped alongside CodeQL instead of living only in logs.
  const results = issues.map((it, idx) => ({
    ruleId: `shady/${it.type}`,
    level: it.severity === 'high' ? 'error' : it.severity === 'medium' ? 'warning' : 'note',
    message: { text: `${it.message} (shady ${it.type})` },
    locations: [{
      physicalLocation: {
        artifactLocation: { uri: it.file || 'repo' },
        region: it.message.match(/line (\d+)/) ? { startLine: Number(it.message.match(/line (\d+)/)[1]) } : undefined,
      },
    }],
  }));
  const sarif = {
    $schema: 'https://schemastore.azuredevops.com/sarif/2.1.0/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'Shady', version: '1.0.0', rules: [] } },
      results,
    }],
  };
  fs.writeFileSync('shady.sarif', JSON.stringify(sarif, null, 2));
}

function emitAnnotationsAndExit() {
  let high = 0;
  issues.forEach(it => {
    const sev = it.severity || 'low';
    const prefix = sev === 'high' ? 'error' : sev === 'medium' ? 'warning' : 'notice';
    const file = it.file || '';
    const title = it.type || 'issue';
    const msg = it.message || '';
    if (gha) console.log(`::${prefix} file=${file},title=Shady ${title}::${msg}`);
    console.log(`${sev.toUpperCase()}: ${title} ${file ? 'in '+file : ''} - ${msg}`);
    if (sev === 'high') high++;
  });

  if (high > 0) {
    console.error(`Shady: ${high} high severity issue(s) found`);
    process.exit(3);
  }

  console.log('Shady: no high-severity issues found');
  process.exit(0);
}

// Main
(async () => {
  console.log('Shady: starting scan');

  // Dependency audit
  try { runNpmAudit(); } catch (e) { console.error('Shady: npm audit failed', e.message); }

  // Secret scan
  try { runSecretScan(); } catch (e) { console.error('Shady: secret scan failed', e.message); }

  // SARIF for GitHub Code Scanning (uploaded by the workflow when present).
  try { emitSarif(); } catch (e) { console.error('Shady: sarif emit failed', e.message); }

  emitAnnotationsAndExit();
})();
