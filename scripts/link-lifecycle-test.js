'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function main() {
  const reconcilerPath = path.join(__dirname, '..', 'utils', 'linkRoleReconciler.js');
  assert.ok(fs.existsSync(reconcilerPath), 'shared membership-aware role reconciler must exist');

  const {
    computeRoleReconciliation,
    retryRoleOperation,
    enqueueRoleReconciliationJob,
    runRoleReconciliationJob,
    reconcileDiscordMemberRoles,
  } = require(reconcilerPath);
  const {
    getLinkSettings,
    validateGuildRoleSettings,
    saveLinkSettings,
  } = require(path.join(__dirname, '..', 'bot', 'utils', 'linkSettings.js'));
  const { applyGuildJoinRoles } = require(path.join(__dirname, '..', 'bot', 'events', 'guildMemberAdd.js'));
  const joinAdds = [];
  const joinMember = {
    id: 'known-discord-user',
    guild: { id: 'guild-join' },
    roles: {
      async add(roleIds) { joinAdds.push([...roleIds].sort()); },
      async remove() {},
    },
  };
  await applyGuildJoinRoles(joinMember, {
    async query() {
      return {
        rows: [
          { config: JSON.stringify({ roles: { assignOnJoin: ['newcomer', 'shared'] } }) },
          { config: JSON.stringify({ roles: { assignOnJoin: ['shared', 'community'] } }) },
        ],
      };
    },
  });
  assert.deepStrictEqual(joinAdds, [['community', 'newcomer', 'shared']],
    'known dashboard users must receive the guild-wide assignOnJoin union on rejoin');

  const guildMemberAddEvent = require(path.join(__dirname, '..', 'bot', 'events', 'guildMemberAdd.js'));
  for (const linked of [true, false]) {
    const lifecycleAdds = [];
    const lifecycleDb = {
      async query(sql) {
        if (/SELECT id FROM users/.test(sql)) return { rows: [{ id: linked ? 71 : 72 }] };
        if (/INSERT INTO discord_role_reconciliation_jobs/.test(sql)) {
          return {
            rows: [{
              id: linked ? 81 : 82,
              discord_guild_id: 'guild-known',
              discord_user_id: linked ? 'known-linked' : 'known-unlinked',
              user_id: linked ? 71 : 72,
              generation: 1,
            }],
          };
        }
        if (/SELECT sf\.enabled/.test(sql)) return { rows: [] };
        if (/SET status = 'completed'/.test(sql)) return { rows: [] };
        if (/SELECT sf\.config/.test(sql)) {
          return { rows: [{ config: JSON.stringify({ roles: { assignOnJoin: ['guild-join-role'] } }) }] };
        }
        throw new Error(`Unexpected guildMemberAdd query: ${sql}`);
      },
    };
    await guildMemberAddEvent.execute({
      id: linked ? 'known-linked' : 'known-unlinked',
      guild: { id: 'guild-known' },
      roles: {
        cache: new Map(),
        async add(roleIds) { lifecycleAdds.push(...roleIds); },
        async remove() {},
      },
    }, lifecycleDb);
    assert.ok(lifecycleAdds.includes('guild-join-role'),
      `known ${linked ? 'linked' : 'unlinked'} dashboard users must receive assignOnJoin roles`);
  }

  const resilientJoinAdds = [];
  const resilientJoinDb = {
    async query(sql) {
      if (/SELECT id FROM users/.test(sql)) return { rows: [{ id: 73 }] };
      if (/INSERT INTO discord_role_reconciliation_jobs/.test(sql)) {
        return {
          rows: [{
            id: 83,
            discord_guild_id: 'guild-known',
            discord_user_id: 'known-resilient',
            user_id: 73,
            generation: 1,
          }],
        };
      }
      if (/SELECT sf\.enabled/.test(sql)) throw new Error('link-role policy lookup failed');
      if (/attempts = attempts \+ 1/.test(sql)) return { rows: [] };
      if (/SELECT sf\.config/.test(sql)) {
        return { rows: [{ config: JSON.stringify({ roles: { assignOnJoin: ['resilient-join-role'] } }) }] };
      }
      throw new Error(`Unexpected resilient guildMemberAdd query: ${sql}`);
    },
  };
  await guildMemberAddEvent.execute({
    id: 'known-resilient',
    guild: { id: 'guild-known' },
    roles: {
      cache: new Map(),
      async add(roleIds) { resilientJoinAdds.push(...roleIds); },
      async remove() {},
    },
  }, resilientJoinDb);
  assert.ok(resilientJoinAdds.includes('resilient-join-role'),
    'assignOnJoin must still run when linked-role reconciliation remains retryable');

  const disabledSettings = await getLinkSettings({
    async query() {
      return {
        rows: [{
          enabled: 0,
          config: JSON.stringify({
            emoteVerificationEnabled: true,
            roles: { assignOnLink: ['disabled-role'] },
          }),
        }],
      };
    },
  }, 7);
  assert.strictEqual(disabledSettings.verificationMode, 'admin_approval',
    'a disabled player_linking feature must fail closed to administrator approval');
  assert.deepStrictEqual(disabledSettings.roles.assignOnLink, [],
    'a disabled player_linking feature must not expose active role settings');

  const deniedQueries = [];
  const deniedPool = {
    async query(sql) {
      deniedQueries.push(sql);
      if (/SELECT \* FROM guilds/.test(sql)) return { rows: [{ id: 7 }] };
      if (/FROM guild_tokens/.test(sql)) return { rows: [{ id: 1 }] };
      if (/FROM player_identities/.test(sql)) {
        return {
          rows: [{
            id: 11,
            gamertag: 'DeniedPlayer',
            server_id: 23,
            guild_id: 7,
            server_name: 'Denied Server',
            linked_account_id: null,
            linked_user_id: null,
            membership_status: null,
          }],
        };
      }
      if (/SELECT id FROM users/.test(sql)) return { rows: [] };
      if (/FROM server_features/.test(sql)) return { rows: [{ enabled: 0, config: '{}' }] };
      if (/INSERT INTO users/.test(sql)) return { rows: [{ id: 99 }] };
      throw new Error(`Unexpected denied-link query: ${sql}`);
    },
  };
  const botDbPath = require.resolve(path.join(__dirname, '..', 'bot', 'db.js'));
  const linkCommandPath = require.resolve(path.join(__dirname, '..', 'bot', 'commands', 'link.js'));
  const originalBotDbModule = require.cache[botDbPath];
  require.cache[botDbPath] = { id: botDbPath, filename: botDbPath, loaded: true, exports: deniedPool };
  delete require.cache[linkCommandPath];
  const deniedLinkCommand = require(linkCommandPath);
  const deniedReplies = [];
  await deniedLinkCommand.execute({
    authorizedServerId: 23,
    guild: { id: 'guild-denied' },
    user: { id: 'discord-denied', username: 'Denied User', avatar: null },
    member: { roles: { cache: new Map(), async add() {}, async remove() {} } },
    options: {
      getString(name) { return name === 'gamertag' ? 'DeniedPlayer' : null; },
    },
    async deferReply() {},
    async editReply(reply) { deniedReplies.push(reply); },
  });
  delete require.cache[linkCommandPath];
  if (originalBotDbModule) require.cache[botDbPath] = originalBotDbModule;
  else delete require.cache[botDbPath];
  assert.ok(deniedReplies.some(reply => String(reply?.content || reply).includes('requires administrator')),
    'disabled exact-server policy must deny a first-time claim pending administrator approval');
  assert.deepStrictEqual(
    deniedQueries.filter(sql => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)),
    [],
    'denied first-time /link must not persist user, challenge, ownership, membership, or outbox writes'
  );

  await assert.rejects(
    () => validateGuildRoleSettings({
      async query() {
        return {
          rows: [{
            server_id: 8,
            enabled: 1,
            config: JSON.stringify({ roles: { removeOnLink: ['member-role'] } }),
          }],
        };
      },
    }, 7, {
      roles: { assignOnLink: ['member-role'] },
    }),
    /contradictory/i,
    'guild-wide policies must reject assigning and removing the same role on link'
  );

  const result = computeRoleReconciliation([
    {
      active: true,
      roles: {
        assignOnLink: ['player', 'shared'],
        removeOnLink: ['visitor'],
        removeOnLeave: ['player', 'shared'],
      },
    },
    {
      active: true,
      roles: {
        assignOnLink: ['vip', 'shared'],
        removeOnLink: [],
        removeOnLeave: ['vip', 'shared'],
      },
    },
    {
      active: false,
      roles: {
        assignOnLink: ['former'],
        removeOnLink: [],
        removeOnLeave: ['former', 'shared'],
      },
    },
  ], ['shared', 'former', 'visitor']);

  assert.deepStrictEqual([...result.add].sort(), ['player', 'vip']);
  assert.deepStrictEqual([...result.remove].sort(), ['former', 'visitor']);
  assert.ok(!result.remove.has('shared'), 'a role required by another active membership must not be removed');

  const activeRemoveOnLeaveOnly = computeRoleReconciliation([{
    active: true,
    roles: { assignOnLink: [], removeOnLink: [], removeOnLeave: ['lifecycle-only'] },
  }], ['lifecycle-only']);
  assert.deepStrictEqual([...activeRemoveOnLeaveOnly.remove], [],
    'removeOnLeave-only roles must not be removed while the exact-server membership is active');

  const unlinkedRemoveOnLeaveOnly = computeRoleReconciliation([{
    active: false,
    roles: { assignOnLink: [], removeOnLink: [], removeOnLeave: ['lifecycle-only'] },
  }], ['lifecycle-only']);
  assert.deepStrictEqual([...unlinkedRemoveOnLeaveOnly.remove], ['lifecycle-only'],
    'removeOnLeave-only roles must be removed after the exact-server membership leaves linked state');

  const disabledActiveRemoveOnLeaveOnly = computeRoleReconciliation([{
    enabled: false,
    active: true,
    roles: { assignOnLink: [], removeOnLink: [], removeOnLeave: ['lifecycle-only'] },
  }], ['lifecycle-only']);
  assert.deepStrictEqual([...disabledActiveRemoveOnLeaveOnly.remove], [],
    'disabling a policy must not treat an active membership as a leave lifecycle event');

  const noMembership = computeRoleReconciliation([
    {
      active: false,
      roles: {
        assignOnLink: ['player'],
        removeOnLink: ['visitor'],
        removeOnLeave: ['player'],
      },
    },
  ], ['player', 'visitor']);
  assert.deepStrictEqual([...noMembership.add], []);
  assert.deepStrictEqual([...noMembership.remove].sort(), ['player']);
  assert.ok(!noMembership.remove.has('visitor'), 'removeOnLink applies only while at least one membership is active');

  const disabledPolicy = computeRoleReconciliation([{
    enabled: false,
    active: true,
    roles: {
      assignOnLink: ['formerly-managed'],
      removeOnLink: [],
      removeOnLeave: ['formerly-managed'],
    },
  }], ['formerly-managed']);
  assert.deepStrictEqual([...disabledPolicy.add], [],
    'disabled policies must not contribute required roles');
  assert.deepStrictEqual([...disabledPolicy.remove], ['formerly-managed'],
    'disabled policies must retain enough history to remove formerly managed roles');

  const changedPolicy = computeRoleReconciliation([{
    enabled: true,
    active: true,
    managedRoleIds: ['removed-from-settings'],
    roles: { assignOnLink: [], removeOnLink: [], removeOnLeave: [] },
  }], ['removed-from-settings']);
  assert.deepStrictEqual([...changedPolicy.remove], ['removed-from-settings'],
    'roles removed from settings must remain known until reconciliation removes them');

  let attempts = 0;
  const retried = await retryRoleOperation(async () => {
    attempts++;
    if (attempts < 3) throw new Error('transient Discord failure');
    return 'ok';
  }, 3);
  assert.strictEqual(retried, 'ok');
  assert.strictEqual(attempts, 3, 'role reconciliation must retry transient failures');

  const discordRequests = [];
  const staleRoleDb = {
    async query(sql) {
      if (/SELECT sf\.enabled/.test(sql)) {
        return {
          rows: [{
            enabled: 1,
            active: true,
            managed_role_ids: [],
            config: JSON.stringify({ roles: { assignOnLink: ['deleted-role', 'live-role'] } }),
          }],
        };
      }
      throw new Error(`Unexpected stale-role query: ${sql}`);
    },
  };
  await reconcileDiscordMemberRoles({
    db: staleRoleDb,
    discordGuildId: 'guild-stale-role',
    discordUserId: 'member-stale-role',
    userId: 91,
    botToken: 'test-token',
    fetchImpl: async (url, options = {}) => {
      discordRequests.push([url, options.method || 'GET']);
      if (!options.method) {
        return { ok: true, status: 200, async json() { return { roles: [] }; } };
      }
      if (url.endsWith('/deleted-role')) {
        return { ok: false, status: 404, async json() { return { code: 10011 }; } };
      }
      return { ok: true, status: 204, async json() { return {}; } };
    },
  });
  assert.ok(discordRequests.some(([url, method]) => url.endsWith('/live-role') && method === 'PUT'),
    'a deleted configured role must not block assigning remaining live roles');

  const memberAdds = [];
  await reconcileDiscordMemberRoles({
    db: staleRoleDb,
    discordGuildId: 'guild-stale-role',
    discordUserId: 'member-stale-role',
    userId: 91,
    member: {
      guild: { roles: { cache: new Map([['live-role', { id: 'live-role' }]]) } },
      roles: {
        cache: new Map(),
        async add(roleIds) {
          if (roleIds.includes('deleted-role')) throw new Error('Unknown Role');
          memberAdds.push(...roleIds);
        },
        async remove() {},
      },
    },
  });
  assert.deepStrictEqual(memberAdds, ['live-role'],
    'interactive reconciliation must omit configured roles deleted from the guild');

  const botEntrySource = fs.readFileSync(path.join(__dirname, '..', 'bot', 'index.js'), 'utf8');
  assert.doesNotMatch(botEntrySource, /global\.fetch\s*=/,
    'the bot must preserve Node native fetch so Discord errors are not rewritten as Nitrado errors');

  const jobQueries = [];
  const jobDb = {
    async query(sql, params) {
      jobQueries.push([sql, params]);
      if (/INSERT INTO discord_role_reconciliation_jobs/.test(sql) && /RETURNING \*/.test(sql)) {
        return {
          rows: [{
            id: 41,
            discord_guild_id: 'guild-1',
            discord_user_id: 'discord-2',
            user_id: 3,
            generation: 1,
          }],
        };
      }
      return { rows: [{ id: 41 }] };
    },
  };
  const directJob = await enqueueRoleReconciliationJob(jobDb, {
    discordGuildId: 'guild-1',
    discordUserId: 'discord-2',
    userId: 3,
  });
  assert.match(jobQueries[0][0], /INSERT INTO discord_role_reconciliation_jobs/,
    'link mutations must be able to enqueue durable role work');
  let directContext;
  await runRoleReconciliationJob({
    db: jobDb,
    job: directJob,
    reconcile: async context => { directContext = context; },
  });
  assert.deepStrictEqual(
    {
      discordGuildId: directContext.discordGuildId,
      discordUserId: directContext.discordUserId,
      userId: directContext.userId,
    },
    { discordGuildId: 'guild-1', discordUserId: 'discord-2', userId: 3 },
    'direct enqueue result must contain the complete context needed by the immediate runner'
  );
  await assert.rejects(
    () => runRoleReconciliationJob({
      db: jobDb,
      job: {
        id: 41,
        discord_guild_id: 'guild-1',
        discord_user_id: 'discord-2',
        user_id: 3,
      },
      reconcile: async () => { throw new Error('Discord unavailable'); },
    }),
    /Discord unavailable/
  );
  assert.ok(jobQueries.some(([sql]) => /attempts = attempts \+ 1/.test(sql) && /next_attempt_at/.test(sql)),
    'failed immediate reconciliation must remain durable and retryable');

  const concurrentState = {
    id: 52,
    discord_guild_id: 'guild-race',
    discord_user_id: 'discord-race',
    user_id: 9,
    status: 'processing',
    generation: 1,
  };
  const concurrentDb = {
    async query(sql) {
      if (/INSERT INTO discord_role_reconciliation_jobs/.test(sql)) {
        concurrentState.generation += 1;
        concurrentState.status = 'pending';
        return { rows: [{ ...concurrentState }] };
      }
      if (/SET status = 'completed'/.test(sql)) {
        const generationMatch = /generation\s*=\s*\$(\d+)/.exec(sql);
        const protectsNewerEnqueue = generationMatch !== null;
        if (!protectsNewerEnqueue || concurrentState.generation === 1) {
          concurrentState.status = 'completed';
        }
        return { rows: [] };
      }
      throw new Error(`Unexpected concurrency test query: ${sql}`);
    },
  };
  await runRoleReconciliationJob({
    db: concurrentDb,
    job: { ...concurrentState },
    reconcile: async () => {
      await enqueueRoleReconciliationJob(concurrentDb, {
        discordGuildId: concurrentState.discord_guild_id,
        discordUserId: concurrentState.discord_user_id,
        userId: concurrentState.user_id,
      });
    },
  });
  assert.strictEqual(concurrentState.status, 'pending',
    'enqueue during processing must not be completed by the stale worker');

  const settingsCompletionState = {
    id: 54,
    discord_guild_id: 'guild-settings-race',
    discord_user_id: 'discord-settings-race',
    user_id: 11,
    status: 'processing',
    generation: 1,
    locked_at: new Date(),
    attempts: 0,
    last_error: null,
  };
  let settingsBulkSql = '';
  let settingsManagedRoleIds = [];
  const settingsLifecycle = [];
  const settingsClient = {
    async query(sql, params = []) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) {
        settingsLifecycle.push(sql);
        return { rows: [] };
      }
      if (/SELECT sf\.server_id/.test(sql)) return { rows: [] };
      if (/SELECT config FROM server_features/.test(sql)) return { rows: [] };
      if (/INSERT INTO discord_link_role_policy_history/.test(sql)) {
        settingsManagedRoleIds = params[1] || [];
        return { rows: [] };
      }
      if (/INSERT INTO server_features/.test(sql)) return { rows: [] };
      if (/INSERT INTO discord_role_reconciliation_jobs/.test(sql)) {
        settingsBulkSql = sql;
        settingsCompletionState.status = 'pending';
        if (/generation = discord_role_reconciliation_jobs\.generation \+ 1/.test(sql)) {
          settingsCompletionState.generation += 1;
        }
        if (/locked_at = NULL/.test(sql)) settingsCompletionState.locked_at = null;
        return /RETURNING \*/.test(sql) ? { rows: [{ ...settingsCompletionState }] } : { rows: [] };
      }
      if (/SET status = 'completed'/.test(sql)) {
        if (settingsCompletionState.generation === params[1]) {
          settingsCompletionState.status = 'completed';
        }
        return { rows: [] };
      }
      if (/attempts = attempts \+ 1/.test(sql)) {
        if (settingsCompletionState.generation === params[2]) {
          settingsCompletionState.status = 'pending';
          settingsCompletionState.attempts += 1;
          settingsCompletionState.last_error = params[0];
        }
        return { rows: [] };
      }
      throw new Error(`Unexpected settings completion query: ${sql}`);
    },
    release() { settingsLifecycle.push('RELEASE'); },
  };
  await saveLinkSettings({ async connect() { return settingsClient; } }, 7, {
    roles: { assignOnLink: ['new-role'], removeOnLeave: ['lifecycle-only'] },
  }, {
    async runRoleJob({ job }) {
      settingsLifecycle.push(`RUN:${job.discord_guild_id}:${job.discord_user_id}:${job.user_id}:${job.generation}`);
    },
  });
  assert.deepStrictEqual(settingsLifecycle, [
    'BEGIN',
    'COMMIT',
    'RELEASE',
    'RUN:guild-settings-race:discord-settings-race:11:2',
  ], 'settings jobs must run with complete context only after commit and transaction-client release');
  assert.deepStrictEqual(settingsManagedRoleIds, ['new-role'],
    'removeOnLeave-only roles must not enter active-reconciliation assignment history');
  await runRoleReconciliationJob({
    db: settingsClient,
    job: { ...settingsCompletionState, generation: 1, status: 'processing' },
    reconcile: async () => {},
  });
  assert.strictEqual(settingsCompletionState.status, 'pending',
    'a settings save during processing must not be completed by the stale worker generation');
  assert.strictEqual(settingsCompletionState.locked_at, null,
    'a settings save must clear the obsolete processing lock');
  assert.match(settingsBulkSql, /RETURNING \*/,
    'settings bulk enqueue must return complete jobs for immediate reconciliation');
  assert.match(settingsBulkSql, /NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ/,
    'settings bulk enqueue must type nullable SELECT expressions for PostgreSQL');

  settingsCompletionState.status = 'processing';
  settingsCompletionState.locked_at = new Date();
  const staleSettingsRetryJob = { ...settingsCompletionState };
  await saveLinkSettings({ async connect() { return settingsClient; } }, 7, {
    roles: { assignOnLink: ['newer-role'] },
  }, { async runRoleJob() {} });
  await assert.rejects(
    () => runRoleReconciliationJob({
      db: settingsClient,
      job: staleSettingsRetryJob,
      reconcile: async () => { throw new Error('stale settings failure'); },
    }),
    /stale settings failure/
  );
  assert.deepStrictEqual(
    {
      status: settingsCompletionState.status,
      attempts: settingsCompletionState.attempts,
      lastError: settingsCompletionState.last_error,
    },
    { status: 'pending', attempts: 0, lastError: null },
    'a stale settings worker retry must not delay or overwrite the newer settings generation'
  );

  const failedConcurrentState = {
    id: 53,
    discord_guild_id: 'guild-failed-race',
    discord_user_id: 'discord-failed-race',
    user_id: 10,
    status: 'processing',
    generation: 1,
    attempts: 0,
    last_error: null,
  };
  const failedConcurrentDb = {
    async query(sql) {
      if (/INSERT INTO discord_role_reconciliation_jobs/.test(sql)) {
        failedConcurrentState.generation += 1;
        failedConcurrentState.status = 'pending';
        return { rows: [{ ...failedConcurrentState }] };
      }
      if (/attempts = attempts \+ 1/.test(sql)) {
        const protectsNewerEnqueue = /generation\s*=\s*\$(\d+)/.test(sql);
        if (!protectsNewerEnqueue || failedConcurrentState.generation === 1) {
          failedConcurrentState.attempts += 1;
          failedConcurrentState.last_error = 'stale failure';
        }
        return { rows: [] };
      }
      throw new Error(`Unexpected failed concurrency test query: ${sql}`);
    },
  };
  await assert.rejects(
    () => runRoleReconciliationJob({
      db: failedConcurrentDb,
      job: { ...failedConcurrentState },
      reconcile: async () => {
        await enqueueRoleReconciliationJob(failedConcurrentDb, {
          discordGuildId: failedConcurrentState.discord_guild_id,
          discordUserId: failedConcurrentState.discord_user_id,
          userId: failedConcurrentState.user_id,
        });
        throw new Error('stale failure');
      },
    }),
    /stale failure/
  );
  assert.deepStrictEqual(
    { attempts: failedConcurrentState.attempts, lastError: failedConcurrentState.last_error },
    { attempts: 0, lastError: null },
    'stale worker failure must not delay or overwrite a newer enqueue generation'
  );

  const migrationPath = path.join(__dirname, '..', 'db', 'migrations', '053_discord_role_reconciliation_jobs.js');
  assert.ok(fs.existsSync(migrationPath), 'durable role reconciliation migration 053 must exist');
  const migrationSource = fs.readFileSync(migrationPath, 'utf8');
  for (const required of ['discord_role_reconciliation_jobs', 'next_attempt_at', 'last_error', 'attempts']) {
    assert.ok(migrationSource.includes(required), `role reconciliation migration is missing ${required}`);
  }
  assert.match(migrationSource, /ADD COLUMN IF NOT EXISTS generation/,
    'migration 053 reruns must upgrade an outbox created by an earlier migration revision');
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS discord_link_role_policy_history/,
    'migration 053 must remain compatible with a fresh schema run');
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS discord_role_reconciliation_jobs/,
    'migration 053 must remain compatible with a fresh schema run');

  const accountLinking = fs.readFileSync(path.join(__dirname, '..', 'routes', 'accountLinking.js'), 'utf8');
  assert.ok(accountLinking.includes('serverId'), 'website unlink must require exact server selection');
  assert.ok(accountLinking.includes("SET status = 'revoked'"), 'website unlink must revoke exact-server membership');
  assert.ok(!accountLinking.includes('DELETE FROM linked_accounts'), 'website unlink must preserve global ownership proof');
  assert.ok(accountLinking.includes('runRoleReconciliationJob'), 'website lifecycle must trigger role reconciliation');
  assert.ok((accountLinking.match(/enqueueRoleReconciliationJob/g) || []).length >= 4,
    'every website link/reactivation/unlink path must enqueue durable role reconciliation');
  assert.match(accountLinking, /transactionDb[\s\S]*enqueueRoleReconciliationJob\(transactionDb/,
    'website role work must be enqueued in the membership transaction');
  assert.match(accountLinking, /FOR UPDATE[\s\S]{0,800}verificationMode !== 'open'/,
    'website open self-link must revalidate the exact-server policy inside the membership transaction');
  assert.ok((accountLinking.match(/feature_name = 'player_linking'[\s\S]{0,80}FOR UPDATE/g) || []).length >= 2,
    'website must lock and revalidate policy for both open and emote ownership claims');
  assert.match(accountLinking, /FROM server_player_memberships spm[\s\S]*spm\.status = 'active'/,
    'website linked-account listing must come from active exact-server memberships');

  const botLink = fs.readFileSync(path.join(__dirname, '..', 'bot', 'commands', 'link.js'), 'utf8');
  assert.match(botLink, /const authorizedServerId = interaction\.authorizedServerId/);
  assert.doesNotMatch(botLink, /CAST\(s\.id AS TEXT\) = \$3/,
    'bot link must not re-resolve a client identifier in a different ID domain');
  assert.ok(botLink.includes('enqueueRoleReconciliationJob(client'),
    'bot link must enqueue role reconciliation before committing membership');
  assert.match(botLink, /getLinkSettings\(client, account\.server_id, \{ forUpdate: true \}\)/,
    'bot open self-link must lock and revalidate the exact-server policy inside the transaction');
  const botUnlink = fs.readFileSync(path.join(__dirname, '..', 'bot', 'commands', 'unlink.js'), 'utf8');
  assert.ok(botUnlink.includes('enqueueRoleReconciliationJob(client'),
    'bot unlink must transactionally enqueue role reconciliation');
  const linkSettingsSource = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'linkSettings.js'), 'utf8');
  assert.match(linkSettingsSource, /INSERT INTO discord_role_reconciliation_jobs[\s\S]*server_player_memberships/,
    'settings changes must enqueue every affected guild member');
  const memberAddSource = fs.readFileSync(path.join(__dirname, '..', 'bot', 'events', 'guildMemberAdd.js'), 'utf8');
  assert.ok(memberAddSource.includes('enqueueRoleReconciliationJob'),
    'guildMemberAdd must create durable role reconciliation work');
  const workerPath = path.join(__dirname, '..', 'bot', 'events', 'linkRoleReconciliationReady.js');
  assert.ok(fs.existsSync(workerPath), 'the durable role outbox must have a retry worker');

  const reconcilerSource = fs.readFileSync(reconcilerPath, 'utf8');
  assert.match(reconcilerSource, /JOIN linked_accounts la[\s\S]*la\.verification_method IN/,
    'role reconciliation must ignore memberships without trusted ownership provenance');
  assert.doesNotMatch(reconcilerSource, /sf\.enabled = 1/,
    'disabled role policies must remain visible so formerly-managed roles can be removed');

  for (const relative of [
    'middleware/serverAccess.js',
    'routes/factions.js',
  ]) {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    assert.ok(source.includes('server_player_memberships'), `${relative} must authorize players through exact-server memberships`);
  }
  const mapHeatmap = fs.readFileSync(path.join(__dirname, '..', 'routes', 'mapHeatmap.js'), 'utf8');
  const authorizationService = fs.readFileSync(path.join(__dirname, '..', 'services', 'authorizationService.js'), 'utf8');
  assert.ok(mapHeatmap.includes('authorizePlatformServer'));
  assert.ok(authorizationService.includes('server_player_memberships'),
    'map heatmaps must authorize players through centralized exact-server memberships');

  console.log('✅ Exact-server link lifecycle and role reconciliation tests passed');
}

main().catch(error => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
