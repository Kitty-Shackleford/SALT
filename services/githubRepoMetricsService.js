'use strict';

/**
 * Public GitHub repository metrics with a >=1h DB cache.
 *
 * The splash page (public, no auth) displays read-only metrics from the
 * GitHub REST API for the public release repo (default:
 * Kitty-Shackleford/SALT — the canonical dev repo is private, so public
 * metrics are served from its public release; override with
 * GITHUB_METRICS_REPO). Values are cached in github_repo_metrics and
 * refreshed at most once per hour.
 *
 * Contract: this module NEVER rejects on a GitHub failure. Callers always
 * get one of:
 *   - { repo, stars, forks, openIssues, commitsLast30d, fetchedAt, stale: false, source: 'live'|'cache' }
 *   - { repo, ...cached, fetchedAt, stale: true, source: 'stale-cache', error }
 *   - { repo, unavailable: true, stale: true, error }   (no cache ever fetched)
 */

const axios = require('axios');

const DEFAULT_REPO_SLUG = 'Kitty-Shackleford/SALT';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const HTTP_TIMEOUT_MS = 8000;
const COMMIT_WINDOW_DAYS = 30;

function resolveRepoSlug(explicit) {
  const slug = String(explicit || process.env.GITHUB_METRICS_REPO || DEFAULT_REPO_SLUG).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) {
    throw new Error(`Invalid GitHub repo slug: ${slug}`);
  }
  return slug;
}

/**
 * GitHub returns the total commit count via the paginated Link header when
 * `since` filters the list: `page=N; rel="last"` → N total. An empty body
 * means zero commits in the window.
 */
function countCommitsSince(linkHeader, bodyIsEmpty) {
  if (bodyIsEmpty) return 0;
  const match = (linkHeader || '').match(/page=(\d+)>;\s*rel="last"/);
  return match ? parseInt(match[1], 10) : 1;
}

async function fetchRepoMetricsFromApi(repoSlug, http) {
  const client = http || axios;
  const base = 'https://api.github.com';
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'dayz-dashboard-splash' };
  const since = new Date(Date.now() - COMMIT_WINDOW_DAYS * 86400000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  const [repoRes, commitsRes] = await Promise.all([
    client.get(`${base}/repos/${repoSlug}`, { timeout: HTTP_TIMEOUT_MS, headers, validateStatus: s => s >= 200 && s < 300 }),
    client.get(`${base}/repos/${repoSlug}/commits`, {
      timeout: HTTP_TIMEOUT_MS,
      headers,
      params: { per_page: 1, since },
      validateStatus: s => s >= 200 && s < 300
    })
  ]);

  const repo = repoRes.data || {};
  const commitsBody = commitsRes.data;
  return {
    stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0,
    forks: typeof repo.forks_count === 'number' ? repo.forks_count : 0,
    openIssues: typeof repo.open_issues_count === 'number' ? repo.open_issues_count : 0,
    commitsLast30d: countCommitsSince(commitsRes.headers && commitsRes.headers.link, !Array.isArray(commitsBody) || commitsBody.length === 0)
  };
}

function summarizeError(err) {
  const status = err && err.response ? err.response.status : null;
  const message = err && err.message ? err.message.slice(0, 200) : 'unknown error';
  return status ? `github http ${status}: ${message}` : message;
}

async function readCache(db, repoSlug) {
  try {
    return await db.get(
      'SELECT payload, fetched_at FROM github_repo_metrics WHERE repo_slug = ?',
      [repoSlug]
    );
  } catch (err) {
    // Cache read failure (e.g. table not yet migrated) must not break the
    // page: fall through to a live fetch attempt.
    return null;
  }
}

async function writeCache(db, repoSlug, payload) {
  await db.run(
    `INSERT INTO github_repo_metrics (repo_slug, payload, fetched_at, created_at, updated_at)
     VALUES (?, ?, NOW(), NOW(), NOW())
     ON CONFLICT (repo_slug) DO UPDATE
       SET payload = EXCLUDED.payload,
           fetched_at = EXCLUDED.fetched_at,
           updated_at = EXCLUDED.updated_at`,
    [repoSlug, JSON.stringify(payload)]
  );
}

/**
 * @param {object} db db abstraction adapter (db.get / db.run)
 * @param {string} [repoSlug] optional repo override (defaults to env/default)
 * @param {object} [opts] { http } injectable HTTP client (defaults to axios);
 *   used by tests to avoid real network calls
 */
async function getRepoMetrics(db, repoSlug, opts) {
  const slug = resolveRepoSlug(repoSlug);
  const http = opts && opts.http;

  const cached = await readCache(db, slug);
  const cachedAgeMs = cached ? Date.now() - new Date(cached.fetched_at).getTime() : Infinity;
  if (cached && cachedAgeMs < CACHE_TTL_MS) {
    return {
      repo: slug,
      ...(cached.payload || {}),
      fetchedAt: cached.fetched_at,
      stale: false,
      source: 'cache'
    };
  }

  try {
    const live = await fetchRepoMetricsFromApi(slug, http);
    await writeCache(db, slug, live);
    return {
      repo: slug,
      ...live,
      fetchedAt: new Date().toISOString(),
      stale: false,
      source: 'live'
    };
  } catch (err) {
    if (cached) {
      return {
        repo: slug,
        ...(cached.payload || {}),
        fetchedAt: cached.fetched_at,
        stale: true,
        source: 'stale-cache',
        error: summarizeError(err)
      };
    }
    return {
      repo: slug,
      unavailable: true,
      stale: true,
      error: summarizeError(err)
    };
  }
}

module.exports = {
  getRepoMetrics,
  // Exposed for tests:
  countCommitsSince,
  resolveRepoSlug,
  DEFAULT_REPO_SLUG,
  CACHE_TTL_MS
};
