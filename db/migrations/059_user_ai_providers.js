/*
 * Migration 059 — Per-user AI provider connections
 *
 * Stores encrypted OpenAI-compatible credentials or a user selection to use
 * the GitHub Copilot SDK with that user's separately connected GitHub token.
 */

async function up(pool) {
  console.log('🤖 Migration 059: Per-user AI provider connections');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_provider_connections (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_type   TEXT NOT NULL CHECK (provider_type IN ('openai-compatible', 'copilot')),
      credential_hash TEXT,
      credential_binding_hash TEXT,
      base_url         TEXT,
      model            TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id),
      CHECK (
        (provider_type = 'openai-compatible' AND credential_hash IS NOT NULL
          AND credential_binding_hash IS NULL AND base_url IS NOT NULL)
        OR
        (provider_type = 'copilot' AND credential_hash IS NULL
          AND credential_binding_hash IS NOT NULL AND base_url IS NULL)
      )
    )
  `);
  console.log('✅ Migration 059 complete');
}

module.exports = { up };
