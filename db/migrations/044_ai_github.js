/*
 * Migration 044 — AI Server Assistant & GitHub Integration
 *
 * Adds tables supporting:
 *   - GitHub account connections per user (PAT or OAuth)
 *   - Per-server GitHub repo links for config versioning
 *   - AI-generated suggestion queue
 *   - AI chat session history per user per file
 */

async function up(pool) {
  console.log('🤖 Migration 044: AI Server Assistant & GitHub integration');

  // Per-user GitHub connection. Stores encrypted token (same AES-256-CBC
  // scheme as Nitrado tokens) and the preferred AI model for this user.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS github_connections (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      github_username TEXT    NOT NULL,
      token_hash      TEXT    NOT NULL,
      token_type      TEXT    NOT NULL DEFAULT 'pat',   -- 'pat' | 'oauth'
      preferred_model TEXT    NOT NULL DEFAULT 'gpt-4o-mini',
      auto_commit     INTEGER NOT NULL DEFAULT 0,       -- 1 = create PRs on apply
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id)
    )
  `);

  // Per-server GitHub repo link. The owner selects a repo + branch and
  // optionally a base path inside the repo where mission files live.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS github_repo_links (
      id          SERIAL PRIMARY KEY,
      server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      repo_owner  TEXT    NOT NULL,
      repo_name   TEXT    NOT NULL,
      branch      TEXT    NOT NULL DEFAULT 'main',
      base_path   TEXT    NOT NULL DEFAULT '/',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(server_id, user_id)
    )
  `);

  // Queue of AI-generated suggestions for a server. A suggestion targets
  // a specific file with a before/after diff and a plain-English explanation.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_suggestions (
      id            SERIAL PRIMARY KEY,
      server_id     INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id       INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      filename      TEXT    NOT NULL,
      trigger_type  TEXT    NOT NULL DEFAULT 'manual',   -- 'manual' | 'scheduled' | 'chat'
      explanation   TEXT    NOT NULL,
      original_content TEXT,
      suggested_content TEXT NOT NULL,
      diff_summary  TEXT,
      status        TEXT    NOT NULL DEFAULT 'pending',  -- 'pending' | 'accepted' | 'rejected' | 'applying' | 'applied'
      applied_at    TIMESTAMPTZ,
      github_pr_url TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Per-user per-file chat history. Lets the AI maintain context across
  // multiple turns without the client resending the full history every time.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_chat_sessions (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      filename   TEXT    NOT NULL,
      messages   TEXT    NOT NULL DEFAULT '[]',   -- JSON array of {role, content}
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, server_id, filename)
    )
  `);

  console.log('✅ Migration 044 complete');
}

module.exports = { up };
