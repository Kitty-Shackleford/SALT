#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { buildManifest, serializeManifest } = require('./lib/ui-surface-manifest');

const root = path.resolve(__dirname, '..');
const artifactPath = path.join(root, 'artifacts', 'ui-surface-manifest.json');
const mode = process.argv[2];

if (!['--write', '--check'].includes(mode) || process.argv.length !== 3) {
  console.error('Usage: node scripts/generate-ui-surface-manifest.js --write|--check');
  process.exit(2);
}

const generated = serializeManifest(buildManifest(root));

if (mode === '--write') {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, generated);
  console.log(`Wrote ${path.relative(root, artifactPath)}`);
  process.exit(0);
}

const committed = fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath, 'utf8') : null;
if (committed !== generated) {
  console.error('UI surface manifest is stale.');
  console.error('Run: npm run manifest:ui');
  console.error('Review the route/page/capability diff before committing.');
  process.exit(1);
}

console.log('UI surface manifest is current');
