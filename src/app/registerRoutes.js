/**
 * Route Registration
 *
 * Mounts all Express routes (both file-based router modules and inline
 * route handlers that previously lived in server.js).
 *
 * To add a new feature:
 *   1. Create a router module under routes/ (or src/routes/).
 *   2. Import it here and mount it with app.use().
 */

const path = require('path');
const fs = require('fs');
const passport = require('passport');
const axios = require('../../utils/nitradoHttp');

const { ensureAuthenticated, ensureAdmin } = require('../../middleware/auth');
const {
  ensureHasOperableServers,
  ensureHasServers,
  ensureApproved,
  ensurePlayerApproved,
  ensurePlatformServerOwner,
} = require('../../middleware/serverAccess');
const { apiLimiter, onboardingLimiter, strictLimiter } = require('../../middleware/rateLimiter');
const { validateToken } = require('../../middleware/validators');
const { errorHandler, notFoundHandler } = require('../../middleware/errorHandler');

const { renderWithCsrf } = require('../../utils/renderWithCsrf');
const { getGuildToken, getGuildTokenForServer } = require('../../utils/guildTokens');
const { getUserGuilds } = require('../../utils/discordAPI');
const { getGuildDownloadPath, resolveGuildDiscordId } = require('../../services/logSyncService');
const { getEventSpawnLocations } = require('../../services/eventHealthService');
const { downloadDirectoryRecursive } = require('../../services/nitradoFileService');
const { createNitradoService } = require('../../services/nitradoService');
const {
  MISSION_SUBDIRS,
  detectDayzPlatform,
  inspectNitradoRootEntries,
  isProviderPathWithinRoots,
} = require('../../utils/dayzPlatform');
const {
  appendPath,
  getPublicConfig,
  isPlayerPortalBaseUrl,
  selectRequestBaseUrl
} = require('../../utils/publicConfig');

// Route modules
const missionFilesRoutes = require('../../routes/missionFiles');
const missionInitRoutes = require('../../routes/missionInit');
const validationRoutes = require('../../routes/validation');
const logParserRoutes = require('../../routes/logParser');
const adminRoutes = require('../../routes/admin');
const nitradoRoutes = require('../../routes/nitrado');
const ownerDashboardRoutes = require('../../routes/ownerDashboard');
const playerPortalRoutes = require('../../routes/playerPortal');
const guildsRoutes = require('../../routes/guilds');
const feedsRoutes = require('../../routes/feeds');
const discordRouter = require('../../routes/discord');
const accessRoutes = require('../../routes/access');
const roleManagementRoutes = require('../../routes/roleManagement');
const healthRoutes = require('../../routes/health');
const linkSettingsRoutes = require('../../routes/linkSettings');
const playerMapSettingsRoutes = require('../../routes/playerMapSettings');
const radarRoutes = require('../../routes/radar');
const teleportRoutes = require('../../routes/teleports');

// Inline route modules (previously inlined in server.js)
const automationRoutes = require('../../routes/automation');
const nitradoSettingsRoutes = require('../../routes/nitradoSettings');
const accountLinkingRoutes = require('../../routes/accountLinking');
const economyRoutes = require('../../routes/economy');
const bountyRoutes = require('../../routes/bounties');
const factionsRoutes = require('../../routes/factions');
const casinoRoutes = require('../../routes/casino');
const lootFinderRoutes = require('../../routes/lootFinder');
const shopRoutes = require('../../routes/shop');
const mapHeatmapRoutes = require('../../routes/mapHeatmap');
const spawnExclusionsRoutes = require('../../routes/spawnExclusions');
const tasksRoutes = require('../../routes/tasks');
const serverControlRoutes = require('../../routes/serverControl');
const backupsRoutes = require('../../routes/backups');
const serverStatsRoutes = require('../../routes/serverStats');
const activityLogRoutes = require('../../routes/activityLog');
const consoleRoutes = require('../../routes/console');
const boostRoutes = require('../../routes/boost');
const supportHubRoutes = require('../../routes/supportHub');
const rotationRoutes = require('../../routes/rotation');
const aiRoutes       = require('../../routes/ai');
const eventHealthRoutes = require('../../routes/eventHealth');

const nitradoService = createNitradoService();

async function resolveAuthorizedProviderStructure(token, serverId) {
  const [gameserver, listRes] = await Promise.all([
    nitradoService.getRawGameserver(token, serverId),
    axios.get(
      `https://api.nitrado.net/services/${serverId}/gameservers/file_server/list`,
      { headers: { Authorization: 'Bearer ' + token }, timeout: 10000 }
    ),
  ]);
  const entries = axios.getNitradoFileEntries(listRes);
  const structure = inspectNitradoRootEntries(entries, gameserver);
  const providerPlatform = detectDayzPlatform(gameserver);
  if (providerPlatform === 'unknown' || structure.platform !== providerPlatform || structure.pathsToSync.length === 0) {
    const error = new Error('Nitrado returned an unsupported or inconsistent DayZ file structure');
    error.statusCode = 502;
    throw error;
  }
  return { ...structure, entries, gameserver };
}

function getPlayerPortalRootRedirect(req) {
  return req.isPlayerPortal && req.isAuthenticated() ? '/player' : null;
}

async function listOperableGuilds(db, userId) {
  return db.query(
    `SELECT DISTINCT g.discord_guild_id as id, g.name, g.icon_url as icon
     FROM guilds g
     LEFT JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = ?
     WHERE g.status = 'approved'
       AND (
         gr.role IN ('owner', 'admin')
         OR EXISTS (
           SELECT 1
           FROM servers s
           JOIN server_role_assignments sra
             ON sra.server_id = s.id
            AND sra.guild_id = s.guild_id
           WHERE s.guild_id = g.id
             AND s.status = 'active'
             AND sra.user_id = ?
             AND sra.role = 'admin'
             AND sra.status = 'active'
         )
       )
     ORDER BY g.name`,
    [userId, userId]
  );
}

/**
 * Register all application routes on the Express `app`.
 *
 * @param {import('express').Application} app
 * @param {Function} csrfProtection - csurf middleware instance from createApp
 */
function registerRoutes(app, csrfProtection) {
  const publicConfig = getPublicConfig();

  // Browsers request this legacy path automatically when pages do not declare
  // an icon. Serve the SVG explicitly so every page gets a favicon without
  // duplicating a <link> element across the static HTML files.
  app.get('/favicon.ico', (req, res) => {
    res.type('image/svg+xml').sendFile(path.join(__dirname, '..', '..', 'public', 'favicon.svg'));
  });

  app.get('/api/public-config', (req, res) => {
    res.json(publicConfig);
  });

  app.get('/readyz', async (req, res) => {
    const minimumBotStartedAt = Number(req.query.minimumBotStartedAt);
    if (!Number.isSafeInteger(minimumBotStartedAt) || minimumBotStartedAt <= 0) {
      return res.status(400).json({ ready: false });
    }
    try {
      const bot = await req.app.locals.db.get(
        `SELECT status, started_at, last_heartbeat
         FROM bot_health
         WHERE id = 1 AND status = 'online'
           AND started_at >= to_timestamp(?)
           AND last_heartbeat >= NOW() - INTERVAL '90 seconds'`,
        [minimumBotStartedAt]
      );
      if (!bot) return res.status(503).json({ ready: false });
      return res.json({ ready: true });
    } catch (error) {
      console.error('Readiness check failed:', error.message);
      return res.status(503).json({ ready: false });
    }
  });

  // -------------------------------------------------------------------------
  // API – file-based route modules
  // -------------------------------------------------------------------------
  app.use('/api', missionFilesRoutes);
  app.use('/api', missionInitRoutes);
  app.use('/api', validationRoutes);
  app.use('/api', logParserRoutes);
  app.use('/api/admin', ensureAuthenticated, ensureAdmin, adminRoutes);
  app.use('/api/owner', ensureAuthenticated, ownerDashboardRoutes);
  app.use('/api/player', ensureAuthenticated, playerPortalRoutes);
  app.use('/api/event-health', ensureAuthenticated, eventHealthRoutes);
  app.use('/api/nitrado', ensureAuthenticated, nitradoRoutes);
  app.use('/api/guilds', ensureAuthenticated, guildsRoutes);
  app.get('/api/access/setup', onboardingLimiter);
  app.use('/api/access', ensureAuthenticated, accessRoutes);
  app.use('/api/roles', ensureAuthenticated, roleManagementRoutes);
  app.use('/api/health', ensureAuthenticated, healthRoutes);
  app.use('/api/link-settings', ensureAuthenticated, linkSettingsRoutes);
  app.use('/api/player-map-settings', ensureAuthenticated, playerMapSettingsRoutes);
  app.use('/api/radar', ensureAuthenticated, ensurePlayerApproved, radarRoutes);
  app.use('/api/teleports', ensureAuthenticated, teleportRoutes);
  app.use('/api/automation', ensureAuthenticated, ensureHasOperableServers, automationRoutes);
  app.use('/api/nitrado/settings', ensureAuthenticated, ensureApproved, nitradoSettingsRoutes);
  app.use('/api/accounts', ensureAuthenticated, accountLinkingRoutes);
  app.use('/api/economy', ensureAuthenticated, ensurePlayerApproved, economyRoutes);
  app.use('/api/bounties', ensureAuthenticated, ensurePlayerApproved, bountyRoutes);
  app.use('/api/factions', ensureAuthenticated, ensurePlayerApproved, factionsRoutes);
  // Casino games — requires an economy-enabled guild with casino_enabled = true
  // NOTE: DB migration 028_add_casino.js must be applied before this route works.
  app.use('/api/casino', ensureAuthenticated, ensurePlayerApproved, casinoRoutes);
  app.use('/api/loot', ensureAuthenticated, ensureApproved, lootFinderRoutes);
  app.use('/api/map', ensureAuthenticated, ensurePlayerApproved, mapHeatmapRoutes);
  app.use('/api/spawn-exclusions', ensureAuthenticated, spawnExclusionsRoutes);
  app.use('/api/tasks', ensureAuthenticated, ensureApproved, tasksRoutes);
  app.use('/api/control', ensureAuthenticated, ensureApproved, serverControlRoutes);
  app.use('/api/backups', ensureAuthenticated, ensureApproved, backupsRoutes);
  app.use('/api/stats', ensureAuthenticated, ensureApproved, serverStatsRoutes);
  app.use('/api/activity', ensureAuthenticated, ensureApproved, activityLogRoutes);
  app.use('/api/console', ensureAuthenticated, ensureApproved, consoleRoutes);
  app.use('/api/boost', ensureAuthenticated, ensureApproved, boostRoutes);
  app.use('/api/rotation', ensureAuthenticated, ensureApproved, rotationRoutes);
  app.use('/api/ai', ensureAuthenticated, ensureApproved, aiRoutes);
  app.use('/api/support', ensureAuthenticated, ensureApproved, supportHubRoutes);
  // Shop system — requires migrations 026 and 027 to be applied.
  app.use('/api/shop', ensureAuthenticated, ensurePlayerApproved, shopRoutes);
  app.use('/api/feeds', ensureApproved, feedsRoutes);
  app.use('/api/discord', ensureAuthenticated, ensureApproved, discordRouter);

  // -------------------------------------------------------------------------
  // API – inline handlers
  // -------------------------------------------------------------------------

  // CSRF token endpoint
  app.get('/api/csrf-token', csrfProtection, (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
  });

  // Telemetry metrics (Prometheus exposition)
  try {
    const telemetry = require('../../utils/telemetry');
    // Restrict metrics to authenticated admins only
    const { ensureAuthenticated, ensureAdmin } = require('../../middleware/auth');
    app.get('/metrics', ensureAuthenticated, ensureAdmin, (req, res) => {
      res.set('Content-Type', 'text/plain; version=0.0.4');
      res.send(telemetry.getPrometheusMetrics());
    });
  } catch (e) {
    // telemetry module missing/failing should not prevent app startup
    console.warn('Telemetry metrics endpoint not available:', e.message);
  }

  app.get('/api/user', ensureAuthenticated, (req, res) => {
    res.json({
      username: req.user.username,
      avatar: req.user.avatar,
      discordId: req.user.discord_id,
      // hasToken removed – tokens are now guild-based, use /api/guilds/:guildId/token-status
      isAdmin: req.user.is_admin || 0
    });
  });

  // Public configuration
  // Public config – whitelist minimal keys used by the onboarding page.
  // Rate-limited to prevent scraping/exfiltration.
  app.get('/api/config', onboardingLimiter, (req, res) => {
    res.json({ discordClientId: process.env.DISCORD_CLIENT_ID });
  });

  // User's approved guilds (filtered by role)
  app.get('/api/user/guilds', ensureAuthenticated, async (req, res) => {
    const db = req.app.locals.db;
    const userId = req.user.id;
    try {
      const guilds = await listOperableGuilds(db, userId);
      res.json({ success: true, guilds });
    } catch (err) {
      console.error('❌ Database error:', err);
      res.status(500).json({ success: false, error: 'Database error' });
    }
  });

  // Guilds that have registered servers (for the player portal)
  app.get('/api/user/guilds-with-servers', ensureAuthenticated, async (req, res) => {
    const db = req.app.locals.db;
    const encryptedToken = req.user.access_token;

    if (!encryptedToken) {
      return res.status(401).json({
        success: false,
        error: 'Discord access token not found. Please log out and log back in.'
      });
    }

    try {
      const allGuilds = await getUserGuilds(encryptedToken);

      const rows = await db.query(
        `SELECT DISTINCT g.discord_guild_id
         FROM guilds g
         JOIN servers s ON s.guild_id = g.id
         WHERE g.status = 'approved'
           AND s.status = 'active'
           AND (
             EXISTS (
               SELECT 1 FROM guild_roles gr
               WHERE gr.guild_id = g.id
                 AND gr.user_id = ?
                 AND gr.role IN ('owner', 'admin')
             )
             OR EXISTS (
               SELECT 1 FROM server_role_assignments sra
               WHERE sra.server_id = s.id
                 AND sra.guild_id = g.id
                 AND sra.user_id = ?
                 AND sra.status = 'active'
             )
             OR EXISTS (
               SELECT 1
               FROM server_player_memberships spm
               JOIN linked_accounts la
                 ON la.id = spm.source_link_id
                AND la.user_id = spm.user_id
                AND la.identity_id = spm.identity_id
               WHERE spm.server_id = s.id
                 AND spm.guild_id = g.id
                 AND spm.user_id = ?
                 AND spm.status = 'active'
                 AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
             )
           )`,
        [req.user.id, req.user.id, req.user.id]
      );

        const guildsWithServers = new Set(rows.map(row => String(row.discord_guild_id)));
        const availableGuilds = allGuilds.filter(guild => guildsWithServers.has(String(guild.id)));

        res.json({
          success: true,
          guilds: availableGuilds.map(guild => ({
            id: guild.id,
            name: guild.name,
            icon: guild.icon
          }))
        });
    } catch (error) {
      console.error('❌ Error fetching user guilds:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Public server list placeholder
  app.get('/api/public/servers', ensureAuthenticated, (req, res) => {
    res.json({ success: true, servers: [] });
  });

  // Deprecated – V1 user-based token endpoint
  app.get('/api/servers', ensureAuthenticated, async (req, res) => {
    return res.status(410).json({
      error: 'This endpoint is deprecated. Use /api/guilds/:guildId/servers instead.',
      message: 'Please select a guild first, then fetch servers for that guild.'
    });
  });

  // Deprecated – V1 save-token endpoint
  app.post('/api/save-token', ensureAuthenticated, strictLimiter, validateToken, (req, res) => {
    return res.status(410).json({
      error: 'This endpoint is deprecated in Schema V2',
      message: 'Please use the Discord bot /register-token command to add your token.',
      instructions: 'Run /register-token in your Discord server to register your Nitrado API token for the guild.'
    });
  });

  // Active mission for a server
  app.get('/api/server-active-mission/:serverId', ensureAuthenticated, ensurePlatformServerOwner, async (req, res) => {
    const db = req.app.locals.db;
    const serverId = req.platformServerAccess.platformServerId;

    try {
      const token = await getGuildToken(db, req.platformServerAccess.discordGuildId);

      if (!token) {
        return res.status(400).json({ error: "No token registered for this server's guild" });
      }

      console.log(`\n📡 Fetching active mission for server ${serverId}...`);

      const gameserver = await nitradoService.getRawGameserver(token, serverId);

      if (!gameserver) {
        return res.status(404).json({ success: false, error: 'Gameserver data not found' });
      }

      const mission = gameserver.settings?.config?.mission || gameserver.query?.map;

      if (!mission) {
        return res.json({ success: false, error: 'No active mission found' });
      }

      const mapMatch = mission.match(/\.(chernarusplus|enoch|sakhal|namalsk|takistanplus)/i);
      const mapName = mapMatch ? mapMatch[1].toLowerCase() : null;

      console.log(`✓ Active mission: ${mission}`);
      console.log(`✓ Detected map: ${mapName}`);

      res.json({
        success: true,
        mission,
        mapName,
        serverStatus: gameserver.status,
        playerCount: gameserver.query?.player_current || 0,
        maxPlayers: gameserver.query?.player_max || 0,
        serverName: gameserver.label
      });

    } catch (err) {
      console.error('Error fetching active mission:', err.message);
      res.status(500).json({ success: false, error: 'Failed to fetch server info', details: err.message });
    }
  });

  // Available maps for a server (from local guild downloads)
  app.get('/api/server-maps/:serverId', ensureAuthenticated, ensurePlatformServerOwner, async (req, res) => {
    const serverId = req.platformServerAccess.platformServerId;

    try {
      const serverPath = getGuildDownloadPath(req.platformServerAccess.discordGuildId, serverId);
      console.log(`\n📂 Scanning for available maps in: ${serverPath}`);

      const mapSet = new Set();
      const possiblePaths = [serverPath, ...MISSION_SUBDIRS.map(dir => path.join(serverPath, dir))];

      for (const dir of possiblePaths) {
        if (fs.existsSync(dir)) {
          for (const entry of fs.readdirSync(dir)) {
            const fullPath = path.join(dir, entry);
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
              const mapMatch = entry.match(/\.(chernarusplus|enoch|sakhal|namalsk|takistanplus)/i);
              if (mapMatch) {
                mapSet.add(mapMatch[1].toLowerCase());
                console.log(`   ✓ Found map: ${mapMatch[1].toLowerCase()} (from ${entry})`);
              }
            }
          }
        }
      }

      const detectedMaps = Array.from(mapSet);
      console.log(`✅ Available maps: ${detectedMaps.join(', ')}`);
      res.json({ success: true, maps: detectedMaps });

    } catch (err) {
      console.error('Error listing maps:', err);
      res.status(500).json({ success: false, error: 'Failed to list maps', details: err.message });
    }
  });

  // Event spawn locations for a map
  app.get('/api/event-spawns/:serverId/:mapName', ensureAuthenticated, ensurePlatformServerOwner, async (req, res) => {
    try {
      const serverId = req.platformServerAccess.platformServerId;
      const mapName = String(req.params.mapName || '').toLowerCase();
      if (!/^[a-z0-9]+$/.test(mapName)) {
        return res.status(400).json({ success: false, message: 'Invalid map name' });
      }
      const serverPath = getGuildDownloadPath(req.platformServerAccess.discordGuildId, serverId);
      const result = getEventSpawnLocations(serverPath, mapName, { missionSubdirs: MISSION_SUBDIRS });
      if (result.configurationError) {
        return res.json({ success: false, message: result.configurationError });
      }
      if (!result.eventSpawnsFileFound) {
        console.log(`   ❌ Event spawns file not found for ${mapName}`);
        return res.json({ success: false, message: 'Event spawns file not found' });
      }
      console.log(`   ✅ Loaded ${result.events.length} event types with ${result.totalSpawns} total spawns`);
      res.json({ success: true, events: result.events, totalSpawns: result.totalSpawns });

    } catch (error) {
      console.error('Error loading event spawns:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  });

  // Detect server file structure
  app.get('/api/detect-structure/:serverId', ensureAuthenticated, ensurePlatformServerOwner, async (req, res) => {
    const db = req.app.locals.db;
    const serverId = req.platformServerAccess.platformServerId;

    try {
      const token = await getGuildTokenForServer(db, serverId);

      if (!token) {
        return res.status(400).json({ error: "No token registered for this server's guild" });
      }

      console.log(`\n=== Detecting structure for server ${serverId} ===`);
      console.log('Step 1: Listing root directory...');

      const { platform, missionsPath, configPath, pathsToSync } =
        await resolveAuthorizedProviderStructure(token, serverId);
      const result = {
        success: true,
        platform,
        rootPath: pathsToSync[0],
        missionsPath,
        configPath,
        pathsToSync,
      };
      console.log('Detection result:', result);
      console.log('=== End Detection ===\n');
      res.json(result);

    } catch (err) {
      console.error('Detection error:', err.message);
      res.status(500).json({
        success: false,
        error: 'Failed to detect server structure',
        details: err.message,
        status: err.response?.status
      });
    }
  });

  // Full server sync (background job)
  app.post('/api/sync-server', ensureAuthenticated, ensurePlatformServerOwner, async (req, res) => {
    const db = req.app.locals.db;
    const serverId = req.platformServerAccess.platformServerId;

    console.log('\n🔧 [SYNC-SERVER] Request received:');
    console.log('   User:', req.user?.username, '(ID:', req.user?.id, ')');
    console.log('   Server ID:', serverId);

    if (!serverId) {
      console.error('❌ [SYNC-SERVER] No serverId provided!');
      return res.status(400).json({ error: 'serverId is required' });
    }

    try {
      console.log('🔍 [SYNC-SERVER] Getting guild token for server:', serverId);

      const token = await getGuildTokenForServer(db, serverId);

      if (!token) {
        return res.status(400).json({ error: "No token registered for this server's guild" });
      }

      const { pathsToSync: syncPaths } = await resolveAuthorizedProviderStructure(token, serverId);

      // Insert a new sync job record
      let jobId;
      try {
        const insertResult = await db.run(
          'INSERT INTO sync_jobs (user_id, server_id, status) VALUES (?, ?, ?) RETURNING id',
          [req.user.id, serverId, 'running']
        );
        jobId = insertResult.lastID;
      } catch (err) {
        console.error('❌ [SYNC-SERVER] Failed to create sync job:', err.message);
        return res.status(500).json({ error: 'Failed to create sync job' });
      }

      console.log(`📋 [JOB-${jobId}] Sync job created`);

      // Run download in the background
      (async () => {
        try {
          const guildDiscordId = await resolveGuildDiscordId(db, req.user.id, serverId);
          if (!guildDiscordId) throw new Error('Could not resolve guild for server ' + serverId);
          const serverPath = getGuildDownloadPath(guildDiscordId, serverId);
          const allResults = { files: [], dirs: [], errors: [], totalSize: 0 };

          for (const remotePath of syncPaths) {
            console.log(`\n📂 [JOB-${jobId}] Syncing path: ${remotePath}`);
            try {
              const result = await downloadDirectoryRecursive(token, serverId, remotePath, serverPath, (progress) => {
                console.log(`   [JOB-${jobId}] Progress:`, progress.type, progress.path);
              });
              allResults.files.push(...result.files);
              allResults.dirs.push(...result.dirs);
              allResults.errors.push(...result.errors);
              allResults.totalSize += result.totalSize;
            } catch (pathErr) {
              console.error(`❌ [JOB-${jobId}] Error syncing ${remotePath}:`, pathErr.message);
              allResults.errors.push({ path: remotePath, error: pathErr.message });
            }
          }

          console.log(`\n✅ [JOB-${jobId}] Sync job completed!`);
          console.log(`   Total files: ${allResults.files.length}`);
          console.log(`   Total size: ${(allResults.totalSize / 1024 / 1024).toFixed(2)} MB`);
          console.log(`   Total errors: ${allResults.errors.length}`);

          try {
            await db.run(
              'UPDATE sync_jobs SET status = ?, files_downloaded = ?, total_size = ?, errors = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?',
              ['completed', allResults.files.length, allResults.totalSize, JSON.stringify(allResults.errors), jobId]
            );
            console.log(`✅ [JOB-${jobId}] Job status updated successfully`);
          } catch (updateErr) {
            console.error(`❌ [JOB-${jobId}] Failed to update job status:`, updateErr.message);
          }

        } catch (err) {
          console.error(`❌ [JOB-${jobId}] Sync job failed catastrophically!`);
          console.error(`   Error: ${err.message}`);

          try {
            await db.run(
              'UPDATE sync_jobs SET status = ?, errors = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?',
              ['failed', err.message, jobId]
            );
          } catch (updateErr) {
            console.error(`❌ [JOB-${jobId}] Failed to update job status to failed:`, updateErr.message);
          }
        }
      })();

      console.log(`📤 [SYNC-SERVER] Returning success response with jobId: ${jobId}`);
      res.json({ success: true, jobId, message: 'Sync started in background' });
    } catch (err) {
      console.error('❌ [SYNC-SERVER] Outer catch block triggered!');
      console.error('   Error:', err.message);
      return res.status(500).json({ error: 'Failed to start sync', details: err.message });
    }
  });

  // Sync job status
  app.get('/api/sync-status/:jobId', ensureAuthenticated, async (req, res) => {
    const db = req.app.locals.db;
    const { jobId } = req.params;

    try {
      const row = await db.get(
        'SELECT * FROM sync_jobs WHERE id = ? AND user_id = ?',
        [jobId, req.user.id]
      );
      if (!row) {
        return res.status(404).json({ error: 'Job not found' });
      }

      res.json({
        success: true,
        job: {
          id: row.id,
          serverId: row.server_id,
          status: row.status,
          filesDownloaded: row.files_downloaded,
          totalSize: row.total_size,
          errors: row.errors ? JSON.parse(row.errors) : [],
          startedAt: row.started_at,
          completedAt: row.completed_at
        }
      });
    } catch (err) {
      return res.status(404).json({ error: 'Job not found' });
    }
  });

  // Recent sync jobs for the current user
  app.get('/api/sync-jobs', ensureAuthenticated, async (req, res) => {
    const db = req.app.locals.db;

    try {
      const rows = await db.query(
        'SELECT * FROM sync_jobs WHERE user_id = ? ORDER BY started_at DESC LIMIT 20',
        [req.user.id]
      );
      res.json({
        success: true,
        jobs: rows.map(r => ({
          id: r.id,
          serverId: r.server_id,
          status: r.status,
          filesDownloaded: r.files_downloaded,
          totalSize: r.total_size,
          startedAt: r.started_at,
          completedAt: r.completed_at
        }))
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch jobs' });
    }
  });

  // Downloaded files for the current user
  app.get('/api/downloads', ensureAuthenticated, async (req, res) => {
    const db = req.app.locals.db;

    try {
      const rows = await db.query(
        'SELECT * FROM downloads WHERE user_id = ? ORDER BY downloaded_at DESC LIMIT 100',
        [req.user.id]
      );
      res.json({ success: true, downloads: rows });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch downloads' });
    }
  });

  // List files/directories on a Nitrado server
  app.post('/api/list-files', ensureAuthenticated, ensurePlatformServerOwner, async (req, res) => {
    const db = req.app.locals.db;
    const serverId = req.platformServerAccess.platformServerId;
    const { directoryPath } = req.body;

    if (!serverId) {
      return res.status(400).json({ error: 'serverId is required' });
    }

    try {
      const token = await getGuildTokenForServer(db, serverId);

      if (!token) {
        return res.status(400).json({ error: "No token registered for this server's guild" });
      }

      const structure = await resolveAuthorizedProviderStructure(token, serverId);
      if (!directoryPath) {
        return res.json({
          success: true,
          files: [],
          directories: structure.pathsToSync.map(providerPath => ({
            type: 'dir',
            name: path.posix.basename(providerPath),
            path: providerPath,
          })),
          currentPath: '(server roots)',
        });
      }
      if (!isProviderPathWithinRoots(directoryPath, structure.pathsToSync)) {
        return res.status(403).json({ error: 'Directory is outside this server\'s authorized DayZ roots' });
      }

      const listUrl = `https://api.nitrado.net/services/${serverId}/gameservers/file_server/list?dir=${encodeURIComponent(directoryPath)}`;

      const listRes = await axios.get(listUrl, { headers: { Authorization: 'Bearer ' + token } });
      const entries = axios.getNitradoFileEntries(listRes)
        .filter(entry => isProviderPathWithinRoots(entry.path, structure.pathsToSync));

      res.json({
        success: true,
        files: entries.filter(e => e.type === 'file'),
        directories: entries.filter(e => e.type === 'dir'),
        currentPath: directoryPath || '(root)'
      });

    } catch (err) {
      console.error('List files error:', err?.response?.data || err.message);
      res.status(500).json({ error: 'Failed to list files' });
    }
  });

  // -------------------------------------------------------------------------
  // Auth routes
  // -------------------------------------------------------------------------

  app.get('/auth/discord', (req, res, next) => {
    const host = req.get('host');
    console.log('🔐 Discord OAuth initiated from host:', host);

    const authBaseUrl = selectRequestBaseUrl(host, publicConfig);
    const callbackURL = appendPath(authBaseUrl, '/auth/discord/callback');
    console.log('   Callback URL:', callbackURL);

    req.session.authBaseUrl = authBaseUrl;
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.redirect('/');
      }
      // If the user is already authenticated and unapproved, redirect to root
      if (req.isAuthenticated && req.user && !req.user.is_admin) {
        // Check approved status quickly
        try {
          const db = req.app.locals.db;
          db.query(
            `SELECT g.id FROM guilds g JOIN guild_roles gr ON gr.guild_id = g.id WHERE gr.user_id = $1 AND g.status = $2 LIMIT 1`,
            [req.user.id, 'approved']
          ).then(rows => {
            if (rows && rows.length > 0) return passport.authenticate('discord', { callbackURL })(req, res, next);
            return res.redirect('/');
          }).catch(() => res.redirect('/'));
        } catch (e) {
          return res.redirect('/');
        }
      } else {
        passport.authenticate('discord', { callbackURL })(req, res, next);
      }
    });
  });

  app.get('/auth/discord/callback',
    (req, res, next) => {
      console.log('\n🔄 Discord callback received');
      console.log('   Original auth base URL:', req.session.authBaseUrl);

      const authBaseUrl = req.session.authBaseUrl || selectRequestBaseUrl(req.get('host'), publicConfig);
      const callbackURL = appendPath(authBaseUrl, '/auth/discord/callback');
      console.log('   Using callback URL:', callbackURL);

      passport.authenticate('discord', {
        callbackURL,
        failureRedirect: '/',
        failureMessage: true,
        keepSessionInfo: true
      })(req, res, next);
    },
    (req, res) => {
      console.log('\n✅ Discord authentication successful');
      console.log('   User:', req.user?.username);

      const userCopy = req.user;
      const authBaseUrl = req.session.authBaseUrl;

      req.session.regenerate((err) => {
        if (err) {
          console.error('❌ Session regeneration error:', err);
          return res.redirect('/');
        }

        console.log('🔄 Session regenerated for security');
        req.session.authBaseUrl = authBaseUrl;

        req.login(userCopy, (loginErr) => {
          if (loginErr) {
            console.error('❌ Login error:', loginErr);
            return res.redirect('/');
          }

          req.session.save((saveErr) => {
            if (saveErr) {
              console.error('❌ Session save error:', saveErr);
              return res.redirect('/');
            }

            console.log('✅ Session saved');
            if (isPlayerPortalBaseUrl(authBaseUrl, publicConfig)) {
              res.redirect('/player');
            } else {
              res.redirect('/dashboard');
            }
          });
        });
      });
    }
  );

  app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
  });

  // -------------------------------------------------------------------------
  // HTML page routes
  // -------------------------------------------------------------------------
  const pub = (...parts) => path.join(__dirname, '..', '..', 'public', ...parts);

  // Player portal
  app.get('/player', ensureAuthenticated, (req, res) => {
    console.log('🎮 Player portal accessed');
    console.log('   isPlayerPortal:', req.isPlayerPortal);
    res.set('Cache-Control', 'no-store');
    renderWithCsrf(pub('player-portal.html'), req, res);
  });

  app.get('/player-portal', ensureAuthenticated, apiLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    renderWithCsrf(pub('player-portal.html'), req, res);
  });

  // Standalone player map — same auth requirement as player portal
  app.get('/player-map', ensureAuthenticated, (req, res) => {
    renderWithCsrf(pub('player-map.html'), req, res);
  });

  // Dashboard
  app.get('/dashboard', ensureAuthenticated, async (req, res) => {
    if (req.isPlayerPortal) return res.redirect('/player');
    const db = req.app.locals.db;

    try {
      // Check whether the user owns or administrates any APPROVED guilds
      const rows = await db.query(
        `SELECT g.id FROM guilds g
         JOIN guild_roles gr ON gr.guild_id = g.id
         WHERE gr.user_id = $1 AND g.status = $2
         LIMIT 1`,
        [req.user.id, 'approved']
      );

      if (rows && rows.length > 0) {
        console.log('📊 Dashboard accessed by owner:', req.user?.username);
        return renderWithCsrf(pub('dashboard.html'), req, res);
      }

      // No approved guilds/servers — show splash and prevent access to full dashboard
      console.log('🟡 Onboarding page shown to:', req.user?.username);
      // Tighten Content Security Policy for the minimal onboarding surface
      // Allow only same-origin resources, inline scripts/styles are permitted
      // here because the onboarding page is intentionally minimal. Connect
      // only to self to prevent data exfiltration.
      const csp = [
        "default-src 'self'",
        "script-src 'self' 'sha384-iGbFBTDYNUD4m++6sH3RYWHWW6SQBNmkleVhBSisrtd1kJOotn35QkTZwNtOEWJW'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https://cdn.discordapp.com",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'"
      ].join('; ');
      res.set('Content-Security-Policy', csp);

      // Render the minimal onboarding splash for unregistered users
      return renderWithCsrf(pub('splash.html'), req, res);
    } catch (err) {
      console.error('❌ Error checking guild ownership for dashboard:', err);
      return res.status(503).send('Dashboard authorization is temporarily unavailable.');
    }
  });

  app.get('/dashboard/feeds', apiLimiter, ensureAuthenticated, (req, res) => {
    console.log('🔔 Dashboard feeds accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'feeds.html'), req, res);
  });

  app.get('/dashboard/economy', apiLimiter, ensureAuthenticated, (req, res) => {
    console.log('💰 Dashboard economy accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'economy.html'), req, res);
  });

  app.get('/dashboard/economy-leaderboard', apiLimiter, ensureAuthenticated, (req, res) => {
    console.log('🏆 Dashboard economy leaderboard accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'economy-leaderboard.html'), req, res);
  });

  app.get('/dashboard/economy-transactions', apiLimiter, ensureAuthenticated, (req, res) => {
    console.log('📜 Dashboard economy transactions accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'economy-transactions.html'), req, res);
  });

  app.get('/dashboard/automation', apiLimiter, ensureAuthenticated, ensureHasOperableServers, (req, res) => {
    console.log('⚙️  Dashboard automation accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'automation.html'), req, res);
  });

  app.get('/dashboard/tasks', apiLimiter, ensureAuthenticated, ensureHasServers, (req, res) => {
    console.log('🕒 Task manager accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'tasks.html'), req, res);
  });

  app.get('/dashboard/server-control', apiLimiter, ensureAuthenticated, ensureHasServers, (req, res) => {
    console.log('🎮 Server control accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'server-control.html'), req, res);
  });

  app.get('/dashboard/spawn-exclusions', apiLimiter, ensureAuthenticated, ensureHasServers, (req, res) => {
    console.log('🛡️ Spawn exclusion review accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'spawn-exclusions.html'), req, res);
  });

  app.get('/dashboard/backups', apiLimiter, ensureAuthenticated, ensureHasServers, (req, res) => {
    console.log('💾 Backup manager accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'backups.html'), req, res);
  });

  app.get('/dashboard/rotation', apiLimiter, ensureAuthenticated, ensureHasServers, (req, res) => {
    console.log('🔄 Rotation manager accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'rotation.html'), req, res);
  });

  app.get('/dashboard/ai-assistant', apiLimiter, ensureAuthenticated, ensureHasServers, (req, res) => {
    console.log('🤖 AI assistant accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'ai-assistant.html'), req, res);
  });

  app.get('/dashboard/server-stats', apiLimiter, ensureAuthenticated, ensureHasServers, (req, res) => {
    console.log('📊 Server stats accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'server-stats.html'), req, res);
  });

  app.get('/dashboard/activity-log', apiLimiter, ensureAuthenticated, ensureHasServers, (req, res) => {
    console.log('📋 Activity log accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'activity-log.html'), req, res);
  });

  app.get('/dashboard/console', apiLimiter, ensureAuthenticated, ensureHasServers, (req, res) => {
    console.log('🖥️  Console accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'console.html'), req, res);
  });

  app.get('/dashboard/boost', apiLimiter, ensureAuthenticated, ensureHasServers, (req, res) => {
    console.log('🚀 Boost manager accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'boost.html'), req, res);
  });

  app.get('/dashboard/support', apiLimiter, ensureAuthenticated, ensureHasServers, (req, res) => {
    console.log('🎫 Support hub accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'support.html'), req, res);
  });

  app.get('/dashboard/settings', apiLimiter, ensureAuthenticated, ensureHasServers, (req, res) => {
    console.log('🔧 Dashboard settings accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'settings.html'), req, res);
  });

  app.get('/dashboard/economy-settings', apiLimiter, ensureAuthenticated, (req, res) => {
    console.log('💰 Economy settings accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'economy-settings.html'), req, res);
  });

  app.get('/dashboard/shop-admin', apiLimiter, ensureAuthenticated, (req, res) => {
    console.log('🛒 Shop admin accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'shop-admin.html'), req, res);
  });

  app.get('/dashboard/casino', apiLimiter, ensureAuthenticated, ensureAdmin, (req, res) => {
    console.log('🎰 Casino stats accessed by:', req.user?.username);
    renderWithCsrf(pub('dashboard', 'casino.html'), req, res);
  });

  app.get('/shop', apiLimiter, ensureAuthenticated, (req, res) => {
    console.log('🛒 Player shop accessed by:', req.user?.username);
    res.set('Cache-Control', 'no-store');
    renderWithCsrf(pub('shop.html'), req, res);
  });

  // Server tools
  app.get('/map', ensureAuthenticated, apiLimiter, ensureHasServers, (req, res) => {
    console.log('🗺️  Map page accessed by:', req.user?.username);
    renderWithCsrf(pub('map.html'), req, res);
  });

  app.get('/loot-finder', ensureAuthenticated, apiLimiter, (req, res) => {
    console.log('🔍 Loot finder accessed by:', req.user?.username);
    renderWithCsrf(pub('loot-finder.html'), req, res);
  });

  app.get('/mission-editor', ensureAuthenticated, apiLimiter, ensureHasServers, (req, res) => {
    console.log('📝 Mission editor accessed by:', req.user?.username);
    renderWithCsrf(pub('mission-editor.html'), req, res);
  });

  app.get('/logs', ensureAuthenticated, apiLimiter, ensureHasOperableServers, (req, res) => {
    console.log('📋 Logs page accessed by:', req.user?.username);
    renderWithCsrf(pub('logs.html'), req, res);
  });

  app.get('/server-players', ensureAuthenticated, apiLimiter, (req, res) => {
    console.log('👥 Server players page accessed by:', req.user?.username);
    renderWithCsrf(pub('server-players.html'), req, res);
  });

  app.get('/server-lists', ensureAuthenticated, apiLimiter, (req, res) => {
    console.log('📋 Server lists page accessed by:', req.user?.username);
    renderWithCsrf(pub('server-lists.html'), req, res);
  });

  // Redirects
  app.get('/automation', ensureAuthenticated, apiLimiter, ensureHasServers, (req, res) => {
    res.redirect('/dashboard/automation');
  });

  app.get('/nitrado-settings', ensureAuthenticated, apiLimiter, ensureHasServers, (req, res) => {
    res.redirect('/dashboard/settings');
  });

  app.get('/economy-dashboard', apiLimiter, ensureAuthenticated, (req, res) => {
    res.redirect('/dashboard/economy');
  });

  app.get('/economy-leaderboard', apiLimiter, ensureAuthenticated, (req, res) => {
    res.redirect('/dashboard/economy-leaderboard');
  });

  app.get('/economy-transactions', apiLimiter, ensureAuthenticated, (req, res) => {
    res.redirect('/dashboard/economy-transactions');
  });

  // Admin HTML pages are authenticated read traffic. Keep sensitive API
  // mutations on their route-specific strict limiters so ordinary navigation
  // cannot exhaust the sensitive-operation bucket.
  app.use('/admin/*', ensureAuthenticated, ensureAdmin, apiLimiter);

  app.get('/admin', ensureAuthenticated, ensureAdmin, (req, res) => {
    console.log('⚡ Admin dashboard accessed by:', req.user?.username);
    renderWithCsrf(pub('admin', 'index.html'), req, res);
  });

  app.get('/admin/guilds', (req, res) => {
    console.log('🏰 Admin guilds page accessed by:', req.user?.username);
    renderWithCsrf(pub('admin', 'guilds.html'), req, res);
  });

  app.get('/admin/guilds-approval', (req, res) => {
    console.log('🛡️  Admin guilds approval page accessed by:', req.user?.username);
    renderWithCsrf(pub('admin', 'guilds-approval.html'), req, res);
  });

  app.get('/admin/servers', (req, res) => {
    console.log('🖥️  Admin servers page accessed by:', req.user?.username);
    renderWithCsrf(pub('admin', 'servers.html'), req, res);
  });

  app.get('/admin/users', (req, res) => {
    console.log('👥 Admin users page accessed by:', req.user?.username);
    renderWithCsrf(pub('admin', 'users.html'), req, res);
  });

  app.get('/admin/roles', (req, res) => {
    renderWithCsrf(pub('admin', 'users.html'), req, res);
  });

  app.get('/dashboard/roles', ensureAuthenticated, (req, res) => {
    renderWithCsrf(pub('admin', 'users.html'), req, res);
  });

  app.get('/admin/audit', (req, res) => {
    console.log('📜 Admin audit log accessed by:', req.user?.username);
    renderWithCsrf(pub('admin', 'audit.html'), req, res);
  });

  app.get('/admin/database', (req, res) => {
    console.log('🧹 Admin database tools accessed by:', req.user?.username);
    renderWithCsrf(pub('admin', 'database.html'), req, res);
  });

  app.get('/admin/reports', ensureAuthenticated, ensureAdmin, (req, res) => {
    console.log('📋 Admin reports accessed by:', req.user?.username);
    renderWithCsrf(pub('admin', 'reports.html'), req, res);
  });

  app.get('/admin/feeds', (req, res) => {
    res.redirect('/dashboard/feeds');
  });

  app.get('/admin/supply-monitor', apiLimiter, ensureAdmin, (req, res) => {
    console.log('💎 Admin supply monitor accessed by:', req.user?.username);
    renderWithCsrf(pub('admin', 'supply-monitor.html'), req, res);
  });

  app.get('/admin/economy-analytics', apiLimiter, ensureAdmin, (req, res) => {
    console.log('📊 Admin economy analytics accessed by:', req.user?.username);
    renderWithCsrf(pub('admin', 'economy-analytics.html'), req, res);
  });

  // Root
  app.get('/', (req, res) => {
    const playerPortalRedirect = getPlayerPortalRootRedirect(req);
    if (playerPortalRedirect) return res.redirect(playerPortalRedirect);
    // Show splash to anonymous and unapproved users. The dashboard route
    // already gates approved users; keep root focused on the splash surface.
    return renderWithCsrf(pub('splash.html'), req, res);
  });

  // -------------------------------------------------------------------------
  // Error handlers (must be registered last)
  // -------------------------------------------------------------------------

  // CSRF error handler (before the general error handler)
  app.use((err, req, res, next) => {
    if (err.code !== 'EBADCSRFTOKEN') return next(err);

    console.error('❌ Invalid CSRF token from:', req.user?.username || 'anonymous');

    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Invalid CSRF token. Please refresh the page.' });
    }

    return res.redirect('/?error=csrf');
  });

  // 404 handler
  app.use(notFoundHandler);

  // General error handler
  app.use(errorHandler);
}

module.exports = { getPlayerPortalRootRedirect, listOperableGuilds, registerRoutes };
