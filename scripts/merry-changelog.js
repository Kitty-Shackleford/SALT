#!/usr/bin/env node
// Merry — simple changelog generator

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runGit(args) {
  try {
    return execFileSync('git', args, { stdio: 'pipe', encoding: 'utf8' }).trim();
  } catch (_error) {
    return '';
  }
}

// Find last tag
const lastTag = runGit(['describe', '--tags', '--abbrev=0']);
const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';

// Get commits (exclude merges and Merry's own generated commits)
const out = runGit(['log', range, '--no-merges', '--pretty=format:%s%x1f%h%x1f%an']);
if (!out) {
  console.log('Merry: no new commits since last tag; nothing to do.');
  process.exit(0);
}

const entries = out.split('\n')
  .filter(Boolean)
  .map(line => {
    const [subject, hash, author] = line.split('\x1f');
    return { subject, hash, author };
  })
  .filter(entry => !entry.subject.startsWith('chore(merry): update CHANGELOG.md'))
  .map(entry => `- ${entry.subject} (${entry.hash}) — ${entry.author}`);

const date = new Date().toISOString().slice(0,10);
const header = `## Unreleased - ${date}\n\n`;
const body = entries.join('\n') + '\n\n';

const changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
let existing = '';
if (fs.existsSync(changelogPath)) existing = fs.readFileSync(changelogPath, 'utf8');

const generated = `<!-- merry:start -->\n${header}${body}<!-- merry:end -->\n\n`;
const markerPattern = /^<!-- merry:start -->\n[\s\S]*?^<!-- merry:end -->\n*/m;
const newContent = markerPattern.test(existing)
  ? existing.replace(markerPattern, generated)
  : `${generated}${existing}`;

if (existing === newContent) {
  console.log('Merry: CHANGELOG.md already up-to-date');
  process.exit(0);
}

fs.writeFileSync(changelogPath, newContent, 'utf8');
console.log('Merry: updated CHANGELOG.md with entries:');
entries.forEach(e => console.log('  ' + e));
process.exit(0);
