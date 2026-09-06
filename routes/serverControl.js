/*
 * routes/serverControl.js
 *
 * API routes for the Server Control Panel dashboard page.
 * Proxies restart/start/stop actions to the Nitrado Gameserver API and
 * returns current server status for display.
 *
 *   GET  /api/control/:serverId/status  — fetch live server status from Nitrado
 *   POST /api/control/:serverId/restart — restart the game server
 *   POST /api/control/:serverId/start   — start the game server
 *   POST /api/control/:serverId/stop    — stop the game server
 *
 * Requires authentication. Token is resolved via the guild that owns the server.
 */

const express = require('express');
const router = express.Router();
const { getGuildTokenForServer } = require('../utils/guildTokens');
const { ensureServerOwner } = require('../middleware/serverAccess');
const nitradoService = require('../services/nitradoService');
const { sendExternalApiError } = require('../utils/externalApiResponse');
const { normalizeProviderServerName } = require('../utils/serverNames');

router.use('/:serverId', ensureServerOwner);

// Shared: resolve token and platform server ID from our internal server ID
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
 * GET /api/control/:serverId/status
 * Returns live server status from Nitrado: online state, player count, map, version.
 */
router.get('/:serverId/status', async (req, res) => {
  const db = req.app.locals.db;
  const { token, platformServerId, error, status } = await resolveToken(db, req.params.serverId);
  if (error) return res.status(status).json({ success: false, error });

  try {
    const serverStatus = await nitradoService.getServerStatus(token, platformServerId);
    res.json({ success: true, ...serverStatus });
  } catch (err) {
    sendExternalApiError(res, err, 'Nitrado');
  }
});

/**
 * GET /api/control/:serverId/notifications
 * Returns active Nitrado service notifications (e.g. near-expiry, DDoS alerts).
 */
router.get('/:serverId/notifications', async (req, res) => {
  const db = req.app.locals.db;
  const { token, platformServerId, error, status } = await resolveToken(db, req.params.serverId);
  if (error) return res.status(status).json({ success: false, error });

  try {
    const notifications = await nitradoService.getNotifications(token, platformServerId);
    res.json({ success: true, notifications });
  } catch (err) {
    sendExternalApiError(res, err, 'Nitrado');
  }
});

/**
 * GET /api/control/:serverId/details
 * Returns service-level metadata: suspension date, auto-extension, game type.
 * Used by the expiry widget on the server control panel.
 */
router.get('/:serverId/details', async (req, res) => {
  const db = req.app.locals.db;
  const { token, platformServerId, error, status } = await resolveToken(db, req.params.serverId);
  if (error) return res.status(status).json({ success: false, error });

  try {
    const details = await nitradoService.getServiceDetails(token, platformServerId);
    res.json({
      success: true,
      ...details,
      name: normalizeProviderServerName(details.name, platformServerId),
    });
  } catch (err) {
    sendExternalApiError(res, err, 'Nitrado');
  }
});

/**
 * POST /api/control/:serverId/:action
 * Sends a control action (restart, start, stop) to Nitrado.
 */
router.post('/:serverId/:action', (req, res) => {
  const { action } = req.params;
  if (!['restart', 'start', 'stop'].includes(action)) {
    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
  }
  return res.status(503).json({
    success: false,
    code: 'PROVIDER_MUTATION_DISABLED',
    error: 'Server lifecycle controls are temporarily unavailable pending durable provider mutation support',
  });
});

module.exports = router;
