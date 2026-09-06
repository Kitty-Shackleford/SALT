'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { captureProviderSnapshots } = require('../services/shopCheckout/providerSnapshots');
const { createStagedProviderFiles } = require('../services/shopCheckout/stagedProviderFiles');
const { createCheckoutTimer } = require('../services/shopCheckout/telemetry');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(async function run() {
  const paths = Array.from({ length: 6 }, (_, index) => `/mission/file-${index}.json`);
  let active = 0;
  let maxActive = 0;
  const fileService = {
    async downloadFileFromServer(_serverId, filePath) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(35);
      active -= 1;
      return `content:${filePath}`;
    },
  };

  const startedAt = performance.now();
  const snapshots = await captureProviderSnapshots({
    platformServerId: 'provider-1',
    token: 'not-a-real-token',
    filePaths: paths,
    fileService,
    concurrency: 3,
  });
  const elapsedMs = performance.now() - startedAt;

  assert.strictEqual(maxActive, 3, 'snapshot reads should use the configured bounded concurrency');
  assert.deepStrictEqual([...snapshots.keys()], paths, 'snapshot order must remain deterministic');
  assert.deepStrictEqual([...snapshots.values()], paths.map(filePath => `content:${filePath}`));
  assert.ok(elapsedMs < 150, `six 35ms snapshots at concurrency 3 should finish in under 150ms (actual ${elapsedMs.toFixed(1)}ms)`);

  const initialFiles = new Map([
    ['/mission/events.xml', '<events/>'],
    ['/mission/spawns.xml', '<eventposdef/>'],
  ]);
  const staged = createStagedProviderFiles(initialFiles);
  assert.strictEqual(
    await staged.fileService.downloadFileFromServer('provider-1', '/mission/events.xml', 'token'),
    '<events/>'
  );
  await staged.fileService.uploadFileToServer(
    'provider-1', '/mission', 'events.xml', '<events><event name="one"/></events>', 'token'
  );
  await staged.fileService.uploadFileToServer(
    'provider-1', '/mission', 'events.xml', '<events><event name="one"/><event name="two"/></events>', 'token'
  );
  await staged.fileService.uploadFileToServer(
    'provider-1', '/mission', 'spawns.xml', '<eventposdef/>', 'token'
  );
  const flushed = [];
  await staged.flush({
    async uploadFileToServer(_serverId, dirPath, fileName, content) {
      flushed.push({ path: `${dirPath}/${fileName}`, content });
    },
  }, 'provider-1', 'token');
  assert.deepStrictEqual(flushed, [{
    path: '/mission/events.xml',
    content: '<events><event name="one"/><event name="two"/></events>',
  }], 'multiple in-memory edits must produce one provider write per changed path');
  await assert.rejects(
    () => staged.fileService.downloadFileFromServer('provider-1', '/mission/unplanned.xml', 'token'),
    /provider plan/i,
    'staged access must fail closed for paths outside the durable snapshot plan'
  );

  const checkoutSource = fs.readFileSync(
    path.join(__dirname, '../services/shopFileService.js'), 'utf8'
  );
  const processCheckoutSource = checkoutSource.slice(checkoutSource.indexOf('async function processCheckout'));
  assert.match(processCheckoutSource, /ORDER BY si\.id, soi\.id/,
    'cart lines must have a unique deterministic staging order');
  assert.match(processCheckoutSource, /createStagedProviderFiles\(prepared\.snapshots\)/,
    'checkout must compose provider file changes from the durable snapshots');
  assert.match(processCheckoutSource, /stagedProviderFiles\.flush\(fileJournal/,
    'checkout must flush each changed staged provider file through the recovery journal');
  const collisionScanSource = checkoutSource.slice(
    checkoutSource.indexOf('async function assertPurchaseEventNamesAvailable'),
    checkoutSource.indexOf('async function assertSpawnsecondaryReferencesExist')
  );
  assert.match(collisionScanSource, /captureProviderSnapshots\(/,
    'independent registered event-file collision reads must use bounded concurrency');

  await assert.rejects(() => captureProviderSnapshots({
    platformServerId: 'provider-1', token: 'x', filePaths: ['/a', '/a'], fileService,
  }), /unique/i);
  await assert.rejects(() => captureProviderSnapshots({
    platformServerId: 'provider-1', token: 'x', filePaths: new Array(33).fill(0).map((_, i) => `/f${i}`), fileService,
  }), /at most 32/i);

  let clock = 100;
  const recorded = [];
  const timer = createCheckoutTimer({
    now: () => clock,
    record: (name, ms) => recorded.push([name, ms]),
    enabled: true,
  });
  await timer.measure('validation', async () => { clock += 12; });
  timer.measureSync('spawn_generation', () => { clock += 3; });
  clock += 5;
  const timings = timer.finish('success');
  assert.deepStrictEqual(timings, { validation: 12, spawn_generation: 3, total: 20 });
  assert.deepStrictEqual(recorded, [
    ['shop_checkout.validation', 12],
    ['shop_checkout.spawn_generation', 3],
    ['shop_checkout.total.success', 20],
  ]);
  assert.throws(() => timer.measureSync('order:123', () => {}), /stage/i,
    'dynamic timing names must be rejected to avoid metric-cardinality growth');

  clock = 0;
  const checkpointTimer = createCheckoutTimer({ now: () => clock, record: () => {}, enabled: true });
  clock = 4;
  checkpointTimer.checkpoint('validation');
  clock = 11;
  checkpointTimer.checkpoint('provider_preflight');
  assert.deepStrictEqual(checkpointTimer.finish('failed'), {
    validation: 4,
    provider_preflight: 7,
    total: 11,
  });

  console.log(JSON.stringify({
    message: 'Shop checkout snapshot concurrency tests passed',
    syntheticSnapshotMs: Number(elapsedMs.toFixed(1)),
    serialEstimateMs: paths.length * 35,
    concurrency: maxActive,
  }));
})().catch(error => {
  console.error(error);
  process.exit(1);
});
