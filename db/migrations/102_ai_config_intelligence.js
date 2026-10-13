/*
 * Migration 102: AI config intelligence
 *
 * Supports the patch-style multi-file / balance-pass / validation /
 * diff-explain feature (AI feature 2/7).
 *
 *   - ai_suggestion_groups: one anchor row per multi-file edit request or
 *     balance pass. Each per-file suggestion links back to it via
 *     ai_suggestions.group_id, so the set of coordinated edits a single
 *     request produced is always discoverable as one group.
 *
 *   - ai_suggestions gains:
 *       group_id          — FK to the anchor group (NULL for legacy rows)
 *       patch             — the deterministic patch the AI emitted (JSON text)
 *       base_content_hash — sha256 of the working-copy bytes the patch was
 *                           validated against; a later apply uses it to detect
 *                           drift and re-materialize suggested_content
 *       diff_explanation  — plain-language delta written when a suggestion is
 *                           applied (deliverable 4)
 *
 * Patch-style suggestions still store original_content + suggested_content
 * (the materialized full replacement), so the existing claim-lease
 * finalization, assertValidReplacement, diff view and GitHub PR path all keep
 * working without change. The extra columns are additive.
 */
'use strict';

async function up(pool) {
  console.log('🔄 Migration 102: AI config intelligence');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_suggestion_groups (
      id         SERIAL PRIMARY KEY,
      server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
      kind       TEXT    NOT NULL,            -- 'multi-file' | 'balance'
      goal       TEXT,
      file_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_suggestion_groups_server
      ON ai_suggestion_groups (server_id, created_at DESC);
  `);

  await pool.query(`
    ALTER TABLE ai_suggestions
      ADD COLUMN IF NOT EXISTS group_id INTEGER,
      ADD COLUMN IF NOT EXISTS patch TEXT,
      ADD COLUMN IF NOT EXISTS base_content_hash TEXT,
      ADD COLUMN IF NOT EXISTS diff_explanation TEXT;
  `);
  await pool.query(`
    ALTER TABLE ai_suggestions
      ADD CONSTRAINT fk_ai_suggestions_group
      FOREIGN KEY (group_id) REFERENCES ai_suggestion_groups(id) ON DELETE SET NULL;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_suggestions_group
      ON ai_suggestions (group_id);
  `);

  console.log('✅ Migration 102: AI config intelligence');
}

async function down(pool) {
  await pool.query(`
    ALTER TABLE ai_suggestions
      DROP CONSTRAINT IF EXISTS fk_ai_suggestions_group;
  `);
  await pool.query(`
    ALTER TABLE ai_suggestions
      DROP COLUMN IF EXISTS diff_explanation,
      DROP COLUMN IF EXISTS base_content_hash,
      DROP COLUMN IF EXISTS patch,
      DROP COLUMN IF EXISTS group_id;
  `);
  await pool.query('DROP TABLE IF EXISTS ai_suggestion_groups');
}

module.exports = { up, down };
