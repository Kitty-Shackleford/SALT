/*
 * routes/activityLog.js
 *
 * Proxy for Nitrado service logs (server events, file browser actions, etc.)
 *
 *   GET /api/activity/:serverId?page=1  — returns one page of service logs
 *
 * Requires authentication. Token is resolved from the guild that owns the server.
 */

const express = require('express');
const router = express.Router();
const { getGuildTokenForServer } = require('../utils/guildTokens');
const { ensureServerOwner } = require('../middleware/serverAccess');
const nitradoService = require('../services/nitradoService');
const { sendExternalApiError } = require('../utils/externalApiResponse');

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
 * GET /api/activity/:serverId
 * Query params: page (defaults to 1)
 *
 * Returns: { logs, currentPage, pageCount, logCount }
 * Each log entry: { user, category, severity, message, created_at, admin }
 */
router.get('/:serverId', async (req, res) => {
  const db = req.app.locals.db;
  const { token, platformServerId, error, status } = await resolveToken(db, req.params.serverId);
  if (error) return res.status(status).json({ success: false, error });

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  try {
    const data = await nitradoService.getLogs(token, platformServerId, page);
    res.json({ success: true, ...data });
  } catch (err) {
    sendExternalApiError(res, err, 'Nitrado');
  }
});

module.exports = router;
