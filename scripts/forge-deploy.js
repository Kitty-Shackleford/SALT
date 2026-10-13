#!/usr/bin/env node
// Forge — build images and optionally deploy via docker-compose

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd) {
  console.log('> ' + cmd);
  try { return execSync(cmd, { stdio: 'inherit' }); } catch (e) { throw e; }
}

const TAG = process.env.IMAGE_TAG || process.env.GITHUB_SHA || 'local';
const PUSH = process.env.PUSH === '1' || process.env.PUSH === 'true';
const DEPLOY = process.env.DEPLOY === '1' || process.env.DEPLOY === 'true';

(async () => {
  console.log(`Forge: building images with tag=${TAG} push=${PUSH} deploy=${DEPLOY}`);

  // Build root backend image if Dockerfile exists
  if (fs.existsSync('Dockerfile')) {
    run(`docker build -t dayz-dashboard:${TAG} .`);
    if (PUSH) {
      run(`docker push dayz-dashboard:${TAG}`);
    }
  } else {
    console.log('Forge: no root Dockerfile found; skipping backend build');
  }

  // Build bot image if bot/Dockerfile exists
  if (fs.existsSync('bot/Dockerfile')) {
    run(`docker build -t dayz-dashboard-bot:${TAG} bot`);
    if (PUSH) {
      run(`docker push dayz-dashboard-bot:${TAG}`);
    }
  } else {
    console.log('Forge: no bot Dockerfile found; skipping bot build');
  }

  if (DEPLOY) {
    // Attempt local docker-compose up if present
    if (fs.existsSync('docker-compose.yml') || fs.existsSync('docker-compose.yaml')) {
      console.log('Forge: running docker-compose up -d on CI runner (local deploy)');
      run('docker-compose pull || true');
      run('docker-compose up -d --build');
    } else {
      console.log('Forge: no docker-compose.yml found for local deploy; skipping');
    }
  }

  console.log('Forge: done');
})();
