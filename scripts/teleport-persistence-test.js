'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const migrationPath = path.join(__dirname, '../db/migrations/071_unified_teleport_system.js');
assert(fs.existsSync(migrationPath), 'Teleport migration must exist');
const migration = fs.readFileSync(migrationPath, 'utf8');

for (const table of [
  'teleport_destinations',
  'player_pra_restrictions',
  'player_disconnect_positions',
  'teleport_requests',
  'teleport_events',
]) {
  assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
}
assert.match(migration, /UNIQUE \(server_id, identity_id\).*active restriction/is);
assert.match(migration, /UNIQUE \(server_id, identity_id, observed_at, source_file\)/);
assert.match(migration, /teleport_requests_one_live_per_player/);
assert.match(migration, /FOREIGN KEY \(destination_id, server_id, guild_id\)/);
assert.match(migration, /status IN \('waiting_disconnect', 'provisioning', 'armed', 'cleanup_pending', 'cleanup_processing', 'cleanup_restart_pending', 'completed', 'failed', 'cancelled'\)/);
assert.match(migration, /refunded_at TIMESTAMPTZ/);
assert.match(migration, /teleport_requests_expiry_idx[\s\S]*WHERE status IN \('waiting_disconnect', 'provisioning', 'armed'\)/);
assert.match(migration, /teleport_requests_refund_pending_idx[\s\S]*status = 'failed'[\s\S]*refunded_at IS NULL/);
assert.match(migration, /mission_dir TEXT/);
assert.match(migration, /mission_map_name TEXT/);
assert.match(migration, /arm_configured_at TIMESTAMPTZ/);
assert.match(migration, /restart_attempt_count INTEGER NOT NULL DEFAULT 0/);
assert.match(migration, /cleanup_restart_requested_at TIMESTAMPTZ/);
assert.match(migration, /cleanup_restart_attempt_count INTEGER NOT NULL DEFAULT 0/);
assert.match(migration, /expires_at TIMESTAMPTZ NOT NULL/);
assert.match(migration, /final_status TEXT NOT NULL DEFAULT 'completed'/);
assert.match(migration, /arrival_observed_at TIMESTAMPTZ/);
assert.match(migration, /cleanup_requested_at TIMESTAMPTZ/);
assert.match(migration, /cleanup_config_removed_at TIMESTAMPTZ/);
for (const eventType of ['restart_request_failed', 'cleanup_config_removed', 'cleanup_restart_requested', 'cleanup_restart_failed']) {
  assert.match(migration, new RegExp(`'${eventType}'`));
}
assert.doesNotMatch(migration, /REFERENCES servers\([^)]*\) ON DELETE RESTRICT/);
assert.doesNotMatch(migration, /REFERENCES server_player_memberships/,
  'teleport history must not permanently block membership unlink or user removal');
assert.match(migration, /CREATE TRIGGER protect_server_active_teleports_trigger/);
assert.match(migration, /Cannot disable or delete server while active teleport state exists/);
const restrictionService = fs.readFileSync(
  path.join(__dirname, '../services/teleportRestrictionService.js'), 'utf8'
);
assert.match(restrictionService, /player_pra_restrictions/);
assert.doesNotMatch(restrictionService, /\bteleport_restrictions\b/);
assert.strictEqual(typeof require(migrationPath).up, 'function');
assert.strictEqual(typeof require(migrationPath).down, 'function');

console.log('✅ Teleport persistence tests passed');
