'use strict';

const express = require('express');
const { ensurePlayerServerAccess, ensureServerAccess } = require('../middleware/serverAccess');
const { getPlayerRadarResponse, getTrustedRadarAudit } = require('../services/radarService');

const router = express.Router();

router.post('/player/:serverId/:identityId', ensurePlayerServerAccess, async (req, res) => {
  try {
    const result = await getPlayerRadarResponse(req.app.locals.db, {
      userId: req.user.id,
      identityId: req.playerServerAccess.identityId,
      serverId: req.playerServerAccess.serverId,
    });
    if (!result) return res.status(403).json({ error: 'Access denied' });
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('POST /api/radar/player/:serverId/:identityId', error);
    return res.status(500).json({ error: 'Failed to load radar response' });
  }
});

router.get('/admin/:serverId', ensureServerAccess, async (req, res) => {
  try {
    const data = await getTrustedRadarAudit(
      req.app.locals.db,
      req.authorization.server.id
    );
    return res.json({ success: true, data });
  } catch (error) {
    console.error('GET /api/radar/admin/:serverId', error);
    return res.status(500).json({ error: 'Failed to load radar audit' });
  }
});

module.exports = router;
