#!/usr/bin/env node
'use strict';
console.log('Running minimal unit tests...');

// Backup env
const OLD_ENV = Object.assign({}, process.env);
const path = require('path');
const { spawnSync } = require('child_process');

async function testPostgresTransactionIsolation() {
  const PostgreSQLAdapter = require('../db/abstraction/postgres');
  const events = [];
  let nextClientId = 1;

  class FakeClient {
    constructor() {
      this.id = nextClientId++;
    }

    async query(sql) {
      events.push({ clientId: this.id, sql });
      return { rows: [], rowCount: 0 };
    }

    release() {}
  }

  const db = new PostgreSQLAdapter();
  db.pool = { connect: async () => new FakeClient() };
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  await Promise.all([
    db.transaction(async () => {
      await pause(20);
      await db.run('UPDATE test_table SET value = ?', [1]);
    }),
    (async () => {
      await pause(5);
      await db.query('SELECT outside_transaction');
    })()
  ]);

  const transactionUpdate = events.find(event => event.sql === 'UPDATE test_table SET value = $1');
  const outsideQuery = events.find(event => event.sql === 'SELECT outside_transaction');

  if (!transactionUpdate || !outsideQuery || transactionUpdate.clientId === outsideQuery.clientId) {
    throw new Error('Concurrent query shared a transaction client');
  }
}

async function testPostgresTransactionRollbackHooksResolveCommitOutcome() {
  const PostgreSQLAdapter = require('../db/abstraction/postgres');
  const run = async outcome => {
    const events = [];
    class FakeClient {
      async query(sql) {
        events.push(sql);
        if (sql.includes('pg_current_xact_id')) return { rows: [{ xid: '123' }] };
        if (sql.includes('pg_xact_status')) {
          return { rows: [{ status: outcome === false ? 'aborted' : 'unknown' }] };
        }
        if (sql === 'COMMIT') throw new Error('commit failed');
        return { rows: [], rowCount: 0 };
      }
      release() {}
    }
    const db = new PostgreSQLAdapter();
    db.pool = { connect: async () => new FakeClient() };
    try {
      await db.transaction(async transactionDb => {
        transactionDb.onTransactionRollback(
          async () => events.push('REMOTE_ROLLBACK'),
          { committed: async () => {
            events.push('VERIFY_COMMIT');
            if (outcome instanceof Error) throw outcome;
            return outcome;
          } }
        );
      });
    } catch (error) {
      events.push('REJECT:' + error.message);
    }
    return events;
  };

  const committed = await run(true);
  if (committed.includes('REMOTE_ROLLBACK')) {
    throw new Error('Ambiguous COMMIT reversed an operation proven committed');
  }
  const rolledBack = await run(false);
  if (!rolledBack.includes('REMOTE_ROLLBACK')) {
    throw new Error('Operation proven rolled back was not compensated');
  }
  const unknown = await run(new Error('database unavailable'));
  if (unknown.includes('REMOTE_ROLLBACK')) {
    throw new Error('Unknown COMMIT outcome triggered unsafe compensation');
  }
}

async function testPostgresMutableVerifierCannotOverrideCommittedXact() {
  const PostgreSQLAdapter = require('../db/abstraction/postgres');
  const events = [];
  const original = {
    async query(sql) {
      if (sql.includes('pg_current_xact_id')) return { rows: [{ xid: '321' }] };
      if (sql === 'COMMIT') throw new Error('lost commit acknowledgement');
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const recovery = {
    async query(sql) {
      events.push(sql);
      if (sql.includes('durable_marker')) return { rows: [{ committed: false }] };
      if (sql.includes('pg_xact_status')) return { rows: [{ status: 'committed' }] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  let connection = 0;
  let compensated = false;
  const db = new PostgreSQLAdapter();
  db.pool = { connect: async () => (++connection === 1 ? original : recovery) };
  try {
    await db.transaction(async transactionDb => {
      transactionDb.onTransactionRollback(
        async () => { compensated = true; },
        { committed: async query => {
          const result = await query('SELECT durable_marker');
          return result.rows?.[0]?.committed === true;
        } }
      );
    });
  } catch (_) {
    // The lost acknowledgement remains the caller-visible result.
  }
  if (compensated) {
    throw new Error('Mutable false verifier overrode authoritative committed transaction status');
  }
  if (!events.some(sql => sql.includes('pg_xact_status'))) {
    throw new Error('False durable marker did not fall back to authoritative transaction status');
  }
}

async function testPostgresCommitRecoveryHandsOffLocksBeforeRecovery() {
  const PostgreSQLAdapter = require('../db/abstraction/postgres');
  const events = [];
  let originalDestroyed = false;
  const original = {
    async query(sql) {
      events.push('original:' + sql);
      if (sql.includes('pg_current_xact_id')) return { rows: [{ xid: '123' }] };
      if (sql === 'COMMIT') throw new Error('lost commit acknowledgement');
      if (sql.includes("status = 'completed'")) return { rows: [{ committed: true }] };
      return { rows: [], rowCount: 0 };
    },
    release(error) {
      events.push('original:release:' + Boolean(error));
      originalDestroyed = Boolean(error);
    },
  };
  const recovery = {
    async query(sql) {
      events.push('recovery:' + sql);
      if (sql.includes('pg_advisory_lock') && !originalDestroyed) {
        throw new Error('recovery attempted lock before destroying original client');
      }
      if (sql.includes("status = 'completed'")) return { rows: [{ committed: false }] };
      if (sql.includes('pg_xact_status')) return { rows: [{ status: 'aborted' }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      return { rows: [], rowCount: 0 };
    },
    release(error) { events.push('recovery:release:' + Boolean(error)); },
  };
  let connection = 0;
  const db = new PostgreSQLAdapter();
  db.pool = { connect: async () => (++connection === 1 ? original : recovery) };
  let compensated = false;
  try {
    await db.transaction(async transactionDb => {
      await transactionDb.acquireTransactionAdvisoryLock(7, 9);
      transactionDb.onTransactionRollback(
        async () => { compensated = true; },
        { committed: async query => {
          const result = await query("SELECT committed FROM shop_orders WHERE status = 'completed'");
          return result.rows?.[0]?.committed === true;
        } }
      );
    });
  } catch (_) {
    // The original COMMIT error remains the transaction result.
  }
  if (!compensated) throw new Error('Aborted ambiguous transaction was not compensated');
  if (!originalDestroyed) throw new Error('Broken original client was returned to the pool');
  const destroyIndex = events.indexOf('original:release:true');
  const recoveryLockIndex = events.findIndex(event => event.includes('recovery:SELECT pg_advisory_lock'));
  if (destroyIndex === -1 || recoveryLockIndex === -1 || destroyIndex > recoveryLockIndex) {
    throw new Error('Recovery lock acquisition preceded original-session destruction');
  }
}

async function testPostgresDestroysClientAfterUnlockFailure() {
  const PostgreSQLAdapter = require('../db/abstraction/postgres');
  let releaseError = null;
  const client = {
    async query(sql) {
      if (sql.includes('pg_current_xact_id')) return { rows: [{ xid: '456' }] };
      if (sql.includes('pg_advisory_unlock')) throw new Error('unlock failed');
      return { rows: [], rowCount: 0 };
    },
    release(error) { releaseError = error; },
  };
  const db = new PostgreSQLAdapter();
  db.pool = { connect: async () => client };
  await db.transaction(async transactionDb => {
    await transactionDb.acquireTransactionAdvisoryLock(7, 10);
  });
  if (!releaseError) throw new Error('Client with unconfirmed advisory unlock was returned to the pool');
}

async function testPostgresDestroysClientAfterAmbiguousLockAcquisition() {
  const PostgreSQLAdapter = require('../db/abstraction/postgres');
  let releaseError = null;
  const client = {
    async query(sql) {
      if (sql.includes('pg_current_xact_id')) return { rows: [{ xid: '789' }] };
      if (sql.includes('pg_advisory_lock')) throw new Error('lost lock acknowledgement');
      return { rows: [], rowCount: 0 };
    },
    release(error) { releaseError = error; },
  };
  const db = new PostgreSQLAdapter();
  db.pool = { connect: async () => client };
  try {
    await db.transaction(tx => tx.acquireTransactionAdvisoryLock(7, 11));
  } catch (_) {
    // Expected acquisition failure.
  }
  if (!releaseError) throw new Error('Client with ambiguous advisory-lock ownership was returned to the pool');
}

async function testPostgresAdvisoryLockAcquisitionIsBounded() {
  const PostgreSQLAdapter = require('../db/abstraction/postgres');
  const run = async lockError => {
    const queries = [];
    let releaseCalled = false;
    let releaseError = null;
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (sql.includes('pg_current_xact_id')) return { rows: [{ xid: '901' }] };
        if (sql.includes('pg_advisory_lock') && lockError) throw lockError;
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
        return { rows: [], rowCount: 0 };
      },
      release(error) {
        releaseCalled = true;
        releaseError = error || null;
      },
    };
    const db = new PostgreSQLAdapter({ advisoryLockTimeoutMs: 75 });
    db.pool = { connect: async () => client };
    let error = null;
    try {
      await db.transaction(async transactionDb => {
        await transactionDb.acquireTransactionAdvisoryLock(7, 12);
        await transactionDb.acquireTransactionAdvisoryLock(7, 12);
      });
    } catch (caught) {
      error = caught;
    }
    return { queries, releaseCalled, releaseError, error };
  };

  const success = await run(null);
  const timeoutConfigIndex = success.queries.findIndex(entry => entry.sql.includes("set_config('lock_timeout'"));
  const lockIndex = success.queries.findIndex(entry => entry.sql.includes('pg_advisory_lock'));
  if (success.error || timeoutConfigIndex === -1 || lockIndex <= timeoutConfigIndex) {
    throw new Error('Advisory lock timeout was not configured before acquisition');
  }
  if (success.queries[timeoutConfigIndex].params?.[0] !== '75ms') {
    throw new Error('Configured advisory lock timeout was not used');
  }
  if (success.queries.filter(entry => entry.sql.includes('pg_advisory_lock')).length !== 1 || !success.releaseCalled || success.releaseError) {
    throw new Error('Successful advisory lock acquisition or cleanup was incorrect');
  }

  const contention = new Error('canceling statement due to lock timeout');
  contention.code = '55P03';
  const timedOut = await run(contention);
  if (!timedOut.error || timedOut.error.code !== '55P03' || !timedOut.releaseCalled || !timedOut.releaseError) {
    throw new Error('Advisory lock contention did not time out and destroy the unsafe client');
  }
  if (timedOut.queries.some(entry => entry.sql.includes('pg_advisory_unlock'))) {
    throw new Error('Cleanup attempted to unlock an advisory lock that was not acquired');
  }

  const failed = await run(new Error('database lock query failed'));
  if (!failed.error || !failed.releaseError) {
    throw new Error('Advisory lock acquisition error did not clean up the client');
  }
}

async function testShopFileMutationsFailClosedOnMalformedContent() {
  const shop = require('../services/shopFileService');
  const malformed = {
    downloadFileFromServer: async () => '{not valid',
    uploadFileToServer: async () => { throw new Error('malformed content must not be overwritten'); },
  };
  const unsupported = {
    downloadFileFromServer: async () => '{"unexpected":true}',
    uploadFileToServer: async () => { throw new Error('unsupported content must not be overwritten'); },
  };
  const missing = {
    downloadFileFromServer: async () => null,
    uploadFileToServer: async () => { throw new Error('missing required file must not be skipped'); },
  };
  const cases = [
    () => shop.appendEffectAreaEntries('1', 'token', '/mission', [{}], malformed),
    () => shop.appendCustomJsonEntries('1', 'token', '/mission/custom.json', [{}], unsupported),
    () => shop.ensureCfgEconomyCoreShopEntry('1', 'token', '/mission', missing),
    () => shop.ensureCfgEconomyCoreShopEntry('1', 'token', '/mission', malformed),
    () => shop.ensureShopEventDefinition('1', 'token', '/mission', 'Event', 'Class', {}, {}, malformed),
    () => shop.addEventSpawnPosition('1', 'token', '/mission', 'Event', 1, 2, 3, 4, malformed),
    () => shop.removeShopEventDefinition('1', 'token', '/mission', 'Event', malformed),
    () => shop.removeEventSpawnPositions('1', 'token', '/mission', ['{"event":"Event","x":1,"z":2,"a":3,"y":4}'], malformed),
  ];
  for (const operation of cases) {
    let rejected = false;
    try {
      await operation();
    } catch (_) {
      rejected = true;
    }
    if (!rejected) throw new Error('Malformed or unsupported shop file content did not fail closed');
  }

  let missingEffectAreaUploadAttempted = false;
  let missingEffectAreaError = null;
  try {
    await shop.appendEffectAreaEntries('1', 'token', '/mission', [{}], {
      downloadFileFromServer: async () => null,
      uploadFileToServer: async () => { missingEffectAreaUploadAttempted = true; },
    });
  } catch (error) {
    missingEffectAreaError = error;
  }
  if (!missingEffectAreaError || !/not found/i.test(missingEffectAreaError.message) || missingEffectAreaUploadAttempted) {
    throw new Error('Missing cfgEffectArea.json did not fail before overriding packaged effect areas');
  }
}

function testShopSpawnEntriesPreserveDayzXyzCoordinateOrder() {
  const shop = require('../services/shopFileService');
  const placement = {
    itemClass: 'Flag_APA',
    entryId: 'DAYZ_DASHBOARD_SHOP_test',
    posX: 4169.9641,
    posY: 0,
    posZ: 10728.7067,
    yaw: 45,
    pitch: 5,
    roll: -5,
  };

  const effectArea = shop.buildEffectAreaEntry(placement);
  if (JSON.stringify(effectArea.Data.Pos) !== JSON.stringify([4169.9641, 0, 10728.7067])) {
    throw new Error('cfgEffectArea placement does not preserve [X, Y, Z], including ground-clipping Y=0');
  }

  const objectSpawner = shop.buildObjectSpawnerEntry(placement);
  if (JSON.stringify(objectSpawner.pos) !== JSON.stringify([4169.9641, 0, 10728.7067])) {
    throw new Error('Object-spawner placement does not preserve [X, Y, Z]');
  }
  if (JSON.stringify(objectSpawner.ypr) !== JSON.stringify([45, 5, -5])) {
    throw new Error('Object-spawner placement does not preserve yaw, pitch, and roll');
  }

  const eventPosition = shop.buildEventSpawnPosition(placement);
  if (JSON.stringify(eventPosition) !== JSON.stringify({ x: 4169.9641, z: 10728.7067, a: 45 })) {
    throw new Error('CE event placement does not omit zero elevation for ground snapping');
  }
}

async function testShopAppendsStandardObjectSpawnerJson() {
  const shop = require('../services/shopFileService');
  let uploaded = null;
  const fileService = {
    downloadFileFromServer: async () => JSON.stringify({
      Objects: [{ name: 'Existing', pos: [1, 2, 3], ypr: [0, 0, 0], scale: 1, enableCEPersistency: 0 }],
      Metadata: { owner: 'server' },
    }),
    uploadFileToServer: async (_serverId, _dir, _name, content) => { uploaded = content; },
  };
  const added = { name: 'AKM', pos: [4, 0, 6], ypr: [0, 0, 0], scale: 1, enableCEPersistency: 0 };

  await shop.appendCustomJsonEntries('1', 'token', '/mission/custom/shop.json', [added], fileService);

  const parsed = JSON.parse(uploaded);
  if (!Array.isArray(parsed.Objects) || parsed.Objects.length !== 2 || parsed.Objects[1].name !== 'AKM') {
    throw new Error('Shop did not append to the standard object-spawner Objects array');
  }
  if (!parsed.Metadata || parsed.Metadata.owner !== 'server') {
    throw new Error('Shop did not preserve unrelated object-spawner root properties');
  }

  const cleaned = JSON.parse(JSON.stringify(parsed));
  const cleanupEntryId = 'DAYZ_DASHBOARD_SHOP_rental-entry';
  cleaned.Objects.push({
    name: 'Rental', pos: [7, 8, 9], ypr: [0, 0, 0], scale: 1,
    _shopEntryId: cleanupEntryId,
  });
  const removed = shop.removeObjectSpawnerEntries(cleaned, new Set([cleanupEntryId]));
  if (removed.Objects.some(entry => entry._shopEntryId === cleanupEntryId) || removed.Metadata.owner !== 'server') {
    throw new Error('Shop cannot safely remove rental entries from standard object-spawner JSON');
  }
}

async function testShopRegistersObjectSpawnerWithoutOverwritingGameplaySettings() {
  const shop = require('../services/shopFileService');
  let uploaded = null;
  const fileService = {
    downloadFileFromServer: async () => JSON.stringify({
      GeneralData: { disableBaseDamage: true },
      WorldsData: { lightingConfig: 1, objectSpawnersArr: ['./custom/existing.json'] },
    }),
    uploadFileToServer: async (_serverId, _dir, _name, content) => { uploaded = content; },
  };

  await shop.ensureObjectSpawnerRegistered('1', 'token', '/mission', 'custom/shop.json', fileService);
  const parsed = JSON.parse(uploaded);
  if (parsed.GeneralData.disableBaseDamage !== true || parsed.WorldsData.lightingConfig !== 1) {
    throw new Error('Object-spawner registration overwrote unrelated cfgGameplay settings');
  }
  if (JSON.stringify(parsed.WorldsData.objectSpawnersArr) !== JSON.stringify([
    './custom/existing.json', './custom/shop.json',
  ])) {
    throw new Error('Object-spawner path was not appended under WorldsData.objectSpawnersArr');
  }
}

function testShopRejectsUnprovisionableCatalogItemsBeforeCheckout() {
  const shop = require('../services/shopFileService');
  for (const item of [
    { spawn_method: 'coords', item_class: 'AKM' },
    { spawn_method: 'preset', item_class: 'AKM' },
    { spawn_method: 'unknown', item_class: 'AKM' },
    { spawn_method: 'cfgEffectArea', item_class: ' Survivor ' },
    { spawn_method: 'custom_json', item_class: 'AKM', custom_json_file: '../outside.json' },
    { spawn_method: 'custom_json', item_class: 'DZ/animals/wolf.p3d', custom_json_file: 'custom/shop.json' },
    { spawn_method: 'event', item_class: 'AKM', event_name: '' },
    { spawn_method: 'event', item_class: 'AKM', event_name: 'HermesShopWeapon' },
    { spawn_method: 'event', item_class: 'AKM', event_name: 'StaticShopAKM', event_config: { active: 2 } },
    { spawn_method: 'event', item_class: 'AKM', event_name: 'StaticShopAKM', event_config: { position: 'near-player' } },
    { spawn_method: 'event', item_class: 'AKM', event_name: 'StaticShopAKM', event_config: { children: [{ type: '', min: 1, max: 1, lootmin: 0, lootmax: 0 }] } },
    { spawn_method: 'event', item_class: 'AKM', event_name: 'StaticShopAKM', event_config: { eventGroupChildren: [{ type: 'AKM', x: 0, y: 0, z: 0, a: 0, spawnsecondary: 'true' }] } },
    { spawn_method: 'event', item_class: 'AKM', event_name: 'StaticShopAKM', event_config: { effectAreaComponents: [{ type: 'Flag_APA', offset: [0, 0] }] } },
    { spawn_method: 'event', item_class: 'AKM', event_name: 'StaticShopAKM', event_config: { effectAreaComponents: [{ type: 'ContaminatedArea_Static', offset: [0, 0, 0], radius: 10 }] } },
    { spawn_method: 'event', item_class: 'AKM', event_name: 'StaticShopAKM', event_config: { objectSpawnerComponents: [{ name: 'AKM', file: '../bad.json', offset: [0, 0, 0] }] } },
    { spawn_method: 'event', item_class: 'AKM', event_name: 'StaticShopAKM', event_config: { objectSpawnerComponents: [{ name: 'AKM', file: 'custom/shop.json', offset: [0, 0, 0] }] } },
    { spawn_method: 'event', item_class: 'Animal_CanisLupus_Grey', event_name: 'AnimalShopWolf', event_config: {} },
    { spawn_method: 'event', item_class: 'AKM', event_name: 'StaticShopAKM', event_config: { children: [{ type: 'Animal_CanisLupus_Grey', min: 1, max: 1, lootmin: 0, lootmax: 0 }] } },
    { spawn_method: 'event', item_class: 'AKM', event_name: 'StaticShopAKM', event_config: { secondary: 'AnimalWolf' } },
    { spawn_method: 'event', item_class: 'AKM', event_name: 'StaticShopAKM', event_config: { eventGroupChildren: [{ type: 'Animal_CanisLupus_Grey', x: 0, y: 0, z: 0, a: 0, spawnsecondary: false }] } },
    { spawn_method: 'event', item_class: 'AKM', event_name: 'StaticShopAKM', event_config: { eventGroupChildren: [{ type: 'InfectedIndustrial', x: 0, y: 0, z: 0, a: 0, spawnsecondary: false }] } },
    { spawn_method: 'event', item_class: 'AKM', event_name: 'StaticShopAKM', event_config: { eventGroupChildren: [{ type: 'AnimalWolf', x: 0, y: 0, z: 0, a: 0, spawnsecondary: true }] } },
    { spawn_method: 'event', item_class: 'AKM', event_name: 'StaticShopAKM', event_config: { eventGroupChildren: [{ type: 'StaticObj_Misc_SupplyBox1_DE', x: 0, y: 0, z: 0, a: 0, spawnsecondary: true }] } },
  ]) {
    let rejected = false;
    try { shop.validateProvisioningItem(item); } catch (_error) { rejected = true; }
    if (!rejected) throw new Error('Unprovisionable shop catalog item was accepted: ' + item.spawn_method);
  }
  shop.validateProvisioningItem({
    spawn_method: 'custom_json',
    item_class: 'Land_Wall_Gate_FenR',
    custom_json_file: 'custom/shop.json',
    object_spawner_config: { scale: 1, enableCEPersistency: false, customString: '' },
  });
  shop.validateProvisioningItem({
    spawn_method: 'event',
    item_class: 'AKM',
    event_name: 'StaticShopAKM',
    event_config: {
      children: [{ type: 'AKM', min: 1, max: 1, lootmin: 0, lootmax: 0 }],
    },
  });
  shop.validateProvisioningItem({
    spawn_method: 'event', item_class: 'AKM', event_name: 'StaticShopSecondary',
    event_config: {
      secondary: 'InfectedIndustrial',
      eventGroupChildren: [{ type: 'StaticObj_Misc_SupplyBox1_DE', x: 0, y: 0, z: 0, a: 0, spawnsecondary: true }],
    },
  });
}

async function testSpawnsecondaryReferencesMustExist() {
  const shop = require('../services/shopFileService');
  const files = {
    '/mission/db/events.xml': '<?xml version="1.0"?><events><event name="InfectedIndustrial"><nominal>1</nominal></event><event name="InfectedGeneric"><nominal>1</nominal></event><event name="StaticConvoy"><secondary>InfectedIndustrial</secondary></event></events>',
    '/mission/custom/shop_events.xml': '<?xml version="1.0"?><events><event name="ShopSecondary"><nominal>1</nominal></event><event name="StaticShopParent"><secondary>ShopSecondary</secondary></event></events>',
  };
  const fileService = {
    downloadFileFromServer: async (_server, filePath) => files[filePath] ?? null,
  };
  await shop.assertSpawnsecondaryReferencesExist(
    '1', 'token', '/mission',
    [{ type: 'InfectedIndustrial', spawnsecondary: true }, { type: 'ShopSecondary', spawnsecondary: true }],
    fileService
  );
  let missingRejected = false;
  try {
    await shop.assertSpawnsecondaryReferencesExist(
      '1', 'token', '/mission', [{ type: 'MissingEvent', spawnsecondary: true }], fileService
    );
  } catch (error) {
    missingRejected = /events\.xml.*MissingEvent|MissingEvent.*events\.xml/i.test(error.message);
  }
  if (!missingRejected) throw new Error('Missing spawnsecondary event reference was accepted');
  let incompatibleRejected = false;
  try {
    await shop.assertSpawnsecondaryReferencesExist(
      '1', 'token', '/mission', [{ type: 'InfectedGeneric', spawnsecondary: true }], fileService
    );
  } catch (error) {
    incompatibleRejected = /secondary-compatible.*InfectedGeneric|InfectedGeneric.*secondary-compatible/i.test(error.message);
  }
  if (!incompatibleRejected) throw new Error('Existing but non-secondary-compatible event reference was accepted');
}

async function testCfgEconomyCoreUsesStructuredRegistrationDetection() {
  const shop = require('../services/shopFileService');
  const { XMLParser, XMLValidator } = require('fast-xml-parser');
  const parser = new XMLParser({ ignoreAttributes: false });
  const run = async raw => {
    const uploads = [];
    const fileService = {
      downloadFileFromServer: async () => raw,
      uploadFileToServer: async (_serverId, _dir, _name, content) => uploads.push(content),
    };
    let error = null;
    try {
      await shop.ensureCfgEconomyCoreShopEntry('1', 'token', '/mission', fileService);
    } catch (caught) {
      error = caught;
    }
    return { uploads, error };
  };

  for (const raw of [
    '<?xml version="1.0"?><economycore><ce folder="custom"><file type="events" name="shop_events.xml"/></ce></economycore>',
    '<economycore>\n  <ce folder = "custom">\n    <file name = "shop_events.xml" type = "events" />\n  </ce>\n</economycore>',
  ]) {
    const registered = await run(raw);
    if (registered.error || registered.uploads.length !== 0) {
      throw new Error('A structured shop_events registration was not recognized');
    }
  }

  for (const raw of [
    '<economycore></economycore>',
    '<economycore><!-- <ce folder="custom"><file name="shop_events.xml" type="events"/></ce> --></economycore>',
    '<economycore><note>custom/shop_events.xml type=events</note></economycore>',
  ]) {
    const absent = await run(raw);
    if (absent.error || absent.uploads.length !== 1) {
      throw new Error('Registration-like comments or text caused a false positive');
    }
    const output = absent.uploads[0];
    if (XMLValidator.validate(output) !== true) throw new Error('Updated cfgeconomycore.xml is invalid XML');
    const parsed = parser.parse(output);
    const ceEntries = Array.isArray(parsed.economycore.ce) ? parsed.economycore.ce : [parsed.economycore.ce];
    const registrations = ceEntries
      .filter(Boolean)
      .flatMap(entry => Array.isArray(entry.file) ? entry.file : [entry.file])
      .filter(file => file && file['@_name'] === 'shop_events.xml' && file['@_type'] === 'events');
    if (registrations.length !== 1) throw new Error('Updated XML does not contain exactly one registration');
  }

  const duplicate = await run('<economycore><ce folder="custom"><file name="shop_events.xml" type="events"/></ce><ce folder="custom"><file name="shop_events.xml" type="events"/></ce></economycore>');
  if (!duplicate.error || duplicate.uploads.length !== 0) {
    throw new Error('Duplicate shop_events registrations were not rejected');
  }

  const malformed = await run('<economycore><ce></economycore>');
  if (!malformed.error || malformed.uploads.length !== 0) {
    throw new Error('Malformed cfgeconomycore.xml was not rejected');
  }
}

async function testEventXmlValidationAndSafeRewriting() {
  const shop = require('../services/shopFileService');
  const { XMLValidator } = require('fast-xml-parser');
  const missing = { downloadFileFromServer: async () => null, uploadFileToServer: async () => {} };
  const rejects = async (operation, message) => {
    let rejected = false;
    try { await operation(); } catch (_) { rejected = true; }
    if (!rejected) throw new Error(message);
  };

  for (const metadata of ['not-json', '{}', '{"event":"E","x":"bad","z":2,"a":3,"y":4}']) {
    let rejected = false;
    try {
      await shop.removeEventSpawnPositions('1', 'token', '/mission', [metadata], missing);
    } catch (_) {
      rejected = true;
    }
    if (!rejected) throw new Error('Missing cfgeventspawns.xml bypassed rental metadata validation');
  }
  await rejects(
    () => shop.removeEventSpawnPositions(
      '1', 'token', '/mission', ['{"event":"E","x":1,"z":2,"a":3,"y":4}'], missing
    ),
    'Missing cfgeventspawns.xml was treated as successful cleanup'
  );
  await rejects(
    () => shop.removeShopEventDefinition('1', 'token', '/mission', 'E', missing),
    'Missing shop_events.xml was treated as successful cleanup'
  );
  await rejects(
    () => shop.removeShopEventGroupDefinition('1', 'token', '/mission', 'E_Group', missing),
    'Missing cfgeventgroups.xml was treated as successful cleanup'
  );

  let cleanupRewrite = null;
  const cleanupSource = '<eventposdef><event name="ZoneOnly"><zone smin="0" smax="0" dmin="0" dmax="0" r="0"/></event><event name="Target"><zone smin="0" smax="0" dmin="0" dmax="0" r="0"/><pos x="1" z="2" a="3" y="4"/></event></eventposdef>';
  await shop.removeEventSpawnPositions(
    '1', 'token', '/mission', ['{"event":"Target","x":1,"z":2,"a":3,"y":4}'], {
      downloadFileFromServer: async () => cleanupSource,
      uploadFileToServer: async (_serverId, _dir, _name, content) => { cleanupRewrite = content; },
    }
  );
  if (!cleanupRewrite?.includes('name="ZoneOnly"') || cleanupRewrite.includes('name="Target"')) {
    throw new Error('Event spawn cleanup removed an unrelated zone-only event');
  }
  await rejects(
    () => shop.removeEventSpawnPositions(
      '1', 'token', '/mission', ['{"event":"Target","x":999,"z":2,"a":3,"y":4}'], {
        downloadFileFromServer: async () => cleanupSource,
        uploadFileToServer: async () => { throw new Error('Unmatched cleanup must not upload'); },
      }
    ),
    'Unmatched event position was treated as successful cleanup'
  );

  const fixture = raw => ({
    downloadFileFromServer: async () => raw,
    uploadFileToServer: async () => { throw new Error('Unsafe XML must not be uploaded'); },
  });
  for (const raw of [
    '',
    '<eventposdef><event></eventposdef>',
    '<wrongroot/>',
    '<eventposdef><event name="E"><pos>not-an-attribute-position</pos></event></eventposdef>',
    '<eventposdef><event name="E"><pos x="" z="2" a="3" y="4"/></event></eventposdef>',
    '<eventposdef><event name="E"><unexpected/></event></eventposdef>',
    '<eventposdef><event><pos x="1" z="2" a="3" y="4"/></event></eventposdef>',
  ]) {
    await rejects(
      () => shop.addEventSpawnPosition('1', 'token', '/mission', 'New', 10, 20, 30, 40, fixture(raw)),
      'Malformed or unsupported nested cfgeventspawns.xml was rewritten'
    );
  }
  await rejects(
    () => shop.addEventSpawnPosition('1', 'token', '/mission', 'New', '', 20, 30, 40, missing),
    'Empty generated event spawn coordinate was accepted'
  );

  const original = '<?xml version="1.0"?><eventposdef><!-- preserve me --><event name="Other"><zone smin="0" smax="0" dmin="0" dmax="0" r="0"/><pos x="1" z="2" a="3" y="4"/></event></eventposdef>';
  let rewritten = null;
  const validFile = {
    downloadFileFromServer: async () => original,
    uploadFileToServer: async (_serverId, _dir, _name, content) => { rewritten = content; },
  };
  await shop.addEventSpawnPosition('1', 'token', '/mission', 'New', 10, 20, 30, 40, validFile);
  if (!rewritten || XMLValidator.validate(rewritten) !== true || !rewritten.includes('preserve me')) {
    throw new Error('Valid cfgeventspawns.xml rewrite did not preserve comments and valid XML');
  }
  if (!rewritten.includes('name="Other"') || !rewritten.includes('name="New"')) {
    throw new Error('Valid unrelated event XML was not preserved');
  }

  let groupedSpawn = null;
  await shop.addEventSpawnPosition('1', 'token', '/mission', 'Grouped', 10, 20, 30, 40, {
    downloadFileFromServer: async () => original,
    uploadFileToServer: async (_serverId, _dir, _name, content) => { groupedSpawn = content; },
  }, { group: 'StaticShop_Group' });
  if (!groupedSpawn || !groupedSpawn.includes('group="StaticShop_Group"')) {
    throw new Error('Event-group spawn position did not preserve its group reference');
  }

  let groupedDefinition = null;
  await shop.ensureShopEventGroupDefinition('1', 'token', '/mission', 'StaticShop_Group', [
    { type: 'Land_Wreck_C130J', x: 0, y: 0, z: 0, a: 0, deloot: 10, lootmin: 4, lootmax: 8 },
    { type: 'AKM', x: 1.5, y: 0.2, z: -2, a: 90, spawnsecondary: false },
  ], {
    downloadFileFromServer: async () => '<?xml version="1.0"?><eventgroupdef><!-- keep --><group name="Existing"><child type="Object" x="0" y="0" z="0" a="0"/></group></eventgroupdef>',
    uploadFileToServer: async (_serverId, _dir, _name, content) => { groupedDefinition = content; },
  });
  if (!groupedDefinition || !groupedDefinition.includes('<!-- keep -->') ||
      !groupedDefinition.includes('name="Existing"') || !groupedDefinition.includes('name="StaticShop_Group"') ||
      !groupedDefinition.includes('type="AKM"') || !groupedDefinition.includes('spawnsecondary="false"')) {
    throw new Error('Shop event-group definition was not appended safely');
  }
  let duplicateGroupUploads = 0;
  await shop.ensureShopEventGroupDefinition('1', 'token', '/mission', 'StaticShop_Group', [
    { type: 'Land_Wreck_C130J', x: 0, y: 0, z: 0, a: 0, deloot: 10, lootmin: 4, lootmax: 8 },
    { type: 'AKM', x: 1.5, y: 0.2, z: -2, a: 90, spawnsecondary: false },
  ], {
    downloadFileFromServer: async () => groupedDefinition,
    uploadFileToServer: async () => { duplicateGroupUploads += 1; },
  });
  if (duplicateGroupUploads !== 0) throw new Error('Matching existing shop event group was rewritten unnecessarily');
  const unmanagedGroupXml = groupedDefinition.replace(/<!--\s*DayZ Shop event group StaticShop_Group\s*-->/, '<!-- manually managed -->');
  await rejects(
    () => shop.ensureShopEventGroupDefinition('1', 'token', '/mission', 'StaticShop_Group', [
      { type: 'Land_Wreck_C130J', x: 0, y: 0, z: 0, a: 0, deloot: 10, lootmin: 4, lootmax: 8 },
      { type: 'AKM', x: 1.5, y: 0.2, z: -2, a: 90, spawnsecondary: false },
    ], { downloadFileFromServer: async () => unmanagedGroupXml, uploadFileToServer: async () => {} }),
    /not owned by the shop/i
  );
  await rejects(
    () => shop.removeShopEventGroupDefinition('1', 'token', '/mission', 'StaticShop_Group', {
      downloadFileFromServer: async () => unmanagedGroupXml,
      uploadFileToServer: async () => {},
    }),
    /not owned by the shop/i
  );
  let groupRemoved = null;
  await shop.removeShopEventGroupDefinition('1', 'token', '/mission', 'StaticShop_Group', {
    downloadFileFromServer: async () => groupedDefinition,
    uploadFileToServer: async (_serverId, _dir, _name, content) => { groupRemoved = content; },
  });
  if (!groupRemoved || groupRemoved.includes('name="StaticShop_Group"') || !groupRemoved.includes('name="Existing"')) {
    throw new Error('Shop event-group cleanup did not remove only the managed group');
  }

  // Keep this representative fixture self-contained: bin/ contains local mission
  // data and is intentionally absent from release/container build contexts.
  const realistic = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<eventposdef>
  <event name="StaticUH1YCrash">
    <zone smin="1" smax="3" dmin="3" dmax="5" r="45" />
    <pos x="558.859619" z="12918.953125" a="-1" />
  </event>
  <event name="StaticSantaCrash">
    <zone smin="1" smax="1" dmin="1" dmax="1" r="45" />
    <pos x="2593.47" z="5094.11" a="0" y="201.66" />
  </event>
  <event name="Loot" />
</eventposdef>`;
  let realisticRewrite = null;
  await shop.addEventSpawnPosition('1', 'token', '/mission', 'HermesValidationProbe', 10, 20, 30, 40, {
    downloadFileFromServer: async () => realistic,
    uploadFileToServer: async (_serverId, _dir, _name, content) => { realisticRewrite = content; },
  });
  if (!realisticRewrite || XMLValidator.validate(realisticRewrite) !== true || !realisticRewrite.includes('HermesValidationProbe')) {
    throw new Error('Realistic DayZ cfgeventspawns.xml could not be safely rewritten');
  }

  const unsupportedEvents = fixture('<events><event name="E"><unexpected/></event></events>');
  await rejects(
    () => shop.ensureShopEventDefinition('1', 'token', '/mission', 'New', 'Class', {}, {}, unsupportedEvents),
    'Unsupported nested shop_events.xml was rewritten'
  );

  const validEvent = '<events><event name="Existing"><nominal>1</nominal><min>0</min><max>1</max><lifetime>1</lifetime><restock>0</restock><saferadius>0</saferadius><distanceradius>0</distanceradius><cleanupradius>0</cleanupradius><flags deletable="1" init_random="0" remove_damaged="0"/><position>fixed</position><limit>child</limit><active>1</active><children><child lootmax="0" lootmin="0" max="1" min="1" type="Class"/></children></event></events>';
  for (const raw of [
    validEvent.replace('<nominal>1</nominal>', '<nominal>abc</nominal>'),
    validEvent.replace('deletable="1"', 'deletable="x"'),
    validEvent.replace('max="1" min="1" type="Class"', 'max="x" min="1" type="Class"'),
    validEvent.replace('type="Class"', 'type=""'),
  ]) {
    await rejects(
      () => shop.ensureShopEventDefinition('1', 'token', '/mission', 'New', 'Class', {}, {}, fixture(raw)),
      'Semantically invalid existing shop_events.xml was rewritten'
    );
  }
  for (const config of [
    { nominal: 'abc' },
    { flags: { deletable: 'x' } },
    { child: { max: 'x' } },
    { limit: 'unsupported' },
  ]) {
    await rejects(
      () => shop.ensureShopEventDefinition('1', 'token', '/mission', 'New', 'Class', config, {}, missing),
      'Semantically invalid event_config generated shop_events.xml'
    );
  }

  let first = null;
  await shop.ensureShopEventDefinition('1', 'token', '/mission', 'First', 'ClassA', {}, { itemName: 'First' }, {
    downloadFileFromServer: async () => null,
    uploadFileToServer: async (_serverId, _dir, _name, content) => { first = content; },
  });
  let second = null;
  await shop.ensureShopEventDefinition('1', 'token', '/mission', 'Second', 'ClassB', {}, { itemName: 'Second' }, {
    downloadFileFromServer: async () => first,
    uploadFileToServer: async (_serverId, _dir, _name, content) => { second = content; },
  });
  if (!second || XMLValidator.validate(second) !== true || !second.includes('"First"') || !second.includes('"Second"')) {
    throw new Error('shop_events.xml rewrite did not preserve existing ownership comments');
  }
  let duplicateEventUploads = 0;
  await shop.ensureShopEventDefinition('1', 'token', '/mission', 'Second', 'ClassB', {}, { itemName: 'Second' }, {
    downloadFileFromServer: async () => second,
    uploadFileToServer: async () => { duplicateEventUploads += 1; },
  });
  if (duplicateEventUploads !== 0) throw new Error('Matching existing shop event was rewritten unnecessarily');
  const unmanagedEventXml = second.replace(/<!--\s*DayZ Shop[^>]*"Second"[^>]*-->/, '<!-- manually managed -->');
  await rejects(
    () => shop.ensureShopEventDefinition('1', 'token', '/mission', 'Second', 'ClassB', {}, { itemName: 'Second' }, {
      downloadFileFromServer: async () => unmanagedEventXml,
      uploadFileToServer: async () => {},
    }),
    /not owned by the shop/i
  );
  await rejects(
    () => shop.removeShopEventDefinition('1', 'token', '/mission', 'Second', {
      downloadFileFromServer: async () => unmanagedEventXml,
      uploadFileToServer: async () => {},
    }),
    /not owned by the shop/i
  );

  let composed = null;
  await shop.ensureShopEventDefinition('1', 'token', '/mission', 'Composed', 'FallbackClass', {
    position: 'uniform',
    active: 0,
    children: [
      { type: 'AKM', min: 1, max: 2, lootmin: 0, lootmax: 0 },
      { type: 'Mag_AKM_30Rnd', min: 2, max: 4, lootmin: 0, lootmax: 0 },
    ],
  }, {}, {
    downloadFileFromServer: async () => null,
    uploadFileToServer: async (_serverId, _dir, _name, content) => { composed = content; },
  });
  if (!composed || !composed.includes('<position>uniform</position>') ||
      !composed.includes('<active>0</active>') ||
      !composed.includes('type="AKM"') || !composed.includes('type="Mag_AKM_30Rnd"')) {
    throw new Error('Composed CE event did not preserve position, active state, and multiple children');
  }

  let groupedEvent = null;
  await shop.ensureShopEventDefinition('1', 'token', '/mission', 'GroupedProduct', 'FallbackClass', {
    eventGroupChildren: [{ type: 'AKM', x: 0, y: 0, z: 0, a: 0 }],
  }, {}, {
    downloadFileFromServer: async () => null,
    uploadFileToServer: async (_serverId, _dir, _name, content) => { groupedEvent = content; },
  });
  if (!groupedEvent || groupedEvent.includes('type="GroupedProduct_Group"') ||
      !/<children(?:\s*\/|>\s*<\/children)>/.test(groupedEvent)) {
    throw new Error('Grouped CE event incorrectly emitted the group name as an entity child');
  }

  let secondaryEvent = null;
  await shop.ensureShopEventDefinition('1', 'token', '/mission', 'SecondaryProduct', 'Object', {
    secondary: 'InfectedIndustrial',
  }, {}, {
    downloadFileFromServer: async () => null,
    uploadFileToServer: async (_serverId, _dir, _name, content) => { secondaryEvent = content; },
  });
  if (!(secondaryEvent.indexOf('<cleanupradius>') < secondaryEvent.indexOf('<secondary>') &&
        secondaryEvent.indexOf('<secondary>') < secondaryEvent.indexOf('<flags '))) {
    throw new Error('CE secondary element was emitted outside canonical element order');
  }

  await rejects(
    () => shop.ensureShopEventDefinition('1', 'token', '/mission', 'Existing', 'DifferentClass', {}, {}, {
      downloadFileFromServer: async () => validEvent,
      uploadFileToServer: async () => { throw new Error('Conflicting event must not be overwritten'); },
    }),
    'A stale existing event definition was accepted for new checkout configuration'
  );

  await rejects(
    () => shop.ensureShopEventGroupDefinition('1', 'token', '/mission', 'Existing', [
      { type: 'DifferentObject', x: 0, y: 0, z: 0, a: 0 },
    ], {
      downloadFileFromServer: async () => '<eventgroupdef><group name="Existing"><child type="Object" x="0" y="0" z="0" a="0"/></group></eventgroupdef>',
      uploadFileToServer: async () => { throw new Error('Conflicting group must not be overwritten'); },
    }),
    'A stale existing event-group definition was accepted for new checkout configuration'
  );
}

async function testExpiredRentalMetadataPreflightPrecedesMutation() {
  const crypto = require('crypto');
  const shop = require('../services/shopFileService');
  const missionFileService = require('../services/missionFileService');
  const originalMission = {
    getActiveMission: missionFileService.getActiveMission,
    downloadFileFromServer: missionFileService.downloadFileFromServer,
    uploadFileToServer: missionFileService.uploadFileToServer,
    deleteFileFromServer: missionFileService.deleteFileFromServer,
  };
  const previousKey = process.env.ENCRYPTION_KEY;
  const key = Buffer.alloc(32, 7);
  const iv = Buffer.alloc(16, 3);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = cipher.update('test-token', 'utf8', 'hex') + cipher.final('hex');
  process.env.ENCRYPTION_KEY = key.toString('hex');
  let uploadAttempts = 0;
  let providerReadAttempts = 0;
  missionFileService.getActiveMission = async () => {
    providerReadAttempts += 1;
    return { mission: 'test.mission', missionPath: '/mission' };
  };
  missionFileService.downloadFileFromServer = async (_serverId, filePath) => {
    providerReadAttempts += 1;
    return filePath.endsWith('cfgEffectArea.json') ? '[{"AreaName":"effect-entry"}]' : null;
  };
  missionFileService.uploadFileToServer = async () => { uploadAttempts += 1; };
  missionFileService.deleteFileFromServer = async () => { uploadAttempts += 1; };
  try {
    for (const eventItem of [
      { file_entry_id: 'not-json', event_name: 'Event' },
      { file_entry_id: null, event_name: 'Event' },
      { file_entry_id: '{"event":"Other","x":1,"z":2,"a":3,"y":4}', event_name: 'Event' },
    ]) {
      const db = {
        acquireTransactionAdvisoryLock: async () => {},
        onTransactionRollback: () => {},
        get: async sql => sql.includes('SELECT gt.token_hash')
          ? { token_hash: `${iv.toString('hex')}:${encrypted}`, platform_server_id: 'service-1' }
          : null,
        query: async sql => sql.includes('FROM shop_order_items soi')
          ? [
            { id: 1, file_entry_id: 'effect-entry', spawn_method: 'cfgEffectArea', custom_json_file: null, event_name: null },
            { id: 2, spawn_method: 'event', custom_json_file: null, ...eventItem },
          ]
          : [],
      };
      let rejected = false;
      try {
        await shop.removeExpiredRentals(db, 1, [1, 2]);
      } catch (_) {
        rejected = true;
      }
      if (!rejected || providerReadAttempts !== 0 || uploadAttempts !== 0) {
        throw new Error('Malformed event rental metadata was rejected only after provider access');
      }
    }

    for (const invalidEntryId of ['DAYZ_DASHBOARD_SHOP_../../unexpected', null]) {
      const malformedEffectAreaDb = {
        acquireTransactionAdvisoryLock: async () => {},
        onTransactionRollback: () => {},
        get: async sql => sql.includes('SELECT gt.token_hash')
          ? { token_hash: `${iv.toString('hex')}:${encrypted}`, platform_server_id: 'service-1' }
          : null,
        query: async sql => sql.includes('FROM shop_order_items soi')
          ? [{
            id: 3,
            file_entry_id: invalidEntryId,
            spawn_method: 'cfgEffectArea',
            custom_json_file: null,
            event_name: null,
          }]
          : [],
      };
      let malformedEffectAreaError = null;
      try {
        await shop.removeExpiredRentals(malformedEffectAreaDb, 1, [3]);
      } catch (error) {
        malformedEffectAreaError = error;
      }
      if (!malformedEffectAreaError ||
          !/invalid cfgEffectArea cleanup metadata/i.test(malformedEffectAreaError.message) ||
          providerReadAttempts !== 0 || uploadAttempts !== 0) {
        throw new Error('Malformed cfgEffectArea rental metadata was not rejected before provider access');
      }
    }

    for (const invalidEntryId of ['DAYZ_DASHBOARD_SHOP_../../unexpected', null]) {
      const malformedCustomJsonDb = {
        acquireTransactionAdvisoryLock: async () => {},
        onTransactionRollback: () => {},
        get: async sql => sql.includes('SELECT gt.token_hash')
          ? { token_hash: `${iv.toString('hex')}:${encrypted}`, platform_server_id: 'service-1' }
          : null,
        query: async sql => sql.includes('FROM shop_order_items soi')
          ? [{
            id: 4,
            file_entry_id: invalidEntryId,
            spawn_method: 'custom_json',
            custom_json_file: 'custom/shop.json',
            event_name: null,
          }]
          : [],
      };
      let malformedCustomJsonError = null;
      try {
        await shop.removeExpiredRentals(malformedCustomJsonDb, 1, [4]);
      } catch (error) {
        malformedCustomJsonError = error;
      }
      if (!malformedCustomJsonError ||
          !/invalid (legacy )?custom JSON cleanup metadata/i.test(malformedCustomJsonError.message) ||
          providerReadAttempts !== 0 || uploadAttempts !== 0) {
        throw new Error('Malformed custom JSON rental metadata was not rejected before provider access');
      }
    }

    for (const duplicateItems of [
      [
        { id: 5, file_entry_id: 'LEGACY_SHOP_duplicate', spawn_method: 'cfgEffectArea', custom_json_file: null, event_name: null },
        { id: 6, file_entry_id: 'LEGACY_SHOP_duplicate', spawn_method: 'cfgEffectArea', custom_json_file: null, event_name: null },
      ],
      [
        { id: 7, file_entry_id: 'LEGACY_SHOP_duplicate', spawn_method: 'custom_json', custom_json_file: 'custom/shop.json', event_name: null },
        { id: 8, file_entry_id: 'LEGACY_SHOP_duplicate', spawn_method: 'custom_json', custom_json_file: 'custom/shop.json', event_name: null },
      ],
      [
        { id: 9, file_entry_id: '{"event":"DuplicateEvent","x":1,"z":2,"a":3,"y":4}', spawn_method: 'event', custom_json_file: null, event_name: 'DuplicateEvent' },
        { id: 10, file_entry_id: '{"event":"DuplicateEvent","x":1,"z":2,"a":3,"y":4}', spawn_method: 'event', custom_json_file: null, event_name: 'DuplicateEvent' },
      ],
    ]) {
      const duplicateMetadataDb = {
        acquireTransactionAdvisoryLock: async () => {},
        onTransactionRollback: () => {},
        get: async sql => sql.includes('SELECT gt.token_hash')
          ? { token_hash: `${iv.toString('hex')}:${encrypted}`, platform_server_id: 'service-1' }
          : null,
        query: async sql => sql.includes('FROM shop_order_items soi') ? duplicateItems : [],
      };
      let duplicateMetadataError = null;
      try {
        await shop.removeExpiredRentals(duplicateMetadataDb, 1, duplicateItems.map(item => item.id));
      } catch (error) {
        duplicateMetadataError = error;
      }
      if (!duplicateMetadataError ||
          !/duplicate shop cleanup metadata/i.test(duplicateMetadataError.message) ||
          providerReadAttempts !== 0 || uploadAttempts !== 0) {
        throw new Error('Duplicate rental cleanup metadata was not rejected before provider access');
      }
    }
  } finally {
    Object.assign(missionFileService, originalMission);
    if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousKey;
  }
}

function testShopEntryIdentifiersUseDashboardNamespaceAndPreserveLegacyCleanup() {
  const shop = require('../services/shopFileService');
  const generated = shop.generateAreaName(42);
  if (!/^DAYZ_DASHBOARD_SHOP_[a-f0-9]{32}$/.test(generated)) {
    throw new Error('New shop entry identifiers do not use the DayZ Dashboard namespace');
  }

  const tracked = shop.parseCustomJsonCleanupMetadata(
    JSON.stringify({
      method: 'custom_json',
      entryId: 'DAYZ_DASHBOARD_SHOP_123',
      file: 'custom/original.json',
    }),
    'custom/edited-later.json'
  );
  if (tracked.entryId !== 'DAYZ_DASHBOARD_SHOP_123' || tracked.relativePath !== 'custom/original.json') {
    throw new Error('Custom JSON cleanup did not use immutable checkout metadata');
  }

  // Older installations used other uppercase namespaces. Their exact persisted
  // markers must remain removable without naming or emitting those namespaces.
  const legacy = shop.parseCustomJsonCleanupMetadata('LEGACY_SHOP_legacy', 'custom/legacy.json');
  if (legacy.entryId !== 'LEGACY_SHOP_legacy' || legacy.relativePath !== 'custom/legacy.json') {
    throw new Error('Legacy custom JSON cleanup metadata is not supported safely');
  }

  let malformedAccepted = false;
  try {
    shop.parseCustomJsonCleanupMetadata(
      'DAYZ_DASHBOARD_SHOP_../../unexpected',
      'custom/legacy.json'
    );
    malformedAccepted = true;
  } catch (error) {
    if (!/invalid legacy custom json cleanup metadata/i.test(error.message)) throw error;
  }
  if (malformedAccepted) {
    throw new Error('Malformed current-namespace shop marker bypassed strict validation');
  }

  let conflictingMarkersAccepted = false;
  try {
    shop.removeEffectAreaEntries({
      Areas: [{
        AreaName: 'LEGACY_SHOP_target',
        _shopEntryId: 'unrelated-marker',
        Type: 'Land_Barn_Wood1',
      }],
    }, new Set(['LEGACY_SHOP_target']));
    conflictingMarkersAccepted = true;
  } catch (error) {
    if (!/identifiers disagree/i.test(error.message)) throw error;
  }
  if (conflictingMarkersAccepted) {
    throw new Error('Conflicting cfgEffectArea marker fields were accepted for cleanup');
  }

  for (const [removeEntries, root, label] of [
    [shop.removeEffectAreaEntries, [
      { AreaName: 'LEGACY_SHOP_duplicate' },
      { AreaName: 'LEGACY_SHOP_duplicate' },
    ], 'cfgEffectArea'],
    [shop.removeObjectSpawnerEntries, { Objects: [
      {
        name: 'Land_Barn_Wood2', pos: [1, 2, 3], ypr: [0, 0, 0], scale: 1,
        _shopEntryId: 'LEGACY_SHOP_duplicate',
      },
      {
        name: 'Land_Barn_Wood2', pos: [4, 5, 6], ypr: [0, 0, 0], scale: 1,
        _shopEntryId: 'LEGACY_SHOP_duplicate',
      },
    ] }, 'custom JSON'],
  ]) {
    let duplicateAccepted = false;
    try {
      removeEntries(root, new Set(['LEGACY_SHOP_duplicate']));
      duplicateAccepted = true;
    } catch (error) {
      if (!/duplicate provider shop entry/i.test(error.message)) throw error;
    }
    if (duplicateAccepted) {
      throw new Error(`Duplicate live ${label} entries were accepted for cleanup`);
    }
  }
}

async function testShopCheckoutRevalidatesExactServerAuthority() {
  const shop = require('../services/shopFileService');
  const captured = [];
  await shop.assertCheckoutAuthority({
    get: async (sql, params) => {
      captured.push({ sql, params });
      if (captured.length === 1) return {};
      if (captured.length === 2) return { guild_id: 4 };
      if (captured.length === 3) return { id: 4 };
      if (captured.length === 4) return { id: 9 };
      if (captured.length === 5) return { server_id: 9 };
      if (captured.length === 6) return { id: 11, source_link_id: 13 };
      if (captured.length === 7) return { id: 13 };
      return { id: 11 };
    },
  }, { identity_id: 7, server_id: 9 }, 3);
  const [advisory, scope, guildLock, serverLock, configLock, discovery, proofLock, membershipLock] = captured;
  if (!advisory.sql.includes('pg_advisory_xact_lock') ||
      !scope.sql.includes('SELECT guild_id FROM servers') ||
      !guildLock.sql.includes("status = 'approved'") || !guildLock.sql.includes('FOR UPDATE') ||
      !serverLock.sql.includes("status = 'active'") || !serverLock.sql.includes('FOR NO KEY UPDATE') ||
      !configLock.sql.includes('guild_economy_config') || !configLock.sql.includes('FOR UPDATE') ||
      !discovery.sql.includes('server_id = ?') || !discovery.sql.includes('user_id = ?') ||
      !discovery.sql.includes('identity_id = ?') || discovery.sql.includes('FOR UPDATE') ||
      JSON.stringify(discovery.params) !== '[9,3,7]' ||
      !proofLock.sql.includes('linked_accounts') || !proofLock.sql.includes('id = ?') ||
      !proofLock.sql.includes('user_id = ?') || !proofLock.sql.includes('identity_id = ?') ||
      !proofLock.sql.includes('verification_method IN') ||
      !proofLock.sql.includes('FOR UPDATE') ||
      JSON.stringify(proofLock.params) !== '[13,3,7,"emote_challenge","admin_approved","self_asserted"]' ||
      !membershipLock.sql.includes('server_player_memberships') ||
      !membershipLock.sql.includes('source_link_id = ?') || !membershipLock.sql.includes("status = 'active'") ||
      !membershipLock.sql.includes('FOR UPDATE') ||
      JSON.stringify(membershipLock.params) !== '[11,9,3,7,13]') {
    throw new Error('Checkout authority recheck is not advisory-parent-proof-membership ordered for the exact trusted user, identity, and server');
  }
  let denial = null;
  let deniedCalls = 0;
  try {
    await shop.assertCheckoutAuthority({
      get: async () => (++deniedCalls === 1 ? { id: 9, guild_id: 4 } : null),
    }, { identity_id: 7, server_id: 9 }, 3);
  } catch (error) {
    denial = error;
  }
  if (!denial || !/active linked player identity/i.test(denial.message) ||
      denial.code !== 'SHOP_AUTHORIZATION_REVOKED') {
    throw new Error('Checkout authority denial is not a controlled, actionable authorization error');
  }
  const routeSource = require('fs').readFileSync(require('path').join(__dirname, '../routes/shop.js'), 'utf8');
  if (!/if \(err\.code === 'SHOP_AUTHORIZATION_REVOKED'\)[\s\S]*?res\.status\(403\)\.json\(\{ error: err\.message, checkoutState: 'failed' \}\)/.test(routeSource)) {
    throw new Error('Shop checkout does not return operation-time authorization denial as HTTP 403');
  }
}

async function testShopLockContentionReturnsControlledBusyError() {
  const shop = require('../services/shopFileService');
  const contention = new Error('canceling statement due to lock timeout');
  contention.code = '55P03';
  let rejected = null;
  try {
    await shop.acquireShopServerLock({
      acquireTransactionAdvisoryLock: async () => { throw contention; },
    }, 1);
  } catch (error) {
    rejected = error;
  }
  if (!rejected || rejected.code !== 'SHOP_BUSY' || !/already being processed/i.test(rejected.message)) {
    throw new Error('Shop advisory-lock contention was not converted to a controlled busy response');
  }
  const routeSource = require('fs').readFileSync(require('path').join(__dirname, '../routes/shop.js'), 'utf8');
  if (!/if \(err\.code === 'SHOP_BUSY'\)[\s\S]*?res\.status\(409\)\.json\(\{ error: err\.message, checkoutState: 'processing' \}\)/.test(routeSource)) {
    throw new Error('Shop route does not return a controlled response for lock contention');
  }

  const databaseFailure = new Error('database unavailable');
  let propagated = null;
  try {
    await shop.acquireShopServerLock({
      acquireTransactionAdvisoryLock: async () => { throw databaseFailure; },
    }, 1);
  } catch (error) {
    propagated = error;
  }
  if (propagated !== databaseFailure) throw new Error('Non-contention shop lock failure was hidden');
}

async function testShopFileRollbackIgnoresCancelledRequestSignal() {
  const shop = require('../services/shopFileService');
  const { currentRequestSignal, runWithRequestSignal } = require('../utils/requestAbort');
  const files = new Map([['/mission/file.xml', '<root>original</root>']]);
  const rollbackSignals = [];
  let uploads = 0;
  const provider = {
    downloadFileFromServer: async (_serverId, path) => files.get(path) ?? null,
    uploadFileToServer: async (_serverId, dir, name, content) => {
      uploads += 1;
      if (uploads > 1) rollbackSignals.push(currentRequestSignal());
      files.set(dir + '/' + name, content);
    },
  };
  const request = new AbortController();
  await runWithRequestSignal(request.signal, async () => {
    const journal = shop.createFileMutationJournal('15580969', 'token', provider);
    await journal.downloadFileFromServer('15580969', '/mission/file.xml', 'token');
    await journal.uploadFileToServer('15580969', '/mission', 'file.xml', '<root>shop-edit</root>', 'token');
    request.abort();
    await journal.rollback();
  });
  if (files.get('/mission/file.xml') !== '<root>original</root>') {
    throw new Error('Shop rollback did not restore provider state after request cancellation');
  }
  if (rollbackSignals.length !== 1 || rollbackSignals[0] !== null) {
    throw new Error('Shop rollback inherited the cancelled HTTP request signal');
  }
}

async function testShopCheckoutPreventsDuplicateSubmissions() {
  const source = require('fs').readFileSync(require('path').join(__dirname, '../public/js/shop.js'), 'utf8');
  const start = source.indexOf('async function checkout()');
  const end = source.indexOf('// ── Active Rentals', start);
  const checkout = source.slice(start, end);
  if (!checkout.includes('checkoutAttempts.has(contextKey)') ||
      !checkout.includes('checkoutAttempts.begin(contextKey)') ||
      !checkout.includes('checkoutAttempts.finish(attempt)')) {
    throw new Error('Shop checkout does not suppress duplicate submissions while provisioning is in progress');
  }
}

async function testShopRollbackRejectsConcurrentProviderEdits() {
  const shop = require('../services/shopFileService');
  const files = new Map([['/mission/file.xml', '<root>original</root>']]);
  const provider = {
    downloadFileFromServer: async (_serverId, path) => files.get(path) ?? null,
    uploadFileToServer: async (_serverId, dir, name, content) => {
      files.set(dir + '/' + name, content);
    },
  };
  const journal = shop.createFileMutationJournal('15580969', 'token', provider);
  await journal.downloadFileFromServer('15580969', '/mission/file.xml', 'token');
  await journal.uploadFileToServer('15580969', '/mission', 'file.xml', '<root>shop-edit</root>', 'token');
  files.set('/mission/file.xml', '<root>external-edit</root>');

  let rejected = null;
  try {
    await journal.rollback();
  } catch (error) {
    rejected = error;
  }
  if (!rejected || !/concurrent provider edit/i.test(rejected.message)) {
    throw new Error('Shop rollback did not reject an out-of-band provider edit');
  }
  if (files.get('/mission/file.xml') !== '<root>external-edit</root>') {
    throw new Error('Shop rollback overwrote an out-of-band provider edit');
  }
}

async function testShopRollbackVerifiesRestoredProviderContent() {
  const shop = require('../services/shopFileService');
  const files = new Map([['/mission/file.xml', '<root>original</root>']]);
  let uploads = 0;
  const provider = {
    downloadFileFromServer: async (_serverId, path) => files.get(path) ?? null,
    uploadFileToServer: async (_serverId, dir, name, content) => {
      uploads += 1;
      if (uploads === 1) files.set(dir + '/' + name, content);
    },
  };
  const journal = shop.createFileMutationJournal('15580969', 'token', provider);
  await journal.downloadFileFromServer('15580969', '/mission/file.xml', 'token');
  await journal.uploadFileToServer('15580969', '/mission', 'file.xml', '<root>shop-edit</root>', 'token');

  let rejected = null;
  try {
    await journal.rollback();
  } catch (error) {
    rejected = error;
  }
  if (!rejected || !/verification failed/i.test(rejected.message)) {
    throw new Error('Shop rollback treated an ineffective provider restore as successful');
  }
  if (files.get('/mission/file.xml') !== '<root>shop-edit</root>') {
    throw new Error('Rollback verification test did not preserve the simulated failed restore');
  }
}

async function testShopRollbackRestoresAmbiguousSuccessfulUpload() {
  const shop = require('../services/shopFileService');
  const files = new Map([['/mission/file.xml', '<root>original</root>']]);
  let uploads = 0;
  const provider = {
    downloadFileFromServer: async (_serverId, path) => files.get(path) ?? null,
    uploadFileToServer: async (_serverId, dir, name, content) => {
      uploads += 1;
      files.set(dir + '/' + name, content);
      if (uploads === 1) {
        const error = new Error('connection reset after provider accepted upload');
        error.code = 'ECONNRESET';
        throw error;
      }
    },
  };
  const journal = shop.createFileMutationJournal('15580969', 'token', provider);
  await journal.downloadFileFromServer('15580969', '/mission/file.xml', 'token');
  let uploadRejected = false;
  try {
    await journal.uploadFileToServer('15580969', '/mission', 'file.xml', '<root>shop-edit</root>', 'token');
  } catch (error) {
    uploadRejected = error.code === 'ECONNRESET';
  }
  if (!uploadRejected || files.get('/mission/file.xml') !== '<root>shop-edit</root>') {
    throw new Error('Ambiguous provider upload test did not reproduce a landed write with a failed response');
  }

  await journal.rollback();
  if (files.get('/mission/file.xml') !== '<root>original</root>') {
    throw new Error('Shop rollback did not restore an ambiguously successful provider upload');
  }
}

async function testShopFileMutationJournalDetectsConcurrentProviderEdits() {
  const shop = require('../services/shopFileService');
  const files = new Map([['/mission/file.xml', '<root>original</root>']]);
  const provider = {
    downloadFileFromServer: async (_serverId, path) => files.get(path) ?? null,
    uploadFileToServer: async (_serverId, dir, name, content) => {
      files.set(dir + '/' + name, content);
    },
  };
  const journal = shop.createFileMutationJournal('15580969', 'token', provider);
  await journal.downloadFileFromServer('15580969', '/mission/file.xml', 'token');
  files.set('/mission/file.xml', '<root>external-edit</root>');
  let conflictRejected = false;
  try {
    await journal.uploadFileToServer('15580969', '/mission', 'file.xml', '<root>shop-edit</root>', 'token');
  } catch (error) {
    conflictRejected = /concurrent provider edit/i.test(error.message);
  }
  if (!conflictRejected || files.get('/mission/file.xml') !== '<root>external-edit</root>') {
    throw new Error('Shop provider mutation did not fail closed on a concurrent edit');
  }

  const clean = shop.createFileMutationJournal('15580969', 'token', provider);
  await clean.downloadFileFromServer('15580969', '/mission/file.xml', 'token');
  await clean.uploadFileToServer('15580969', '/mission', 'file.xml', '<root>shop-edit</root>', 'token');
  if (files.get('/mission/file.xml') !== '<root>shop-edit</root>') throw new Error('Shop journal did not write verified content');
  await clean.rollback();
  if (files.get('/mission/file.xml') !== '<root>external-edit</root>') throw new Error('Shop journal did not restore its exact snapshot');
}

async function testNitradoDeleteUsesFormEncodedBody() {
  const axios = require('../utils/nitradoHttp');
  const missionFileService = require('../services/missionFileService');
  const originalDelete = axios.delete;
  let request = null;
  axios.delete = async (url, config) => {
    request = { url, config };
    return { data: { status: 'success' } };
  };

  try {
    await missionFileService.deleteFileFromServer('service-1', '/mission/new-file.xml', 'test-token');
  } finally {
    axios.delete = originalDelete;
  }

  if (!request || request.config.params) {
    throw new Error('Nitrado delete path was sent in the query string');
  }
  if (request.config.data !== 'path=%2Fmission%2Fnew-file.xml') {
    throw new Error('Nitrado delete path was not form encoded in the request body');
  }
  if (request.config.headers['Content-Type'] !== 'application/x-www-form-urlencoded') {
    throw new Error('Nitrado delete request did not declare form encoding');
  }
}

async function testCentralNitradoHttpTimeoutsAndSanitizedErrors() {
  const http = require('http');
  const fs = require('fs');
  const { createNitradoHttpClient, nitradoFetch, defaults } = require('../utils/nitradoHttp');
  if (!Number.isFinite(defaults.timeout) || defaults.timeout <= 0) {
    throw new Error('Central Nitrado HTTP client has no finite default timeout');
  }
  const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
  for (const file of ['routes', 'services', 'bot', 'utils', 'src', 'tools']
    .flatMap(directory => walk(path.join(__dirname, '..', directory)))
    .filter(file => file.endsWith('.js'))) {
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('api.nitrado.net')) continue;
    if (file.endsWith(path.join('utils', 'nitradoHttp.js'))) continue;
    if (source.includes("require('axios')") || source.includes('require("axios")')) {
      throw new Error('Nitrado request bypasses the centralized timeout client: ' + file);
    }
    if (/\bglobalThis\.fetch\s*\(|\bfetch\s*\(/.test(source) && !source.includes('nitradoFetch')) {
      throw new Error('Fetch-based Nitrado request bypasses timeout handling: ' + file);
    }
  }
  let hangingRequestClosed = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } else if (req.url === '/fail') {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unavailable', reflectedAuthorization: req.headers.authorization }));
    } else {
      req.on('close', () => { hangingRequestClosed = true; });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const client = createNitradoHttpClient(50);
  try {
    let overriddenTimeout = null;
    await client.get('http://unused.invalid', {
      timeout: 0,
      adapter: async config => {
        overriddenTimeout = config.timeout;
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
      },
    });
    if (!Number.isFinite(overriddenTimeout) || overriddenTimeout <= 0) {
      throw new Error('Per-request options can disable the centralized Nitrado timeout');
    }
    const normal = await client.get(`http://127.0.0.1:${port}/ok`);
    if (normal.data?.ok !== true) throw new Error('Normal centralized Nitrado request failed');

    const reflectedSecret = 'reflected-credential-that-must-not-leak';
    let failedError = null;
    try {
      await client.get(`http://127.0.0.1:${port}/fail`, {
        headers: { Authorization: ['Bea', 'rer ', reflectedSecret].join('') },
      });
    } catch (error) { failedError = error; }
    if (!failedError || failedError.response?.status !== 503) throw new Error('HTTP failure was not controlled');
    if ((failedError.message + JSON.stringify(failedError)).includes(reflectedSecret)) {
      throw new Error('Nitrado HTTP failure exposed a reflected credential');
    }

    const secret = 'credential-that-must-not-leak';
    let timeoutError = null;
    const started = Date.now();
    try {
      await client.get(`http://127.0.0.1:${port}/hang`, {
        headers: { Authorization: ['Bea', 'rer ', secret].join('') },
      });
    } catch (error) {
      timeoutError = error;
    }
    if (!timeoutError || timeoutError.code !== 'NITRADO_TIMEOUT' || Date.now() - started > 1000) {
      throw new Error('Nitrado timeout did not terminate the request promptly');
    }
    const serialized = timeoutError.message + JSON.stringify(timeoutError);
    if (serialized.includes(secret) || serialized.includes('Authorization')) {
      throw new Error('Nitrado timeout error leaked credentials');
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    if (!hangingRequestClosed) throw new Error('Timed-out Nitrado request did not release its socket');

    let fetchTimedOut = false;
    const stalledFetch = (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
    try {
      await nitradoFetch('https://api.nitrado.net/services', {}, stalledFetch, 20);
    } catch (error) {
      fetchTimedOut = error.code === 'NITRADO_TIMEOUT';
    }
    if (!fetchTimedOut) throw new Error('Fetch-based Nitrado request did not time out');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function testSchemaVersionReadErrorsFailClosed() {
  const PostgreSQLAdapter = require('../db/abstraction/postgres');
  const adapter = new PostgreSQLAdapter();
  adapter.run = async () => {
    throw new Error('schema catalog unavailable');
  };

  let rejected = false;
  try {
    await adapter.getSchemaVersion();
  } catch (error) {
    rejected = error.message === 'schema catalog unavailable';
  }

  if (!rejected) {
    throw new Error('Schema version read error was treated as version zero');
  }
}

function testNitradoPathNormalization() {
  const { normalizeNitradoFilePath } = require('../services/logSyncService');
  const cases = [
    ['/games/ni123_1/ftproot/dayzxb', '/games/ni123_1/noftp/dayzxb'],
    ['/games/ni123_1/ftproot/dayzps/config', '/games/ni123_1/noftp/dayzps/config'],
    ['/games/ni123_1/ftproot/dayzswitch/config', '/games/ni123_1/noftp/dayzswitch/config'],
    ['/games/ni123_1/ftproot/dayzstandalone/config', '/games/ni123_1/noftp/dayzstandalone/config'],
    ['/games/ni123_1/ftproot/dayzswitch_missions', '/games/ni123_1/ftproot/dayzswitch_missions'],
  ];
  for (const [input, expected] of cases) {
    if (normalizeNitradoFilePath(input) !== expected) {
      throw new Error(`Nitrado file path normalization failed for ${input}`);
    }
  }
}

function testNitradoApiPathToFtpPath() {
  const { toNitradoFtpPath } = require('../bot/utils/nitrado');
  const cases = [
    ['/games/ni123_1/ftproot/dayzxb_missions/mission/cfgeconomycore.xml', '/dayzxb_missions/mission/cfgeconomycore.xml'],
    ['/games/ni123_1/noftp/dayzxb/config/server.log', '/dayzxb/config/server.log'],
    ['/dayzxb_missions/mission/custom/messages.xml', '/dayzxb_missions/mission/custom/messages.xml'],
  ];

  for (const [input, expected] of cases) {
    if (toNitradoFtpPath(input) !== expected) {
      throw new Error(`Nitrado API path was not converted to FTP path: ${input}`);
    }
  }
}

function testNitradoIdentityExtraction() {
  const { extractNitradoUserId } = require('../utils/nitradoIdentity');
  const tokenPayload = { data: { user: { user_id: 987654 } } };
  if (extractNitradoUserId(tokenPayload) !== '987654') {
    throw new Error('Nitrado token identity did not resolve the immutable user ID');
  }
  if (extractNitradoUserId({ data: { user: {} } }) !== null) {
    throw new Error('Malformed Nitrado identity payload did not fail closed');
  }
}

async function testExactPlatformServerOwnerGuard() {
  const { ensurePlatformServerOwner } = require('../middleware/serverAccess');
  const runGuard = async row => {
    let authorizationSql = null;
    const response = { statusCode: null, body: null };
    const req = {
      isAuthenticated: () => true,
      user: { id: 7, is_admin: false },
      params: { serverId: 'service-22' },
      query: { guildId: 'guild-b' },
      body: {},
      app: { locals: { db: { get: async sql => {
        authorizationSql = sql;
        return row;
      } } } },
      originalUrl: '/api/nitrado/settings/service-22',
    };
    let nextCalled = false;
    const res = {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return this; },
    };
    await ensurePlatformServerOwner(req, res, () => { nextCalled = true; });
    return { ...response, nextCalled, authorizationSql };
  };

  const denied = await runGuard(null);
  if (denied.statusCode !== 403 || denied.nextCalled) {
    throw new Error('Platform server owner guard accepted unrelated guild evidence');
  }

  const allowed = await runGuard({ id: 22, guild_id: 2, discord_guild_id: 'guild-b', role: 'owner' });
  if (!allowed.nextCalled) {
    throw new Error('Platform server owner guard rejected the exact server owner');
  }
  if (/\(\? IS NULL OR/.test(allowed.authorizationSql) ||
      !/CAST\(\? AS TEXT\) IS NULL/.test(allowed.authorizationSql)) {
    throw new Error('Platform server owner guard uses an untyped PostgreSQL null parameter');
  }
  if (!allowed.authorizationSql.includes('server_role_assignments') ||
      !allowed.authorizationSql.includes("sra.role = 'admin'") ||
      !allowed.authorizationSql.includes("sra.status = 'active'")) {
    throw new Error('Platform server owner guard excludes exact assigned server admins');
  }
}

async function testExactApprovedGuildOperatorGuard() {
  const { ensureApprovedGuildOperator } = require('../middleware/serverAccess');
  let seenParams = null;
  const req = {
    isAuthenticated: () => true,
    user: { id: 7, is_admin: false },
    params: {},
    query: { guildId: 'guild-b' },
    body: {},
    app: { locals: { db: { get: async (_sql, params) => {
      seenParams = params;
      return null;
    } } } },
  };
  let nextCalled = false;
  let statusCode = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json() { return this; },
  };
  await ensureApprovedGuildOperator(req, res, () => { nextCalled = true; });
  if (statusCode !== 403 || nextCalled || !seenParams.includes('guild-b')) {
    throw new Error('Guild operator guard was not bound to the requested approved guild');
  }
}

function testPlayerLinkEmoteChallenge() {
  const {
    CHALLENGE_LENGTH,
    createEmoteChallengeSequence,
    evaluateEmoteChallenge,
  } = require('../services/playerLinkChallengeService');

  const sequence = createEmoteChallengeSequence(() => 0.25);
  if (sequence.length !== CHALLENGE_LENGTH || new Set(sequence).size !== CHALLENGE_LENGTH) {
    throw new Error('Player link challenge is not a unique multi-emote sequence');
  }

  const startedAt = new Date('2026-08-24T12:00:00.000Z');
  const expiresAt = new Date('2026-08-24T12:10:00.000Z');
  const events = sequence.map((emoteType, index) => ({
    emote_type: emoteType,
    timestamp: new Date(startedAt.getTime() + ((index + 1) * 1000)).toISOString(),
  }));
  if (!evaluateEmoteChallenge(sequence, events, startedAt, expiresAt).verified) {
    throw new Error('Correct in-window emote sequence did not verify');
  }

  const wrong = events.map(event => ({ ...event }));
  [wrong[0].emote_type, wrong[1].emote_type] = [wrong[1].emote_type, wrong[0].emote_type];
  if (evaluateEmoteChallenge(sequence, wrong, startedAt, expiresAt).verified) {
    throw new Error('Out-of-order emote sequence verified');
  }
}

function testProductionDiagnosticSessionRoutesAreAbsent() {
  const fs = require('fs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/app/registerRoutes.js'), 'utf8');
  if (source.includes('/internal/mint-session') || source.includes('/internal/run-tests')) {
    throw new Error('Production route graph still exposes diagnostic session endpoints');
  }
}

function testStaticMiddlewareCannotServePrivilegedHtml() {
  const fs = require('fs');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src/app/registerMiddleware.js'),
    'utf8'
  );
  const required = [
    "req.path.endsWith('.html')",
    'index: false',
    'redirect: false',
  ];
  if (required.some(value => !source.includes(value))) {
    throw new Error('Static middleware can bypass canonical authenticated HTML routes');
  }
}

function testDashboardAuthorizationErrorsFailClosed() {
  const fs = require('fs');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src/app/registerRoutes.js'),
    'utf8'
  );
  const dashboardRoute = source.slice(
    source.indexOf("app.get('/dashboard'"),
    source.indexOf("app.get('/dashboard/feeds'")
  );
  if (dashboardRoute.includes('Fallback to full dashboard') ||
      !dashboardRoute.includes('status(503)')) {
    throw new Error('Dashboard authorization lookup errors do not fail closed');
  }
}

function testCriticalNitradoRoutersMountExactServerGuards() {
  const nitradoSettingsRouter = require('../routes/nitradoSettings');
  const boostRouter = require('../routes/boost');
  const logParserRouter = require('../routes/logParser');
  const mountedNames = router => router.stack.flatMap(layer => [
    layer.handle?.name,
    ...(layer.route?.stack || []).map(routeLayer => routeLayer.handle?.name),
  ]).filter(Boolean);
  if (!mountedNames(nitradoSettingsRouter).includes('ensurePlatformServerOwner')) {
    throw new Error('Nitrado settings router lacks exact platform-server authorization');
  }
  if (!mountedNames(boostRouter).includes('ensureServerOwner')) {
    throw new Error('Boost router lacks exact internal-server owner middleware');
  }
  if (!mountedNames(logParserRouter).includes('ensurePlatformServerOwner')) {
    throw new Error('Log parser router lacks exact platform-server authorization');
  }

  for (const routeName of ['tasks', 'serverControl', 'backups', 'serverStats', 'activityLog', 'console']) {
    const protectedRouter = require(`../routes/${routeName}`);
    if (!mountedNames(protectedRouter).includes('ensureServerOwner')) {
      throw new Error(`${routeName} router lacks exact internal-server owner middleware`);
    }
  }

  const registerRoutesSource = require('fs').readFileSync(
    path.join(__dirname, '..', 'src/app/registerRoutes.js'),
    'utf8'
  );
  for (const routePath of [
    "'/api/server-active-mission/:serverId'",
    "'/api/detect-structure/:serverId'",
    "'/api/sync-server'",
    "'/api/list-files'",
  ]) {
    const routePattern = new RegExp(`${routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*ensurePlatformServerOwner`);
    if (!routePattern.test(registerRoutesSource)) {
      throw new Error(`${routePath} lacks exact platform-server authorization`);
    }
  }
}

function testTenantOwnershipMigrationConstraints() {
  const fs = require('fs');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'db/migrations/047_tenant_ownership_constraints.js'),
    'utf8'
  );
  const required = [
    'nitrado_user_id',
    'UNIQUE INDEX',
    'linked_accounts_identity_owner_uq',
    'servers_platform_server_owner_uq',
    'player_link_challenges',
    'sequence JSONB NOT NULL',
    'HAVING COUNT(*) > 1',
  ];
  for (const marker of required) {
    if (!source.includes(marker)) {
      throw new Error(`Tenant ownership migration is missing ${marker}`);
    }
  }
}

function testRegisterTokenNeverReassignsServerGuilds() {
  const fs = require('fs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'bot/commands/register-token.js'), 'utf8');
  const setupSource = fs.readFileSync(path.join(__dirname, '..', 'bot/services/guildSetupService.js'), 'utf8');
  if (/DO UPDATE SET[\s\S]{0,200}\n\s+guild_id\s*=\s*EXCLUDED\.guild_id/.test(source)) {
    throw new Error('Register-token still reassigns existing servers across guilds');
  }
  if (!source.includes('nitradoService.getAuthenticatedUser(token)')) {
    throw new Error('Register-token does not bind the stable Nitrado user ID');
  }
  if (!source.includes('FOR UPDATE') || !source.includes('getDiscordSetupPermission(interaction)') ||
      !setupSource.includes('interaction?.client?.guilds.fetch') ||
      !setupSource.includes('guild: interaction?.guild?.id') ||
      !setupSource.includes("force: true, cache: false") ||
      !setupSource.includes('user: actorDiscordId') ||
      !setupSource.includes('user: ownerDiscordId') ||
      !setupSource.includes('permissions?.has(PermissionFlagsBits.Administrator)')) {
    throw new Error('Register-token lacks concurrency locking or authoritative runtime Administrator enforcement');
  }
  if (!source.includes("SET status = 'approved'") ||
      !source.includes("WHERE id = $1 AND status = 'pending'") ||
      !source.includes('approved_at = CURRENT_TIMESTAMP') ||
      !source.includes('approved_by = $2') ||
      !source.includes('ensureAuthoritativeInitialGuildOwner') ||
      source.includes('Pending admin approval')) {
    throw new Error('Verified initial guild setup does not activate the tenant atomically');
  }
}

function testWebsiteServerRegistrationRequiresBoundAccountService() {
  const fs = require('fs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes/nitrado.js'), 'utf8');
  const ownerSource = fs.readFileSync(path.join(__dirname, '..', 'routes/ownerDashboard.js'), 'utf8');
  const feedsSource = fs.readFileSync(path.join(__dirname, '..', 'routes/feeds.js'), 'utf8');
  if (!source.includes("router.post('/register-server', ensureGuildOwner") || !source.includes('res.status(410)')) {
    throw new Error('Legacy manual website server registration is not disabled for exact guild owners');
  }
  if (!source.includes("router.put('/account-servers/:serviceId', ensureGuildOwner")) {
    throw new Error('Dashboard server selection lacks exact approved-guild owner authorization');
  }
  if (!source.includes('nitrado_user_id IS NOT NULL') ||
      !source.includes('getAuthenticatedUser') ||
      !source.includes('String(identity.id) !== String(tokenRow.nitrado_user_id)') ||
      !source.includes('services.find(item => String(item.id) === serviceId)')) {
    throw new Error('Dashboard server selection does not prove service ownership by the current bound Nitrado account');
  }
  if (!source.includes('FOR UPDATE') || source.includes('const { serverId, serverName, guildId } = req.body')) {
    throw new Error('Dashboard server selection is not serialized or trusts client-supplied provider identity');
  }
  const listRoute = source.slice(source.indexOf("router.get('/registered-servers'"));
  if (!listRoute.includes("g.status = 'approved'") ||
      !listRoute.includes('server_role_assignments') ||
      listRoute.includes("gr.role IN ('owner', 'admin', 'moderator')")) {
    throw new Error('Registered server list is not restricted to approved exact-server roles');
  }
  const ownerListRoute = ownerSource.slice(
    ownerSource.indexOf("router.get('/servers'"),
    ownerSource.indexOf("router.get('/servers/:id'")
  );
  if (!ownerListRoute.includes("g.status = 'approved'") ||
      !ownerListRoute.includes("s.status = 'active'") ||
      ownerListRoute.includes('req.user.is_admin')) {
    throw new Error('Owner server list includes disabled guilds or inactive servers');
  }
  if (feedsSource.includes("gr.role IN ('owner', 'admin', 'moderator')")) {
    throw new Error('Guild-wide moderator can manage guild feed configuration');
  }
}

function testDashboardTokenRegistrationBindsNitradoIdentity() {
  const fs = require('fs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes/guilds.js'), 'utf8');
  if (!source.includes("require('../services/nitradoService')") ||
      !source.includes('nitradoService.getAuthenticatedUser') ||
      !source.includes('nitradoService.listServices') ||
      !source.includes('nitrado_user_id') ||
      !source.includes('FOR UPDATE') ||
      !source.includes("guild.status === 'disabled'")) {
    throw new Error('Dashboard token registration bypasses stable Nitrado identity binding');
  }
  if (!source.includes("AND gt.nitrado_user_id IS NOT NULL") ||
      !source.includes("AND g.status = 'approved'")) {
    throw new Error('Dashboard token access exposes disabled or unverified Nitrado credentials');
  }
  if (source.includes("router.get('/:guildId/token'")) {
    throw new Error('Dashboard exposes a direct decrypted Nitrado token endpoint');
  }
}

function testRotationPresetOperationsAreBoundToExactServer() {
  const fs = require('fs');
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes/rotation.js'), 'utf8');
  const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'services/rotationService.js'), 'utf8');

  if (!serviceSource.includes('acquireProviderMutationLock(transactionDb, serverId)') ||
      !serviceSource.includes('outcome = await db.transaction(async transactionDb =>') ||
      !serviceSource.includes('prepared = await prepare(transactionDb)') ||
      !serviceSource.includes('db.independentTransaction(durableDb => persistPreparedMutation')) {
    throw new Error('Rotation provider mutations do not share the fenced exact-server mission-file lock');
  }
  if (!routeSource.includes('await rotationService.activatePreset(') ||
      !routeSource.includes('await rotationService.deactivatePreset(') ||
      !routeSource.includes('transactionDb => assertRotationMutationAuthority(transactionDb, serverId, req.user.id)')) {
    throw new Error('Rotation activation is not bound to the authorized path server');
  }
  if (!routeSource.includes('WHERE rp.id = ? AND rp.server_id = ?') ||
      !routeSource.includes('rs.server_id = rp.server_id')) {
    throw new Error('Rotation preset/snippet mutations are not exact-server-bound');
  }
  if (!serviceSource.includes('WHERE id = ? AND server_id = ?') ||
      !serviceSource.includes('rs.server_id = rp.server_id')) {
    throw new Error('Rotation service does not fail closed on cross-server presets or snippets');
  }
}

function testAiAssistantUsesCspCompatibleRuntimeRoutes() {
  const fs = require('fs');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public/dashboard/ai-assistant.html'), 'utf8');
  const middleware = fs.readFileSync(path.join(__dirname, '..', 'src/app/registerMiddleware.js'), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes/ai.js'), 'utf8');

  if (!page.includes('<script src="/js/ai-assistant.js" defer></script>') ||
      /\son[a-z]+\s*=/.test(page) || /<script>([\s\S]*?)<\/script>/.test(page)) {
    throw new Error('AI Assistant page is blocked by the application CSP');
  }
  if (page.includes('/api/guilds/servers') || page.includes('/api/mission-files/content')) {
    throw new Error('AI Assistant still references nonexistent API routes');
  }
  if (!middleware.includes("req.path.endsWith('.html')")) {
    throw new Error('Direct AI Assistant HTML path bypasses authentication');
  }
  if (!routes.includes('getAuthorizedSuggestion') ||
      !routes.includes("gr.role IN ('owner', 'admin')") ||
      !routes.includes("g.status = 'approved'")) {
    throw new Error('AI suggestion operations are not bound to the current server role');
  }
}

async function testBotCommandsRequireApprovedGuild() {
  const { canExecuteGuildCommand } = require('../bot/utils/commandAuthorization');
  const approvedDb = { query: async () => ({ rows: [{ status: 'approved' }] }) };
  const disabledDb = { query: async () => ({ rows: [{ status: 'disabled' }] }) };
  if (!await canExecuteGuildCommand(approvedDb, 'guild-a', 'stats')) {
    throw new Error('Approved guild was denied a bot command');
  }
  if (await canExecuteGuildCommand(disabledDb, 'guild-a', 'stats')) {
    throw new Error('Disabled guild retained bot command access');
  }
  if (await canExecuteGuildCommand(approvedDb, null, 'stats')) {
    throw new Error('Direct-message command bypassed guild authorization');
  }
  if (!await canExecuteGuildCommand(disabledDb, 'guild-a', 'register-token')) {
    throw new Error('Registration command cannot reach its command-local disabled-guild check');
  }
}

async function testBotCommandsAuthorizeActorForExactServer() {
  const { authorizeGuildCommand } = require('../bot/utils/commandAuthorization');
  if (typeof authorizeGuildCommand !== 'function') {
    throw new Error('Bot command authorization has no actor-to-server capability check');
  }

  const makeDb = rows => ({
    async query(sql, params) {
      if (!sql.includes('server_role_assignments') ||
          !sql.includes("s.status = 'active'") ||
          !sql.includes("g.status = 'approved'") ||
          !params.includes('guild-a') ||
          !params.includes('actor-a')) {
        throw new Error('Bot authorization query is not bound to actor, guild, and active server');
      }
      return { rows };
    },
  });
  const base = {
    server_id: 41,
    platform_server_id: 'service-a',
    server_role: null,
    server_role_status: null,
  };
  const actor = { discordUserId: 'actor-a', requestedServerId: 'service-a', isDiscordAdministrator: false };

  const unassigned = await authorizeGuildCommand(makeDb([base]), 'guild-a', 'server-control', actor);
  if (unassigned.allowed) throw new Error('Unassigned guild member received server-control access');

  const moderatorDb = makeDb([{ ...base, server_role: 'moderator', server_role_status: 'active' }]);
  const moderatorControl = await authorizeGuildCommand(moderatorDb, 'guild-a', 'server-control', actor);
  if (moderatorControl.allowed) throw new Error('Server moderator received server-management access');
  const moderatorBan = await authorizeGuildCommand(moderatorDb, 'guild-a', 'ban', actor);
  if (!moderatorBan.allowed || moderatorBan.serverId !== 41) {
    throw new Error('Exact-server moderator was denied moderation capability');
  }

  const foreign = await authorizeGuildCommand(
    makeDb([{ ...base, server_id: 52, platform_server_id: 'service-b', server_role: 'admin', server_role_status: 'active' }]),
    'guild-a',
    'server-control',
    actor
  );
  if (foreign.allowed) throw new Error('Actor assignment to another server authorized the selected server');

  const discordAdmin = await authorizeGuildCommand(
    makeDb([base]),
    'guild-a',
    'server-control',
    { ...actor, isDiscordAdministrator: true }
  );
  if (!discordAdmin.allowed || discordAdmin.serverId !== 41) {
    throw new Error('Discord guild administrator was denied its exact active server');
  }

  const unknown = await authorizeGuildCommand(makeDb([base]), 'guild-a', 'future-unclassified-command', {
    ...actor,
    isDiscordAdministrator: true,
  });
  if (unknown.allowed) {
    throw new Error('Unclassified Discord command failed open');
  }
}

function testPlayerLinkVerificationPolicyIsExactServerScoped() {
  const fs = require('fs');
  const website = fs.readFileSync(path.join(__dirname, '..', 'routes/accountLinking.js'), 'utf8');
  const bot = fs.readFileSync(path.join(__dirname, '..', 'bot/commands/link.js'), 'utf8');
  if (!website.includes('evaluateEmoteChallenge') || !website.includes("'emote_challenge'")) {
    throw new Error('Website player linking does not require an emote challenge');
  }
  for (const [name, source] of [['website', website], ['bot', bot]]) {
    if (!source.includes('server_player_memberships') ||
        !source.includes('account.server_id') ||
        !source.includes('account.guild_id')) {
      throw new Error(`${name} player linking does not create an exact-server membership`);
    }
  }
  if (website.includes("VALUES (?, ?, ?, 'manual')")) {
    throw new Error('Website still contains an unproven manual-link insertion path');
  }
  if (!website.includes('parseLinkSettings') ||
      !website.includes("verificationMode === 'admin_approval'") ||
      !website.includes("verificationMode === 'open'") ||
      !website.includes("'self_asserted'")) {
    throw new Error('Website player linking does not enforce all three exact-server verification modes');
  }
  if (bot.includes("[userId, account.id, guild.id, 'bot_command']")) {
    throw new Error('Bot still contains an unproven command-link insertion path');
  }
  if (!bot.includes('s.guild_id,') || !bot.includes('String(account.guild_id)')) {
    throw new Error('Bot link challenge is not bound to the selected server guild');
  }

  const settingsPath = path.join(__dirname, '..', 'bot/utils/linkSettings.js');
  const commandPath = path.join(__dirname, '..', 'bot/commands/link-settings.js');
  if (!fs.existsSync(settingsPath) || !fs.existsSync(commandPath)) {
    throw new Error('Exact-server link settings are missing');
  }
  const { parseLinkSettings } = require(settingsPath);
  const { isTrustedLinkMethod, isFinancialLinkMethod } = require('../utils/linkTrust');
  if (!isTrustedLinkMethod('emote_challenge') || !isTrustedLinkMethod('admin_approved') ||
      isTrustedLinkMethod('self_asserted') ||
      !isFinancialLinkMethod('emote_challenge') || !isFinancialLinkMethod('admin_approved') ||
      !isFinancialLinkMethod('self_asserted') ||
      isFinancialLinkMethod('manual') || isFinancialLinkMethod('bot_command') ||
      isFinancialLinkMethod('server_policy')) {
    throw new Error('Financial linked-account policy is not isolated from proof-based relinking');
  }
  const { CAPABILITIES, canUseCapability } = require('../services/authorizationService');
  const activePlayer = {
    player_membership_status: 'active',
    player_membership_id: 4,
    player_verification_method: 'self_asserted',
  };
  if (!canUseCapability(activePlayer, { id: 3 }, CAPABILITIES.PLAYER_FINANCIAL) ||
      canUseCapability({ ...activePlayer, player_verification_method: 'manual' },
        { id: 3 }, CAPABILITIES.PLAYER_FINANCIAL)) {
    throw new Error('Player financial capability does not use the isolated active-link policy');
  }
  if (parseLinkSettings(null).verificationMode !== 'admin_approval' ||
      parseLinkSettings({ emoteVerificationEnabled: true }).verificationMode !== 'emote' ||
      parseLinkSettings({ verificationMode: 'open' }).verificationMode !== 'open' ||
      parseLinkSettings({ verificationMode: 'invalid' }).verificationMode !== 'admin_approval') {
    throw new Error('Player-link verification modes are not normalized fail closed');
  }
  const settingsSource = fs.readFileSync(settingsPath, 'utf8');
  const commandSource = fs.readFileSync(commandPath, 'utf8');
  const rbacMigration = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '050_multi_tenant_rbac.js'),
    'utf8'
  );
  const policyMigration = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', '057_player_link_verification_modes.js'),
    'utf8'
  );
  if (!rbacMigration.includes("'self_asserted'") ||
      !policyMigration.includes("'self_asserted'") ||
      !policyMigration.includes('server_player_memberships_verification_method_check')) {
    throw new Error('Fresh and upgraded schemas do not allow the explicit open-link provenance');
  }
  for (const value of [
    "feature_name = 'player_linking'",
    'server_id = $1',
    'interaction.authorizedServerId',
    "setName('server')",
  ]) {
    if (!settingsSource.includes(value) && !commandSource.includes(value)) {
      throw new Error(`Link settings are missing exact-server guard: ${value}`);
    }
  }
  if (!bot.includes('linkSettings.verificationMode') ||
      !bot.includes("'existing_verified_link'")) {
    throw new Error('Bot /link does not honor the exact-server verification mode');
  }
  if (!bot.includes('requires administrator or moderator approval') ||
      !bot.includes("verificationMethod = 'self_asserted'") ||
      !bot.includes('account.linked_user_id === userId') ||
      !bot.includes("status = 'active'")) {
    throw new Error('Three-level link policy permits the wrong claim path or blocks secure reactivation');
  }
}

async function testDiscordRoleAutomationUsesExactServerSettings() {
  const fs = require('fs');
  const servicePath = path.join(__dirname, '..', 'bot/utils/linkRoleAutomation.js');
  const commandPath = path.join(__dirname, '..', 'bot/commands/link-settings.js');
  const joinEventPath = path.join(__dirname, '..', 'bot/events/guildMemberAdd.js');
  if (!fs.existsSync(servicePath) || !fs.existsSync(joinEventPath)) {
    throw new Error('Discord role lifecycle automation is missing');
  }

  const { applyLinkRoleAutomation } = require(servicePath);
  const calls = [];
  const member = {
    roles: {
      async add(ids) { calls.push(['add', ids]); },
      async remove(ids) { calls.push(['remove', ids]); },
    },
  };
  await applyLinkRoleAutomation(member, {
    roles: {
      assignOnJoin: ['10'],
      assignOnLink: ['20', '21'],
      removeOnLink: ['10'],
      removeOnLeave: ['20'],
    },
  }, 'link');
  if (JSON.stringify(calls) !== JSON.stringify([
    ['add', ['20', '21']],
    ['remove', ['10']],
  ])) {
    throw new Error('Link role automation applied roles for the wrong lifecycle event');
  }

  const command = fs.readFileSync(commandPath, 'utf8');
  const joinEvent = fs.readFileSync(joinEventPath, 'utf8');
  for (const required of [
    'PermissionFlagsBits.ManageRoles',
    'interaction.authorizedServerId',
    "feature_name = 'player_linking'",
    "s.status = 'active'",
    "g.status = 'approved'",
  ]) {
    if (!command.includes(required) && !joinEvent.includes(required)) {
      throw new Error(`Role automation is missing guard: ${required}`);
    }
  }
}

function testExpiredPlayerLinkChallengesReleaseIdentityBeforeOwnershipChecks() {
  const fs = require('fs');
  const sources = [
    ['website', fs.readFileSync(path.join(__dirname, '..', 'routes/accountLinking.js'), 'utf8')],
    ['bot', fs.readFileSync(path.join(__dirname, '..', 'bot/commands/link.js'), 'utf8')],
  ];

  for (const [name, source] of sources) {
    const expiryCheck = source.indexOf('new Date(challenge.expires_at) <= now');
    const claimantCheck = source.indexOf('challenge.user_id !==');
    const provenanceCheck = source.indexOf('String(challenge.guild_id)');
    if (expiryCheck === -1 || claimantCheck === -1 || provenanceCheck === -1 ||
        expiryCheck > claimantCheck || expiryCheck > provenanceCheck) {
      throw new Error(`${name} leaves expired ownership challenges blocking another claimant`);
    }
  }
}

function testBotAggregatesAreExactServerScoped() {
  const fs = require('fs');
  for (const relativePath of ['bot/commands/stats.js', 'bot/commands/leaderboard.js', 'bot/commands/my-stats.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
    if (!source.includes("setName('server')") ||
        !source.includes('interaction.authorizedServerId') ||
        !source.includes('server_id = $')) {
      throw new Error(`${relativePath} does not bind aggregate data to the exact authorized server`);
    }
  }

  const unlink = fs.readFileSync(path.join(__dirname, '..', 'bot/commands/unlink.js'), 'utf8');
  if (!unlink.includes("setName('server')") ||
      !unlink.includes('interaction.authorizedServerId') ||
      !unlink.includes('server_player_memberships') ||
      unlink.includes('DELETE FROM linked_accounts')) {
    throw new Error('Bot unlink is not scoped to the selected server membership');
  }
}

function testStatusDeliveryIsBoundToFeatureGuild() {
  const fs = require('fs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'bot/services/serverStatusService.js'), 'utf8');
  const readySource = fs.readFileSync(path.join(__dirname, '..', 'bot/events/ready.js'), 'utf8');
  if (!source.includes('s.guild_id = $2') ||
      !source.includes("g.status = 'approved'") ||
      !source.includes('gt.nitrado_user_id IS NOT NULL') ||
      !source.includes('nitradoService.getAuthenticatedUser')) {
    throw new Error('Server status delivery is not bound to the approved feature guild and verified Nitrado account');
  }
  if (!readySource.includes('await backfillLegacyNitradoTokenBindings()')) {
    throw new Error('Bot startup does not explicitly backfill legacy Nitrado account bindings');
  }
}

function testLogSyncBindsEveryServerToOneAuthorizedGuild() {
  const fs = require('fs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'services/logSyncService.js'), 'utf8');
  const schedulerSource = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
  const compactSource = source.replace(/\s+/g, ' ');
  if (!compactSource.includes("gr.role IN ('owner', 'admin')") ||
      !compactSource.includes("g.status = 'approved'") ||
      !compactSource.includes("s.status = 'active'") ||
      !compactSource.includes('gt.nitrado_user_id IS NOT NULL') ||
      !source.includes('resolveOperationalServer(db, userId, serverId, token)') ||
      !source.includes('new Set(tokens).size !== 1') ||
      !source.includes('HAVING COUNT(DISTINCT gt.id) = 1') ||
      !schedulerSource.includes('buildScheduledLogSyncPlan(settings)') ||
      schedulerSource.includes('settings.autoScan ? [] : serverIds') ||
      schedulerSource.includes('listGameServers')) {
    throw new Error('Log sync does not bind every requested server to one authorized guild account');
  }
}

function testBotHeartbeatClassification() {
  const { classifyBotHealth } = require('../utils/botHealth');
  const now = Date.parse('2026-08-24T01:00:00.000Z');

  const online = classifyBotHealth({
    status: 'online',
    last_heartbeat: '2026-08-24T00:59:30.000Z',
    guild_count: 3,
    websocket_ping_ms: 42,
    process_uptime_seconds: 600,
  }, now);
  if (online.status !== 'online' || online.guildCount !== 3 || online.websocketPingMs !== 42) {
    throw new Error('Fresh bot heartbeat was not classified as online');
  }

  const onlineWithoutPing = classifyBotHealth({
    status: 'online',
    last_heartbeat: '2026-08-24T00:59:30.000Z',
    websocket_ping_ms: null,
  }, now);
  if (onlineWithoutPing.websocketPingMs !== null) {
    throw new Error('Missing bot websocket ping was not preserved as null');
  }

  const stale = classifyBotHealth({
    status: 'online',
    last_heartbeat: '2026-08-24T00:57:00.000Z',
  }, now);
  if (stale.status !== 'offline') {
    throw new Error('Stale bot heartbeat was not classified as offline');
  }

  if (classifyBotHealth(null, now).status !== 'offline') {
    throw new Error('Missing bot heartbeat was not classified as offline');
  }
}

async function testLegacyMigrationFailsClosed() {
  const { migrate } = require('../db/migrations/004_complete_redesign');
  let mutationCount = 0;
  let schemaVersionReads = 0;
  const db = {
    getSchemaVersion: async () => {
      schemaVersionReads += 1;
      return 0;
    },
    tableExists: async table => table === 'discord_guilds',
    run: async () => { mutationCount++; },
  };

  let error = null;
  try {
    await migrate(db);
  } catch (caught) {
    error = caught;
  }

  if (!error || error.code !== 'LEGACY_SCHEMA_MIGRATION_UNSUPPORTED') {
    throw new Error('Legacy PostgreSQL migration did not fail closed');
  }
  if (mutationCount !== 0) {
    throw new Error('Legacy PostgreSQL migration mutated the database before refusing');
  }
  if (schemaVersionReads !== 0) {
    throw new Error('Legacy migration touched schema-version metadata before refusing');
  }

  const mixedDb = {
    getSchemaVersion: async () => {
      schemaVersionReads += 1;
      return 0;
    },
    tableExists: async table => ['discord_guilds', 'guilds'].includes(table),
  };
  let mixedError = null;
  try {
    await migrate(mixedDb);
  } catch (caught) {
    mixedError = caught;
  }
  if (!mixedError || mixedError.code !== 'LEGACY_SCHEMA_MIGRATION_UNSUPPORTED') {
    throw new Error('Mixed legacy/V2 database bypassed the fail-closed migration guard');
  }
  if (schemaVersionReads !== 0) {
    throw new Error('Mixed legacy/V2 migration touched schema-version metadata before refusing');
  }
}

async function testMigrationAndTrackingAreAtomic() {
  const { runMigrationInTransaction } = require('../db/migrationRunnerPg');
  const events = [];
  const client = {
    async query(sql, params) {
      events.push({ sql: sql.trim(), params });
      return { rows: [], rowCount: 0 };
    },
    release() {
      events.push({ sql: 'RELEASE' });
    },
  };
  const pool = { async connect() { return client; } };
  const migration = {
    async up(db) {
      const leased = await db.connect();
      await leased.query('BEGIN');
      await leased.query('ALTER TABLE example ADD COLUMN value TEXT');
      await leased.query('COMMIT');
      leased.release();
    },
  };

  await runMigrationInTransaction(pool, migration, 'test.js');
  const sql = events.map(event => event.sql);
  const expected = [
    'BEGIN',
    'ALTER TABLE example ADD COLUMN value TEXT',
    'INSERT INTO schema_migrations (migration_name) VALUES ($1) ON CONFLICT DO NOTHING',
    'COMMIT',
    'RELEASE',
  ];
  if (JSON.stringify(sql) !== JSON.stringify(expected)) {
    throw new Error(`Migration and tracking were not atomic: ${JSON.stringify(sql)}`);
  }

  events.length = 0;
  let rejected = false;
  try {
    await runMigrationInTransaction(pool, { async up() { throw new Error('migration failed'); } }, 'broken.js');
  } catch (error) {
    rejected = error.message === 'migration failed';
  }
  if (!rejected || events.map(event => event.sql).join('|') !== 'BEGIN|ROLLBACK|RELEASE') {
    throw new Error('Failed migration was not rolled back atomically');
  }
}

async function testMigrationRunnerFailsClosedAndSerializes() {
  const { validateMigrationExport, withMigrationLock } = require('../db/migrationRunnerPg');
  if (typeof validateMigrationExport !== 'function' || typeof withMigrationLock !== 'function') {
    throw new Error('Migration runner does not expose fail-closed validation and serialization helpers');
  }
  let rejected = false;
  try {
    validateMigrationExport('073_broken.js', {});
  } catch (error) {
    rejected = /must export an up\(\) function/.test(error.message);
  }
  if (!rejected) throw new Error('Malformed pending migration did not fail closed');

  const events = [];
  const client = {
    async query(sql) { events.push(sql.trim()); return { rows: [], rowCount: 0 }; },
    release() { events.push('RELEASE'); },
  };
  const pool = { async connect() { return client; } };
  await withMigrationLock(pool, async lockedClient => {
    if (lockedClient !== client) throw new Error('Migration callback did not use the lock-owning connection');
    events.push('CALLBACK');
  });
  const joined = events.join('|');
  if (!/pg_advisory_lock/.test(joined) || !/pg_advisory_unlock/.test(joined)) {
    throw new Error(`Migration runner did not hold a PostgreSQL advisory lock: ${joined}`);
  }
  if (events.indexOf('CALLBACK') < events.findIndex(sql => /pg_advisory_lock/.test(sql)) ||
      events.indexOf('CALLBACK') > events.findIndex(sql => /pg_advisory_unlock/.test(sql))) {
    throw new Error(`Migration callback ran outside the advisory lock: ${joined}`);
  }
  if (!events.some(sql => /lock_timeout/.test(sql)) || !events.some(sql => /statement_timeout/.test(sql))) {
    throw new Error(`Migration runner did not set bounded database timeouts: ${joined}`);
  }
}

async function testLegacySchemaDetectionErrorsFailClosed() {
  const { checkForOldSchema } = require('../db/schema');
  let rejected = false;
  const originalError = console.error;
  console.error = () => {};
  try {
    await checkForOldSchema({
      async tableExists() {
        throw new Error('catalog unavailable');
      },
    });
  } catch (error) {
    rejected = error.message === 'catalog unavailable';
  } finally {
    console.error = originalError;
  }

  if (!rejected) {
    throw new Error('Legacy schema detection error was treated as a fresh database');
  }
}

function testSchemaStateClassificationFailsClosed() {
  const { classifySchemaState } = require('../db/schema');
  const cases = [
    [0, false, 'fresh'],
    [0, true, 'legacy'],
    [1, true, 'legacy'],
    [2, true, 'legacy'],
    [1, false, 'unsupported'],
    [2, false, 'current'],
    [3, false, 'unsupported'],
  ];

  for (const [version, hasOldTables, expected] of cases) {
    const actual = classifySchemaState(version, hasOldTables);
    if (actual !== expected) {
      throw new Error(`Schema v${version} classified as ${actual}; expected ${expected}`);
    }
  }
}

function testErrorHandlerOnlyClassifiesPostgresSqlState() {
  const { errorHandler } = require('../middleware/errorHandler');
  const req = { path: '/test', method: 'GET' };
  const capture = error => {
    const response = { statusCode: null, body: null };
    const res = {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return this; },
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      errorHandler(error, req, res);
    } finally {
      console.error = originalError;
    }
    return response;
  };

  const systemError = capture({ code: 'EPIPE', status: 418, message: 'broken pipe' });
  if (systemError.statusCode !== 418) {
    throw new Error('Five-character system error was misclassified as PostgreSQL');
  }

  const postgresError = capture({ code: '23505', severity: 'ERROR', message: 'duplicate' });
  if (postgresError.statusCode !== 500 || postgresError.body?.error !== 'Database error. Please try again later.') {
    throw new Error('PostgreSQL SQLSTATE error was not classified safely');
  }
}

function testProductionRequiresPostgresPassword() {
  const script = `
    process.env.NODE_ENV = 'production';
    process.env.DISCORD_CLIENT_ID = '900000000000000002';
    process.env.DISCORD_CLIENT_SECRET = '${'s'.repeat(16)}';
    process.env.SESSION_SECRET = '${'x'.repeat(32)}';
    process.env.ENCRYPTION_KEY = '${'a'.repeat(64)}';
    process.env.PORT = '3000';
    delete process.env.POSTGRES_PASSWORD;
    require('./utils/envValidator').validateEnv();
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { PATH: process.env.PATH },
    encoding: 'utf8',
  });

  if (result.status !== 1 || !result.stderr.includes('POSTGRES_PASSWORD')) {
    throw new Error('Production environment accepted a missing PostgreSQL password');
  }
}

async function testApprovedGuildAccessIncludesVerifiedPlayers() {
  const { ensurePlayerApproved } = require('../middleware/serverAccess');
  const runGuard = async approvedGuild => {
    const calls = [];
    const req = {
      isAuthenticated: () => true,
      user: { id: 42, is_admin: 0 },
      app: { locals: { db: { async get(sql, params) {
        calls.push({ sql, params });
        return approvedGuild;
      } } } },
    };
    const response = { statusCode: null, body: null };
    const res = {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return this; },
    };
    let allowed = false;
    await ensurePlayerApproved(req, res, () => { allowed = true; });
    return { allowed, response, calls };
  };

  const accepted = await runGuard({ id: 7 });
  if (!accepted.allowed || accepted.response.statusCode !== null) {
    throw new Error('Verified linked player was denied approved-guild access');
  }

  const rejected = await runGuard(null);
  if (rejected.allowed || rejected.response.statusCode !== 403) {
    throw new Error('Unverified or cross-guild linked player was granted approved-guild access');
  }

  const query = accepted.calls[0].sql.replace(/\s+/g, ' ');
  const requiredPredicates = [
    "g.status = 'approved'",
    'FROM server_player_memberships spm',
    'spm.guild_id = g.id',
    "spm.status = 'active'",
    'la.id = spm.source_link_id',
    "la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')",
  ];
  if (accepted.calls[0].params.join(',') !== '42,42' || requiredPredicates.some(predicate => !query.includes(predicate))) {
    throw new Error('Player access query does not enforce the approved and same-guild verification boundary');
  }

  const routeSource = require('fs').readFileSync(path.join(__dirname, '..', 'src/app/registerRoutes.js'), 'utf8');
  if (!routeSource.includes("app.use('/api/shop', ensureAuthenticated, ensurePlayerApproved, shopRoutes)")) {
    throw new Error('Shop routes do not use the player-specific approved-guild guard');
  }
  const playerFacingMounts = [
    "app.use('/api/economy', ensureAuthenticated, ensurePlayerApproved, economyRoutes)",
    "app.use('/api/factions', ensureAuthenticated, ensurePlayerApproved, factionsRoutes)",
    "app.use('/api/casino', ensureAuthenticated, ensurePlayerApproved, casinoRoutes)",
    "app.use('/api/map', ensureAuthenticated, ensurePlayerApproved, mapHeatmapRoutes)",
    "app.use('/api/shop', ensureAuthenticated, ensurePlayerApproved, shopRoutes)",
  ];
  if (playerFacingMounts.some(mount => !routeSource.includes(mount))) {
    throw new Error('A player-facing router does not use the player-specific approved-guild guard');
  }
  const privilegedMounts = [
    "app.use('/api/nitrado/settings', ensureAuthenticated, ensureApproved, nitradoSettingsRoutes)",
    "app.use('/api/control', ensureAuthenticated, ensureApproved, serverControlRoutes)",
    "app.use('/api/boost', ensureAuthenticated, ensureApproved, boostRoutes)",
  ];
  if (privilegedMounts.some(mount => !routeSource.includes(mount))) {
    throw new Error('A privileged operational route lost the strict approved-guild guard');
  }

  const botLinkSource = require('fs').readFileSync(path.join(__dirname, '..', 'bot/commands/link.js'), 'utf8');
  if (!botLinkSource.includes('verified_by_guild_id, verification_method') ||
      !botLinkSource.includes('VALUES ($1, $2, $3, $4)') ||
      !botLinkSource.includes('[userId, account.id, guild.id, verificationMethod]')) {
    throw new Error('Bot link command does not bind the verifying guild to the linked account');
  }
}

async function testPlayerResourceGuardsAreTenantBound() {
  const { ensurePlayerGuildAccess, ensurePlayerIdentityAccess, ensurePlayerServerAccess } = require('../middleware/serverAccess');
  const runGuard = async (guard, reqOverrides) => {
    const calls = [];
    const req = {
      isAuthenticated: () => true,
      user: { id: 42, is_admin: 0 },
      params: {},
      query: {},
      body: {},
      app: { locals: { db: { async get(sql, params) {
        calls.push({ sql: sql.replace(/\s+/g, ' '), params });
        if (sql.includes('s.id AS server_id')) {
          return {
            server_id: 11,
            guild_id: 13,
            platform_server_id: 'service-11',
            server_status: 'active',
            guild_status: 'approved',
            discord_guild_id: 'guild-13',
            server_role: 'moderator',
            server_role_status: 'active',
          };
        }
        return { id: 7, server_id: 11, guild_id: 13 };
      } } } },
      ...reqOverrides,
    };
    let allowed = false;
    await guard(req, { status() { return this; }, json() { return this; } }, () => { allowed = true; });
    return { allowed, call: calls[0], playerAccess: req.playerAccess };
  };

  const guild = await runGuard(ensurePlayerGuildAccess, { params: { guildId: 'guild-b' } });
  const identity = await runGuard(ensurePlayerIdentityAccess, { params: { identityId: '99' } });
  const server = await runGuard(ensurePlayerServerAccess, { params: { serverId: '11' } });
  if (!guild.allowed || !identity.allowed || !server.allowed) {
    throw new Error('Tenant-bound player resource guards denied valid access');
  }
  if (identity.playerAccess?.serverId !== 11 || identity.playerAccess?.guildId !== 13) {
    throw new Error('Identity guard did not pass its authorized server context downstream');
  }

  const guildPredicates = ["g.status = 'approved'", 'g.discord_guild_id = ?', 'gr.guild_id = g.id', 'spm.guild_id = g.id', "spm.status = 'active'"];
  const identityPredicates = ["g.status = 'approved'", 'spm.identity_id = ?', 'la.id = spm.source_link_id', "spm.status = 'active'"];
  if (guildPredicates.some(predicate => !guild.call.sql.includes(predicate)) ||
      identityPredicates.some(predicate => !identity.call.sql.includes(predicate))) {
    throw new Error('Player resource guards do not bind verification to the requested guild or identity');
  }

  const economySource = require('fs').readFileSync(path.join(__dirname, '..', 'routes/economy.js'), 'utf8');
  const factionsSource = require('fs').readFileSync(path.join(__dirname, '..', 'routes/factions.js'), 'utf8');
  const casinoSource = require('fs').readFileSync(path.join(__dirname, '..', 'routes/casino.js'), 'utf8').replace(/\s+/g, ' ');
  const shopSource = require('fs').readFileSync(path.join(__dirname, '..', 'routes/shop.js'), 'utf8');
  const shopServiceSource = require('fs').readFileSync(path.join(__dirname, '..', 'services/shopFileService.js'), 'utf8');
  if (!economySource.includes('router.use(ensureAuthenticated)') ||
      !economySource.includes("router.param('identityId', ensurePlayerServerAccess)") ||
      !(economySource.includes("router.param('serverId', ensurePlayerServerAccess)") ||
        economySource.includes("router.get('/:serverId/leaderboard', ensurePlayerServerAccess")) ||
      economySource.includes('router.use(ensureAuthenticated, ensurePlayerServerAccess)') ||
      !economySource.includes('return req.playerServerAccess') ||
      !factionsSource.includes("router.param('guildId', ensurePlayerGuildAccess)") ||
      !factionsSource.includes('server_player_memberships') ||
      !casinoSource.includes('resolvePlayerContext(db, identityId, serverId)') ||
      !casinoSource.includes("JOIN servers s ON s.id = pg.server_id AND s.status = 'active'") ||
      !shopSource.includes("router.param('serverId', ensurePlayerServerAccess)") ||
      !shopSource.includes("WHERE si.is_active = true AND s.status = 'active' AND g.status = 'approved'") ||
      !shopSource.includes('spm.server_id = s.id') ||
      !shopSource.includes("router.get('/orders/:identityId', ensurePlayerServerAccess") ||
      !shopServiceSource.includes('Number(item.catalog_server_id) !== Number(order.server_id)') ||
      !shopServiceSource.includes("error: 'Cart contains items from another server'")) {
    throw new Error('Player-facing routers do not apply exact resource guards');
  }

  const accessSource = require('fs').readFileSync(path.join(__dirname, '..', 'middleware/serverAccess.js'), 'utf8');
  if (!accessSource.includes('CAPABILITIES.SERVER_VIEW') ||
      !accessSource.includes('authorizeServer(') ||
      casinoSource.includes('const identity = isAdmin') ||
      casinoSource.includes('FROM linked_accounts la')) {
    throw new Error('Identity-scoped access can fall back to unrelated role or activity evidence');
  }
}

function testHtmlAuthenticationRedirectsWithoutChangingApiResponses() {
  const { ensureAuthenticated } = require('../middleware/auth');

  const runGuard = originalUrl => {
    const response = { statusCode: null, body: null, redirect: null };
    const req = {
      isAuthenticated: () => false,
      originalUrl,
      accepts: type => type === 'html',
    };
    const res = {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return this; },
      redirect(location) { response.redirect = location; return this; },
    };
    ensureAuthenticated(req, res, () => {});
    return response;
  };

  const page = runGuard('/player');
  if (page.redirect !== '/' || page.statusCode !== null) {
    throw new Error('Logged-out HTML page request did not redirect to the landing page');
  }

  const api = runGuard('/api/player/profile');
  if (api.statusCode !== 401 || api.body?.error !== 'Not authenticated' || api.redirect !== null) {
    throw new Error('Logged-out API request did not retain its JSON 401 response');
  }
}

function testPlayerPortalRootDoesNotRedirectAnonymousUsersIntoAuthLoop() {
  const { getPlayerPortalRootRedirect } = require('../src/app/registerRoutes');
  if (getPlayerPortalRootRedirect({ isPlayerPortal: true, isAuthenticated: () => false }) !== null) {
    throw new Error('Anonymous player-portal root request redirects into the protected player route');
  }
  if (getPlayerPortalRootRedirect({ isPlayerPortal: true, isAuthenticated: () => true }) !== '/player') {
    throw new Error('Authenticated player-portal root request does not enter the player portal');
  }
  if (getPlayerPortalRootRedirect({ isPlayerPortal: false, isAuthenticated: () => true }) !== null) {
    throw new Error('Dashboard-host root request redirects to the player portal');
  }
}

function testSensitiveRequestDataIsNotLogged() {
  const fs = require('fs');
  const middlewareSource = fs.readFileSync(path.join(__dirname, '..', 'src/app/registerMiddleware.js'), 'utf8');
  const routesSource = fs.readFileSync(path.join(__dirname, '..', 'src/app/registerRoutes.js'), 'utf8');
  const forbidden = [
    'Cookies received:',
    "console.log('   Session ID:', req.sessionID)",
    "console.log('   Query params:', req.query)",
    "console.log('   Session ID before auth:', req.sessionID)",
  ];

  if (forbidden.some(fragment => middlewareSource.includes(fragment) || routesSource.includes(fragment))) {
    throw new Error('Request or OAuth logs still expose session or authorization credentials');
  }
}

function testPlayerMapAccessIsBoundToRequestedServerGuild() {
  const fs = require('fs');
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes/mapHeatmap.js'), 'utf8').replace(/\s+/g, ' ');
  const authorizationSource = fs.readFileSync(path.join(__dirname, '..', 'services/authorizationService.js'), 'utf8').replace(/\s+/g, ' ');
  const requiredPredicates = [
    "g.status = 'approved'",
    "s.status = 'active'",
    'sra.server_id = s.id',
    'sra.guild_id = s.guild_id',
    'FROM server_player_memberships membership',
    'membership.server_id = s.id',
    "membership.status = 'active'",
    'account.id = membership.source_link_id',
  ];

  if (!routeSource.includes('authorizePlatformServer') ||
      !routeSource.includes('CAPABILITIES.SERVER_VIEW') ||
      requiredPredicates.some(predicate => !authorizationSource.includes(predicate))) {
    throw new Error('Player map access is not bound to the requested server and approved guild');
  }
}

async function testCentralServerAuthorizationDenyFirst() {
  const {
    CAPABILITIES,
    authorizeServer,
  } = require('../services/authorizationService');

  const makeDb = row => ({
    async get(sql, params) {
      if (!sql.includes("g.status = 'approved'") ||
          !sql.includes('s.id = ?') ||
          !sql.includes('server_role_assignments') ||
          !sql.includes('server_player_memberships') ||
          !sql.includes("membership.status = 'active'") ||
          !params.some(value => String(value) === '41')) {
        throw new Error('Authorization query is not bound to the exact approved server');
      }
      return row;
    },
  });

  const actor = { id: 7, is_admin: false };
  const serverBase = {
    server_id: 41,
    guild_id: 4,
    discord_guild_id: 'guild-a',
    platform_server_id: 'service-a',
    guild_status: 'approved',
    server_status: 'active',
  };

  const denied = await authorizeServer(makeDb({ ...serverBase }), actor, 41, CAPABILITIES.SERVER_VIEW);
  if (denied !== null) throw new Error('Unassigned user received server access');

  const legacyModerator = await authorizeServer(
    makeDb({ ...serverBase, guild_role: 'moderator' }),
    actor,
    41,
    CAPABILITIES.SERVER_MODERATE
  );
  if (legacyModerator !== null) throw new Error('Guild-wide moderator role granted server access');

  const assignedModerator = await authorizeServer(
    makeDb({ ...serverBase, server_role: 'moderator', server_role_status: 'active' }),
    actor,
    41,
    CAPABILITIES.SERVER_MODERATE
  );
  if (!assignedModerator || assignedModerator.server.id !== 41) {
    throw new Error('Exact-server moderator assignment was denied');
  }

  const moderatorManage = await authorizeServer(
    makeDb({ ...serverBase, server_role: 'moderator', server_role_status: 'active' }),
    actor,
    41,
    CAPABILITIES.SERVER_MANAGE
  );
  if (moderatorManage !== null) throw new Error('Moderator received server management access');

  const serverAdminOwner = await authorizeServer(
    makeDb({ ...serverBase, server_role: 'admin', server_role_status: 'active' }),
    actor,
    41,
    CAPABILITIES.SERVER_OWNER
  );
  if (serverAdminOwner !== null) throw new Error('Server admin received owner-only access');

  const guildAdminOwner = await authorizeServer(
    makeDb({ ...serverBase, guild_role: 'admin' }),
    actor,
    41,
    CAPABILITIES.SERVER_OWNER
  );
  if (guildAdminOwner !== null) throw new Error('Guild admin received owner-only access');

  const guildOwner = await authorizeServer(
    makeDb({ ...serverBase, guild_role: 'owner' }),
    actor,
    41,
    CAPABILITIES.SERVER_OWNER
  );
  if (!guildOwner) throw new Error('Guild owner was denied owner-only access');

  const playerView = await authorizeServer(
    makeDb({
      ...serverBase,
      player_membership_id: 88,
      player_membership_status: 'active',
      identity_id: 99,
    }),
    actor,
    41,
    CAPABILITIES.SERVER_VIEW
  );
  if (!playerView || playerView.player.identityId !== 99) {
    throw new Error('Active exact-server player membership was denied');
  }

  const playerManage = await authorizeServer(
    makeDb({
      ...serverBase,
      player_membership_id: 88,
      player_membership_status: 'active',
      identity_id: 99,
    }),
    actor,
    41,
    CAPABILITIES.SERVER_MANAGE
  );
  if (playerManage !== null) throw new Error('Player received server management access');
}

async function testServerCapabilityMiddlewareUsesCanonicalContext() {
  const {
    CAPABILITIES,
    ensureServerOwner,
    requireServerCapability,
  } = require('../middleware/serverAccess');
  const makeReq = row => ({
    isAuthenticated: () => true,
    user: { id: 7, discord_id: 'user-7', is_admin: false },
    params: { serverId: '41' },
    query: {},
    body: {},
    app: { locals: { db: { get: async () => row } } },
    originalUrl: '/api/servers/41',
  });
  const makeRes = () => ({
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });

  const deniedReq = makeReq(null);
  const deniedRes = makeRes();
  let deniedNext = false;
  await requireServerCapability(CAPABILITIES.SERVER_VIEW)(
    deniedReq,
    deniedRes,
    () => { deniedNext = true; }
  );
  if (deniedRes.statusCode !== 404 || deniedNext) {
    throw new Error('Unauthorized server capability did not return enumeration-safe 404');
  }

  const allowedReq = makeReq({
    server_id: 41,
    guild_id: 4,
    discord_guild_id: 'guild-a',
    platform_server_id: 'service-a',
    guild_status: 'approved',
    server_status: 'active',
    server_role: 'moderator',
    server_role_status: 'active',
  });
  const allowedRes = makeRes();
  let allowedNext = false;
  await requireServerCapability(CAPABILITIES.SERVER_MODERATE)(
    allowedReq,
    allowedRes,
    () => { allowedNext = true; }
  );
  if (!allowedNext || allowedReq.authorization?.server?.id !== 41) {
    throw new Error('Server capability middleware did not attach canonical context');
  }

  const ownerReq = makeReq({
    server_id: 41,
    guild_id: 4,
    discord_guild_id: 'guild-a',
    platform_server_id: 'service-a',
    guild_status: 'approved',
    server_status: 'active',
    guild_role: 'owner',
  });
  const ownerRes = makeRes();
  let ownerNext = false;
  await ensureServerOwner(ownerReq, ownerRes, () => { ownerNext = true; });
  if (!ownerNext || ownerReq.authorization?.server?.id !== 41) {
    throw new Error('Legacy server-owner guard did not delegate to canonical authorization');
  }
}

function testServerSelectionNeverFallsBackAcrossMultipleServers() {
  const { selectServerForGuild } = require('../bot/utils/nitrado');
  const servers = [
    { id: 11, platform_server_id: 'alpha' },
    { id: 12, platform_server_id: 'beta' },
  ];

  let ambiguousError = null;
  try {
    selectServerForGuild(servers, null);
  } catch (error) {
    ambiguousError = error;
  }
  if (!ambiguousError || ambiguousError.code !== 'SERVER_SELECTION_REQUIRED') {
    throw new Error('Multiple guild servers did not require explicit selection');
  }

  const selected = selectServerForGuild(servers, 'beta');
  if (!selected || selected.id !== 12) {
    throw new Error('Explicit platform server selection did not resolve exact server');
  }

  let foreignError = null;
  try {
    selectServerForGuild(servers, 'foreign');
  } catch (error) {
    foreignError = error;
  }
  if (!foreignError || foreignError.code !== 'SERVER_NOT_FOUND') {
    throw new Error('Foreign server selection did not fail closed');
  }

  if (selectServerForGuild([servers[0]], null).id !== 11) {
    throw new Error('Single-server guild did not resolve its sole server');
  }
}

function testBotServerCommandsAcceptExplicitServerSelection() {
  const fs = require('fs');
  const commands = [
    'uptime.js',
    'priority.js',
    'economy.js',
    'ban-list.js',
    'whitelist.js',
    'ban.js',
  ];
  for (const command of commands) {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'bot/commands', command),
      'utf8'
    );
    if (!source.includes("setName('server')") ||
        !source.includes("interaction.options.getString('server')") ||
        !source.includes('interaction.authorizedServerId')) {
      throw new Error(`${command} cannot select an exact server in a multi-server guild`);
    }
  }
}

function testRemainingBotCommandsRejectImplicitServerSelection() {
  const fs = require('fs');
  for (const command of ['location.js', 'online.js', 'wipe-info.js', 'setup-status.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'bot/commands', command), 'utf8');
    if (!source.includes("setName('server')") ||
        !source.includes("interaction.options.getString('server')") ||
        !source.includes('interaction.authorizedServerId') ||
        source.includes('ORDER BY s.id ASC\n          LIMIT 1') ||
        source.includes('ORDER BY s.id ASC LIMIT 1')) {
      throw new Error(`${command} still selects the first active server`);
    }
  }
}

function testTenantRbacMigrationDefinesCompositeOwnership() {
  const fs = require('fs');
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'db/migrations/050_multi_tenant_rbac.js'),
    'utf8'
  );
  const required = [
    'server_role_assignments',
    'server_player_memberships',
    'user_id INTEGER NOT NULL',
    'source_link_id INTEGER NOT NULL',
    'security_audit_events',
    'guild_setup_state',
    'UNIQUE (id, guild_id)',
    'FOREIGN KEY (server_id, guild_id)',
    "CHECK (role IN ('admin', 'moderator'))",
    "CHECK (status IN ('active', 'suspended', 'revoked'))",
  ];
  const missing = required.filter(value => !migration.includes(value));
  if (missing.length) {
    throw new Error(`Tenant RBAC migration is missing: ${missing.join(', ')}`);
  }
  const auditTable = migration.slice(
    migration.indexOf('CREATE TABLE IF NOT EXISTS security_audit_events'),
    migration.indexOf('CREATE INDEX IF NOT EXISTS security_audit_events_scope_idx')
  );
  if (auditTable.includes('FOREIGN KEY (server_id, guild_id)')) {
    throw new Error('Security audit events lose guild scope when a server is deleted');
  }
}

function testFeedConfigurationIsExactServerScoped() {
  const fs = require('fs');
  const migrationPath = path.join(
    __dirname,
    '..',
    'db/migrations/051_server_scoped_runtime_config.js'
  );
  if (!fs.existsSync(migrationPath)) {
    throw new Error('Server-scoped runtime configuration migration is missing');
  }

  const migration = fs.readFileSync(migrationPath, 'utf8');
  const worker = fs.readFileSync(
    path.join(__dirname, '..', 'workers/feedProcessor.js'),
    'utf8'
  );
  const queue = fs.readFileSync(
    path.join(__dirname, '..', 'utils/feedEventQueue.js'),
    'utf8'
  );
  const feedRoutes = fs.readFileSync(path.join(__dirname, '..', 'routes/feeds.js'), 'utf8');
  const feedCommand = fs.readFileSync(path.join(__dirname, '..', 'bot/commands/setup-feeds.js'), 'utf8');
  const statusCommand = fs.readFileSync(path.join(__dirname, '..', 'bot/commands/setup-status.js'), 'utf8');
  const restartCommand = fs.readFileSync(path.join(__dirname, '..', 'bot/commands/notify-restart.js'), 'utf8');
  const alertCommand = fs.readFileSync(path.join(__dirname, '..', 'bot/commands/alert-threshold.js'), 'utf8');
  const statusService = fs.readFileSync(path.join(__dirname, '..', 'bot/services/serverStatusService.js'), 'utf8');
  const aiService = fs.readFileSync(path.join(__dirname, '..', 'services/aiService.js'), 'utf8');
  const accessRoute = fs.readFileSync(path.join(__dirname, '..', 'routes/access.js'), 'utf8');
  const reportCommand = fs.readFileSync(path.join(__dirname, '..', 'bot/commands/report.js'), 'utf8');
  const requiredMigration = [
    'ADD COLUMN IF NOT EXISTS server_id',
    'ON discord_feeds(server_id, feed_type)',
    'ON feed_templates(server_id, feed_type, event_type)',
    'COUNT(*) = 1',
    'SET enabled = 0',
    "feature_name = 'server_status'",
    'ALTER TABLE player_reports',
  ];
  const missingMigration = requiredMigration.filter(value => !migration.includes(value));
  if (missingMigration.length) {
    throw new Error(`Runtime configuration migration is missing: ${missingMigration.join(', ')}`);
  }

  const requiredWorker = [
    'SELECT DISTINCT guild_id, server_id FROM feed_events',
    'processServerFeedEvents(db, guild_id, server_id)',
    'WHERE guild_id = ? AND server_id = ?',
    'claimPendingEvents(db, guildId, serverId, 50, enabledFeedTypes)',
    'getTemplate(db, event.server_id, event.feed_type, event.event_type)',
  ];
  const missingWorker = requiredWorker.filter(value => !worker.includes(value));
  if (missingWorker.length) {
    throw new Error(`Feed worker is not exact-server scoped: ${missingWorker.join(', ')}`);
  }

  if (!queue.includes('getPendingEvents(db, guildId, serverId, limit = 100, feedTypes = null)') ||
      !queue.includes('WHERE guild_id = ? AND server_id = ? AND processed = 0')) {
    throw new Error('Feed queue reads are not exact-server scoped');
  }

  for (const [name, source, required] of [
    ['feed API', feedRoutes, ['authorization.server.id', 'server_id = ?', 'ON CONFLICT(server_id, feed_type)']],
    ['feed command', feedCommand, ['interaction.authorizedServerId', 'server_id', 'ON CONFLICT (server_id, feed_type)']],
    ['status command', statusCommand, ['server_features', 'ON CONFLICT (server_id, feature_name)']],
    ['restart command', restartCommand, ['interaction.authorizedServerId', 'ON CONFLICT (server_id, discord_user_id)']],
    ['alert command', alertCommand, ['interaction.authorizedServerId', 'server_id = $2']],
    ['status service', statusService, ['FROM server_features sf', 'FROM restart_notify_prefs', 'FROM player_count_alerts', 'server_id = $2']],
    ['AI status configuration', aiService, ["FROM server_features WHERE feature_name = 'server_status'", 'server_id = $1']],
    ['onboarding status configuration', accessRoute, ['FROM server_features sf', 'JOIN servers configured_server']],
    ['report command', reportCommand, ['interaction.authorizedServerId', 'server_id = $2', 'ON CONFLICT (server_id, feed_type)']],
  ]) {
    const missing = required.filter(value => !source.includes(value));
    if (missing.length) throw new Error(`${name} is not exact-server scoped: ${missing.join(', ')}`);
  }
}

function testServerRoleApiUsesCanonicalManageAuthorization() {
  const fs = require('fs');
  const routePath = path.join(__dirname, '..', 'routes/access.js');
  if (!fs.existsSync(routePath)) {
    throw new Error('Server-scoped role assignment API is missing');
  }
  const source = fs.readFileSync(routePath, 'utf8');
  const required = [
    'requireServerCapability(CAPABILITIES.GUILD_MANAGE)',
    'req.authorization.guild.id',
    'req.authorization.server.id',
    'gr.guild_id = ?',
    'server_role_assignments',
    'security_audit_events',
    'target_type, target_id, metadata',
    "result: 'allowed'",
    "status = 'active'",
    'await lockUserRoleMutations(',
    'await lockActiveServerTenant(',
    'await hasLockedServerManageAuthority(',
    'AND user_id = ? AND status = \'active\'',
    "return res.status(404).json({ error: 'Not found' })",
  ];
  const missing = required.filter(value => !source.includes(value));
  if (missing.length) {
    throw new Error(`Server role API is missing tenant guards: ${missing.join(', ')}`);
  }

  const routeRegistration = fs.readFileSync(
    path.join(__dirname, '..', 'src/app/registerRoutes.js'),
    'utf8'
  );
  if (!routeRegistration.includes("app.use('/api/access', ensureAuthenticated, accessRoutes)")) {
    throw new Error('Server-scoped access API is not mounted behind authentication');
  }
}

function testPlayerLinkRequiresExactServerWhenAmbiguous() {
  const fs = require('fs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'bot/commands/link.js'), 'utf8');
  const website = fs.readFileSync(path.join(__dirname, '..', 'routes/accountLinking.js'), 'utf8');
  const portal = fs.readFileSync(path.join(__dirname, '..', 'public/js/player-portal.js'), 'utf8');
  const required = [
    "setName('server')",
    "interaction.options.getString('server')",
    'interaction.authorizedServerId',
    "s.status = 'active'",
    's.id = $3',
    'More than one server has that gamertag',
    'server:${account.platform_server_id}',
  ];
  const missing = required.filter(value => !source.includes(value));
  if (missing.length || source.includes('SELECT DISTINCT ON (pi.id)')) {
    throw new Error(`Player linking can select an arbitrary server: ${missing.join(', ')}`);
  }
  if (!website.includes('const { gameAccountId, guildId, serverId } = req.body') ||
      !website.includes('s.id = ?') ||
      !portal.includes('serverId: selectedServer')) {
    throw new Error('Website player linking can select an arbitrary server');
  }
}

function testGuildServerListingFiltersEveryServerByActor() {
  const fs = require('fs');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'routes/guilds.js'),
    'utf8'
  );
  const required = [
    'LEFT JOIN server_role_assignments sra',
    "gr.role IN ('owner', 'admin')",
    "sra.status = 'active'",
    "g.status = 'approved'",
    "s.status = 'active'",
  ];
  const missing = required.filter(value => !source.includes(value));
  if (missing.length || source.includes("router.get('/:guildId/servers', requireRole('user')")) {
    throw new Error(`Guild server listing is not actor-filtered: ${missing.join(', ')}`);
  }
}

function testReviewedTenantBoundariesAreEnforced() {
  const fs = require('fs');
  const serverAccess = fs.readFileSync(path.join(__dirname, '..', 'middleware/serverAccess.js'), 'utf8');
  if (!serverAccess.includes('CAPABILITIES.SERVER_OWNER') ||
      !serverAccess.includes("s.status = 'active'")) {
    throw new Error('Owner-only or inactive-server boundary is missing');
  }

  const logParser = fs.readFileSync(path.join(__dirname, '..', 'routes/logParser.js'), 'utf8');
  if (!logParser.includes("router.get('/tracked-players', ensureAuthenticated, ensurePlatformServerOwner") ||
      !logParser.includes("router.get('/detect-alts', ensureAuthenticated, ensurePlatformServerOwner")) {
    throw new Error('Sensitive player/device exports are not bound to exact-server operator access');
  }

  const loot = fs.readFileSync(path.join(__dirname, '..', 'routes/lootFinder.js'), 'utf8');
  if (!loot.includes('ensurePlatformServerOwner') ||
      !loot.includes('req.platformServerAccess.serverId')) {
    throw new Error('Loot heatmap is not bound to authorized server context');
  }

  const discord = fs.readFileSync(path.join(__dirname, '..', 'routes/discord.js'), 'utf8');
  if (!discord.includes('ensureApprovedGuildOperator') ||
      !discord.includes('req.guildAccess.discordGuildId')) {
    throw new Error('Discord channel enumeration is not bound to an authorized guild');
  }
}

function testFeedWorkerKeepsStatsAndEventsOnExactServer() {
  const fs = require('fs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'workers/feedProcessor.js'), 'utf8');
  const required = [
    'WHERE s.id = ? AND g.discord_guild_id = ?',
    'fetchKillStreak(db, killerIdentityId, serverId)',
    'fetchDeathStreak(db, victimIdentityId, serverId)',
    'fetchServerRank(db, killerIdentityId, serverId)',
    'fetchKDStats(db, killerIdentityId, serverId)',
    'WHERE server_id = $2',
    "WHERE s.id = $1 AND s.status = 'active'",
  ];
  const missing = required.filter(value => !source.includes(value));
  if (missing.length || source.includes('fetchWalletBalance(db, killerIdentityId)')) {
    throw new Error(`Feed worker can expose cross-server statistics: ${missing.join(', ')}`);
  }
}

async function testFeedQueueSuppressesUnconfiguredEvents() {
  const { queueKillEvent } = require('../utils/feedEventQueue');
  let writes = 0;
  const db = {
    async get() { return null; },
    async run() { writes += 1; },
  };

  const queued = await queueKillEvent(db, 'guild', 42, 'kill_feed', 'player_kill', {});
  if (queued !== false || writes !== 0) {
    throw new Error('Events without an enabled matching feed were retained indefinitely');
  }
}

async function testFeedDisabledSuppressionIncludesExpiredLeases() {
  const { suppressDisabledFeedEvents } = require('../utils/feedEventQueue');
  let statement = '';
  await suppressDisabledFeedEvents({
    async run(sql) { statement = sql.replace(/\s+/g, ' '); },
  }, 'guild', 42, []);
  if (!/processed = 0/.test(statement) ||
      !/processed = 3 AND lease_expires_at <= CURRENT_TIMESTAMP/.test(statement)) {
    throw new Error('Disabled feeds leave expired delivery leases permanently stranded');
  }
}

async function testFeedClaimsUseLeasesAndSkipLocked() {
  const { claimPendingEvents } = require('../utils/feedEventQueue');
  if (typeof claimPendingEvents !== 'function') {
    throw new Error('Feed queue does not expose atomic event claiming');
  }
  let statement = '';
  const rows = await claimPendingEvents({
    async query(sql) {
      statement = sql.replace(/\s+/g, ' ');
      return [{ id: 9, claim_token: 'lease' }];
    },
  }, 'guild', 42, 25, ['kill_feed']);
  if (rows.length !== 1 || !/FOR UPDATE SKIP LOCKED/.test(statement) ||
      !/lease_expires_at/.test(statement) || !/RETURNING/.test(statement)) {
    throw new Error('Feed claims are not atomic, leased, and recoverable');
  }
}

async function testFeedCompletionAndRetryAreFenced() {
  const { markEventProcessed, markEventFailed } = require('../utils/feedEventQueue');
  if (typeof markEventFailed !== 'function') throw new Error('Feed failures are not retryable');
  const writes = [];
  const db = { async run(sql, params) { writes.push({ sql: sql.replace(/\s+/g, ' '), params }); } };
  await markEventProcessed(db, 9, true, 'claim-a');
  await markEventFailed(db, 9, 'claim-a', new Error('temporary'), 3);
  if (!writes[0].sql.includes('claim_token = ?') ||
      !writes[1].sql.includes('next_attempt_at') ||
      !writes[1].sql.includes('attempt_count') ||
      !writes[1].sql.includes('claim_token = ?')) {
    throw new Error('Feed completion or retry can be written by a stale worker');
  }
}

async function testDiscordPostingHasFiniteTimeout() {
  const { postViaWebhook } = require('../utils/discordPoster');
  const originalFetch = global.fetch;
  let aborted = false;
  global.fetch = (_url, options) => new Promise((resolve, reject) => {
    if (!options.signal) return;
    options.signal.addEventListener('abort', () => {
      aborted = true;
      reject(options.signal.reason);
    });
  });
  try {
    const completed = await Promise.race([
      postViaWebhook('https://discord.com/api/webhooks/1/token', { embeds: [] }, true, 10)
        .then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 100)),
    ]);
    if (!completed || !aborted) throw new Error('Discord post did not honor a finite timeout');
  } finally {
    global.fetch = originalFetch;
  }
}

async function testFeedWorkerUsesDiscordGuildNamespaceForQueuedEvents() {
  const { processFeedEvents } = require('../workers/feedProcessor');
  const discordGuildId = '900000000000000002';
  let serverLookup = null;
  let queueLookup = null;
  const db = {
    async query(sql) {
      if (sql.includes('SELECT DISTINCT guild_id, server_id FROM feed_events')) {
        queueLookup = sql.replace(/\s+/g, ' ');
        return [{ guild_id: discordGuildId, server_id: 42 }];
      }
      if (sql.includes('SELECT * FROM feed_events')) {
        return [{
          id: 5,
          guild_id: discordGuildId,
          server_id: 42,
          feed_type: 'kill_feed',
          event_type: 'player_kill',
          event_data: '{}',
        }];
      }
      return [];
    },
    async get(sql, params) {
      if (sql.includes("feed_type = 'kill_feed'")) {
        return { channel_id: 'channel', webhook_url: null, settings: '{}' };
      }
      if (sql.includes("feed_type = 'faction_feed'")) return null;
      if (sql.includes('FROM servers s')) {
        serverLookup = { sql: sql.replace(/\s+/g, ' '), params };
        return null;
      }
      return null;
    },
    async run() {},
  };

  await processFeedEvents(db);
  if (!queueLookup?.includes('lease_expires_at') || !queueLookup.includes('processed = 3')) {
    throw new Error('Expired feed delivery leases cannot be reclaimed');
  }
  if (!serverLookup ||
      !serverLookup.sql.includes('g.discord_guild_id = ?') ||
      String(serverLookup.params[0]) !== '42' ||
      String(serverLookup.params[1]) !== discordGuildId) {
    throw new Error('Feed worker compared a queued Discord guild ID to an internal guild ID');
  }
}

async function testFeedWorkerDoesNotRouteFactionEventsToKillFeed() {
  const { processFeedEvents } = require('../workers/feedProcessor');
  const discordGuildId = '900000000000000002';
  let routedToKillFeed = false;
  let eventStatusWrites = 0;
  let pendingRead = null;
  const db = {
    async query(sql, params) {
      if (sql.includes('SELECT DISTINCT guild_id, server_id FROM feed_events')) {
        return [{ guild_id: discordGuildId, server_id: 42 }];
      }
      if (sql.includes('SELECT * FROM feed_events')) {
        pendingRead = { sql: sql.replace(/\s+/g, ' '), params };
        return [{
          id: 6,
          guild_id: discordGuildId,
          server_id: 42,
          feed_type: 'faction_feed',
          event_type: 'territory_capture',
          event_data: '{}',
        }];
      }
      return [];
    },
    async get(sql) {
      if (sql.includes("feed_type = 'kill_feed'")) {
        return { channel_id: 'kill-channel', webhook_url: null, settings: '{}' };
      }
      if (sql.includes("feed_type = 'faction_feed'")) return null;
      if (sql.includes('FROM servers s')) {
        routedToKillFeed = true;
        return null;
      }
      return null;
    },
    async run(sql) {
      if (sql.includes('UPDATE feed_events')) eventStatusWrites += 1;
    },
  };

  await processFeedEvents(db);

  if (routedToKillFeed) {
    throw new Error('A faction event fell through to an enabled kill feed');
  }
  if (eventStatusWrites !== 1) {
    throw new Error('An event with no matching enabled feed was not terminally suppressed');
  }
  if (!pendingRead?.sql.includes('feed_type IN (?)') ||
      !pendingRead.sql.includes('FOR UPDATE SKIP LOCKED') ||
      JSON.stringify(pendingRead.params?.slice(0, 4)) !== JSON.stringify([discordGuildId, 42, 'kill_feed', 50])) {
    throw new Error('Pending feed reads can be starved by events whose feed type is disabled');
  }
}

async function testMapHeatmapsRejectInactiveServers() {
  const router = require('../routes/mapHeatmap');
  const route = router.stack.find(layer => layer.route?.path === '/kill-heatmap');
  const handler = route?.route?.stack?.[route.route.stack.length - 1]?.handle;
  if (!handler) throw new Error('Kill heatmap handler was not found');

  let response = null;
  const req = {
    app: {
      locals: {
        db: {
          async get(sql) {
            return sql.includes("s.status = 'active'") ? null : { id: 41 };
          },
          async query() {
            throw new Error('Inactive server data query should not run');
          },
        },
      },
    },
    query: { serverId: 'service-inactive' },
    user: { id: 7, is_admin: true },
  };
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      response = { statusCode: this.statusCode, body };
      return this;
    },
  };

  await handler(req, res);
  if (response?.statusCode !== 404) {
    throw new Error('Inactive server retained access to player heatmap history');
  }
}

function testFeedDestinationsAreBoundToDiscordGuild() {
  const fs = require('fs');
  const poster = fs.readFileSync(path.join(__dirname, '..', 'utils/discordPoster.js'), 'utf8');
  const worker = fs.readFileSync(path.join(__dirname, '..', 'workers/feedProcessor.js'), 'utf8');
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes/feeds.js'), 'utf8');
  const status = fs.readFileSync(path.join(__dirname, '..', 'bot/services/serverStatusService.js'), 'utf8');
  if (!poster.includes('validateDiscordDestination') ||
      !poster.includes('channel.guild_id') ||
      !poster.includes('webhook.guild_id') ||
      !worker.includes('validateDiscordDestination(') ||
      !worker.includes('server.discord_guild_id') ||
      !routes.includes('validateDiscordDestination(scope.guildId, channelId, webhookUrl)') ||
      !status.includes('channel.guildId === guildDiscordId')) {
    throw new Error('Feed destinations are not verified against the configured Discord guild');
  }
}

function testPlayerGuildDiscoveryUsesApplicationAuthorization() {
  const fs = require('fs');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src/app/registerRoutes.js'),
    'utf8'
  );
  const start = source.indexOf("app.get('/api/user/guilds-with-servers'");
  const end = source.indexOf("app.get('/api/", start + 20);
  const route = source.slice(start, end === -1 ? source.length : end);
  const required = [
    'g.discord_guild_id',
    'server_role_assignments',
    'server_player_memberships',
    'linked_accounts',
    "g.status = 'approved'",
    "s.status = 'active'",
  ];
  const missing = required.filter(value => !route.includes(value));
  if (start === -1 || missing.length || route.includes('SELECT DISTINCT guild_id FROM servers')) {
    throw new Error(`Player guild discovery is not tenant-authorized: ${missing.join(', ')}`);
  }
}

function testOnboardingSetupStatusIsResolvedFromAuthenticatedOwnership() {
  const fs = require('fs');
  const access = fs.readFileSync(path.join(__dirname, '..', 'routes/access.js'), 'utf8');
  const onboarding = fs.readFileSync(path.join(__dirname, '..', 'public/js/onboarding.js'), 'utf8');
  const splash = fs.readFileSync(path.join(__dirname, '..', 'public/splash.html'), 'utf8');
  const requiredAccess = [
    "router.get('/setup'",
    "gr.role IN ('owner', 'admin')",
    'gr.user_id = ?',
    'guild_tokens',
    'server_role_assignments',
    "g.status IN ('pending', 'approved')",
  ];
  const missing = requiredAccess.filter(value => !access.includes(value));
  if (missing.length) {
    throw new Error(`Setup status is not actor-derived: ${missing.join(', ')}`);
  }
  if (!onboarding.includes("fetch('/api/access/setup')") ||
      !splash.includes('id="setupSteps"') ||
      splash.includes('id="token"')) {
    throw new Error('Onboarding UI is not driven by safe server-side setup status');
  }
  if (!splash.includes('href="/auth/discord"') ||
      !onboarding.includes('response.status === 401') ||
      !onboarding.includes('Sign in with Discord') ||
      onboarding.includes("if(!r.ok) throw new Error('setup')")) {
    throw new Error('Anonymous onboarding does not provide an actionable Discord sign-in flow');
  }
}

function testADMConnectingFormat() {
  const { parseADMLog } = require('../routes/logParser');
  const players = parseADMLog(
    '17:44:12 | Player "ExamplePlayer" (id=0123456789ABCDEF0123456789ABCDEF01234567) is connecting'
  );

  if (players.length !== 1 || players[0].playerName !== 'ExamplePlayer') {
    throw new Error('ADM parser did not recognize the "is connecting" format');
  }
}

// Minimal valid environment for validateEnv()
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '900000000000000002';
const testCrypto = require('crypto');
process.env.DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || testCrypto.randomBytes(16).toString('hex');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || testCrypto.randomBytes(32).toString('hex');
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || testCrypto.randomBytes(32).toString('hex');
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || testCrypto.randomBytes(24).toString('hex');
process.env.PORT = process.env.PORT || '3000';

(async () => {
  try {
    const { validateEnv } = require('../utils/envValidator');
    validateEnv();
    console.log('✅ validateEnv passed');

    await testPostgresTransactionIsolation();
    console.log('✅ PostgreSQL transaction isolation passed');

    await testPostgresTransactionRollbackHooksResolveCommitOutcome();
    console.log('✅ PostgreSQL transaction commit-outcome compensation passed');

    await testPostgresMutableVerifierCannotOverrideCommittedXact();
    console.log('✅ PostgreSQL mutable-marker commit recovery passed');

    await testPostgresCommitRecoveryHandsOffLocksBeforeRecovery();
    console.log('✅ PostgreSQL recovery lock handoff passed');

    await testPostgresDestroysClientAfterUnlockFailure();
    console.log('✅ PostgreSQL failed-cleanup client destruction passed');

    await testPostgresDestroysClientAfterAmbiguousLockAcquisition();
    console.log('✅ PostgreSQL ambiguous-lock client destruction passed');

    await testPostgresAdvisoryLockAcquisitionIsBounded();
    console.log('✅ PostgreSQL advisory-lock timeout and cleanup passed');

    await testShopFileMutationsFailClosedOnMalformedContent();
    console.log('✅ Shop malformed-file fail-closed behavior passed');

    testShopSpawnEntriesPreserveDayzXyzCoordinateOrder();
    console.log('✅ Shop DayZ X/Y/Z coordinate mapping passed');

    await testShopAppendsStandardObjectSpawnerJson();
    console.log('✅ Standard object-spawner JSON append passed');

    await testShopRegistersObjectSpawnerWithoutOverwritingGameplaySettings();
    console.log('✅ Object-spawner cfgGameplay registration passed');

    testShopRejectsUnprovisionableCatalogItemsBeforeCheckout();
    console.log('✅ Shop provisioning preflight passed');

    await testSpawnsecondaryReferencesMustExist();
    console.log('✅ Shop spawnsecondary event reference validation passed');

    await testCfgEconomyCoreUsesStructuredRegistrationDetection();
    console.log('✅ Structured cfgeconomycore registration detection passed');

    await testEventXmlValidationAndSafeRewriting();
    console.log('✅ Event XML validation and safe rewriting passed');

    await testExpiredRentalMetadataPreflightPrecedesMutation();
    console.log('✅ Expired rental metadata preflight passed');

    testShopEntryIdentifiersUseDashboardNamespaceAndPreserveLegacyCleanup();
    console.log('✅ Shop entry namespace and immutable cleanup metadata passed');

    await testShopCheckoutRevalidatesExactServerAuthority();
    console.log('✅ Shop operation-time authority recheck passed');

    await testShopLockContentionReturnsControlledBusyError();
    console.log('✅ Shop lock-contention response passed');

    await testShopFileRollbackIgnoresCancelledRequestSignal();
    console.log('✅ Shop cancellation-independent rollback passed');

    await testShopCheckoutPreventsDuplicateSubmissions();
    console.log('✅ Shop duplicate-submission suppression passed');

    await testShopRollbackRejectsConcurrentProviderEdits();
    console.log('✅ Shop rollback concurrent-edit rejection passed');

    await testShopRollbackVerifiesRestoredProviderContent();
    console.log('✅ Shop rollback restore verification passed');

    await testShopRollbackRestoresAmbiguousSuccessfulUpload();
    console.log('✅ Shop ambiguous-upload rollback passed');

    await testShopFileMutationJournalDetectsConcurrentProviderEdits();
    console.log('✅ Shop provider compare-before-write and rollback passed');

    await testNitradoDeleteUsesFormEncodedBody();
    console.log('✅ Nitrado delete transport passed');

    await testCentralNitradoHttpTimeoutsAndSanitizedErrors();
    console.log('✅ Central Nitrado HTTP timeout and error handling passed');

    await testSchemaVersionReadErrorsFailClosed();
    console.log('✅ Schema version read errors fail closed passed');

    testNitradoPathNormalization();
    console.log('✅ Nitrado path normalization passed');

    testNitradoApiPathToFtpPath();
    console.log('✅ Nitrado API-to-FTP path conversion passed');

    testNitradoIdentityExtraction();
    console.log('✅ Nitrado immutable identity extraction passed');

    await testExactPlatformServerOwnerGuard();
    console.log('✅ Exact platform-server owner guard passed');

    await testExactApprovedGuildOperatorGuard();
    console.log('✅ Exact approved-guild operator guard passed');

    testPlayerLinkEmoteChallenge();
    console.log('✅ Player-link emote challenge passed');

    testProductionDiagnosticSessionRoutesAreAbsent();
    console.log('✅ Production diagnostic session routes absent passed');

    testStaticMiddlewareCannotServePrivilegedHtml();
    console.log('✅ Static HTML route bypass protection passed');

    testDashboardAuthorizationErrorsFailClosed();
    console.log('✅ Dashboard authorization error fail-closed passed');

    testCriticalNitradoRoutersMountExactServerGuards();
    console.log('✅ Critical Nitrado routers mount exact server guards passed');

    testTenantOwnershipMigrationConstraints();
    console.log('✅ Tenant ownership migration constraints passed');

    testRegisterTokenNeverReassignsServerGuilds();
    console.log('✅ Register-token server ownership binding passed');

    testWebsiteServerRegistrationRequiresBoundAccountService();
    console.log('✅ Website server registration account binding passed');

    testDashboardTokenRegistrationBindsNitradoIdentity();
    console.log('✅ Dashboard token registration account binding passed');

    testRotationPresetOperationsAreBoundToExactServer();
    console.log('✅ Rotation preset exact-server binding passed');

    testAiAssistantUsesCspCompatibleRuntimeRoutes();
    console.log('✅ AI Assistant CSP and runtime route wiring passed');

    await testBotCommandsRequireApprovedGuild();
    console.log('✅ Bot command approved-guild gate passed');

    await testBotCommandsAuthorizeActorForExactServer();
    console.log('✅ Bot exact-server actor authorization passed');

    testPlayerLinkVerificationPolicyIsExactServerScoped();
    console.log('✅ Exact-server player-link verification policy passed');

    await testDiscordRoleAutomationUsesExactServerSettings();
    console.log('✅ Exact-server Discord role automation passed');

    testExpiredPlayerLinkChallengesReleaseIdentityBeforeOwnershipChecks();
    console.log('✅ Expired player identity challenges release claims passed');

    testBotAggregatesAreExactServerScoped();
    console.log('✅ Bot aggregate commands are exact-server scoped passed');

    testStatusDeliveryIsBoundToFeatureGuild();
    console.log('✅ Server status delivery target binding passed');

    testLogSyncBindsEveryServerToOneAuthorizedGuild();
    console.log('✅ Log sync exact guild/server binding passed');

    testBotHeartbeatClassification();
    console.log('✅ Bot heartbeat classification passed');

    await testLegacyMigrationFailsClosed();
    console.log('✅ Legacy migration fails closed passed');

    await testMigrationAndTrackingAreAtomic();
    console.log('✅ PostgreSQL migration atomicity passed');

    await testMigrationRunnerFailsClosedAndSerializes();
    console.log('✅ PostgreSQL migration serialization and validation passed');

    await testLegacySchemaDetectionErrorsFailClosed();
    console.log('✅ Legacy schema detection errors fail closed passed');

    testSchemaStateClassificationFailsClosed();
    console.log('✅ Schema state classification passed');

    testErrorHandlerOnlyClassifiesPostgresSqlState();
    console.log('✅ PostgreSQL error classification passed');

    testProductionRequiresPostgresPassword();
    console.log('✅ Production PostgreSQL password requirement passed');

    await testApprovedGuildAccessIncludesVerifiedPlayers();
    console.log('✅ Verified player approved-guild access passed');

    await testPlayerResourceGuardsAreTenantBound();
    console.log('✅ Player resource tenant boundaries passed');

    testHtmlAuthenticationRedirectsWithoutChangingApiResponses();
    console.log('✅ HTML/API authentication response split passed');

    testPlayerPortalRootDoesNotRedirectAnonymousUsersIntoAuthLoop();
    console.log('✅ Player portal anonymous root redirect-loop protection passed');

    testSensitiveRequestDataIsNotLogged();
    console.log('✅ Sensitive request logging protection passed');

    testPlayerMapAccessIsBoundToRequestedServerGuild();
    console.log('✅ Player map tenant-bound access passed');

    await testCentralServerAuthorizationDenyFirst();
    console.log('✅ Central exact-server authorization passed');

    await testServerCapabilityMiddlewareUsesCanonicalContext();
    console.log('✅ Server capability middleware context passed');

    testServerSelectionNeverFallsBackAcrossMultipleServers();
    console.log('✅ Explicit multi-server bot selection passed');

    testBotServerCommandsAcceptExplicitServerSelection();
    console.log('✅ Bot commands expose exact server selection passed');

    testRemainingBotCommandsRejectImplicitServerSelection();
    console.log('✅ Remaining bot commands reject implicit server selection passed');

    testTenantRbacMigrationDefinesCompositeOwnership();
    console.log('✅ Tenant RBAC schema constraints passed');

    testFeedConfigurationIsExactServerScoped();
    console.log('✅ Feed configuration exact-server scope passed');

    testServerRoleApiUsesCanonicalManageAuthorization();
    console.log('✅ Server role API canonical authorization passed');

    testPlayerLinkRequiresExactServerWhenAmbiguous();
    console.log('✅ Player link exact-server selection passed');

    testGuildServerListingFiltersEveryServerByActor();
    console.log('✅ Guild server listing actor filtering passed');

    testReviewedTenantBoundariesAreEnforced();
    console.log('✅ Reviewed tenant boundaries passed');

    testFeedWorkerKeepsStatsAndEventsOnExactServer();
    console.log('✅ Feed worker exact-server statistics passed');

    await testFeedQueueSuppressesUnconfiguredEvents();
    console.log('✅ Feed queue disabled-feed suppression passed');

    await testFeedDisabledSuppressionIncludesExpiredLeases();
    console.log('✅ Feed queue expired disabled-lease suppression passed');

    await testFeedClaimsUseLeasesAndSkipLocked();
    console.log('✅ Feed queue transactional claims passed');

    await testFeedCompletionAndRetryAreFenced();
    console.log('✅ Feed queue fenced completion and retry passed');

    await testDiscordPostingHasFiniteTimeout();
    console.log('✅ Discord post timeout passed');

    await testFeedWorkerUsesDiscordGuildNamespaceForQueuedEvents();
    console.log('✅ Feed worker guild identifier namespace passed');

    await testFeedWorkerDoesNotRouteFactionEventsToKillFeed();
    console.log('✅ Feed worker event-type routing passed');

    await testMapHeatmapsRejectInactiveServers();
    console.log('✅ Inactive server map denial passed');

    testFeedDestinationsAreBoundToDiscordGuild();
    console.log('✅ Feed destination guild binding passed');

    testPlayerGuildDiscoveryUsesApplicationAuthorization();
    console.log('✅ Player guild discovery authorization passed');

    testOnboardingSetupStatusIsResolvedFromAuthenticatedOwnership();
    console.log('✅ Authenticated onboarding setup status passed');

    testADMConnectingFormat();
    console.log('✅ ADM connecting format passed');
  } catch (err) {
    console.error('❌ Unit test failed:', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    Object.keys(process.env).forEach(k => delete process.env[k]);
    Object.assign(process.env, OLD_ENV);
  }

  if (!process.exitCode) {
    console.log('\nAll unit tests passed');
  }
})();
