'use strict';

const express = require('express');
const { CAPABILITIES } = require('../services/authorizationService');
const { requireServerCapability } = require('../middleware/serverAccess');
const { PLAYER_MAP_FEATURES, parsePlayerMapSettings } = require('../utils/playerMapPolicy');
const { lockAndVerifyLinkSettingsManager } = require('../services/linkSettingsAuthorization');

const router = express.Router();
const requireServerManage = requireServerCapability(CAPABILITIES.SERVER_MANAGE);

router.get('/:serverId', requireServerManage, async (req, res) => {
  try {
    const row = await req.app.locals.db.get(
      "SELECT config FROM server_features WHERE server_id = ? AND feature_name = 'player_map'",
      [req.authorization.server.id]
    );
    return res.json({ success: true, settings: parsePlayerMapSettings(row?.config) });
  } catch (error) {
    console.error('Failed to load player-map settings:', error.message);
    return res.status(500).json({ error: 'Failed to load player-map settings' });
  }
});

router.put('/:serverId', requireServerManage, async (req, res) => {
  const submitted = req.body?.enabledFeatures;
  if (!Array.isArray(submitted)
      || submitted.some(feature => typeof feature !== 'string' || !PLAYER_MAP_FEATURES.includes(feature))) {
    return res.status(400).json({ error: 'Invalid player-map features' });
  }

  const normalized = parsePlayerMapSettings({ enabledFeatures: submitted });
  try {
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

      await db.get(
        "SELECT config FROM server_features WHERE server_id = ? AND feature_name = 'player_map' FOR UPDATE",
        [scope.id]
      );
      await db.run(
        `INSERT INTO server_features (server_id, feature_name, enabled, config, updated_at)
         VALUES (?, 'player_map', 1, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (server_id, feature_name) DO UPDATE SET
           enabled = 1, config = EXCLUDED.config, updated_at = CURRENT_TIMESTAMP`,
        [scope.id, JSON.stringify(normalized)]
      );
      await db.run(
        `INSERT INTO security_audit_events
          (actor_user_id, guild_id, server_id, action, result, target_type, target_id, metadata)
         VALUES (?, ?, ?, 'player_map.policy_changed', 'allowed', 'server', ?, ?)`,
        [req.user.id, scope.guild_id, scope.id, String(scope.id), JSON.stringify(normalized)]
      );
    });
    return res.json({ success: true, settings: normalized });
  } catch (error) {
    if (error.code === 'NOT_FOUND') return res.status(404).json({ error: 'Resource not found' });
    console.error('Failed to save player-map settings:', error.message);
    return res.status(500).json({ error: 'Failed to save player-map settings' });
  }
});

module.exports = router;
