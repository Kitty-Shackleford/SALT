'use strict';

const assert = require('assert');
const casinoRouter = require('../routes/casino');

async function testOverflowingStatefulWinCancelsAfterCommit() {
  const calls = [];
  const session = {
    session_id: 'b'.repeat(64), user_id: 7, identity_id: 11, server_id: 13,
    guild_id: 17, game_type: 'holdem', state: {}, version: 2,
    reserved_wager: '10.00', status: 'active',
    expires_at: new Date(Date.now() + 60000).toISOString()
  };
  const db = {
    async transaction(callback) {
      const pending = [];
      const transaction = Object.create(this);
      transaction.run = async (sql, params) => {
        pending.push({ sql, params });
        return { changes: 1 };
      };
      const result = await callback(transaction);
      calls.push(...pending);
      return result;
    },
    async get(sql) {
      if (/SELECT guild_id FROM servers/.test(sql)) return { guild_id: 17 };
      if (/FROM guilds/.test(sql)) return { id: 17 };
      if (/FROM servers/.test(sql)) return { id: 13 };
      if (/server_player_memberships/.test(sql)) return { id: 99, source_link_id: 88 };
      if (/linked_accounts/.test(sql)) return { id: 88 };
      if (/casino_sessions/.test(sql)) return session;
      if (/player_wallets/.test(sql)) return { cash_on_hand: '90071992547394.91' };
      if (/guild_economy_config/.test(sql)) return {
        guild_id: 17, fixed_supply_enabled: false, max_money_supply: null,
        current_money_supply: '90071992547404.91'
      };
      return null;
    },
    async run(sql, params) { calls.push({ sql, params }); return { changes: 1 }; }
  };
  await assert.rejects(() => casinoRouter._test.settleCasinoBet(db, {
    identityId: 11, serverId: 13, guildId: 17, gameType: 'holdem',
    wager: 10, payout: 20, result: 'win', resultData: {},
    casinoSession: {
      binding: { sessionId: session.session_id, userId: 7, identityId: 11,
        serverId: 13, guildId: 17, gameType: 'holdem' }, version: 2
    }
  }), error => error.status === 409 && /cancelled.*capacity/i.test(error.message));
  const wallet = calls.find(call => /UPDATE player_wallets/.test(call.sql));
  assert.strictEqual(wallet.params[0], '90071992547404.91', 'only reserved escrow is refunded');
  assert(calls.some(call => /casino_game_history/.test(call.sql)
    && call.params.includes('push')), 'capacity cancellation must use the persisted result enum');
  assert(calls.some(call => /casino_sessions SET status = 'settled'/.test(call.sql)
    && /state = /.test(call.sql)), 'session must be consumed exactly once with cancellation state');
}

async function testOverflowingRefundBecomesDurableClaimAndConsumesSession() {
  const calls = [];
  const session = {
    session_id: 'c'.repeat(64), user_id: 7, identity_id: 11, server_id: 13,
    guild_id: 17, game_type: 'holdem', state: {}, version: 2,
    reserved_wager: '10.00', status: 'active',
    expires_at: new Date(Date.now() + 60000).toISOString()
  };
  const db = {
    async transaction(callback) {
      const pending = [];
      const transaction = Object.create(this);
      transaction.run = async (sql, params) => {
        pending.push({ sql, params });
        return { changes: 1 };
      };
      const result = await callback(transaction);
      calls.push(...pending);
      return result;
    },
    async get(sql) {
      if (/FROM guilds/.test(sql)) return { id: 17 };
      if (/FROM servers/.test(sql)) return { id: 13 };
      if (/server_player_memberships/.test(sql)) return { id: 99, source_link_id: 88 };
      if (/linked_accounts/.test(sql)) return { id: 88 };
      if (/casino_sessions/.test(sql)) return session;
      if (/player_wallets/.test(sql)) return { cash_on_hand: '90071992547409.91' };
      if (/guild_economy_config/.test(sql)) return {
        guild_id: 17, fixed_supply_enabled: false, max_money_supply: null,
        current_money_supply: '90071992547409.91'
      };
      if (/INSERT INTO financial_refund_claims/.test(sql)) {
        calls.push({ sql, params: [13, 11, '10.00', 'casino_session',
          session.session_id, 'destination_wallet_capacity_exceeded'] });
        return {
          id: 43, server_id: 13, identity_id: 11, amount: '10.00',
          source_type: 'casino_session', source_key: session.session_id,
          reason: 'destination_wallet_capacity_exceeded', status: 'pending',
        };
      }
      return null;
    },
    async run(sql, params) { calls.push({ sql, params }); return { changes: 1 }; }
  };
  await assert.rejects(() => casinoRouter._test.settleCasinoBet(db, {
    identityId: 11, serverId: 13, guildId: 17, gameType: 'holdem',
    wager: 10, payout: 20, result: 'win', resultData: {},
    casinoSession: { binding: { sessionId: session.session_id, userId: 7,
      identityId: 11, serverId: 13, guildId: 17, gameType: 'holdem' }, version: 2 }
  }), error => error.status === 409 && /claimable refund/i.test(error.message));
  assert(!calls.some(call => /UPDATE player_wallets/.test(call.sql)),
    'a full destination must not attempt an impossible wallet refund');
  assert(calls.some(call => /INSERT INTO financial_refund_claims/.test(call.sql)
    && call.params.includes('10.00') && call.params.includes(session.session_id)),
  'reserved wager must move to a durable exact-cent claim');
  assert(calls.some(call => /casino_sessions SET status = 'settled'/.test(call.sql)),
    'overflow recovery must consume the active session');
}

async function testMismatchedClaimConflictRollsBackCasinoSettlement() {
  const session = {
    session_id: 'd'.repeat(64), user_id: 7, identity_id: 11, server_id: 13,
    guild_id: 17, game_type: 'holdem', state: {}, version: 2,
    reserved_wager: '10.00', status: 'active',
    expires_at: new Date(Date.now() + 60000).toISOString()
  };
  let terminal = false;
  const db = {
    async transaction(callback) {
      const before = terminal;
      try { return await callback(this); }
      catch (error) { terminal = before; throw error; }
    },
    async get(sql) {
      if (/FROM guilds/.test(sql)) return { id: 17 };
      if (/FROM servers/.test(sql)) return { id: 13 };
      if (/server_player_memberships/.test(sql)) return { id: 99, source_link_id: 88 };
      if (/linked_accounts/.test(sql)) return { id: 88 };
      if (/casino_sessions/.test(sql)) return session;
      if (/player_wallets/.test(sql)) return { cash_on_hand: '90071992547409.91' };
      if (/guild_economy_config/.test(sql)) return {
        guild_id: 17, fixed_supply_enabled: false, max_money_supply: null,
        current_money_supply: '90071992547409.91'
      };
      if (/INSERT INTO financial_refund_claims/.test(sql)) return null;
      if (/FROM financial_refund_claims/.test(sql)) return {
        id: 44, server_id: 99, identity_id: 11, amount: '10.00',
        source_type: 'casino_session', source_key: session.session_id,
        reason: 'destination_wallet_capacity_exceeded', status: 'pending',
      };
      return null;
    },
    async run(sql) {
      if (/UPDATE casino_sessions/.test(sql)) terminal = true;
      return { changes: 1 };
    }
  };
  await assert.rejects(() => casinoRouter._test.settleCasinoBet(db, {
    identityId: 11, serverId: 13, guildId: 17, gameType: 'holdem',
    wager: 10, payout: 20, result: 'win', resultData: {},
    casinoSession: { binding: { sessionId: session.session_id, userId: 7,
      identityId: 11, serverId: 13, guildId: 17, gameType: 'holdem' }, version: 2 }
  }), error => error.status === 409 && /claim conflict/i.test(error.message));
  assert.strictEqual(terminal, false,
    'a non-equivalent claim conflict must roll back terminal casino settlement');
}

async function testAdminStatsPreserveExactNumericStringsBeyondBigint() {
  const layer = casinoRouter.stack.find(entry => entry.route?.path === '/admin-stats');
  assert(layer, 'admin stats route missing');
  const handler = layer.route.stack.at(-1).handle;
  const sql = [];
  const huge = '9223372036854775808.25';
  const db = {
    async get(statement) {
      sql.push(statement);
      return { total_games: 2, total_wagered: huge, total_payout: '10.75', house_profit: '-1.25' };
    },
    async query(statement) {
      sql.push(statement);
      if (/GROUP BY game_type/.test(statement)) return [{ wagered: '10.25', payout: '10.75', house_profit: '-0.50' }];
      if (/ORDER BY stats.net DESC/.test(statement)) return [{ net: huge }];
      if (/ORDER BY stats.net ASC/.test(statement)) return [{ net: '-9223372036854775808.25' }];
      return [{ wager: '10.25', payout: '10.75', net: '0.50' }];
    },
  };
  const req = { app: { locals: { db } }, query: {}, playerServerAccess: { serverId: 13 } };
  const res = {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler(req, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.summary.total_wagered, huge);
  assert.strictEqual(res.body.byGame[0].wagered, '10.25');
  assert.strictEqual(res.body.recent[0].net, '0.50');
  assert(sql.every(statement => !/::bigint/i.test(statement)),
    'NUMERIC money must not be rounded or overflow through BIGINT casts');
}

async function main() {
  assert.ok(casinoRouter._test?.settleCasinoBet, 'casino settlement test seam must exist');
  const calls = [];
  const session = {
    session_id: 'a'.repeat(64), user_id: 7, identity_id: 11, server_id: 13,
    guild_id: 17, game_type: 'holdem', state: {}, version: 2,
    status: 'active', expires_at: new Date(Date.now() + 60000).toISOString()
  };
  const db = {
    async transaction(callback) { calls.push('transaction'); return callback(this); },
    async get(sql) {
      calls.push(sql);
      if (/SELECT guild_id FROM servers/.test(sql)) return { guild_id: 17 };
      if (/FROM guilds/.test(sql)) return { id: 17 };
      if (/FROM servers/.test(sql)) return { id: 13 };
      if (/server_player_memberships/.test(sql)) return { id: 99, source_link_id: 88 };
      if (/linked_accounts/.test(sql)) return { id: 88 };
      if (/casino_sessions/.test(sql)) return session;
      if (/player_wallets/.test(sql)) return { cash_on_hand: 100 };
      if (/guild_economy_config/.test(sql)) return {
        guild_id: 17, fixed_supply_enabled: false, max_money_supply: null,
        current_money_supply: 100
      };
      return null;
    },
    async run(sql) {
      calls.push(sql);
      return { changes: 1 };
    }
  };

  const balance = await casinoRouter._test.settleCasinoBet(db, {
    identityId: 11, serverId: 13, guildId: 17, gameType: 'holdem',
    wager: 10, payout: 20, result: 'win', resultData: {},
    casinoSession: {
      binding: { sessionId: session.session_id, userId: 7, identityId: 11,
        serverId: 13, guildId: 17, gameType: 'holdem' },
      version: 2
    }
  });

  assert.strictEqual(balance, 110);
  assert.ok(calls.some(sql => /casino_sessions[\s\S]*FOR UPDATE/.test(sql)), 'session row must be locked');
  assert.ok(calls.some(sql => /player_wallets[\s\S]*FOR UPDATE/.test(sql)), 'wallet row must be locked');
  assert.ok(calls.some(sql => /status = 'settled'/.test(sql)), 'terminal session must be consumed');
  await testOverflowingStatefulWinCancelsAfterCommit();
  await testOverflowingRefundBecomesDurableClaimAndConsumesSession();
  await testMismatchedClaimConflictRollsBackCasinoSettlement();
  await testAdminStatsPreserveExactNumericStringsBeyondBigint();
  console.log('casino atomic settlement behavior test passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
