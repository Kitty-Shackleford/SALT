'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function routeBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notStrictEqual(start, -1, `${startMarker} must exist`);
  assert.notStrictEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return source.slice(start, end);
}

function testDiscoveryRequiresTrustedExactMembership() {
  const source = fs.readFileSync(path.join(root, 'routes/playerPortal.js'), 'utf8');
  const discover = routeBlock(
    source,
    "router.get('/discover/:guild_id'",
    "router.get('/search'",
  );

  assert.ok(discover.includes('server_player_memberships spm'),
    'discovery must derive disclosed accounts from exact-server memberships');
  assert.ok(discover.includes('spm.source_link_id = la.id'),
    'discovery membership must be bound to the disclosed ownership link');
  assert.ok(discover.includes('spm.user_id = la.user_id'),
    'discovery membership user must match the ownership link user');
  assert.ok(discover.includes("spm.status = 'active'"),
    'discovery must require active membership');
  assert.ok(discover.includes("la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')"),
    'discovery must require trusted ownership provenance');
  assert.ok(!discover.includes('primary_identity_id IN ('),
    'discovery must not infer and disclose alternate accounts from global identity history');
}

function testMyStatsRequiresTrustedExactMembership() {
  const source = fs.readFileSync(path.join(root, 'bot/commands/my-stats.js'), 'utf8');

  assert.ok(source.includes('spm.source_link_id = la.id'),
    'my-stats membership must be bound to the selected ownership link');
  assert.ok(source.includes('spm.user_id = la.user_id'),
    'my-stats membership user must match the ownership link user');
  assert.ok(source.includes('spm.identity_id = la.identity_id'),
    'my-stats membership identity must match the ownership link identity');
  assert.ok(source.includes("la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')"),
    'my-stats must require trusted ownership provenance');
  assert.ok(source.includes("spm.status = 'active'"),
    'my-stats must require active exact-server membership');
}

function testOnlineAssociationsRequireTrustedExactMembership() {
  const source = fs.readFileSync(path.join(root, 'bot/commands/online.js'), 'utf8');

  assert.ok(source.includes('LEFT JOIN server_player_memberships spm'),
    'online must preserve public gamertags while gating Discord associations through membership');
  assert.ok(source.includes('spm.server_id = soc.server_id'),
    'online association membership must target the exact listed server');
  assert.ok(source.includes("spm.status = 'active'"),
    'online associations must require active membership');
  assert.ok(source.includes('la.id = spm.source_link_id'),
    'online association membership must be bound to its source link');
  assert.ok(source.includes('la.user_id = spm.user_id'),
    'online association ownership user must match membership user');
  assert.ok(source.includes('la.identity_id = spm.identity_id'),
    'online association ownership identity must match membership identity');
  assert.ok(source.includes("la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')"),
    'online associations must require trusted ownership provenance');
}

testDiscoveryRequiresTrustedExactMembership();
testMyStatsRequiresTrustedExactMembership();
testOnlineAssociationsRequireTrustedExactMembership();
console.log('✅ Linked-account private-data consumer tests passed');
