'use strict';

const express = require('express');
const { requireServerCapability } = require('../middleware/serverAccess');
const {
  CAPABILITIES,
  authorizeServerMutation,
} = require('../services/authorizationService');
const {
  listTerritories,
  reviewTerritory,
} = require('../services/factionTerritoryService');
const { lockUserRoleMutations } = require('../utils/roleMutationLocks');

const router = express.Router();
router.param('serverId', requireServerCapability(CAPABILITIES.SERVER_MODERATE));

router.get('/:serverId', async (req, res) => {
  try {
    const result = await req.app.locals.db.transaction(async transactionDb => {
      await lockUserRoleMutations(transactionDb, [req.user.id]);
      const authorization = await authorizeServerMutation(
        transactionDb,
        req.user,
        req.authorization.server.id,
        CAPABILITIES.SERVER_MODERATE
      );
      if (!authorization) return { denied: true };
      const territories = await listTerritories(transactionDb, authorization.server.id, {
        status: req.query.status,
        page: req.query.page ?? 1,
        pageSize: req.query.pageSize ?? 50,
      });
      return { territories };
    });
    if (result.denied) return res.status(403).json({ success: false, error: 'Access denied' });
    return res.json({ success: true, territories: result.territories });
  } catch (error) {
    if (error instanceof TypeError) return res.status(400).json({ success: false, error: error.message });
    console.error('Failed to list faction territories:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to list faction territories' });
  }
});

router.patch('/:serverId/:territoryId', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const result = await db.transaction(async transactionDb => {
      await lockUserRoleMutations(transactionDb, [req.user.id]);
      const authorization = await authorizeServerMutation(
        transactionDb,
        req.user,
        req.authorization.server.id,
        CAPABILITIES.SERVER_MODERATE
      );
      if (!authorization) return { denied: true };
      const territory = await reviewTerritory(
        transactionDb,
        authorization,
        req.params.territoryId,
        req.user.id,
        {
          decision: req.body.decision,
          expectedVersion: req.body.expectedVersion,
          note: req.body.note,
        }
      );
      return { territory };
    });
    if (result.denied) return res.status(403).json({ success: false, error: 'Access denied' });
    if (!result.territory) return res.status(404).json({ success: false, error: 'Territory not found' });
    return res.json({ success: true, territory: result.territory });
  } catch (error) {
    if (error.code === 'STALE_TERRITORY') {
      return res.status(409).json({ success: false, error: error.message });
    }
    if (error instanceof TypeError) return res.status(400).json({ success: false, error: error.message });
    console.error('Failed to review faction territory:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to review faction territory' });
  }
});

module.exports = router;
