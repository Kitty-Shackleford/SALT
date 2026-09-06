/*
 * DayZ Dashboard — Support Hub Route
 * Copyright (C) 2026
 *
 * Proxies the Nitrado support channels endpoint:
 *   GET /channels — current availability of chat, phone, support_wizard
 */

const express = require('express');
const router = express.Router();
const nitradoService = require('../services/nitradoService');
const { sendExternalApiError } = require('../utils/externalApiResponse');
const { ensureServerAccess } = require('../middleware/serverAccess');


/**
 * GET /channels
 * Returns Nitrado's support channel availability (chat, phone, support_wizard).
 * This endpoint is global and does not need a tenant credential.
 */
router.get('/channels', async (req, res) => {
  try {
    res.json(await nitradoService.getSupportChannels());
  } catch (err) {
    sendExternalApiError(res, err, 'Nitrado');
  }
});

/**
 * GET /service-id/:serverId
 * Returns the Nitrado platform service ID for the given internal server ID.
 * Used by the support page to pre-fill the service ID in support links.
 */
router.get('/service-id/:serverId', ensureServerAccess, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const server = await db.get(
      'SELECT platform_server_id FROM servers WHERE id = ?',
      [req.params.serverId]
    );
    if (!server) return res.status(404).json({ error: 'Server not found' });
    res.json({ platform_server_id: server.platform_server_id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
