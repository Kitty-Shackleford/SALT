'use strict';

const assert = require('assert');
const casino = require('../routes/casino')._test;
const { processExpiredCasinoSessions, startCasinoExpiryWorker } =
  require('../workers/casinoExpiryProcessor');

async function main() {
  assert.ok(casino.createCasinoSession, 'casino session creation seam must exist');
  assert.ok(casino.reserveAndAdvanceCasinoSession,
    'additional stake reservation seam must exist');
  assert.ok(casino.expireCasinoSession, 'expired escrow forfeiture seam must exist');
  assert.ok(casino.totalBlackjackWager, 'blackjack side-bet accounting seam must exist');
  assert.strictEqual(casino.totalBlackjackWager({ insuranceBet: 5 }, 20), 25);

  const calls = [];
  let balance = 100;
  const db = {
    async transaction(callback) {
      calls.push('BEGIN');
      const result = await callback(this);
      calls.push('COMMIT');
      return result;
    },
    async get(sql) {
      calls.push(sql);
      if (/SELECT guild_id FROM servers/.test(sql)) return { guild_id: 17 };
      if (/FROM guilds/.test(sql)) return { id: 17 };
      if (/FROM servers/.test(sql)) return { id: 13, guild_id: 17 };
      if (/SELECT guild_id FROM servers/.test(sql)) return { guild_id: 17 };
      if (/FROM guilds/.test(sql)) return { id: 17 };
      if (/FROM servers/.test(sql)) return { id: 13, guild_id: 17 };
      if (/server_player_memberships/.test(sql)) return { id: 99, source_link_id: 88 };
      if (/linked_accounts/.test(sql)) return { id: 88 };
      if (/guild_economy_config/.test(sql)) return { server_id: 13 };
      if (/player_wallets/.test(sql)) return { cash_on_hand: balance };
      return null;
    },
    async run(sql, params) {
      calls.push(sql);
      if (/UPDATE player_wallets/.test(sql)) balance = Number(params[0]);
      return { changes: 1, lastID: 1 };
    }
  };
  const req = { user: { id: 7 } };
  const server = { id: 13, guild_id: 17 };
  const sessionId = await casino.createCasinoSession(
    db, req, 'holdem', 11, server, { ante: 40 }, 5, 40
  );

  assert.match(sessionId, /^[a-f0-9]{64}$/);
  assert.strictEqual(balance, 60, 'initial stake must be debited before session creation commits');
  assert.strictEqual(calls[0], 'BEGIN');
  assert.strictEqual(calls.at(-1), 'COMMIT');
  assert.ok(calls.some(sql => /player_wallets[\s\S]*FOR UPDATE/.test(sql)), 'wallet must be locked');
  assert.ok(calls.some(sql => /reserved_wager/.test(sql)), 'escrow must be persisted server-side');

  let reserveBalance = 60;
  let reserveAmount = 40;
  let reserveVersion = 0;
  const reserveCalls = [];
  const reserveSession = {
    session_id: sessionId, user_id: 7, identity_id: 11, server_id: 13, guild_id: 17,
    game_type: 'holdem', state: { ante: 40 }, status: 'active',
    get version() { return reserveVersion; },
    get reserved_wager() { return reserveAmount; },
    expires_at: new Date(Date.now() + 60000).toISOString()
  };
  const reserveDb = {
    async transaction(callback) { return callback(this); },
    async get(sql) {
      reserveCalls.push(sql);
      if (/SELECT guild_id FROM servers/.test(sql)) return { guild_id: 17 };
      if (/FROM guilds/.test(sql)) return { id: 17 };
      if (/FROM servers/.test(sql)) return { id: 13, guild_id: 17 };
      if (/SELECT guild_id FROM servers/.test(sql)) return { guild_id: 17 };
      if (/FROM guilds/.test(sql)) return { id: 17 };
      if (/FROM servers/.test(sql)) return { id: 13, guild_id: 17 };
      if (/server_player_memberships/.test(sql)) return { id: 99, source_link_id: 88 };
      if (/linked_accounts/.test(sql)) return { id: 88 };
      if (/guild_economy_config/.test(sql)) return { server_id: 13 };
      if (/casino_sessions/.test(sql)) return reserveSession;
      if (/player_wallets/.test(sql)) return { cash_on_hand: reserveBalance };
      return null;
    },
    async run(sql, params) {
      reserveCalls.push(sql);
      if (/UPDATE player_wallets/.test(sql)) reserveBalance = Number(params[0]);
      if (/UPDATE casino_sessions/.test(sql)) {
        reserveAmount += Number(params[1]);
        reserveVersion++;
      }
      return { changes: 1 };
    }
  };
  const binding = { sessionId, userId: 7, identityId: 11, serverId: 13, guildId: 17,
    gameType: 'holdem' };
  const nextVersion = await casino.reserveAndAdvanceCasinoSession(
    reserveDb, binding, 0, 40, { ...reserveSession.state, called: true }
  );
  assert.strictEqual(nextVersion, 1);
  assert.strictEqual(reserveBalance, 20, 'additional wager must be atomically debited');
  assert.strictEqual(reserveAmount, 80, 'additional wager must be added to escrow');
  assert.ok(reserveCalls.some(sql => /reserved_wager = reserved_wager \+/.test(sql)));
  const reserveConfigLock = reserveCalls.findIndex(sql =>
    /guild_economy_config[\s\S]*FOR UPDATE/.test(sql));
  const reserveSessionLock = reserveCalls.findIndex(sql => /SELECT \* FROM casino_sessions/.test(sql));
  assert.ok(reserveConfigLock >= 0 && reserveConfigLock < reserveSessionLock,
    'stake reservation must take the supply recalculation lock before the session lock');

  const expiryCalls = [];
  const expiredSession = {
    ...reserveSession, status: 'active', reserved_wager: 40,
    expires_at: new Date(Date.now() - 60000).toISOString()
  };
  const expiryDb = {
    async transaction(callback) { return callback(this); },
    async get(sql) {
      expiryCalls.push(sql);
      if (/expires_at <= clock_timestamp\(\)/i.test(sql)) return { is_expired: true };
      if (/FROM servers/.test(sql)) return { id: 13, guild_id: 17 };
      if (/casino_sessions/.test(sql)) return expiredSession;
      if (/guild_economy_config/.test(sql)) {
        return { guild_id: 17, fixed_supply_enabled: true, max_money_supply: 200,
          current_money_supply: 100 };
      }
      return null;
    },
    async run(sql) { expiryCalls.push(sql); return { changes: 1, lastID: 1 }; }
  };
  assert.strictEqual(await casino.expireCasinoSession(expiryDb, binding), true);
  assert.ok(expiryCalls.some(sql => /status = 'expired'/.test(sql)),
    'expired escrow must become terminal');
  assert.ok(expiryCalls.some(sql => /UPDATE guild_economy_config SET current_money_supply/.test(sql)),
    'expired escrow forfeiture must sink reserved stake');
  const expiryConfigLock = expiryCalls.findIndex(sql =>
    /guild_economy_config[\s\S]*FOR UPDATE/.test(sql));
  const expirySessionLock = expiryCalls.findIndex(sql => /SELECT \* FROM casino_sessions/.test(sql));
  assert.ok(expiryConfigLock >= 0 && expiryConfigLock < expirySessionLock,
    'expiry must take the supply recalculation lock before the session lock');

  calls.length = 0;
  const session = {
    session_id: sessionId, user_id: 7, identity_id: 11, server_id: 13, guild_id: 17,
    game_type: 'holdem', state: { ante: 40 }, version: 0, status: 'active',
    reserved_wager: 40, expires_at: new Date(Date.now() + 60000).toISOString()
  };
  db.get = async sql => {
    calls.push(sql);
    if (/SELECT guild_id FROM servers/.test(sql)) return { guild_id: 17 };
      if (/FROM guilds/.test(sql)) return { id: 17 };
      if (/FROM servers/.test(sql)) return { id: 13, guild_id: 17 };
      if (/server_player_memberships/.test(sql)) return { id: 99, source_link_id: 88 };
    if (/linked_accounts/.test(sql)) return { id: 88 };
    if (/casino_sessions/.test(sql)) return session;
    if (/player_wallets/.test(sql)) return { cash_on_hand: balance };
    if (/guild_economy_config/.test(sql)) {
      return { guild_id: 17, fixed_supply_enabled: true, max_money_supply: 200,
        current_money_supply: 100 };
    }
    return null;
  };
  const settledBalance = await casino.settleCasinoBet(db, {
    identityId: 11, serverId: 13, guildId: 17, gameType: 'holdem',
    wager: 40, payout: 80, result: 'win', resultData: {},
    casinoSession: {
      binding: { sessionId, userId: 7, identityId: 11, serverId: 13, guildId: 17,
        gameType: 'holdem' },
      version: 0
    }
  });
  assert.strictEqual(settledBalance, 140, 'settlement credits payout without debiting escrow twice');
  assert.ok(calls.some(sql => /UPDATE guild_economy_config SET current_money_supply/.test(sql)),
    'net casino win must update supply in the settlement transaction');
  assert.ok(calls.some(sql => /INSERT INTO economy_supply_log/.test(sql)),
    'net casino win must be supply-audited');
  const settlementConfigLock = calls.findIndex(sql =>
    /guild_economy_config[\s\S]*FOR UPDATE/.test(sql));
  const settlementSessionLock = calls.findIndex(sql => /SELECT \* FROM casino_sessions/.test(sql));
  assert.ok(settlementConfigLock >= 0 && settlementConfigLock < settlementSessionLock,
    'settlement must take the supply recalculation lock before the session lock');

  let rollbackBalance = 100;
  let rollbackHistory = 0;
  const capDb = {
    transactionStorage: { getStore: () => ({ client: {} }) },
    async transaction(callback) {
      const snapshot = { balance: rollbackBalance, history: rollbackHistory };
      try { return await callback(this); }
      catch (error) {
        rollbackBalance = snapshot.balance;
        rollbackHistory = snapshot.history;
        throw error;
      }
    },
    async get(sql) {
      if (/SELECT guild_id FROM servers/.test(sql)) return { guild_id: 17 };
      if (/FROM guilds/.test(sql)) return { id: 17 };
      if (/FROM servers/.test(sql)) return { id: 13, guild_id: 17 };
      if (/server_player_memberships/.test(sql)) return { id: 99, source_link_id: 88 };
      if (/linked_accounts/.test(sql)) return { id: 88 };
      if (/player_wallets/.test(sql)) return { cash_on_hand: rollbackBalance };
      if (/guild_economy_config/.test(sql)) {
        return { guild_id: 17, starting_cash: 0, fixed_supply_enabled: true,
          max_money_supply: 105, current_money_supply: 100 };
      }
      return null;
    },
    async run(sql, params) {
      if (/UPDATE player_wallets/.test(sql)) rollbackBalance = Number(params[0]);
      if (/INSERT INTO casino_game_history/.test(sql)) rollbackHistory++;
      return { changes: 1, lastID: 1 };
    }
  };
  await assert.rejects(() => casino.settleCasinoBet(capDb, {
    identityId: 11, serverId: 13, guildId: 17, gameType: 'slots', actorUserId: 5,
    wager: 10, payout: 30, result: 'win', resultData: {}
  }), /supply cap exceeded/i);
  assert.strictEqual(rollbackBalance, 100, 'cap rejection must roll back wallet settlement');
  assert.strictEqual(rollbackHistory, 0, 'cap rejection must roll back game history');

  let concurrentBalance = 60;
  let sessionCount = 0;
  let tail = Promise.resolve();
  const concurrencyDb = {
    transactionStorage: { getStore: () => ({ client: {} }) },
    transaction(callback) {
      const run = tail.then(() => callback(this));
      tail = run.catch(() => {});
      return run;
    },
    async get(sql) {
      if (/SELECT guild_id FROM servers/.test(sql)) return { guild_id: 17 };
      if (/FROM guilds/.test(sql)) return { id: 17 };
      if (/FROM servers/.test(sql)) return { id: 13, guild_id: 17 };
      if (/server_player_memberships/.test(sql)) return { id: 99, source_link_id: 88 };
      if (/linked_accounts/.test(sql)) return { id: 88 };
      if (/guild_economy_config/.test(sql)) return { server_id: 13, starting_cash: 0 };
      if (/player_wallets/.test(sql)) return { cash_on_hand: concurrentBalance };
      return null;
    },
    async run(sql, params) {
      if (/UPDATE player_wallets/.test(sql)) concurrentBalance = Number(params[0]);
      if (/INSERT INTO casino_sessions/.test(sql)) sessionCount++;
      return { changes: 1, lastID: 1 };
    }
  };
  const attempts = await Promise.allSettled([
    casino.createCasinoSession(concurrencyDb, req, 'craps', 11, server, { wager: 40 }, 5, 40),
    casino.createCasinoSession(concurrencyDb, req, 'holdem', 11, server, { ante: 40 }, 5, 40)
  ]);
  assert.deepStrictEqual(attempts.map(item => item.status).sort(), ['fulfilled', 'rejected'],
    'concurrent sessions cannot reserve more than the wallet balance');
  assert.strictEqual(concurrentBalance, 20);
  assert.strictEqual(sessionCount, 1);

  const expiredRows = [
    { session_id: 'a'.repeat(64), server_id: 13, guild_id: 17, identity_id: 11,
      game_type: 'craps', reserved_wager: 30, status: 'active' },
    { session_id: 'b'.repeat(64), server_id: 19, guild_id: 23, identity_id: 29,
      game_type: 'holdem', reserved_wager: 45, status: 'active' }
  ];
  const processed = new Set();
  const workerCalls = [];
  let workerTail = Promise.resolve();
  const workerDb = {
    transaction(callback) {
      const run = workerTail.then(() => callback(this));
      workerTail = run.catch(() => {});
      return run;
    },
    async query(sql, params) {
      workerCalls.push(sql);
      if (/SELECT DISTINCT server_id/.test(sql)) {
        const next = expiredRows.find(row => !processed.has(row.session_id));
        return next ? [{ server_id: next.server_id }] : [];
      }
      if (/FROM casino_sessions/.test(sql) && /SKIP LOCKED/.test(sql)) {
        return expiredRows.filter(row => row.server_id === params[0] && !processed.has(row.session_id));
      }
      return [];
    },
    async get(sql, params) {
      workerCalls.push(sql);
      if (/FROM servers/.test(sql)) {
        const row = expiredRows.find(item => item.server_id === params[0]);
        return row ? { id: row.server_id, guild_id: row.guild_id } : null;
      }
      if (/guild_economy_config/.test(sql)) {
        const row = expiredRows.find(item => item.server_id === params[0]);
        return row ? { guild_id: row.guild_id, current_money_supply: 200,
          fixed_supply_enabled: true, max_money_supply: 500 } : null;
      }
      return null;
    },
    async run(sql, params) {
      workerCalls.push(sql);
      if (/UPDATE casino_sessions/.test(sql)) processed.add(params[0]);
      return { changes: 1, lastID: 1 };
    }
  };
  const workerResults = await Promise.all([
    processExpiredCasinoSessions(workerDb, { batchSize: 10 }),
    processExpiredCasinoSessions(workerDb, { batchSize: 10 })
  ]);
  assert.strictEqual(workerResults.reduce((sum, result) => sum + result.processed, 0), 2,
    'multiple workers must forfeit each expired escrow exactly once');
  assert.strictEqual(processed.size, 2);
  assert.ok(workerCalls.some(sql => /FOR UPDATE SKIP LOCKED/.test(sql)),
    'autonomous expiry must use non-blocking row claims');
  assert.ok(workerCalls.some(sql => /status = 'expired'/.test(sql)),
    'autonomous expiry must make sessions terminal in the sink transaction');
  assert.strictEqual(workerCalls.filter(sql => /INSERT INTO economy_supply_log/.test(sql)).length, 2,
    'each forfeited escrow must have exactly one supply sink audit row');

  let exactSupplyAfter = null;
  let exactExpired = false;
  const exactWorkerDb = {
    async transaction(callback) { return callback(this); },
    async query(sql) {
      if (/SELECT DISTINCT server_id/.test(sql)) return exactExpired ? [] : [{ server_id: 31 }];
      if (/FROM casino_sessions/.test(sql) && /SKIP LOCKED/.test(sql)) return [{
        session_id: 'c'.repeat(64), server_id: 31, guild_id: 41, identity_id: 51,
        game_type: 'holdem', reserved_wager: '90071992547409.91',
      }];
      return [];
    },
    async get(sql) {
      if (/FROM servers/.test(sql)) return { id: 31, guild_id: 41 };
      if (/guild_economy_config/.test(sql)) return {
        guild_id: 41, current_money_supply: '90071992547420.00',
        fixed_supply_enabled: true, max_money_supply: '99999999999999.99',
      };
      return null;
    },
    async run(sql, params) {
      if (/UPDATE guild_economy_config SET current_money_supply/.test(sql)) exactSupplyAfter = params[0];
      if (/UPDATE casino_sessions/.test(sql)) exactExpired = true;
      return { changes: 1, lastID: 1 };
    },
  };
  assert.deepStrictEqual(await processExpiredCasinoSessions(exactWorkerDb, { batchSize: 1 }),
    { processed: 1 });
  assert.strictEqual(exactSupplyAfter, '10.09',
    'worker expiry must preserve exact cents without coercing reserved_wager through Number');

  let startupTask;
  let intervalTask;
  const expiryErrors = [];
  const scheduledDb = {
    async query() { throw new Error('scheduled expiry failure'); }
  };
  const worker = startCasinoExpiryWorker(scheduledDb, {
    startupDelayMs: 0,
    intervalMs: 60000,
    setTimeoutFn(callback) { startupTask = callback; return { unref() {} }; },
    setIntervalFn(callback) { intervalTask = callback; return { unref() {} }; },
    logger: { info() {}, error(...args) { expiryErrors.push(args); } }
  });
  assert.strictEqual(typeof startupTask, 'function', 'expiry processing must run on startup');
  assert.strictEqual(typeof intervalTask, 'function', 'expiry processing must run on a schedule');
  await startupTask();
  assert.strictEqual(expiryErrors.length, 1, 'scheduled expiry failures must be contained and logged');
  worker.stop();
  assert.match(require('fs').readFileSync(require.resolve('../utils/economyScheduler'), 'utf8'),
    /startCasinoExpiryWorker\(db\)/,
    'the actual backend economy scheduler must start casino expiry processing');
  console.log('casino escrow accounting tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
