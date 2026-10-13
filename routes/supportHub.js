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

/**
 * GET /server/:serverId/tickets
 * Discord tickets for the server's guild (open + closed, newest first).
 */
router.get('/server/:serverId/tickets', ensureServerAccess, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const guildId = req.authorization?.guild?.id;
    if (!guildId) return res.status(404).json({ error: 'Guild not found' });
    const tickets = await db.all(
      `SELECT id, channel_id, subject, opened_by_discord_id, opened_by_username,
              closed_at, close_reason, message_count, created_at
       FROM tickets
       WHERE guild_id = ?
       ORDER BY created_at DESC
       LIMIT 100`,
      [guildId]
    );
    res.json({ data: tickets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /server/:serverId/tickets/:ticketId
 * Full archived transcript for one ticket (membership-checked via guild).
 */
router.get('/server/:serverId/tickets/:ticketId', ensureServerAccess, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const guildId = req.authorization?.guild?.id;
    if (!guildId) return res.status(404).json({ error: 'Guild not found' });
    const ticket = await db.get(
      `SELECT id, channel_id, subject, opened_by_username, opened_by_discord_id,
              closed_at, close_reason, created_at
       FROM tickets WHERE id = ? AND guild_id = ?`,
      [req.params.ticketId, guildId]
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    const messages = await db.all(
      `SELECT author_id, author_name, content, created_at
       FROM ticket_messages
       WHERE ticket_id = ?
       ORDER BY created_at ASC`,
      [req.params.ticketId]
    );
    res.json({ ticket, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
