/*
 * Migration 060 — Canonical user-owned GitHub Actions integration per server
 *
 * AI repository links remain per user. This table identifies the one repository
 * that represents a server's optional standalone automation environment.
 */

async function up(pool) {
  console.log('⚡ Migration 060: Add canonical GitHub Actions integrations');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS github_action_integrations (
      server_id          INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
      connection_user_id INTEGER NOT NULL REFERENCES github_connections(user_id) ON DELETE CASCADE,
      repo_owner         TEXT NOT NULL,
      repo_name          TEXT NOT NULL,
      branch             TEXT NOT NULL DEFAULT 'main',
      manifest_path      TEXT NOT NULL DEFAULT 'dayz-integration.json',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (manifest_path = 'dayz-integration.json')
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_github_action_integrations_connection
      ON github_action_integrations(connection_user_id)
  `);

  console.log('✅ Migration 060 complete');
}

module.exports = { up };
