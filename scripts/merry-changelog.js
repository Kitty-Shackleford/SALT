#!/usr/bin/env node
// Merry — public changelog generator

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function runGit(args) {
  return execFileSync('git', args, { stdio: 'pipe', encoding: 'utf8' }).trim();
}

function findLastTag() {
  const description = runGit(['describe', '--tags', '--abbrev=0', '--always']);
  const tags = new Set(runGit(['tag', '--list']).split('\n').filter(Boolean));
  return tags.has(description) ? description : '';
}

function escapeMarkdown(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([`*_[\]{}()<>#+.!|])/g, '\\$1');
}

const lastTag = findLastTag();
const lastTagCommit = lastTag
  ? runGit(['rev-parse', '--verify', `refs/tags/${lastTag}^{commit}`])
  : '';
if (lastTagCommit && !/^[0-9a-f]{40,64}$/i.test(lastTagCommit)) {
  throw new Error('Merry: resolved tag is not a commit hash');
}
const range = lastTagCommit ? `${lastTagCommit}..HEAD` : 'HEAD';
const hashes = runGit(['rev-list', '--no-merges', range, '--']).split('\n').filter(Boolean);

if (hashes.length === 0) {
  console.log('Merry: no new commits since last tag; nothing to do.');
  process.exit(0);
}

const entries = hashes.map(hash => {
  if (!/^[0-9a-f]{40,64}$/i.test(hash)) {
    throw new Error('Merry: git returned an invalid commit hash');
  }
  const fields = runGit(['show', '-s', '--format=%cs%x00%s%x00%h%x00%an', hash, '--']).split('\x00');
  if (fields.length !== 4) {
    throw new Error(`Merry: malformed metadata for commit ${hash}`);
  }
  const [date, subject, shortHash, author] = fields;
  return { date, subject, hash: shortHash, author };
}).filter(entry => !entry.subject.startsWith('chore(merry): update CHANGELOG.md'));

if (entries.length === 0) {
  console.log('Merry: no new non-generated commits since last tag; nothing to do.');
  process.exit(0);
}

const lines = entries.map(entry =>
  `- ${escapeMarkdown(entry.subject)} (${entry.hash}) — ${escapeMarkdown(entry.author)}`);
const date = entries[0].date;
const header = `## Unreleased - ${date}\n\n`;
const body = `${lines.join('\n')}\n\n`;
const changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
const existing = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf8') : '';
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
lines.forEach(line => console.log(`  ${line}`));
