#!/usr/bin/env node
// Lightweight PR reviewer for DayZ Dashboard (Doc agent scaffold)

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runGit(args) {
  return execFileSync('git', args, { stdio: 'pipe' }).toString().trim();
}

const baseRef = process.env.DOC_REVIEW_BASE_SHA || 'origin/main';
const headRef = process.env.DOC_REVIEW_HEAD_SHA || 'HEAD';

try {
  for (const [label, ref] of [['base', baseRef], ['head', headRef]]) {
    if (process.env.GITHUB_ACTIONS && !/^[0-9a-f]{40}$/i.test(ref)) {
      throw new Error(`${label} revision is not an immutable commit SHA`);
    }
    runGit(['cat-file', '-e', `${ref}^{commit}`]);
  }
} catch (error) {
  console.error(`Unable to resolve documentation review revisions: ${error.message}`);
  process.exit(1);
}

let fileListStr;
try {
  fileListStr = runGit(['diff', '--name-only', `${baseRef}...${headRef}`]);
} catch (error) {
  console.error(`Unable to calculate documentation review diff: ${error.message}`);
  process.exit(1);
}

if (!fileListStr) {
  console.log('No changed files detected.');
  process.exit(0);
}

const files = fileListStr.split('\n').map(s => s.trim()).filter(Boolean);
console.log(`Doc: reviewing ${files.length} changed files`);

let issues = [];

files.forEach(file => {
  // Only review files that still exist in the checked-out tree.
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  const basename = path.basename(file);
  const isDocumentation = file.endsWith('.md') || file.endsWith('.html');
  const isPrivateEnvironmentFile = /^\.env(?:\.|$)/.test(basename)
    && !/\.example$/.test(basename);

  // Documentation TODOs are advisory. Code quality and secret scanning are
  // handled by the canonical CI suite, ESLint, security:audit, and Gitleaks.
  if (isDocumentation) {
    const todoMatches = content.match(/\b(TODO|FIXME)\b/gi);
    if (todoMatches) {
      issues.push({ file, type: 'todo', message: `Found TODO/FIXME (${todoMatches.length})` });
    }
  }

  // A private environment file or embedded private key is never documentation.
  // Example files and documented environment-variable names are legitimate.
  if (isPrivateEnvironmentFile) {
    issues.push({ file, type: 'env_file', message: 'Private environment file must not be committed' });
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) {
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
