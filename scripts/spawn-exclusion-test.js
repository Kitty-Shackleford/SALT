'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {
  clusterFlagEvidence,
  refreshFlagCandidates,
  listExclusionZones,
  findConfirmedExclusion,
} = require('../services/spawnExclusionService');

function testNearbyFlagEvidenceFormsOneCandidate() {
  const candidates = clusterFlagEvidence([
    { id: 12, pos_x: 1000, pos_y: 2000, pos_z: 12, timestamp: '2026-08-01T00:00:00Z' },
    { id: 10, pos_x: 1040, pos_y: 2030, pos_z: 14, timestamp: '2026-08-03T00:00:00Z' },
    { id: 30, pos_x: 4000, pos_y: 5000, pos_z: 20, timestamp: '2026-08-02T00:00:00Z' },
  ], { clusterRadius: 100, defaultExclusionRadius: 200 });

  assert.equal(candidates.length, 2);
  assert.deepStrictEqual(candidates[0].sourceEventIds, [10, 12]);
  assert.equal(candidates[0].sourceKey, 'territory-flag:10');
  assert.equal(candidates[0].evidenceCount, 2);
  assert.equal(candidates[0].centerX, 1020);
  assert.equal(candidates[0].centerZ, 2015);
  assert.equal(candidates[0].radius, 200);
  assert.equal(candidates[0].lastEvidenceAt, '2026-08-03T00:00:00.000Z');
}

function testBridgingFlagEvidenceMergesConnectedClusters() {
  const candidates = clusterFlagEvidence([
    { id: 1, pos_x: 0, pos_y: 0, pos_z: 10, timestamp: '2026-08-01T00:00:00Z' },
    { id: 2, pos_x: 180, pos_y: 0, pos_z: 20, timestamp: '2026-08-01T00:00:00Z' },
    { id: 3, pos_x: 90, pos_y: 0, pos_z: 30, timestamp: '2026-08-01T00:00:00Z' },
  ], { clusterRadius: 100 });

  assert.equal(candidates.length, 1, 'transitively connected flag evidence was split');
  assert.deepStrictEqual(candidates[0].sourceEventIds, [1, 2, 3]);
}

async function testRefreshCreatesPendingCandidatesWithoutOverwritingReview() {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM territory_events')) {
        assert(sql.includes('LIMIT $3'), 'flag refresh query is not bounded');
        assert(sql.includes('pos_y'), 'flag refresh must select stored ADM northing');
        assert(sql.includes('pos_y IS NOT NULL'), 'flag refresh must require stored ADM northing');
        assert.deepStrictEqual(params, [7, 90, 500]);
        return [
          { id: 41, pos_x: 100, pos_y: 200, pos_z: 5, timestamp: '2026-08-01T00:00:00Z' },
          { id: 42, pos_x: 120, pos_y: 220, pos_z: 7, timestamp: '2026-08-02T00:00:00Z' },
        ];
      }
      if (sql.includes("source_type = 'territory_flag'")) {
        return [{ source_key: 'territory-flag:stable', center_x: 110, center_z: 210 }];
      }
      return [];
    },
  };

  const result = await refreshFlagCandidates(db, 7);
  assert.equal(result.length, 1);
  const upsert = calls.find(call => call.sql.includes('INSERT INTO spawn_exclusion_zones'));
  assert(upsert, 'candidate was not persisted');
  assert(upsert.sql.includes("status = spawn_exclusion_zones.status"), 'refresh can overwrite an admin review');
  assert(upsert.sql.includes("WHEN spawn_exclusion_zones.status = 'pending' THEN EXCLUDED.center_x"), 'refresh can move reviewed geometry');
  assert(upsert.sql.includes("WHEN spawn_exclusion_zones.status = 'pending' THEN EXCLUDED.center_z"), 'refresh can move reviewed geometry');
  assert.equal(upsert.params[0], 7);
  assert.equal(upsert.params[1], 'territory-flag:stable');
}

async function testZoneListingIsPaginatedAndBounded() {
  let query;
  const db = {
    query: async (sql, params) => {
      query = { sql, params };
      return [];
    },
  };

  await listExclusionZones(db, 7, { page: 2, pageSize: 25 });
  assert(query.sql.includes('LIMIT $2 OFFSET $3'), 'zone listing is not bounded');
  assert.deepStrictEqual(query.params, [7, 25, 25]);
  await assert.rejects(
    () => listExclusionZones(db, 7, { pageSize: 501 }),
    /pageSize cannot exceed 200/
  );
  await assert.rejects(
    () => listExclusionZones(db, 7, { page: 101 }),
    /page cannot exceed 100/
  );
}

async function testOnlyConfirmedMatchingZoneExcludesPlacement() {
  let query;
  const db = {
    get: async (sql, params) => {
      query = { sql, params };
      return { id: 9, label: 'Protected base', radius_m: 200 };
    },
  };

  const match = await findConfirmedExclusion(db, 7, 1100, 2200);
  assert.equal(match.id, 9);
  assert(query.sql.includes("status = 'confirmed'"));
  assert(query.sql.includes('server_id = $1'));
  assert.deepStrictEqual(query.params, [7, 1100, 2200]);
}

async function testAdminRoutesUseCanonicalExactServerScope() {
  const router = require('../routes/spawnExclusions');
  const layers = router.stack.filter(layer => layer.route);
  const signatures = layers.map(layer => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
  assert(signatures.includes('GET /:serverId'));
  assert(signatures.includes('POST /:serverId/refresh'));
  assert(signatures.includes('PATCH /:serverId/:zoneId'));
  assert(router.params.serverId?.length, 'spawn exclusion routes lack exact-server authorization');

  const routeSource = fs.readFileSync(
    path.join(__dirname, '../routes/spawnExclusions.js'), 'utf8'
  );
  assert(routeSource.includes("require('../services/shopFileService')"), 'review route does not share the checkout lock domain');
  assert(routeSource.includes('db.transaction(async transactionDb =>'), 'review mutation is not transactional');
  assert(
    routeSource.includes('await shopFileService.acquireShopServerLock(transactionDb, serverId)'),
    'review mutation can race an in-flight checkout'
  );
}

async function testReviewMutationIsBoundToCanonicalServer() {
  const service = require('../services/spawnExclusionService');
  let query;
  const db = {
    get: async (sql, params) => {
      query = { sql, params };
      return { id: 9, server_id: 7, status: 'confirmed', radius_m: 250 };
    },
  };

  const reviewed = await service.reviewExclusionZone(db, 7, 9, 3, {
    status: 'confirmed', radius: 250, label: 'Main base',
  });
  assert.equal(reviewed.id, 9);
  assert(query.sql.includes('WHERE id = $1 AND server_id = $2'));
  assert.deepStrictEqual(query.params, [9, 7, 'confirmed', 250, 'Main base', 3]);
  await assert.rejects(
    () => service.reviewExclusionZone(db, 7, 9, 3, { status: 'pending', radius: 250 }),
    /confirmed or dismissed/
  );
}

async function testConfirmedZoneBlocksDirectedEventPlacement() {
  const service = require('../services/spawnExclusionService');
  const db = {
    get: async (_sql, params) => params[1] === 1000
      ? { id: 9, label: 'Secret base name', radius_m: 200 }
      : null,
  };

  await assert.rejects(
    () => service.assertEventPlacementsAllowed(db, 7, [
      { spawn_method: 'event', pos_x: 1000, pos_z: 2000 },
    ]),
    error => error.code === 'SPAWN_EXCLUDED' &&
      error.message === 'Directed event location is inside a protected gameplay zone'
  );
  await service.assertEventPlacementsAllowed(db, 7, [
    { spawn_method: 'cfgEffectArea', pos_x: 1000, pos_z: 2000 },
    { spawn_method: 'event', pos_x: 5000, pos_z: 6000 },
  ]);
}

function testApiAndCheckoutWiring() {
  const registerRoutes = fs.readFileSync(
    path.join(__dirname, '../src/app/registerRoutes.js'), 'utf8'
  );
  assert(registerRoutes.includes("require('../../routes/spawnExclusions')"));
  assert(registerRoutes.includes("app.use('/api/spawn-exclusions'"));

  const checkout = fs.readFileSync(
    path.join(__dirname, '../services/shopFileService.js'), 'utf8'
  );
  const enforcement = checkout.indexOf('await spawnExclusionService.assertEventPlacementsAllowed(');
  const deduction = checkout.indexOf('// Deduct currency');
  assert(enforcement >= 0, 'shop checkout does not enforce confirmed spawn exclusions');
  assert(deduction > enforcement, 'spawn exclusion check must precede currency deduction');

  const shopRoute = fs.readFileSync(
    path.join(__dirname, '../routes/shop.js'), 'utf8'
  );
  assert(
    /err\.code === 'SPAWN_EXCLUDED'[\s\S]*?status\(409\)\.json\(\{ error: err\.message, checkoutState: 'failed' \}\)/.test(shopRoute),
    'shop checkout must return a policy-denial response for protected locations'
  );
}

function testAdminReviewUiContract() {
  const routes = fs.readFileSync(
    path.join(__dirname, '../src/app/registerRoutes.js'), 'utf8'
  );
  const pagePath = path.join(__dirname, '../public/dashboard/spawn-exclusions.html');
  const clientPath = path.join(__dirname, '../public/js/spawn-exclusions.js');
  assert(fs.existsSync(pagePath), 'spawn exclusion review page is missing');
  assert(fs.existsSync(clientPath), 'spawn exclusion review client is missing');
  assert(routes.includes("app.get('/dashboard/spawn-exclusions'"), 'spawn exclusion review page route is missing');
  assert(routes.includes("pub('dashboard', 'spawn-exclusions.html')"), 'spawn exclusion page is not CSRF-rendered');

  const page = fs.readFileSync(pagePath, 'utf8');
  for (const id of ['serverSelect', 'refreshCandidatesBtn', 'zonesContainer', 'previousPageBtn', 'nextPageBtn']) {
    assert(page.includes(`id="${id}"`), `spawn exclusion page lacks ${id}`);
  }
  const client = fs.readFileSync(clientPath, 'utf8');
  assert(client.includes("fetch('/api/csrf-token')"), 'review UI does not initialize CSRF protection');
  assert(client.includes('/api/spawn-exclusions/'), 'review UI does not use the exclusion API');
  assert(client.includes("method: 'PATCH'"), 'review UI cannot submit admin decisions');
  assert(client.includes("method: 'POST'"), 'review UI cannot refresh candidates');
}

async function testMigrationDefinesReviewedServerScopedZones() {
  const statements = [];
  const migration = require('../db/migrations/062_spawn_exclusion_zones');
  await migration.up({ query: async sql => { statements.push(sql); } });
  const ddl = statements.join('\n');

  assert(ddl.includes('CREATE TABLE IF NOT EXISTS spawn_exclusion_zones'));
  assert(/server_id\s+INTEGER NOT NULL REFERENCES servers\(id\) ON DELETE CASCADE/.test(ddl));
  assert(/UNIQUE\s*\(server_id, source_key\)/.test(ddl));
  assert(ddl.includes("CHECK (status IN ('pending', 'confirmed', 'dismissed'))"));
  assert(ddl.includes('CHECK (radius_m BETWEEN 50 AND 1000)'));
  assert(/evidence_event_ids\s+BIGINT\[\] NOT NULL/.test(ddl));
  assert(/reviewed_by\s+INTEGER REFERENCES users\(id\) ON DELETE SET NULL/.test(ddl));
  assert(ddl.includes('idx_territory_events_flag_candidates'));
  assert(ddl.includes("WHERE event_type = 'raised' AND structure_type = 'TerritoryFlag'"));
  assert(ddl.includes('idx_spawn_exclusion_zones_review_queue'));
  assert(ddl.includes("(CASE status WHEN 'pending' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END)"));
  assert(/last_evidence_at DESC NULLS LAST,\s*id/.test(ddl));
  assert(ddl.includes('idx_spawn_exclusion_zones_flag_matching'));
  assert(ddl.includes("WHERE source_type = 'territory_flag'"));
  assert(/last_evidence_at DESC NULLS LAST,\s*id DESC/.test(ddl));
}

(async () => {
  testNearbyFlagEvidenceFormsOneCandidate();
  testBridgingFlagEvidenceMergesConnectedClusters();
  await testRefreshCreatesPendingCandidatesWithoutOverwritingReview();
  await testZoneListingIsPaginatedAndBounded();
  await testOnlyConfirmedMatchingZoneExcludesPlacement();
  await testAdminRoutesUseCanonicalExactServerScope();
  await testReviewMutationIsBoundToCanonicalServer();
  await testConfirmedZoneBlocksDirectedEventPlacement();
  testApiAndCheckoutWiring();
  testAdminReviewUiContract();
  await testMigrationDefinesReviewedServerScopedZones();
  console.log('✅ Spawn exclusion candidate, schema, and enforcement tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
