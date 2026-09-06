#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const scanHistory = process.argv.includes('--history');

const rules = [
  { name: 'private-key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'aws-access-key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github-token', regex: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { name: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: 'openai-style-token', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'discord-token', regex: /\b(?:mfa\.[A-Za-z0-9_-]{20,}|[MN][A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,})\b/g },
  {
    name: 'credential-in-url',
    regex: /https?:\/\/[^\s/:]+:[^\s/@]+@[^\s/]+/g,
    allow: match => /https?:\/\/embedded:credential@/i.test(match)
  },
  {
    name: 'hardcoded-credential',
    regex: /\b(?:password|passwd|client_secret|api_key|access_token|private_key)\b\s*[:=]\s*['"`]([^'"`\n]{8,})['"`]/gi,
    allow: match => /(?:example|placeholder|fixture|replace|your[_-]|dummy|unit-test|process\.env|\$\{|\.repeat\(|<[^>]+>)/i.test(match)
  },
  {
    name: 'unquoted-environment-credential',
    regex: /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|CLIENT_SECRET|API_KEY|ACCESS_TOKEN|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*([^\s#'"`][^\s#]{7,})\s*$/g,
    allow: match => /(?:example|placeholder|replace|your[_-]|dummy|unit-test|\$\{|<[^>]+>|\[[A-Z_-]+\])/i.test(match)
  }
];

function isText(buffer) {
  return !buffer.subarray(0, 8192).includes(0);
}

function scanLine(line, source, lineNumber, findings) {
  for (const rule of rules) {
    rule.regex.lastIndex = 0;
    let match;
    while ((match = rule.regex.exec(line)) !== null) {
      if (!rule.allow || !rule.allow(match[0])) {
        findings.push({ rule: rule.name, source, line: lineNumber });
      }
      if (match[0].length === 0) rule.regex.lastIndex += 1;
    }
  }
}

function scanText(text, source, findings) {
  text.split(/\r?\n/).forEach((line, index) => scanLine(line, source, index + 1, findings));
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

async function scanGitHistory(findings) {
  const child = spawn(
    'git',
    ['log', '--all', '-p', '--no-ext-diff', '--unified=0', '--', '.', ':(exclude)package-lock.json'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const completion = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let commit = 'unknown';
  let file = 'unknown';
  let addedLine = 0;

  for await (const line of lines) {
    if (line.startsWith('commit ')) commit = line.slice(7, 19);
    if (line.startsWith('+++ b/')) file = line.slice(6);
    const hunk = line.match(/^@@ -[^ ]+ \+(\d+)/);
    if (hunk) addedLine = Number(hunk[1]);
    if (line.startsWith('+') && !line.startsWith('+++')) {
      scanLine(line.slice(1), `git-history:${commit}:${file}`, addedLine, findings);
      addedLine += 1;
    } else if (!line.startsWith('-') && !line.startsWith('@@')) {
      addedLine += 1;
    }
  }

  const exitCode = await completion;
  if (exitCode !== 0) throw new Error(`git history scan failed: ${stderr.trim()}`);
}

async function main() {
  const files = trackedFiles();
  const findings = [];
  for (const relativePath of files) {
    const content = fs.readFileSync(path.join(root, relativePath));
    if (isText(content)) scanText(content.toString('utf8'), relativePath, findings);
  }

  if (scanHistory) await scanGitHistory(findings);

  const unique = Array.from(new Map(findings.map(item => [`${item.rule}:${item.source}:${item.line}`, item])).values());
  if (unique.length > 0) {
    console.error(`❌ Potential secrets found: ${unique.length}`);
    for (const finding of unique) {
      console.error(`   ${finding.rule} at ${finding.source}:${finding.line} (value redacted)`);
    }
    process.exit(1);
  }

  console.log(`✅ No potential secrets found in ${files.length} source files${scanHistory ? ' or Git history' : ''}`);
}

main().catch(error => {
  console.error(`❌ Security audit failed: ${error.message}`);
  process.exit(1);
});
