const express = require('express');
const router = express.Router();
const { decryptToken } = require('../utils/encryption');
const { ensurePlatformServerOwner } = require('../middleware/serverAccess');
const nitradoService = require('../services/nitradoService');
const { mutateProviderSettings } = require('../services/providerSettingMutationService');
const { sendExternalApiError } = require('../utils/externalApiResponse');

router.use('/:serverId', ensurePlatformServerOwner);

/**
 * Get decrypted Nitrado token for a guild
 */
async function getGuildToken(db, guildId) {
  const row = await db.get(`
    SELECT gt.token_hash
    FROM guild_tokens gt
    WHERE gt.guild_id = ?
      AND gt.token_type = 'nitrado'
      AND gt.nitrado_user_id IS NOT NULL
    ORDER BY gt.created_at DESC
    LIMIT 1
  `, [guildId]);

  if (!row || !row.token_hash) return null;
  return decryptToken(row.token_hash);
}

/**
 * GET /api/nitrado/settings/:serverId
 * Get Nitrado server settings
 */
router.get('/:serverId', async (req, res) => {
  const { serverId } = req.params;

  const db = req.app.locals.db;

  try {
    const token = await getGuildToken(db, req.platformServerAccess.guildId);

    if (!token) {
      return res.status(404).json({
        error: 'No Nitrado token found for this guild',
        message: 'Use /register-token in Discord to register your token'
      });
    }

    const settings = await nitradoService.getSettings(token, serverId);
    const safeSettings = { ...settings, config: { ...(settings.config || {}) } };
    delete safeSettings.config.hostname;

    res.json({
      success: true,
      settings: safeSettings
    });

  } catch (err) {
    console.error('Error fetching Nitrado settings:', err.code || err.name);
    sendExternalApiError(res, err, 'Nitrado');
  }
});

/**
 * POST /api/nitrado/settings/:serverId
 * Update Nitrado server settings
 */
router.post('/:serverId', async (req, res) => {
  const { serverId } = req.params;
  const { settings } = req.body;

  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return res.status(400).json({ success: false, error: 'settings must be an object' });
  }

  const db = req.app.locals.db;

  try {
    const entries = Object.entries(settings).flatMap(([category, categorySettings]) => {
      if (!categorySettings || typeof categorySettings !== 'object' || Array.isArray(categorySettings)) return [];
      return Object.entries(categorySettings).map(([key, value]) => ({ category, key, value }));
    });
    if (entries.length === 0 || entries.length > 200) {
      return res.status(400).json({ success: false, error: 'settings must contain between 1 and 200 values' });
    }
    if (entries.some(({ category, key }) => category === 'config' && key === 'hostname')) {
      return res.status(400).json({
        success: false,
        error: 'Use the dedicated server hostname controls',
      });
    }

    const result = await mutateProviderSettings({
      db,
      internalServerId: req.platformServerAccess.serverId,
      expectedPlatformServerId: serverId,
      actor: req.user,
      entries,
      action: 'settings_batch',
      contextType: 'nitrado_settings',
    });

    res.json({ success: true, updated: result.updated });

  } catch (err) {
    if (err.status || err.statusCode) {
      return res.status(err.status || err.statusCode).json({
        success: false,
        error: err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }
    console.error('Error updating Nitrado settings:', err.code || err.name);
    return sendExternalApiError(res, err, 'Nitrado');
  }
});

module.exports = router;