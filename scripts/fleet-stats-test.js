'use strict';

// Splash fleet stats:
// (a) fleetStatsService queries reuse the admin per-server data path and
//     exclude disabled guilds
// (b) githubRepoMetricsService: >=1h cache, stale fallback on GitHub failure
//     (never rejects), commit-count parsing from the paginated Link header
// (c) route contract: public endpoint is rate-limited, unauthenticated, and
//     degrades to 503 on DB failure
// (d) splash UI contract: metric containers exist, client fetches the
//     endpoint, no eval / no external exfiltration in the page script
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { getFleetStats } = require('../services/fleetStatsService');
const {
  getRepoMetrics,
  countCommitsSince,
  resolveRepoSlug,
  DEFAULT_REPO_SLUG,
  CACHE_TTL_MS
} = require('../services/githubRepoMetricsService');

// ---------------------------------------------------------------------------
// (a) fleetStatsService
// ---------------------------------------------------------------------------

function fakeDb(rows) {
  const calls = [];
  return {
    calls,
    async get(sql, params) {
      calls.push({ sql, params: params || [] });
      return rows.shift();
    }
  };
}

test('fleet stats: player total counts unregistered players (LEFT JOIN linked_accounts)', async () => {
  const db = fakeDb([
    { total: 8549, registered: 10 },
    { total: 7, active: 2 },
    { active: 4 }
  ]);
  const stats = await getFleetStats(db);
  assert.deepEqual(stats, {
    players: { total: 8549, registered: 10 },
    servers: { total: 7, active: 2 },
    guilds: { active: 4 }
  });

  const playersSql = db.calls[0].sql;
  assert.match(playersSql, /player_server_activity/, 'players must come from the admin data path (player_server_activity)');
  assert.match(playersSql, /LEFT JOIN linked_accounts/, 'unregistered players must be included (LEFT JOIN)');
  assert.match(playersSql, /COUNT\(DISTINCT psa\.identity_id\)/, 'total must be distinct identities across all servers');
});

test('fleet stats: guild count uses the documented active filter (status approved)', async () => {
  const db = fakeDb([{ total: 1, registered: 0 }, { total: 1, active: 1 }, { active: 4 }]);
  await getFleetStats(db);
  const guildsSql = db.calls[2].sql;
  assert.match(guildsSql, /FROM guilds/i);
  assert.match(guildsSql, /status\s*=\s*'approved'/i, 'removed (disabled) guilds must be excluded');
  assert.ok(!/status\s*=\s*'disabled'/i.test(guildsSql), 'disabled guilds must not be counted');
});

test('fleet stats: server count matches the admin /api/admin/stats data path', async () => {
  const db = fakeDb([{ total: 1, registered: 0 }, { total: 7, active: 2 }, { active: 1 }]);
  await getFleetStats(db);
  const serversSql = db.calls[1].sql;
  assert.match(serversSql, /FROM servers/i, 'server count must come from the servers table (same as /api/admin/stats)');
});

// ---------------------------------------------------------------------------
// (b) githubRepoMetricsService
// ---------------------------------------------------------------------------

function cacheDb({ row, written }) {
  const slug = row ? row.slug : 'o/r';
  return {
    async get(sql, params) {
      assert.match(sql, /FROM github_repo_metrics/);
      assert.deepEqual(params, [slug]);
      return row ? { payload: row.payload, fetched_at: row.fetchedAt } : null;
    },
    async run(sql, params) {
      written.push({ sql, params });
      assert.match(sql, /INSERT INTO github_repo_metrics/);
      assert.match(sql, /ON CONFLICT \(repo_slug\)/);
      assert.deepEqual(params.slice(0, 1), [slug]);
      return { changes: 1 };
    }
  };
}

function failingHttp() {
  return {
    async get() {
      const err = new Error('getaddrinfo ENOTFOUND api.github.com');
      err.response = undefined;
      throw err;
    }
  };
}

function liveHttp() {
  return {
    async get(url) {
      if (url.includes('/commits')) {
        return { data: [{}], headers: { link: '<https://api.github.com/page/7>; rel="next", <https://api.github.com/page=42>; rel="last"' } };
      }
      return { data: { stargazers_count: 2, forks_count: 1, open_issues_count: 21 }, headers: {} };
    }
  };
}

test('github metrics: fresh cache is served without any API call', async () => {
  const written = [];
  const db = cacheDb({ row: { slug: 'o/r', payload: { stars: 9, forks: 2, openIssues: 3, commitsLast30d: 1 }, fetchedAt: new Date(Date.now() - 10 * 60000).toISOString() }, written });
  const result = await getRepoMetrics(db, 'o/r', { http: failingHttp() });
  assert.equal(result.stars, 9);
  assert.equal(result.stale, false);
  assert.equal(result.source, 'cache');
  assert.equal(written.length, 0, 'a fresh cache must not be refetched');
});

test('github metrics: expired cache triggers a live fetch and refreshes the cache', async () => {
  const written = [];
  const db = cacheDb({ row: { slug: 'o/r', payload: { stars: 1, forks: 0, openIssues: 0, commitsLast30d: 0 }, fetchedAt: new Date(Date.now() - (CACHE_TTL_MS + 60000)).toISOString() }, written });
  const result = await getRepoMetrics(db, 'o/r', { http: liveHttp() });
  assert.equal(result.stars, 2);
  assert.equal(result.openIssues, 21);
  assert.equal(result.commitsLast30d, 42, 'commit count must come from the Link header last page');
  assert.equal(result.stale, false);
  assert.equal(result.source, 'live');
  assert.equal(written.length, 1, 'the fresh value must be written to the cache table');
  assert.deepEqual(JSON.parse(written[0].params[1]), { stars: 2, forks: 1, openIssues: 21, commitsLast30d: 42 });
});

test('github metrics: API failure with a stale cache returns cached values + stale marker (no throw)', async () => {
  const written = [];
  const db = cacheDb({ row: { slug: 'o/r', payload: { stars: 5, forks: 1, openIssues: 2, commitsLast30d: 3 }, fetchedAt: new Date(Date.now() - (CACHE_TTL_MS + 60000)).toISOString() }, written });
  const result = await getRepoMetrics(db, 'o/r', { http: failingHttp() });
  assert.equal(result.stars, 5, 'must fall back to cached values');
  assert.equal(result.stale, true, 'must carry the stale marker');
  assert.equal(result.source, 'stale-cache');
  assert.match(result.error, /ENOTFOUND|getaddrinfo/);
  assert.equal(written.length, 0, 'a failed fetch must not overwrite the cache');
});

test('github metrics: API failure with no cache at all returns unavailable (no throw)', async () => {
  const written = [];
  const db = cacheDb({ row: null, written });
  const result = await getRepoMetrics(db, 'o/r', { http: failingHttp() });
  assert.equal(result.unavailable, true);
  assert.equal(result.stale, true);
  assert.ok(result.error, 'must carry an error summary');
  assert.equal(written.length, 0);
});

test('github metrics: HTTP 500 from the API is summarized and never throws', async () => {
  const written = [];
  const db = cacheDb({ row: null, written });
  const http500 = {
    async get() {
      const err = new Error('Request failed with status code 500');
      err.response = { status: 500 };
      throw err;
    }
  };
  const result = await getRepoMetrics(db, 'o/r', { http: http500 });
  assert.equal(result.unavailable, true);
  assert.match(result.error, /http 500/);
});

test('countCommitsSince: parses the paginated Link header', () => {
  assert.equal(countCommitsSince('<u>; rel="next", <u2>; rel="last"', false), 1);
  assert.equal(countCommitsSince('<u>; rel="next", <https://api.github.com/repos/o/r/commits?per_page=1&page=14>; rel="last"', false), 14);
  assert.equal(countCommitsSince('', true), 0, 'empty body means zero commits in the window');
});

test('resolveRepoSlug: validates the slug and honors the env override', () => {
  assert.equal(resolveRepoSlug('Kitty-Shackleford/SALT'), 'Kitty-Shackleford/SALT');
  assert.equal(resolveRepoSlug(), DEFAULT_REPO_SLUG);
  assert.throws(() => resolveRepoSlug('no-slash'), /Invalid GitHub repo slug/);
  assert.throws(() => resolveRepoSlug('a/b/c'), /Invalid GitHub repo slug/);
  const prev = process.env.GITHUB_METRICS_REPO;
  process.env.GITHUB_METRICS_REPO = 'override/repo';
  try {
    assert.equal(resolveRepoSlug(), 'override/repo');
  } finally {
    if (prev === undefined) delete process.env.GITHUB_METRICS_REPO;
    else process.env.GITHUB_METRICS_REPO = prev;
  }
});

// ---------------------------------------------------------------------------
// (c) route contract (source-level: the route is registered inline in
//     registerRoutes.js alongside the other public endpoints)
// ---------------------------------------------------------------------------

test('route: /api/public/fleet-stats is public, rate-limited, and degrades to 503', () => {
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'registerRoutes.js'), 'utf8');
  const start = routeSource.indexOf("app.get('/api/public/fleet-stats'");
  assert.ok(start !== -1, 'public fleet-stats endpoint is missing');
  const nextRoute = routeSource.indexOf('\n  app.', start + 10);
  const route = routeSource.slice(start, nextRoute !== -1 ? nextRoute : routeSource.length);
  assert.match(route, /onboardingLimiter/, 'endpoint must be rate-limited');
  assert.ok(!route.includes('ensureAuthenticated'), 'endpoint must stay public (no auth)');
  assert.match(route, /getFleetStats\(db\)/);
  assert.match(route, /getRepoMetrics\(db\)/);
  assert.match(route, /503/, 'DB failure must degrade to 503, not 500');
  // GitHub failures are absorbed inside the service — the route must not
  // treat them as fatal:
  const service = fs.readFileSync(path.join(__dirname, '..', 'services', 'githubRepoMetricsService.js'), 'utf8');
  assert.match(service, /return \{[^]*unavailable: true,/, 'service must produce an unavailable marker instead of rejecting');
  assert.ok(!/throw/.test(service.slice(service.indexOf('async function getRepoMetrics'), service.indexOf('module.exports'))),
    'getRepoMetrics must never reject');
});

// ---------------------------------------------------------------------------
// (d) splash UI contract
// ---------------------------------------------------------------------------

test('splash UI: all four metric families are present and client-driven', () => {
  const splash = fs.readFileSync(path.join(__dirname, '..', 'public', 'splash.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'splash-fleet-stats.js'), 'utf8');

  assert.ok(splash.includes('id="fleetStats"'), 'splash must carry the fleet stats container');
  for (const id of ['fleetPlayers', 'fleetServers', 'fleetGuilds', 'fleetGithub', 'fleetStatsNote']) {
    assert.ok(splash.includes(`id="${id}"`), `splash is missing #${id}`);
  }
  assert.ok(splash.includes('/js/splash-fleet-stats.js'), 'splash must load the fleet stats script');

  assert.match(client, /fetch\('\/api\/public\/fleet-stats'/, 'client must fetch the public endpoint');
  assert.ok(!client.includes('eval('), 'no eval in the splash stats script');
  assert.ok(!/https?:\/\//.test(client), 'no external URLs (no exfil path) in the splash stats script');
  assert.match(client, /credentials: 'same-origin'/);
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test('migration 110: creates the cache table (up) and drops it (down)', async () => {
  const migrationPath = path.join(__dirname, '..', 'db', 'migrations', '110_github_repo_metrics.js');
  assert.ok(fs.existsSync(migrationPath), 'migration 110 must exist');
  const { up, down } = require(migrationPath);
  const sql = [];
  const pool = { async query(s) { sql.push(s); } };
  await up(pool);
  assert.equal(sql.length, 1);
  assert.match(sql[0], /CREATE TABLE IF NOT EXISTS github_repo_metrics/);
  assert.match(sql[0], /repo_slug TEXT NOT NULL UNIQUE/);
  assert.match(sql[0], /payload JSONB NOT NULL/);
  await down(pool);
  assert.match(sql[1], /DROP TABLE IF EXISTS github_repo_metrics/);
});
