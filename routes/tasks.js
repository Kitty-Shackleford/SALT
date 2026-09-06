/*
 * routes/tasks.js
 *
 * API routes for managing Nitrado scheduled tasks (cron-based restarts, etc.)
 * These are thin proxies to the Nitrado Service_Tasks API endpoints:
 *
 *   GET    /api/tasks/:serverId/list      — available task types for this server
 *   GET    /api/tasks/:serverId           — list current tasks
 *   POST   /api/tasks/:serverId           — create a new task
 *   PUT    /api/tasks/:serverId/:taskId   — update an existing task
 *   DELETE /api/tasks/:serverId/:taskId   — delete a task
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

// Shared helper: get token + validate server ownership
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
 * GET /api/tasks/:serverId/list
 * Returns the task types available for this server (e.g. game_server_restart).
 */
router.get('/:serverId/list', async (req, res) => {
  const db = req.app.locals.db;
  const { token, platformServerId, error, status } = await resolveToken(db, req.params.serverId);
  if (error) return res.status(status).json({ success: false, error });

  try {
    const available = await nitradoService.availableTasks(token, platformServerId);
    const tasks = available.map(task => ({ action_method: task.actionMethod, desc: task.description }));
    res.json({ success: true, tasks });
  } catch (err) {
    sendExternalApiError(res, err, 'Nitrado');
  }
});

/**
 * GET /api/tasks/:serverId
 * Returns all scheduled tasks for this server.
 */
router.get('/:serverId', async (req, res) => {
  const db = req.app.locals.db;
  const { token, platformServerId, error, status } = await resolveToken(db, req.params.serverId);
  if (error) return res.status(status).json({ success: false, error });

  try {
    const tasks = await nitradoService.listTasks(token, platformServerId);
    res.json({ success: true, tasks });
  } catch (err) {
    sendExternalApiError(res, err, 'Nitrado');
  }
});

/**
 * POST /api/tasks/:serverId
 * Create a new scheduled task.
 * Body: { minute, hour, day, month, weekday, action_method, action_data }
 * action_method is the task type key (e.g. "game_server_restart").
 */
router.post('/:serverId', async (req, res) => {
  const { minute, hour, action_method } = req.body;

  if (!minute || !hour || !action_method) {
    return res.status(400).json({ success: false, error: 'minute, hour, and action_method are required' });
  }

  return res.status(503).json({
    success: false,
    code: 'PROVIDER_MUTATION_DISABLED',
    error: 'Scheduled task changes are temporarily unavailable pending stable provider task identity and durable compensation support',
  });
});

/**
 * PUT /api/tasks/:serverId/:taskId
 * Update an existing scheduled task.
 */
router.put('/:serverId/:taskId', async (_req, res) => {
  return res.status(503).json({
    success: false,
    code: 'PROVIDER_MUTATION_DISABLED',
    error: 'Scheduled task changes are temporarily unavailable pending stable provider task identity and durable compensation support',
  });
});

/**
 * DELETE /api/tasks/:serverId/:taskId
 * Delete a scheduled task.
 */
router.delete('/:serverId/:taskId', async (_req, res) => {
  return res.status(503).json({
    success: false,
    code: 'PROVIDER_MUTATION_DISABLED',
    error: 'Scheduled task changes are temporarily unavailable pending stable provider task identity and durable compensation support',
  });
});

module.exports = router;
