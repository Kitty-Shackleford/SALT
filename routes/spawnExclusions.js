'use strict';

const express = require('express');
const { requireServerCapability } = require('../middleware/serverAccess');
const { CAPABILITIES } = require('../services/authorizationService');
const spawnExclusions = require('../services/spawnExclusionService');
const shopFileService = require('../services/shopFileService');

const router = express.Router();
router.param('serverId', requireServerCapability(CAPABILITIES.SERVER_MANAGE));

function canonicalServerId(req) {
  return req.authorization.server.id;
}

router.get('/:serverId', async (req, res) => {
  try {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 100);
    const zones = await spawnExclusions.listExclusionZones(
      req.app.locals.db,
      canonicalServerId(req),
      { page, pageSize }
    );
    return res.json({ zones, page, pageSize });
  } catch (error) {
    if (/must be a positive integer|cannot exceed|offset is too large/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('❌ Failed to list spawn exclusion zones:', error.message);
    return res.status(500).json({ error: 'Failed to list spawn exclusion zones' });
  }
});

router.post('/:serverId/refresh', async (req, res) => {
  try {
    const serverId = canonicalServerId(req);
    const candidates = await spawnExclusions.refreshFlagCandidates(req.app.locals.db, serverId);
    const zones = await spawnExclusions.listExclusionZones(req.app.locals.db, serverId);
    return res.json({ candidateCount: candidates.length, zones });
  } catch (error) {
    console.error('❌ Failed to refresh spawn exclusion candidates:', error.message);
    return res.status(500).json({ error: 'Failed to refresh spawn exclusion candidates' });
  }
});

router.patch('/:serverId/:zoneId', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const serverId = canonicalServerId(req);
    const zone = await db.transaction(async transactionDb => {
      await shopFileService.acquireShopServerLock(transactionDb, serverId);
      return spawnExclusions.reviewExclusionZone(
        transactionDb,
        serverId,
        req.params.zoneId,
        req.user.id,
        {
          status: req.body?.status,
          radius: req.body?.radius,
          label: req.body?.label,
        }
      );
    });
    if (!zone) return res.status(404).json({ error: 'Spawn exclusion zone not found' });
    return res.json({ zone });
  } catch (error) {
    if (/must be|between 1 and 120/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('❌ Failed to review spawn exclusion zone:', error.message);
    return res.status(500).json({ error: 'Failed to review spawn exclusion zone' });
  }
});

module.exports = router;
