'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const normalize = value => value.replace(/\s+/g, ' ');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function includesAll(source, values, label) {
  const missing = values.filter(value => !source.includes(value));
  assert.deepStrictEqual(missing, [], `${label} missing: ${missing.join(', ')}`);
}

function assertCommandSerializes(relativePath) {
  const command = require(path.join(root, relativePath));
  const json = command.data.toJSON();
  assert(json.name, `${relativePath} has no command name`);
  assert(Array.isArray(json.options), `${relativePath} options did not serialize`);
  JSON.stringify(json);
}

(async () => {
  const migration = normalize(read('db/migrations/051_server_scoped_runtime_config.js'));
  const feedsRoute = normalize(read('routes/feeds.js'));
  const setupFeeds = normalize(read('bot/commands/setup-feeds.js'));
  const setupStatus = normalize(read('bot/commands/setup-status.js'));
  const notifyRestart = normalize(read('bot/commands/notify-restart.js'));
  const alertThreshold = normalize(read('bot/commands/alert-threshold.js'));
  const report = normalize(read('bot/commands/report.js'));
  const statusService = normalize(read('bot/services/serverStatusService.js'));
  const aiService = normalize(read('services/aiService.js'));
  const accessRoute = normalize(read('routes/access.js'));
  const adminFeeds = normalize(read('public/js/admin-feeds.js'));
  const dashboardFeeds = normalize(read('public/js/dashboard-feeds.js'));
  const adminFeedsHtml = read('public/admin/feeds.html');
  const dashboardFeedsHtml = read('public/dashboard/feeds.html');
  const logParser = normalize(read('routes/logParser.js'));
  const feedProcessor = normalize(read('workers/feedProcessor.js'));
  const modLog = normalize(read('bot/commands/mod-log.js'));

  test('migration backfills only a canonical singleton guild server', () => {
    includesAll(migration, [
      'JOIN servers s ON s.guild_id = g.id',
      'GROUP BY g.id, g.discord_guild_id',
      'HAVING COUNT(*) = 1',
      'f.guild_id = singleton_servers.discord_guild_id',
      't.guild_id = singleton_servers.discord_guild_id',
      'p.guild_id = singleton_servers.discord_guild_id',
      'a.guild_id = singleton_servers.discord_guild_id',
      'r.guild_id = singleton_servers.discord_guild_id',
    ], 'singleton migration');
  });

  test('migration quarantines ambiguous enabled runtime rows', () => {
    includesAll(migration, [
      'UPDATE discord_feeds SET enabled = 0 WHERE server_id IS NULL',
      'UPDATE restart_notify_prefs SET enabled = FALSE WHERE server_id IS NULL',
      'UPDATE player_count_alerts SET enabled = FALSE WHERE server_id IS NULL',
      'CHECK (enabled = 0 OR server_id IS NOT NULL)',
      'CHECK (enabled = FALSE OR server_id IS NOT NULL)',
    ], 'ambiguous-row quarantine');
  });

  test('migration indexes and status migration use exact internal server ids', () => {
    includesAll(migration, [
      'ON discord_feeds(server_id, feed_type)',
      'ON feed_templates(server_id, feed_type, event_type)',
      'ON restart_notify_prefs(server_id, discord_user_id)',
      'ON player_count_alerts(server_id, enabled)',
      'ON player_reports(server_id, created_at DESC)',
      'INSERT INTO server_features (server_id, feature_name, enabled, config, updated_at)',
      "WHERE gf.feature_name = 'server_status'",
      "UPDATE guild_features SET enabled = 0",
    ], 'server indexes/status migration');
  });

  test('feed HTTP CRUD binds canonical Discord guild and internal server', () => {
    includesAll(feedsRoute, [
      "router.param('serverId', requireServerCapability(CAPABILITIES.SERVER_MANAGE))",
      'authorization.guild.discordGuildId',
      'authorization.server.id',
      'WHERE guild_id = ? AND server_id = ?',
      'ON CONFLICT(server_id, feed_type) DO UPDATE SET guild_id = excluded.guild_id',
      'ON CONFLICT(server_id, feed_type, event_type) DO UPDATE SET guild_id = excluded.guild_id',
    ], 'feed routes');
  });

  test('bot feed, restart, alert, and report writes and reads use the authorized server', () => {
    includesAll(setupFeeds, [
      'interaction.authorizedServerId',
      'ON CONFLICT (server_id, feed_type) DO UPDATE SET guild_id = EXCLUDED.guild_id',
      'WHERE guild_id = $1 AND server_id = $2',
    ], 'setup-feeds');
    includesAll(notifyRestart, [
      'interaction.authorizedServerId',
      'ON CONFLICT (server_id, discord_user_id) DO UPDATE SET guild_id = EXCLUDED.guild_id',
      'WHERE guild_id = $1 AND server_id = $2 AND discord_user_id = $3',
    ], 'notify-restart');
    includesAll(alertThreshold, [
      'interaction.authorizedServerId',
      '(guild_id, server_id, threshold',
      'WHERE id = $1 AND guild_id = $2 AND server_id = $3',
      'WHERE guild_id = $1 AND server_id = $2',
    ], 'alert-threshold');
    includesAll(report, [
      'interaction.authorizedServerId',
      'ON CONFLICT (server_id, feed_type) DO UPDATE SET guild_id = EXCLUDED.guild_id',
      '(guild_id, server_id, reporter_discord_id',
      'WHERE guild_id = $1 AND server_id = $2',
    ], 'report');
  });

  test('status setup accepts only the server authorized for the interaction', () => {
    includesAll(setupStatus, [
      'interaction.authorizedServerId',
      'creds.serverId !== interaction.authorizedServerId',
      'FROM server_features',
      'ON CONFLICT (server_id, feature_name) DO UPDATE',
    ], 'setup-status');
    assert(!setupStatus.includes('FROM guild_features'), 'setup-status still reads guild_features');
    assert(!setupStatus.includes('server_db_id: server_db_id'), 'status config redundantly trusts an embedded server id');
  });

  test('status worker derives guild and server only from server_features', () => {
    includesAll(statusService, [
      'FROM server_features sf',
      'JOIN servers s ON s.id = sf.server_id',
      'JOIN guilds g ON g.id = s.guild_id',
      'sf.server_id AS server_db_id',
      'WHERE guild_id = $1 AND server_id = $2 AND enabled = TRUE',
    ], 'status service');
    assert(!statusService.includes('FROM guild_features gf'), 'status worker still reads guild_features');
    assert(!statusService.includes('config.server_db_id'), 'status worker trusts an embedded server id');
  });

  test('AI and setup readiness read server_features only', () => {
    includesAll(aiService, [
      "FROM server_features WHERE feature_name = 'server_status'",
      'AND server_id = $1',
    ], 'AI service');
    includesAll(accessRoute, [
      'FROM server_features sf',
      'configured_server.id = sf.server_id',
      "sf.feature_name IN ('server_status', 'restart_countdown')",
    ], 'setup readiness');
  });

  test('both feed UIs require and send an exact internal server id', () => {
    for (const [label, source] of [['admin', adminFeeds], ['dashboard', dashboardFeeds]]) {
      includesAll(source, [
        'currentServerId',
        '/servers`',
        '/${currentServerId}`',
        '/${currentServerId}/templates`',
        '/${currentServerId}/test`',
      ], `${label} feed UI`);
    }
    assert(adminFeedsHtml.includes('id="serverSelect"'), 'admin feed UI has no server selector');
    assert(dashboardFeedsHtml.includes('id="serverSelect"'), 'dashboard feed UI has no server selector');
  });

  test('all modified runtime slash-command builders serialize', () => {
    for (const commandPath of [
      'bot/commands/setup-feeds.js',
      'bot/commands/setup-status.js',
      'bot/commands/notify-restart.js',
      'bot/commands/alert-threshold.js',
      'bot/commands/report.js',
    ]) {
      assertCommandSerializes(commandPath);
    }
  });

  test('log economy lookups receive the canonical internal server id and kill money moves atomically', () => {
    assert(!logParser.includes('getEconomyConfigForIdentity(db, identityId);'), 'playtime config omits server id');
    assert(!logParser.includes('getEconomyConfigForIdentity(db, killerIdentityId);'), 'kill config omits server id');
    includesAll(logParser, [
      'getEconomyConfigForIdentity(db, identityId, dbServerId)',
      'getEconomyConfigForIdentity(db, killerIdentityId, dbServerId)',
      'processKillEconomyTransaction',
    ], 'log economy');
  });

  test('feed processor reads economy config by exact server id', () => {
    includesAll(feedProcessor, [
      'JOIN guild_economy_config gec ON gec.server_id = s.id',
      "WHERE s.id = $1 AND s.status = 'active'",
    ], 'feed economy config');
    assert(!feedProcessor.includes('JOIN guild_economy_config gec ON s.guild_id = gec.guild_id'),
      'feed economy config still fans out through guild');
  });

  test('mod-log reads and mutates only the interaction authorized server', () => {
    includesAll(modLog, [
      'interaction.authorizedServerId',
      'server_id = $',
    ], 'mod-log');
  });

  const calls = [];
  const migrationModule = require(path.join(root, 'db/migrations/051_server_scoped_runtime_config.js'));
  await migrationModule.up({ query: async sql => calls.push(normalize(sql)) });
  assert.strictEqual(calls.length, 4, 'migration phase count changed unexpectedly');
  assert(calls[0].includes('ALTER TABLE discord_feeds'), 'columns are not created first');
  assert(calls[1].includes('singleton_servers'), 'legacy rows are not migrated second');
  assert(calls[2].includes('CREATE UNIQUE INDEX'), 'indexes are not created third');
  assert(calls[3].includes('INSERT INTO server_features'), 'status config is not migrated last');
  passed += 1;
  console.log('✓ migration executes through the expected ordered phases');

  console.log(`\nRuntime server-scope regression tests passed: ${passed}`);
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
