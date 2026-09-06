'use strict';

const express = require('express');
const { ensureAuthenticated: defaultEnsureAuthenticated } = require('../middleware/auth');
const { createMissionInitAccessService } = require('../services/missionInitCapabilityService');

function createMissionInitRouter(options = {}) {
  const router = express.Router();
  const ensureAuthenticated = options.ensureAuthenticated || defaultEnsureAuthenticated;
  const accessService = options.accessService || {
    probeForActor(input) {
      return createMissionInitAccessService().probeForActor(input);
    },
  };

  router.get(
    '/servers/:serverId/capabilities/mission-init',
    ensureAuthenticated,
    async (req, res) => {
      try {
        const capability = await accessService.probeForActor({
          db: req.app.locals.db,
          actor: req.user,
          internalServerId: req.params.serverId,
          includeContent: false,
        });
        const publicCapability = { ...capability };
        delete publicCapability.content;
        return res.json({ success: true, capability: publicCapability });
      } catch (error) {
        const status = error.status || 502;
        return res.status(status).json({
          success: false,
          code: status < 500 ? error.code || 'MISSION_INIT_UNAVAILABLE' : 'MISSION_INIT_PROBE_FAILED',
          error: status < 500 ? error.message : 'Mission init capability could not be determined',
        });
      }
    }
  );

  router.get(
    '/servers/:serverId/mission-init',
    ensureAuthenticated,
    async (req, res) => {
      try {
        const result = await accessService.probeForActor({
          db: req.app.locals.db,
          actor: req.user,
          internalServerId: req.params.serverId,
          includeContent: true,
        });
        if (result.status !== 'supported' || !result.rolloutEnabled || typeof result.content !== 'string') {
          const status = result.status === 'unknown' ? 502 : (result.status === 'absent' ? 404 : 409);
          return res.status(status).json({
            success: false,
            code: result.reasonCode || 'MISSION_INIT_UNAVAILABLE',
            error: 'Mission init preview is unavailable for this server',
          });
        }
        const { content, ...capability } = result;
        return res.json({ success: true, capability, content });
      } catch (error) {
        const status = error.status || 502;
        return res.status(status).json({
          success: false,
          code: status < 500 ? error.code || 'MISSION_INIT_UNAVAILABLE' : 'MISSION_INIT_PROBE_FAILED',
          error: status < 500 ? error.message : 'Mission init preview could not be loaded',
        });
      }
    }
  );

  return router;
}

const router = createMissionInitRouter();
router.createMissionInitRouter = createMissionInitRouter;

module.exports = router;
