#!/usr/bin/env node
// Lightweight PR reviewer for DayZ Dashboard (Doc agent scaffold)

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd) {
  try {
    return execSync(cmd, { stdio: 'pipe' }).toString().trim();
  } catch (e) {
    return '';
  }
}

// Determine base ref from env (GitHub Actions sets GITHUB_BASE_REF/GITHUB_HEAD_REF)
const baseRef = process.env.GITHUB_BASE_REF || 'origin/main';
const headRef = process.env.GITHUB_HEAD_REF || 'HEAD';

// Ensure refs are available
if (baseRef.startsWith('origin/') === false && baseRef !== 'origin/main') {
  try { run(`git fetch origin ${baseRef} --depth=1`); } catch (e) {}
}

// Get changed files between base and head
let diffCmd = `git diff --name-only ${baseRef}...${headRef}`;
const fileListStr = run(diffCmd);
if (!fileListStr) {
  console.log('No changed files detected.');
  process.exit(0);
}

const files = fileListStr.split('\n').map(s => s.trim()).filter(Boolean);
console.log(`Doc: reviewing ${files.length} changed files`);

let issues = [];

files.forEach(file => {
  // only review files that still exist in tree
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');

  // TODO/FIXME
  const todoMatches = content.match(/\b(TODO|FIXME)\b/gi);
  if (todoMatches) {
    issues.push({ file, type: 'todo', message: `Found TODO/FIXME (${todoMatches.length})` });
  }

  // console.* in non-dev assets (flag JS in public/ or server code)
  if (file.endsWith('.js') || file.endsWith('.ts')) {
    const consoleMatches = content.match(/console\.(log|error|warn|info)\(/g);
    if (consoleMatches) {
      issues.push({ file, type: 'console', message: `Found console.* usages (${consoleMatches.length})` });
    }

    // AGPL header check for JS files that are added/modified (quick heuristic)
    const firstChunk = content.slice(0, 800);
    if (!/GNU Affero General Public License/i.test(firstChunk)) {
      issues.push({ file, type: 'license', message: 'Missing AGPL license header in JS/TS file' });
    }
  }

  // possible secret: 64 hex chars
  const secretMatch = content.match(/[0-9a-fA-F]{64}/g);
  if (secretMatch) {
    issues.push({ file, type: 'secret', message: `Possible 64-hex secret (${secretMatch.length})` });
  }

  // eval usage
  if (/\beval\s*\(/.test(content)) {
    issues.push({ file, type: 'eval', message: 'Use of eval() detected' });
  }

  // child_process usage
  if (/child_process\.(exec|execSync|spawn|spawnSync)/.test(content) || /require\(['\"]child_process['\"]\)/.test(content)) {
    issues.push({ file, type: 'child_process', message: 'Use of child_process APIs detected' });
  }

  // .env file or dotenv usage (flag if .env file is modified or a literal .env was added)
  if (file === '.env' || /\bdotenv\.config\(/.test(content) || /\.env['\"]/.test(content)) {
    issues.push({ file, type: 'env_file', message: 'Reference to .env or dotenv detected; ensure secrets are not committed' });
  }

  // Hardcoded sensitive-looking env values (quick heuristic)
  const sensitiveKeyRegex = /(?:ENCRYPTION_KEY|DISCORD_CLIENT_SECRET|DISCORD_CLIENT_ID|DISCORD_BOT_TOKEN|SESSION_SECRET)\s*[:=]\s*['\"]?([0-9A-Za-z\-_+\/=]{8,})['\"]?/g;
  let m;
  let foundSensitive = 0;
  while ((m = sensitiveKeyRegex.exec(content)) !== null) {
    foundSensitive++;
  }
  if (foundSensitive) {
    issues.push({ file, type: 'sensitive_env', message: `Possible hardcoded sensitive env values (${foundSensitive})` });
  }

  // PEM/private key blocks
  if (/-----BEGIN (RSA |)PRIVATE KEY-----/.test(content)) {
    issues.push({ file, type: 'secret', message: 'Possible private key block detected (PEM)' });
  }
});

// Severity mapping: high, medium, low
const gha = Boolean(process.env.GITHUB_ACTIONS);
let highCount = 0;

function emitAnnotation(file, level, title, message) {
  const safeFile = file || '';
  const prefix = level === 'high' ? 'error' : level === 'medium' ? 'warning' : 'notice';
  if (gha) {
    // GitHub Actions annotation format
    console.log(`::${prefix} file=${safeFile},title=Doc ${title}::${message}`);
  }
  console.log(`${level.toUpperCase()}: ${title} in ${safeFile}: ${message}`);
}

issues.forEach(({file, type, message}) => {
  // Classify severity
  let severity = 'low';
  if (type === 'secret' || type === 'eval' || type === 'child_process' || type === 'sensitive_env' || type === 'env_file') {
    severity = 'high';
  } else if (type === 'console' || type === 'todo') {
    severity = 'medium';
  } else if (type === 'license') {
    severity = 'low';
  }

  if (severity === 'high') highCount++;
  emitAnnotation(file, severity, type, message);
});

if (issues.length === 0) {
  console.log('Doc: no quick issues found.');
} else {
  console.log(`Doc: ${issues.length} quick issues found (${highCount} high severity). Review recommended.`);
}

// Exit non-zero if any high severity issues found to fail the job
process.exit(highCount > 0 ? 2 : 0);
