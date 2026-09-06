'use strict';

const express = require('express');
const { ensurePlatformServerOwner } = require('../middleware/serverAccess');
const { getGuildDownloadPath } = require('../services/logSyncService');
const { getEventHealth } = require('../services/eventHealthService');
const { MISSION_SUBDIRS } = require('../utils/dayzPlatform');

const router = express.Router();

router.get('/', ensurePlatformServerOwner, async (req, res) => {
  const mapName = String(req.query.map || '').toLowerCase();
  if (!/^[a-z0-9]+$/.test(mapName)) {
    return res.status(400).json({ success: false, error: 'A valid map is required' });
  }

  try {
    const guildDiscordId = req.platformServerAccess.discordGuildId;
    const platformServerId = req.platformServerAccess.platformServerId;
    const serverPath = getGuildDownloadPath(guildDiscordId, platformServerId);
    const health = await getEventHealth(serverPath, mapName, { missionSubdirs: MISSION_SUBDIRS });
    return res.json({ success: true, mapName, ...health });
  } catch (error) {
    console.error('Failed to load event health:', error.message);
    return res.status(500).json({ success: false, error: 'Failed to load event health' });
  }
});

module.exports = router;
