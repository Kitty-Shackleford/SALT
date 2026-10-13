'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const kit = path.join(root, 'templates', 'dayz-server-automation');
const {
  parseIntegrationManifest,
  summarizeIntegrationHealth,
  inspectGitHubActionsIntegration,
} = require('../services/githubActionsIntegrationService');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const manifestInput = {
  schema_version: 1,
  platform: 'dayz',
  server_id: '15580969',
  integration_version: '1.0.0',
  generated_at: '2026-08-28T20:00:00.000Z',
  capabilities: ['server_status', 'player_count'],
  data_endpoints: [{ name: 'server_status', path: 'dayz/data/current/server-status.json', format: 'json' }],
  actions: [{
    id: 'dayz-monitor',
    name: 'Server Monitor',
    version: '1.0.0',
    workflow: '.github/workflows/dayz-monitor.yml',
    capabilities: ['server_status', 'player_count'],
    data_outputs: ['dayz/data/current/server-status.json'],
    expected_interval_minutes: 15,
  }],
};
const manifest = parseIntegrationManifest(JSON.stringify(manifestInput), { expectedServerId: '15580969' });
assert.equal(manifest.serverId, '15580969');
assert.deepStrictEqual(manifest.capabilities, ['server_status', 'player_count']);
assert.throws(
  () => parseIntegrationManifest(JSON.stringify({ ...manifestInput, server_id: 'other' }), { expectedServerId: '15580969' }),
  /server ID/i
);
assert.throws(
  () => parseIntegrationManifest(JSON.stringify({ ...manifestInput, pages_url: 'http://example.test/' })),
  /Pages URL/
);
assert.throws(
  () => parseIntegrationManifest(JSON.stringify({ ...manifestInput, capabilities: [] })),
  /action capabilities/
);
for (const invalid of [
  { ...manifestInput, integration_version: 'not-semver' },
  { ...manifestInput, pages_url: false },
  { ...manifestInput, $schema: false },
  { ...manifestInput, unexpected: true },
  { ...manifestInput, actions: [{ ...manifestInput.actions[0], version: 'not-semver' }] },
  { ...manifestInput, actions: [{ ...manifestInput.actions[0], data_outputs: undefined }] },
  { ...manifestInput, actions: [{ ...manifestInput.actions[0], unexpected: true }] },
  { ...manifestInput, actions: [{ ...manifestInput.actions[0], expected_interval_minutes: '15' }] },
  { ...manifestInput, actions: [{ ...manifestInput.actions[0], expected_interval_minutes: 1.5 }] },
]) assert.throws(() => parseIntegrationManifest(JSON.stringify(invalid)), /integration manifest/i);

const health = summarizeIntegrationHealth(manifest, [{
  path: '.github/workflows/dayz-monitor.yml',
  state: 'active',
  run: { status: 'completed', conclusion: 'success', updatedAt: '2026-08-28T20:05:00.000Z' },
}], new Date('2026-08-28T20:10:00.000Z'));
assert.equal(health.status, 'healthy');
assert.equal(health.actions[0].status, 'healthy');

const stale = summarizeIntegrationHealth(manifest, [{
  path: '.github/workflows/dayz-monitor.yml',
  state: 'active',
  run: { status: 'completed', conclusion: 'success', updatedAt: '2026-08-28T18:00:00.000Z' },
}], new Date('2026-08-28T20:10:00.000Z'));
assert.equal(stale.actions[0].status, 'stale');

const missing = summarizeIntegrationHealth(manifest, [{
  path: '.github/workflows/dayz-monitor.yml',
  state: 'missing',
  run: null,
}], new Date('2026-08-28T20:10:00.000Z'));
assert.equal(missing.actions[0].status, 'not_installed');

const invalidTimestamp = summarizeIntegrationHealth(manifest, [{
  path: '.github/workflows/dayz-monitor.yml',
  state: 'active',
  run: { status: 'completed', conclusion: 'success', updatedAt: 'not-a-date' },
}], new Date('2026-08-28T20:10:00.000Z'));
assert.equal(invalidTimestamp.actions[0].status, 'unknown');

assert.equal(typeof inspectGitHubActionsIntegration, 'function');

for (const file of [
  'README.md',
  'dayz-integration.json',
  '.github/workflows/dayz-monitor.yml',
  '.github/workflows/dayz-validate.yml',
  '.github/workflows/dayz-backup.yml',
  '.github/workflows/dayz-pages.yml',
  'dayz/scripts/collect-status.mjs',
  'dayz/scripts/validate-config.py',
  'dayz/scripts/backup.mjs',
  'dayz/scripts/build-manifest.mjs',
  'dayz/pages/index.html',
  'dayz/pages/app.js',
  'dayz/pages/styles.css',
  'dayz/schemas/integration-manifest.schema.json',
  'dayz/schemas/server-status.schema.json',
  'dayz/schemas/validation-report.schema.json',
]) assert.ok(fs.existsSync(path.join(kit, file)), `missing kit file ${file}`);

const packageJson = JSON.parse(read('package.json'));
assert.match(
  packageJson.scripts.lint,
  /scripts\/provider-mutation-pg-test\.js/,
  'the canonical lint gate must include the PostgreSQL provider mutation regression'
);

const ciWorkflow = read('.github/workflows/ci.yml');
assert.match(
  ciWorkflow,
  /name:\s*Use supported npm audit client[\s\S]*npm install --global npm@12\.0\.2[\s\S]*name:\s*Install dependencies/,
  'CI must install the pinned bulk-audit npm client before dependency installation and auditing'
);
assert.match(
  ciWorkflow,
  /image:\s*postgres:15(?:-alpine)?/,
  'CI PostgreSQL version must match the PostgreSQL 15 production runtime required by migrations'
);
assert.match(
  ciWorkflow,
  /--health-cmd\s+["']pg_isready -U dayz-dashboard["']/,
  'CI PostgreSQL health command must be passed to Docker as one quoted argument'
);

assert.match(
  ciWorkflow,
  /ENCRYPTION_KEY=\$\(node -e ["'][^\n]+randomBytes\(32\)[^\n]+["']\) npm test/,
  'CI unit tests must receive an ephemeral 32-byte encryption key without storing a credential'
);
assert.match(
  ciWorkflow,
  /POSTGRES_DB:\s+dayz-dashboard-test/,
  'CI PostgreSQL rehearsals must run against an explicitly dedicated test database'
);
assert.match(
  ciWorkflow,
  /PROVIDER_MUTATION_PG_TEST_DATABASE:\s+postgres:\/\/dayz-dashboard:[^\s]+@127\.0\.0\.1:5432\/dayz-dashboard-test/,
  'CI must exercise provider recovery constraints and lock handoff against a dedicated PostgreSQL 15 test database'
);
assert.match(
  ciWorkflow,
  /FINANCIAL_IDEMPOTENCY_PG_TEST_DATABASE:\s+postgres:\/\/dayz-dashboard:[^\s]+@127\.0\.0\.1:5432\/dayz-dashboard-test[\s\S]*FINANCIAL_RETENTION_PG_TEST_DATABASE:\s+postgres:\/\/dayz-dashboard:[^\s]+@127\.0\.0\.1:5432\/dayz-dashboard-test/,
  'CI must run both financial PostgreSQL rehearsals against the dedicated test database'
);
assert.match(
  ciWorkflow,
  /ports:\s*\n\s*-\s*5432:5432/,
  'CI must publish the PostgreSQL service port to the host runner used by the database smoke test'
);
assert.match(
  ciWorkflow,
  /POSTGRES_HOST:\s+127\.0\.0\.1/,
  'CI database smoke tests must use the IPv4 loopback address exposed by the PostgreSQL service container'
);
assert.match(
  ciWorkflow,
  /npm ci --prefix bot/,
  'CI must install the bot dependencies required by the root test suite'
);

const dopeyWorkflow = read('.github/workflows/dopey.yml');
const dopeySmoke = read('scripts/dopey-smoke.js');
assert.match(
  dopeySmoke,
  /waitUntil:\s*['"]networkidle['"]/,
  'Dopey must wait for client-side redirects to settle before inspecting the page DOM'
);
assert.match(
  dopeyWorkflow,
  /npm i -D playwright@1\.62\.1/,
  'Dopey must use a Playwright version that supports Ubuntu 24.04 runners'
);
assert.match(
  dopeyWorkflow,
  /npx playwright install --with-deps chromium/,
  'Dopey must install its pinned Playwright Chromium browser and system dependencies'
);
assert.match(
  dopeyWorkflow,
  /python3 -m http\.server 8080 --directory public/,
  'Dopey must use a runner-provided static server that cannot be removed during dependency installation'
);
assert.ok(
  dopeyWorkflow.indexOf('npx playwright install --with-deps chromium')
    < dopeyWorkflow.indexOf('python3 -m http.server 8080 --directory public'),
  'Dopey must install dependencies before starting the static server'
);
assert.match(
  dopeyWorkflow,
  /curl --fail --silent --show-error http:\/\/(localhost|127\.0\.0\.1):8080\//,
  'Dopey must verify the static server is reachable before launching the browser smoke test'
);

const merryWorkflow = read('.github/workflows/merry.yml');
assert.match(
  merryWorkflow,
  /permissions:\s*\n\s*contents: write/,
  'Merry must grant its workflow token contents write access to push CHANGELOG.md'
);
assert.doesNotMatch(merryWorkflow, /write-all/);

const forgeWorkflow = read('.github/workflows/forge.yml');
const piperWorkflow = read('.github/workflows/piper.yml');
for (const [name, workflow] of [['Forge', forgeWorkflow], ['Piper', piperWorkflow]]) {
  assert.doesNotMatch(
    workflow,
    /^\s*if:\s*.*\bsecrets\./m,
    `${name} must not reference the secrets context directly in an if expression`
  );
}
assert.match(
  forgeWorkflow,
  /id:\s*deploy-config[\s\S]*GITHUB_OUTPUT[\s\S]*steps\.deploy-config\.outputs\.configured/,
  'Forge must derive a non-secret deployment guard before conditionally running deployment steps'
);
assert.match(
  forgeWorkflow,
  /push_images:[\s\S]*type:\s*boolean[\s\S]*default:\s*false[\s\S]*deploy:[\s\S]*type:\s*boolean[\s\S]*default:\s*false/,
  'Forge manual runs must default to neither publishing images nor deploying'
);
assert.match(forgeWorkflow, /DEPLOY_REQUESTED:\s*\$\{\{\s*github\.event_name\s*==\s*'push'\s*\|\|\s*inputs\.deploy\s*\}\}/);
assert.match(
  forgeWorkflow,
  /name:\s*Validate image tag[\s\S]*IMAGE_TAG[\s\S]*\{0,127\}/,
  'Forge must reject invalid user-supplied Docker tags before building'
);
assert.match(
  forgeWorkflow,
  /jobs:[\s\S]*build:[\s\S]*outputs:[\s\S]*backend_digest:[\s\S]*steps\.backend-build\.outputs\.digest[\s\S]*bot_digest:[\s\S]*steps\.bot-build\.outputs\.digest[\s\S]*source_sha:[\s\S]*github\.sha/,
  'Forge must bind deployment inputs to digests produced by the exact checked-out SHA'
);
assert.match(forgeWorkflow, /npm ci[\s\S]*npm ci --prefix bot[\s\S]*ENCRYPTION_KEY=\$\(node -e ["'][^\n]+randomBytes\(32\)[^\n]+["']\) npm test[\s\S]*npm run lint[\s\S]*id:\s*backend-build/);
assert.strictEqual(
  (forgeWorkflow.match(/labels:\s*org\.opencontainers\.image\.revision=\$\{\{ github\.sha \}\}/g) || []).length,
  2,
  'Forge must label both backend and bot images with the exact tested SHA'
);
assert.match(forgeWorkflow, /IMAGES_PUBLISHED:\s*\$\{\{ needs\.build\.outputs\.published \}\}[\s\S]*\$IMAGES_PUBLISHED["']?\s*==\s*["']true["']/);
assert.match(forgeWorkflow, /BACKEND_IMAGE:[^\n]*@\$\{\{ needs\.build\.outputs\.backend_digest \}\}/);
assert.match(forgeWorkflow, /BOT_IMAGE:[^\n]*@\$\{\{ needs\.build\.outputs\.bot_digest \}\}/);
assert.match(forgeWorkflow, /git checkout --detach "\$source_sha"/);
assert.match(
  forgeWorkflow,
  /concurrency:\s*\n\s*group:\s*forge-staging-deploy\s*\n\s*cancel-in-progress:\s*false/,
  'Forge staging deployments must serialize access to the shared remote deployment directory'
);
assert.match(
  forgeWorkflow,
  /name:\s*Verify clean tested tree[\s\S]*git status --porcelain --untracked-files=all[\s\S]*name:\s*Set up Docker Buildx/,
  'Forge must reject tracked or untracked build-context changes after tests and before image builds'
);
assert.match(
  forgeWorkflow,
  /git checkout --detach "\$source_sha"[\s\S]*git status --porcelain --untracked-files=all[\s\S]*docker-compose -f docker-compose\.yml/,
  'Forge must reject dirty remote state and use only the reviewed Compose file'
);
assert.doesNotMatch(
  forgeWorkflow,
  /(?<!-f docker-compose\.yml )docker-compose\s+(?:up|pull|run|ps)\b/,
  'Every remote Compose command must explicitly select docker-compose.yml'
);
assert.match(forgeWorkflow, /docker-compose -f docker-compose\.yml up[^\n]*--no-build/);
assert.match(
  forgeWorkflow,
  /if \[\[ "\$DEPLOY_REQUESTED" == "true" \]\]; then[\s\S]*exit 1[\s\S]*configured=false/,
  'A requested deployment with missing publication or SSH prerequisites must fail instead of succeeding as a no-op'
);
assert.match(
  forgeWorkflow,
  /postgres_container=\$\(docker-compose -f docker-compose\.yml ps -q postgres\)[\s\S]*for attempt in \{1\.\.30\}[\s\S]*\.State\.Health\.Status[\s\S]*docker create/,
  'Forge must require bounded PostgreSQL health before running the digest-bound migration container'
);
assert.match(
  forgeWorkflow,
  /docker-compose -f docker-compose\.yml stop backend bot[\s\S]*docker create/,
  'Old application containers must not continue accessing the database during migrations'
);
assert.match(
  forgeWorkflow,
  /for attempt in \{1\.\.30\}[\s\S]*curl[\s\S]*127\.0\.0\.1:3000[\s\S]*Bot initialization complete/,
  'Forge must perform bounded backend and bot readiness checks after startup'
);
assert.match(
  forgeWorkflow,
  /postgres_container=\$\(docker-compose -f docker-compose\.yml ps -q postgres\)[\s\S]*git checkout --detach "\$source_sha"[\s\S]*test "\$\(docker-compose -f docker-compose\.yml ps -q postgres\)" = "\$postgres_container"/,
  'Forge must preserve the existing PostgreSQL container identity across checkout and migration'
);
assert.doesNotMatch(forgeWorkflow, /docker-compose -f docker-compose\.yml up -d postgres/,
  'A scoped application rollout must not recreate PostgreSQL');
assert.match(
  forgeWorkflow,
  /docker create[\s\S]*"\$backend_image" node scripts\/init-db\.js[\s\S]*\.Config\.Cmd[\s\S]*docker start[\s\S]*docker wait[\s\S]*migration_exit/,
  'Forge must create, inspect, and verify the exact digest-bound migration container before removing it'
);
assert.match(
  forgeWorkflow,
  /docker start[\s\S]*timeout --signal=TERM --kill-after=30s 15m docker wait "\$migration_container"[\s\S]*cleanup_migration/,
  'Forge must bound migration completion and retain forced cleanup on timeout'
);
assert.match(
  forgeWorkflow,
  /--force-recreate --no-deps --no-build backend bot[\s\S]*Bot initialization complete/,
  'Forge must use fresh application containers and a post-initialization bot readiness marker'
);
assert.match(
  forgeWorkflow,
  /name:\s*Prepare exact source build context[\s\S]*git archive "\$GITHUB_SHA"[\s\S]*id:\s*backend-build[\s\S]*context:\s*\/tmp\/dayz-build-context[\s\S]*id:\s*bot-build[\s\S]*context:\s*\/tmp\/dayz-build-context/,
  'Forge image builds must consume a clean archive of the exact tested source SHA'
);
const dockerIgnore = read('.dockerignore');
for (const ignoredPath of ['build', 'dist', '*.log', 'logs', 'tmp', 'temp', 'coverage']) {
  assert(dockerIgnore.split(/\r?\n/).includes(ignoredPath),
    `.dockerignore must exclude ignored build-context path ${ignoredPath}`);
}
assert.match(forgeWorkflow, /\[\[ "\$BACKEND_IMAGE" =~ \^\[a-z0-9/,
  'Forge must validate the complete backend image reference, not only its digest suffix');
assert.match(forgeWorkflow, /\[\[ "\$BOT_IMAGE" =~ \^\[a-z0-9/,
  'Forge must validate the complete bot image reference, not only its digest suffix');
assert.match(
  forgeWorkflow,
  /\[\[ "\$DEPLOY_HOST" != -\* \]\]/,
  'Forge must reject option-like SSH hosts before invoking OpenSSH'
);
assert.match(
  forgeWorkflow,
  /ssh -- "\$DEPLOY_HOST" bash -s --/,
  'Forge must terminate OpenSSH options before the validated deployment host'
);
const deployHostPattern = forgeWorkflow.match(/\[\[ "\$DEPLOY_HOST" =~ (\^[^\n ]+\$) \]\]/)?.[1];
assert.ok(deployHostPattern, 'Forge must expose one explicit deployment-host grammar');
for (const validHost of ['deploy.example.com', 'operator@deploy.example.com', '127.0.0.1']) {
  const result = spawnSync('bash', ['-c', `[[ "$DEPLOY_HOST" =~ ${deployHostPattern} ]]`], {
    env: { ...process.env, DEPLOY_HOST: validHost },
  });
  assert.strictEqual(result.status, 0, `Forge must accept valid deployment host ${validHost}`);
}
for (const invalidHost of ['-V', '-Fconfig', '@host', 'user@', 'user@@host', '']) {
  const result = spawnSync('bash', ['-c', `[[ "$DEPLOY_HOST" =~ ${deployHostPattern} ]]`], {
    env: { ...process.env, DEPLOY_HOST: invalidHost },
  });
  assert.notStrictEqual(result.status, 0, `Forge must reject malformed deployment host ${invalidHost}`);
}
assert.match(
  forgeWorkflow,
  /app_start_epoch=\$\(date \+%s\)[\s\S]*\/readyz\?minimumBotStartedAt=\$app_start_epoch/,
  'Forge readiness must prove database access and a bot heartbeat from the new deployment'
);
assert.match(
  forgeWorkflow,
  /postgres_container=.*[\s\S]*docker wait[\s\S]*test "\$\(docker-compose -f docker-compose\.yml ps -q postgres\)" = "\$postgres_container"/,
  'Forge must recheck PostgreSQL identity after migration completion'
);
assert.match(
  forgeWorkflow,
  /test "\$deployment_ready" = "true"[\s\S]*test "\$\(docker-compose -f docker-compose\.yml ps -q postgres\)" = "\$postgres_container"[\s\S]*\.State\.Health\.Status/,
  'Forge must recheck PostgreSQL identity and health after the complete application rollout'
);
assert.doesNotMatch(
  forgeWorkflow,
  /docker-compose(?:\s+-f\s+docker-compose\.yml)?\s+pull[^\n]*(?:\|\|\s*true|;\s*true)/,
  'Forge must not suppress immutable image pull failures'
);
const compose = read('docker-compose.yml');
assert.match(compose, /db-init:[\s\S]*?image:\s*\$\{BACKEND_IMAGE:-dayz-dashboard:local\}/);
assert.match(compose, /backend:[\s\S]*image:\s*\$\{BACKEND_IMAGE:-dayz-dashboard:local\}/);
assert.match(compose, /bot:[\s\S]*image:\s*\$\{BOT_IMAGE:-dayz-dashboard-bot:local\}/);

assert.match(
  piperWorkflow,
  /IMAGE_TAG:\s*\$\{\{\s*inputs\.version\s*\|\|\s*\(github\.event_name\s*==\s*'push'\s*&&\s*github\.ref_name\)\s*\|\|\s*github\.sha\s*\}\}/,
  'Piper manual builds without a version must use the SHA instead of a possibly invalid branch name'
);
assert.match(
  piperWorkflow,
  /name:\s*Validate image tag[\s\S]*IMAGE_TAG[\s\S]*\{0,127\}/,
  'Piper must reject invalid user-supplied Docker tags before building'
);
assert.match(
  piperWorkflow,
  /push_images:[\s\S]*type:\s*boolean[\s\S]*default:\s*false/,
  'Piper manual runs must not publish images unless explicitly requested'
);
assert.match(piperWorkflow, /file:\s*\.\/Dockerfile\.bot|docker build[^\n]*-f\s+(?:\.\/)?Dockerfile\.bot/);
assert.match(
  piperWorkflow,
  /if:\s*startsWith\(github\.ref,\s*'refs\/tags\/v'\)\s*\|\|\s*inputs\.version\s*!=\s*''/,
  'Piper must create a release only for a version tag or an explicit manual version'
);
assert.match(piperWorkflow, /permissions:\s*\n\s*contents:\s*write/);
assert.doesNotMatch(piperWorkflow, /write-all/);

const monitor = read('templates/dayz-server-automation/.github/workflows/dayz-monitor.yml');
assert.match(monitor, /workflow_dispatch:/);
assert.match(monitor, /schedule:/);
assert.match(monitor, /permissions:\s*\n\s*contents: write/);
assert.doesNotMatch(monitor, /write-all/);
assert.match(monitor, /secrets\.NITRADO_API_TOKEN/);

const backup = read('templates/dayz-server-automation/.github/workflows/dayz-backup.yml');
assert.match(backup, /actions\/upload-artifact@[0-9a-f]{40} # v/);
assert.doesNotMatch(backup, /git add/);
const kitReadme = read('templates/dayz-server-automation/README.md');
assert.match(kitReadme, /\["\/noftp\/dayzxb_missions"\]/);
assert.match(kitReadme, /active mission/i);

const pages = read('templates/dayz-server-automation/.github/workflows/dayz-pages.yml');
assert.match(pages, /pages: write/);
assert.match(pages, /id-token: write/);
assert.match(pages, /_site\/data\/server-status\.json/);
assert.match(pages, /_site\/reports\/validation\.json/);
const pagesApp = read('templates/dayz-server-automation/dayz/pages/app.js');
assert.match(pagesApp, /data\/server-status\.json/);
assert.match(pagesApp, /reports\/validation\.json/);
for (const workflow of [monitor, backup, pages, read('templates/dayz-server-automation/.github/workflows/dayz-validate.yml')]) {
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d/);
  assert.match(workflow, /uses:\s+actions\/[a-z-]+@[0-9a-f]{40} # v/);
}

const aiRoute = read('routes/ai.js');
assert.match(aiRoute, /github\/integration/);
const aiPage = read('public/dashboard/ai-assistant.html');
assert.match(aiPage, /githubIntegrationStatus/);
const personalRepoStart = aiPage.indexOf('id="currentRepoDisplay"');
const canonicalIntegrationStart = aiPage.indexOf('id="canonicalIntegrationDisplay"');
assert(personalRepoStart >= 0 && canonicalIntegrationStart > personalRepoStart);
assert(aiPage.indexOf('</div>', personalRepoStart) < canonicalIntegrationStart);
assert.match(aiRoute, /expectedServerId/);
assert.match(aiRoute, /INSERT INTO github_action_integrations/);
assert.match(aiRoute, /DELETE FROM github_action_integrations/);
assert.match(aiRoute, /db\.transaction/);
const browser = read('public/js/ai-assistant.js');
assert.match(browser, /github\/integration/);
assert.doesNotMatch(browser, /github\/commits\?perPage=5/);
assert.doesNotMatch(browser, /currentRepoDisplay.*contains\('hidden'\)/);
assert.match(browser, /await loadRepoLink\(\);\s*await loadGitHubOperations\(\);/);
assert.match(browser, /Failed to disconnect GitHub/);
assert.match(browser, /Failed to unlink repository/);
const settingsPage = read('public/dashboard/settings.html');
assert.match(settingsPage, /GitHub Actions Integration/);
assert.match(settingsPage, /\/dashboard\/ai-assistant#repo/);
const botAuth = read('bot/utils/commandAuthorization.js');
assert.match(botAuth, /'github': 'server_manage'/);
const botCommand = read('bot/commands/github.js');
assert.match(botCommand, /github_action_integrations/);
assert.match(botCommand, /JOIN guild_roles/);
assert.match(botCommand, /server_role_assignments/);
assert.match(botCommand, /sra\.status = 'active'/);

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-actions-kit-'));
try {
  const validatorScript = path.join(kit, 'dayz/scripts/validate-config.py');
  const emptyValidation = spawnSync('python3', [validatorScript], { cwd: runtimeDir, encoding: 'utf8' });
  assert.equal(emptyValidation.status, 0, emptyValidation.stderr);
  const emptyReport = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'dayz/reports/current/validation.json'), 'utf8'));
  assert.equal(emptyReport.status, 'no_files');

  fs.mkdirSync(path.join(runtimeDir, 'dayz/config'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'dayz/config/broken.xml'), '<events>');
  const invalidValidation = spawnSync('python3', [validatorScript], { cwd: runtimeDir, encoding: 'utf8' });
  assert.notEqual(invalidValidation.status, 0);
  const invalidReport = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'dayz/reports/current/validation.json'), 'utf8'));
  assert.equal(invalidReport.status, 'invalid');

  const backupScript = pathToFileURL(path.join(kit, 'dayz/scripts/backup.mjs')).href;
  const wrapper = `
    globalThis.fetch = async input => {
      const url = String(input);
      if (url.endsWith('/gameservers')) return new Response(JSON.stringify({ data: { gameserver: {
        game: 'dayzxb',
        game_specific: { path: '/games/account/noftp/dayzxb/' },
        settings: { config: { mission: process.env.MOCK_MISSION || 'dayzOffline.enoch' } },
        query: { map: 'dayzOffline.chernarusplus' }
      } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('/file_server/list')) {
        if (process.env.EXPECT_LIST_PATH && !url.includes(encodeURIComponent(process.env.EXPECT_LIST_PATH))) {
          throw new Error('Backup did not resolve the expected provider path');
        }
        return new Response(JSON.stringify({ data: { entries:
          process.env.MOCK_EMPTY_LIST === 'true' ? [] : [
            { name: 'config.xml', type: 'file', path: process.env.MOCK_ENTRY_PATH || '/noftp/test/config.xml' }
          ]
        } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/file_server/download')) return new Response(JSON.stringify({ data: { token: {
        url: 'https://signed.example/config.xml'
      } } }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('config', { status: 200, headers: { 'content-length': '6' } });
    };
    await import(${JSON.stringify(backupScript)});
  `;
  const runtimeEnv = {
    ...process.env,
    NITRADO_SERVER_ID: '15580969',
    NITRADO_API_TOKEN: ['test', 'token'].join('-'),
    DAYZ_BACKUP_PATHS_JSON: '["/noftp/test"]',
    DAYZ_BACKUP_MAX_BYTES: '100',
  };
  const emptyBackup = spawnSync(process.execPath, ['--input-type=module', '-e', wrapper], {
    cwd: runtimeDir,
    env: { ...runtimeEnv, MOCK_EMPTY_LIST: 'true' },
    encoding: 'utf8',
  });
  assert.equal(emptyBackup.status, 0, emptyBackup.stderr);
  const emptyBackupMetadata = JSON.parse(fs.readFileSync(
    path.join(runtimeDir, 'dayz-backup/backup-metadata.json'),
    'utf8'
  ));
  assert.equal(emptyBackupMetadata.bytes, 0);

  fs.rmSync(path.join(runtimeDir, 'dayz-backup'), { recursive: true, force: true });
  const backup = spawnSync(process.execPath, ['--input-type=module', '-e', wrapper], {
    cwd: runtimeDir,
    env: runtimeEnv,
    encoding: 'utf8',
  });
  assert.equal(backup.status, 0, backup.stderr);
  assert.equal(fs.readFileSync(path.join(runtimeDir, 'dayz-backup/noftp/test/config.xml'), 'utf8'), 'config');

  fs.rmSync(path.join(runtimeDir, 'dayz-backup'), { recursive: true, force: true });
  const missionAlias = spawnSync(process.execPath, ['--input-type=module', '-e', wrapper], {
    cwd: runtimeDir,
    env: {
      ...runtimeEnv,
      DAYZ_BACKUP_PATHS_JSON: '["/noftp/dayzxb_missions"]',
      EXPECT_LIST_PATH: '/games/account/ftproot/dayzxb_missions/dayzOffline.enoch',
      MOCK_ENTRY_PATH: '/games/account/ftproot/dayzxb_missions/dayzOffline.enoch/config.xml',
    },
    encoding: 'utf8',
  });
  assert.equal(missionAlias.status, 0, missionAlias.stderr);
  assert.equal(fs.readFileSync(
    path.join(runtimeDir, 'dayz-backup/games/account/ftproot/dayzxb_missions/dayzOffline.enoch/config.xml'),
    'utf8'
  ), 'config');

  fs.rmSync(path.join(runtimeDir, 'dayz-backup'), { recursive: true, force: true });
  const escapedRoot = spawnSync(process.execPath, ['--input-type=module', '-e', wrapper], {
    cwd: runtimeDir,
    env: { ...runtimeEnv, MOCK_ENTRY_PATH: '/noftp/private/admin.cfg' },
    encoding: 'utf8',
  });
  assert.notEqual(escapedRoot.status, 0);
  assert.match(escapedRoot.stderr, /outside the configured roots/);
  assert.ok(!fs.existsSync(path.join(runtimeDir, 'dayz-backup/noftp/private/admin.cfg')));

  fs.rmSync(path.join(runtimeDir, 'dayz-backup'), { recursive: true, force: true });
  const prefixedRoot = spawnSync(process.execPath, ['--input-type=module', '-e', wrapper], {
    cwd: runtimeDir,
    env: {
      ...runtimeEnv,
      DAYZ_BACKUP_PATHS_JSON: '["/games/ni123_1/ftproot/dayzxb"]',
      MOCK_ENTRY_PATH: '/games/ni123_1/ftproot/dayzxb/config.xml',
    },
    encoding: 'utf8',
  });
  assert.equal(prefixedRoot.status, 0, prefixedRoot.stderr);
  assert.equal(fs.readFileSync(
    path.join(runtimeDir, 'dayz-backup/games/ni123_1/noftp/dayzxb/config.xml'),
    'utf8'
  ), 'config');

  fs.rmSync(path.join(runtimeDir, 'dayz-backup'), { recursive: true, force: true });
  const missionRoot = spawnSync(process.execPath, ['--input-type=module', '-e', wrapper], {
    cwd: runtimeDir,
    env: {
      ...runtimeEnv,
      DAYZ_BACKUP_PATHS_JSON: '["/games/ni123_1/ftproot/dayzxb_missions"]',
      MOCK_ENTRY_PATH: '/games/ni123_1/ftproot/dayzxb_missions/mission/config.xml',
    },
    encoding: 'utf8',
  });
  assert.equal(missionRoot.status, 0, missionRoot.stderr);
  assert.equal(fs.readFileSync(
    path.join(runtimeDir, 'dayz-backup/games/ni123_1/ftproot/dayzxb_missions/mission/config.xml'),
    'utf8'
  ), 'config');

  fs.rmSync(path.join(runtimeDir, 'dayz-backup'), { recursive: true, force: true });
  const oversized = spawnSync(process.execPath, ['--input-type=module', '-e', wrapper], {
    cwd: runtimeDir,
    env: { ...runtimeEnv, DAYZ_BACKUP_MAX_BYTES: '3' },
    encoding: 'utf8',
  });
  assert.notEqual(oversized.status, 0);
  assert.match(oversized.stderr, /DAYZ_BACKUP_MAX_BYTES/);

  const invalidLimit = spawnSync(process.execPath, ['--input-type=module', '-e', wrapper], {
    cwd: runtimeDir,
    env: { ...runtimeEnv, DAYZ_BACKUP_MAX_BYTES: 'not-a-number' },
    encoding: 'utf8',
  });
  assert.notEqual(invalidLimit.status, 0);
  assert.match(invalidLimit.stderr, /DAYZ_BACKUP_MAX_BYTES/);
} finally {
  fs.rmSync(runtimeDir, { recursive: true, force: true });
}

const partialFailureProbe = spawnSync(process.execPath, ['-e', `
  const assert = require('assert');
  const { inspectGitHubActionsIntegration } = require('./services/githubActionsIntegrationService');
  const input = ${JSON.stringify(JSON.stringify({
  ...manifestInput,
  actions: [manifestInput.actions[0], {
    ...manifestInput.actions[0],
    id: 'dayz-validator',
    name: 'Validator',
    workflow: '.github/workflows/dayz-validate.yml',
  }],
}))};
  const github = {
    getRepository: async () => ({ fullName: 'owner/repo', private: true }),
    getRepoFile: async () => ({ content: input }),
    listWorkflows: async () => [
      { id: 1, path: '.github/workflows/dayz-monitor.yml', state: 'active' },
      { id: 2, path: '.github/workflows/dayz-validate.yml', state: 'active' },
    ],
    listWorkflowRuns: async (_token, _owner, _repo, id) => {
      if (id === 2) throw new Error('forbidden');
      return [{ status: 'completed', conclusion: 'success', updatedAt: '2026-08-28T20:05:00.000Z' }];
    },
  };
  inspectGitHubActionsIntegration({ github, token: 'x', owner: 'owner', repo: 'repo', branch: 'main', expectedServerId: '15580969', now: new Date('2026-08-28T20:10:00.000Z') })
    .then(result => {
      assert.equal(result.actions[0].status, 'healthy');
      assert.equal(result.actions[1].status, 'unknown');
    })
    .catch(error => { console.error(error); process.exitCode = 1; });
`], { cwd: root, encoding: 'utf8' });
assert.equal(partialFailureProbe.status, 0, partialFailureProbe.stderr);

console.log('GitHub Actions automation kit tests passed');
