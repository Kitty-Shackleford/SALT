/*
 * Migration 043 — Snippet Rotation System
 *
 * Adds tables for the server config rotation system, which lets owners
 * build a library of XML/JSON snippets and deploy them to their Nitrado
 * server on a schedule or manually.
 *
 * Activation patterns supported:
 *   ce_folder         — uploads a file into the mission ce/ directory
 *                       (types, events, spawnabletypes, randompresets, globals, messages)
 *   cfggameplay_array — patches a path into a cfgGameplay.json array
 *                       (spawnGearPresetFiles, objectSpawnersArr, playerRestrictedAreaFiles)
 *   location_bundle   — pairs an object spawner JSON (cfgGameplay.json) with a
 *                       mapgrouppos.xml block; both deployed together
 *   xml_patch         — downloads an XML file, injects/strips a managed block, re-uploads
 *   file_swap         — full file replacement with backup/restore support
 */

async function up(pool) {
  console.log('🔄 Migration 043: Snippet rotation system');

  // ── Snippet library ──────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotation_snippets (
      id                  INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      guild_id            INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      server_id           INTEGER REFERENCES servers(id) ON DELETE SET NULL,
      name                TEXT NOT NULL,
      description         TEXT,

      -- Which activation pattern this snippet uses
      pattern             TEXT NOT NULL CHECK (pattern IN (
                            'ce_folder', 'cfggameplay_array', 'location_bundle',
                            'xml_patch', 'file_swap'
                          )),

      -- ce_folder: which economy core type
      ce_type             TEXT CHECK (ce_type IN (
                            'types', 'spawnabletypes', 'events',
                            'randompresets', 'globals', 'messages'
                          )),

      -- cfggameplay_array / location_bundle: which array in cfgGameplay.json
      cfggameplay_array   TEXT CHECK (cfggameplay_array IN (
                            'spawnGearPresetFiles', 'objectSpawnersArr', 'playerRestrictedAreaFiles'
                          )),

      -- cfggameplay_array / location_bundle: where to upload the JSON on the server
      deploy_path         TEXT,

      -- xml_patch: which file to patch and what XML block tag to inject/strip
      target_file         TEXT,
      xml_root_tag        TEXT,

      -- file_swap: full Nitrado path for the target file
      target_path         TEXT,

      -- Primary content (XML or JSON depending on pattern)
      content             TEXT NOT NULL,

      -- location_bundle: the companion mapgrouppos XML block (paired with content = spawner JSON)
      mapgrouppos_content TEXT,

      -- location_bundle: optional types.xml / spawnabletypes.xml additions
      types_content       TEXT,
      spawnabletypes_content TEXT,

      tags                TEXT,  -- comma-separated
      created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── Presets (named groups of snippets) ───────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotation_presets (
      id              INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      guild_id        INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      server_id       INTEGER REFERENCES servers(id) ON DELETE SET NULL,
      name            TEXT NOT NULL,
      description     TEXT,
      active          BOOLEAN NOT NULL DEFAULT FALSE,

      -- 'none' | 'date_range' | 'recurring'
      schedule_type   TEXT NOT NULL DEFAULT 'none',

      -- JSON schedule config:
      --   date_range:  { "start": "2026-12-01", "end": "2027-01-05" }
      --   recurring:   { "cron": "0 18 * * 5", "duration_hours": 62 }
      schedule_config TEXT,

      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── Preset ↔ Snippet join ────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotation_preset_snippets (
      preset_id   INTEGER NOT NULL REFERENCES rotation_presets(id)  ON DELETE CASCADE,
      snippet_id  INTEGER NOT NULL REFERENCES rotation_snippets(id) ON DELETE CASCADE,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (preset_id, snippet_id)
    )
  `);

  // ── Activation history log ───────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotation_history (
      id              INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      preset_id       INTEGER REFERENCES rotation_presets(id) ON DELETE SET NULL,
      preset_name     TEXT,   -- snapshot in case preset is later deleted
      server_id       INTEGER REFERENCES servers(id) ON DELETE SET NULL,
      action          TEXT NOT NULL CHECK (action IN ('activated', 'deactivated', 'failed')),
      triggered_by    TEXT NOT NULL DEFAULT 'scheduler',  -- 'scheduler' | discord_id of user
      result          TEXT,   -- success message or error details
      triggered_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ── ce/ folder setup tracking ────────────────────────────────────────────
  // Tracks whether cfgeconomycore.xml has been patched with rotation placeholders
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotation_setup (
      server_id       INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
      ce_setup_done   BOOLEAN NOT NULL DEFAULT FALSE,
      ce_setup_at     TIMESTAMPTZ,
      setup_by        INTEGER REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // ── File swap backup store ───────────────────────────────────────────────
  // Keeps a copy of files before a file_swap snippet overwrites them
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotation_file_backups (
      id          INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      snippet_id  INTEGER NOT NULL REFERENCES rotation_snippets(id) ON DELETE CASCADE,
      server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      file_path   TEXT NOT NULL,
      content     TEXT NOT NULL,
      backed_up_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(snippet_id, server_id)
    )
  `);

  // ── Indexes ──────────────────────────────────────────────────────────────
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rotation_snippets_guild ON rotation_snippets(guild_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rotation_presets_guild  ON rotation_presets(guild_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rotation_presets_active ON rotation_presets(active) WHERE active = TRUE`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_rotation_history_preset ON rotation_history(preset_id)`);

  console.log('✅ Migration 043 complete');
}

module.exports = { up };
