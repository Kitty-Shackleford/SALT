/*
 * routes/backups.js
 *
 * API routes for the Backup Manager dashboard page.
 * Proxies Nitrado Gameserver Backup endpoints:
 *
 *   GET  /api/backups/:serverId           — list all backups
 *   POST /api/backups/:serverId/gameserver — restore a gameserver backup
 *   POST /api/backups/:serverId/database  — restore a database backup
 *
 * Requires authentication. Token is resolved via the guild that owns the server.
 * Permissions needed: ROLE_WEBINTERFACE_BACKUPS_READ, ROLE_WEBINTERFACE_BACKUPS_WRITE
 */

const express = require('express');
const router = express.Router();
const nitradoService = require('../services/nitradoService');
const { sendExternalApiError } = require('../utils/externalApiResponse');
const { getGuildTokenForServer } = require('../utils/guildTokens');
const { ensureServerOwner } = require('../middleware/serverAccess');

router.use('/:serverId', ensureServerOwner);

async function resolveToken(db, serverId) {
  const server = await db.get(
    'SELECT platform_server_id FROM servers WHERE id = ?',
    [serverId]
  );
  if (!server) return { error: 'Server not found', status: 404 };

  const token = await getGuildTokenForServer(db, server.platform_server_id);
  if (!token) return { error: 'No Nitrado token found for this server', status: 403 };

  return { token, platformServerId: server.platform_server_id };
}

/**
 * GET /api/backups/:serverId
 * Returns the full backup list from Nitrado.
 * Response shape: { success, backups: { gameserver: { mapName: [ { backup_type, backup_timestamp, backup_number, backup_size } ] } } }
 */
router.get('/:serverId', async (req, res) => {
  const db = req.app.locals.db;
  const { token, platformServerId, error, status } = await resolveToken(db, req.params.serverId);
  if (error) return res.status(status).json({ success: false, error });

  try {
    const backups = await nitradoService.listBackups(token, platformServerId);
    res.json({ success: true, backups });
  } catch (err) {
    sendExternalApiError(res, err, 'Nitrado');
  }
});

/**
 * POST /api/backups/:serverId/gameserver
 * Restore a gameserver backup.
 * Body: { folder (map directory name), backup (backup timestamp as string) }
 */
router.post('/:serverId/gameserver', (req, res) => {
  const { folder, backup } = req.body;
  if (!folder || !backup) {
    return res.status(400).json({ success: false, error: 'folder and backup are required' });
  }

  return res.status(503).json({
    success: false,
    code: 'PROVIDER_MUTATION_DISABLED',
    error: 'Backup restores are temporarily unavailable because provider restores cannot be compensated safely'
  });
});

/**
 * POST /api/backups/:serverId/database
 * Restore a database backup.
 * Body: { database (database name), timestamp (backup timestamp as string) }
 */
router.post('/:serverId/database', (req, res) => {
  const { database, timestamp } = req.body;
  if (!database || !timestamp) {
    return res.status(400).json({ success: false, error: 'database and timestamp are required' });
  }

  return res.status(503).json({
    success: false,
    code: 'PROVIDER_MUTATION_DISABLED',
    error: 'Backup restores are temporarily unavailable because provider restores cannot be compensated safely'
  });
});

module.exports = router;
