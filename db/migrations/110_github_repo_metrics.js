'use strict';

/**
 * Migration 110: Cached public GitHub repo metrics.
 *
 * The splash page (public, no auth) shows GitHub metrics for the public
 * release repository (Kitty-Shackleford/SALT by default). All values are
 * read-only public data; they are fetched at most once per hour and cached
 * here so a GitHub hiccup never 500s the landing page — the route falls
 * back to the last cached row with a "stale" marker.
 */
async function up(pool) {
  console.log('🔄 Migration 110: Add cached GitHub repo metrics');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS github_repo_metrics (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      repo_slug TEXT NOT NULL UNIQUE,
      payload JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('✅ Migration 110 complete');
}

async function down(pool) {
  await pool.query(`
    DROP TABLE IF EXISTS github_repo_metrics;
  `);
}

module.exports = { up, down };
