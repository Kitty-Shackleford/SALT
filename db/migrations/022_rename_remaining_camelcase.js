'use strict';

/**
 * Migration 022: Rename all remaining camelCase columns to snake_case.
 *
 * Migrations 019 and 021 covered most renames, but many tables were missed.
 * This migration covers the remainder across ~20 tables.
 *
 * Uses SAVEPOINT per rename so an already-renamed column (42703) or
 * missing table (42P01) is silently skipped without aborting the transaction.
 */

const RENAMES = [
  // users
  ['users',                 'isBanned',           'is_banned'],
  ['users',                 'refreshToken',        'refresh_token'],
  ['users',                 'tokenExpiresAt',      'token_expires_at'],
  ['users',                 'lastLoginAt',         'last_login_at'],
  // guilds
  ['guilds',                'approvedAt',          'approved_at'],
  ['guilds',                'approvedBy',          'approved_by'],
  ['guilds',                'disabledAt',          'disabled_at'],
  ['guilds',                'disabledBy',          'disabled_by'],
  ['guilds',                'disabledReason',      'disabled_reason'],
  // guild_roles
  ['guild_roles',           'assignedAt',          'assigned_at'],
  // guild_features
  ['guild_features',        'featureName',         'feature_name'],
  // server_features
  ['server_features',       'featureName',         'feature_name'],
  // player_sessions
  ['player_sessions',       'ipAddress',           'ip_address'],
  ['player_sessions',       'logSource',           'log_source'],
  // player_health_status
  ['player_health_status',  'posX',                'pos_x'],
  ['player_health_status',  'posY',                'pos_y'],
  ['player_health_status',  'posZ',                'pos_z'],
  // kill_events
  ['kill_events',           'logSource',           'log_source'],
  // damage_events (migration 019 already renamed victimGamertag/victimPosition)
  ['damage_events',         'victimPosX',          'victim_pos_x'],
  ['damage_events',         'victimPosY',          'victim_pos_y'],
  ['damage_events',         'victimPosZ',          'victim_pos_z'],
  ['damage_events',         'attackerGamertag',    'attacker_gamertag'],
  ['damage_events',         'attackerType',        'attacker_type'],
  ['damage_events',         'bodyPart',            'body_part'],
  ['damage_events',         'bodyPartId',          'body_part_id'],
  ['damage_events',         'hpBefore',            'hp_before'],
  ['damage_events',         'hpAfter',             'hp_after'],
  ['damage_events',         'logSource',           'log_source'],
  // territory_events (migration 019 already renamed logSource on this table)
  ['territory_events',      'posX',                'pos_x'],
  ['territory_events',      'posY',                'pos_y'],
  ['territory_events',      'posZ',                'pos_z'],
  // player_achievements
  ['player_achievements',   'achievementType',     'achievement_type'],
  ['player_achievements',   'achievementName',     'achievement_name'],
  ['player_achievements',   'achievedAt',          'achieved_at'],
  // economy_transactions
  ['economy_transactions',  'sourceIdentityId',    'source_identity_id'],
  // sync_jobs
  ['sync_jobs',             'remotePath',          'remote_path'],
  ['sync_jobs',             'startedAt',           'started_at'],
  // downloads
  ['downloads',             'syncJobId',           'sync_job_id'],
  ['downloads',             'filePath',            'file_path'],
  ['downloads',             'localPath',           'local_path'],
  ['downloads',             'fileSize',            'file_size'],
  ['downloads',             'downloadedAt',        'downloaded_at'],
  // jobs
  ['jobs',                  'startedAt',           'started_at'],
  // file_downloads
  ['file_downloads',        'fileType',            'file_type'],
  ['file_downloads',        'fileDate',            'file_date'],
  ['file_downloads',        'fileSize',            'file_size'],
  ['file_downloads',        'downloadedAt',        'downloaded_at'],
  ['file_downloads',        'parsedAt',            'parsed_at'],
  ['file_downloads',        'playersFound',        'players_found'],
  ['file_downloads',        'eventsFound',         'events_found'],
  // audit_log
  ['audit_log',             'targetType',          'target_type'],
  ['audit_log',             'targetId',            'target_id'],
  // feed_events
  ['feed_events',           'processedAt',         'processed_at'],
  // server_settings
  ['server_settings',       'autoBanAlts',         'auto_ban_alts'],
  // alt_ban_exemptions
  ['alt_ban_exemptions',    'exemptedAt',          'exempted_at'],
  ['alt_ban_exemptions',    'exemptedBy',          'exempted_by'],
];

const RENAMES_DOWN = RENAMES.map(([t, o, n]) => [t, n, o]);

async function safeRename(client, table, oldCol, newCol) {
  try {
    await client.query('SAVEPOINT sp_rename');
    await client.query(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
    await client.query('RELEASE SAVEPOINT sp_rename');
    console.log(`  ✓ Renamed ${table}.${oldCol} → ${newCol}`);
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT sp_rename');
    if (err.code === '42703' || err.code === '42P01') {
      // Column or table doesn't exist — already renamed or skipped
    } else {
      throw err;
    }
  }
}

async function up(db) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const [table, oldCol, newCol] of RENAMES) {
      await safeRename(client, table, oldCol, newCol);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function down(db) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const [table, oldCol, newCol] of RENAMES_DOWN) {
      await safeRename(client, table, oldCol, newCol);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { up, down };
