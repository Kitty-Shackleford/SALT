'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CHECKOUT_STATES,
  createCheckoutAttemptRegistry,
  createCheckoutStateMachine,
  checkoutView,
  resolveCheckoutOutcome,
} = require('../public/js/checkout-state');

(function run() {
  const rendered = [];
  const machine = createCheckoutStateMachine((state, detail) => rendered.push({ state, detail }));
  assert.strictEqual(machine.state, CHECKOUT_STATES.IDLE);

  machine.transition(CHECKOUT_STATES.CHECKING);
  machine.transition(CHECKOUT_STATES.PROCESSING);
  assert.deepStrictEqual(checkoutView(machine.state), {
    buttonLabel: 'Processing order…',
    message: 'Processing your order… Please wait while we confirm your purchase.',
    disabled: true,
    busy: true,
  });
  assert.strictEqual(checkoutView(CHECKOUT_STATES.PROCESSING, { slow: true }).message,
    'Still working — this may take a few moments.');

  machine.transition(CHECKOUT_STATES.RECOVERY, { message: 'Provider reconciliation is pending.' });
  const recovery = checkoutView(machine.state, machine.detail);
  assert.strictEqual(recovery.disabled, true);
  assert.match(recovery.message, /reconciliation/i);

  machine.reset();
  machine.transition(CHECKOUT_STATES.CHECKING);
  machine.transition(CHECKOUT_STATES.FAILED, { message: 'Insufficient funds' });
  const failed = checkoutView(machine.state, machine.detail);
  assert.strictEqual(failed.buttonLabel, 'Try Again');
  assert.strictEqual(failed.disabled, false);
  assert.doesNotMatch(failed.message, /not charged/i,
    'the UI must not make an unproven financial claim');

  machine.reset();
  machine.transition(CHECKOUT_STATES.CHECKING);
  machine.transition(CHECKOUT_STATES.UNKNOWN);
  const unknown = checkoutView(machine.state);
  assert.strictEqual(unknown.disabled, false);
  assert.strictEqual(unknown.busy, false);
  assert.match(unknown.buttonLabel, /retry/i);
  assert.match(unknown.message, /same request/i);
  machine.transition(CHECKOUT_STATES.CHECKING);

  assert.ok(rendered.length >= 8);

  const attempts = createCheckoutAttemptRegistry();
  const first = attempts.begin('server-1:identity-1');
  assert.ok(first, 'the first checkout for a context must start');
  assert.strictEqual(attempts.begin('server-1:identity-1'), null,
    'the same cart context must not start twice while its checkout is pending');
  const secondContext = attempts.begin('server-2:identity-1');
  assert.ok(secondContext, 'a distinct cart context may start independently');
  assert.strictEqual(attempts.has('server-1:identity-1'), true,
    'switching away must retain the original pending checkout');
  attempts.finish(first);
  assert.strictEqual(attempts.has('server-1:identity-1'), false);
  attempts.finish(secondContext);

  assert.strictEqual(resolveCheckoutOutcome({ responseOk: true, checkoutState: 'success' }),
    CHECKOUT_STATES.SUCCESS);
  assert.strictEqual(resolveCheckoutOutcome({ responseOk: false, checkoutState: 'recovery' }),
    CHECKOUT_STATES.RECOVERY);
  assert.strictEqual(resolveCheckoutOutcome({ responseOk: false, checkoutState: 'unknown' }),
    CHECKOUT_STATES.UNKNOWN);
  assert.strictEqual(resolveCheckoutOutcome({ responseOk: false, checkoutState: 'processing' }),
    CHECKOUT_STATES.UNKNOWN,
    'a busy checkout must retain the same request identity for a safe retry');
  assert.strictEqual(resolveCheckoutOutcome({ responseOk: false, responseStatus: 504 }),
    CHECKOUT_STATES.UNKNOWN,
    'a final gateway timeout must not claim that checkout failed');
  assert.strictEqual(resolveCheckoutOutcome({ responseOk: false, invalidResponse: true }),
    CHECKOUT_STATES.UNKNOWN,
    'a malformed gateway response must not claim that checkout failed');
  assert.strictEqual(resolveCheckoutOutcome({ networkError: true }), CHECKOUT_STATES.UNKNOWN,
    'a transport failure must not claim that checkout failed');

  const shopSource = fs.readFileSync(path.join(__dirname, '../public/js/shop.js'), 'utf8');
  const shopHtml = fs.readFileSync(path.join(__dirname, '../public/shop.html'), 'utf8');
  const routeSource = fs.readFileSync(path.join(__dirname, '../src/app/registerRoutes.js'), 'utf8');
  const idempotencySource = fs.readFileSync(
    path.join(__dirname, '../utils/financialIdempotency.js'), 'utf8'
  );
  assert.match(shopHtml, /\/js\/checkout-state\.js\?v=checkout-idempotency-v1/,
    'the checkout state contract must use a cache-busting asset URL');
  assert.match(shopHtml, /\/js\/shop\.js\?v=checkout-idempotency-v1/,
    'the checkout transport must use a cache-busting asset URL');
  assert.match(routeSource, /app\.get\('\/shop'[\s\S]*?Cache-Control', 'no-store'[\s\S]*?renderWithCsrf\(pub\('shop\.html'/,
    'the authenticated shop document must not be reused across checkout contract deployments');
  assert.match(idempotencySource, /Idempotency-Key is required[^']*refresh/i,
    'a stale financial client must receive an actionable refresh instruction');
  assert.match(shopSource, /createCheckoutAttemptRegistry\(\)/,
    'the live shop must share duplicate protection across selector contexts');
  assert.match(shopSource, /resolveCheckoutOutcome\(/,
    'the live shop must map backend and transport outcomes explicitly');
  assert.match(shopSource, /checkoutMachine\.transition\(CHECKOUT_STATES\.PROCESSING/,
    'the live shop must display processing state before awaiting checkout');
  assert.match(shopSource, /previousOutcome\?\.idempotencyKey/,
    'an unknown checkout retry must reuse the original durable idempotency key');
  assert.match(shopSource, /resetCheckoutForCartMutation\(contextKey\)/,
    'adding a new cart item after success must restore checkout to idle');
  const quantityMutation = shopSource.slice(
    shopSource.indexOf('async function updateCartItemQty'),
    shopSource.indexOf('async function removeCartItem')
  );
  const removalMutation = shopSource.slice(
    shopSource.indexOf('async function removeCartItem'),
    shopSource.indexOf('/** Checkout: process the current cart.')
  );
  assert.match(quantityMutation, /resetCheckoutForCartMutation\(contextKey\)/,
    'a successful quantity update must invalidate any retained checkout request identity');
  assert.match(removalMutation, /resetCheckoutForCartMutation\(contextKey\)/,
    'a successful removal must invalidate any retained checkout request identity');
  assert.match(shopSource, /checkoutOutcomes\.set\(contextKey, \{ state: outcome, detail, idempotencyKey, requestBody \}\)/,
    'unknown outcomes must retain the key and exact command body needed for safe retry');
  assert.match(shopSource, /let displayedCatalogServerId = null/,
    'catalog rendering must track which server is actually displayed');
  assert.match(shopSource, /displayedCatalogServerId !== currentServerId/,
    'A → B → A switches must reload when the visible catalog no longer matches');
  assert.match(shopSource, /responseStatus: res\.status/,
    'gateway statuses must participate in checkout outcome classification');
  assert.match(shopSource, /invalidResponse,/,
    'malformed checkout responses must remain financially uncertain');
  assert.doesNotMatch(shopSource, /if \(checkoutBtn\) checkoutBtn\.disabled = false/,
    'selector changes must not blindly re-enable checkout');

  console.log('Shop checkout UI state-machine tests passed');
})();
