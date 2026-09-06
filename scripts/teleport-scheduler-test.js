'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const schedulerSource = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
assert.match(schedulerSource, /processWaitingTeleports/);
assert.match(schedulerSource, /processTeleportCleanups/);
assert.match(schedulerSource, /processTeleportRestarts/);
assert.match(schedulerSource, /processExpiredTeleports/);
assert.match(schedulerSource, /async function checkTeleportQueue\(\)/);
assert.match(schedulerSource, /status IN \('waiting_disconnect', 'provisioning', 'armed', 'cleanup_pending', 'cleanup_processing', 'cleanup_restart_pending'\)/);
assert.match(schedulerSource, /cron\.schedule\('\*\/30 \* \* \* \* \*', checkTeleportQueue\)/);
assert.match(schedulerSource, /teleportQueueRunning/);
assert.match(
  schedulerSource,
  /const expired = await processExpiredTeleports\(db, server\.server_id, \{\s*allowLifecycleExpiry: restartEvidenceReady,?\s*\}\)/,
  'terminal refund replay must continue while evidence-dependent expiry is deferred'
);
assert.ok(
  schedulerSource.indexOf('await markTeleportArrivals(db, server.server_id)') <
    schedulerSource.indexOf('const expired = await processExpiredTeleports'),
  'authoritative arrivals must be claimed before expired armed requests are failed and refunded'
);

console.log('✅ Teleport scheduler tests passed');
