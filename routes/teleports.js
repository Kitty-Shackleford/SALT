'use strict';

const express = require('express');
const { requireServerCapability } = require('../middleware/serverAccess');
const { CAPABILITIES } = require('../services/authorizationService');
const {
  createTeleportDestination,
  deactivateTeleportDestination,
  listTeleportDestinations,
} = require('../services/teleportDestinationService');
const { requestModeratorTeleport } = require('../services/teleportService');
const {
  imposePraRestriction,
  releasePraRestriction,
} = require('../services/teleportRestrictionService');

const router = express.Router();
const requireManage = requireServerCapability(CAPABILITIES.SERVER_MANAGE);
const requireModerate = requireServerCapability(CAPABILITIES.SERVER_MODERATE);

function scope(req) {
  return {
    serverId: req.authorization.server.id,
    guildId: req.authorization.guild.id,
    actorUserId: req.user.id,
  };
}

function sendTeleportError(res, error, fallback) {
  if (error.status && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({ error: error.message, code: error.code || undefined });
  }
  if (/is required|is invalid|must contain/.test(error.message)) {
    return res.status(400).json({ error: error.message });
  }
  console.error(`❌ ${fallback}:`, error.message);
  return res.status(500).json({ error: fallback });
}

router.get('/:serverId/destinations', requireManage, async (req, res) => {
  try {
    const destinations = await listTeleportDestinations(req.app.locals.db, scope(req));
    return res.json({ destinations });
  } catch (error) {
    return sendTeleportError(res, error, 'Failed to list teleport destinations');
  }
});

router.post('/:serverId/destinations', requireManage, async (req, res) => {
  try {
    const destination = await req.app.locals.db.transaction(transactionDb =>
      createTeleportDestination(transactionDb, { ...scope(req), ...req.body })
    );
    return res.status(201).json({ destination });
  } catch (error) {
    return sendTeleportError(res, error, 'Failed to create teleport destination');
  }
});

router.delete('/:serverId/destinations/:destinationId', requireManage, async (req, res) => {
  try {
    const destination = await req.app.locals.db.transaction(transactionDb =>
      deactivateTeleportDestination(transactionDb, {
        ...scope(req), destinationId: req.params.destinationId,
      })
    );
    return res.json({ destination });
  } catch (error) {
    return sendTeleportError(res, error, 'Failed to deactivate teleport destination');
  }
});

router.post('/:serverId/restrictions', requireModerate, async (req, res) => {
  try {
    const result = await req.app.locals.db.transaction(db => imposePraRestriction(db, {
      serverId: req.authorization.server.id,
      identityId: req.body?.identityId,
      destinationId: req.body?.destinationId,
      actorUserId: req.user.id,
      reason: req.body?.reason,
      notifyPlayer: req.body?.notifyPlayer,
    }));
    return res.status(201).json(result);
  } catch (error) {
    return sendTeleportError(res, error, 'Failed to impose PRA restriction');
  }
});

router.delete('/:serverId/restrictions/:restrictionId', requireModerate, async (req, res) => {
  try {
    const restriction = await req.app.locals.db.transaction(db => releasePraRestriction(db, {
      serverId: req.authorization.server.id,
      restrictionId: req.params.restrictionId,
      actorUserId: req.user.id,
    }));
    return res.json({ restriction });
  } catch (error) {
    return sendTeleportError(res, error, 'Failed to release PRA restriction');
  }
});

router.post('/:serverId/requests', requireModerate, async (req, res) => {
  try {
    const request = await req.app.locals.db.transaction(transactionDb =>
      requestModeratorTeleport(transactionDb, {
        ...scope(req),
        identityId: req.body?.identityId,
        destinationId: req.body?.destinationId,
        source: 'admin',
        reason: req.body?.reason,
        overridePra: req.body?.overridePra === true,
        notifyPlayer: req.body?.notifyPlayer !== false,
      })
    );
    return res.status(202).json({ request });
  } catch (error) {
    return sendTeleportError(res, error, 'Failed to request teleport');
  }
});

module.exports = router;
