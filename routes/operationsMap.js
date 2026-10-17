'use strict';

const express = require('express');
const { requireServerCapability } = require('../middleware/serverAccess');
const {
  CAPABILITIES,
  authorizeServerMutation,
} = require('../services/authorizationService');
const {
  buildOperationsMapSnapshot,
  parseWindowMinutes,
  isSupportedMapName,
  savePlayerStaffNote,
} = require('../services/operationsMapService');
const { getGuildTokenForExactServer } = require('../utils/guildTokens');
const nitradoService = require('../services/nitradoService');
const { lockUserRoleMutations } = require('../utils/roleMutationLocks');

const router = express.Router();
router.param('serverId', requireServerCapability(CAPABILITIES.SERVER_MODERATE));
const SUPPORTED_MAP_PATTERN = /(?:^|\.)(chernarusplus|enoch|sakhal|namalsk|takistanplus|nasdara)(?:$|\.)/i;

function activeSessionContext(gameserver) {
  if (gameserver?.status !== 'started') return null;
  const liveMap = gameserver?.query?.map;
  const match = String(liveMap || '').match(SUPPORTED_MAP_PATTERN);
  const rawStartedAt = Number(gameserver?.last_status_change);
  const startedAtMs = rawStartedAt < 1e12 ? rawStartedAt * 1000 : rawStartedAt;
  if (!match || !Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
  return { mapName: match[1].toLowerCase(), startedAt: new Date(startedAtMs).toISOString() };
}

router.get('/:serverId', async (req, res) => {
  const mapName = String(req.query.map || '').trim().toLowerCase();
  if (!isSupportedMapName(mapName)) {
    return res.status(400).json({ success: false, error: 'A supported map is required' });
  }

  try {
    const db = req.app.locals.db;
    const { server, guild } = req.authorization;
    const token = await getGuildTokenForExactServer(db, server.id, guild.id);
    if (!token) return res.status(503).json({ success: false, error: 'Active map verification is unavailable' });
    const gameserver = await nitradoService.getRawGameserver(token, server.platformServerId);
    const activeSession = activeSessionContext(gameserver);
    if (!activeSession) {
      return res.status(503).json({ success: false, error: 'Active map verification is unavailable' });
    }
    if (activeSession.mapName !== mapName) {
      return res.status(409).json({
        success: false,
        error: 'Selected map is not the active server map',
        activeMapName: activeSession.mapName,
      });
    }
    const result = await db.transaction(async transactionDb => {
      await lockUserRoleMutations(transactionDb, [req.user.id]);
      const authorization = await authorizeServerMutation(
        transactionDb,
        req.user,
        server.id,
        CAPABILITIES.SERVER_MODERATE
      );
      if (!authorization) return { denied: true };
      const snapshot = await buildOperationsMapSnapshot({
        db: transactionDb,
        serverId: authorization.server.id,
        mapName: activeSession.mapName,
        activeSessionStartedAt: activeSession.startedAt,
        windowMinutes: parseWindowMinutes(req.query.windowMinutes),
      });
      return { snapshot };
    });
    if (result.denied) return res.status(403).json({ success: false, error: 'Access denied' });
    return res.json(result.snapshot);
  } catch (error) {
    console.error('Failed to load operations map:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to load operations map' });
  }
});

router.patch('/:serverId/players/:identityId/note', async (req, res) => {
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
      const staffNote = await savePlayerStaffNote(transactionDb, {
        serverId: authorization.server.id,
        identityId: req.params.identityId,
        actorUserId: req.user.id,
        note: req.body.note,
        expectedVersion: req.body.expectedVersion,
      });
      return { staffNote };
    });
    if (result.denied) return res.status(403).json({ success: false, error: 'Access denied' });
    if (!result.staffNote) return res.status(404).json({ success: false, error: 'Player not found on this server' });
    return res.json({ success: true, staffNote: result.staffNote });
  } catch (error) {
    if (error.code === 'STALE_PLAYER_NOTE') {
      return res.status(409).json({ success: false, error: error.message });
    }
    if (error instanceof TypeError) return res.status(400).json({ success: false, error: error.message });
    console.error('Failed to save player staff note:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to save player note' });
  }
});

module.exports = router;
module.exports.activeSessionContext = activeSessionContext;
