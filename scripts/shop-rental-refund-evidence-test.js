'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

async function main() {
  const refundPolicy = require('../services/shopRentalRefundService');

  assert.deepStrictEqual(
    refundPolicy.calculateProratedRentalRefund({
      unitPrice: '20.00',
      quantity: 6,
      purchasedRestarts: 6,
      remainingRestarts: 4,
    }),
    { paidCents: 12000n, maximumRefundCents: 8000n, consumedRestarts: 2 },
    'unused scheduled restarts must determine the normal refundable amount'
  );
  assert.deepStrictEqual(
    refundPolicy.calculateProratedRentalRefund({
      unitPrice: '10.00',
      quantity: 3,
      purchasedRestarts: 3,
      remainingRestarts: 2,
    }),
    { paidCents: 3000n, maximumRefundCents: 2000n, consumedRestarts: 1 },
    'quantity must affect the paid and refundable amounts without multiplying restart counts'
  );
  assert.deepStrictEqual(
    refundPolicy.calculateProratedRentalRefund({
      unitPrice: '10.00',
      quantity: 3,
      purchasedRestarts: 3,
      remainingRestarts: 0,
    }),
    { paidCents: 3000n, maximumRefundCents: 0n, consumedRestarts: 3 },
    'a fully consumed rental has no normal refundable value'
  );
  assert.deepStrictEqual(
    refundPolicy.calculateProratedRentalRefund({
      unitPrice: '90071992547409.93',
      quantity: 1,
      purchasedRestarts: 1,
      remainingRestarts: 1,
    }),
    { paidCents: 9007199254740993n, maximumRefundCents: 9007199254740993n, consumedRestarts: 0 },
    'NUMERIC(20,2) refund values beyond JavaScript safe integers must remain exact'
  );
  assert.deepStrictEqual(
    refundPolicy.validateRefundDecision({
      calculatedRefundCents: 9007199254740993n,
      requestedRefundCents: 9007199254740993n,
      paidCents: 9007199254740993n,
      reasonCode: 'provider_failure',
      adminNote: '',
      override: false,
    }),
    { overrideApplied: false, adminNote: '' },
    'refund validation must accept exact BigInt cents through the NUMERIC(20,2) boundary'
  );
  assert.throws(() => refundPolicy.calculateProratedRentalRefund({
    unitPrice: '10.00', quantity: 3, purchasedRestarts: 3, remainingRestarts: 4,
  }), error => error.status === 400 && /remaining restarts/i.test(error.message));
  assert.strictEqual(
    refundPolicy.validateRefundDecision({
      calculatedRefundCents: 8000,
      requestedRefundCents: 8000,
      reasonCode: 'provider_failure',
      adminNote: '',
      override: false,
    }).overrideApplied,
    false
  );
  assert.throws(() => refundPolicy.validateRefundDecision({
    calculatedRefundCents: 0,
    requestedRefundCents: 0,
    paidCents: 3000,
    reasonCode: 'provider_failure',
    adminNote: '',
    override: false,
  }), /no refundable value/i, 'zero-value decisions must not terminalize an order as refunded');
  assert.throws(() => refundPolicy.validateRefundDecision({
    calculatedRefundCents: 8000,
    requestedRefundCents: 9000,
    reasonCode: 'other',
    adminNote: '',
    override: true,
  }), error => error.status === 400 && /note/i.test(error.message),
  'an override must be rejected as a controlled client error when it is undocumented');
  assert.throws(() => refundPolicy.validateRefundDecision({
    calculatedRefundCents: 8000,
    requestedRefundCents: 8000,
    reasonCode: 'invented_reason',
    adminNote: 'No',
    override: false,
  }), /reason/i, 'refund reasons must come from the server allowlist');

  assert.throws(() => refundPolicy.validateRefundDecision({
    calculatedRefundCents: 8000,
    requestedRefundCents: 8000,
    paidCents: 12000,
    reasonCode: 'provider_failure',
    adminNote: '',
    override: false,
    requiresEvidenceOverride: true,
  }), error => error.status === 400 && /incomplete evidence/i.test(error.message),
  'an ordinary prorated refund must fail closed when payment or consumption evidence is incomplete');
  assert.deepStrictEqual(refundPolicy.validateRefundDecision({
    calculatedRefundCents: 8000,
    requestedRefundCents: 8000,
    paidCents: 12000,
    reasonCode: 'provider_failure',
    adminNote: 'Legacy evidence reviewed manually',
    override: true,
    requiresEvidenceOverride: true,
  }), { overrideApplied: true, adminNote: 'Legacy evidence reviewed manually' },
  'an administrator may explicitly document an incomplete-evidence override');

  const roundedJsonAmount = JSON.parse('{"approved_amount":90071992547409.93}').approved_amount;
  let serviceDbTouched = false;
  await assert.rejects(
    () => require('../services/shopFileService').processRefund(new Proxy({}, {
      get() {
        serviceDbTouched = true;
        throw new Error('database touched');
      },
    }), 70, 1, {
      approvedByUserId: 6,
      reasonCode: 'provider_failure',
      adminNote: '',
      approvedAmount: roundedJsonAmount,
      override: false,
    }),
    error => error.status === 400 && /decimal text/i.test(error.message),
    'refund service must reject Number-rounded monetary input before touching the database'
  );
  assert.strictEqual(serviceDbTouched, false);

  if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);
  const shopRouter = require('../routes/shop');
  const refundLayer = shopRouter.stack.find(layer =>
    layer.route?.path === '/admin/orders/:orderId/refund' && layer.route.methods.post);
  assert(refundLayer, 'admin refund route must exist');
  const refundHandler = refundLayer.route.stack.at(-1).handle;
  let routeDbTouched = false;
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await refundHandler({
    app: { locals: { db: new Proxy({}, {
      get() {
        routeDbTouched = true;
        throw new Error('database touched');
      },
    }) } },
    params: { orderId: '70' },
    body: { reason_code: 'provider_failure', approved_amount: roundedJsonAmount },
    user: { id: 6 },
  }, response);
  assert.strictEqual(response.statusCode, 400,
    'refund route must reject a JSON numeric monetary token');
  assert.match(response.body?.error || '', /decimal text/i);
  assert.strictEqual(routeDbTouched, false,
    'invalid numeric monetary input must fail before transactional reads or writes');

  const migration = read('db/migrations/084_shop_rental_refund_evidence.js');
  for (const table of [
    'shop_order_payment_allocations',
    'shop_rental_consumption_events',
    'shop_refund_decisions',
  ]) {
    assert(migration.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `${table} must be durable`);
  }
  assert.match(migration, /restart_log_id[\s\S]*REFERENCES server_restart_log/,
    'rental consumption must link to authoritative restart evidence');
  assert.match(migration, /UNIQUE\s*\(order_item_id, restart_log_id\)/,
    'one restart may consume a rental line only once');
  assert.match(migration, /BEFORE TRUNCATE ON shop_order_payment_allocations/,
    'payment evidence must reject direct truncation');
  assert.match(migration, /FOREIGN KEY \(order_id, server_id, identity_id\)/,
    'financial evidence must be database-bound to one exact order scope');
  assert.match(migration, /FOREIGN KEY \(restart_log_id, server_id\)/,
    'consumption evidence must bind its restart to the same exact server');
  assert.match(migration,
    /validate_shop_rental_consumption_event[\s\S]*restart_type = 'scheduled'/,
    'consumption evidence must reject crash and owner-triggered restart records');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS shop_order_id INTEGER/,
    'shop ledger rows must carry their exact order identity');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS refund_claim_id BIGINT/,
    'deferred payout ledger rows must carry their exact BIGINT claim identity');
  assert.match(migration,
    /FOREIGN KEY \(refund_claim_id, server_id, identity_id, amount\)[\s\S]*REFERENCES financial_refund_claims\(id, server_id, identity_id, amount\)/,
    'deferred payout ledgers must be database-bound to the exact claim scope and amount');
  assert.match(migration,
    /source <> 'deferred_refund_claim' AND refund_claim_id IS NULL[\s\S]*source = 'deferred_refund_claim'[\s\S]*refund_claim_id IS NOT NULL/,
    'new deferred payout ledger rows must not omit their claim identity');
  assert.match(migration,
    /validate_shop_order_payment_allocation[\s\S]*et\.shop_order_id = NEW\.order_id/,
    'payment allocation evidence must bind its debit to the exact order');
  assert.match(migration, /economy_transaction_id INTEGER[\s\S]*refund_claim_id BIGINT/,
    'credited decisions must retain their exact ledger credit while deferred decisions retain their claim');
  assert.match(migration,
    /validate_shop_refund_credit_link[\s\S]*et\.shop_order_id = NEW\.order_id[\s\S]*transaction_type = 'credit'[\s\S]*source = 'shop_refund'/,
    'credited refund evidence must validate the exact refund ledger transaction');
  assert.match(migration,
    /validate_shop_rental_consumption_event[\s\S]*restart_type = 'scheduled'[\s\S]*srl\.detected_at >= so\.checked_out_at[\s\S]*soi\.restarts_remaining = NEW\.previous_restarts_remaining[\s\S]*FOR UPDATE OF soi/,
    'consumption evidence must lock and match the current rental counter for a post-checkout scheduled restart');
  assert.match(migration,
    /validate_shop_rental_counter_update[\s\S]*shop_rental_consumption_events[\s\S]*previous_restarts_remaining = OLD\.restarts_remaining[\s\S]*resulting_restarts_remaining = NEW\.restarts_remaining/,
    'a completed rental counter decrement must require its matching durable consumption event');
  assert.match(migration,
    /protect_consumed_restart_evidence[\s\S]*shop_rental_consumption_events[\s\S]*OLD\.id[\s\S]*RAISE EXCEPTION/,
    'restart evidence must become immutable once a rental consumption event references it');
  assert.match(migration, /FOREIGN KEY \(economy_transaction_id, server_id, identity_id, account_type\)/,
    'payment evidence must bind its transaction to the same account and exact resource');
  assert.match(migration, /validate_shop_order_payment_allocation[\s\S]*transaction_type = 'debit'[\s\S]*source = 'shop_purchase'[\s\S]*et\.amount = -NEW\.amount/,
    'payment allocation evidence must validate the linked debit source and exact amount');
  assert.match(migration, /validate_shop_refund_claim_link[\s\S]*source_type = 'shop_order_refund'[\s\S]*source_key = NEW\.order_id::text/,
    'deferred refund evidence must validate the claim source order');
  assert.match(migration, /refund_claim_id BIGINT/,
    'refund claim evidence must preserve the BIGINT claim identity domain');
  assert.match(migration, /FOREIGN KEY \(refund_claim_id, server_id, identity_id, approved_amount\)/,
    'deferred refund evidence must bind the exact claim scope and amount');
  assert.match(migration, /payment_status = 'credited' AND refund_claim_id IS NULL[\s\S]*payment_status = 'deferred' AND refund_claim_id IS NOT NULL/,
    'refund payout status and claim linkage must remain consistent');
  assert.doesNotMatch(migration, /NUMERIC\(15,\s*2\)/,
    'financial evidence must not narrow the canonical NUMERIC(20,2) money domain');
  assert.match(migration, /amount NUMERIC\(20,2\)/,
    'payment allocation evidence must preserve the canonical money domain');
  assert.match(migration, /calculated_amount NUMERIC\(20,2\)[\s\S]*approved_amount NUMERIC\(20,2\)[\s\S]*paid_amount NUMERIC\(20,2\)/,
    'refund evidence must preserve the canonical money domain');
  assert.match(migration, /approved_by_user_id/);
  assert.match(migration, /calculated_amount/);
  assert.match(migration, /approved_amount/);
  assert.match(migration, /policy_snapshot/);

  const route = read('routes/shop.js');
  assert.match(route, /reason_code/);
  assert.match(route, /admin_note/);
  assert.match(route, /approved_amount/);
  assert.match(route, /payment_allocations/);
  assert.match(route, /consumption_events/);
  assert.match(route, /refund_decisions/);
  assert.strictEqual(
    (route.match(/CASE WHEN srd\.payment_status = 'deferred'\s+THEN COALESCE\(frc\.status, 'pending'\)/g) || []).length,
    2,
    'admin and player refund reads must both project current deferred-claim status'
  );
  assert.match(route,
    /CASE WHEN srd\.payment_status = 'deferred'[\s\S]*frc\.claimed_at[\s\S]*payment_status_at/,
    'refund reads must timestamp a claimed payout with the claim lifecycle time');
  assert.match(route,
    /WHERE so\.server_id = \?[\s\S]*AND so\.status = 'completed'[\s\S]*AND soi\.restarts_remaining > 0/,
    'admin active rentals must exclude unpaid carts and exhausted lines');
  assert.match(route,
    /WHERE so\.identity_id = \? AND so\.server_id = \?[\s\S]*AND so\.status = 'completed'[\s\S]*AND soi\.restarts_remaining > 0/,
    'player active rentals must exclude exhausted lines');

  const restartService = read('services/shopRestartService.js');
  assert.match(restartService, /INSERT INTO shop_rental_consumption_events/,
    'each counted restart must create immutable per-rental evidence');
  assert.match(restartService,
    /INSERT INTO shop_rental_consumption_events[\s\S]*ON CONFLICT \(order_item_id, restart_log_id\) DO NOTHING[\s\S]*RETURNING id[\s\S]*if \(!consumption\) continue;[\s\S]*UPDATE shop_order_items/,
    'a rental counter must change only after uniquely claiming its restart-consumption event');

  let remainingRestarts = 3;
  const claimedRestartIds = new Set();
  const replayDb = {
    async all(sql) {
      if (sql.includes('SELECT soi.id, soi.order_id, soi.restarts_remaining')) {
        return [{ id: 41, order_id: 17, restarts_remaining: remainingRestarts }];
      }
      if (sql.includes('SELECT soi.id') && sql.includes('restarts_remaining <= 0')) return [];
      throw new Error(`Unexpected replay all query: ${sql}`);
    },
    async get(sql, params) {
      if (!sql.includes('INSERT INTO shop_rental_consumption_events')) {
        throw new Error(`Unexpected replay get query: ${sql}`);
      }
      const restartLogId = params[3];
      if (claimedRestartIds.has(restartLogId)) return null;
      claimedRestartIds.add(restartLogId);
      return { id: claimedRestartIds.size };
    },
    async run(sql, params) {
      if (sql.includes('UPDATE shop_order_items SET restarts_remaining')) {
        remainingRestarts = params[0];
        return { changes: 1 };
      }
      if (sql.includes('INSERT INTO shop_rental_consumption_events')) {
        const restartLogId = params[3];
        const duplicate = claimedRestartIds.has(restartLogId);
        claimedRestartIds.add(restartLogId);
        return { changes: duplicate ? 0 : 1 };
      }
      throw new Error(`Unexpected replay run query: ${sql}`);
    },
  };
  await require('../services/shopRestartService').decrementRentalCounts(
    replayDb, 9, '2026-09-06T12:00:00.000Z', 501
  );
  await require('../services/shopRestartService').decrementRentalCounts(
    replayDb, 9, '2026-09-06T12:00:00.000Z', 501
  );
  assert.strictEqual(remainingRestarts, 2,
    'replaying one restart-log event must not consume the same rental line twice');

  const checkoutService = read('services/shopFileService.js');
  assert.match(checkoutService, /INSERT INTO shop_order_payment_allocations/,
    'checkout must preserve the authoritative wallet and bank split');
  assert.match(checkoutService,
    /INSERT INTO economy_transactions \(identity_id, server_id, transaction_type, amount, balance_after, account_type, source, shop_order_id, timestamp\)/,
    'shop debits and immediate refund credits must carry their exact order ID');
  assert.match(checkoutService,
    /FROM shop_order_payment_allocations[\s\S]*FROM shop_rental_consumption_events/,
    'refund decisions must read payment allocation and restart-consumption evidence');
  assert.match(checkoutService, /requiresEvidenceOverride/,
    'incomplete payment or usage evidence must require an explicit documented override');

  const fulfillmentService = read('services/shopFulfillmentStatusService.js');
  assert.match(fulfillmentService,
    /observedAt: latest\.observation\.observedAt/,
    'failed, refused, attempted, and successful fulfillment outcomes must expose their evidence time');

  const adminHtml = read('public/dashboard/shop-admin.html');
  const adminJs = read('public/js/shop-admin.js');
  const adminMoneyHelpers = adminJs.slice(
    adminJs.indexOf('function moneyTextFromCents'),
    adminJs.indexOf('function escapeHtml')
  );
  const adminMoneyContext = {};
  vm.runInNewContext(`${adminMoneyHelpers}
    formattedBoundary = formatPrice('90071992547409.93');
    parsedBoundary = refundAmountCents('90071992547409.93').toString();
    normalizedBoundary = normalizeRefundAmountText('90071992547409.93');`, adminMoneyContext);
  assert.strictEqual(adminMoneyContext.formattedBoundary, '90,071,992,547,409.93',
    'admin money rendering must preserve every cent beyond Number.MAX_SAFE_INTEGER');
  assert.strictEqual(adminMoneyContext.parsedBoundary, '9007199254740993',
    'admin refund parsing must accept the NUMERIC(20,2) boundary exactly');
  assert.strictEqual(adminMoneyContext.normalizedBoundary, '90071992547409.93',
    'admin refund submission must preserve the exact decimal boundary');
  const adminRoutes = read('routes/admin.js');
  for (const table of [
    'shop_order_payment_allocations',
    'shop_rental_consumption_events',
    'shop_refund_decisions',
  ]) {
    assert(adminRoutes.includes(`'${table}'`), `${table} must survive administrative reset paths`);
  }
  for (const label of ['Purchased', 'Consumed', 'Remaining', 'Paid', 'Checkout', 'Evidence']) {
    assert(adminHtml.includes(label), `admin rental view must show ${label}`);
  }
  assert.match(adminJs, /calculated_refund/);
  assert.match(adminJs, /reason_code/);
  assert.match(adminJs, /admin_note/);
  assert.match(adminJs, /payload\.data\?\.deferred[\s\S]*Payment is pending/,
    'admin refund outcome must read the deferred flag from the API response envelope');
  assert.doesNotMatch(adminJs, /approvedAmount\s*=\s*Number\(approvedAmountText\)/,
    'admin refund input must not silently round or normalize invalid decimal text');
  assert.match(adminJs, /normalizeRefundAmountText\(approvedAmountText\)/,
    'admin refund input must preserve a canonical exact-cent string');

  let resolveRefundBody;
  const refundBody = new Promise(resolve => { resolveRefundBody = resolve; });
  const refundAlerts = [];
  let staleOrderReloads = 0;
  let staleRentalReloads = 0;
  const adminRaceContext = vm.createContext({
    console,
    document: { addEventListener() {} },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        data: [{
          id: 1,
          item_type: 'one_time',
          item_name: 'Test item',
          unit_price: '10.00',
          quantity: 1,
          is_active: true,
        }],
        payment_allocations: [{ account_type: 'wallet', amount: '10.00' }],
      }),
    }),
    fetchWithCsrf: async () => ({ ok: true, json: () => refundBody }),
    prompt: (_message, defaultValue) => defaultValue,
    confirm: () => true,
    alert: message => refundAlerts.push(message),
    staleOrderReloads,
    staleRentalReloads,
  });
  vm.runInContext(`${adminJs}\n
    currentServerId = '1';
    adminContextGeneration = 1;
    loadOrders = () => { staleOrderReloads++; };
    loadRentals = () => { staleRentalReloads++; };
    refundRacePromise = refundOrder(70);`, adminRaceContext);
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext("adminContextGeneration++; currentServerId = '2';", adminRaceContext);
  resolveRefundBody({ data: { deferred: false } });
  await adminRaceContext.refundRacePromise;
  staleOrderReloads = vm.runInContext('staleOrderReloads', adminRaceContext);
  staleRentalReloads = vm.runInContext('staleRentalReloads', adminRaceContext);
  assert.deepStrictEqual(refundAlerts, [],
    'a refund response body resolved after a server switch must not display a stale outcome');
  assert.strictEqual(staleOrderReloads, 0,
    'a refund response body resolved after a server switch must not reload orders in the new context');
  assert.strictEqual(staleRentalReloads, 0,
    'a refund response body resolved after a server switch must not reload rentals in the new context');

  assert.match(adminJs,
    /latestEvidenceTimestamp\([\s\S]*consumption_events[\s\S]*event\.consumed_at/,
    'admin order details must compare fulfillment and restart-consumption timestamps');
  assert.match(adminJs,
    /latestEvidenceTimestamp\(r\.fulfillment\?\.confirmedAt, r\.fulfillment\?\.observedAt, r\.last_consumed_at\)/,
    'admin active rentals must include the latest failed, refused, or attempted fulfillment observation');
  assert.doesNotMatch(adminJs,
    /calculatedRefund\.toFixed|Number\(item\.unit_price/,
    'admin refund calculation must not round exact decimal values through Number');
  assert.doesNotMatch(adminJs, /new Date\(r\.created_at\)/,
    'rental start must not use a nonexistent created_at field');

  const playerHtml = read('public/shop.html');
  const playerJs = read('public/js/shop.js');
  const playerMoneyHelper = playerJs.slice(
    playerJs.indexOf('function moneyAmountCents'),
    playerJs.indexOf('function latestEvidenceTimestamp')
  );
  const playerMoneyContext = {};
  vm.runInNewContext(`${playerMoneyHelper}
    formattedBoundary = formatPrice('90071992547409.93');`, playerMoneyContext);
  assert.strictEqual(playerMoneyContext.formattedBoundary, '90,071,992,547,409.93',
    'player money rendering must preserve every cent beyond Number.MAX_SAFE_INTEGER');
  assert.match(playerJs,
    /latestEvidenceTimestamp\(r\.fulfillment\?\.confirmedAt, r\.fulfillment\?\.observedAt, r\.last_consumed_at\)/,
    'player active rentals must include the latest failed, refused, or attempted fulfillment observation');
  assert.match(playerJs,
    /latestEvidenceTimestamp\([\s\S]*consumption_events[\s\S]*event\.consumed_at/,
    'player order details must compare fulfillment and restart-consumption timestamps');
  assert.match(route,
    /evidence_history_available:\s*!isRental\s*\|\|[\s\S]*consumption_events/,
    'player order items must expose whether their rental consumption history is complete');
  assert.match(playerJs,
    /evidence_history_available[\s\S]*Legacy\/incomplete restart history/,
    'player order history must label incomplete rental evidence rather than presenting inferred counters as complete');
  assert.match(playerHtml, /scheduled restart/i,
    'rental terms must be visible before ordering');
  for (const field of [
    'purchased_restarts', 'consumed_restarts', 'restarts_remaining',
    'checked_out_at', 'refund_status', 'payment_allocations',
  ]) {
    assert(playerJs.includes(field), `player rental history must render ${field}`);
  }

  console.log('Shop rental refund evidence tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
