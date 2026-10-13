'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const generator = path.join(root, 'scripts', 'merry-changelog.js');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'merry-changelog-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    encoding: 'utf8',
    ...options,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

try {
  run('git', ['init', '-q']);
  run('git', ['config', 'user.name', 'Merry Tester']);
  run('git', ['config', 'user.email', 'merry@example.test']);

  fs.writeFileSync(path.join(workspace, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
  run('git', ['add', 'CHANGELOG.md']);
  run('git', ['commit', '-qm', 'initial release notes']);

  fs.writeFileSync(path.join(workspace, 'feature.txt'), 'feature\n', 'utf8');
  run('git', ['add', 'feature.txt']);
  run('git', ['commit', '-qm', 'feat: add smoke probe']);

  run(process.execPath, [generator]);
  const first = fs.readFileSync(path.join(workspace, 'CHANGELOG.md'), 'utf8');
  assert.doesNotMatch(first, /undefined/);
  assert.match(first, /feat: add smoke probe \([0-9a-f]+\) — Merry Tester/);
  assert.equal((first.match(/<!-- merry:start -->/g) || []).length, 1);
  assert.equal((first.match(/<!-- merry:end -->/g) || []).length, 1);
  assert.match(first, /# Changelog/);

  run('git', ['add', 'CHANGELOG.md']);
  run('git', ['commit', '-qm', 'chore(merry): update CHANGELOG.md [skip ci]']);
  run(process.execPath, [generator]);
  const second = fs.readFileSync(path.join(workspace, 'CHANGELOG.md'), 'utf8');
  assert.equal(second, first, 'Merry must ignore its own commit and avoid duplicate generated sections');

  console.log('Merry changelog generator tests passed');
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
