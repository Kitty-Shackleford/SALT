'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function main() {
  const {
    parseShopCheckoutCommand,
    buildShopCartFingerprint,
  } = require('../utils/shopCheckoutCommand');
  const {
    parseIdempotencyKey,
    fingerprintFinancialRequest,
    claimFinancialOperationInTransaction,
    completeFinancialOperationInTransaction,
  } = require('../utils/financialIdempotency');

  assert.throws(
    () => parseIdempotencyKey({ get: () => undefined }),
    /Idempotency-Key is required/,
    'financial mutations must reject requests without an idempotency key'
  );
  assert.strictEqual(
    parseIdempotencyKey({ get: name => name === 'Idempotency-Key' ? 'request-1' : undefined }),
    'request-1'
  );
  assert.throws(
    () => parseIdempotencyKey({ get: () => 'x'.repeat(129) }),
    /128 characters or fewer/
  );

  assert.strictEqual(
    fingerprintFinancialRequest({ amountCents: 100, operation: 'deposit' }),
    fingerprintFinancialRequest({ operation: 'deposit', amountCents: 100 }),
    'semantic fingerprints must not depend on object key insertion order'
  );

  const cart = { id: '41', identity_id: '11', server_id: '7', total_price: '25.00' };
  const cartItems = [
    { id: '2', order_id: '41', shop_item_id: '8', quantity: 1, unit_price: '10.00' },
    { id: '3', order_id: '41', shop_item_id: '9', quantity: 1, unit_price: '15.00' },
  ];
  const cartFingerprint = buildShopCartFingerprint(cart, cartItems);
  assert.match(cartFingerprint, /^[a-f0-9]{64}$/);
  assert.strictEqual(
    cartFingerprint,
    buildShopCartFingerprint(cart, [cartItems[1], cartItems[0]]),
    'cart fingerprints must use deterministic line ordering'
  );
  assert.notStrictEqual(
    cartFingerprint,
    buildShopCartFingerprint(cart, [{ ...cartItems[0], quantity: 2 }, cartItems[1]]),
    'cart fingerprints must change with the purchased contents'
  );
  assert.deepStrictEqual(parseShopCheckoutCommand({
    cartId: 41,
    cartFingerprint,
  }), { cartId: 41, cartFingerprint });
  assert.throws(() => parseShopCheckoutCommand({ cartId: 0, cartFingerprint }), /cartId/i);
  assert.throws(() => parseShopCheckoutCommand({ cartId: 41, cartFingerprint: 'bad' }), /cartFingerprint/i);

  const writes = [];
  const newClaimDb = {
    async get(sql, params) {
      writes.push({ sql, params });
      if (/INSERT INTO financial_idempotency_records/.test(sql)) return { id: 9 };
      throw new Error(`Unexpected get: ${sql}`);
    },
    async run(sql, params) { writes.push({ sql, params }); return { changes: 1 }; },
  };
  const scope = {
    serverId: 7,
    identityId: 11,
    actorUserId: 13,
    operation: 'deposit',
    idempotencyKey: 'request-1',
    requestFingerprint: fingerprintFinancialRequest({ operation: 'deposit', amountCents: 100 }),
  };
  const claim = await claimFinancialOperationInTransaction(newClaimDb, scope);
  assert.deepStrictEqual(claim, { id: 9, replay: false });
  await completeFinancialOperationInTransaction(newClaimDb, 9, 200, {
    success: true,
    walletBalance: 9,
  });
  assert.match(writes[1].sql, /response_body[\s\S]*completed_at/i);

  const completed = {
    id: 9,
    operation: 'deposit',
    request_fingerprint: scope.requestFingerprint,
    response_status: 200,
    response_body: { success: true, walletBalance: 9 },
    completed_at: new Date().toISOString(),
  };
  const replayDb = {
    async get(sql) {
      if (/INSERT INTO financial_idempotency_records/.test(sql)) return null;
      if (/SELECT/.test(sql) && /FOR UPDATE/.test(sql)) return completed;
      throw new Error(`Unexpected get: ${sql}`);
    },
  };
  assert.deepStrictEqual(
    await claimFinancialOperationInTransaction(replayDb, scope),
    { id: 9, replay: true, status: 200, body: completed.response_body }
  );

  const conflictDb = {
    async get(sql) {
      if (/INSERT INTO financial_idempotency_records/.test(sql)) return null;
      if (/SELECT/.test(sql) && /FOR UPDATE/.test(sql)) {
        return { ...completed, request_fingerprint: '0'.repeat(64) };
      }
      throw new Error(`Unexpected get: ${sql}`);
    },
  };
  await assert.rejects(
    () => claimFinancialOperationInTransaction(conflictDb, scope),
    error => error.status === 409 && /conflicts/.test(error.message)
  );

  const economySource = fs.readFileSync(path.join(__dirname, '..', 'routes/economy.js'), 'utf8');
  assert.match(economySource, /parseIdempotencyKey\(req\)/,
    'deposit, withdrawal, and transfer routes must require Idempotency-Key');
  assert.match(economySource, /completeFinancialOperationInTransaction/,
    'financial responses must be persisted in the same transaction as balance changes');

  for (const file of ['public/js/player-portal.js', 'public/js/economy-dashboard-init.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(source, /Idempotency-Key/,
      `${file} must supply idempotency keys for first-party financial mutations`);
  }

  const shopRouteSource = fs.readFileSync(path.join(__dirname, '..', 'routes/shop.js'), 'utf8');
  const shopClientSource = fs.readFileSync(path.join(__dirname, '..', 'public/js/shop.js'), 'utf8');
  assert.match(shopRouteSource, /operation: 'shop_checkout'/,
    'shop checkout must claim a durable financial idempotency record');
  assert.match(shopRouteSource, /shopFileService\.acquireShopServerLock\(transactionDb, serverId\)[\s\S]*shopFileService\.assertCheckoutAuthority\(transactionDb,[\s\S]*claimFinancialOperationInTransaction/,
    'shop checkout must acquire the canonical server and authority locks before its idempotency claim');
  assert.match(shopRouteSource, /completeFinancialOperationInTransaction/,
    'shop checkout must persist its exact response with the financial mutation');
  assert.match(shopRouteSource, /res\.status\(503\)\.json\(\{ error: 'Internal server error', checkoutState: 'unknown' \}\)/,
    'unknown checkout outcomes must be retryable with the same durable request identity');
  assert.match(shopClientSource, /'Idempotency-Key': idempotencyKey/,
    'the shop client must send one stable idempotency key per checkout intent');
  assert.match(shopRouteSource, /parseShopCheckoutCommand\(req\.body\)/,
    'shop checkout must validate the immutable cart command from the request');
  assert.match(shopRouteSource, /cartId: checkoutCommand\.cartId,[\s\S]*cartFingerprint: checkoutCommand\.cartFingerprint/,
    'the durable request fingerprint must bind the exact cart and content fingerprint');
  assert.match(shopRouteSource, /buildShopCartFingerprint\(cart, cartItems\)/,
    'checkout must compare the requested fingerprint with the locked current cart');
  const checkoutFunction = shopClientSource.slice(
    shopClientSource.indexOf('async function checkout()'),
    shopClientSource.indexOf('// ── Active Rentals')
  );
  assert.ok(
    checkoutFunction.indexOf('const previousOutcome = checkoutOutcomes.get(contextKey)') <
      checkoutFunction.indexOf('!cartItems.length'),
    'safe replay state must be consulted before the local empty-cart guard'
  );
  assert.match(checkoutFunction, /previousOutcome\?\.requestBody \|\| currentCheckoutCommand/,
    'safe retries must retain the exact original cart command body');
  assert.match(checkoutFunction, /body: JSON\.stringify\(requestBody\)/,
    'checkout retries must resend the exact retained command body');

  const casinoSource = fs.readFileSync(path.join(__dirname, '..', 'routes/casino.js'), 'utf8');
  const casinoRouter = require('../routes/casino');
  assert.ok(casinoRouter._test?.runIdempotentCasinoRequest,
    'casino idempotency transaction must expose a behavioral test seam');
  let cancellationCommitted = false;
  const cancellationDb = {
    async transaction(callback) {
      const transaction = {
        async get(sql) {
          if (/pg_advisory_xact_lock/.test(sql)) return {};
          if (/SELECT guild_id FROM servers/.test(sql)) return { guild_id: 17 };
          if (/FROM guilds/.test(sql)) return { id: 17 };
          if (/FROM servers/.test(sql)) return { id: 7 };
          if (/guild_economy_config/.test(sql)) return null;
          if (/server_player_memberships/.test(sql)) return { id: 19, source_link_id: 23 };
          if (/linked_accounts/.test(sql)) return { id: 23 };
          if (/INSERT INTO financial_idempotency_records/.test(sql)) return { id: '31' };
          throw new Error(`Unexpected cancellation get: ${sql}`);
        },
        async run(sql) {
          if (/UPDATE financial_idempotency_records/.test(sql)) return { changes: 1 };
          throw new Error(`Unexpected cancellation run: ${sql}`);
        },
      };
      const result = await callback(transaction);
      cancellationCommitted = true;
      return result;
    },
  };
  const cancellationResponse = await casinoRouter._test.runIdempotentCasinoRequest(
    cancellationDb,
    { user: { id: 13 }, get: () => 'cancelled-win-request' },
    { serverId: 7, identityId: 11, operation: 'casino_holdem_call', input: { action: 'call' } },
    async () => {
      const error = new Error('Casino win cancelled because destination wallet capacity was exceeded');
      error.status = 409;
      error.cancellation = { cancelled: true };
      throw error;
    }
  );
  assert.strictEqual(cancellationCommitted, true,
    'capacity cancellation and its idempotent response must commit together');
  assert.deepStrictEqual(cancellationResponse, {
    replay: false,
    status: 409,
    body: { error: 'Casino win cancelled because destination wallet capacity was exceeded' },
  });
  assert.match(casinoSource, /runIdempotentCasinoRequest/,
    'casino RNG and settlement must run inside a durable idempotent request transaction');
  for (const routeContract of [
    ["const HORSE_RACING_ACTIONS = ['new-race', 'place-bet']", 'horse-racing'],
    ["const COURSING_ACTIONS = ['new-race', 'place-bet']", 'coursing'],
  ]) {
    assert(casinoSource.includes(routeContract[0]),
      `${routeContract[1]} must reject unknown actions before claiming an idempotency record`);
  }
  for (const operation of [
    'casino_blackjack_insurance',
    'casino_blackjack_no_insurance',
    'casino_blackjack_split',
    'casino_blackjack_hit',
    'casino_blackjack_stand',
    'casino_blackjack_double',
    'casino_horse_racing_new_race',
    'casino_horse_racing_place_bet',
    'casino_coursing_new_race',
    'casino_coursing_place_bet',
    'casino_craps_point_roll',
    'casino_holdem_call',
    'casino_holdem_fold',
  ]) {
    assert(casinoSource.includes(`'${operation}'`),
      `${operation} must have its own durable request identity`);
  }
  for (const file of ['public/js/casino/slots.js', 'public/js/casino/baccarat.js',
    'public/js/casino/craps.js', 'public/js/casino/roulette.js',
    'public/js/casino/blackjack.js', 'public/js/casino/horseracing.js',
    'public/js/casino/coursing.js', 'public/js/casino/holdem.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(source, /Idempotency-Key/,
      `${file} must supply idempotency keys for first-party casino mutations`);
  }

  const apiSource = fs.readFileSync(path.join(__dirname, '..', 'public/js/api.js'), 'utf8');
  const attempts = [];
  const apiContext = {
    console,
    document: { querySelector: () => ({ content: 'csrf-token' }) },
    setTimeout: callback => callback(),
    window: { location: {} },
    fetch: async (_url, options) => {
      attempts.push({
        key: options.headers['Idempotency-Key'],
        body: options.body,
      });
      if (attempts.length === 1) throw new TypeError('network failure');
      return { status: 200 };
    },
  };
  vm.runInNewContext(apiSource, apiContext);
  await apiContext.window.api.fetchWithCsrf('/api/economy/deposit', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'logical-request-1' },
    body: '{}',
  });
  assert.deepStrictEqual(attempts, [
    { key: 'logical-request-1', body: '{}' },
    { key: 'logical-request-1', body: '{}' },
  ], 'idempotent POST transport retries must retain the logical request key and exact body');

  console.log('financial idempotency tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
