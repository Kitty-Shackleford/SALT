#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function replaceEmptySetting(source, name, value) {
  const pattern = new RegExp(`^${name}=\\s*$`, 'm');
  if (!pattern.test(source)) {
    throw new Error(`Local environment template is missing an empty ${name} setting`);
  }
  return source.replace(pattern, `${name}=${value}`);
}

function createLocalEnvironment(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const templatePath = options.templatePath || path.join(root, '.env.local.example');
  const targetPath = options.targetPath || path.join(root, '.env.local');

  let content = fs.readFileSync(templatePath, 'utf8');
  content = replaceEmptySetting(content, 'SESSION_SECRET', crypto.randomBytes(32).toString('hex'));
  content = replaceEmptySetting(content, 'ENCRYPTION_KEY', crypto.randomBytes(32).toString('hex'));
  content = replaceEmptySetting(content, 'POSTGRES_PASSWORD', crypto.randomBytes(32).toString('base64url'));

  fs.writeFileSync(targetPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return targetPath;
}

if (require.main === module) {
  try {
    const targetPath = createLocalEnvironment();
    console.log(`Created ${path.basename(targetPath)} with generated local-only secrets.`);
    console.log('Add the dedicated Discord test application values, then run: npm run local:up');
  } catch (error) {
    if (error.code === 'EEXIST') {
      console.error('.env.local already exists; it was not changed.');
    } else {
      console.error(`Failed to create .env.local: ${error.message}`);
    }
    process.exitCode = 1;
  }
}

module.exports = { createLocalEnvironment, replaceEmptySetting };
