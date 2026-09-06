#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createLocalEnvironment } = require('./local-setup');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-local-runtime-'));

async function run() {
try {
  const targetPath = path.join(tempDir, '.env.local');
  createLocalEnvironment({
    templatePath: path.join(root, '.env.local.example'),
    targetPath,
  });

  const content = fs.readFileSync(targetPath, 'utf8');
  assert.match(content, /^DEPLOYMENT_MODE=local$/m);
  assert.match(content, /^DASHBOARD_URL=http:\/\/localhost:3000$/m);
  assert.match(content, /^SESSION_SECRET=[a-f0-9]{64}$/m);
  assert.match(content, /^ENCRYPTION_KEY=[a-f0-9]{64}$/m);
  assert.match(content, /^POSTGRES_PASSWORD=[A-Za-z0-9_-]{43}$/m);
  assert.strictEqual(fs.statSync(targetPath).mode & 0o777, 0o600);
  const dockerIgnore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
  assert.match(dockerIgnore, /^\.env\*$/m, 'local secrets can enter the Docker build context');
  const gitIgnore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(gitIgnore, /^!\.dockerignore$/m, '.dockerignore will not be included in commits');

  const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(serverSource, /app\.listen\(PORT, listenHost,/, 'local mode does not bind the Node listener explicitly');
  const { getListenHost } = require('../utils/publicConfig');
  assert.strictEqual(getListenHost({ DEPLOYMENT_MODE: ' LOCAL ' }), '127.0.0.1',
    'normalized local mode does not default to loopback');
  assert.strictEqual(getListenHost({ DEPLOYMENT_MODE: 'local', LISTEN_HOST: ' 127.0.0.1 ' }), '127.0.0.1',
    'explicit loopback listener is not normalized before binding');
  assert.strictEqual(getListenHost({ DEPLOYMENT_MODE: 'full' }), '0.0.0.0');
  assert.throws(
    () => createLocalEnvironment({ templatePath: path.join(root, '.env.local.example'), targetPath }),
    error => error?.code === 'EEXIST',
    'local setup overwrote an existing environment file'
  );

  const baseEnv = {
    ...process.env,
    DISCORD_CLIENT_ID: '900000000000000013',
    DISCORD_CLIENT_SECRET: 'local-test-client-secret',
    SESSION_SECRET: 's'.repeat(32),
    ENCRYPTION_KEY: 'a'.repeat(64),
    PORT: '3000',
    POSTGRES_PASSWORD: 'local-test-password',
    DEPLOYMENT_MODE: 'local',
    DASHBOARD_URL: 'http://localhost:3000',
    PLAYER_PORTAL_URL: 'http://localhost:3000',
    NODE_ENV: 'development',
    SESSION_SECURE_COOKIE: 'false',
  };
  const validatorProbe = "require('./utils/envValidator').validateEnv('web')";
  const valid = spawnSync(process.execPath, ['-e', validatorProbe], { cwd: root, env: baseEnv, encoding: 'utf8' });
  assert.strictEqual(valid.status, 0, valid.stderr);

  const exposedLocal = spawnSync(process.execPath, ['-e', validatorProbe], {
    cwd: root,
    env: { ...baseEnv, LISTEN_HOST: '0.0.0.0' },
    encoding: 'utf8',
  });
  assert.notStrictEqual(exposedLocal.status, 0, 'direct local mode accepted a public listener');

  const containerLocal = spawnSync(process.execPath, ['-e', validatorProbe], {
    cwd: root,
    env: { ...baseEnv, LISTEN_HOST: '0.0.0.0', LOCAL_CONTAINER_RUNTIME: 'true' },
    encoding: 'utf8',
  });
  assert.strictEqual(containerLocal.status, 0, containerLocal.stderr);

  const pm2Local = spawnSync(process.execPath, ['-e', "require('./ecosystem.config')"], {
    cwd: root,
    env: baseEnv,
    encoding: 'utf8',
  });
  assert.notStrictEqual(pm2Local.status, 0, 'PM2 accepted unsupported local mode');

  const pm2Full = spawnSync(process.execPath, ['-e', "require('./ecosystem.config')"], {
    cwd: root,
    env: { ...baseEnv, DEPLOYMENT_MODE: ' FULL ' },
    encoding: 'utf8',
  });
  assert.strictEqual(pm2Full.status, 0, pm2Full.stderr);

  const pm2Bot = spawnSync(process.execPath, ['-e', "const apps=require('./ecosystem.config').apps; if (apps.length !== 1 || apps[0].name !== 'dayz-dashboard-bot') process.exit(1)"], {
    cwd: root,
    env: { ...baseEnv, DEPLOYMENT_MODE: ' BoT ' },
    encoding: 'utf8',
  });
  assert.strictEqual(pm2Bot.status, 0, pm2Bot.stderr);

  const production = spawnSync(process.execPath, ['-e', validatorProbe], {
    cwd: root,
    env: { ...baseEnv, NODE_ENV: 'production' },
    encoding: 'utf8',
  });
  assert.notStrictEqual(production.status, 0, 'local mode accepted NODE_ENV=production');

  const secureCookie = spawnSync(process.execPath, ['-e', validatorProbe], {
    cwd: root,
    env: { ...baseEnv, SESSION_SECURE_COOKIE: 'true' },
    encoding: 'utf8',
  });
  assert.notStrictEqual(secureCookie.status, 0, 'local HTTP mode accepted secure-only cookies');

  const { deployCommands } = require('../bot/deploy-commands');
  await assert.rejects(
    deployCommands({
      rest: { put: async () => { throw new Error('Discord unavailable'); } },
      clientId: '900000000000000013',
      guildId: '900000000000000014',
      commands: [],
    }),
    /Discord unavailable/,
    'Discord command deployment swallowed a provider failure'
  );

  console.log('Local runtime tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
