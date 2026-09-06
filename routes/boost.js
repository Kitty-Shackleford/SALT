/*
 * DayZ Dashboard — Boost History Route
 * Copyright (C) 2026
 *
 * Proxies Nitrado GameserverBoosting API endpoints:
 *   GET  /:serverId/history   — paginated boost history
 *   GET  /:serverId/settings  — current boost settings (code, messages)
 *   PUT  /:serverId/settings  — update boost settings
 */

const express = require('express');
const router = express.Router();
const nitradoService = require('../services/nitradoService');
const { sendExternalApiError } = require('../utils/externalApiResponse');
const { getGuildTokenForServer } = require('../utils/guildTokens');
const { ensureServerOwner } = require('../middleware/serverAccess');

router.use('/:serverId', ensureServerOwner);


/** Resolve internal server ID → Nitrado service ID + token */
async function getServiceContext(db, serverId) {
  const server = await db.get(
    'SELECT platform_server_id FROM servers WHERE id = ?',
    [serverId]
  );
  if (!server) throw new Error('Server not found');
  const token = await getGuildTokenForServer(db, server.platform_server_id);
  if (!token) throw new Error('No Nitrado token for server');
  return { platformId: server.platform_server_id, token };
}

/** GET /:serverId/history?page=1 */
router.get('/:serverId/history', async (req, res) => {
  try {
    const { platformId, token } = await getServiceContext(req.app.locals.db, req.params.serverId);
    const page = req.query.page || 1;
    res.json(await nitradoService.getBoostHistory(token, platformId, page));
  } catch (err) {
    sendExternalApiError(res, err, 'Nitrado');
  }
});

/** GET /:serverId/settings */
router.get('/:serverId/settings', async (req, res) => {
  try {
    const { platformId, token } = await getServiceContext(req.app.locals.db, req.params.serverId);
    res.json(await nitradoService.getBoostSettings(token, platformId));
  } catch (err) {
    sendExternalApiError(res, err, 'Nitrado');
  }
});

/** PUT /:serverId/settings — update boost message/welcome_message/enabled */
router.put('/:serverId/settings', (_req, res) => {
  return res.status(503).json({
    success: false,
    code: 'PROVIDER_MUTATION_DISABLED',
    error: 'Boost setting changes are temporarily unavailable pending durable provider mutation support'
  });
});

module.exports = router;
