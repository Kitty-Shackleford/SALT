'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function testExactServerStatusProjection() {
  const { createMissionInitStatusService } = require('../services/missionInitStatusService');
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push([sql, params]);
      if (sql.includes('FROM servers s')) {
        return [{
          server_id: 42,
          platform_server_id: '90000002',
          token_hash: 'encrypted',
        }];
      }
      if (sql.includes("workflow = 'mission_init'")) {
        return [{
          id: '91',
          action: 'deploy',
          status: 'completed',
          plan_json: {
            expectedSourceHash: 'a'.repeat(64),
            expectedCandidateHash: 'b'.repeat(64),
            configurationHash: 'c'.repeat(64),
            privateConfiguration: { identityId: 'must-not-leak' },
          },
          created_at: new Date('2026-09-05T01:00:00Z'),
          finished_at: new Date('2026-09-05T01:01:00Z'),
        }];
      }
      if (sql.includes("status IN ('prepared', 'recovery_pending')")) return [];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const service = createMissionInitStatusService({
    decryptToken(value) {
      assert.strictEqual(value, 'encrypted');
      return 'provider-token';
    },
    capabilityService: {
      async probe(input) {
        assert.deepStrictEqual(input, {
          platformServerId: '90000002',
          token: 'provider-token',
          includeContent: false,
          includeProviderPath: false,
        });
        return {
          capability: 'mission.init_c',
          status: 'supported',
          reasonCode: 'init_c_readable',
          platform: 'pc',
          activeMission: 'dayzOffline.chernarusplus',
          observedAt: '2026-09-05T02:00:00.000Z',
          readable: true,
          writable: false,
          runtimeVerified: false,
          supportLevel: 'readable',
          rolloutEnabled: true,
          size: 3230,
          hash: 'b'.repeat(64),
        };
      },
    },
  });

  const result = await service.getStatus({
    db,
    internalServerId: 42,
    discordGuildId: '900000000000000002',
  });

  assert.strictEqual(result.providerState, 'candidate_present');
  assert.strictEqual(result.liveSourceHash, 'b'.repeat(64));
  assert.strictEqual(Object.hasOwn(result.capability, 'activeMission'), false);
  assert.deepStrictEqual(result.latestOperation, {
    id: '91',
    action: 'deploy',
    status: 'completed',
    sourceHash: 'a'.repeat(64),
    candidateHash: 'b'.repeat(64),
    configurationHash: 'c'.repeat(64),
    restoredHash: null,
    createdAt: '2026-09-05T01:00:00.000Z',
    finishedAt: '2026-09-05T01:01:00.000Z',
  });
  assert.deepStrictEqual(result.controlPlane, {
    desiredState: 'not_persisted',
    approval: 'not_persisted',
    deploymentActionAvailable: false,
    restoreActionAvailable: false,
    restartActionAvailable: false,
  });
  assert.strictEqual(result.runtimeEvidence, 'not_recorded');
  assert(!JSON.stringify(result).includes('must-not-leak'));
  assert(calls[0][0].includes('g.discord_guild_id = ?'));
  assert(calls[0][0].includes("s.status = 'active'"));
  assert(calls[0][0].includes("g.status = 'approved'"));
  assert.deepStrictEqual(calls[0][1], [42, '900000000000000002']);
  for (const [sql, params] of calls.slice(1)) {
    assert(sql.includes('JOIN servers scoped_server ON scoped_server.id = pm.server_id'));
    assert(sql.includes('JOIN guilds scoped_guild ON scoped_guild.id = scoped_server.guild_id'));
    assert(sql.includes('scoped_guild.discord_guild_id = ?'));
    assert(sql.includes('pm.provider_service_id = ?'));
    assert(sql.includes("scoped_server.status = 'active'"));
    assert(sql.includes("scoped_guild.status = 'approved'"));
    assert.deepStrictEqual(params, [42, '900000000000000002', '90000002']);
  }
}

async function testRestoreAndDriftStates() {
  const { createMissionInitStatusService } = require('../services/missionInitStatusService');
  async function statusFor(liveHash, operation) {
    const service = createMissionInitStatusService({
      decryptToken: () => 'token',
      capabilityService: { async probe() {
        return { status: 'supported', hash: liveHash, platform: 'pc', observedAt: '2026-09-05T02:00:00.000Z' };
      } },
    });
    return service.getStatus({
      internalServerId: 42,
      discordGuildId: '900000000000000002',
      db: { async query(sql) {
        if (sql.includes('FROM servers s')) {
          return [{ server_id: 42, platform_server_id: '90000002', token_hash: 'encrypted' }];
        }
        if (sql.includes("workflow = 'mission_init'")) return [operation];
        return [];
      } },
    });
  }

  const restore = {
    id: 92,
    action: 'restore',
    status: 'completed',
    plan_json: { expectedCurrentHash: 'b'.repeat(64), restoredHash: 'a'.repeat(64) },
    created_at: '2026-09-05T01:02:00.000Z',
    finished_at: '2026-09-05T01:03:00.000Z',
  };
  assert.strictEqual((await statusFor('a'.repeat(64), restore)).providerState, 'original_restored');
  assert.strictEqual((await statusFor('d'.repeat(64), restore)).providerState, 'drifted');
}

async function testDeniedOrAmbiguousContextStopsBeforeProvider() {
  const { createMissionInitStatusService } = require('../services/missionInitStatusService');
  let providerCalls = 0;
  const service = createMissionInitStatusService({
    decryptToken() { throw new Error('decrypt must not run'); },
    capabilityService: { async probe() { providerCalls += 1; } },
  });
  await assert.rejects(
    () => service.getStatus({
      db: { async query() { return []; } },
      internalServerId: 42,
      discordGuildId: '900000000000000002',
    }),
    error => error.code === 'MISSION_INIT_STATUS_UNAVAILABLE' && error.status === 404
  );
  await assert.rejects(
    () => service.getStatus({
      db: { async query() {
        return [
          { server_id: 42, platform_server_id: '90000002', token_hash: 'one' },
          { server_id: 42, platform_server_id: '90000002', token_hash: 'two' },
        ];
      } },
      internalServerId: 42,
      discordGuildId: '900000000000000002',
    }),
    error => error.code === 'MISSION_INIT_STATUS_UNAVAILABLE'
  );
  assert.strictEqual(providerCalls, 0);
}

function testDiscordCommandContract() {
  const root = path.join(__dirname, '..');
  const commandPath = path.join(root, 'bot', 'commands', 'mission-init.js');
  assert(fs.existsSync(commandPath), 'mission-init Discord command must exist');
  const source = fs.readFileSync(commandPath, 'utf8');
  const authorization = fs.readFileSync(path.join(root, 'bot', 'utils', 'commandAuthorization.js'), 'utf8');
  assert.match(source, /setName\('mission-init'\)/);
  assert.match(source, /setName\('status'\)/);
  assert.match(source, /setName\('server'\)/);
  assert.match(source, /interaction\.authorizedServerId/);
  assert.match(source, /MessageFlags\.Ephemeral/);
  assert.doesNotMatch(source, /\.deploy\(|\.restore\(|controlServer\(/);
  assert.match(authorization, /'mission-init':\s*'server_manage'/);
}

function testCommandModuleLoadsWithoutEncryptionConfiguration() {
  const root = path.join(__dirname, '..');
  const env = { ...process.env };
  delete env.ENCRYPTION_KEY;
  const loaded = spawnSync(process.execPath, ['-e', "require('./bot/commands/mission-init')"], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert.strictEqual(loaded.status, 0, loaded.stderr || loaded.stdout);
}

function testDiscordEmbedProjectionIsSanitizedAndBounded() {
  if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);
  const { buildStatusEmbed } = require('../bot/commands/mission-init');
  assert.strictEqual(typeof buildStatusEmbed, 'function');
  const providerMission = 'private-provider-mission-' + 'x'.repeat(2048);
  const oversized = 'z'.repeat(2048);
  const embed = buildStatusEmbed({
    capability: {
      status: oversized,
      platform: oversized,
      activeMission: providerMission,
      observedAt: '2026-09-05T02:00:00.000Z',
    },
    liveSourceHash: oversized,
    providerState: oversized,
    latestOperation: {
      id: oversized,
      action: oversized,
      status: oversized,
      candidateHash: oversized,
      configurationHash: oversized,
    },
    providerRecovery: {
      operationId: oversized,
      workflow: oversized,
      status: oversized,
    },
    runtimeEvidence: oversized,
    controlPlane: { desiredState: oversized, approval: oversized },
  }).toJSON();
  const serialized = JSON.stringify(embed);
  const aggregateTextLength = (embed.title?.length || 0) +
    (embed.description?.length || 0) +
    embed.fields.reduce((total, field) => total + field.name.length + field.value.length, 0);
  assert(!serialized.includes(providerMission));
  assert(embed.fields.every(field => field.value.length <= 1024));
  assert(aggregateTextLength <= 6000, `embed text exceeds Discord limit: ${aggregateTextLength}`);
}

async function main() {
  await testExactServerStatusProjection();
  await testRestoreAndDriftStates();
  await testDeniedOrAmbiguousContextStopsBeforeProvider();
  testDiscordCommandContract();
  testCommandModuleLoadsWithoutEncryptionConfiguration();
  testDiscordEmbedProjectionIsSanitizedAndBounded();
  console.log('✅ Mission init Discord status tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
