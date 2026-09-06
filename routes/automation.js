const express = require('express');
const router = express.Router();
const {
  getDecryptedToken,
  resolveOperationalServers,
  performLogSync
} = require('../services/logSyncService');
const { scanLogsForServer } = require('../services/logScanService');
const { processDownloadedRestartEvidence } = require('../services/logRestartProcessingService');
const {
  captureDatabaseClock,
  filterServerIdsWithoutSyncErrors,
  isLogSyncRunSuccessful,
  markServerLogParseSuccessful,
} = require('../utils/logSyncScheduling');

// Get automation settings
router.get('/settings', async (req, res) => {
  const db = req.app.locals.db;

  try {
    const row = await db.get(
      'SELECT * FROM automation_settings WHERE user_id = ?',
      [req.user.id]
    );

    const settings = {
      autoLogSync: row?.auto_log_sync ? JSON.parse(row.auto_log_sync) : { enabled: false, interval: 15, servers: [], autoScan: true },
      autoTracking: row?.auto_tracking ? JSON.parse(row.auto_tracking) : { enabled: false, interval: 60 }
    };

    res.json(settings);
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }
});

// Update auto log sync settings
router.post('/log-sync', async (req, res) => {
  const db = req.app.locals.db;
  const { enabled, interval, autoScan, servers } = req.body;

  try {
    const requestedServerIds = Array.isArray(servers) ? servers : [];
    const authorizedServers = requestedServerIds.length > 0
      ? await resolveOperationalServers(db, req.user.id, requestedServerIds)
      : [];
    if (!authorizedServers) {
      return res.status(403).json({ error: 'Access denied for one or more servers' });
    }
    const canonicalServerIds = authorizedServers.map(server => server.platformServerId);
    if (canonicalServerIds.length > 0 && !await getDecryptedToken(db, req.user.id, canonicalServerIds)) {
      return res.status(400).json({
        success: false,
        error: 'Selected servers must use the same Nitrado account'
      });
    }
    const settings = JSON.stringify({
      enabled,
      interval,
      autoScan,
      servers: canonicalServerIds,
      lastRun: null
    });

    await db.run(
      `INSERT INTO automation_settings (user_id, auto_log_sync) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET auto_log_sync = excluded.auto_log_sync`,
      [req.user.id, settings]
    );

    res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Update auto player tracking settings
router.post('/player-tracking', async (req, res) => {
  const db = req.app.locals.db;
  const { enabled, interval } = req.body;

  const settings = JSON.stringify({
    enabled,
    interval,
    lastRun: null
  });

  try {
    await db.run(
      `INSERT INTO automation_settings (user_id, auto_tracking) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET auto_tracking = excluded.auto_tracking`,
      [req.user.id, settings]
    );

    res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Manual sync trigger - uses shared performLogSync function
router.post('/sync-now', async (req, res) => {
  const db = req.app.locals.db;

  try {
    console.log('🔄 Manual sync triggered by user:', req.user.id);

    // Get user's auto-sync settings
    const settingsRow = await db.get(
      'SELECT auto_log_sync FROM automation_settings WHERE user_id = ?',
      [req.user.id]
    );

    if (!settingsRow || !settingsRow.auto_log_sync) {
      return res.status(400).json({
        success: false,
        error: 'No auto-sync settings found. Please enable and configure auto-sync first.'
      });
    }

    const settings = JSON.parse(settingsRow.auto_log_sync);
    const requestedServerIds = Array.isArray(settings.servers) ? settings.servers : [];

    if (requestedServerIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No servers selected for sync. Please select servers in the settings.'
      });
    }

    const authorizedServers = await resolveOperationalServers(db, req.user.id, requestedServerIds);
    if (!authorizedServers) {
      return res.status(403).json({
        success: false,
        error: 'Access denied for one or more servers'
      });
    }
    const serverIds = authorizedServers.map(server => server.platformServerId);
    const internalServerIdByPlatformId = new Map(
      authorizedServers.map(server => [server.platformServerId, server.id])
    );
    settings.servers = serverIds;
    console.log(`📂 Syncing logs for servers: ${serverIds.join(', ')}`);

    const token = await getDecryptedToken(db, req.user.id, serverIds);
    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'No Nitrado token found'
      });
    }

    // Bound successful source coverage at download start; a kill occurring
    // during the download is not guaranteed to be present in that snapshot.
    const syncStartedAt = await captureDatabaseClock(db);
    const result = await performLogSync(db, req.user.id, token, serverIds);

    // Always parse after a manual sync so player/session caches refresh even
    // when no files changed (e.g., first-time bootstrap from existing logs).
    let parsedServers = 0;
    const parseBlockedServerIds = new Set(
      (result.parseBlockedServerIds || result.failedServerIds || []).map(String)
    );
    const parseErrors = Array.from(
      parseBlockedServerIds,
      serverId => `Server ${serverId}: Sync failed; parsing skipped`
    );
    const serversToParse = filterServerIdsWithoutSyncErrors(serverIds, parseBlockedServerIds);
    const rptBlockedServerIds = new Set(
      (result.rptBlockedServerIds || []).map(String)
    );
    for (const serverId of serversToParse) {
      try {
        const evidence = result.restartEvidence?.[serverId];
        const scanResult = await scanLogsForServer(db, req.user.id, serverId, token, {
          sourceObservedAt: evidence?.latestAdmModifiedAt,
          sourceObservedLogFile: evidence?.latestAdmPath,
          includeRptLogs: !rptBlockedServerIds.has(String(serverId)),
        });
        if (scanResult) {
          await markServerLogParseSuccessful(
            db,
            internalServerIdByPlatformId.get(String(serverId)),
            syncStartedAt,
            { lifecycleEvidenceReady: scanResult.onlineCachePublished === true }
          );
          parsedServers++;
        } else {
          parseErrors.push(`Server ${serverId}: No logs were parsed`);
        }
      } catch (parseErr) {
        parseErrors.push(`Server ${serverId}: ${parseErr.message}`);
      }
    }

    const restartServerIds = filterServerIdsWithoutSyncErrors(serverIds, result.failedServerIds);
    for (const serverId of restartServerIds) {
      const evidence = result.restartEvidence?.[serverId];
      if (!evidence) continue;
      try {
        await processDownloadedRestartEvidence(db, {
          serverId: internalServerIdByPlatformId.get(String(serverId)),
          platformServerId: serverId,
        }, evidence);
      } catch (restartErr) {
        parseErrors.push(`Server ${serverId} restart evidence: ${restartErr.message}`);
      }
    }

    const runSuccessful = isLogSyncRunSuccessful({
      syncErrors: result.errors,
      parseErrors,
      requiredParseCount: serverIds.length,
      parsedCount: parsedServers,
    });

    if (runSuccessful) {
      settings.lastRun = new Date().toISOString();
      await db.run(
        'UPDATE automation_settings SET auto_log_sync = ? WHERE user_id = ?',
        [JSON.stringify(settings), req.user.id]
      );
    }

    console.log(`\n${runSuccessful ? '✅' : '❌'} Sync ${runSuccessful ? 'complete' : 'incomplete'}:`);
    console.log(`   📥 New files downloaded: ${result.totalFilesDownloaded}`);
    console.log(`   🔄 Files updated: ${result.totalFilesUpdated}`);
    console.log(`   ⏭️  Files skipped: ${result.totalFilesSkipped}`);
    console.log(`   📊 Servers parsed: ${parsedServers}/${serverIds.length}`);
    if (result.errors.length > 0) {
      console.log(`   ⚠️  Errors: ${result.errors.length}`);
    }
    if (parseErrors.length > 0) {
      console.log(`   ⚠️  Parse errors: ${parseErrors.length}`);
    }

    res.status(runSuccessful ? 200 : 502).json({
      success: runSuccessful,
      error: runSuccessful ? undefined : 'Sync or log parsing was incomplete; retry remains eligible',
      filesDownloaded: result.totalFilesDownloaded,
      filesUpdated: result.totalFilesUpdated,
      filesSkipped: result.totalFilesSkipped,
      parsedServers,
      parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
      errors: result.errors.length > 0 ? result.errors : undefined
    });

  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({
      success: false,
      error: 'Sync failed: ' + err.message
    });
  }
});

module.exports = router;
