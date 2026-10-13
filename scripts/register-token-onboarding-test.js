'use strict';

// Isolated executable command contract: no Discord, provider, environment or DB access.
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { ACTOR_ROLE_LOCK_NAMESPACE, lockPgUserRoleMutations } = require('../utils/roleMutationLocks');
const GUILD = '123456789012345678';
const ACTOR = '223456789012345678';
const OWNER = '323456789012345678';
const OTHER = '123456789012345679'; // adjacent snowflake must never alias GUILD
const GUILD_DB = 71;
const ACTOR_DB = 20;
const OWNER_DB = 10;
const root = path.resolve(__dirname, '..');
const tests = [];
const test = (name, run) => tests.push({ name, run });

async function runCommand(options = {}) {
  const actor = options.ownerActor ? OWNER : ACTOR;
  const actorId = options.ownerActor ? OWNER_DB : ACTOR_DB;
  const initial = {
    users: [{ id: ACTOR_DB, discord_id: ACTOR }, { id: OWNER_DB, discord_id: OWNER }],
    guild: options.newGuild ? null : { id: GUILD_DB, discord_guild_id: GUILD, status: options.status || 'pending' },
    roles: options.established ? [{ guild_id: GUILD_DB, user_id: OWNER_DB, role: 'owner' }] : [],
    token: options.established ? { nitrado_user_id: '900', token_hash: 'old' } : null,
    setup: options.newGuild || options.noSetup ? null : { status: 'in_progress', current_step: 'discord_connected' },
    audits: [],
  };
  if (options.role && !options.ownerActor) initial.roles.push({ guild_id: GUILD_DB, user_id: actorId, role: options.role });
  if (options.conflictingOwner) initial.roles = [{ guild_id: GUILD_DB, user_id: ACTOR_DB, role: 'owner' }];
  if (options.missingUsers) initial.users = [];
  if (options.initialUsers) initial.users = options.initialUsers;
  if (options.existingToken) initial.token = { nitrado_user_id: options.existingToken, token_hash: 'old' };
  let state = structuredClone(initial);
  let working;
  const events = [];
  const replies = [];
  let fetchCount = 0;
  let permissionRevoked = false;
  let releaseError;
  const result = rows => ({ rows, rowCount: rows.length });
  const client = {
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, ' ').trim();
      events.push({ sql: q, params });
      const hooked = await options.queryHook?.(q, params, working);
      if (hooked !== undefined) return hooked;
      if (q === 'BEGIN') { working = structuredClone(state); return result([]); }
      if (q === 'COMMIT') { state = structuredClone(working); working = null; return result([]); }
      if (q === 'ROLLBACK') {
        working = null;
        if (options.rollbackFails) throw new Error('simulated rollback failure');
        return result([]);
      }
      assert(working, `query escaped transaction: ${q}`);
      if (options.failSql && options.failSql.test(q)) throw new Error('simulated write failure');
      if (options.zeroSql && options.zeroSql.test(q)) return result([]);
      if (q.includes('pg_try_advisory_xact_lock')) return result([{ locked: true }]);
      if (q.includes('pg_advisory_xact_lock')) return result([]);
      if (q.startsWith('SELECT') && q.includes('FROM users')) {
        const ids = Array.isArray(params[0]) ? params[0] : [params[0]];
        return result(working.users.filter(u => q.includes('discord_id =') ? ids.includes(u.discord_id) : ids.includes(u.id)));
      }
      if (q.startsWith('INSERT INTO users')) {
        let user = working.users.find(u => u.discord_id === params[0]);
        if (user && q.includes('DO NOTHING')) return result([]);
        if (!user) { user = { id: params[0] === OWNER ? OWNER_DB : ACTOR_DB, discord_id: params[0] }; working.users.push(user); }
        return result([user]);
      }
      if (q.startsWith('UPDATE users')) {
        assert.match(q, /WHERE id = \$1 AND discord_id = \$4/);
        const user = working.users.find(u => u.id === params[0] && u.discord_id === params[3]);
        if (!user) return result([]);
        user.username = params[1]; user.avatar = params[2];
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith('SELECT') && q.includes('FROM guilds')) {
        assert(params[0] === GUILD || params[0] === GUILD_DB, 'exact guild lookup');
        return result(working.guild ? [working.guild] : []);
      }
      if (q.startsWith('INSERT INTO guilds')) {
        assert.equal(params[0], GUILD);
        working.guild = working.guild || { id: GUILD_DB, discord_guild_id: GUILD, status: options.concurrentGuildStatus || 'pending' };
        return result([working.guild]);
      }
      if (q.startsWith('UPDATE guilds')) {
        assert.equal(params[0], GUILD_DB);
        working.guild.status = 'approved'; return result([{ id: GUILD_DB }]);
      }
      if (q.startsWith('SELECT') && q.includes('FROM guild_roles')) {
        assert.equal(params[0], GUILD_DB);
        let rows = working.roles.filter(r => r.guild_id === params[0]);
        if (q.includes("role = 'owner'")) rows = rows.filter(r => r.role === 'owner');
        if (q.includes('user_id = $2')) rows = options.storedRevoked ? [] : rows.filter(r => r.user_id === params[1]);
        if (q.includes("role IN ('owner', 'admin')")) rows = rows.filter(r => ['owner', 'admin'].includes(r.role));
        return result(rows.map(r => ({ ...r, discord_id: working.users.find(u => u.id === r.user_id)?.discord_id })));
      }
      if (q.startsWith('INSERT INTO guild_roles')) {
        assert.equal(params[0], GUILD_DB);
        const role = q.includes("VALUES ($1, $2, 'owner'") ? 'owner' : 'admin';
        let row = working.roles.find(r => r.guild_id === params[0] && r.user_id === params[1]);
        if (row && q.includes("guild_roles.role <> 'owner'") && row.role === 'owner') return result([]);
        if (row) row.role = role;
        else { row = { guild_id: params[0], user_id: params[1], role }; working.roles.push(row); }
        return result([row]);
      }
      if (q.startsWith('SELECT') && q.includes('FROM guild_tokens')) {
        if (q.includes('guild_id <> $2')) {
          assert.deepEqual(params, ['900', GUILD_DB]);
          return result(options.providerConflict ? [{ guild_id: 99 }] : []);
        }
        assert.equal(params[0], GUILD_DB);
        if (options.revokedAtTokenLock) permissionRevoked = true;
        return result(working.token ? [working.token] : []);
      }
      if (q.startsWith('INSERT INTO guild_tokens')) {
        assert.equal(params[0], GUILD_DB);
        working.token = { token_hash: params[1], nitrado_user_id: params[2] };
        return result([{ id: 300 }]);
      }
      if (q.startsWith('SELECT') && q.includes('FROM guild_setup_state')) {
        assert.equal(params[0], GUILD_DB);
        return result(working.setup?.status === 'in_progress' ? [{ guild_id: GUILD_DB, ...working.setup }] : []);
      }
      if (q.startsWith('INSERT INTO guild_setup_state')) {
        assert.equal(params[0], GUILD_DB);
        working.setup = { status: 'in_progress', current_step: q.includes('nitrado_connected') ? 'nitrado_connected' : 'discord_connected' };
        return { rows: [], rowCount: 1 };
      }
      if (q.startsWith('INSERT INTO security_audit_events')) {
        assert.equal(params[1], GUILD_DB);
        working.audits.push({ sql: q, params });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unhandled test SQL: ${q}`);
    },
    release(error) { releaseError = error; events.push({ sql: 'RELEASE' }); },
  };
  const interaction = {
    guild: { id: GUILD, name: 'Fixture guild', iconURL: () => null },
    user: { id: actor, username: 'Fixture actor', avatar: null },
    options: { getString: () => 'fixture-token-not-a-credential' },
    reply: async value => replies.push(value),
    deferReply: async () => events.push({ sql: 'DEFER' }),
    editReply: async value => replies.push(value),
    client: { guilds: { fetch: async args => {
      assert.deepEqual(args, { guild: GUILD, force: true, cache: false });
      fetchCount++;
      events.push({ sql: 'DISCORD', fetchCount });
      const fresh = fetchCount > 1;
      if (fresh && options.unavailable) throw new Error('Discord unavailable');
      const owner = fresh && options.ownerChanged ? OTHER : OWNER;
      const guildId = fresh && options.guildMismatch ? OTHER : GUILD;
      return { id: guildId, ownerId: owner, members: { fetch: async args => {
        assert.equal(args.force, true); assert.equal(args.cache, false);
        const id = fresh && options.actorMismatch && args.user === actor ? OTHER : args.user;
        return { guild: { id: fresh && options.memberGuildMismatch ? OTHER : guildId }, user: { id, username: 'Fixture user', avatar: null },
          permissions: { has: () => !(options.member || (fresh && (options.revoked || permissionRevoked))) } };
      } } };
    } } },
  };
  const builder = new Proxy({}, { get: (_, key) => key === 'then' ? undefined : () => builder });
  const originalLoad = Module._load;
  const commandPath = path.join(root, 'bot/commands/register-token.js');
  const servicePath = path.join(root, 'bot/services/guildSetupService.js');
  const injected = new Map([
    [path.join(root, 'bot/db.js'), { connect: async () => client }],
    [path.join(root, 'utils/encryption.js'), { encryptToken: () => 'encrypted-fixture' }],
    [path.join(root, 'services/nitradoService.js'), {
      validateRegistrationToken: async () => ({ status: 'valid', userId: '900', username: 'fixture', scopes: ['user_info', 'service'], missingScopes: [] }),
      getRegistrationData: async () => ({
        dayzServers: options.noServers ? [] : [{ id: '901', name: 'Fixture server', platform: 'xbox' }],
        user: { id: '900' },
      }),
    }],
    [path.join(root, 'bot/utils/website.js'), { getWebsiteLink: () => 'https://dashboard.invalid' }],
  ]);
  delete require.cache[commandPath]; delete require.cache[servicePath];
  Module._load = function(request, parent, main) {
    if (request === 'discord.js') return { SlashCommandBuilder: function() { return builder; }, PermissionFlagsBits: { Administrator: 8n }, MessageFlags: { Ephemeral: 64 } };
    const resolved = Module._resolveFilename(request, parent);
    if (injected.has(resolved)) return injected.get(resolved);
    return originalLoad.call(this, request, parent, main);
  };
  const logs = [];
  const originalLog = console.log; const originalError = console.error;
  console.log = (...args) => logs.push(args); console.error = (...args) => logs.push(args);
  try { await require(commandPath).execute(interaction); }
  finally {
    Module._load = originalLoad; console.log = originalLog; console.error = originalError;
    delete require.cache[commandPath]; delete require.cache[servicePath];
  }
  for (const entry of logs.flat()) {
    if (entry?.code === 'ERR_ASSERTION' || /Unhandled test SQL/.test(entry?.message || '')) throw entry;
  }
  for (const event of events) assert(!/\b(platform_role|is_admin|server_role_assignments)\b/.test(event.sql), 'no global or server grants');
  return { state, initial, events, replies, fetchCount, releaseError, logs, actorId };
}

function denied(outcome) {
  assert(!outcome.replies.some(r => /registered successfully/.test(r.content)), 'registration must deny');
  assert.deepEqual(outcome.state, outcome.initial, 'denial leaves no committed changes');
}

test('missing identity ID10 versus peer10→20 retries without a lower lock or protected grants', async () => {
  // Deterministic two-client wait graph; both command/helper implementations are
  // real, only PostgreSQL's query/lock scheduling is simulated (no live DB).
  const held = new Map();
  const waits = new Map();
  const attempts = [];
  const acquire = async (who, id, blocking) => {
    attempts.push({ who, id, blocking });
    if (!held.has(id) || held.get(id) === who) { held.set(id, who); return true; }
    if (!blocking) return false;
    const holder = held.get(id);
    if (waits.has(holder) && held.get(waits.get(holder).id) === who) {
      throw new Error('simulated advisory deadlock: setup20→10 versus peer10→20');
    }
    return new Promise(resolve => waits.set(who, { id, resolve }));
  };
  const release = who => {
    for (const [id, holder] of held) if (holder === who) held.delete(id);
    for (const [waiter, wait] of waits) {
      if (!held.has(wait.id)) { held.set(wait.id, waiter); waits.delete(waiter); wait.resolve(true); }
    }
  };
  let resumePeer;
  const inserted = new Promise(resolve => { resumePeer = resolve; });
  const peer = lockPgUserRoleMutations({ query: async (sql, params) => {
    assert.equal(params[0], ACTOR_ROLE_LOCK_NAMESPACE);
    await acquire('peer', params[1], true);
    if (params[1] === OWNER_DB) await inserted;
    return { rows: [] };
  } }, [OWNER_DB, ACTOR_DB]);
  const out = await runCommand({
    initialUsers: [{ id: ACTOR_DB, discord_id: ACTOR }],
    queryHook: async (q, params, working) => {
      if (/pg_(try_)?advisory_xact_lock\(\$1, \$2\)/.test(q)) {
        assert.equal(params[0], ACTOR_ROLE_LOCK_NAMESPACE);
        const locked = await acquire('setup', params[1], !q.includes('pg_try_'));
        return { rows: [{ locked }], rowCount: 1 };
      }
      if (q.startsWith('INSERT INTO users')) {
        // A preallocated ID10 becomes visible after discovery missed it.
        working.users.push({ id: OWNER_DB, discord_id: OWNER });
        resumePeer();
        await new Promise(resolve => setImmediate(resolve));
        return { rows: [], rowCount: 0 }; // ON CONFLICT winner, then fallback SELECT
      }
      if (q === 'ROLLBACK' || q === 'COMMIT') release('setup');
    },
  });
  resumePeer();
  await peer;
  release('peer');
  denied(out);
  assert.match(out.replies.at(-1).content, /retry/i, 'contention must request a full retry, not deadlock');
  const setup = attempts.filter(a => a.who === 'setup');
  assert(!setup.some((a, i) => setup.slice(0, i).some(before => before.id > a.id)), 'never acquire a lower fence after a higher fence');
  assert.deepEqual(attempts.filter(a => a.who === 'peer').map(a => a.id), [OWNER_DB, ACTOR_DB]);
  assert(!out.events.some(e => /^(?:INSERT INTO|UPDATE) (?!users\b)/.test(e.sql)), 'retry writes no protected grants/token/setup/audit');
  assert(out.events.some(e => e.sql === 'ROLLBACK'));
});

test('revoked native Administrator after discovery cannot register', async () => {
  const out = await runCommand({ revoked: true });
  denied(out);
  assert.equal(out.fetchCount, 2, 'fresh Discord recheck inside transaction');
  assert(!out.events.some(e => e.sql.startsWith('INSERT INTO guild_tokens')), 'no protected write before fresh permission check');
});

test('missing-user unique conflict holds no user fence while the peer finishes', async () => {
  const setupLocks = [];
  let peerFinished = false;
  const out = await runCommand({
    initialUsers: [{ id: ACTOR_DB, discord_id: ACTOR }],
    queryHook: async (q, params, working) => {
      if (/pg_(try_)?advisory_xact_lock\(\$1, \$2\)/.test(q)) setupLocks.push(params[1]);
      if (!q.startsWith('INSERT INTO users')) return;
      assert.deepEqual(setupLocks, [], 'unique-conflict wait must not retain a fence needed by its writer');
      // The uncommitted ID10 writer needs fences10→20 before its commit can
      // resolve INSERT ON CONFLICT. Assert it can finish before returning.
      await lockPgUserRoleMutations({ query: async (sql, ids) => {
        assert(!setupLocks.includes(ids[1]), 'peer is not blocked by setup');
        return { rows: [] };
      } }, [OWNER_DB, ACTOR_DB]);
      peerFinished = true;
      working.users.push({ id: OWNER_DB, discord_id: OWNER });
      return { rows: [], rowCount: 0 };
    },
  });
  assert(peerFinished);
  assert(out.replies.some(r => /registered successfully/.test(r.content)), JSON.stringify(out.replies));
  assert.deepEqual(setupLocks, [OWNER_DB, ACTOR_DB]);
});

test('missing-user partial fence contention rolls back without profiles or protected grants', async () => {
  for (const locked of [false, undefined]) {
    const out = await runCommand({
      missingUsers: true,
      queryHook: async (q, params) => {
        if (q.includes('pg_try_advisory_xact_lock') && params[1] === ACTOR_DB) {
          return { rows: [{ locked }], rowCount: 1 };
        }
      },
    });
    denied(out);
    assert.match(out.replies.at(-1).content, /retry/i);
    assert.deepEqual(out.events.filter(e => e.sql.includes('pg_try_advisory_xact_lock')).map(e => e.params[1]), [OWNER_DB, ACTOR_DB]);
    assert(!out.events.some(e => e.sql.startsWith('UPDATE users') || /^(?:INSERT INTO|UPDATE) (?!users\b)/.test(e.sql)));
    assert(!out.events.some(e => /hashtext/.test(e.sql)), 'no tenant fence with incomplete identity fences');
    assert(out.events.some(e => e.sql === 'ROLLBACK'));
  }
});

test('removed or recreated accounts fail before profile refresh and protected grants', async () => {
  for (const missingUsers of [false, true]) {
    for (const recreate of [false, true]) {
      const out = await runCommand({
        missingUsers,
        queryHook: async (q, params, working) => {
          if (!/pg_(try_)?advisory_xact_lock\(\$1, \$2\)/.test(q) || params[1] !== ACTOR_DB) return;
          working.users = working.users.filter(u => u.discord_id !== ACTOR);
          if (recreate) working.users.push({ id: 30, discord_id: ACTOR });
        },
      });
      denied(out);
      assert.match(out.replies.at(-1).content, /account changed/);
      assert(!out.events.some(e => e.sql.startsWith('UPDATE users') || /^(?:INSERT INTO|UPDATE) (?!users\b)/.test(e.sql)));
      assert(!out.events.some(e => /hashtext/.test(e.sql)));
    }
  }
});

test('ordinary ascending missing identity registers after resolving the complete ID set', async () => {
  const out = await runCommand({ initialUsers: [{ id: OWNER_DB, discord_id: OWNER }] });
  assert(out.replies.some(r => /registered successfully/.test(r.content)), JSON.stringify(out.replies));
  const fences = out.events.filter(e => e.sql.includes('pg_try_advisory_xact_lock'));
  assert.deepEqual(fences.map(e => e.params), [[ACTOR_ROLE_LOCK_NAMESPACE, OWNER_DB], [ACTOR_ROLE_LOCK_NAMESPACE, ACTOR_DB]]);
  assert(out.events.findIndex(e => e.sql.startsWith('INSERT INTO users')) < out.events.indexOf(fences[0]));
});

test('owner identity changed after discovery fails closed', async () => {
  const out = await runCommand({ ownerChanged: true });
  denied(out);
  assert(!out.events.some(e => e.sql.startsWith('INSERT INTO guild_tokens')));
});

test('serialization locks accounts before guild and roles before fresh Discord check', async () => {
  const out = await runCommand({ established: true, role: 'admin', status: 'approved', revoked: true });
  denied(out);
  const userLocks = out.events.filter(e => e.sql === 'SELECT pg_advisory_xact_lock($1, $2)');
  assert.deepEqual(userLocks.map(e => e.params), [[ACTOR_ROLE_LOCK_NAMESPACE, OWNER_DB], [ACTOR_ROLE_LOCK_NAMESPACE, ACTOR_DB]]);
  const index = predicate => out.events.findIndex(predicate);
  const guildLock = index(e => /FROM guilds.*FOR UPDATE/.test(e.sql));
  const roleLock = index(e => /FROM guild_roles.*user_id = \$2.*FOR UPDATE/.test(e.sql));
  assert(index(e => e === userLocks[1]) < guildLock, 'account fences precede tenant locks');
  assert(roleLock > guildLock, 'revocable actor role locked after guild');
  assert(index(e => e.sql === 'DISCORD' && e.fetchCount === 2) > roleLock, 'Discord recheck follows role locks');
  assert(!out.events.some(e => /^(INSERT|UPDATE) (?!users\b)/.test(e.sql)), 'existing-account denial makes zero protected writes');
});

test('initial separate Administrator gets exact guild Admin with provenance and login guidance', async () => {
  const out = await runCommand();
  assert(out.replies.some(r => /registered successfully/.test(r.content)), JSON.stringify(out.replies));
  assert.deepEqual(out.state.roles, [
    { guild_id: GUILD_DB, user_id: OWNER_DB, role: 'owner' },
    { guild_id: GUILD_DB, user_id: ACTOR_DB, role: 'admin' },
  ]);
  assert.equal(out.state.guild.status, 'approved');
  assert.equal(out.state.token.token_hash, 'encrypted-fixture');
  const grantAudit = out.state.audits.find(a => a.sql.includes('guild_setup.admin_granted'));
  assert(grantAudit, 'new scoped grant has a dedicated audit');
  assert.deepEqual(grantAudit.params, [ACTOR_DB, GUILD_DB, String(ACTOR_DB), GUILD, ACTOR, OWNER]);
  assert.match(grantAudit.sql, /verified_register_token/);
  assert.match(grantAudit.sql, /discord_administrator/);
  assert.match(out.replies.at(-1).content, /Guild Admin/);
  assert.match(out.replies.at(-1).content, /same Discord account/i);
  assert.match(out.replies.at(-1).content, /Guild owner: use the server toggles/, 'Admin must not be directed to owner-only server activation');
  assert.match(out.replies.at(-1).content, /only this (Discord )?(guild|server)/i);
  const tokenWrite = out.events.findIndex(e => e.sql.startsWith('INSERT INTO guild_tokens'));
  const finalDiscord = out.events.findLastIndex(e => e.sql === 'DISCORD');
  const firstGrant = out.events.findIndex(e => e.sql.startsWith('INSERT INTO guild_roles'));
  assert(tokenWrite >= 0 && finalDiscord > tokenWrite && firstGrant > finalDiscord,
    'ownerless shell rechecks authority after token insertion and before Owner/Admin grants');
  assert.equal(out.fetchCount, 3);
});

test('approved guild with conflicting stored owner fails before token writes', async () => {
  const out = await runCommand({ established: true, conflictingOwner: true, status: 'approved' });
  denied(out);
  assert(!out.events.some(e => e.sql.startsWith('INSERT INTO guild_tokens')));
});

test('ownerless non-initial setup never reboots grants or replaces tokens', async () => {
  for (const options of [{ noSetup: true }, { existingToken: '900' }]) {
    const out = await runCommand(options);
    denied(out);
    assert(!out.events.some(e => e.sql.startsWith('INSERT INTO guild_tokens')), 'deny before token write');
    assert(!out.events.some(e => e.sql.startsWith('INSERT INTO guild_roles')), 'no resurrected role');
  }
});

test('zero-row mandatory writes roll back token owner admin approval and audit atomically', async () => {
  for (const zeroSql of [
    /INSERT INTO security_audit_events.*guild_setup.register_token/,
    /INSERT INTO security_audit_events.*guild_setup.approved/,
    /INSERT INTO security_audit_events.*guild_setup.admin_granted/,
    /INSERT INTO guild_setup_state.*nitrado_connected/,
    /INSERT INTO guild_roles.*'admin'/,
    /INSERT INTO guild_roles.*'owner'/,
    /INSERT INTO guild_tokens/,
    /UPDATE guilds/,
    /INSERT INTO guilds/,
  ]) {
    const out = await runCommand({ zeroSql });
    denied(out);
    assert(out.events.some(e => e.sql === 'ROLLBACK'), String(zeroSql));
  }
});

test('rollback failure discards connection and never reports success', async () => {
  const out = await runCommand({ failSql: /guild_setup.approved/, rollbackFails: true });
  denied(out);
  assert(out.releaseError instanceof Error, 'poisoned transaction connection must be discarded');
  assert.match(out.releaseError.message, /rollback failure/);
});

test('fresh member evidence from another guild is rejected', async () => {
  const out = await runCommand({ memberGuildMismatch: true });
  denied(out);
  assert(!out.events.some(e => e.sql.startsWith('INSERT INTO guild_tokens')));
});

// Characterization coverage for policy which must remain unchanged.
test('initial authoritative owner remains sole Owner without an Admin downgrade', async () => {
  const out = await runCommand({ ownerActor: true, member: true });
  assert(out.replies.some(r => /registered successfully/.test(r.content)), JSON.stringify(out.replies));
  assert.deepEqual(out.state.roles, [{ guild_id: GUILD_DB, user_id: OWNER_DB, role: 'owner' }]);
  assert.match(out.replies.at(-1).content, /Guild Owner/);
  assert(!out.state.audits.some(a => a.sql.includes('admin_granted')));
  assert.deepEqual(out.events.filter(e => e.sql === 'SELECT pg_advisory_xact_lock($1, $2)').map(e => e.params),
    [[ACTOR_ROLE_LOCK_NAMESPACE, OWNER_DB]], 'deduplicate owner/actor account fence');
});

test('authorized established Owner and Admin retry without changing roles', async () => {
  for (const actor of [{ ownerActor: true }, { role: 'admin' }]) {
    const out = await runCommand({ established: true, status: 'approved', ...actor });
    assert(out.replies.some(r => /registered successfully/.test(r.content)), JSON.stringify(out.replies));
    assert.deepEqual(out.state.roles, out.initial.roles);
    assert(!out.events.some(e => e.sql.startsWith('INSERT INTO guild_roles')));
    assert(!out.state.audits.some(a => a.sql.includes('admin_granted')));
  }
});

test('native Administrator alone cannot replace established tokens or resurrect a revoked grant', async () => {
  for (const actor of [{}, { role: 'moderator' }, { role: 'admin', storedRevoked: true }]) {
    const out = await runCommand({ established: true, status: 'approved', ...actor });
    denied(out);
    assert(!out.events.some(e => /^(INSERT|UPDATE) (?!users\b)/.test(e.sql)), 'no registration writes for unrelated/revoked actor');
  }
});

test('ordinary member cannot register even with a stored application Admin role', async () => {
  const out = await runCommand({ member: true, established: true, role: 'admin' });
  denied(out);
  assert(!out.events.some(e => e.sql === 'BEGIN'));
});

test('disabled guild is denied under its row lock before all registration writes', async () => {
  const out = await runCommand({ status: 'disabled' });
  denied(out);
  assert(out.events.some(e => /FROM guilds.*FOR UPDATE/.test(e.sql)));
  assert(!out.events.some(e => /^(INSERT|UPDATE) (?!users\b)/.test(e.sql)));
});

test('fresh Discord unavailable guild mismatch and actor mismatch all deny', async () => {
  for (const options of [{ unavailable: true }, { guildMismatch: true }, { actorMismatch: true }]) {
    const out = await runCommand(options);
    denied(out);
    assert(!out.events.some(e => /^(INSERT|UPDATE) (?!users\b)/.test(e.sql)));
  }
});

test('provider account conflicts deny without token or scoped role changes', async () => {
  for (const options of [{ providerConflict: true }, { existingToken: '999', established: true, role: 'admin' }]) {
    const out = await runCommand(options);
    denied(out);
    assert(!out.events.some(e => e.sql.startsWith('INSERT INTO guild_tokens')));
    assert(!out.events.some(e => e.sql.startsWith('INSERT INTO guild_roles')));
  }
});

for (const [lockName, lockSql] of [
  ['guild upsert', /^INSERT INTO guilds /],
  ['setup-state lock', /SELECT guild_id FROM guild_setup_state.*FOR UPDATE/],
]) {
  for (const change of ['revoked', 'ownerChanged']) {
    test(`new guild ${change} during ${lockName} denies after late locks`, async () => {
      let changed = false;
      const options = {
        newGuild: true,
        queryHook: async q => {
          if (!lockSql.test(q)) return;
          // Simulate Discord changing while the late unique/row lock waits.
          await new Promise(resolve => setImmediate(resolve));
          options[change] = true;
          changed = true;
        },
      };
      const out = await runCommand(options);
      assert(changed, 'fixture must reach the late lock before changing Discord');
      denied(out);
      assert(out.events.some(e => e.sql === 'ROLLBACK'), 'whole transaction must roll back');
      assert(!out.events.some(e => e.sql === 'COMMIT'), 'stale authority must never commit');
      const guildUpsert = out.events.findIndex(e => /^INSERT INTO guilds /.test(e.sql));
      const setupLock = out.events.findIndex(e => /SELECT guild_id FROM guild_setup_state.*FOR UPDATE/.test(e.sql));
      const finalDiscord = out.events.findLastIndex(e => e.sql === 'DISCORD');
      assert(guildUpsert >= 0 && setupLock > guildUpsert, 'both late locks must be reached');
      assert(finalDiscord > setupLock, 'final Discord fetch follows both late locks');
      assert.equal(out.fetchCount, 3, 'retain early checks and add a new-guild post-lock check');
      assert(!out.events.some(e => /^(?:INSERT INTO (?:guild_tokens|guild_roles|security_audit_events)|UPDATE guilds)\b/.test(e.sql)),
        'no token, owner/Admin, approval or audit writes before post-lock denial');
    });
  }
}

for (const newGuild of [true, false]) {
  for (const change of ['revoked', 'ownerChanged', 'guildMismatch', 'actorMismatch', 'memberGuildMismatch', 'unavailable']) {
    test(`${newGuild ? 'new guild' : 'ownerless shell'} ${change} during token insert denies before initial grants`, async () => {
      let changed = false;
      let tokenPersisted = false;
      const options = {
        newGuild,
        queryHook: async (q, params, working) => {
          if (q === 'ROLLBACK') tokenPersisted = working?.token?.token_hash === 'encrypted-fixture';
          if (!q.startsWith('INSERT INTO guild_tokens')) return;
          // The initial INSERT can wait on a unique lock even with no token row.
          await new Promise(resolve => setImmediate(resolve));
          options[change] = true;
          changed = true;
        },
      };
      const out = await runCommand(options);
      assert(changed, 'fixture must reach token insertion before changing Discord');
      denied(out);
      assert(tokenPersisted, 'denial must roll back the token already written in this transaction');
      assert(out.events.some(e => e.sql === 'ROLLBACK'));
      assert(!out.events.some(e => e.sql === 'COMMIT'));
      const tokenWrite = out.events.findIndex(e => e.sql.startsWith('INSERT INTO guild_tokens'));
      const finalDiscord = out.events.findLastIndex(e => e.sql === 'DISCORD');
      assert(finalDiscord > tokenWrite, 'fresh authority check must follow the token unique-lock wait');
      assert.equal(out.fetchCount, newGuild ? 4 : 3, 'retain early and new-guild post-scope checks');
      assert(!out.events.some(e => /^(?:INSERT INTO (?:guild_roles|security_audit_events)|UPDATE guilds)\b/.test(e.sql)),
        'no owner/Admin grants, approval or audits on post-token denial');
      assert(!out.events.some(e => /^INSERT INTO guild_setup_state.*nitrado_connected/.test(e.sql)),
        'denial must not advance setup');
    });
  }
}

test('new guild and missing accounts bootstrap without late user writes', async () => {
  const out = await runCommand({ newGuild: true, missingUsers: true });
  assert(out.replies.some(r => /registered successfully/.test(r.content)), JSON.stringify(out.replies));
  assert.deepEqual(out.state.roles.map(r => r.role).sort(), ['admin', 'owner']);
  assert.equal(out.state.guild.status, 'approved');
  assert.equal(out.state.token.token_hash, 'encrypted-fixture');
  assert(out.state.audits.some(a => a.sql.includes('guild_setup.admin_granted')));
  const guildUpsert = out.events.findIndex(e => /^INSERT INTO guilds /.test(e.sql));
  const setupLock = out.events.findIndex(e => /SELECT guild_id FROM guild_setup_state.*FOR UPDATE/.test(e.sql));
  const finalDiscord = out.events.findLastIndex(e => e.sql === 'DISCORD');
  const tokenWrite = out.events.findIndex(e => e.sql.startsWith('INSERT INTO guild_tokens'));
  const postScopeDiscord = out.events.findIndex(e => e.sql === 'DISCORD' && e.fetchCount === 3);
  const firstGrant = out.events.findIndex(e => e.sql.startsWith('INSERT INTO guild_roles'));
  assert(guildUpsert >= 0 && setupLock > guildUpsert && postScopeDiscord > setupLock && tokenWrite > postScopeDiscord,
    'successful new guild retains the post-scope check before writing its token');
  assert(finalDiscord > tokenWrite && firstGrant > finalDiscord,
    'successful new guild rechecks authority after the token write and before initial grants');
  assert.equal(out.fetchCount, 4);
  const fences = out.events.filter(e => e.sql.includes('pg_try_advisory_xact_lock'));
  assert.deepEqual(fences.map(e => e.params), [[ACTOR_ROLE_LOCK_NAMESPACE, OWNER_DB], [ACTOR_ROLE_LOCK_NAMESPACE, ACTOR_DB]], 'all-new IDs are sorted even when insertion returns20 then10');
  assert(out.events.filter(e => e.sql.startsWith('INSERT INTO users')).every(e => out.events.indexOf(e) < out.events.indexOf(fences[0])));
  const firstTenantLock = out.events.findIndex(e => /hashtext/.test(e.sql));
  assert(out.events.filter(e => e.sql.startsWith('INSERT INTO users')).every(e => out.events.indexOf(e) < firstTenantLock));
  assert(out.events.filter(e => e.sql.startsWith('UPDATE users')).every(e => out.events.indexOf(e) < firstTenantLock));
});

test('provider with no DayZ services creates no registrations or users', async () => {
  const out = await runCommand({ noServers: true });
  denied(out);
  assert(!out.events.some(e => e.sql === 'BEGIN'));
});

test('late write errors roll back all token ownership role approval and audit changes', async () => {
  for (const failSql of [/guild_setup.admin_granted/, /guild_setup.register_token/, /guild_setup.approved/]) {
    const out = await runCommand({ failSql });
    denied(out);
    assert(out.events.some(e => e.sql === 'ROLLBACK'));
  }
});

test('concurrently inserted disabled guild cannot be activated by initial registration', async () => {
  const out = await runCommand({ newGuild: true, concurrentGuildStatus: 'disabled' });
  denied(out);
  assert(!out.events.some(e => e.sql.startsWith('INSERT INTO guild_tokens')));
});

test('native authority revoked while waiting for credential locks denies at operation time', async () => {
  const out = await runCommand({ established: true, role: 'admin', status: 'approved', revokedAtTokenLock: true });
  denied(out);
  assert(!out.events.some(e => /^(INSERT|UPDATE) (?!users\b)/.test(e.sql)));
});

test('registration refreshes existing Discord profiles before tenant locks', async () => {
  const out = await runCommand();
  assert(out.replies.some(r => /registered successfully/.test(r.content)));
  assert.equal(out.state.users.find(u => u.id === ACTOR_DB).username, 'Fixture actor');
  assert.equal(out.state.users.find(u => u.id === OWNER_DB).username, 'Fixture user');
  const tenantLock = out.events.findIndex(e => /hashtext/.test(e.sql));
  const refreshes = out.events.filter(e => e.sql.startsWith('UPDATE users'));
  assert.equal(refreshes.length, 2);
  assert(refreshes.every(e => out.events.indexOf(e) < tenantLock));
});

(async () => {
  const filter = process.argv[2];
  let count = 0;
  for (const entry of tests.filter(t => !filter || t.name.includes(filter))) {
    let timeout;
    try {
      await Promise.race([
        entry.run(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Test timed out: ${entry.name}`)), 5000); }),
      ]);
    } finally { clearTimeout(timeout); }
    count++; console.log(`PASS ${entry.name}`);
  }
  assert(count > 0, 'test filter matched no tests');
  console.log(`PASS ${count} register-token onboarding tests`);
})().catch(error => { console.error(error); process.exitCode = 1; });
