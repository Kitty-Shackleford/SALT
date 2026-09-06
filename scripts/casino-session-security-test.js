'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const route = fs.readFileSync(path.join(root, 'routes/casino.js'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'db/schema-v2.js'), 'utf8');
const migrationPath = path.join(root, 'db/migrations/054_casino_sessions.js');
const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8') : '';
const clients = ['blackjack.js', 'horseracing.js', 'coursing.js', 'craps.js', 'holdem.js']
  .map(name => fs.readFileSync(path.join(root, 'public/js/casino', name), 'utf8'))
  .join('\n');

assert.match(migration, /CREATE TABLE IF NOT EXISTS casino_sessions/i,
  'migration 054 must be compatible with schema-v2 creating casino_sessions first');
for (const column of ['session_id', 'user_id', 'identity_id', 'server_id', 'guild_id', 'game_type', 'state', 'version', 'status', 'reserved_wager', 'expires_at']) {
  assert.match(migration, new RegExp(`\\b${column}\\b`, 'i'), `migration must define ${column}`);
}
assert.match(schema, /CREATE TABLE IF NOT EXISTS casino_sessions/i, 'schema-v2 must create casino_sessions');
assert.match(route, /crypto\.randomBytes\(32\)/, 'session IDs must be unguessable');
assert.match(route, /FOR UPDATE/, 'casino settlement must lock rows');
assert.match(route, /req\.user\.id/, 'sessions must bind the authenticated user');
assert.match(route, /router\.param\('identityId',[\s\S]*ensurePlayerServerAccess/, 'path identity routes must be re-authorized after params exist');
assert.match(route, /req\.playerServerAccess\.serverId/, 'sessions must bind canonical server access');
assert.match(route, /version\s*=\s*version\s*\+\s*1/i, 'actions must consume one session version');
assert.match(route, /status\s*=\s*'settled'/i, 'terminal sessions must settle once');
for (const operation of ['casino_blackjack_deal', 'casino_craps_come_out']) {
  const start = route.indexOf(`operation: '${operation}'`);
  const body = route.slice(start, route.indexOf('sendIdempotentCasinoResponse', start));
  assert(start >= 0 && /createCasinoSession\([\s\S]*wager,[\s\S]*inTransaction:\s*true/.test(body),
    `${operation} must reserve the initial wager inside its idempotent transaction`);
}
const holdemStart = route.indexOf("operation: 'casino_holdem_deal'");
const holdemBody = route.slice(holdemStart, route.indexOf('sendIdempotentCasinoResponse', holdemStart));
assert(holdemStart >= 0 && /createCasinoSession\([\s\S]*state\.ante,[\s\S]*inTransaction:\s*true/.test(holdemBody),
  'holdem session creation must reserve the ante inside its idempotent transaction');
assert.match(route, /reserveAndAdvanceCasinoSession\(/,
  'additional multi-step wagers must be atomically reserved');
assert.doesNotMatch(route, /cash_on_hand\) \|\| 0\) < wager \* 2/,
  'post-reservation checks must not require the already-escrowed stake again');
assert.doesNotMatch(route, /function\s+(?:sign|verify)(?:AndParse)?(?:HandState|RaceState|CoursingRace|CrapsState|HoldemState)/, 'replayable signed client state helpers must be removed');
assert.doesNotMatch(route, /handState:\s*state|raceState:\s*state|gameState:\s*gameState/, 'private state must not be returned');
assert.doesNotMatch(clients, /handState\s*:|raceState\s*:|gameState\s*:/, 'clients must only return opaque session IDs');
for (const name of ['blackjack.js', 'horseracing.js', 'coursing.js', 'craps.js', 'holdem.js']) {
  const source = fs.readFileSync(path.join(root, 'public/js/casino', name), 'utf8');
  assert.match(source, /sessionId/, `${name} must use sessionId`);
}

console.log('casino session security regression tests passed');
