const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const {
  performLogSync,
  getDecryptedToken,
  getGuildDownloadPath,
  resolveOperationalServers,
} = require('./services/logSyncService');
const { scanLogsForServer } = require('./services/logScanService');
const { processDownloadedRestartEvidence } = require('./services/logRestartProcessingService');
const { expireBounties } = require('./services/bountyService');
const {
  markTeleportArrivals,
  processExpiredTeleports,
  processTeleportCleanups,
  processTeleportRestarts,
  processWaitingTeleports,
  refreshRestartEvidence,
} = require('./services/teleportProcessorService');
const {
  buildScheduledLogSyncPlan,
  captureDatabaseClock,
  filterServerIdsWithoutSyncErrors,
  hasUnparsedLogFiles,
  isLogSourceObservationFresh,
  isLogSyncRunSuccessful,
  markServerLogParseSuccessful,
  scheduledLogSyncDue,
  selectServerIdsToParse,
} = require('./utils/logSyncScheduling');

function startScheduler(db) {
  console.log('\n🚀 Starting automation scheduler...');
  console.log('   Checking for sync jobs every 30 seconds');

  // Prevent slow sync and provider queue work from overlapping their next ticks.
  let syncRunning = false;
  let teleportQueueRunning = false;

  async function checkTeleportQueue() {
    if (teleportQueueRunning) return;
    teleportQueueRunning = true;
    try {
      const servers = await db.query(
        `SELECT DISTINCT server_id
         FROM teleport_requests
         WHERE status IN ('waiting_disconnect', 'provisioning', 'armed', 'cleanup_pending', 'cleanup_processing', 'cleanup_restart_pending')
            OR (status = 'failed' AND order_item_id IS NOT NULL AND refunded_at IS NULL)
         ORDER BY server_id`
      );
      for (const server of servers) {
        let restartEvidenceReady = true;
        try {
          await refreshRestartEvidence(db, server.server_id);
        } catch (error) {
          restartEvidenceReady = false;
          console.error(`Teleport restart evidence refresh failed for server ${server.server_id}:`, error.message);
        }
        if (restartEvidenceReady) await markTeleportArrivals(db, server.server_id);
        const expired = await processExpiredTeleports(db, server.server_id, {
          allowLifecycleExpiry: restartEvidenceReady,
        });
        const cleanup = await processTeleportCleanups(db, server.server_id);
        const waiting = await processWaitingTeleports(db, server.server_id);
        const restarts = restartEvidenceReady
          ? await processTeleportRestarts(db, server.server_id)
          : [];
        const retries = [...expired, ...cleanup, ...waiting, ...restarts]
          .filter(outcome => outcome.status === 'retry');
        if (retries.length > 0) {
          console.error(`   ❌ ${retries.length} teleport queue operation(s) remain retryable`);
        }
      }
    } catch (error) {
      console.error('❌ Teleport queue check failed:', error.message);
    } finally {
      teleportQueueRunning = false;
    }
  }

  async function needsLogParse(server) {
    const row = await db.get(
      `SELECT last_sync_at
       FROM servers
       WHERE id = ?`,
      [server.id]
    );
    if (!row?.last_sync_at) return true;

    const configPath = path.join(
      getGuildDownloadPath(server.guildDiscordId, server.platformServerId), 'config'
    );
    let mtimes = [];
    try {
      mtimes = fs.readdirSync(configPath, { withFileTypes: true })
        .filter(entry => entry.isFile() && /\.(?:ADM|RPT)$/i.test(entry.name))
        .map(entry => fs.statSync(path.join(configPath, entry.name)).mtimeMs);
    } catch (error) {
      console.error(
        `   ❌ Could not inspect parse checkpoint for server ${server.platformServerId}:`, error.message
      );
      return true;
    }
    return hasUnparsedLogFiles(row.last_sync_at, mtimes);
  }

  /* eslint-disable require-atomic-updates */
  async function checkAndRunLogSync() {
    if (syncRunning) {
      console.log('\n⏰ Skipping log sync check — previous run still in progress');
      return;
    }
    syncRunning = true;
    console.log('\n⏰ Checking for auto log sync jobs...');

    try {
      const rows = await db.query(
        `SELECT u.id, u.username, u.discord_id, a.auto_log_sync
         FROM users u
         JOIN automation_settings a ON u.id = a.user_id
         WHERE a.auto_log_sync IS NOT NULL`
      );

      if (!rows || rows.length === 0) {
        console.log('   No users with auto-sync enabled');
        return;
      }

      for (const row of rows) {
        try {
          const settings = JSON.parse(row.auto_log_sync);

          if (!settings.enabled) {
            console.log(`   ⏸️  ${row.username}: Auto-sync disabled`);
            continue;
          }

          const interval = settings.interval || 15; // Default 15 minutes
          const now = new Date();

          // Check if it's time to run. Failed runs retain lastRun but use
          // lastAttempt to avoid retrying a slow provider failure every 30 seconds.
          if (scheduledLogSyncDue(settings, now.getTime())) {
            settings.lastAttempt = now.toISOString();
            await db.run(
              'UPDATE automation_settings SET auto_log_sync = ? WHERE user_id = ?',
              [JSON.stringify(settings), row.id]
            );
            console.log(`\n🔄 Auto-sync triggered for ${row.username}`);

            const { serverIds, parseAfterSync } = buildScheduledLogSyncPlan(settings);

            if (serverIds.length === 0) {
              console.log(`   ⚠️  No servers to sync`);
              continue;
            }

            const authorizedServers = await resolveOperationalServers(db, row.id, serverIds);
            if (!authorizedServers || authorizedServers.length !== serverIds.length) {
              console.log('   ⚠️  One or more sync servers are ambiguous or unauthorized');
              continue;
            }
            const serverByPlatformId = new Map(
              authorizedServers.map(server => [server.platformServerId, server])
            );

            // Every configured server must resolve through the same exact
            // authorized provider token before the grouped sync can run.
            const token = await getDecryptedToken(db, row.id, serverIds);
            if (!token) {
              console.log(`   ⚠️  No unique authorized token found for this sync configuration`);
              continue;
            }

            // The finality watermark must never advance past events that could
            // have occurred while the provider download itself was in flight.
            const syncStartedAt = await captureDatabaseClock(db);
            const result = await performLogSync(db, row.id, token, serverIds);

            console.log(`   ✅ Complete: ${result.totalFilesDownloaded} new, ${result.totalFilesUpdated} updated`);

            const parseCandidates = parseAfterSync
              ? await selectServerIdsToParse(
                serverIds,
                result.changedServerIds,
                serverId => needsLogParse(serverByPlatformId.get(String(serverId)))
              )
              : [];
            const serversToParse = filterServerIdsWithoutSyncErrors(
              parseCandidates,
              result.parseBlockedServerIds || result.failedServerIds
            );
            const rptBlockedServerIds = new Set(
              (result.rptBlockedServerIds || []).map(String)
            );

            const parseErrors = [];
            let parsedServers = 0;
            if (serversToParse.length > 0) {
              console.log(`\n📊 Auto-parsing downloaded logs for ${serversToParse.length} server(s)...`);
              for (const serverId of serversToParse) {
                try {
                  const evidence = result.restartEvidence?.[serverId];
                  const scanResult = await scanLogsForServer(db, row.id, serverId, token, {
                    sourceObservedAt: evidence?.latestAdmModifiedAt,
                    sourceObservedLogFile: evidence?.latestAdmPath,
                    includeRptLogs: !rptBlockedServerIds.has(String(serverId)),
                  });
                  if (!scanResult) {
                    parseErrors.push(`Server ${serverId}: No logs were parsed`);
                    continue;
                  }
                  await markServerLogParseSuccessful(
                    db,
                    serverByPlatformId.get(String(serverId)).id,
                    syncStartedAt,
                    { lifecycleEvidenceReady: scanResult.onlineCachePublished === true }
                  );
                  parsedServers++;
                  console.log(`   ✅ Parsed server ${serverId}: ${scanResult.players} players, ${scanResult.killEvents} kills`);
                } catch (parseErr) {
                  parseErrors.push(`Server ${serverId}: ${parseErr.message}`);
                  console.error(`   ❌ Error parsing logs for server ${serverId}:`, parseErr.message);
                }
              }
            }

            // A successful byte-for-byte verification also extends source
            // coverage when that unchanged local generation was already parsed.
            const alreadyParsedServers = filterServerIdsWithoutSyncErrors(
              serverIds,
              result.parseBlockedServerIds || result.failedServerIds
            )
              .filter(serverId => parseAfterSync && !parseCandidates.includes(serverId));
            for (const serverId of alreadyParsedServers) {
              try {
                const evidence = result.restartEvidence?.[serverId];
                const lifecycleEvidenceReady = await isLogSourceObservationFresh(
                  db,
                  evidence?.latestAdmModifiedAt
                );
                await markServerLogParseSuccessful(
                  db,
                  serverByPlatformId.get(String(serverId)).id,
                  syncStartedAt,
                  { lifecycleEvidenceReady }
                );
              } catch (parseErr) {
                parseErrors.push(`Server ${serverId}: ${parseErr.message}`);
              }
            }

            // Process exact-server restart evidence for shop rental lifecycle tracking.
            // Some console servers expose an empty server.log, so the provider's
            // absolute start transition and the newest completed RPT are the fallback.
            const restartServerIds = filterServerIdsWithoutSyncErrors(serverIds, result.failedServerIds);
            for (const platformServerId of restartServerIds) {
              const evidence = result.restartEvidence?.[platformServerId];
              if (!evidence) continue;
              try {
                await processDownloadedRestartEvidence(db, {
                  serverId: serverByPlatformId.get(String(platformServerId)).id,
                  platformServerId,
                }, evidence);
              } catch (restartErr) {
                parseErrors.push(`Server ${platformServerId} restart evidence: ${restartErr.message}`);
                console.error(`   ❌ Error processing restart events for server ${platformServerId}:`, restartErr.message);
              }
            }

            const runSuccessful = isLogSyncRunSuccessful({
              syncErrors: result.errors,
              parseErrors,
              requiredParseCount: serversToParse.length,
              parsedCount: parsedServers,
            });
            if (!runSuccessful) {
              console.error('   ❌ Sync run incomplete; lastRun preserved so it remains retryable');
              continue;
            }

            // Update last run time only after every required operation succeeds.
            settings.lastRun = new Date().toISOString();
            try {
              await db.run(
                'UPDATE automation_settings SET auto_log_sync = ? WHERE user_id = ?',
                [JSON.stringify(settings), row.id]
              );
            } catch (updateErr) {
              console.error('   ❌ Failed to update lastRun:', updateErr.message);
            }

          } else {
            const lastRunMs = settings.lastRun ? Date.parse(settings.lastRun) : NaN;
            const lastAttemptMs = settings.lastAttempt ? Date.parse(settings.lastAttempt) : NaN;
            const latestRunMs = Math.max(
              Number.isFinite(lastRunMs) ? lastRunMs : 0,
              Number.isFinite(lastAttemptMs) ? lastAttemptMs : 0
            );
            const nextRun = new Date(latestRunMs + interval * 60 * 1000);
            const minutesLeft = Math.round((nextRun - now) / 60000);
            console.log(`   ⏳ ${row.username}: Next run in ${minutesLeft} minutes`);
          }

        } catch (rowErr) {
          console.error(`   ❌ Error processing user ${row.username}:`, rowErr.message);
        }
      }
    } catch (err) {
      console.error('❌ Database error:', err);
    } finally {
      syncRunning = false;
    }
  }

  // Run immediately on startup (after 5 seconds)
  setTimeout(() => {
    console.log('\n🔄 Running initial sync check...');
    checkAndRunLogSync();
  }, 5000);

  // Then check every 30 seconds. Slow runs remain serialized independently.
  cron.schedule('*/30 * * * * *', checkAndRunLogSync);
  cron.schedule('*/30 * * * * *', checkTeleportQueue);

  // ── Rotation preset scheduler (checks every 5 minutes) ──────────────────
  const { activatePreset, deactivatePreset } = require('./services/rotationService');

  async function assertScheduledRotationAuthority(transactionDb, presetId, serverId) {
    const authorized = await transactionDb.get(
      `SELECT rp.id
       FROM rotation_presets rp
       JOIN servers s ON s.id = rp.server_id AND s.status = 'active'
       JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
       JOIN guild_tokens gt ON gt.guild_id = g.id
         AND gt.token_type = 'nitrado' AND gt.nitrado_user_id IS NOT NULL
       WHERE rp.id = ? AND rp.server_id = ? AND rp.schedule_type <> 'none'
       FOR NO KEY UPDATE OF rp, s, g, gt`,
      [presetId, serverId]
    );
    if (!authorized) throw new Error('Scheduled rotation authority was revoked');
  }

  async function checkRotationSchedules() {
    const now = new Date();

    try {
      const presets = await db.query(
        `SELECT rp.*
         FROM rotation_presets rp
         JOIN servers s ON s.id = rp.server_id AND s.status = 'active'
         JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
         WHERE rp.schedule_type <> 'none'`
      );

      for (const preset of (presets || [])) {
        let shouldBeActive = preset.active;

        try {
          const cfg = preset.schedule_config ? JSON.parse(preset.schedule_config) : null;

          if (preset.schedule_type === 'date_range' && cfg?.start && cfg?.end) {
            const start = new Date(cfg.start);
            const end   = new Date(cfg.end);
            shouldBeActive = now >= start && now <= end;
          }

          // Recurring handled by activating at cron time; deactivation by duration
          // A full recurring implementation would track activation time in rotation_history

        } catch (parseErr) {
          console.error(`⚠️  Could not parse schedule for preset ${preset.id}:`, parseErr.message);
          continue;
        }

        // Activate if it should be active but isn't
        if (shouldBeActive && !preset.active) {
          console.log(`🔄 [Scheduler] Activating preset "${preset.name}" (scheduled)`);
          await activatePreset(
            db,
            preset.id,
            preset.server_id,
            'scheduler',
            transactionDb => assertScheduledRotationAuthority(
              transactionDb, preset.id, preset.server_id
            )
          ).catch(err =>
            console.error(`❌ [Scheduler] Failed to activate preset ${preset.id}:`, err.message)
          );
        }

        // Deactivate if it should not be active but is
        if (!shouldBeActive && preset.active) {
          console.log(`⏹  [Scheduler] Deactivating preset "${preset.name}" (schedule ended)`);
          await deactivatePreset(
            db,
            preset.id,
            preset.server_id,
            'scheduler',
            transactionDb => assertScheduledRotationAuthority(
              transactionDb, preset.id, preset.server_id
            )
          ).catch(err =>
            console.error(`❌ [Scheduler] Failed to deactivate preset ${preset.id}:`, err.message)
          );
        }
      }
    } catch (err) {
      console.error('❌ Rotation scheduler error:', err.message);
    }
  }

  // Check rotation schedules every 5 minutes
  cron.schedule('*/5 * * * *', checkRotationSchedules);

  // Expire funded bounty contracts in bounded exact-server transactions.
  let bountyExpirationRunning = false;
  cron.schedule('*/5 * * * *', async () => {
    if (bountyExpirationRunning) return;
    bountyExpirationRunning = true;
    try {
      const servers = await db.query("SELECT id FROM servers WHERE status = 'active' ORDER BY id");
      for (const server of (servers || [])) {
        try {
          const result = await db.transaction(() => expireBounties(db, server.id));
          if (result.expiredCount > 0) {
            console.log(
              `💰 [Bounties] Settled ${result.expiredCount} expired contract(s) on server ${server.id}; ` +
              `wallet credited ${result.walletCreditedAmount}, deferred claims ${result.deferredClaimAmount}`
            );
          }
        } catch (error) {
          console.error(`❌ Bounty expiration failed for server ${server.id}:`, error.message);
        }
      }
    } catch (error) {
      console.error('❌ Bounty expiration failed:', error.message);
    } finally {
      bountyExpirationRunning = false;
    }
  });

  // ── AI weekly analysis (Sundays at 3am) ─────────────────────────────────
  // Reviews every server that has a repository link,
  // generating new suggestions based on the past 7 days of kill/loot data.
  cron.schedule('0 3 * * 0', async () => {
    console.log('🤖 [Scheduler] Running weekly AI server analysis...');

    try {
      // Find servers with repository links; inference credentials are configured server-side.
      const connections = await db.query(
        `SELECT DISTINCT grl.user_id, s.id AS server_id,
                s.platform_server_id, s.name AS server_name
         FROM github_repo_links grl
         JOIN servers s ON s.id = grl.server_id`
      );

      for (const conn of (connections || [])) {
        // Only analyze types.xml and events.xml — the highest-value targets
        for (const filename of ['types.xml', 'events.xml']) {
          try {
            // We need the file content — skip if we can't get it without
            // a live Nitrado download. Log a placeholder suggestion instead.
            // Full automation requires a Nitrado token which is per-guild.
            // For now, log that analysis is ready and wait for manual trigger.
            console.log(`   ℹ️  [AI] Skipping auto-download for ${conn.server_name} — trigger manually from dashboard`);
          } catch (fileErr) {
            console.error(`   ❌ [AI] ${filename} for server ${conn.server_id}:`, fileErr.message);
          }
        }
      }
    } catch (err) {
      console.error('❌ AI weekly analysis error:', err.message);
    }
  });

  console.log('   ✅ Scheduler started successfully\n');
}

module.exports = { startScheduler };
