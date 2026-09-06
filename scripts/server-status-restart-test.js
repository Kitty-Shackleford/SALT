#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildEmbed,
  applyChangedOnlineCacheRows,
  refreshGuildPresence,
  safeEdit,
  selectChangedOnlineCacheRows,
  formatRestartChannelName,
  formatRestartEmbedLabel,
  selectNewestRptStartMs,
} = require('../bot/services/serverStatusService');

function testRestartChannelUsesCountdownLabel() {
  const restartAtMs = Date.now() + (65 * 60 * 1000);
  assert.strictEqual(formatRestartChannelName(restartAtMs, '1h 5m'), '🔄 Restart: 1h 5m');
  assert.strictEqual(formatRestartChannelName(null), '🔄 Restart: Unknown');
}

function testRestartChannelDoesNotShowAnExpiredTime() {
  assert.strictEqual(
    formatRestartChannelName(Date.now() - 1000, 'Restarting…'),
    '🔄 Restart: Restarting…'
  );
}

function testRestartEmbedUsesDiscordLiveTimestamp() {
  const restartAtMs = Date.parse('2030-08-31T00:23:43.000Z');
  const epochSeconds = Math.floor(restartAtMs / 1000);
  assert.strictEqual(
    formatRestartEmbedLabel(restartAtMs, '1h 5m'),
    `<t:${epochSeconds}:t> • <t:${epochSeconds}:R>`
  );
  assert.strictEqual(formatRestartEmbedLabel(null, '1h 5m'), '1h 5m');
  assert.strictEqual(formatRestartEmbedLabel(null, null), 'Unknown');
}

function testNewestRptIsSelectedByEmbeddedTimestamp() {
  const selected = selectNewestRptStartMs([
    'DayZServer_X1_x64_2026-08-26_18-24-33.RPT',
    'DayZServerP_X1_x64_2026-08-30_14-03-32.RPT',
    'not-a-log.txt',
  ]);
  assert.strictEqual(selected, Date.parse('2026-08-30T14:03:32.000Z'));
}

function testStatusEmbedContainsLiveRestartCountdown() {
  const restartAtMs = Date.parse('2030-08-31T00:23:43.000Z');
  const epochSeconds = Math.floor(restartAtMs / 1000);
  const embed = buildEmbed(
    'Test Server',
    { status: 'started', query: {}, settings: { config: {} } },
    '4y 0m',
    [],
    null,
    null,
    restartAtMs
  ).toJSON();
  const restartField = embed.fields.find(field => field.name.includes('Next Restart'));
  assert(restartField, 'restart field missing from status embed');
  assert(restartField.value.includes(`<t:${epochSeconds}:R>`), 'live restart countdown missing');
}

function testStatusEmbedExplainsUnavailablePlayerNames() {
  const embed = buildEmbed(
    'Test Server',
    {
      status: 'started',
      query: { player_current: 2, player_max: 20 },
      settings: { config: {} },
    },
    null,
    []
  ).toJSON();
  const playerField = embed.fields.find(field => field.name.includes('Online Players'));
  assert(playerField, 'online-player field missing from status embed');
  assert.match(playerField.value, /names unavailable — provider log evidence is delayed or stale/);
}

function testStatusPlayerNamesRequireFreshProviderEvidence() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'services', 'serverStatusService.js'),
    'utf8'
  );
  assert.match(source, /JOIN server_online_cache_snapshots/);
  assert.match(source, /source_observed_at >= clock_timestamp\(\) - INTERVAL '120 minutes'/);
  assert.match(source, /source_observed_at <= clock_timestamp\(\) \+ INTERVAL '5 minutes'/);
}

function testAllUserFacingOnlineListsRequireFreshProviderEvidence() {
  const sources = [
    path.join(__dirname, '..', 'bot', 'services', 'serverStatusService.js'),
    path.join(__dirname, '..', 'bot', 'commands', 'online.js'),
    path.join(__dirname, '..', 'bot', 'commands', 'location.js'),
    path.join(__dirname, '..', 'routes', 'guilds.js'),
    path.join(__dirname, 'tui-admin.js'),
  ];
  for (const sourcePath of sources) {
    const source = fs.readFileSync(sourcePath, 'utf8');
    assert.match(source, /JOIN server_online_cache_snapshots/);
    assert.match(source, /source_observed_at >= clock_timestamp\(\) - INTERVAL '120 minutes'/);
    assert.match(source, /source_observed_at <= clock_timestamp\(\) \+ INTERVAL '5 minutes'/);
  }
}

function testOnlineCacheChangesSelectOnlyExactChangedServers() {
  const baseline = new Map([['3', '2'], ['5', '8']]);
  const rows = [
    { server_db_id: 5, scan_generation: '8', discord_guild_id: 'guild-b' },
    { server_db_id: 3, scan_generation: '3', discord_guild_id: 'guild-a' },
  ];
  assert.deepStrictEqual(
    selectChangedOnlineCacheRows(baseline, rows),
    [rows[1]],
    'one server publication must refresh only that exact server/guild row'
  );
  assert.deepStrictEqual(
    selectChangedOnlineCacheRows(new Map([['3', '3'], ['5', '8']]), rows),
    [],
    'database row order must not trigger redundant Discord refreshes'
  );
}

function testStatusLoopWatchesPublishedOnlineCacheEveryThirtySeconds() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'services', 'serverStatusService.js'),
    'utf8'
  );
  assert.match(source, /const CACHE_REFRESH_INTERVAL_MS = 30 \* 1000/);
  assert.match(source, /server_online_cache_snapshots/);
  assert.match(source, /row => refreshGuildPresence\(client, row\)/);
  const presenceRefreshSource = source.slice(
    source.indexOf('async function refreshGuildPresence'),
    source.indexOf('/**\n * Runs one full update pass')
  );
  assert.doesNotMatch(
    presenceRefreshSource,
    /fetchServerData|fetchNextRestart|fetchRestartFromXml/,
    'a cache change must not poll the provider or fan out through the all-server refresh path'
  );
  assert.match(source, /setInterval\(\(\) => refreshStatusOnOnlineCacheChange\(client\), CACHE_REFRESH_INTERVAL_MS\)/);
}

async function testSafeEditOnlyAcknowledgesSuccessfulDiscordEdits() {
  assert.strictEqual(await safeEdit(async () => {}), true);

  const originalError = console.error;
  console.error = () => {};
  try {
    assert.strictEqual(
      await safeEdit(async () => { throw new Error('Discord edit failed'); }),
      false,
      'a failed Discord edit must remain retryable'
    );
  } finally {
    console.error = originalError;
  }
}

async function testCacheGenerationAcknowledgementRequiresExactServerSuccess() {
  const generations = new Map([['3', '1'], ['4', '1']]);
  const rows = [
    { server_db_id: 3, scan_generation: '2' },
    { server_db_id: 4, scan_generation: '2' },
  ];
  const attempted = [];

  await applyChangedOnlineCacheRows(generations, rows, async row => {
    attempted.push(row.server_db_id);
    return row.server_db_id === 3;
  });

  assert.deepStrictEqual(attempted, [3, 4]);
  assert.strictEqual(generations.get('3'), '2');
  assert.strictEqual(generations.get('4'), '1');
}

async function testCacheRefreshEditsFromLocalStateWithoutProviderCalls() {
  let editedEmbed = null;
  let playerFetches = 0;
  const client = {
    channels: {
      fetch: async channelId => {
        assert.strictEqual(channelId, 'status-channel');
        return {
          guildId: 'discord-guild',
          messages: {
            fetch: async messageId => {
              assert.strictEqual(messageId, 'status-message');
              return {
                edit: async payload => { editedEmbed = payload.embeds[0]; },
              };
            },
          },
        };
      },
    },
  };
  const row = {
    server_db_id: 3,
    discord_guild_id: 'discord-guild',
    config: JSON.stringify({
      text_channel_id: 'status-channel',
      pinned_message_id: 'status-message',
    }),
  };
  const renderCache = new Map([['3', {
    serverName: 'Exact Server',
    gameserver: { query: { player_current: 1, player_max: 10 }, status: 'started' },
    restartLabel: null,
    restartAtMs: null,
    lastLogSyncTime: null,
    nextLogSyncTime: null,
  }]]);

  const updated = await refreshGuildPresence(client, row, {
    renderCache,
    fetchPlayers: async serverId => {
      playerFetches += 1;
      assert.strictEqual(serverId, 3);
      return [{ gamertag: 'FreshPlayer' }];
    },
  });

  assert.strictEqual(updated, true);
  assert.strictEqual(playerFetches, 1);
  assert(editedEmbed, 'the cached provider state should render a fresh player list');
  assert.match(JSON.stringify(editedEmbed), /FreshPlayer/);

  const missingMessage = await refreshGuildPresence(client, {
    ...row,
    config: JSON.stringify({ text_channel_id: 'status-channel' }),
  }, {
    renderCache,
    fetchPlayers: async () => { throw new Error('must not fetch without a message target'); },
  });
  assert.strictEqual(missingMessage, false);
}

async function main() {
  testRestartChannelUsesCountdownLabel();
  testRestartChannelDoesNotShowAnExpiredTime();
  testRestartEmbedUsesDiscordLiveTimestamp();
  testNewestRptIsSelectedByEmbeddedTimestamp();
  testStatusEmbedContainsLiveRestartCountdown();
  testStatusEmbedExplainsUnavailablePlayerNames();
  testStatusPlayerNamesRequireFreshProviderEvidence();
  testAllUserFacingOnlineListsRequireFreshProviderEvidence();
  testOnlineCacheChangesSelectOnlyExactChangedServers();
  testStatusLoopWatchesPublishedOnlineCacheEveryThirtySeconds();
  await testSafeEditOnlyAcknowledgesSuccessfulDiscordEdits();
  await testCacheGenerationAcknowledgementRequiresExactServerSuccess();
  await testCacheRefreshEditsFromLocalStateWithoutProviderCalls();
  console.log('✅ Restart timer accuracy tests passed');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
