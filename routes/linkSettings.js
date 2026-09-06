'use strict';

const express = require('express');
const { CAPABILITIES } = require('../services/authorizationService');
const { requireServerCapability } = require('../middleware/serverAccess');
const { parseLinkSettings } = require('../utils/linkPolicy');
const { lockAndVerifyLinkSettingsManager } = require('../services/linkSettingsAuthorization');

const router = express.Router();
const VERIFICATION_MODES = ['admin_approval', 'emote', 'open'];
const requireServerManage = requireServerCapability(CAPABILITIES.SERVER_MANAGE);

router.get('/:serverId', requireServerManage, async (req, res) => {
  try {
    const row = await req.app.locals.db.get(
      "SELECT config FROM server_features WHERE server_id = ? AND feature_name = 'player_linking' AND enabled = 1",
      [req.authorization.server.id]
    );
    return res.json({ success: true, settings: parseLinkSettings(row?.config) });
  } catch (error) {
    console.error('Failed to load player-link settings:', error.message);
    return res.status(500).json({ error: 'Failed to load player-link settings' });
  }
});

router.put('/:serverId', requireServerManage, async (req, res) => {
  const verificationMode = String(req.body?.verificationMode || '');
  if (!VERIFICATION_MODES.includes(verificationMode)) {
    return res.status(400).json({ error: 'Invalid verification mode' });
  }
  try {
    let normalized;
    await req.app.locals.db.transaction(async db => {
      const scope = await lockAndVerifyLinkSettingsManager(
        db,
        req.user.id,
        req.authorization.server.id
      );
      if (!scope) {
        const error = new Error('Not found');
        error.code = 'NOT_FOUND';
        throw error;
      }
      const currentRow = await db.get(
        "SELECT config FROM server_features WHERE server_id = ? AND feature_name = 'player_linking' FOR UPDATE",
        [scope.id]
      );
      normalized = parseLinkSettings(currentRow?.config);
      normalized.verificationMode = verificationMode;
      await db.run(
        `INSERT INTO server_features (server_id, feature_name, enabled, config, updated_at)
         VALUES (?, 'player_linking', 1, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (server_id, feature_name) DO UPDATE SET
           enabled = 1, config = EXCLUDED.config, updated_at = CURRENT_TIMESTAMP`,
        [scope.id, JSON.stringify(normalized)]
      );
      await db.run(
        `INSERT INTO security_audit_events
          (actor_user_id, guild_id, server_id, action, result, target_type, target_id, metadata)
         VALUES (?, ?, ?, 'player_link.policy_changed', 'allowed', 'server', ?, ?)`,
        [req.user.id, scope.guild_id, scope.id, String(scope.id), JSON.stringify({ verificationMode })]
      );
    });
    return res.json({ success: true, settings: normalized });
  } catch (error) {
    if (error.code === 'NOT_FOUND') return res.status(404).json({ error: 'Resource not found' });
    console.error('Failed to save player-link settings:', error.message);
    return res.status(500).json({ error: 'Failed to save player-link settings' });
  }
});

module.exports = router;
