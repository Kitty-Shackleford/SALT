'use strict';

/**
 * Regression: casino settlement result labels vs the CHECK constraint.
 *
 * casino_game_history.result is CHECK (result IN ('win','loss','push'))
 * (migration 028) and is never widened. Two flows used to write illegal
 * labels there:
 *   1. Split-hand aggregate: settleAllSplitHands() labeled a non-all-loss
 *      aggregate 'split' (player-side: one or more hands won or pushed).
 *   2. Natural blackjack: resolveBlackjack() / the natural-on-deal and
 *      insurance branches wrote 'blackjack' for a 3:2 player win.
 * Both made the settlement INSERT violate the constraint, rolling back the
 * whole transaction (500 + stranded escrow).
 *
 * The fix normalizes at the single settlement boundary (settleCasinoBetInTransaction)
 * from the already-computed net: net > 0 → 'win', net = 0 → 'push',
 * net < 0 → 'loss'. Game-specific labels ('blackjack', 'split') stay in the
 * API response and result_data, where the UI still renders them.
 *
 * The fake DB below enforces the CHECK constraint the same way
 * Postgres does: any INSERT INTO casino_game_history whose result column is
 * not one of 'win','loss','push' is rejected, so a settlement path that
 * tries to persist an illegal label fails exactly like production.
 */

const assert = require('assert');
const casinoRouter = require('../routes/casino');

const LEGAL_RESULTS = new Set(['win', 'loss', 'push']);
const HISTORY_INSERT = /INSERT INTO casino_game_history/;
const SESSION_ID = 'e'.repeat(64);

// ── Helpers ──────────────────────────────────────────────────────────────────

function card(rank) {
  const value = rank === 'A' ? 11 : (['K', 'Q', 'J'].includes(rank) ? 10 : parseInt(rank, 10));
  return { suit: '♠', rank, value };
}

const CONTEXT = {
  identityId: 11,
  server: { id: 13, guild_id: 17 },
  binding: { sessionId: SESSION_ID, userId: 7, identityId: 11, serverId: 13, guildId: 17, gameType: 'blackjack' },
  version: 2,
};

function splitState(hand1Cards, hand2Cards, wager = 10) {
  return {
    wager,
    playerCards: [],
    dealerCards: [card('5')],
    doubled: false,
    playerHasBJ: false,
    insuranceBet: 0,
    insuranceSettled: true,
    splitHands: [
      { cards: hand1Cards, wager, doubled: false, result: null },
      { cards: hand2Cards, wager, doubled: false, result: null },
    ],
    currentHandIndex: 1,
  };
}

function makeDb({
  calls = [],
  balance = '500.00',
  session,
  extraGet = null,
} = {}) {
  const db = {
    async transaction(callback) { return callback(this); },
    async get(sql) {
      if (extraGet) {
        const override = extraGet(sql);
        if (override !== undefined) return override;
      }
      if (/pg_advisory_xact_lock/.test(sql)) return {};
      if (/FROM guilds/.test(sql)) return { id: 17 };
      if (/FROM servers/.test(sql)) return { id: 13, guild_id: 17 };
      if (/FROM guild_economy_config/.test(sql)) return {
        guild_id: 17, server_id: 13, fixed_supply_enabled: false,
        max_money_supply: null, current_money_supply: '500.00',
      };
      if (/server_player_memberships/.test(sql)) return { id: 99, source_link_id: 88 };
      if (/FROM linked_accounts/.test(sql)) return { id: 88 };
      if (/SELECT \* FROM casino_sessions/.test(sql)) return session;
      if (/expires_at <= clock_timestamp/.test(sql)) return { is_expired: false };
      if (/FROM player_wallets/.test(sql)) return {
        id: 3, identity_id: 11, server_id: 13, cash_on_hand: balance,
      };
      if (/INSERT INTO financial_idempotency_records/.test(sql)) return { id: 42 };
      return null;
    },
    async run(sql, params = []) {
      if (HISTORY_INSERT.test(sql)) {
        const result = params[6];
        assert.ok(LEGAL_RESULTS.has(result),
          `CHECK violation: casino_game_history.result must be win|loss|push, got ${JSON.stringify(result)}`);
      }
      calls.push({ sql, params });
      return { changes: 1, lastID: 1 };
    },
  };
  return db;
}

function historyInsert(calls) {
  return calls.find(call => HISTORY_INSERT.test(call.sql));
}

function splitSession() {
  return {
    session_id: SESSION_ID, user_id: 7, identity_id: 11, server_id: 13,
    guild_id: 17, game_type: 'blackjack', state: {}, version: 2,
    reserved_wager: '20.00', status: 'active',
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
}

// ── Unit level: the normalization itself ─────────────────────────────────────

function testLegalSettlementResultMapping() {
  const { legalSettlementResult, resolveBlackjack } = casinoRouter._test;
  assert.ok(legalSettlementResult, 'legalSettlementResult test seam must exist');

  // The natural blackjack is a player-side WIN at the 3:2 multiplier…
  assert.strictEqual(resolveBlackjack([card('A'), card('K')], [card('10'), card('9')]).result, 'blackjack');
  assert.strictEqual(legalSettlementResult('blackjack', 1500), 'win',
    'a natural (net +1.5×) must persist as win');
  // …while split aggregates map by the aggregate net…
  assert.strictEqual(legalSettlementResult('split', 0), 'push', 'all-push split aggregate must persist as push');
  assert.strictEqual(legalSettlementResult('split', -2000), 'loss', 'all-loss split aggregate must persist as loss');
  assert.strictEqual(legalSettlementResult('split', 2500), 'win', 'non-all-loss split aggregate must persist as win');
  // …and already-legal labels pass through untouched, net signs and all.
  for (const legal of LEGAL_RESULTS) {
    assert.strictEqual(legalSettlementResult(legal, 0), legal);
    assert.strictEqual(legalSettlementResult(legal, 1), legal);
    assert.strictEqual(legalSettlementResult(legal, -1), legal);
  }
}

// ── Split-hand settlement (settleAllSplitHands) ──────────────────────────────

async function testSplitAggregateMixedSettlesAsWin() {
  const calls = [];
  const db = makeDb({ calls, balance: '200.00', session: splitSession() });
  // Hand 1: 9 + 10 = 19 beats dealer 16 → win (wager 10 → payout 20, net +10)
  // Hand 2: 6 + 10 = 16 ties dealer 16 → push (wager 10 → payout 10, net 0)
  // Aggregate: wager 20, payout 30, net +10 → player-side WIN.
  const state = splitState([card('9'), card('J')], [card('6'), card('10')]);
  const dealer = [card('10'), card('6')];

  const results = await casinoRouter._test.settleAllSplitHands(
    db, state, dealer, '$', CONTEXT, { inTransaction: true });

  assert.deepStrictEqual(results.map(r => r.result), ['win', 'push']);
  assert.deepStrictEqual(results.map(r => r.payout), [20, 10], 'per-hand payouts must stay exact');
  const insert = historyInsert(calls);
  assert(insert, 'split settlement must write a casino_game_history row');
  assert.strictEqual(insert.params[3], 'blackjack');
  assert.strictEqual(insert.params[4], '20.00', 'aggregate wager (both hands)');
  assert.strictEqual(insert.params[5], '30.00', 'aggregate payout (win 20 + push 10)');
  assert.strictEqual(insert.params[6], 'win',
    'a net-positive split aggregate must be persisted as win, not split');
  assert(JSON.parse(insert.params[7]).split === true, 'split flag must stay in result_data');
}

async function testSplitAggregateAllLossSettlesAsLoss() {
  const calls = [];
  const db = makeDb({ calls, balance: '200.00', session: splitSession() });
  // Hand 1: 4 + 6 = 10, Hand 2: 3 + 5 = 8, dealer 17 → both lose
  const state = splitState([card('4'), card('6')], [card('3'), card('5')]);
  const dealer = [card('9'), card('8')];

  const results = await casinoRouter._test.settleAllSplitHands(
    db, state, dealer, '$', CONTEXT, { inTransaction: true });

  assert.deepStrictEqual(results.map(r => r.result), ['loss', 'loss']);
  assert.deepStrictEqual(results.map(r => r.payout), [0, 0]);
  const insert = historyInsert(calls);
  assert.strictEqual(insert.params[5], '0.00', 'all-loss split pays out nothing');
  assert.strictEqual(insert.params[6], 'loss',
    'an all-loss split aggregate must still persist as loss');
}

async function testSplitAggregateAllPushSettlesAsPush() {
  const calls = [];
  const db = makeDb({ calls, balance: '200.00', session: splitSession() });
  // Hand 1: 6 + 10 = 16, Hand 2: 7 + 9 = 16, dealer 16 → both push
  const state = splitState([card('6'), card('J')], [card('7'), card('9')]);
  const dealer = [card('10'), card('6')];

  const results = await casinoRouter._test.settleAllSplitHands(
    db, state, dealer, '$', CONTEXT, { inTransaction: true });

  assert.deepStrictEqual(results.map(r => r.result), ['push', 'push']);
  assert.deepStrictEqual(results.map(r => r.payout), [10, 10], 'pushes return the stake');
  const insert = historyInsert(calls);
  assert.strictEqual(insert.params[4], '20.00');
  assert.strictEqual(insert.params[5], '20.00', 'all-push split returns the full wager');
  assert.strictEqual(insert.params[6], 'push',
    'an all-push split aggregate must persist as push, not split');
}

// ── Natural blackjack via the real deal handler ──────────────────────────────

async function testNaturalBlackjackDealSettlesAsWin() {
  const calls = [];
  const { resolveBlackjack } = casinoRouter._test;
  // Player natural vs dealer without an up-card BJ: label stays 'blackjack'.
  assert.strictEqual(
    resolveBlackjack([card('A'), card('10')], [card('10'), card('7')]).result,
    'blackjack');

  // drawCard() pulls Math.random() twice per card: suit index, then rank
  // index. Pin the raw sequence: [suit, rank] per card —
  //   player: A♠, 10♠  dealer: 10♠, 7♠
  const randomValues = [0, 0 / 13, 0, 9 / 13, 0, 9 / 13, 0, 6 / 13];
  // Pin the RNG: 0 → suit ♠; rank index = floor(r * 13).
  const originalRandom = Math.random;
  Math.random = () => randomValues.shift();
  const db = makeDb({
    calls,
    balance: '100.00',
    session: null,
    extraGet: sql => {
      if (/FROM player_identities/.test(sql)) {
        return { id: 11, server_id: 13, gamertag: 'Tester' };
      }
      if (/FROM servers WHERE id =/.test(sql)) {
        return { id: 13, guild_id: 17, status: 'active', name: 'S13' };
      }
      if (/FROM guild_economy_config/.test(sql)) {
        return {
          server_id: 13, enabled: true, casino_enabled: true,
          currency_symbol: '$', currency_name: 'Credits',
          casino_min_bet: '1', casino_max_bet: '10000',
          fixed_supply_enabled: false, max_money_supply: null,
          current_money_supply: '100.00',
        };
      }
      return undefined;
    },
  });

  const layer = casinoRouter.stack.find(entry => entry.route?.path === '/play/blackjack');
  assert(layer, 'blackjack route missing');
  const handler = layer.route.stack.at(-1).handle;
  const req = {
    app: { locals: { db } },
    body: { identityId: '11', action: 'deal', wager: 10 },
    user: { id: 7 },
    playerServerAccess: { serverId: 13 },
    get: name => name === 'Idempotency-Key' ? 'regression-natural-bj' : undefined,
  };
  const res = {
    statusCode: 200, body: null,
    set() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  try {
    await handler(req, res);
  } finally {
    Math.random = originalRandom;
  }

  assert.strictEqual(res.statusCode, 200, `deal must not 500: ${JSON.stringify(res.body)}`);
  assert.strictEqual(res.body.status, 'complete');
  assert.strictEqual(res.body.result, 'blackjack', 'API keeps the display label');
  assert.strictEqual(res.body.playerTotal, 21);
  assert.strictEqual(res.body.net, 15, '3:2 payout on a 10 wager → net +15');
  assert.strictEqual(res.body.balanceAfter, 115);

  const insert = historyInsert(calls);
  assert(insert, 'natural blackjack must write a casino_game_history row');
  assert.strictEqual(insert.params[4], '10.00', 'wager unchanged');
  assert.strictEqual(insert.params[5], '25.00', '2.5× payout must be preserved exactly');
  assert.strictEqual(insert.params[6], 'win',
    'natural blackjack must be persisted as win, not blackjack');
  assert(JSON.parse(insert.params[7]).playerTotal === 21, 'cards stay in result_data');
  // Idempotency must record the successful response, not an error replay.
  const idemComplete = calls.find(call =>
    /UPDATE financial_idempotency_records/.test(call.sql) && call.params[0] === 200);
  assert(idemComplete, 'idempotency record must be completed with status 200');
  assert.strictEqual(JSON.parse(idemComplete.params[1]).result, 'blackjack');
}

function main() {
  return (async () => {
    assert.ok(casinoRouter._test?.legalSettlementResult, 'normalization test seam must exist');
    assert.ok(casinoRouter._test?.settleAllSplitHands, 'split settlement test seam must exist');
    testLegalSettlementResultMapping();
    await testSplitAggregateMixedSettlesAsWin();
    await testSplitAggregateAllLossSettlesAsLoss();
    await testSplitAggregateAllPushSettlesAsPush();
    await testNaturalBlackjackDealSettlesAsWin();
    console.log('casino settlement result regression test passed');
  })();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
