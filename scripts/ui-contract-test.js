#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-ui-manifest-'));

try {
  fs.mkdirSync(path.join(fixtureRoot, 'src', 'app'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'public', 'admin'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'public', 'dashboard'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'public', 'js'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'public', 'admin', 'users.html'), '<!doctype html><title>Users</title>\n');
  fs.writeFileSync(
    path.join(fixtureRoot, 'public', 'dashboard', 'tasks.html'),
    '<!doctype html><title>Tasks</title><script src="/js/instance-config.js"></script><script src="https://cdn.example.test/chart.js"></script><script src="/js/taskManager.js?v=contract-1"></script>\n'
  );
  fs.writeFileSync(path.join(fixtureRoot, 'public', 'js', 'instance-config.js'), 'globalThis.config = {};\n');
  fs.writeFileSync(
    path.join(fixtureRoot, 'public', 'js', 'taskManager.js'),
    "fetch('/api/tasks');\nfetch('/api/tasks');\nfetch(`/api/tasks/${serverId}`);\nfetch('/api/concat/' + serverId);\nfetch(`/api/tasks/${serverId}`, { method: 'PATCH' });\nfetch(requestUrl, { method: verb });\nfetch('/api/options', opts);\nfetch('/api/spread', { ...options, credentials: 'same-origin' });\n"
  );
  fs.writeFileSync(path.join(fixtureRoot, 'src', 'app', 'registerRoutes.js'), `
function registerRoutes(app) {
  const pub = (...parts) => path.join(__dirname, '..', '..', 'public', ...parts);
  app.use('/admin/*', ensureAuthenticated, ensureAdmin, apiLimiter);
  app.get('/admin/users', (req, res) => {
    renderWithCsrf(pub('admin', 'users.html'), req, res);
  });
  app.get('/dashboard/tasks', apiLimiter, ensureAuthenticated, ensureHasServers, (req, res) => {
    if (req.isPlayerPortal) return res.redirect('/player');
    if (req.customPortal) return res.redirect(playerRedirect);
    renderWithCsrf(pub('dashboard', 'tasks.html'), req, res);
  });
  app.get('/automation', ensureAuthenticated, apiLimiter, ensureHasServers, (req, res) => {
    res.redirect('/dashboard/automation');
  });
}
`);

  const { buildManifest, serializeManifest } = require('./lib/ui-surface-manifest');
  const manifest = buildManifest(fixtureRoot);

  assert.deepStrictEqual(manifest.routes, [
    {
      method: 'GET',
      path: '/admin/users',
      kind: 'page',
      pageTargets: ['public/admin/users.html'],
      redirectTargets: [],
      declaredMiddleware: [],
      inheritedMiddleware: ['ensureAuthenticated', 'ensureAdmin', 'apiLimiter'],
    },
    {
      method: 'GET',
      path: '/automation',
      kind: 'redirect',
      pageTargets: [],
      redirectTargets: ['/dashboard/automation'],
      declaredMiddleware: ['ensureAuthenticated', 'apiLimiter', 'ensureHasServers'],
      inheritedMiddleware: [],
    },
    {
      method: 'GET',
      path: '/dashboard/tasks',
      kind: 'mixed',
      pageTargets: ['public/dashboard/tasks.html'],
      redirectTargets: ['/player', '{dynamic}'],
      declaredMiddleware: ['apiLimiter', 'ensureAuthenticated', 'ensureHasServers'],
      inheritedMiddleware: [],
    },
  ]);
  assert.deepStrictEqual(manifest.pages, [
    {
      file: 'public/admin/users.html',
      routes: ['/admin/users'],
      scripts: [],
    },
    {
      file: 'public/dashboard/tasks.html',
      routes: ['/dashboard/tasks'],
      scripts: ['/js/instance-config.js', 'https://cdn.example.test/chart.js', '/js/taskManager.js?v=contract-1'],
    },
  ]);
  assert.deepStrictEqual(manifest.capabilities, [
    {
      script: 'public/js/taskManager.js',
      transport: 'fetch',
      method: 'DYNAMIC',
      target: '{dynamic}',
      targetKind: 'unresolved',
    },
    {
      script: 'public/js/taskManager.js',
      transport: 'fetch',
      method: 'DYNAMIC',
      target: '/api/options',
      targetKind: 'literal',
    },
    {
      script: 'public/js/taskManager.js',
      transport: 'fetch',
      method: 'DYNAMIC',
      target: '/api/spread',
      targetKind: 'literal',
    },
    {
      script: 'public/js/taskManager.js',
      transport: 'fetch',
      method: 'GET',
      target: '/api/concat/{dynamic}',
      targetKind: 'template',
    },
    {
      script: 'public/js/taskManager.js',
      transport: 'fetch',
      method: 'GET',
      target: '/api/tasks',
      targetKind: 'literal',
    },
    {
      script: 'public/js/taskManager.js',
      transport: 'fetch',
      method: 'GET',
      target: '/api/tasks/{dynamic}',
      targetKind: 'template',
    },
    {
      script: 'public/js/taskManager.js',
      transport: 'fetch',
      method: 'PATCH',
      target: '/api/tasks/{dynamic}',
      targetKind: 'template',
    },
  ]);
  assert.strictEqual(serializeManifest(manifest), serializeManifest(buildManifest(fixtureRoot)));

  const repositoryManifest = buildManifest(root);
  assert.strictEqual(repositoryManifest.pages.length, 49, 'every current HTML document must remain inventoried');
  assert.deepStrictEqual(
    repositoryManifest.pages.filter(page => page.routes.length === 0).map(page => page.file),
    [
      'public/admin/feeds.html',
      'public/automation.html',
      'public/economy-dashboard.html',
      'public/economy-leaderboard.html',
      'public/economy-transactions.html',
      'public/index.html',
      'public/nitrado-settings.html',
      'public/onboarding.html',
    ],
    'unrouted legacy documents changed; review capability parity before adding or removing one'
  );
  for (const route of repositoryManifest.routes) {
    assert(!route.path.endsWith('.html'), `canonical route must not expose a direct HTML path: ${route.path}`);
    for (const target of route.pageTargets) {
      assert(fs.existsSync(path.join(root, target)), `canonical page target does not exist: ${target}`);
    }
  }
  for (const page of repositoryManifest.pages) {
    assert.strictEqual(new Set(page.scripts).size, page.scripts.length, `page loads a duplicate script: ${page.file}`);
    for (const source of page.scripts.filter(source => source.startsWith('/') && !source.startsWith('//'))) {
      const localSourcePath = source.split(/[?#]/, 1)[0];
      assert(fs.existsSync(path.join(root, 'public', localSourcePath)),
        `local page script does not exist: ${page.file} -> ${source}`);
    }
  }
  for (const capability of repositoryManifest.capabilities) {
    assert(fs.existsSync(path.join(root, capability.script)), `capability script does not exist: ${capability.script}`);
    assert(
      ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'DYNAMIC'].includes(capability.method),
      `unsupported capability method: ${capability.method}`
    );
  }

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.strictEqual(packageJson.scripts['manifest:ui'], 'node scripts/generate-ui-surface-manifest.js --write');
  assert.strictEqual(packageJson.scripts['manifest:ui:check'], 'node scripts/generate-ui-surface-manifest.js --check');
  assert.strictEqual(packageJson.scripts['test:ui-contract'], 'node scripts/ui-contract-test.js && npm run manifest:ui:check');
  assert.match(packageJson.scripts.test, /npm run test:ui-contract/);
  assert.match(packageJson.scripts.lint, /scripts\/lib\/ui-surface-manifest\.js/);

  const snapshotCheck = spawnSync(process.execPath, ['scripts/generate-ui-surface-manifest.js', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.strictEqual(snapshotCheck.status, 0, snapshotCheck.stderr || snapshotCheck.stdout);
  console.log('UI surface manifest route extraction tests passed');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
