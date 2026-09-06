'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const shop = fs.readFileSync(path.join(root, 'routes', 'shop.js'), 'utf8');
const frontend = fs.readFileSync(path.join(root, 'public', 'js', 'shop.js'), 'utf8');
const { normalizeCartCoordinates } = require('../utils/shopCoordinates');

assert.match(shop, /async function verifyIdentityOwner\(db, userId, identityId, serverId\)/);
assert.match(shop, /FROM server_player_memberships spm[\s\S]*spm\.source_link_id = la\.id[\s\S]*spm\.server_id = \?/);
assert.match(shop, /la\.verification_method IN \('emote_challenge', 'admin_approved', 'self_asserted'\)/);
assert.doesNotMatch(shop, /\? = true[\s\S]{0,200}FROM guild_roles/,
  'global dashboard admin must not list every tenant shop');
assert.match(shop, /SELECT soi\.id, so\.identity_id, so\.server_id[\s\S]*FOR UPDATE OF soi, so/);
assert.match(shop, /assertIdentityOwnerForMutation\([\s\S]*transactionDb, req\.user\.id, cartItemReference\.identity_id, cartItemReference\.server_id/);
assert.match(shop, /router\.get\('\/orders\/:identityId', ensurePlayerServerAccess/);
assert.match(shop, /WHERE identity_id = \? AND server_id = \? AND status IN/);
assert.match(frontend, /\/api\/shop\/orders\/\$\{identityId\}\?serverId=\$\{encodeURIComponent\(serverId\)\}/);

assert.deepStrictEqual(
  normalizeCartCoordinates({ pos_x: 4576.635, pos_y: 0, pos_z: 10068.641 }),
  { pos_x: 4576.635, pos_y: 0, pos_z: 10068.641, ypr_x: 0, ypr_y: 0, ypr_z: 0 },
  'missing orientation values must use the schema-safe zero defaults'
);
assert.deepStrictEqual(
  normalizeCartCoordinates({ ypr_x: 90 }, {
    pos_x: 1, pos_y: 2, pos_z: 3, ypr_x: 4, ypr_y: 5, ypr_z: 6,
  }),
  { pos_x: 1, pos_y: 2, pos_z: 3, ypr_x: 90, ypr_y: 5, ypr_z: 6 },
  'partial cart updates must preserve coordinates omitted by the client'
);
assert.throws(
  () => normalizeCartCoordinates({ pos_x: 'not-a-coordinate' }),
  /valid finite number/,
  'invalid coordinates must be rejected before reaching PostgreSQL'
);

console.log('✅ Shop resource/server IDOR tests passed');
