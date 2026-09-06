'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const commandPath = path.join(__dirname, '..', 'bot', 'commands', 'teleport.js');
assert(fs.existsSync(commandPath), 'teleport slash command must exist');
const commandSource = fs.readFileSync(commandPath, 'utf8');
assert.match(commandSource, /requestModeratorTeleport/);
assert.match(commandSource, /interaction\.authorizedServerId/);
assert.match(commandSource, /spm\.status = 'active'/);
assert.match(commandSource, /JOIN player_gamertags pg/);
assert.match(commandSource, /pg\.is_current_gamertag = 1/);
assert.match(commandSource, /SELECT id FROM users WHERE discord_id = \?/);
assert.doesNotMatch(commandSource, /SELECT id FROM users WHERE discord_id = \? FOR UPDATE/);
assert.match(commandSource, /const targets = await transactionDb\.query/);
assert.match(commandSource, /targets\.length !== 1/);
assert.doesNotMatch(commandSource, /LIMIT 1/);
assert.doesNotMatch(commandSource, /FOR UPDATE OF spm/);
assert.match(commandSource, /source:\s*'admin'/);

const authorizationSource = fs.readFileSync(
  path.join(__dirname, '..', 'bot', 'utils', 'commandAuthorization.js'),
  'utf8'
);
assert.match(authorizationSource, /'teleport':\s*'server_moderate'/);

const adapterSource = fs.readFileSync(
  path.join(__dirname, '..', 'bot', 'utils', 'dashboardDbAdapter.js'),
  'utf8'
);
assert.match(adapterSource, /PostgreSQLAdapter/);
assert.match(adapterSource, /adapter\.pool = pool/);

console.log('✅ Teleport bot command tests passed');
