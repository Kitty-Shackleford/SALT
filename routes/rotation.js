/*
 * routes/rotation.js
 *
 * REST API for the snippet rotation system.
 * All routes require the user to be authenticated and have access to the
 * relevant server (owner or admin role).
 *
 * Route overview:
 *   GET    /api/rotation/setup/:serverId          — setup wizard status
 *   POST   /api/rotation/setup/:serverId          — run ce/ folder setup
 *
 *   GET    /api/rotation/snippets/:serverId       — list snippets
 *   POST   /api/rotation/snippets/:serverId       — create snippet
 *   PUT    /api/rotation/snippets/:serverId/:id   — update snippet
 *   DELETE /api/rotation/snippets/:serverId/:id   — delete snippet
 *
 *   GET    /api/rotation/presets/:serverId        — list presets
 *   POST   /api/rotation/presets/:serverId        — create preset
 *   PUT    /api/rotation/presets/:serverId/:id    — update preset metadata
 *   DELETE /api/rotation/presets/:serverId/:id    — delete preset
 *
 *   POST   /api/rotation/presets/:serverId/:id/snippets      — add snippet to preset
 *   DELETE /api/rotation/presets/:serverId/:id/snippets/:sid — remove snippet from preset
 *
 *   POST   /api/rotation/presets/:serverId/:id/activate      — manually activate preset
 *   POST   /api/rotation/presets/:serverId/:id/deactivate    — manually deactivate preset
 *
 *   GET    /api/rotation/history/:serverId        — activation history log
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { ensureServerOwner } = require('../middleware/serverAccess');
const rotationService = require('../services/rotationService');
const missionFileService = require('../services/missionFileService');
const economyOverrideService = require('../services/economyOverrideService');
const { createProviderSettingFileService } = require('../services/providerSettingMutationService');
const { createMissionInitFileService } = require('../services/missionInitFileService');
const { acquireProviderMutationLock } = require('../services/shopFileService');
const { reconcileProviderMutation } = require('../services/providerMutationRecoveryService');

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

async function assertRotationDefinitionMutable(
  db,
  serverId,
  userId,
  { snippetId = null, presetId = null }
) {
  await acquireProviderMutationLock(db, serverId);
  await assertRotationMutationAuthority(db, serverId, userId);
  const activePreset = snippetId !== null
    ? await db.get(
      `SELECT rp.id FROM rotation_presets rp
       JOIN rotation_preset_snippets rps ON rps.preset_id = rp.id
       WHERE rp.server_id = ? AND rps.snippet_id = ? AND rp.active = TRUE
       FOR NO KEY UPDATE OF rp`,
      [serverId, snippetId]
    )
    : await db.get(
      `SELECT id FROM rotation_presets
       WHERE id = ? AND server_id = ? AND active = TRUE
       FOR NO KEY UPDATE`,
      [presetId, serverId]
    );
  if (activePreset) {
    const error = new Error('Deactivate the affected rotation preset before changing its definition');
    error.code = 'ROTATION_DEFINITION_ACTIVE';
    error.status = 409;
    throw error;
  }
}

async function resolveProviderRecoveryContext(db, serverId, userId) {
  const row = await db.get(
    `SELECT s.guild_id, s.platform_server_id, gt.token_hash
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
     JOIN guild_tokens gt ON gt.guild_id = s.guild_id
       AND gt.token_type = 'nitrado' AND gt.nitrado_user_id IS NOT NULL
     WHERE s.id = ? AND s.status = 'active'
     FOR NO KEY UPDATE OF s, g, gt`,
    [serverId]
  );
  if (!row?.platform_server_id || !row?.token_hash) {
    throw new Error('Authorized Nitrado token is unavailable for provider recovery');
  }
  const ownerRole = await db.get(
    `SELECT role FROM guild_roles
     WHERE guild_id = ? AND user_id = ? AND role = 'owner'
     FOR UPDATE`,
    [row.guild_id, userId]
  );
  if (!ownerRole) {
    const error = new Error('Provider recovery owner authority was revoked');
    error.status = 403;
    throw error;
  }
  const { decryptToken } = require('../utils/encryption');
  return { platformServerId: row.platform_server_id, token: decryptToken(row.token_hash) };
}

async function assertRotationMutationAuthority(db, serverId, userId) {
  const scope = await db.get(
    `SELECT s.guild_id
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id
     WHERE s.id = ? AND s.status = 'active' AND g.status = 'approved'
     FOR NO KEY UPDATE OF s, g`,
    [serverId]
  );
  if (!scope) {
    const error = new Error('Rotation authority was revoked');
    error.status = 403;
    throw error;
  }
  const ownerRole = await db.get(
    `SELECT role FROM guild_roles
     WHERE guild_id = ? AND user_id = ? AND role = 'owner'
     FOR UPDATE`,
    [scope.guild_id, userId]
  );
  if (!ownerRole) {
    const error = new Error('Rotation owner authority was revoked');
    error.status = 403;
    throw error;
  }
}

// ── Setup wizard ──────────────────────────────────────────────────────────────

// GET /api/rotation/setup/:serverId — check if ce/ placeholder files are registered
router.get('/setup/:serverId', requireAuth, ensureServerOwner, async (req, res) => {
  const db       = req.app.locals.db;
  const serverId = parseInt(req.params.serverId, 10);

  try {
    const setup = await db.get('SELECT * FROM rotation_setup WHERE server_id = ?', [serverId]);
    res.json({ done: !!setup?.ce_setup_done, setup: setup || null });
  } catch (err) {
    console.error('rotation setup status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rotation/setup/:serverId — run the one-time ce/ setup
router.post('/setup/:serverId', requireAuth, ensureServerOwner, async (req, res) => {
  const db       = req.app.locals.db;
  const serverId = parseInt(req.params.serverId, 10);
  const userId   = req.user.id;

  try {
    const result = await rotationService.runCeSetup(
      db,
      serverId,
      userId,
      transactionDb => assertRotationMutationAuthority(transactionDb, serverId, userId)
    );
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('rotation ce setup error:', err);
    res.status(err.status || (err.code === 'ROTATION_RECOVERY_PENDING' ? 409 : 500))
      .json({ error: err.message, recoveryPending: err.code === 'ROTATION_RECOVERY_PENDING' });
  }
});

// ── Snippets ──────────────────────────────────────────────────────────────────

// GET /api/rotation/snippets/:serverId
router.get('/snippets/:serverId', requireAuth, ensureServerOwner, async (req, res) => {
  const db       = req.app.locals.db;
  const serverId = parseInt(req.params.serverId, 10);

  try {
    const snippets = await db.query(
      `SELECT id, name, description, pattern, ce_type, cfggameplay_array, deploy_path,
              target_file, xml_root_tag, target_path, tags, created_at, updated_at
       FROM rotation_snippets
       WHERE server_id = ?
       ORDER BY name`,
      [serverId]
    );
    res.json({ snippets });
  } catch (err) {
    console.error('rotation snippets list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rotation/snippets/:serverId — create a new snippet
router.post('/snippets/:serverId', requireAuth, ensureServerOwner, async (req, res) => {
  const db       = req.app.locals.db;
  const serverId = parseInt(req.params.serverId, 10);
  const userId   = req.user.id;

  const {
    name, description, pattern, ce_type, cfggameplay_array, deploy_path,
    target_file, xml_root_tag, target_path, content, mapgrouppos_content,
    types_content, spawnabletypes_content, tags
  } = req.body;

  if (!name || !pattern || !content) {
    return res.status(400).json({ error: 'name, pattern, and content are required' });
  }

  // Get guild_id from server
  const server = await db.get('SELECT guild_id FROM servers WHERE id = ?', [serverId]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  try {
    const result = await db.run(
      `INSERT INTO rotation_snippets
       (guild_id, server_id, name, description, pattern, ce_type, cfggameplay_array,
        deploy_path, target_file, xml_root_tag, target_path, content, mapgrouppos_content,
        types_content, spawnabletypes_content, tags, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        server.guild_id, serverId, name, description || null, pattern,
        ce_type || null, cfggameplay_array || null, deploy_path || null,
        target_file || null, xml_root_tag || null, target_path || null,
        content, mapgrouppos_content || null, types_content || null,
        spawnabletypes_content || null, tags || null, userId
      ]
    );
    res.json({ success: true, id: result.lastID });
  } catch (err) {
    console.error('rotation snippet create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/rotation/snippets/:serverId/:id — update snippet
router.put('/snippets/:serverId/:id', requireAuth, ensureServerOwner, async (req, res) => {
  const db         = req.app.locals.db;
  const serverId   = parseInt(req.params.serverId, 10);
  const snippetId  = parseInt(req.params.id, 10);

  const {
    name, description, pattern, ce_type, cfggameplay_array, deploy_path,
    target_file, xml_root_tag, target_path, content, mapgrouppos_content,
    types_content, spawnabletypes_content, tags
  } = req.body;

  try {
    const changes = await db.transaction(async transactionDb => {
      await assertRotationDefinitionMutable(
        transactionDb, serverId, req.user.id, { snippetId }
      );
      return transactionDb.run(
        `UPDATE rotation_snippets SET
           name = ?, description = ?, pattern = ?, ce_type = ?, cfggameplay_array = ?,
           deploy_path = ?, target_file = ?, xml_root_tag = ?, target_path = ?,
           content = ?, mapgrouppos_content = ?, types_content = ?, spawnabletypes_content = ?,
           tags = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND server_id = ?`,
        [
          name, description || null, pattern, ce_type || null, cfggameplay_array || null,
          deploy_path || null, target_file || null, xml_root_tag || null, target_path || null,
          content, mapgrouppos_content || null, types_content || null,
          spawnabletypes_content || null, tags || null,
          snippetId, serverId
        ]
      );
    });
    if (!changes.changes) return res.status(404).json({ error: 'Snippet not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('rotation snippet update error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/rotation/snippets/:serverId/:id
router.delete('/snippets/:serverId/:id', requireAuth, ensureServerOwner, async (req, res) => {
  const db        = req.app.locals.db;
  const serverId  = parseInt(req.params.serverId, 10);
  const snippetId = parseInt(req.params.id, 10);

  try {
    const result = await db.transaction(async transactionDb => {
      await assertRotationDefinitionMutable(
        transactionDb, serverId, req.user.id, { snippetId }
      );
      return transactionDb.run(
        'DELETE FROM rotation_snippets WHERE id = ? AND server_id = ?',
        [snippetId, serverId]
      );
    });
    if (!result.changes) return res.status(404).json({ error: 'Snippet not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('rotation snippet delete error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Presets ───────────────────────────────────────────────────────────────────

// GET /api/rotation/presets/:serverId — list presets with their snippets
router.get('/presets/:serverId', requireAuth, ensureServerOwner, async (req, res) => {
  const db       = req.app.locals.db;
  const serverId = parseInt(req.params.serverId, 10);

  try {
    const presets = await db.query(
      `SELECT id, name, description, active, schedule_type, schedule_config, created_at, updated_at
       FROM rotation_presets WHERE server_id = ? ORDER BY name`,
      [serverId]
    );

    // Attach snippet list to each preset
    for (const preset of presets) {
      preset.snippets = await db.query(
        `SELECT rs.id, rs.name, rs.pattern, rps.sort_order
         FROM rotation_snippets rs
         JOIN rotation_preset_snippets rps ON rps.snippet_id = rs.id
         WHERE rps.preset_id = ?
         ORDER BY rps.sort_order`,
        [preset.id]
      );
    }

    res.json({ presets });
  } catch (err) {
    console.error('rotation presets list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rotation/presets/:serverId — create preset
router.post('/presets/:serverId', requireAuth, ensureServerOwner, async (req, res) => {
  const db       = req.app.locals.db;
  const serverId = parseInt(req.params.serverId, 10);
  const userId   = req.user.id;
  const { name, description, schedule_type, schedule_config } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });

  const server = await db.get('SELECT guild_id FROM servers WHERE id = ?', [serverId]);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  try {
    const result = await db.run(
      `INSERT INTO rotation_presets (guild_id, server_id, name, description, schedule_type, schedule_config, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        server.guild_id, serverId, name, description || null,
        schedule_type || 'none',
        schedule_config ? JSON.stringify(schedule_config) : null,
        userId
      ]
    );
    res.json({ success: true, id: result.lastID });
  } catch (err) {
    console.error('rotation preset create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/rotation/presets/:serverId/:id — update preset metadata
router.put('/presets/:serverId/:id', requireAuth, ensureServerOwner, async (req, res) => {
  const db       = req.app.locals.db;
  const serverId = parseInt(req.params.serverId, 10);
  const presetId = parseInt(req.params.id, 10);
  const { name, description, schedule_type, schedule_config } = req.body;

  try {
    const result = await db.transaction(async transactionDb => {
      await assertRotationDefinitionMutable(
        transactionDb, serverId, req.user.id, { presetId }
      );
      return transactionDb.run(
        `UPDATE rotation_presets SET
           name = ?, description = ?, schedule_type = ?, schedule_config = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND server_id = ?`,
        [
          name, description || null,
          schedule_type || 'none',
          schedule_config ? JSON.stringify(schedule_config) : null,
          presetId, serverId
        ]
      );
    });
    if (!result.changes) return res.status(404).json({ error: 'Preset not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('rotation preset update error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/rotation/presets/:serverId/:id
router.delete('/presets/:serverId/:id', requireAuth, ensureServerOwner, async (req, res) => {
  const db       = req.app.locals.db;
  const serverId = parseInt(req.params.serverId, 10);
  const presetId = parseInt(req.params.id, 10);

  try {
    const result = await db.transaction(async transactionDb => {
      await assertRotationDefinitionMutable(
        transactionDb, serverId, req.user.id, { presetId }
      );
      return transactionDb.run(
        'DELETE FROM rotation_presets WHERE id = ? AND server_id = ?',
        [presetId, serverId]
      );
    });
    if (!result.changes) return res.status(404).json({ error: 'Preset not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('rotation preset delete error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Preset ↔ Snippet management ───────────────────────────────────────────────

// POST /api/rotation/presets/:serverId/:id/snippets — add snippet to preset
router.post('/presets/:serverId/:id/snippets', requireAuth, ensureServerOwner, async (req, res) => {
  const db        = req.app.locals.db;
  const serverId  = parseInt(req.params.serverId, 10);
  const presetId  = parseInt(req.params.id, 10);
  const { snippet_id, sort_order } = req.body;

  if (!snippet_id) return res.status(400).json({ error: 'snippet_id is required' });

  try {
    const result = await db.transaction(async transactionDb => {
      await assertRotationDefinitionMutable(
        transactionDb, serverId, req.user.id, { presetId }
      );
      return transactionDb.run(
        `INSERT INTO rotation_preset_snippets (preset_id, snippet_id, sort_order)
         SELECT rp.id, rs.id, ?
         FROM rotation_presets rp
         JOIN rotation_snippets rs ON rs.id = ? AND rs.server_id = rp.server_id
         WHERE rp.id = ? AND rp.server_id = ?
         ON CONFLICT (preset_id, snippet_id) DO UPDATE SET sort_order = ?`,
        [sort_order || 0, snippet_id, presetId, serverId, sort_order || 0]
      );
    });
    if (!result.changes) return res.status(404).json({ error: 'Preset or snippet not found for this server' });
    res.json({ success: true });
  } catch (err) {
    console.error('rotation preset add snippet error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /api/rotation/presets/:serverId/:id/snippets/:sid
router.delete('/presets/:serverId/:id/snippets/:sid', requireAuth, ensureServerOwner, async (req, res) => {
  const db        = req.app.locals.db;
  const serverId  = parseInt(req.params.serverId, 10);
  const presetId  = parseInt(req.params.id, 10);
  const snippetId = parseInt(req.params.sid, 10);

  try {
    const result = await db.transaction(async transactionDb => {
      await assertRotationDefinitionMutable(
        transactionDb, serverId, req.user.id, { presetId }
      );
      return transactionDb.run(
        `DELETE FROM rotation_preset_snippets
         WHERE preset_id = ? AND snippet_id = ?
           AND EXISTS (
             SELECT 1 FROM rotation_presets rp
             JOIN rotation_snippets rs ON rs.id = ? AND rs.server_id = rp.server_id
             WHERE rp.id = ? AND rp.server_id = ?
           )`,
        [presetId, snippetId, snippetId, presetId, serverId]
      );
    });
    if (!result.changes) return res.status(404).json({ error: 'Preset or snippet not found for this server' });
    res.json({ success: true });
  } catch (err) {
    console.error('rotation preset remove snippet error:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Activate / Deactivate ─────────────────────────────────────────────────────

// POST /api/rotation/presets/:serverId/:id/activate
router.post('/presets/:serverId/:id/activate', requireAuth, ensureServerOwner, async (req, res) => {
  const db       = req.app.locals.db;
  const serverId = parseInt(req.params.serverId, 10);
  const presetId = parseInt(req.params.id, 10);
  const userId   = String(req.user.discord_id || req.user.id);

  try {
    await rotationService.activatePreset(
      db,
      presetId,
      serverId,
      userId,
      transactionDb => assertRotationMutationAuthority(transactionDb, serverId, req.user.id)
    );
    res.json({ success: true, message: 'Preset activated' });
  } catch (err) {
    console.error('rotation activate error:', err);
    res.status(err.status || (err.code === 'ROTATION_RECOVERY_PENDING' ? 409 : 500))
      .json({ error: err.message, recoveryPending: err.code === 'ROTATION_RECOVERY_PENDING' });
  }
});

// POST /api/rotation/presets/:serverId/:id/deactivate
router.post('/presets/:serverId/:id/deactivate', requireAuth, ensureServerOwner, async (req, res) => {
  const db       = req.app.locals.db;
  const serverId = parseInt(req.params.serverId, 10);
  const presetId = parseInt(req.params.id, 10);
  const userId   = String(req.user.discord_id || req.user.id);

  try {
    await rotationService.deactivatePreset(
      db,
      presetId,
      serverId,
      userId,
      transactionDb => assertRotationMutationAuthority(transactionDb, serverId, req.user.id)
    );
    res.json({ success: true, message: 'Preset deactivated' });
  } catch (err) {
    console.error('rotation deactivate error:', err);
    res.status(err.status || (err.code === 'ROTATION_RECOVERY_PENDING' ? 409 : 500))
      .json({ error: err.message, recoveryPending: err.code === 'ROTATION_RECOVERY_PENDING' });
  }
});

// ── Provider recovery ─────────────────────────────────────────────────────────

router.post('/recovery/:serverId/:operationId/restore', requireAuth, ensureServerOwner, async (req, res) => {
  const db = req.app.locals.db;
  const serverId = Number(req.params.serverId);
  const operationId = Number(req.params.operationId);
  try {
    const result = await reconcileProviderMutation(db, {
      serverId,
      operationId,
      reconciledBy: `user:${req.user.id}`,
      acquireLock: (transactionDb, exactServerId) => acquireProviderMutationLock(
        transactionDb,
        exactServerId,
        { allowedOperationId: operationId }
      ),
      resolveProviderContext: (transactionDb, exactServerId) => resolveProviderRecoveryContext(
        transactionDb,
        exactServerId,
        req.user.id
      ),
      fileService: missionFileService,
      fileServiceResolver: ({ operation }) => {
        if (operation.workflow === 'provider_settings') return createProviderSettingFileService();
        if (operation.workflow === 'mission_init') return createMissionInitFileService();
        return missionFileService;
      },
      directoryService: economyOverrideService,
      expectedCurrentHashes: req.body?.expectedCurrentHashes || null,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('provider recovery reconciliation error:', error);
    const notFound = error.message === 'Unresolved provider recovery operation not found';
    const status = notFound ? 404
      : (error.status || (error.code === 'SHOP_BUSY' ? 409 : 502));
    res.status(status).json({
      error: error.message,
      recoveryPending: !notFound,
      ...(error.code === 'PROVIDER_RECOVERY_CONFLICT'
        ? { code: error.code, currentHashes: error.currentHashes }
        : {}),
    });
  }
});

// ── History ───────────────────────────────────────────────────────────────────

// GET /api/rotation/history/:serverId
router.get('/history/:serverId', requireAuth, ensureServerOwner, async (req, res) => {
  const db       = req.app.locals.db;
  const serverId = parseInt(req.params.serverId, 10);
  const limit    = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  try {
    const history = await db.query(
      `SELECT id, preset_id, preset_name, action, triggered_by, result, triggered_at
       FROM rotation_history
       WHERE server_id = ?
       ORDER BY triggered_at DESC
       LIMIT ?`,
      [serverId, limit]
    );
    const recovery = await db.query(
      `SELECT id,
              CASE WHEN context_type = 'rotation_preset' THEN context_id::integer ELSE NULL END AS preset_id,
              workflow, action, status, error_summary, created_at, finished_at
       FROM provider_mutations
       WHERE server_id = ? AND status IN ('prepared', 'recovery_pending')
       ORDER BY created_at DESC`,
      [serverId]
    );
    res.json({ history, recovery });
  } catch (err) {
    console.error('rotation history error:', err);
    res.status(500).json({ error: err.message });
  }
});

router._test = { resolveProviderRecoveryContext };

module.exports = router;
