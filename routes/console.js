/*
 * routes/console.js
 *
 * Proxy for sending console commands to the Nitrado gameserver.
 * Note: Xbox servers may not support console commands via the Nitrado API.
 *
 *   POST /api/console/:serverId/command  — send a command, return the response
 *
 * Requires authentication. Token is resolved from the guild that owns the server.
 */

const express = require('express');
const router = express.Router();
const { ensureServerOwner } = require('../middleware/serverAccess');

router.use('/:serverId', ensureServerOwner);

/**
 * POST /api/console/:serverId/command
 * Body: { command: string }
 *
 * Forwards the command to Nitrado and returns the result.
 * On failure the Nitrado error message is passed through (useful for Xbox
 * servers where this feature is unsupported).
 */
router.post('/:serverId/command', (req, res) => res.status(503).json({
  success: false,
  code: 'PROVIDER_MUTATION_DISABLED',
  error: 'Console commands are temporarily unavailable pending durable provider mutation support',
}));

module.exports = router;
