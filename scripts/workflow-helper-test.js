#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const merrySource = path.join(root, 'scripts', 'merry-changelog.js');
const dopeySource = path.join(root, 'scripts', 'dopey-smoke.js');
const merryWorkflow = path.join(root, '.github', 'workflows', 'merry.yml');

function findInvalidWorkflowScriptTargets(workflowTexts, repositoryRoot, trackedFiles) {
  const invalid = [];
  const scriptPattern = /(?:^|[\s"'`])((?:\.\/)?scripts\/[A-Za-z0-9_./-]+\.js)(?=$|[\s"'`),])/gm;
  for (const [workflow, text] of workflowTexts) {
    for (const match of text.matchAll(scriptPattern)) {
      const relativePath = match[1].replace(/^\.\//, '');
      const absolutePath = path.join(repositoryRoot, relativePath);
      let isRegularFile = false;
      try {
        isRegularFile = fs.statSync(absolutePath).isFile();
      } catch {
        // Missing targets are reported below.
      }
      if (!isRegularFile || !trackedFiles.has(relativePath)) {
        invalid.push(`${workflow}:${relativePath}`);
      }
    }
  }
  return invalid;
}

function assertWorkflowScriptTargetsExist() {
  const workflowDir = path.join(root, '.github', 'workflows');
  const workflows = fs.readdirSync(workflowDir)
    .filter(name => /\.ya?ml$/i.test(name));
  const workflowTexts = workflows.map(workflow => [
    workflow,
    fs.readFileSync(path.join(workflowDir, workflow), 'utf8'),
  ]);
  const trackedFiles = new Set(execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\0').filter(Boolean));
  const invalid = findInvalidWorkflowScriptTargets(workflowTexts, root, trackedFiles);
  assert.deepStrictEqual(invalid, [],
    'workflow script targets must be regular, repository-tracked files');
}

function testWorkflowScriptTargetValidation() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'salt-workflow-target-test-'));
  try {
    fs.mkdirSync(path.join(fixtureRoot, 'scripts'));
    fs.writeFileSync(path.join(fixtureRoot, 'scripts', 'tracked.js'), '', 'utf8');
    fs.writeFileSync(path.join(fixtureRoot, 'scripts', 'untracked.js'), '', 'utf8');
    fs.mkdirSync(path.join(fixtureRoot, 'scripts', 'directory.js'));
    const workflowTexts = [[
      'fixture.yml',
      [
        'node scripts/tracked.js',
        'node ./scripts/missing-dot.js',
        'node "scripts/missing-double.js"',
        "node 'scripts/missing-single.js'",
        'node --trace-warnings scripts/missing-option.js',
        'node scripts/untracked.js',
        'node scripts/directory.js',
      ].join('\n'),
    ]];
    assert.deepStrictEqual(findInvalidWorkflowScriptTargets(
      workflowTexts,
      fixtureRoot,
      new Set(['scripts/tracked.js', 'scripts/directory.js']),
    ), [
      'fixture.yml:scripts/missing-dot.js',
      'fixture.yml:scripts/missing-double.js',
      'fixture.yml:scripts/missing-single.js',
      'fixture.yml:scripts/missing-option.js',
      'fixture.yml:scripts/untracked.js',
      'fixture.yml:scripts/directory.js',
    ]);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

testWorkflowScriptTargetValidation();
assertWorkflowScriptTargetsExist();
assert.ok(fs.existsSync(merrySource), 'Merry workflow helper must exist');
assert.ok(fs.existsSync(dopeySource), 'Dopey workflow helper must exist');
const merryWorkflowText = fs.readFileSync(merryWorkflow, 'utf8');
assert.match(merryWorkflowText, /contents:\s*read/, 'public Merry workflow must be read-only');
assert.match(merryWorkflowText, /actions\/upload-artifact@v4/, 'public Merry workflow must publish its generated changelog as an artifact');
assert.ok(!merryWorkflowText.includes('git-auto-commit-action'),
  'public Merry workflow must not create unsigned commits on protected main');

for (const script of [merrySource, dopeySource]) {
  execFileSync(process.execPath, ['--check', script], { stdio: 'pipe' });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'salt-merry-test-'));
try {
  execFileSync('git', ['init', '--quiet'], { cwd: tmp });
  execFileSync('git', ['config', 'user.name', 'Workflow Test'], { cwd: tmp });
  execFileSync('git', ['config', 'user.email', 'workflow-test@example.invalid'], { cwd: tmp });
  fs.mkdirSync(path.join(tmp, 'scripts'));
  fs.copyFileSync(merrySource, path.join(tmp, 'scripts', 'merry-changelog.js'));
  fs.writeFileSync(path.join(tmp, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
  fs.writeFileSync(path.join(tmp, 'feature.txt'), 'public feature\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: tmp });
  execFileSync('git', ['commit', '--quiet', '-m', 'feat: public workflow helper'], { cwd: tmp });
  execFileSync('git', ['update-ref', 'refs/tags/--output=owned', 'HEAD'], { cwd: tmp });
  fs.appendFileSync(path.join(tmp, 'feature.txt'), 'hostile markdown\n', 'utf8');
  execFileSync('git', ['add', 'feature.txt'], { cwd: tmp });
  execFileSync('git', ['commit', '--quiet', '-m', 'feat: [unsafe](javascript:alert(1)) <script>\x1ffield'], { cwd: tmp });
  const hostileShortHash = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();

  const shimDir = path.join(tmp, 'git-shim');
  fs.mkdirSync(shimDir);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const gitShim = path.join(shimDir, 'git');
  fs.writeFileSync(gitShim, `#!/bin/sh
if [ "$1" = "describe" ]; then
  echo "fatal: simulated repository failure" >&2
  exit 128
fi
exec "$REAL_GIT" "$@"
`, 'utf8');
  fs.chmodSync(gitShim, 0o755);
  const failedGit = spawnSync(process.execPath, ['scripts/merry-changelog.js'], {
    cwd: tmp,
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, REAL_GIT: realGit },
    encoding: 'utf8',
  });
  assert.notEqual(failedGit.status, 0, 'Merry must propagate unexpected git status 128 failures');
  assert.equal(fs.readFileSync(path.join(tmp, 'CHANGELOG.md'), 'utf8'), '# Changelog\n');

  execFileSync(process.execPath, ['scripts/merry-changelog.js'], { cwd: tmp, stdio: 'pipe' });
  const first = fs.readFileSync(path.join(tmp, 'CHANGELOG.md'), 'utf8');
  assert.equal((first.match(/<!-- merry:start -->/g) || []).length, 1);
  assert.equal((first.match(/<!-- merry:end -->/g) || []).length, 1);
  assert.match(first, /feat:/);
  assert.ok(!first.includes('[unsafe](javascript:'), 'commit subjects must not inject Markdown links');
  assert.ok(!first.includes('<script>'), 'commit subjects must not inject HTML');
  assert.ok(first.includes(`(${hostileShortHash}) — Workflow Test`),
    'control characters in subjects must not shift hash or author fields');
  assert.ok(!fs.existsSync(path.join(tmp, 'owned..HEAD')), 'option-like tags must not become Git options');

  execFileSync('git', ['add', 'CHANGELOG.md'], { cwd: tmp });
  const nextDay = { ...process.env, GIT_AUTHOR_DATE: '2030-01-02T00:00:00Z', GIT_COMMITTER_DATE: '2030-01-02T00:00:00Z' };
  execFileSync('git', ['commit', '--quiet', '-m', 'chore(merry): update CHANGELOG.md [skip ci]'], { cwd: tmp, env: nextDay });
  execFileSync(process.execPath, ['scripts/merry-changelog.js'], { cwd: tmp, stdio: 'pipe' });
  const second = fs.readFileSync(path.join(tmp, 'CHANGELOG.md'), 'utf8');
  assert.equal(second, first, 'Merry output must remain idempotent after its generated commit on a later day');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const missingPlaywrightDir = fs.mkdtempSync(path.join(os.tmpdir(), 'salt-dopey-test-'));
let missingPlaywright;
try {
  const isolatedDopey = path.join(missingPlaywrightDir, 'dopey-smoke.js');
  fs.copyFileSync(dopeySource, isolatedDopey);
  missingPlaywright = spawnSync(process.execPath, [isolatedDopey], {
    cwd: missingPlaywrightDir,
    env: { ...process.env, NODE_PATH: '' },
    encoding: 'utf8',
  });
} finally {
  fs.rmSync(missingPlaywrightDir, { recursive: true, force: true });
}
assert.equal(missingPlaywright.status, 78, 'Dopey must fail clearly when Playwright is unavailable');
assert.match(missingPlaywright.stderr, /Playwright not installed/);

const closeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'salt-dopey-close-test-'));
try {
  const moduleDir = path.join(closeTestDir, 'node_modules', 'playwright');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.copyFileSync(dopeySource, path.join(closeTestDir, 'dopey-smoke.js'));
  const marker = path.join(closeTestDir, 'browser-closed');
  fs.writeFileSync(path.join(moduleDir, 'index.js'), `
    const fs = require('fs');
    module.exports = {
      chromium: {
        launch: async () => ({
          newContext: async () => ({ newPage: async () => { throw new Error('newPage failed'); } }),
          close: async () => fs.writeFileSync(process.env.DOPEY_CLOSE_MARKER, 'closed')
        })
      }
    };
  `, 'utf8');
  const failedSetup = spawnSync(process.execPath, ['dopey-smoke.js'], {
    cwd: closeTestDir,
    env: { ...process.env, NODE_PATH: '', DOPEY_CLOSE_MARKER: marker },
    encoding: 'utf8',
  });
  assert.equal(failedSetup.status, 2, 'Dopey must report unexpected browser setup failures');
  assert.ok(fs.existsSync(marker), 'Dopey must close Chromium after a post-launch failure');
} finally {
  fs.rmSync(closeTestDir, { recursive: true, force: true });
}

console.log('Workflow helper tests passed');
