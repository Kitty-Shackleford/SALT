const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const nitradoService = require('../services/nitradoService');
const { validatePagination, validateSort } = require('../middleware/validators');
const { ensureAuthenticated } = require('../middleware/auth');
const { ensurePlatformServerOwner } = require('../middleware/serverAccess');
const { decryptToken } = require('../utils/encryption');
const economyHelper = require('../utils/economyHelper');
const { claimBountiesForKillInTransaction } = require('../services/bountyService');
const { playtimeRewardCents, centsToAmount } = require('../utils/money');
const moneySupplyManager = require('../utils/moneySupplyManager');
const { queueKillEvent } = require('../utils/feedEventQueue');
const { resolveGuildDiscordId, getGuildDownloadPath } = require('../services/logSyncService');
const { detectDayzPlatform } = require('../utils/dayzPlatform');
const { compareLogFileEntries, logStartTimeMs, parseStrictTimestampMs } = require('../utils/logFileChronology');
const {
  markTeleportArrivals,
  processTeleportCleanups,
  processWaitingTeleports,
} = require('../services/teleportProcessorService');
const { openContainedFileSync } = require('../utils/safePath');
const {
  lockActiveCaptureServer,
  applyEmoteEventToCaptureInTransaction,
} = require('../services/shopEmoteCaptureService');

const DAYZ_PLAYER_ID_PATTERN = '[A-Za-z0-9_-]+={0,2}';
const DAYZ_PLAYER_ID_REGEX = new RegExp(`^${DAYZ_PLAYER_ID_PATTERN}$`);

function normalizeDayzPlayerId(value, platform = null) {
  const playerId = String(value ?? '').trim();
  if (!playerId || playerId.length > 128 || /^unknown$/i.test(playerId) || !DAYZ_PLAYER_ID_REGEX.test(playerId)) {
    return null;
  }
  return normalizeParserPlatform(platform) === 'xbox' && /^[A-Fa-f0-9]+$/.test(playerId)
    ? playerId.toUpperCase()
    : playerId;
}

function normalizeParsedEventIdentities(eventGroups, platform = null) {
  const normalizeGroup = (events, fieldsForEvent) => {
    const normalizedEvents = [];
    for (const event of events || []) {
      const requiredFields = typeof fieldsForEvent === 'function'
        ? fieldsForEvent(event)
        : fieldsForEvent;
      const normalized = { ...event };
      let valid = true;
      for (const field of requiredFields) {
        const normalizedId = normalizeDayzPlayerId(event[field], platform);
        if (!normalizedId) {
          valid = false;
          break;
        }
        normalized[field] = normalizedId;
      }
      if (valid) normalizedEvents.push(normalized);
    }
    return normalizedEvents;
  };

  return {
    ...eventGroups,
    healthUpdates: normalizeGroup(eventGroups.healthUpdates, ['platformUserId']),
    damageEvents: normalizeGroup(
      eventGroups.damageEvents,
      event => event.attackerPlatformUserId
        ? ['victimPlatformUserId', 'attackerPlatformUserId']
        : ['victimPlatformUserId']
    ),
    killEvents: normalizeGroup(eventGroups.killEvents, ['victimPlatformUserId', 'killerPlatformUserId']),
    territoryEvents: normalizeGroup(eventGroups.territoryEvents, ['platformUserId']),
    deathEvents: normalizeGroup(eventGroups.deathEvents, ['platformUserId']),
    unconsciousEvents: normalizeGroup(eventGroups.unconsciousEvents, ['platformUserId']),
    respawnEvents: normalizeGroup(eventGroups.respawnEvents, ['platformUserId']),
    positionSnapshots: normalizeGroup(eventGroups.positionSnapshots, ['platformUserId']),
    emoteEvents: normalizeGroup(eventGroups.emoteEvents, ['platformUserId']),
  };
}

/**
 * Get guild token helper
 */
async function getGuildToken(db, guildId, platformServerId) {
  const row = await db.get(`
    SELECT gt.token_hash
    FROM guilds g
    JOIN guild_tokens gt ON g.id = gt.guild_id
    JOIN servers s ON s.guild_id = g.id
    WHERE g.discord_guild_id = ?
      AND s.platform_server_id = ?
      AND g.status = 'approved'
      AND gt.token_type = 'nitrado'
      AND gt.nitrado_user_id IS NOT NULL
    ORDER BY gt.created_at DESC
    LIMIT 1
  `, [guildId, platformServerId]);
  if (!row || !row.token_hash) return null;
  return decryptToken(row.token_hash);
}

/**
 * Resolve the local downloaded log directory for a server.
 *
 * Current canonical path:
 *   downloads/{discord_guild_id}/server_{platformServerId}/config
 *
 * Legacy fallbacks are kept for backward compatibility with older downloads.
 */
function isSafeLogDirectory(candidate) {
  try {
    const resolved = path.resolve(candidate);
    const stat = fs.lstatSync(resolved);
    return stat.isDirectory() && !stat.isSymbolicLink() && fs.realpathSync(resolved) === resolved;
  } catch (_error) {
    return false;
  }
}

async function resolveDownloadedLogDir(db, user, platformServerId) {
  const userId = String(user?.id || '');
  const userDiscordId = String(user?.discord_id || '');

  // Canonical shared guild path (current)
  const guildDiscordId = await resolveGuildDiscordId(db, userId, platformServerId);
  if (guildDiscordId) {
    const canonical = path.join(getGuildDownloadPath(guildDiscordId, platformServerId), 'config');
    if (isSafeLogDirectory(canonical)) {
      return { baseDir: canonical, triedPaths: [canonical] };
    }
  }

  // Legacy per-user paths (old layout)
  const possiblePaths = [
    path.join(__dirname, '..', 'downloads', userDiscordId, `server_${platformServerId}`, 'config'),
    path.join(__dirname, '..', 'downloads', userDiscordId, `server_${platformServerId}`),
    path.join(__dirname, '..', 'downloads', userDiscordId, String(platformServerId), 'config'),
    path.join(__dirname, '..', 'downloads', userDiscordId, String(platformServerId)),
    path.join(__dirname, '..', 'downloads', userId, `server_${platformServerId}`, 'config'),
    path.join(__dirname, '..', 'downloads', userId, `server_${platformServerId}`),
    path.join(__dirname, '..', 'downloads', userId, String(platformServerId), 'config'),
    path.join(__dirname, '..', 'downloads', userId, String(platformServerId))
  ].filter(Boolean);

  for (const testPath of possiblePaths) {
    if (isSafeLogDirectory(testPath)) {
      return { baseDir: testPath, triedPaths: possiblePaths };
    }
  }

  return { baseDir: null, triedPaths: possiblePaths };
}

// Parse logs and extract player info (manual upload)
router.post('/parse-logs', ensurePlatformServerOwner, async (req, res) => {
  const serverId = req.platformServerAccess.platformServerId;
  const platform = req.platformServerAccess.platform;
  const { admLog, rptLog } = req.body;

  if (!admLog && !rptLog) {
    return res.status(400).json({ error: 'No log content provided' });
  }

  try {
    const playerMap = new Map();

    // Parse ADM log
    if (admLog) {
      const admPlayers = parseADMLog(admLog, platform);
      admPlayers.forEach(player => {
        const key = (player.playerName || player.platformUserId || '').toLowerCase();
        playerMap.set(key, player);
      });
    }

    // Parse RPT log and merge data
    if (rptLog) {
      const rptPlayers = parseRPTLog(rptLog, platform);
      rptPlayers.forEach(player => {
        const key = (player.playerName || player.platformUserId || '').toLowerCase();
        if (playerMap.has(key)) {
          const existing = playerMap.get(key);
          // Only merge deviceId from RPT, ignore dpnid to keep ADM's hashed platformUserId
          existing.deviceId = player.deviceId || existing.deviceId;
        } else {
          playerMap.set(key, player);
        }
      });
    }

    const players = Array.from(playerMap.values());

    const db = req.app.locals.db;

    // Save to database using new schema before reporting success.
    await savePlayersToDatabase(
      db,
      req.user.id,
      serverId,
      players,
      platform,
      req.platformServerAccess.serverId,
    );

    res.json({
      success: true,
      players,
      totalPlayers: players.length
    });

  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: 'Failed to parse logs', details: err.message });
  }
});

// Scan local downloaded logs
router.post('/scan-local-logs', ensurePlatformServerOwner, async (req, res) => {
  const serverId = req.platformServerAccess.platformServerId;
  const guildId = req.platformServerAccess.discordGuildId;
  if (!serverId || !guildId) {
    return res.status(400).json({ error: 'Server ID and guild ID required' });
  }

  const db = req.app.locals.db;
  try {
    const token = await getGuildToken(db, guildId, serverId);
    const scanResult = await scanLogsForServer(db, req.user.id, serverId, token, {
      internalServerId: req.platformServerAccess.serverId,
    });
    if (!scanResult) {
      return res.status(404).json({
        error: 'No ADM or RPT log files found in downloaded files.'
      });
    }
    return res.json({ success: true, ...scanResult });
  } catch (err) {
    console.error('Scan error:', err);
    return res.status(500).json({ error: 'Failed to scan logs', details: err.message });
  }
});

// Scan ALL local downloaded logs for a server
router.post('/scan-all-logs', ensurePlatformServerOwner, async (req, res) => {
  console.log('\n📨 [API] POST /api/scan-all-logs');
  console.log('   User:', req.user?.username);
  console.log('   Body:', req.body);

  const serverId = req.platformServerAccess.platformServerId;
  const guildId = req.platformServerAccess.discordGuildId;

  if (!serverId) {
    console.error('❌ [API] No serverId provided');
    return res.status(400).json({ error: 'Server ID required' });
  }

  if (!guildId) {
    console.error('❌ [API] No guildId provided');
    return res.status(400).json({ error: 'Guild ID required' });
  }

  console.log('   Server ID:', serverId);
  console.log('   Guild ID:', guildId);

  const db = req.app.locals.db;

  try {
    const { baseDir, triedPaths } = await resolveDownloadedLogDir(db, req.user, serverId);
    console.log(`🔍 Scanning ALL logs for server ${serverId}`);
    if (baseDir) console.log(`  ✓ Found logs directory: ${baseDir}`);

    if (!baseDir) {
      return res.status(404).json({
        error: 'No logs found for this server. Please download logs first using the file browser.',
        debug: { serverId, triedPaths }
      });
    }

    // Get guild token and fetch platform from API
    const token = await getGuildToken(db, guildId, serverId);
    const platform = await resolveServerPlatform(db, token, serverId, {
      baseDir,
      internalServerId: req.platformServerAccess.serverId,
    });

    // Bind platform metadata updates to the exact server authorized by middleware.
    await db.run(
      'UPDATE servers SET platform = ? WHERE id = ?',
      [platform, req.platformServerAccess.serverId]
    ).then(() => {
      console.log(`  ✅ Updated server platform to: ${platform}`);
    }).catch(err => {
      console.error('  ⚠️ Failed to update server platform:', err.message);
    });

    console.log(`  🎮 Platform: ${platform}`);

    const scanResult = await scanLogsForServer(
      db,
      req.user.id,
      serverId,
      token,
      {
        fullHistory: true,
        internalServerId: req.platformServerAccess.serverId,
      }
    );
    if (!scanResult) {
      return res.status(404).json({ error: 'No ADM or RPT log files found in downloaded files.' });
    }

    return res.json({
      success: true,
      message: `Scanned ${scanResult.filesScanned.admCount} ADM and ${scanResult.filesScanned.rptCount} RPT log files`,
      ...scanResult,
    });

  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: 'Failed to scan logs', details: err.message });
  }
});

// Helper: Fetch server info from Nitrado API and detect platform
async function fetchServerPlatform(token, nitradoServerId) {
  try {
    const gameserver = await nitradoService.getRawGameserver(token, nitradoServerId);
    const game = gameserver?.game?.toLowerCase() || '';

    console.log(`  📡 Nitrado API game type: ${game}`);

    const platform = detectDayzPlatform(gameserver);
    return platform === 'pc' ? 'steam' : platform;
  } catch (err) {
    console.error('  ❌ Error fetching server info from Nitrado:', err.message);
    return 'unknown';
  }
}

// Helper: Find newest log file recursively using strict filename chronology
function findLogFile(dir, pattern) {
  const matches = findAllLogFiles(dir, pattern, Infinity);
  const entries = matches.map(filePath => {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Invalid log file: ${filePath}`);
    return {
      filePath,
      name: path.basename(filePath),
      mtimeMs: stat.mtimeMs,
    };
  });
  entries.sort(compareLogFileEntries);
  return entries.length > 0 ? entries[entries.length - 1].filePath : null;
}

// Helper: Detect platform from directory path (fallback)
function detectPlatformFromPath(dirPath) {
  const platform = detectDayzPlatform({ game: String(dirPath).toLowerCase() });
  return platform === 'pc' ? 'steam' : platform;
}

function normalizeParserPlatform(value) {
  const platform = String(value || '').toLowerCase();
  if (platform === 'ps' || platform === 'playstation') return 'playstation';
  if (platform === 'pc' || platform === 'steam') return 'steam';
  if (platform === 'xbox' || platform === 'switch2') return platform;
  return null;
}

async function resolveServerPlatform(db, token, serverId, {
  fetchPlatform = fetchServerPlatform,
  baseDir = null,
  internalServerId = null,
} = {}) {
  const providerPlatform = token
    ? normalizeParserPlatform(await fetchPlatform(token, serverId))
    : null;
  if (providerPlatform) return providerPlatform;

  const pathPlatform = baseDir ? normalizeParserPlatform(detectPlatformFromPath(baseDir)) : null;
  if (pathPlatform) return pathPlatform;

  if (!Number.isSafeInteger(Number(internalServerId)) || Number(internalServerId) <= 0) {
    throw new Error(`Unable to determine platform for exact server ${serverId}`);
  }
  const server = await db.get(
    'SELECT platform FROM servers WHERE id = ?',
    [Number(internalServerId)],
  );
  const storedPlatform = normalizeParserPlatform(server?.platform);
  if (storedPlatform) {
    console.warn(`  ⚠️ Using stored platform for exact server ${serverId}`);
    return storedPlatform;
  }

  throw new Error(`Unable to determine platform for exact server ${serverId}`);
}

/**
 * Maximum bytes to read from a single log file.
 * ADM/RPT files can grow to hundreds of MB on long-running servers.
 * Reading the whole file into memory and then calling .split('\n') many
 * times per parse pass can exhaust the Node.js heap.  We read only the
 * most-recent portion of very large files so we always capture the latest
 * events while bounding memory use.
 */
const MAX_LOG_FILE_BYTES = 20 * 1024 * 1024; // 20 MB — balances event coverage vs heap pressure

/**
 * Read a log file safely, capping at MAX_LOG_FILE_BYTES from the end of the
 * file.  For files within the limit the behaviour is identical to readFileSync.
 * For oversized files we seek to the last MAX_LOG_FILE_BYTES, then discard the
 * (likely partial) first line so every returned line is complete.
 *
 * @param {string} filePath - Absolute path to the log file.
 * @returns {string} UTF-8 file content, at most MAX_LOG_FILE_BYTES long.
 */
function openLogFile(filePath, rootDir = path.dirname(filePath)) {
  const relativePath = path.relative(rootDir, filePath);
  return openContainedFileSync(rootDir, relativePath);
}

function readLogFileSafely(filePath, { fullHistory = false, rootDir = path.dirname(filePath) } = {}) {
  const { fd, stat } = openLogFile(filePath, rootDir);
  try {
    if (fullHistory || stat.size <= MAX_LOG_FILE_BYTES) {
      return fs.readFileSync(fd, 'utf-8');
    }

    const sizeMB = Math.round(stat.size / 1024 / 1024);
    console.warn(`⚠️  Log file is ${sizeMB} MB — reading last ${MAX_LOG_FILE_BYTES / 1024 / 1024} MB only: ${path.basename(filePath)}`);

    const buf = Buffer.alloc(MAX_LOG_FILE_BYTES);
    fs.readSync(fd, buf, 0, MAX_LOG_FILE_BYTES, stat.size - MAX_LOG_FILE_BYTES);
    const content = buf.toString('utf-8');
    const firstNewline = content.indexOf('\n');
    return firstNewline >= 0 ? content.slice(firstNewline + 1) : content;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Async generator that streams lines from a log file without loading the
 * entire content into a string.  For files larger than MAX_LOG_FILE_BYTES,
 * seeks to the last MAX_LOG_FILE_BYTES so recent events are always captured.
 *
 * This avoids the String.split() OOM that occurs when Node tries to create
 * hundreds of thousands of substring objects from a 50 MB+ buffer all at once.
 *
 * @param {string} filePath - Absolute path to the log file.
 * @yields {string} Each complete line of the file.
 */
/* eslint-disable no-unused-vars */
async function* streamLogLines(filePath, {
  fullHistory = false,
  rootDir = path.dirname(filePath),
} = {}) {
  const { fd, stat } = openLogFile(filePath, rootDir);
  const start = !fullHistory && stat.size > MAX_LOG_FILE_BYTES ? stat.size - MAX_LOG_FILE_BYTES : 0;
  const sourceLineBase = countNewlinesBeforeFd(fd, start);

  if (start > 0) {
    const sizeMB = Math.round(stat.size / 1024 / 1024);
    console.warn(`⚠️  Log ${path.basename(filePath)} is ${sizeMB} MB — streaming last ${MAX_LOG_FILE_BYTES / 1024 / 1024} MB`);
  }

  const fileStream = fs.createReadStream(filePath, { fd, start, encoding: 'utf8', autoClose: true });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let skipFirst = start > 0;
  let sourceLineIndex = sourceLineBase - 1;
  try {
    for await (const line of rl) {
      sourceLineIndex++;
      if (skipFirst) { skipFirst = false; continue; }
      yield { line, sourceLineIndex };
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }
}

function countNewlinesBeforeFd(fd, endOffset) {
  if (endOffset <= 0) return 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  let count = 0;
  while (position < endOffset) {
    const bytesRead = fs.readSync(fd, buffer, 0, Math.min(buffer.length, endOffset - position), position);
    if (bytesRead === 0) break;
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0x0a) count++;
    }
    position += bytesRead;
  }
  return count;
}

function sourceLineBaseForSafeRead(filePath, rootDir = path.dirname(filePath)) {
  const { fd, stat } = openLogFile(filePath, rootDir);
  try {
    if (stat.size <= MAX_LOG_FILE_BYTES) return 0;
    return countNewlinesBeforeFd(fd, stat.size - MAX_LOG_FILE_BYTES) + 1;
  } finally {
    fs.closeSync(fd);
  }
}

function attachSourceObservation(events, filePath, sourceLineBase = 0) {
  const sourceFile = path.basename(filePath);
  for (const event of events) {
    event.sourceFile = sourceFile;
    event.sourceLine = sourceLineBase + (event.sourceLineIndex ?? 0);
  }
  return events;
}

/**
 * Single-pass streaming ADM parser. Reads an ADM file line-by-line and
 * extracts the same event groups returned by the original multiple-pass
 * parsers (sessions, health, damage, kills, territory events, deaths,
 * unconscious, respawns, position snapshots, emotes, and simple player
 * connection records).
 *
 * Returns an object with arrays for each event type. Designed to keep
 * memory use low by avoiding creating a full lines array for large files.
 */
async function parseADMFileStream(filePath, logDate, {
  fullHistory = false,
  rootDir = path.dirname(filePath),
  sessionState = new Map(),
  includeActiveSessions = true,
  platform = null,
} = {}) {
  const players = [];
  const onlineUpdates = []; // minimal lines for updateOnlineStateFromLines compatibility
  const healthUpdates = new Map();
  const damageEvents = [];
  const killEvents = [];
  const territoryEvents = [];
  const deathEvents = [];
  const unconsciousEvents = [];
  const respawnEvents = [];
  const positionSnapshots = [];
  const disconnectPositions = [];
  const emoteEvents = [];
  const sessionsCompleted = [];

  // Session tracking
  const connectRegex = /(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)"\s*\(id=([A-Za-z0-9_-]+={0,2})\)\s*is connect(?:ed|ing)/;
  const disconnectRegex = /(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)"\s*\(id=([A-Za-z0-9_-]+={0,2})(?:\s+pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>)?\)\s*has been disconnected/;
  const activeSessions = sessionState;

  // Health regex (damage lines are parsed separately before this check).
  const healthRegex = /(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\)\[HP: ([\d.]+)\]/;

  // Kill regex (mirrors parseKillEvents)
  const killRegex = /(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(DEAD\) \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\)(?:\[HP: [\d.]+\])? killed by Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2})(?: pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>)?\) with (\S+)(?: from ([\d.]+) meters)?/;

  // Territory/emote/respawn/position regexes (subset used)
  const respawnRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(DEAD\) \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) is choosing to respawn$/;
  const playerListHeader = /^(\d{2}:\d{2}:\d{2}) \| ##### PlayerList log: (\d+) players$/;
  const playerLineRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\)$/;
  const emoteRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) performed (\S+)(?: with (.+))?$/;

  // For position snapshot blocks
  let inSnapshot = false;
  let snapshotTimestamp = null;
  let previousLineTimestamp = null;
  const recentDamageByParticipants = new Map();

  const sourceFile = path.basename(filePath);
  for await (const streamedLine of streamLogLines(filePath, { fullHistory, rootDir })) {
    const { line, sourceLineIndex } = streamedLine;
    const lineTimeMatch = line.match(/^(\d{2}:\d{2}:\d{2}) \|/);
    if (lineTimeMatch) {
      const effectiveTimestamp = parseADMTimestamp(lineTimeMatch[1], logDate, previousLineTimestamp);
      logDate = effectiveTimestamp.slice(0, 10);
      previousLineTimestamp = effectiveTimestamp;
    }
    // Sessions (connect/disconnect)
    let m = line.match(connectRegex);
    if (m) {
      const [, timestamp, playerName, playerId] = m;
      const normalized = normalizeDayzPlayerId(playerId, platform);
      if (normalized) {
        const loginAt = parseADMTimestamp(timestamp, logDate);
        activeSessions.set(normalized, {
          playerGamertag: playerName,
          platformUserId: normalized,
          loginAt,
          logoutAt: null
        });

        players.push({ playerName, platformUserId: normalized, dpnid: null, deviceId: null });
        onlineUpdates.push({ type: 'connect', playerGamertag: playerName, platformUserId: normalized, loginAt });
      }
      continue;
    }

    m = line.match(disconnectRegex);
    if (m) {
      const [, timestamp, playerName, playerId, posX, posY, posZ] = m;
      const normalized = normalizeDayzPlayerId(playerId, platform);
      if (!normalized) continue;
      const logoutAt = parseADMTimestamp(timestamp, logDate);
      if (posX !== undefined) {
        disconnectPositions.push({
          timestamp: logoutAt,
          playerGamertag: playerName,
          platformUserId: normalized,
          posX: Number(posX),
          posY: Number(posY),
          posZ: Number(posZ),
          sourceFile,
        });
      }
      const session = activeSessions.get(normalized);
      if (session) {
        session.logoutAt = parseADMTimestamp(timestamp, logDate, session.loginAt);
        sessionsCompleted.push(session);
        activeSessions.delete(normalized);
      } else {
        sessionsCompleted.push({ playerGamertag: playerName, platformUserId: normalized, loginAt: null, logoutAt: parseADMTimestamp(timestamp, logDate) });
      }
      onlineUpdates.push({ type: 'disconnect', platformUserId: normalized });
      continue;
    }

    // Position snapshot blocks
    const headerMatch = line.match(playerListHeader);
    if (headerMatch) {
      inSnapshot = true;
      snapshotTimestamp = parseADMTimestamp(headerMatch[1], logDate);
      continue;
    }
    if (inSnapshot && /^\d{2}:\d{2}:\d{2} \| #####$/.test(line)) {
      inSnapshot = false;
      snapshotTimestamp = null;
      continue;
    }
    if (inSnapshot) {
      const pl = line.match(playerLineRegex);
      if (pl) {
        const [, , playerName, playerId, posX, posY, posZ] = pl;
        positionSnapshots.push({ timestamp: snapshotTimestamp, playerGamertag: playerName, platformUserId: playerId, posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ) });
        continue;
      }
    }

    // Parse damage before the generic health prefix consumes the same line.
    const damageEvent = parseDamageLine(line, logDate);
    if (damageEvent) {
      damageEvent.sourceFile = sourceFile;
      damageEvent.sourceLine = sourceLineIndex;
      damageEvents.push(damageEvent);
      if (damageEvent.attackerPlatformUserId) {
        recentDamageByParticipants.set(
          `${damageEvent.victimPlatformUserId}:${damageEvent.attackerPlatformUserId}`,
          damageEvent
        );
      }
    }

    // Health update
    m = line.match(healthRegex);
    if (m) {
      const [, timestamp, playerName, playerId, posX, posY, posZ, hpBefore] = m;
      const parsedTimestamp = parseADMTimestamp(timestamp, logDate);
      const existing = healthUpdates.get(playerId);
      if (!existing || new Date(parsedTimestamp) > new Date(existing.timestamp)) {
        healthUpdates.set(playerId, {
          playerGamertag: playerName,
          platformUserId: playerId,
          currentHP: parseFloat(hpBefore),
          maxHP: 100.0,
          status: parseFloat(hpBefore) > 0 ? 'alive' : 'dead',
          lastPosition: `${posX},${posY},${posZ}`,
          posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ),
          timestamp: parsedTimestamp
        });
      }
      continue;
    }

    // Kill events
    m = line.match(killRegex);
    if (m) {
      const [ , time, victimName, victimId, victimX, victimY, victimZ, killerName, killerId, killerX, killerY, killerZ, weapon, distance ] = m;
      let computedDistance = null;
      if (distance) computedDistance = parseFloat(distance);
      else if (killerX && killerY && killerZ && victimX && victimY && victimZ) {
        try { const kx = parseFloat(killerX), ky = parseFloat(killerY), kz = parseFloat(killerZ); const vx = parseFloat(victimX), vy = parseFloat(victimY), vz = parseFloat(victimZ); computedDistance = Math.sqrt((kx-vx)**2 + (ky-vy)**2 + (kz-vz)**2); } catch (e) { computedDistance = null; }
      }
      const killTimestamp = parseADMTimestamp(time, logDate);
      const precedingDamage = recentDamageByParticipants.get(`${victimId}:${killerId}`);
      const matchingDamage = precedingDamage &&
        precedingDamage.attackerType === 'player' &&
        precedingDamage.attackerPlatformUserId === killerId &&
        precedingDamage.timestamp === killTimestamp
        ? precedingDamage
        : null;
      killEvents.push({
        timestamp: killTimestamp,
        victimGamertag: victimName,
        victimPlatformUserId: victimId,
        victimPosition: `${victimX},${victimY},${victimZ}`,
        killerGamertag: killerName,
        killerPlatformUserId: killerId,
        killerPosition: killerX ? `${killerX},${killerY},${killerZ}` : null,
        weapon,
        weaponExtra: matchingDamage?.weapon || null,
        bodyPart: matchingDamage?.bodyPart || null,
        damage: matchingDamage?.damage ?? null,
        distance: computedDistance
      });
      continue;
    }

    const unconscious = parseUnconsciousEvents([line], logDate);
    if (unconscious.length > 0) {
      unconscious[0].sourceFile = sourceFile;
      unconscious[0].sourceLine = sourceLineIndex;
      unconsciousEvents.push(unconscious[0]);
      continue;
    }

    // Respawn
    m = line.match(respawnRegex);
    if (m) {
      const [, timestamp, playerName, playerId, posX, posY, posZ] = m;
      respawnEvents.push({ timestamp: parseADMTimestamp(timestamp, logDate), playerGamertag: playerName, platformUserId: playerId, posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ) });
      continue;
    }

    // Emote
    m = line.match(emoteRegex);
    if (m) {
      const [, timestamp, playerName, playerId, posX, posY, posZ, emoteType, itemName] = m;
      emoteEvents.push({ timestamp: parseADMTimestamp(timestamp, logDate), playerGamertag: playerName, platformUserId: playerId, emoteType, itemName: itemName || null, posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ), sourceFile, sourceLine: sourceLineIndex });
      continue;
    }

    // Deaths (multiple formats)
    // Reuse existing death regexes from parseDeathEvents (simple subset here)
    const diedRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(DEAD\) \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) died\. Stats> Water: ([\d.]+) Energy: ([\d.]+) Bleed sources: (\d+)$/;
    const drownedRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(DEAD\) \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) drowned\. Stats> Water: ([\d.]+) Energy: ([\d.]+) Bleed sources: (\d+)$/;
    const killedByRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(DEAD\) \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) killed by (\S+)$/;
    const bledOutRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(DEAD\) \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) bled out$/;
    const suicideRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(DEAD\) \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) committed suicide$/;

    m = line.match(diedRegex);
    if (m) { const [, timestamp, playerName, playerId, posX, posY, posZ, water, energy, bleedSources] = m; deathEvents.push({ timestamp: parseADMTimestamp(timestamp, logDate), playerGamertag: playerName, platformUserId: playerId, deathType: 'died', killedBy: null, posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ), water: parseFloat(water), energy: parseFloat(energy), bleedSources: parseInt(bleedSources) }); continue; }
    m = line.match(drownedRegex);
    if (m) { const [, timestamp, playerName, playerId, posX, posY, posZ, water, energy, bleedSources] = m; deathEvents.push({ timestamp: parseADMTimestamp(timestamp, logDate), playerGamertag: playerName, platformUserId: playerId, deathType: 'drowned', killedBy: null, posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ), water: parseFloat(water), energy: parseFloat(energy), bleedSources: parseInt(bleedSources) }); continue; }
    m = line.match(killedByRegex);
    if (m) { const [, timestamp, playerName, playerId, posX, posY, posZ, killedBy] = m; deathEvents.push({ timestamp: parseADMTimestamp(timestamp, logDate), playerGamertag: playerName, platformUserId: playerId, deathType: 'killed_by_npc', killedBy, posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ), water: null, energy: null, bleedSources: null }); continue; }
    m = line.match(bledOutRegex);
    if (m) { const [, timestamp, playerName, playerId, posX, posY, posZ] = m; deathEvents.push({ timestamp: parseADMTimestamp(timestamp, logDate), playerGamertag: playerName, platformUserId: playerId, deathType: 'bled_out', killedBy: null, posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ), water: null, energy: null, bleedSources: null }); continue; }
    m = line.match(suicideRegex);
    if (m) { const [, timestamp, playerName, playerId, posX, posY, posZ] = m; deathEvents.push({ timestamp: parseADMTimestamp(timestamp, logDate), playerGamertag: playerName, platformUserId: playerId, deathType: 'suicide', killedBy: null, posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ), water: null, energy: null, bleedSources: null }); continue; }

    // Reuse the full territory parser so streamed scans retain action, class,
    // display name, tool, and position instead of storing generic "unknown" rows.
    const parsedTerritory = parseTerritoryEvents([line], logDate);
    if (parsedTerritory.length > 0) {
      parsedTerritory[0].sourceFile = sourceFile;
      parsedTerritory[0].sourceLine = sourceLineIndex;
      territoryEvents.push(parsedTerritory[0]);
      continue;
    }

  }

  // Normalize opaque IDs once across every emitted event family. Invalid or
  // sentinel identities are filtered before participant discovery/persistence.
  const normalizedEvents = normalizeParsedEventIdentities({
    healthUpdates: Array.from(healthUpdates.values()),
    damageEvents,
    killEvents,
    territoryEvents,
    deathEvents,
    unconsciousEvents,
    respawnEvents,
    positionSnapshots,
    emoteEvents,
  }, platform);

  // Include still-open sessions only after the final chronological ADM file.
  if (includeActiveSessions) {
    for (const [, session] of activeSessions) sessionsCompleted.push(session);
  }

  // Event lines can appear in an incremental window without a nearby connect
  // line. Discover every participant before persistence so identity lookup
  // cannot silently discard otherwise valid events.
  const playerIds = new Set(players.map(player => player.platformUserId));
  const recordParticipant = (playerName, platformUserId) => {
    const normalized = normalizeDayzPlayerId(platformUserId, platform);
    if (!normalized) return;
    if (playerIds.has(normalized)) return;
    players.push({ playerName, platformUserId: normalized, dpnid: null, deviceId: null });
    playerIds.add(normalized);
  };
  for (const session of sessionsCompleted) recordParticipant(session.playerGamertag, session.platformUserId);
  for (const event of normalizedEvents.healthUpdates) recordParticipant(event.playerGamertag, event.platformUserId);
  for (const event of normalizedEvents.damageEvents) {
    recordParticipant(event.victimGamertag, event.victimPlatformUserId);
    recordParticipant(event.attackerGamertag, event.attackerPlatformUserId);
  }
  for (const event of normalizedEvents.killEvents) {
    recordParticipant(event.victimGamertag, event.victimPlatformUserId);
    recordParticipant(event.killerGamertag, event.killerPlatformUserId);
  }
  for (const events of [
    normalizedEvents.territoryEvents,
    normalizedEvents.deathEvents,
    normalizedEvents.unconsciousEvents,
    normalizedEvents.respawnEvents,
    normalizedEvents.positionSnapshots,
    disconnectPositions,
    normalizedEvents.emoteEvents,
  ]) {
    for (const event of events) recordParticipant(event.playerGamertag, event.platformUserId);
  }

  return {
    players,
    onlineUpdates,
    disconnectPositions,
    sourceObservedAt: previousLineTimestamp,
    ...normalizedEvents,
    sessions: sessionsCompleted
  };
}

/**
 * Normalise a log content argument: parse functions accept either the raw
 * string (for backwards-compatible single-function calls from HTTP routes) or
 * a pre-split lines array (for the batch-sync loops that call many parse
 * functions on the same file).  Splitting once in the loop and passing the
 * array avoids allocating a new ~500k-element array for every parse function.
 *
 * @param {string|string[]} content - Raw log string or pre-split lines array.
 * @returns {string[]} Lines array.
 */
function toLines(content) {
  return Array.isArray(content) ? content : content.split('\n');
}

// Parse ADM log for player IDs
function parseADMLog(content, platform = null) {
  const players = [];
  const lines = toLines(content);

  // DayZ versions use both "is connected" and "is connecting".
  const connectionRegex = /Player "([^"]+)"\s*\(id=([A-Za-z0-9_-]+={0,2})\)\s*is connect(?:ed|ing)/;

  for (const line of lines) {
    const match = line.match(connectionRegex);
    const normalizedPlayerId = normalizeDayzPlayerId(match?.[2], platform);
    if (match && normalizedPlayerId) {
      players.push({
        playerName: match[1],
        platformUserId: normalizedPlayerId,
        dpnid: null,
        deviceId: null
      });
    }
  }

  return players;
}

// Parse RPT log for player IDs, dpnids, and device IDs
function parseRPTLog(content, platform = null) {
  const lines = toLines(content);

  // Match: Player (id=) has connected.
  const connectedRegex = /Player (\S+) \(id=([A-Za-z0-9_-]+={0,2})\) has connected\./;

  // Match: [Login]: Adding player  to login queue
  const loginRegex = /\[Login\]: Adding (?:prioritized )?player (\S+) \((\d+)\) to login queue/;

  // Match: [MAM] :: [NetworkServer::CheckMAMData] :: device:  | account:
  const deviceRegex = /\[MAM\] :: \[NetworkServer::CheckMAMData\] :: device: ([A-Za-z0-9+/=_-]+) \| account: ([A-Za-z0-9_-]+={0,2})/;

  const playerMap = new Map();
  const deviceMap = new Map(); // platformUserId -> deviceId
  const dpnidMap = new Map(); // playerName -> dpnid

  // First pass: collect device IDs and dpnids
  for (const line of lines) {
    const deviceMatch = line.match(deviceRegex);
    if (deviceMatch) {
      const platformUserId = normalizeDayzPlayerId(deviceMatch[2], platform);
      if (platformUserId) deviceMap.set(platformUserId, deviceMatch[1]);
    }

    const loginMatch = line.match(loginRegex);
    if (loginMatch) {
      dpnidMap.set(loginMatch[1], loginMatch[2]);
    }
  }

  // Second pass: build player records
  for (const line of lines) {
    const connMatch = line.match(connectedRegex);
    if (connMatch) {
      const playerName = connMatch[1];
      const platformUserId = normalizeDayzPlayerId(connMatch[2], platform);

      if (platformUserId && !playerMap.has(platformUserId)) {
        playerMap.set(platformUserId, {
          playerName,
          platformUserId,
          dpnid: dpnidMap.get(playerName) || null,
          deviceId: deviceMap.get(platformUserId) || null
        });
      }
    }
  }

  return Array.from(playerMap.values());
}

/**
 * Extract the date from ADM log header
 * Format: "AdminLog started on 2026-02-19 at 17:23:31"
 */
function extractLogDate(admLog, fallbackDate = new Date().toISOString().slice(0, 10)) {
  const lines = toLines(admLog);
  const headerRegex = /AdminLog started on (\d{4})-(\d{2})-(\d{2}) at (\d{2}):(\d{2}):(\d{2})/;

  for (const line of lines) {
    const match = line.match(headerRegex);
    if (!match) continue;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
    const [year, month, day, hour, minute, second] = [
      yearText, monthText, dayText, hourText, minuteText, secondText,
    ].map(Number);
    const timestamp = new Date(0);
    timestamp.setUTCFullYear(year, month - 1, day);
    timestamp.setUTCHours(hour, minute, second, 0);
    if (
      timestamp.getUTCFullYear() === year
      && timestamp.getUTCMonth() === month - 1
      && timestamp.getUTCDate() === day
      && timestamp.getUTCHours() === hour
      && timestamp.getUTCMinutes() === minute
      && timestamp.getUTCSeconds() === second
    ) {
      return `${yearText}-${monthText}-${dayText}`;
    }
  }

  return fallbackDate;
}

function extractLogDateFromFilePath(filePath, rootDir = path.dirname(filePath)) {
  const startTimeMs = logStartTimeMs(path.basename(filePath));
  if (startTimeMs !== null) {
    return new Date(startTimeMs).toISOString().slice(0, 10);
  }

  const { fd, stat } = openLogFile(filePath, rootDir);
  try {
    const fallbackDate = new Date(stat.mtimeMs).toISOString().slice(0, 10);
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return extractLogDate(buffer.subarray(0, bytesRead).toString('utf8'), fallbackDate);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parse ADM timestamp and handle midnight rollover
 * @param {string} timeStr - Time in HH:MM:SS format
 * @param {string} logDate - Base date in YYYY-MM-DD format
 * @param {string} previousTimestamp - Previous timestamp to compare for rollover detection
 * @returns {string} ISO 8601 timestamp
 */
function parseADMTimestamp(timeStr, logDate, previousTimestamp = null) {
  if (!logDate) {
    logDate = new Date().toISOString().split('T')[0];
  }

  let timestamp = `${logDate}T${timeStr}Z`;

  // Detect midnight rollover: if this timestamp is earlier than previous, add 1 day
  if (previousTimestamp) {
    const currentTime = new Date(timestamp);
    const prevTime = new Date(previousTimestamp);

    if (currentTime < prevTime) {
      // Current time is earlier - must be next day
      const nextDay = new Date(logDate);
      nextDay.setDate(nextDay.getDate() + 1);
      const nextDateStr = nextDay.toISOString().split('T')[0];
      timestamp = `${nextDateStr}T${timeStr}Z`;
    }
  }

  return timestamp;
}

/**
 * Applies parser-resolved online-state updates in ADM line order.
 *
 * The streaming parser resolves timestamps using its file-wide chronology
 * cursor. Reusing those timestamps avoids dating post-midnight connections
 * against the file's original start date.
 *
 * @param {object[]} updates - Parser-resolved connect/disconnect updates
 * @param {Map} onlineMap - Map<platformUserId, session> mutated in place
 */
function updateOnlineState(updates, onlineMap) {
  for (const update of updates) {
    if (update.type === 'connect') {
      onlineMap.set(update.platformUserId, {
        playerGamertag: update.playerGamertag,
        platformUserId: update.platformUserId,
        loginAt: update.loginAt,
      });
    } else if (update.type === 'disconnect') {
      onlineMap.delete(update.platformUserId);
    }
  }
}

/**
 * Parse player sessions from ADM log
 * Matches login/logout events and calculates duration
 */
function parsePlayerSessions(admLog, logDate, platform = null) {
  const lines = toLines(admLog);

  const connectRegex = /(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)"\s*\(id=([A-Za-z0-9_-]+={0,2})\)\s*is connect(?:ed|ing)/;
  const disconnectRegex = /(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)"\s*\(id=([A-Za-z0-9_-]+={0,2})(?:\s+pos=<[^>]+>)?\)\s*has been disconnected/;

  const activeSessions = new Map();
  const completedSessions = [];

  for (const line of lines) {
    let match = line.match(connectRegex);
    if (match) {
      const [, timestamp, playerName, playerId] = match;
      const normalizedPlayerId = normalizeDayzPlayerId(playerId, platform);
      if (!normalizedPlayerId) continue;
      activeSessions.set(normalizedPlayerId, {
        playerGamertag: playerName,
        platformUserId: normalizedPlayerId,
        loginAt: parseADMTimestamp(timestamp, logDate),
        logoutAt: null
      });
      continue;
    }

    match = line.match(disconnectRegex);
    if (match) {
      const [, timestamp, playerName, playerId] = match;
      const normalizedPlayerId = normalizeDayzPlayerId(playerId, platform);
      if (!normalizedPlayerId) continue;
      const session = activeSessions.get(normalizedPlayerId);
      if (session) {
        session.logoutAt = parseADMTimestamp(timestamp, logDate, session.loginAt);
        completedSessions.push(session);
        activeSessions.delete(normalizedPlayerId);
      } else {
        completedSessions.push({
          playerGamertag: playerName,
          platformUserId: normalizedPlayerId,
          loginAt: null,
          logoutAt: parseADMTimestamp(timestamp, logDate)
        });
      }
    }
  }

  for (const [, session] of activeSessions) {
    completedSessions.push(session);
  }

  return completedSessions;
}

/**
 * Bulk-loads player identities for a set of platform user IDs.
 * Returns a Map<platformUserId, identityId> built from a single query,
 * avoiding the N+1 pattern of one SELECT per event.
 */
async function buildIdentityMap(db, platform, platformUserIds) {
  const unique = [...new Set(platformUserIds.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const placeholders = unique.map(() => '?').join(', ');
  const rows = await db.all(
    `SELECT platform_user_id, id FROM player_identities WHERE platform = ? AND platform_user_id IN (${placeholders})`,
    [platform, ...unique]
  );
  const map = new Map();
  for (const row of rows) {
    map.set(row.platform_user_id, row.id);
  }
  return map;
}

function resolvedIdentityId(identityMap, platformUserId, context) {
  if (!platformUserId) return null;
  const identityId = identityMap.get(platformUserId);
  if (!identityId) throw new Error(`${context} identity not found for parsed event`);
  return identityId;
}

/**
 * Builds a stable synthetic identity id for online-cache rows when the
 * canonical identity record does not exist yet.
 *
 * We keep these ids negative so they never collide with real identity ids
 * (which are positive SERIAL/IDENTITY values).
 */
function syntheticIdentityIdFromPlatformUserId(platformUserId) {
  const str = String(platformUserId || '');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0; // keep 32-bit signed
  }
  if (hash === 0) hash = 1;
  return -Math.abs(hash);
}

async function getExactServerForPersistence(db, platformServerId, internalServerId) {
  const exactServerId = Number(internalServerId);
  if (!Number.isSafeInteger(exactServerId) || exactServerId <= 0) {
    throw new Error(`Exact internal server ID required for server ${platformServerId}`);
  }

  const server = await db.get('SELECT id FROM servers WHERE id = ?', [exactServerId]);
  if (!server) {
    throw new Error(`Exact server ${exactServerId} not found in database`);
  }
  return server;
}

/**
 * Updates the server_online_cache table with the players currently online.
 * Called after each log scan with the active sessions from the most recent ADM log.
 * Wipes all existing rows for the server first so the cache always reflects the
 * latest scan — no stale rows from previous scans accumulate here.
 */
async function allocateOnlineCacheScanGeneration(db) {
  const row = await db.get(
    "SELECT nextval('server_online_cache_scan_generation_seq')::text AS scan_generation"
  );
  if (!/^\d+$/.test(String(row?.scan_generation || '')) || BigInt(row.scan_generation) <= 0n) {
    throw new Error('Online cache scan generation is unavailable');
  }
  return String(row.scan_generation);
}

async function updateOnlineCache(db, platformServerId, activeSessions, platform, internalServerId,
  sourceObservedAt, scanGeneration) {
  try {
    if (!sourceObservedAt || !Number.isFinite(new Date(sourceObservedAt).getTime())) {
      throw new Error('Online cache source observation time is unavailable');
    }
    if (!/^\d+$/.test(String(scanGeneration || '')) || BigInt(scanGeneration) <= 0n) {
      throw new Error('Online cache scan generation is unavailable');
    }

    const published = await db.transaction(async transactionDb => {
      const server = await getExactServerForPersistence(
        transactionDb, platformServerId, internalServerId
      );
      const lockedServer = await transactionDb.get(
        'SELECT id FROM servers WHERE id = ? FOR UPDATE',
        [server.id]
      );
      if (!lockedServer) throw new Error(`Exact server ${server.id} is no longer available`);
      const dbServerId = lockedServer.id;

      const validity = await transactionDb.get(
        `SELECT ?::timestamptz >= clock_timestamp() - INTERVAL '120 minutes' AS fresh,
                ?::timestamptz <= clock_timestamp() + INTERVAL '5 minutes' AS plausible`,
        [sourceObservedAt, sourceObservedAt]
      );
      if (!validity?.plausible) {
        throw new Error('Online cache source observation time is implausible');
      }
      if (!validity.fresh) return false;

      await transactionDb.run(
        `INSERT INTO server_online_cache_snapshots (server_id, source_observed_at)
         VALUES (?, ?) ON CONFLICT (server_id) DO NOTHING`,
        [dbServerId, sourceObservedAt]
      );
      const marker = await transactionDb.get(
        `SELECT source_observed_at, scan_generation FROM server_online_cache_snapshots
         WHERE server_id = ? FOR UPDATE`,
        [dbServerId]
      );
      if (BigInt(marker.scan_generation || 0) >= BigInt(scanGeneration)) return false;

      const identityMap = await buildIdentityMap(
        transactionDb, platform, activeSessions.map(session => session.platformUserId)
      );
      await transactionDb.run('DELETE FROM server_online_cache WHERE server_id = ?', [dbServerId]);

      for (const session of activeSessions) {
        const identityId = resolvedIdentityId(
          identityMap, session.platformUserId, 'Online cache participant'
        );
        let gamertag = session.playerGamertag || session.platformUserId;
        const gtagRow = await transactionDb.get(
          `SELECT gamertag FROM player_gamertags
           WHERE identity_id = ? AND server_id = ? AND is_current_gamertag = 1 LIMIT 1`,
          [identityId, dbServerId]
        );
        gamertag = gtagRow?.gamertag || gamertag;

        await transactionDb.run(
          `INSERT INTO server_online_cache (server_id, identity_id, gamertag, login_at, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT (server_id, identity_id) DO UPDATE SET
             gamertag = EXCLUDED.gamertag,
             login_at = EXCLUDED.login_at,
             updated_at = CURRENT_TIMESTAMP`,
          [dbServerId, identityId, gamertag, session.loginAt]
        );
      }
      await transactionDb.run(
        `UPDATE server_online_cache_snapshots
         SET source_observed_at = ?, scan_generation = ?, published_at = clock_timestamp()
         WHERE server_id = ? AND scan_generation < ?`,
        [sourceObservedAt, scanGeneration, dbServerId, scanGeneration]
      );
      return true;
    });

    if (!published) {
      console.log(`  ⏭️ Online cache not updated for server ${platformServerId}: source evidence is stale or superseded`);
      return false;
    }
    console.log(`  📡 Online cache updated for server ${platformServerId}: ${activeSessions.length} player(s) online`);
    return true;
  } catch (err) {
    console.error(`  ⚠️  updateOnlineCache error:`, err.message);
    throw err;
  }
}

/**
 * Save player sessions to database
 */
async function refreshPlayerServerActivityForIdentity(db, dbServerId, identityId) {
  await db.run(
    `UPDATE player_server_activity psa
     SET total_sessions = (
           SELECT COUNT(*) FROM player_sessions ps
           WHERE ps.identity_id = psa.identity_id AND ps.server_id = psa.server_id
         ),
         first_seen = (
           SELECT MIN(login_at) FROM player_sessions ps
           WHERE ps.identity_id = psa.identity_id AND ps.server_id = psa.server_id
         ),
         last_seen = (
           SELECT MAX(COALESCE(logout_at, login_at)) FROM player_sessions ps
           WHERE ps.identity_id = psa.identity_id AND ps.server_id = psa.server_id
         )
     WHERE psa.server_id = ? AND psa.identity_id = ?`,
    [dbServerId, identityId]
  );
}

async function saveSessions(db, platformServerId, sessions, platform, internalServerId) {
  if (sessions.length === 0) {
    return 0;
  }

  const server = await getExactServerForPersistence(db, platformServerId, internalServerId);

  const dbServerId = server.id;
  let savedCount = 0;

  const identityMap = await buildIdentityMap(db, platform, sessions.map(s => s.platformUserId));

  for (const session of sessions) {
    try {
      const identityId = resolvedIdentityId(identityMap, session.platformUserId, 'Session');

      let duration = null;
      const wasNewSession = await db.transaction(async () => {
        let inserted = false;
        let sessionCompletedNow = false;
        try {
          if (!session.loginAt && session.logoutAt) {
            const openSession = await db.get(
              `SELECT id, login_at
               FROM player_sessions
               WHERE identity_id = ?
                 AND server_id = ?
                 AND logout_at IS NULL
               ORDER BY login_at DESC
               FOR UPDATE
               LIMIT 1`,
              [identityId, dbServerId]
            );
            if (!openSession) return false;
            const loginTime = new Date(openSession.login_at).getTime();
            const logoutTime = new Date(session.logoutAt).getTime();
            duration = Math.floor((logoutTime - loginTime) / 1000);
            const sessionResult = await db.get(
              `UPDATE player_sessions
               SET logout_at = ?, duration = ?
               WHERE id = ? AND logout_at IS NULL
               RETURNING id`,
              [session.logoutAt, duration, openSession.id]
            );
            sessionCompletedNow = Boolean(sessionResult && duration > 0);
          } else {
            if (session.loginAt && session.logoutAt) {
              const loginTime = new Date(session.loginAt).getTime();
              const logoutTime = new Date(session.logoutAt).getTime();
              duration = Math.floor((logoutTime - loginTime) / 1000);
            }
            const sessionResult = await db.get(
              `INSERT INTO player_sessions (identity_id, server_id, login_at, logout_at, duration, log_source)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(identity_id, server_id, login_at) DO UPDATE SET
                 logout_at = EXCLUDED.logout_at,
                 duration = EXCLUDED.duration
               WHERE player_sessions.logout_at IS NULL AND EXCLUDED.logout_at IS NOT NULL
               RETURNING id, (xmax = 0) AS inserted`,
              [identityId, dbServerId, session.loginAt, session.logoutAt, duration, 'adm_log']
            );
            inserted = sessionResult?.inserted === true;
            sessionCompletedNow = Boolean(sessionResult && duration !== null && duration > 0);
          }
        } catch (runErr) {
          if (runErr.code === '23505' || (runErr.message && runErr.message.includes('UNIQUE'))) {
            console.log(`   ℹ️  Skipping duplicate session for ${session.playerGamertag}`);
            return false;
          }
          throw runErr;
        }

        // Award once in the same transaction that first inserts or closes the session.
        if (sessionCompletedNow) {
          const config = await economyHelper.getEconomyConfigForIdentity(db, identityId, dbServerId);
          if (config && config.enabled && config.playtime_rewards_enabled && config.playtime_reward_per_hour > 0) {
            const durationHours = duration / 3600;
            const reward = centsToAmount(playtimeRewardCents(config.playtime_reward_per_hour, duration));
            if (reward > 0) {
              const result = await economyHelper.awardMoneyInTransaction(
                db,
                identityId,
                reward,
                'playtime',
                `Playtime reward (${durationHours.toFixed(2)} hours)`,
                dbServerId,
                { sessionDuration: durationHours, hourlyRate: config.playtime_reward_per_hour }
              );
              if (result) {
                console.log(`💰 Awarded ${config.currency_symbol}${reward.toFixed(2)} to identity ${identityId} for ${durationHours.toFixed(2)}h playtime`);
              }
            }
          }
        }
        await refreshPlayerServerActivityForIdentity(db, dbServerId, identityId);
        return inserted;
      });
      if (wasNewSession) savedCount++;

    } catch (err) {
      console.error(`❌ Error saving session for ${session.playerGamertag}:`, err.message);
      throw err;
    }
  }

  console.log(`✅ Saved ${savedCount} player sessions to database`);
  return savedCount;
}

// Save players to database (NEW SCHEMA V2)
async function savePlayersToDatabase(db, userId, serverId, players, platform, internalServerId) {
  if (players.length === 0) return;

  const exactServerId = Number(internalServerId);
  if (!Number.isSafeInteger(exactServerId) || exactServerId <= 0) {
    throw new Error(`Exact internal server ID required for server ${serverId}`);
  }

  const server = await db.get(
    'SELECT id FROM servers WHERE id = ?',
    [exactServerId]
  );
  if (!server) {
    console.error('❌ Exact server not found in database:', exactServerId);
    throw new Error(`Exact server ${exactServerId} not found in database`);
  }

  const dbServerId = server.id;
  console.log(`✅ Found exact database server ID: ${dbServerId}`);

  let identitiesCreated = 0;

  for (const player of players) {
    const platformUserId = player.platformUserId || player.bohemiaId || player.dpnid;

    if (!platformUserId) {
      console.warn('⚠️ Skipping player without platform ID:', player.playerName);
      continue;
    }

    try {
      // Step 2: Check if player identity already exists
        const existingIdentity = await db.get(
        'SELECT id, player_id FROM player_identities WHERE platform = ? AND platform_user_id = ?',
        [platform, platformUserId]
      );

      let identityId;

      if (existingIdentity) {
        identityId = existingIdentity.id;

        // Merge device_id and dpnid when available but avoid overwriting existing values
        try {
          await db.run(
            `UPDATE player_identities SET
               device_id = COALESCE(device_id, ?),
               dpnid = COALESCE(dpnid, ?)
             WHERE id = ?`,
            [player.deviceId || null, player.dpnid || null, identityId]
          );
        } catch (mergeErr) {
          console.warn('⚠️ Failed to merge device_id/dpnid into existing identity:', mergeErr.message);
          throw mergeErr;
        }
      } else {
        // Step 3a: Create player record first
        const playerResult = await db.run(
          'INSERT INTO players (primary_identity_id) VALUES (NULL) RETURNING id',
          []
        );
        const playerId = playerResult.lastID;
        console.log(`📝 Created player record: ${playerId}`);

        // Step 3b: Create player identity with the playerId
        const identityResult = await db.run(
          `INSERT INTO player_identities (player_id, platform, platform_user_id, device_id, dpnid)
           VALUES (?, ?, ?, ?, ?) RETURNING id`,
          [playerId, platform, platformUserId, player.deviceId || null, player.dpnid || null]
        );
        identityId = identityResult.lastID;
        console.log(`📝 Created identity: ${identityId} for player ${playerId}`);

        // Step 3c: Update player's primaryIdentityId
        await db.run(
          'UPDATE players SET primary_identity_id = ? WHERE id = ?',
          [identityId, playerId]
        );
      }

      // Step 4: Create or update gamertag
      const existingGamertag = await db.get(
        'SELECT id FROM player_gamertags WHERE identity_id = ? AND server_id = ?',
        [identityId, dbServerId]
      );

      if (existingGamertag) {
        await db.run(
          `UPDATE player_gamertags
           SET gamertag = ?, last_seen = CURRENT_TIMESTAMP, is_current_gamertag = 1
           WHERE identity_id = ? AND server_id = ?`,
          [player.playerName, identityId, dbServerId]
        );
      } else {
        await db.run(
          `INSERT INTO player_gamertags (identity_id, server_id, gamertag, is_current_gamertag, last_seen)
           VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)`,
          [identityId, dbServerId, player.playerName]
        );
      }

      // Step 5: Ensure this identity is associated with the exact server.
      // Session-derived counters are rebuilt after parsing; identity discovery
      // must never increment them because retained logs can be replayed.
      await db.run(
        `INSERT INTO player_server_activity
           (identity_id, server_id, first_seen, last_seen, total_sessions)
         VALUES (?, ?, NULL, NULL, 0)
         ON CONFLICT (identity_id, server_id) DO NOTHING`,
        [identityId, dbServerId]
      );

      console.log(`✅ Player: ${player.playerName} (${platform}: ${platformUserId}) on server ${dbServerId}`);
      identitiesCreated++;
    } catch (err) {
      console.error(`❌ Error processing player ${player.playerName}:`, err);
      throw err;
    }
  }

  console.log(`✅ Saved ${identitiesCreated} player identities`);
}

async function refreshPlayerServerActivity(db, platformServerId, internalServerId) {
  const server = await getExactServerForPersistence(db, platformServerId, internalServerId);

  await db.run(
    `UPDATE player_server_activity psa
     SET total_sessions = (
           SELECT COUNT(*)
           FROM player_sessions ps
           WHERE ps.identity_id = psa.identity_id AND ps.server_id = psa.server_id
         ),
         first_seen = (
           SELECT MIN(login_at)
           FROM player_sessions ps
           WHERE ps.identity_id = psa.identity_id AND ps.server_id = psa.server_id
         ),
         last_seen = (
           SELECT MAX(COALESCE(logout_at, login_at))
           FROM player_sessions ps
           WHERE ps.identity_id = psa.identity_id AND ps.server_id = psa.server_id
         )
     WHERE psa.server_id = ?`,
    [server.id]
  );
}


/**
 * Parse player health updates from ADM log
 * Extracts HP and position from damage events
 */
function parseHealthUpdates(admLog, logDate) {
  const healthUpdates = new Map();
  const lines = toLines(admLog);

  // Format: Player "X" (id=... pos=<X,Y,Z>)[HP: 93.825] hit by ...
  const healthRegex = /(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\)\[HP: ([\d.]+)\]/;

  for (const line of lines) {
    const match = line.match(healthRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ, hpBefore] = match;
      const parsedTimestamp = parseADMTimestamp(timestamp, logDate);
      const existingUpdate = healthUpdates.get(playerId);

      if (!existingUpdate || new Date(parsedTimestamp) > new Date(existingUpdate.timestamp)) {
        const hp = parseFloat(hpBefore);
        healthUpdates.set(playerId, {
          playerGamertag: playerName,
          platformUserId: playerId,
          currentHP: hp,
          maxHP: 100.0,
          status: hp > 0 ? 'alive' : 'dead',
          lastPosition: `${posX},${posY},${posZ}`,
          posX: parseFloat(posX),
          posY: parseFloat(posY),
          posZ: parseFloat(posZ),
          timestamp: parsedTimestamp
        });
      }
    }
  }

  return Array.from(healthUpdates.values());
}

/**
 * Save player health updates to database
 * Uses UPSERT to update existing records or create new ones
 */
async function saveHealthUpdates(db, platformServerId, healthUpdates, platform, internalServerId) {
  if (healthUpdates.length === 0) {
    return 0;
  }

  const server = await getExactServerForPersistence(db, platformServerId, internalServerId);

  const dbServerId = server.id;
  let savedCount = 0;

  const identityMap = await buildIdentityMap(db, platform, healthUpdates.map(h => h.platformUserId));

  for (const health of healthUpdates) {
    try {
      const identityId = resolvedIdentityId(identityMap, health.platformUserId, 'Health update');

      await db.run(
        `INSERT INTO player_health_status (
          identity_id, server_id, current_hp, max_hp, status,
          last_position, pos_x, pos_y, pos_z, last_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(identity_id, server_id) DO UPDATE SET
          current_hp = excluded.current_hp,
          max_hp = excluded.max_hp,
          status = excluded.status,
          last_position = excluded.last_position,
          pos_x = excluded.pos_x,
          pos_y = excluded.pos_y,
          pos_z = excluded.pos_z,
          last_updated = excluded.last_updated
        WHERE excluded.last_updated > player_health_status.last_updated`,
        [
          identityId,
          dbServerId,
          health.currentHP,
          health.maxHP,
          health.status,
          health.lastPosition,
          health.posX,
          health.posY,
          health.posZ,
          health.timestamp
        ]
      );
      savedCount++;

    } catch (err) {
      console.error(`❌ Error saving health for ${health.playerGamertag}:`, err.message);
      throw err;
    }
  }

  console.log(`✅ Saved ${savedCount} health updates to database`);
  return savedCount;
}

/**
 * Parse damage events from ADM log
 * Format: Player "X" (id=... pos=<X,Y,Z>)[HP: 93.825] hit by Infected into Torso(1) for 6.175 damage (MeleeInfected)
 */
function parseDamageLine(line, logDate) {
  const prefix = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" (?:\(DEAD\) )?\(id=([A-Za-z0-9_-]+={0,2}) pos=<([\d.-]+), ([\d.-]+), ([\d.-]+)>\)\[HP: ([\d.]+)\] /;
  const prefixMatch = line.match(prefix);
  if (!prefixMatch) return null;

  const [, timestamp, victimName, victimId, posX, posY, posZ, reportedHp] = prefixMatch;
  const remainder = line.slice(prefixMatch[0].length);
  const reportedHpNum = parseFloat(reportedHp);
  const base = {
    timestamp: parseADMTimestamp(timestamp, logDate),
    victimGamertag: victimName,
    victimPlatformUserId: victimId,
    victimPosition: `${posX},${posY},${posZ}`,
    victimPosX: parseFloat(posX),
    victimPosY: parseFloat(posY),
    victimPosZ: parseFloat(posZ),
    hpAfter: reportedHpNum,
  };

  const playerMatch = remainder.match(/^hit by Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2})(?: pos=<[^>]+>)?\) into (\w+)\((\d+)\) for ([\d.]+) damage \(([^)]+)\)(?: with (\S+))?(?: from ([\d.]+) meters)?/);
  if (playerMatch) {
    const [, attackerName, attackerPlatformUserId, bodyPart, bodyPartId, damage, ammo, weapon, distance] = playerMatch;
    const damageAmount = parseFloat(damage);
    return {
      ...base,
      attackerType: 'player',
      attackerGamertag: attackerName,
      attackerPlatformUserId,
      weapon: ammo,
      weaponName: weapon || null,
      bodyPart,
      bodyPartId: parseInt(bodyPartId),
      damage: damageAmount,
      distance: distance ? parseFloat(distance) : null,
      hpBefore: reportedHpNum + damageAmount,
    };
  }

  const standardMatch = remainder.match(/^hit by (Infected|Animal|Environment|Vehicle|Fall|Explosion|Unknown) into (\w+)\((\d+)\) for ([\d.]+) damage \(([^)]+)\)/);
  if (standardMatch) {
    const [, attacker, bodyPart, bodyPartId, damage, weapon] = standardMatch;
    const damageAmount = parseFloat(damage);
    const typeMap = { Infected: 'infected', Animal: 'animal', Environment: 'environment', Vehicle: 'vehicle', Fall: 'environment', Explosion: 'explosion', Unknown: 'unknown' };
    return {
      ...base,
      attackerType: typeMap[attacker],
      attackerGamertag: null,
      weapon,
      bodyPart,
      bodyPartId: parseInt(bodyPartId),
      damage: damageAmount,
      hpBefore: reportedHpNum + damageAmount,
    };
  }

  const explosionMatch = remainder.match(/^hit by explosion \(([^)]+)\)/i);
  if (explosionMatch) {
    return { ...base, attackerType: 'explosion', attackerGamertag: null, weapon: explosionMatch[1], bodyPart: null, bodyPartId: null, damage: null, hpBefore: null };
  }

  if (remainder === 'hit by FallDamageHealth') {
    return { ...base, attackerType: 'fall', attackerGamertag: null, weapon: 'FallDamageHealth', bodyPart: null, bodyPartId: null, damage: null, hpBefore: null };
  }

  return null;
}

function parseDamageEvents(admLog, logDate) {
  return toLines(admLog).map((line, sourceLineIndex) => {
    const event = parseDamageLine(line, logDate);
    if (event) event.sourceLineIndex = sourceLineIndex;
    return event;
  }).filter(Boolean);
}

/**
 * Save damage events to database
 */
async function saveDamageEvents(db, platformServerId, damageEvents, platform, internalServerId) {
  if (damageEvents.length === 0) {
    return 0;
  }

  const server = await getExactServerForPersistence(db, platformServerId, internalServerId);

  const dbServerId = server.id;
  let savedCount = 0;

  const allIds = damageEvents.flatMap(event => [
    event.victimPlatformUserId,
    event.attackerType === 'player' ? event.attackerPlatformUserId : null,
  ]);
  const identityMap = await buildIdentityMap(db, platform, allIds);

  for (const event of damageEvents) {
    try {
      const victimIdentityId = resolvedIdentityId(
        identityMap,
        event.victimPlatformUserId,
        'Damage victim'
      );

      const attackerIdentityId = event.attackerType === 'player'
        ? resolvedIdentityId(identityMap, event.attackerPlatformUserId, 'Damage attacker')
        : null;

      try {
        await db.run(
          `INSERT INTO damage_events (
            server_id, victim_identity_id, victim_gamertag,
            victim_position, victim_pos_x, victim_pos_y, victim_pos_z,
            attacker_identity_id, attacker_gamertag, attacker_type,
            weapon, body_part, body_part_id,
            damage, hp_before, hp_after, timestamp, log_source, source_file, source_line
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            dbServerId,
            victimIdentityId,
            event.victimGamertag,
            event.victimPosition,
            event.victimPosX,
            event.victimPosY,
            event.victimPosZ,
            attackerIdentityId,
            event.attackerGamertag,
            event.attackerType,
            event.weapon,
            event.bodyPart,
            event.bodyPartId,
            event.damage,
            event.hpBefore,
            event.hpAfter,
            event.timestamp,
            'adm_log',
            event.sourceFile || null,
            event.sourceLine ?? null
          ]
        );
        savedCount++;
      } catch (runErr) {
        if ((runErr.message && runErr.message.includes('UNIQUE constraint failed')) || runErr.code === '23505') {
          // Skip duplicate
        } else {
          throw runErr;
        }
      }

    } catch (err) {
      console.error(`❌ Error saving damage event for ${event.victimGamertag}:`, err.message);
      throw err;
    }
  }

  console.log(`✅ Saved ${savedCount} damage events to database`);
  return savedCount;
}

/**
 * Parse kill events from ADM log
 * Format: Player "Victim" (DEAD) (id=HEXID pos=<X,Y,Z>)[HP: 0] killed by Player "Killer" (id=HEXID pos=<X,Y,Z>) with Weapon from Distance meters
 */
function parseKillEvents(admLog, logDate) {
  const killEvents = [];
  const lines = toLines(admLog);

  // Matches kill lines in the format:
  //   HH:MM:SS | Player "VictimName" (DEAD) (id=HEXID pos=<X,Y,Z>)[HP: N] killed by Player "KillerName" (id=HEXID pos=<X,Y,Z>) with WeaponName from Distance meters
  const killRegex = /(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(DEAD\) \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\)(?:\[HP: [\d.]+\])? killed by Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2})(?: pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>)?\) with (\S+)(?: from ([\d.]+) meters)?/;

  for (const [sourceLineIndex, line] of lines.entries()) {
    const match = line.match(killRegex);
    if (!match) continue;

    const [
      ,
      time,
      victimName,
      victimId,
      victimX,
      victimY,
      victimZ,
      killerName,
      killerId,
      killerX,
      killerY,
      killerZ,
      weapon,
      distance
    ] = match;

    // Compute distance: prefer explicit distance from log, otherwise compute from positions when available
    let computedDistance = null;
    if (distance) {
      computedDistance = parseFloat(distance);
    } else if (killerX && killerY && killerZ && victimX && victimY && victimZ) {
      try {
        const kx = parseFloat(killerX);
        const ky = parseFloat(killerY);
        const kz = parseFloat(killerZ);
        const vx = parseFloat(victimX);
        const vy = parseFloat(victimY);
        const vz = parseFloat(victimZ);
        const dx = kx - vx;
        const dy = ky - vy;
        const dz = kz - vz;
        computedDistance = Math.sqrt(dx*dx + dy*dy + dz*dz);
      } catch (e) {
        computedDistance = null;
      }
    }

    killEvents.push({
      timestamp: parseADMTimestamp(time, logDate),
      victimGamertag: victimName,
      victimPlatformUserId: victimId,
      victimPosition: `${victimX},${victimY},${victimZ}`,
      killerGamertag: killerName,
      killerPlatformUserId: killerId,
      killerPosition: killerX ? `${killerX},${killerY},${killerZ}` : null,
      weapon,
      distance: computedDistance,
      sourceLineIndex,
    });
  }

  return killEvents;
}

function enrichKillEventsWithDamage(killEvents, damageEvents) {
  return killEvents.map(kill => {
    const matchingDamage = damageEvents
      .filter(damage =>
        damage.victimPlatformUserId === kill.victimPlatformUserId &&
        damage.attackerPlatformUserId === kill.killerPlatformUserId &&
        damage.timestamp === kill.timestamp &&
        (kill.sourceLineIndex == null || damage.sourceLineIndex == null || damage.sourceLineIndex < kill.sourceLineIndex)
      )
      .sort((a, b) => (b.sourceLineIndex ?? -1) - (a.sourceLineIndex ?? -1))[0];

    if (!matchingDamage) return kill;
    return {
      ...kill,
      weaponExtra: matchingDamage.weapon || null,
      bodyPart: matchingDamage.bodyPart || null,
      damage: matchingDamage.damage ?? null,
    };
  });
}

function parseCombatEvents(admLog, logDate, platform = null) {
  const normalized = normalizeParsedEventIdentities({
    damageEvents: parseDamageEvents(admLog, logDate),
    killEvents: parseKillEvents(admLog, logDate),
  }, platform);
  return {
    damageEvents: normalized.damageEvents,
    killEvents: enrichKillEventsWithDamage(normalized.killEvents, normalized.damageEvents),
  };
}

async function processKillEconomyTransaction(db, serverId, callback) {
  return db.transaction(async () => {
    const server = await db.get(
      "SELECT id FROM servers WHERE id = ? AND status = 'active' FOR UPDATE",
      [serverId]
    );
    if (!server) throw new Error('Server is unavailable');
    return callback();
  });
}

/**
 * Save kill events to database
 */
async function saveKillEvents(db, platformServerId, killEvents, platform, guildId, internalServerId) {
  if (killEvents.length === 0) {
    return 0;
  }

  const server = await getExactServerForPersistence(db, platformServerId, internalServerId);

  const dbServerId = server.id;
  let savedCount = 0;

  const allIds = killEvents.flatMap(e => [e.victimPlatformUserId, e.killerPlatformUserId]);
  const identityMap = await buildIdentityMap(db, platform, allIds);

  for (const event of killEvents) {
    try {
      const wasSaved = await processKillEconomyTransaction(db, dbServerId, async () => {
      const victimIdentityId = resolvedIdentityId(identityMap, event.victimPlatformUserId, 'Kill victim');
      const killerIdentityId = resolvedIdentityId(identityMap, event.killerPlatformUserId, 'Kill killer');

      let wasNewKill = false;
      let killEventId = null;
      try {
        const killResult = await db.run(
          `INSERT INTO kill_events (
            server_id, killer_identity_id, killer_gamertag, killer_position,
            victim_identity_id, victim_gamertag, victim_position,
            weapon, distance, timestamp, log_source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          [
            dbServerId,
            killerIdentityId,
            event.killerGamertag,
            event.killerPosition,
            victimIdentityId,
            event.victimGamertag,
            event.victimPosition,
            event.weapon,
            event.distance,
            event.timestamp,
            'adm_log'
          ]
        );
        if (killResult.changes > 0) {
          wasNewKill = true;
          killEventId = Number(killResult.lastID);
        }
      } catch (runErr) {
        if ((runErr.message && runErr.message.includes('UNIQUE constraint failed')) || runErr.code === '23505') {
          // Skip duplicate
        } else {
          throw runErr;
        }
      }

      // Award kill reward / process loot if this was a new kill event
      if (wasNewKill) {
        // Track economy outcomes so the Discord embed can show them
        let killRewardAmount = 0;
        let lootAmount = 0;
        let lootSource = null; // set when loot mode fires; used in feed payload
        let bountyAwardAmount = 0;
        let bountyRefundAmount = 0;
        let bountyDeferredAwardAmount = 0;
        let bountyDeferredRefundAmount = 0;

        // Establish bounty membership/contract locks before any economy helper
        // locks wallets, preserving the shared server → membership/bounty → wallet order.
        const bountyClaim = await claimBountiesForKillInTransaction(db, {
          killEventId,
          serverId: dbServerId,
          killerIdentityId,
          victimIdentityId,
          killedAt: event.timestamp,
        });
        bountyAwardAmount = bountyClaim?.publicFeedAwardAmount ?? bountyClaim?.claimedAmount ?? 0;
        bountyRefundAmount = bountyClaim?.refundedAmount || 0;
        bountyDeferredAwardAmount = bountyClaim?.publicFeedDeferredAwardAmount
          ?? bountyClaim?.deferredAwardAmount ?? 0;
        bountyDeferredRefundAmount = bountyClaim?.deferredRefundAmount || 0;
        await moneySupplyManager.lockSupplyForUpdate(db, dbServerId);

        try {
          const config = await economyHelper.getEconomyConfigForIdentity(db, killerIdentityId, dbServerId);
          if (config && config.enabled) {
            const mode = config.kill_reward_mode || 'bank';

            // Bank-pays-killer mode: server bank credits the killer
            if ((mode === 'bank' || mode === 'both') && config.kill_rewards_enabled && config.kill_reward > 0) {
              const reward = await economyHelper.awardMoneyInTransaction(
                db,
                killerIdentityId,
                config.kill_reward,
                'kill',
                `Kill reward (${event.victimGamertag})`,
                dbServerId,
                { victimIdentityId: victimIdentityId, weapon: event.weapon, distance: event.distance }
              );
              if (reward) {
                killRewardAmount = config.kill_reward;
                console.log(`💰 Awarded ${config.currency_symbol}${config.kill_reward} to ${event.killerGamertag} for kill`);
              }
            }

            // Loot mode: killer takes a configured amount from the victim's account(s)
            if ((mode === 'loot' || mode === 'both') && config.kill_loot_amount > 0) {
              lootSource = config.kill_loot_source || 'wallet';
              lootAmount = await economyHelper.lootFromVictimInTransaction(
                db,
                victimIdentityId,
                config.kill_loot_amount,
                lootSource,
                event.killerGamertag,
                dbServerId
              );
              if (lootAmount > 0) {
                // Credit the looted amount to the killer's wallet
                await economyHelper.creditTransferInTransaction(
                  db,
                  killerIdentityId,
                  lootAmount,
                  'kill_loot',
                  `Looted from ${event.victimGamertag}`,
                  dbServerId,
                  null
                );
                console.log(`🪙 Looted ${config.currency_symbol}${lootAmount} (${lootSource}) from ${event.victimGamertag} → ${event.killerGamertag}`);
              }
            }
          }
        } catch (error) {
          console.error('Error processing kill economy:', error);
          throw error;
        }

        // Process death penalty for the victim
        try {
          const penalty = await economyHelper.processDeathPenaltyInTransaction(
            db,
            victimIdentityId,
            dbServerId
          );
          if (penalty) {
            console.log(`💀 Death penalty applied: ${penalty.amount} deducted from identity ${victimIdentityId}`);
          }
        } catch (error) {
          console.error('Error processing death penalty:', error);
          throw error;
        }

        // Queue kill event for Discord feed with full details for the rich embed
        if (guildId) {
          console.log(`🔔 [KILL FEED] Attempting to queue kill event for guild ${guildId}`);
          try {
            await queueKillEvent(db, guildId, dbServerId, 'kill_feed', 'player_kill', {
              killer:            event.killerGamertag,
              killerId:          event.killerPlatformUserId,
              killerIdentityId:  killerIdentityId,
              victim:            event.victimGamertag,
              victimId:          event.victimPlatformUserId,
              victimIdentityId:  victimIdentityId,
              weapon:            event.weapon,
              weaponExtra:       event.weaponExtra || null,
              distance:          event.distance || 0,
              bodyPart:          event.bodyPart   || 'Unknown',
              damage:            event.damage     || 0,
              serverId:          dbServerId,
              killRewardAmount:  killRewardAmount,
              lootAmount:        lootAmount,
              lootSource:        lootSource,
              bountyAwardAmount: bountyAwardAmount,
              bountyRefundAmount: bountyRefundAmount,
              bountyDeferredAwardAmount: bountyDeferredAwardAmount,
              bountyDeferredRefundAmount: bountyDeferredRefundAmount,
              timestamp:         event.timestamp
            });
            console.log(`✅ [KILL FEED] Successfully queued kill event`);
          } catch (error) {
            console.error('❌ [KILL FEED] Error queuing kill feed event:', error);
            throw error;
          }

          // Queue a faction_feed event when both players are in different factions
          try {
            const guildRow = await db.get(
              `SELECT id FROM guilds WHERE discord_guild_id = ?`,
              [guildId]
            );
            if (guildRow) {
              const internalGuildId = guildRow.id;

              // Resolve killer and victim identity IDs from their gamertags/platform IDs
              // faction_members.identity_id is an integer FK — never pass a platform hex ID
              if (killerIdentityId && victimIdentityId) {
                const [killerMembership, victimMembership] = await Promise.all([
                  db.get(
                    `SELECT f.name AS faction_name, f.tag AS faction_tag
                     FROM faction_members fm
                     JOIN factions f ON f.id = fm.faction_id
                     WHERE fm.identity_id = ? AND f.guild_id = ?
                     LIMIT 1`,
                    [killerIdentityId, internalGuildId]
                  ),
                  db.get(
                    `SELECT f.name AS faction_name, f.tag AS faction_tag
                     FROM faction_members fm
                     JOIN factions f ON f.id = fm.faction_id
                     WHERE fm.identity_id = ? AND f.guild_id = ?
                     LIMIT 1`,
                    [victimIdentityId, internalGuildId]
                  ),
                ]);

                // Only fire if both players are in factions AND they are different factions
                if (killerMembership && victimMembership &&
                    killerMembership.faction_tag !== victimMembership.faction_tag) {
                  await queueKillEvent(db, guildId, dbServerId, 'faction_feed', 'faction_kill', {
                    killer:        event.killerGamertag,
                    killerFaction: killerMembership.faction_tag || killerMembership.faction_name,
                    victim:        event.victimGamertag,
                    victimFaction: victimMembership.faction_tag || victimMembership.faction_name,
                    weapon:        event.weapon,
                    distance:      event.distance || 0,
                    timestamp:     event.timestamp,
                  });
                  console.log(`⚔️ [FACTION FEED] Queued faction kill: [${killerMembership.faction_tag}] vs [${victimMembership.faction_tag}]`);
                }
              }
            }
          } catch (error) {
            console.error('❌ [FACTION FEED] Error queuing faction feed event:', error);
            throw error;
          }
        } else {
          console.warn('⚠️ [KILL FEED] No guildId available, skipping feed queue');
        }
      }
      return wasNewKill;
      });
      if (wasSaved) savedCount++;

    } catch (err) {
      console.error(`❌ Error saving kill event for ${event.victimGamertag}:`, err.message);
      throw err;
    }
  }

  console.log(`✅ Saved ${savedCount} kill events to database`);
  return savedCount;
}

/**
 * Parse territory and base building events from ADM log
 */
function parseTerritoryEvents(admLog, logDate) {
  const territoryEvents = [];
  const lines = toLines(admLog);

  // Real ADM formats (pos embedded in player info, no separate pos= at end):
  //   Built/Dismantled — no space between ')' and action:
  //     HH:MM:SS | Player "X" (id=HASH pos=<X, Y, Z>)Built PART on STRUCT with TOOL
  //     HH:MM:SS | Player "X" (id=HASH pos=<X, Y, Z>)Dismantled PART from STRUCT with TOOL
  //   placed/folded/has raised — space before action:
  //     HH:MM:SS | Player "X" (id=HASH pos=<X, Y, Z>) placed DisplayName<ClassName>
  //     HH:MM:SS | Player "X" (id=HASH pos=<X, Y, Z>) has raised FLAG on TerritoryFlag at <X,Y,Z>
  //     HH:MM:SS | Player "X" (id=HASH pos=<X, Y, Z>) folded STRUCT

  const playerPrefix = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\)/;

  // Built PART on STRUCT with TOOL  (immediately after closing paren, no space)
  const builtRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\)Built (.+?) on (.+?) with (.+)$/;
  // Dismantled PART from STRUCT with TOOL
  const dismantleRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\)Dismantled (.+?) from (.+?) with (.+)$/;
  // placed DisplayName<ClassName>
  const placedRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) placed (.+)$/;
  // has raised FLAG on TerritoryFlag
  const raisedRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) has raised (\S+) on (TerritoryFlag)/;
  // folded STRUCT
  const foldedRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) folded (.+)$/;
  // Mounted ITEM on STRUCT  (via SurvivorBase entity, no space after closing paren)
  const mountedRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\)Player SurvivorBase<[^>]+> Mounted (.+?) on (.+)$/;
  // Unmounted ITEM from STRUCT
  const unmountedRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\)Player SurvivorBase<[^>]+> Unmounted (.+?) from (.+)$/;

  for (const [sourceLineIndex, line] of lines.entries()) {
    if (!playerPrefix.test(line)) continue;
    const addTerritoryEvent = event => territoryEvents.push({ ...event, sourceLineIndex });

    let match = line.match(builtRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ, structurePart, structureType, toolUsed] = match;
      addTerritoryEvent({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName,
        platformUserId: playerId,
        eventType: 'built',
        structureType: normalizeStructureType(structureType),
        structurePart: structurePart.trim(),
        toolUsed: toolUsed.trim(),
        position: `${posX},${posY},${posZ}`,
        posX: parseFloat(posX),
        posY: parseFloat(posY),
        posZ: parseFloat(posZ)
      });
      continue;
    }

    match = line.match(dismantleRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ, structurePart, structureType, toolUsed] = match;
      addTerritoryEvent({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName,
        platformUserId: playerId,
        eventType: 'dismantled',
        structureType: normalizeStructureType(structureType),
        structurePart: structurePart.trim(),
        toolUsed: toolUsed.trim(),
        position: `${posX},${posY},${posZ}`,
        posX: parseFloat(posX),
        posY: parseFloat(posY),
        posZ: parseFloat(posZ)
      });
      continue;
    }

    match = line.match(placedRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ, itemRaw] = match;
      // itemRaw is "DisplayName<ClassName>" or just "ClassName"
      // Store the raw ClassName as structure_type so achievement ILIKE queries work
      // (e.g. "Barrel_Green" matches '%Barrel%', "WoodenCrate" matches '%Crate%')
      const classMatch = itemRaw.match(/^(.+)<([^>]+)>$/);
      const structureType = classMatch ? classMatch[2] : itemRaw.trim();
      const displayName = classMatch ? classMatch[1].trim() : itemRaw.trim();
      addTerritoryEvent({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName,
        platformUserId: playerId,
        eventType: 'placed',
        structureType,           // raw class name, e.g. Barrel_Green, WoodenCrate
        structurePart: displayName, // human-readable label, e.g. "Barrel", "Wooden Crate"
        toolUsed: null,
        position: `${posX},${posY},${posZ}`,
        posX: parseFloat(posX),
        posY: parseFloat(posY),
        posZ: parseFloat(posZ)
      });
      continue;
    }

    match = line.match(raisedRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ, flagName, structureType] = match;
      addTerritoryEvent({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName,
        platformUserId: playerId,
        eventType: 'raised',
        structureType: normalizeStructureType(structureType),
        structurePart: flagName,
        toolUsed: null,
        position: `${posX},${posY},${posZ}`,
        posX: parseFloat(posX),
        posY: parseFloat(posY),
        posZ: parseFloat(posZ)
      });
      continue;
    }

    match = line.match(foldedRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ, structureType] = match;
      addTerritoryEvent({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName,
        platformUserId: playerId,
        eventType: 'folded',
        structureType: normalizeStructureType(structureType),
        structurePart: null,
        toolUsed: null,
        position: `${posX},${posY},${posZ}`,
        posX: parseFloat(posX),
        posY: parseFloat(posY),
        posZ: parseFloat(posZ)
      });
      continue;
    }

    match = line.match(mountedRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ, item, onStruct] = match;
      addTerritoryEvent({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName,
        platformUserId: playerId,
        eventType: 'mounted',
        structureType: item.trim(),       // e.g. BarbedWire
        structurePart: onStruct.trim(),   // e.g. Fence
        toolUsed: null,
        position: `${posX},${posY},${posZ}`,
        posX: parseFloat(posX),
        posY: parseFloat(posY),
        posZ: parseFloat(posZ)
      });
      continue;
    }

    match = line.match(unmountedRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ, item, fromStruct] = match;
      addTerritoryEvent({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName,
        platformUserId: playerId,
        eventType: 'unmounted',
        structureType: item.trim(),         // e.g. BarbedWire
        structurePart: fromStruct.trim(),   // e.g. Fence
        toolUsed: null,
        position: `${posX},${posY},${posZ}`,
        posX: parseFloat(posX),
        posY: parseFloat(posY),
        posZ: parseFloat(posZ)
      });
    }
  }

  return territoryEvents;
}

/**
 * Normalize structure type for built/dismantled/folded events where the
 * log gives the structure name (Fence, Gate, Watchtower, etc.).
 * For placed events we store the raw class name instead of normalising.
 */
function normalizeStructureType(structureType) {
  // Defensively handle missing/empty input coming from varied ADM formats.
  if (!structureType) return 'unknown';
  const lower = String(structureType).toLowerCase().trim();
  if (!lower) return 'unknown';
  if (lower.includes('flag') || lower.includes('territory')) return 'TerritoryFlag';
  if (lower.includes('watchtower') || lower.includes('tower')) return 'Watchtower';
  if (lower.includes('gate')) return 'Gate';
  if (lower.includes('fence')) return 'Fence';
  if (lower.includes('wall')) return 'Wall';
  return String(structureType).trim();
}

/**
 * Save territory events to database
 */
async function saveTerritoryEvents(db, platformServerId, territoryEvents, platform, internalServerId) {
  if (territoryEvents.length === 0) {
    return 0;
  }

  const server = await getExactServerForPersistence(db, platformServerId, internalServerId);

  const dbServerId = server.id;
  let savedCount = 0;

  const identityMap = await buildIdentityMap(db, platform, territoryEvents.map(e => e.platformUserId));

  for (const event of territoryEvents) {
    try {
      const identityId = resolvedIdentityId(identityMap, event.platformUserId, 'Territory event');

      try {
        // Defensive default for missing structureType — avoid NULL inserts causing constraint failures.
        const structureTypeSafe = event.structureType || 'unknown';
        if (!event.structureType) console.warn(`⚠️ Missing structureType for event at ${event.timestamp}; defaulting to 'unknown'`);
        const terrResult = await db.run(
          `INSERT INTO territory_events (
            server_id, identity_id, player_gamertag, event_type, structure_type,
            structure_part, tool_used, position, pos_x, pos_y, pos_z, timestamp, log_source,
            source_file, source_line
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            dbServerId,
            identityId,
            event.playerGamertag,
            event.eventType,
            structureTypeSafe,
            event.structurePart || null,
            event.toolUsed || null,
            event.position,
            event.posX,
            event.posY,
            event.posZ,
            event.timestamp,
            'adm_log',
            event.sourceFile || null,
            event.sourceLine ?? null
          ]
        );
        if (terrResult.changes > 0) savedCount++;
      } catch (runErr) {
        if ((runErr.message && runErr.message.includes('UNIQUE constraint failed')) || runErr.code === '23505') {
          // Skip duplicate
        } else {
          throw runErr;
        }
      }

    } catch (err) {
      console.error(`❌ Error saving territory event:`, err.message);
      throw err;
    }
  }

  console.log(`✅ Saved ${savedCount} territory events to database`);
  return savedCount;
}

/**
 * Parse death events from ADM log.
 * Covers: generic death (Stats>), zombie/animal kills, bleed-outs.
 */
function parseDeathEvents(admLog, logDate) {
  const deathEvents = [];
  const lines = toLines(admLog);

  // died. Stats> Water: N Energy: N Bleed sources: N
  const diedRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(DEAD\) \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) died\. Stats> Water: ([\d.]+) Energy: ([\d.]+) Bleed sources: (\d+)$/;
  // killed by ZmbType or animal class
  const killedByRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(DEAD\) \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) killed by (\S+)$/;
  // bled out
  const bledOutRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(DEAD\) \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) bled out$/;
  // committed suicide
  const suicideRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(DEAD\) \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) committed suicide$/;
  // drowned. Stats>
  const drownedRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(DEAD\) \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) drowned\. Stats> Water: ([\d.]+) Energy: ([\d.]+) Bleed sources: (\d+)$/;

  for (const line of lines) {
    let match = line.match(diedRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ, water, energy, bleedSources] = match;
      deathEvents.push({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName,
        platformUserId: playerId,
        deathType: 'died',
        killedBy: null,
        posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ),
        water: parseFloat(water), energy: parseFloat(energy), bleedSources: parseInt(bleedSources)
      });
      continue;
    }

    match = line.match(drownedRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ, water, energy, bleedSources] = match;
      deathEvents.push({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName,
        platformUserId: playerId,
        deathType: 'drowned',
        killedBy: null,
        posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ),
        water: parseFloat(water), energy: parseFloat(energy), bleedSources: parseInt(bleedSources)
      });
      continue;
    }

    match = line.match(killedByRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ, killedBy] = match;
      deathEvents.push({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName,
        platformUserId: playerId,
        deathType: 'killed_by_npc',
        killedBy,
        posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ),
        water: null, energy: null, bleedSources: null
      });
      continue;
    }

    match = line.match(bledOutRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ] = match;
      deathEvents.push({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName,
        platformUserId: playerId,
        deathType: 'bled_out',
        killedBy: null,
        posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ),
        water: null, energy: null, bleedSources: null
      });
      continue;
    }

    match = line.match(suicideRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ] = match;
      deathEvents.push({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName,
        platformUserId: playerId,
        deathType: 'suicide',
        killedBy: null,
        posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ),
        water: null, energy: null, bleedSources: null
      });
    }
  }

  return deathEvents;
}

async function saveDeathEvents(db, platformServerId, deathEvents, platform, internalServerId) {
  if (deathEvents.length === 0) return 0;

  const server = await getExactServerForPersistence(db, platformServerId, internalServerId);

  const dbServerId = server.id;
  let savedCount = 0;

  const identityMap = await buildIdentityMap(db, platform, deathEvents.map(e => e.platformUserId));

  for (const event of deathEvents) {
    try {
      const identityId = resolvedIdentityId(identityMap, event.platformUserId, 'Parsed event');

      const result = await db.run(
        `INSERT INTO player_death_events (
          server_id, identity_id, player_gamertag, death_type, killed_by,
          pos_x, pos_y, pos_z, water_level, energy_level, bleed_sources, timestamp, log_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          dbServerId, identityId, event.playerGamertag, event.deathType, event.killedBy,
          event.posX, event.posY, event.posZ,
          event.water, event.energy, event.bleedSources,
          event.timestamp, 'adm_log'
        ]
      );
      if (result.changes > 0) savedCount++;
    } catch (err) {
      if (err.code === '23505') continue;
      console.error(`❌ Error saving death event:`, err.message);
      throw err;
    }
  }

  console.log(`✅ Saved ${savedCount} death events to database`);
  return savedCount;
}

/**
 * Parse unconscious events (went unconscious, regained consciousness, disconnect-while-unconscious).
 */
function parseUnconsciousEvents(admLog, logDate) {
  const events = [];
  const lines = toLines(admLog);

  const unconsciousRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) is unconscious$/;
  const regainedRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) regained consciousness$/;
  const disconnectUnconsciousRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) is disconnecting while being unconscious$/;

  for (const line of lines) {
    let match = line.match(unconsciousRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ] = match;
      events.push({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName, platformUserId: playerId,
        eventType: 'unconscious',
        posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ)
      });
      continue;
    }

    match = line.match(regainedRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ] = match;
      events.push({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName, platformUserId: playerId,
        eventType: 'regained_consciousness',
        posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ)
      });
      continue;
    }

    match = line.match(disconnectUnconsciousRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ] = match;
      events.push({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName, platformUserId: playerId,
        eventType: 'disconnect_unconscious',
        posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ)
      });
    }
  }

  return events;
}

async function saveUnconsciousEvents(db, platformServerId, events, platform, internalServerId) {
  if (events.length === 0) return 0;

  const server = await getExactServerForPersistence(db, platformServerId, internalServerId);

  const dbServerId = server.id;
  let savedCount = 0;

  const identityMap = await buildIdentityMap(db, platform, events.map(e => e.platformUserId));

  for (const event of events) {
    try {
      const identityId = resolvedIdentityId(identityMap, event.platformUserId, 'Parsed event');

      const result = await db.run(
        `INSERT INTO player_unconscious_events (
          server_id, identity_id, player_gamertag, event_type,
          pos_x, pos_y, pos_z, timestamp, log_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [dbServerId, identityId, event.playerGamertag, event.eventType,
         event.posX, event.posY, event.posZ, event.timestamp, 'adm_log']
      );
      if (result.changes > 0) savedCount++;
    } catch (err) {
      if (err.code === '23505') continue;
      console.error(`❌ Error saving unconscious event:`, err.message);
      throw err;
    }
  }

  console.log(`✅ Saved ${savedCount} unconscious events to database`);
  return savedCount;
}

/**
 * Parse cleanup (despawn) events from RPT log lines.
 *
 * Matches lines like:
 *   14:39:54.526 <cleanup> Depleted:"PorkCan" at [2461,5239] damage=0.61
 *   14:40:43.132 <cleanup> Depleted:"ZmbM_PatrolNormal_Winter" at [4203,10379] damage=0.00 DE="InfectedArmy"
 *
 * Only "Depleted" events are captured — "Remove" lines are duplicates and
 * "Outside world" lines are map boundary discards, not CE-managed loot.
 *
 * @param {string[]|string} rptContent - RPT log lines (array or newline-joined string)
 * @param {string}          logDate    - ISO date string extracted from the filename (YYYY-MM-DD)
 * @returns {{ itemClass, posX, posZ, damage, logDate }[]}
 */
function parseCleanupEvents(rptContent, logDate) {
  const lines = toLines(rptContent);
  const events = [];

  // HH:MM:SS[.mmm]  <cleanup> Depleted:"ItemClass" at [x,z] damage=N.NN [DE="group"]
  const regex = /\d{1,2}:\d{2}:\d{2}[\d.]* <cleanup> Depleted:"([^"]+)" at \[(\d+),(\d+)\] damage=([\d.]+)/;

  for (const line of lines) {
    const m = line.match(regex);
    if (!m) continue;
    events.push({
      itemClass: m[1],
      posX:      parseInt(m[2], 10),
      posZ:      parseInt(m[3], 10),
      damage:    parseFloat(m[4]),
      logDate,
    });
  }
  return events;
}

/**
 * Bulk-insert cleanup events into loot_despawn_events.
 * Silently skips duplicates (same item/position/date on the same server).
 *
 * @param {object}   db               - Database adapter
 * @param {string}   platformServerId - Nitrado platform server ID
 * @param {{ itemClass, posX, posZ, damage, logDate }[]} events
 * @returns {Promise<number>} rows inserted
 */
async function saveCleanupEvents(db, platformServerId, events, internalServerId) {
  if (!events || events.length === 0) return 0;

  const server = await getExactServerForPersistence(db, platformServerId, internalServerId);

  const dbServerId = server.id;
  let savedCount = 0;

  // Insert in batches of 500 to keep individual queries manageable
  const BATCH = 500;
  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH);

    // Build parameterised bulk INSERT
    const placeholders = batch.map((_, j) => {
      const base = j * 5;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });
    const values = [];
    for (const e of batch) {
      values.push(dbServerId, e.itemClass, e.posX, e.posZ, e.logDate);
    }

    try {
      const result = await db.run(
        `INSERT INTO loot_despawn_events (server_id, item_class, pos_x, pos_z, log_date)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (server_id, item_class, pos_x, pos_z, log_date) DO NOTHING`,
        values
      );
      savedCount += result.changes ?? 0;
    } catch (err) {
      console.error('❌ Error saving cleanup event batch:', err.message);
      throw err;
    }
  }

  console.log(`✅ Saved ${savedCount} loot despawn events`);
  return savedCount;
}

/**
 * Extract a YYYY-MM-DD date string from an RPT filename.
 * Filename format: DayZServer_X1_x64_2026-05-15_14-38-46.RPT
 */
function extractRPTLogDate(filePath, rootDir = path.dirname(filePath)) {
  const filenameTimestamp = logStartTimeMs(path.basename(filePath));
  if (filenameTimestamp !== null) return new Date(filenameTimestamp).toISOString().slice(0, 10);
  const { fd, stat } = openLogFile(filePath, rootDir);
  try {
    return new Date(stat.mtimeMs).toISOString().slice(0, 10);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Parse respawn events — player choosing to respawn after death.
 */
function parseRespawnEvents(admLog, logDate) {
  const events = [];
  const lines = toLines(admLog);

  const respawnRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(DEAD\) \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) is choosing to respawn$/;

  for (const line of lines) {
    const match = line.match(respawnRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ] = match;
      events.push({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName, platformUserId: playerId,
        posX: parseFloat(posX), posY: parseFloat(posY), posZ: parseFloat(posZ)
      });
    }
  }

  return events;
}

async function saveRespawnEvents(db, platformServerId, events, platform, internalServerId) {
  if (events.length === 0) return 0;

  const server = await getExactServerForPersistence(db, platformServerId, internalServerId);

  const dbServerId = server.id;
  let savedCount = 0;

  const identityMap = await buildIdentityMap(db, platform, events.map(e => e.platformUserId));

  for (const event of events) {
    try {
      const identityId = resolvedIdentityId(identityMap, event.platformUserId, 'Parsed event');

      const result = await db.run(
        `INSERT INTO player_respawn_events (
          server_id, identity_id, player_gamertag,
          pos_x, pos_y, pos_z, timestamp, log_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [dbServerId, identityId, event.playerGamertag,
         event.posX, event.posY, event.posZ, event.timestamp, 'adm_log']
      );
      if (result.changes > 0) savedCount++;
    } catch (err) {
      if (err.code === '23505') continue;
      console.error(`❌ Error saving respawn event:`, err.message);
      throw err;
    }
  }

  console.log(`✅ Saved ${savedCount} respawn events to database`);
  return savedCount;
}

/**
 * Parse PlayerList snapshot blocks.
 * Format:
 *   HH:MM:SS | ##### PlayerList log: N players
 *   HH:MM:SS | Player "Name" (id=HASH pos=<X, Y, Z>)
 *   ...
 *   HH:MM:SS | #####
 */
function parsePositionSnapshots(admLog, logDate) {
  const snapshots = [];
  const lines = toLines(admLog);

  const headerRegex = /^(\d{2}:\d{2}:\d{2}) \| ##### PlayerList log: (\d+) players$/;
  const playerLineRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\)$/;

  let inBlock = false;
  let snapshotTimestamp = null;

  for (const line of lines) {
    const headerMatch = line.match(headerRegex);
    if (headerMatch) {
      inBlock = true;
      snapshotTimestamp = parseADMTimestamp(headerMatch[1], logDate);
      continue;
    }

    if (inBlock) {
      if (/^\d{2}:\d{2}:\d{2} \| #####$/.test(line)) {
        inBlock = false;
        continue;
      }

      const playerMatch = line.match(playerLineRegex);
      if (playerMatch) {
        const [, , playerName, playerId, posX, posY, posZ] = playerMatch;
        snapshots.push({
          timestamp: snapshotTimestamp,
          playerGamertag: playerName,
          platformUserId: playerId,
          posX: parseFloat(posX),
          posY: parseFloat(posY),
          posZ: parseFloat(posZ)
        });
      }
    }
  }

  return snapshots;
}

async function savePositionSnapshots(db, platformServerId, snapshots, platform, internalServerId) {
  if (snapshots.length === 0) return 0;

  const server = await getExactServerForPersistence(db, platformServerId, internalServerId);

  const dbServerId = server.id;
  let savedCount = 0;

  const identityMap = await buildIdentityMap(db, platform, snapshots.map(s => s.platformUserId));

  for (const snap of snapshots) {
    try {
      const identityId = resolvedIdentityId(identityMap, snap.platformUserId, 'Position snapshot');

      const result = await db.run(
        `INSERT INTO player_position_snapshots (
          server_id, identity_id, player_gamertag,
          pos_x, pos_y, pos_z, timestamp, log_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING`,
        [dbServerId, identityId, snap.playerGamertag,
         snap.posX, snap.posY, snap.posZ, snap.timestamp, 'adm_log']
      );
      if (result.changes > 0) savedCount++;
    } catch (err) {
      if (err.code === '23505') continue;
      console.error(`❌ Error saving position snapshot:`, err.message);
      throw err;
    }
  }

  console.log(`✅ Saved ${savedCount} position snapshots to database`);
  return savedCount;
}

async function saveDisconnectPositions(db, platformServerId, positions, platform, internalServerId) {
  if (!positions.length) return 0;
  const server = await getExactServerForPersistence(db, platformServerId, internalServerId);
  const identityMap = await buildIdentityMap(db, platform, positions.map(position => position.platformUserId));
  let savedCount = 0;
  for (const position of positions) {
    const identityId = resolvedIdentityId(identityMap, position.platformUserId, 'Disconnect position');
    const result = await db.run(
      `INSERT INTO player_disconnect_positions
         (server_id, identity_id, pos_x, pos_y, pos_z, observed_at, source_file)
       SELECT ?, ?, ?, ?, ?, ?, ?
       FROM server_player_memberships
       WHERE server_id = ? AND identity_id = ? AND status = 'active'
       ON CONFLICT DO NOTHING`,
      [server.id, identityId, position.posX, position.posY, position.posZ,
        position.timestamp, position.sourceFile, server.id, identityId]
    );
    if (result.changes > 0) savedCount++;
  }
  return savedCount;
}

/**
 * Parse emote events.
 * Format: HH:MM:SS | Player "Name" (id=HASH pos=<X, Y, Z>) performed EmoteType [with Item]
 */
function parseEmoteEvents(admLog, logDate) {
  const events = [];
  const lines = toLines(admLog);

  // with optional item
  const emoteRegex = /^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)" \(id=([A-Za-z0-9_-]+={0,2}) pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\) performed (\S+)(?: with (.+))?$/;

  for (const [sourceLineIndex, line] of lines.entries()) {
    const match = line.match(emoteRegex);
    if (match) {
      const [, timestamp, playerName, playerId, posX, posY, posZ, emoteType, itemName] = match;
      events.push({
        timestamp: parseADMTimestamp(timestamp, logDate),
        playerGamertag: playerName,
        platformUserId: playerId,
        emoteType,
        itemName: itemName || null,
        posX: parseFloat(posX),
        posY: parseFloat(posY),
        posZ: parseFloat(posZ),
        sourceLineIndex,
      });
    }
  }

  return events;
}

async function saveEmoteEvents(db, platformServerId, events, platform, internalServerId) {
  if (events.length === 0) return 0;

  const server = await getExactServerForPersistence(db, platformServerId, internalServerId);
  const dbServerId = server.id;
  const identityMap = await buildIdentityMap(db, platform, events.map(e => e.platformUserId));

  const savedCount = await db.transaction(async transactionDb => {
    const lockedServer = await lockActiveCaptureServer(transactionDb, dbServerId);
    if (!lockedServer) throw new Error(`Exact server ${dbServerId} is no longer available`);

    let insertedCount = 0;
    for (const event of events) {
      const identityId = resolvedIdentityId(identityMap, event.platformUserId, 'Parsed event');
      const result = await transactionDb.run(
        `INSERT INTO player_emote_events (
          server_id, identity_id, player_gamertag, emote_type, item_name,
          pos_x, pos_y, pos_z, timestamp, log_source, source_file, source_line
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
        RETURNING id`,
        [dbServerId, identityId, event.playerGamertag, event.emoteType, event.itemName,
         event.posX, event.posY, event.posZ, event.timestamp, 'adm_log',
         event.sourceFile || null, event.sourceLine ?? null]
      );
      if (result.changes > 0) {
        insertedCount++;
        await applyEmoteEventToCaptureInTransaction(transactionDb, result.lastID);
      }
    }
    return insertedCount;
  });

  console.log(`✅ Saved ${savedCount} emote events to database`);
  return savedCount;
}

// Get all tracked players with pagination and sorting
router.get('/tracked-players', ensureAuthenticated, ensurePlatformServerOwner, validatePagination, validateSort, async (req, res) => {
  console.log('\n📨 [API] GET /api/tracked-players');
  console.log('   User:', req.user?.username);
  console.log('   Query params:', req.query);

  const db = req.app.locals.db;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 100;
  const sortBy = req.query.sortBy || 'lastSeenAt';
  const sortOrder = req.query.sortOrder || 'DESC';

  console.log('   Parsed:', { page, limit, sortBy, sortOrder });

  // ENSURE all sort fields are whitelisted
  const ALLOWED_SORT_FIELDS = ['currentName', 'platformUserId', 'platform', 'deviceId', 'firstSeenAt', 'lastSeenAt'];
  const ALLOWED_SORT_ORDER = ['ASC', 'DESC'];

  // Strict validation
  let validSortBy = sortBy;
  if (!ALLOWED_SORT_FIELDS.includes(sortBy)) {
    validSortBy = 'lastSeenAt';
  }

  let validSortOrder = sortOrder.toUpperCase();
  if (!ALLOWED_SORT_ORDER.includes(validSortOrder)) {
    validSortOrder = 'DESC';
  }

  const offset = (page - 1) * limit;
  console.log('   SQL offset:', offset);

  try {
    const dbServerId = req.platformServerAccess.serverId;
    // Count only identities observed on the exact authorized server.
    const countRow = await db.get(
      `SELECT COUNT(DISTINCT psa.identity_id) as total
       FROM player_server_activity psa
       JOIN player_identities pi ON pi.id = psa.identity_id
       WHERE psa.server_id = ?`,
      [dbServerId]
    );

    const totalPlayers = countRow.total;
    const totalPages = limit === -1 ? 1 : Math.ceil(totalPlayers / limit);

    console.log('   Total players in DB:', totalPlayers);

    // Map sort field from old to new schema
    let sortField = validSortBy;
    if (validSortBy === 'currentName') {
      sortField = 'COALESCE(pg.gamertag, pi.platform_username)';
    } else if (validSortBy === 'platformUserId') {
      sortField = 'pi.platform_user_id';
    } else if (validSortBy === 'platform') {
      sortField = 'pi.platform';
    } else if (validSortBy === 'deviceId') {
      sortField = 'pi.device_id';
    } else if (validSortBy === 'firstSeenAt') {
      sortField = 'psa.first_seen';
    } else if (validSortBy === 'lastSeenAt') {
      sortField = 'psa.last_seen';
    }

    console.log('🔍 [API] Querying database...');

    // Build query using Schema V2
    let query = `
      SELECT
        pi.id,
        pi.platform_user_id as "platformUserId",
        pi.platform,
        COALESCE(pg.gamertag, pi.platform_username) as "currentName",
        pi.device_id as "deviceId",
        psa.first_seen as "firstSeenAt",
        psa.last_seen as "lastSeenAt",
        STRING_AGG(DISTINCT pg.gamertag, ',') as "allGamertags"
      FROM player_server_activity psa
      JOIN player_identities pi ON pi.id = psa.identity_id
      LEFT JOIN player_gamertags pg
        ON pg.identity_id = pi.id
       AND pg.server_id = psa.server_id
       AND pg.is_current_gamertag = 1
      WHERE psa.server_id = ?
      GROUP BY pi.id, psa.first_seen, psa.last_seen
      ORDER BY ${sortField} ${validSortOrder}
    `;

    if (limit !== -1) {
      query += ` LIMIT ? OFFSET ?`;
    }

    const params = limit === -1 ? [dbServerId] : [dbServerId, limit, offset];

    const rows = await db.query(query, params);

    console.log('✅ [API] Query successful');
    console.log('   Players returned:', rows.length);
    console.log('   Total count:', totalPlayers);

    res.json({
      success: true,
      players: rows,
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalPlayers: totalPlayers,
        limit: limit,
        hasMore: page < totalPages
      }
    });
  } catch (err) {
    console.error('❌ [API] Query error:', err);
    console.error('   Message:', err.message);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

// Detect alts (players sharing device IDs)
router.get('/detect-alts', ensureAuthenticated, ensurePlatformServerOwner, async (req, res) => {
  const db = req.app.locals.db;
  const dbServerId = req.platformServerAccess.serverId;

  // Restrict identity/device correlation to players observed on the selected server.
  const query = `
    SELECT
      pi.device_id,
      STRING_AGG(COALESCE(pg.gamertag, 'Unknown'), '|||') as "playerNames",
      STRING_AGG(pi.platform_user_id, '|||') as "platformUserIds",
      STRING_AGG(pi.platform, '|||') as platforms,
      COUNT(DISTINCT pi.id) as "accountCount",
      MAX(psa.last_seen) as last_seen
    FROM player_server_activity psa
    JOIN player_identities pi ON pi.id = psa.identity_id
    LEFT JOIN player_gamertags pg
      ON pg.identity_id = pi.id
     AND pg.server_id = psa.server_id
     AND pg.is_current_gamertag = 1
    WHERE psa.server_id = ?
      AND pi.device_id IS NOT NULL
    GROUP BY pi.device_id
    HAVING COUNT(DISTINCT pi.id) > 1
    ORDER BY COUNT(DISTINCT pi.id) DESC, MAX(psa.last_seen) DESC
  `;

  try {
    const rows = await db.query(query, [dbServerId]);

    if (!rows || rows.length === 0) {
      return res.json({ success: true, alts: [], totalDevices: 0 });
    }

    const dedup = val => val ? [...new Set(val.split('|||').filter(Boolean))] : [];

    const alts = rows.map(row => ({
      deviceId: row.device_id,
      platforms: dedup(row.platforms),
      accounts: dedup(row.playerNames),
      platformUserIds: dedup(row.platformUserIds),
      accountCount: row.accountCount,
      lastSeen: row.last_seen
    }));

    res.json({ success: true, alts, totalDevices: alts.length });
  } catch (err) {
    console.error('❌ Error detecting alts:', err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});

// Helper: Find ALL log files matching pattern
function findAllLogFiles(dir, pattern, maxAgeMs = 25 * 60 * 60 * 1000, {
  excludedArtifactPattern = null,
} = {}) {
  const matches = (candidate, candidatePattern) => {
    if (!candidatePattern) return false;
    candidatePattern.lastIndex = 0;
    return candidatePattern.test(candidate);
  };
  const rootStat = fs.lstatSync(dir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Invalid log inventory directory: ${dir}`);
  }
  const results = [];
  const cutoff = Date.now() - maxAgeMs;
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.lstatSync(filePath);

    if (stat.isSymbolicLink()) {
      if (matches(file, excludedArtifactPattern)) continue;
      throw new Error(`Log inventory contains a symbolic link: ${filePath}`);
    }
    if (stat.isDirectory()) {
      if (matches(file, excludedArtifactPattern)) continue;
      results.push(...findAllLogFiles(filePath, pattern, maxAgeMs, { excludedArtifactPattern }));
    } else if (stat.isFile() && matches(file, pattern) && stat.mtimeMs >= cutoff) {
      // Incremental scans only process recent logs so the scheduler does not
      // re-parse months of historical files every minute.
      results.push(filePath);
    }
  }

  return results;
}

function normalizeSourceObservedAt(parsedSourceObservedAt, providerSourceObservedAt) {
  let providerMs = null;
  if (typeof providerSourceObservedAt === 'number'
      || (typeof providerSourceObservedAt === 'string' && /^\d+(?:\.\d+)?$/.test(providerSourceObservedAt))) {
    const numeric = Number(providerSourceObservedAt);
    if (Number.isFinite(numeric) && numeric > 0) {
      providerMs = numeric < 1e12 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
    }
  } else if (typeof providerSourceObservedAt === 'string') {
    providerMs = parseStrictTimestampMs(providerSourceObservedAt);
  }
  if (providerMs !== null && !Number.isFinite(new Date(providerMs).getTime())) {
    providerMs = null;
  }
  if (providerMs !== null) return new Date(providerMs).toISOString();

  const parsedMs = parseStrictTimestampMs(parsedSourceObservedAt);
  return parsedMs !== null ? new Date(parsedMs).toISOString() : null;
}

function normalizeLatestAdmPositionTimestamps(positionSnapshots, parsedSourceObservedAt,
  providerSourceObservedAt) {
  const parsedMs = parseStrictTimestampMs(parsedSourceObservedAt);
  const providerIso = normalizeSourceObservedAt(null, providerSourceObservedAt);
  const providerMs = providerIso ? Date.parse(providerIso) : null;
  if (parsedMs === null || providerMs === null) return positionSnapshots;

  const hourMs = 60 * 60 * 1000;
  const offsetMs = Math.round((providerMs - parsedMs) / hourMs) * hourMs;
  const residualMs = providerMs - parsedMs - offsetMs;
  if (offsetMs < 0 || offsetMs > 14 * hourMs
      || residualMs < 0 || residualMs > 15 * 60 * 1000) {
    return positionSnapshots;
  }

  const normalized = [];
  for (const snapshot of positionSnapshots) {
    const timestampMs = parseStrictTimestampMs(snapshot.timestamp);
    if (timestampMs === null) {
      normalized.push(snapshot);
      continue;
    }
    const normalizedTimestampMs = timestampMs + offsetMs;
    if (normalizedTimestampMs > providerMs) return positionSnapshots;
    normalized.push({ ...snapshot, timestamp: new Date(normalizedTimestampMs).toISOString() });
  }
  return normalized;
}

/**
 * Standalone log scanner for a single server – callable from the scheduler.
 * @param {object} db - PostgreSQL database adapter
 * @param {number} userId - Internal DB user ID
 * @param {string|number} serverId - Nitrado platform server ID
 * @param {string} token - Decrypted Nitrado API token
 */
async function scanLogsForServer(db, userId, serverId, token, {
  fullHistory = false,
  includeRptLogs = true,
  internalServerId = null,
  systemAuthorizedInternalServerId = null,
  sourceObservedAt = null,
  sourceObservedLogFile = null,
} = {}) {
  let guildDiscordId;
  let serverContext;
  if (systemAuthorizedInternalServerId !== null) {
    serverContext = await db.get(
      `SELECT s.id, s.guild_id, s.platform, g.discord_guild_id
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
       WHERE s.id = ?
         AND CAST(s.platform_server_id AS TEXT) = ?
         AND s.status = 'active'
         AND g.status = 'approved'`,
      [systemAuthorizedInternalServerId, String(serverId)]
    );
    if (!serverContext) {
      throw new Error(`Unable to resolve exact server context for ${serverId}`);
    }
    guildDiscordId = serverContext.discord_guild_id;
    internalServerId = serverContext.id;
  } else {
    guildDiscordId = await resolveGuildDiscordId(db, userId, serverId);
  }
  const serverDir = guildDiscordId
    ? getGuildDownloadPath(guildDiscordId, serverId)
    : null;

  const baseDir = serverDir ? require('path').join(serverDir, 'config') : null;

  if (!baseDir || !fs.existsSync(baseDir)) {
    console.log(`  ⚠️ No log directory found for server ${serverId}: ${baseDir}`);
    return null;
  }

  if (!serverContext) {
    serverContext = await db.get(
      `SELECT s.id, s.guild_id, s.platform, g.discord_guild_id
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
       WHERE CAST(s.platform_server_id AS TEXT) = ?
         AND g.discord_guild_id = ?
         AND s.status = 'active'
         AND g.status = 'approved'
         AND (CAST(? AS BIGINT) IS NULL OR s.id = ?)
         AND NOT EXISTS (
           SELECT 1 FROM servers other
           WHERE CAST(other.platform_server_id AS TEXT) = CAST(s.platform_server_id AS TEXT)
             AND other.id <> s.id
         )
       LIMIT 1`,
      [String(serverId), String(guildDiscordId), internalServerId, internalServerId]
    );
  }
  if (!serverContext) {
    throw new Error(`Unable to resolve exact server context for ${serverId}`);
  }

  // Allocation precedes scan work. Failed/partial scans consume a generation
  // without publishing it and therefore cannot renew cache authority.
  const scanGeneration = await allocateOnlineCacheScanGeneration(db);

  // Resolve platform from provider metadata, the validated local path, or the
  // exact stored server row. Never persist parsed identities as "unknown".
  const platform = await resolveServerPlatform(db, token, serverId, {
    baseDir,
    internalServerId: serverContext.id,
  });

  // Use the exact authorized server context for kill-event Discord feeds.
  const guildId = serverContext.discord_guild_id;

  const maxAgeMs = fullHistory ? Infinity : 25 * 60 * 60 * 1000;
  const allAdmLogs = findAllLogFiles(baseDir, /\.ADM$/i, maxAgeMs, {
    excludedArtifactPattern: includeRptLogs ? null : /\.RPT$/i,
  });
  const allRptLogs = includeRptLogs
    ? findAllLogFiles(baseDir, /\.RPT$/i, maxAgeMs)
    : [];
  // Ensure deterministic oldest→newest processing by the log's own start
  // timestamp. Local mtimes reflect download order and can invert chronology
  // when several historical files are first synchronized concurrently.
  const chronologicalEntry = filePath => {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Invalid log file: ${filePath}`);
    return {
      name: path.basename(filePath),
      mtimeMs: stat.mtimeMs,
    };
  };
  allAdmLogs.sort((a, b) => compareLogFileEntries(chronologicalEntry(a), chronologicalEntry(b)));
  allRptLogs.sort((a, b) => compareLogFileEntries(chronologicalEntry(a), chronologicalEntry(b)));

  if (allAdmLogs.length === 0 && allRptLogs.length === 0) {
    console.log(`  ⚠️ No ADM/RPT log files found for server ${serverId}`);
    return null;
  }

  console.log(`  📁 Found ${allAdmLogs.length} ADM and ${allRptLogs.length} RPT log files for server ${serverId}`);

  const playerMap = new Map();
  const healthUpdatesMap = new Map();
  const failedLogFiles = [];
  let totalKillsSaved = 0;
  let latestSourceObservedAt = null;

  // Tracks current online state across ALL ADM files in chronological order.
  // Connect events add a player; disconnect events remove them.
  // After all files the remaining entries are the players currently online.
  const onlinePlayersMap = new Map();
  const sessionState = new Map();

  // Process ADM logs one at a time: parse → save → let GC reclaim memory
  for (let i = 0; i < allAdmLogs.length; i++) {
    const logPath = allAdmLogs[i];
    try {
      // Streaming single-pass parse for large ADM logs to avoid massive .split('\n') allocations
      const logDate = extractLogDateFromFilePath(logPath, baseDir);
      const streamed = await parseADMFileStream(logPath, logDate, {
        fullHistory,
        rootDir: baseDir,
        sessionState,
        includeActiveSessions: i === allAdmLogs.length - 1,
        platform,
      });
      if (streamed.sourceObservedAt && (!latestSourceObservedAt
          || new Date(streamed.sourceObservedAt) > new Date(latestSourceObservedAt))) {
        latestSourceObservedAt = streamed.sourceObservedAt;
      }

      // Maintain running online state using timestamps already resolved by the
      // streaming parser's file-wide midnight chronology cursor.
      updateOnlineState(streamed.onlineUpdates, onlinePlayersMap);

      // Merge players discovered in file
      const filePlayers = streamed.players || [];
      const filePlayerIds = new Set(filePlayers.map(p => p.platformUserId));

      // Add any killer/victim not captured by parseADMLog (connection events only)
      for (const evt of streamed.killEvents) {
        if (evt.killerPlatformUserId && !filePlayerIds.has(evt.killerPlatformUserId)) {
          filePlayers.push({ playerName: evt.killerGamertag, platformUserId: evt.killerPlatformUserId, dpnid: null, deviceId: null });
          filePlayerIds.add(evt.killerPlatformUserId);
        }
        if (evt.victimPlatformUserId && !filePlayerIds.has(evt.victimPlatformUserId)) {
          filePlayers.push({ playerName: evt.victimGamertag, platformUserId: evt.victimPlatformUserId, dpnid: null, deviceId: null });
          filePlayerIds.add(evt.victimPlatformUserId);
        }
      }

      filePlayers.forEach(player => {
        const key = (player.playerName || player.platformUserId || '').toLowerCase();
        if (!playerMap.has(key)) playerMap.set(key, player);
      });

      // Ensure identity records exist for all participants BEFORE saving events.
      await savePlayersToDatabase(db, userId, serverId, filePlayers, platform, serverContext.id);

      // Merge health updates
      for (const h of streamed.healthUpdates) {
        const existing = healthUpdatesMap.get(h.platformUserId);
        if (!existing || new Date(h.timestamp) > new Date(existing.timestamp)) {
          healthUpdatesMap.set(h.platformUserId, h);
        }
      }

      // Save parsed event groups against the exact resolved server row.
      await saveSessions(db, serverId, streamed.sessions || [], platform, serverContext.id);
      await saveDamageEvents(db, serverId, streamed.damageEvents || [], platform, serverContext.id);
      totalKillsSaved += await saveKillEvents(db, serverId, streamed.killEvents || [], platform, guildId, serverContext.id);
      await saveTerritoryEvents(db, serverId, streamed.territoryEvents || [], platform, serverContext.id);
      await saveDeathEvents(db, serverId, streamed.deathEvents || [], platform, serverContext.id);
      await saveUnconsciousEvents(db, serverId, streamed.unconsciousEvents || [], platform, serverContext.id);
      await saveRespawnEvents(db, serverId, streamed.respawnEvents || [], platform, serverContext.id);
      await saveDisconnectPositions(db, serverId, streamed.disconnectPositions || [], platform, serverContext.id);
      const positionSnapshots = sourceObservedLogFile
        && path.resolve(logPath) === path.resolve(sourceObservedLogFile)
        ? normalizeLatestAdmPositionTimestamps(
          streamed.positionSnapshots || [],
          streamed.sourceObservedAt,
          sourceObservedAt
        )
        : streamed.positionSnapshots || [];
      await savePositionSnapshots(db, serverId, positionSnapshots, platform, serverContext.id);
      const emoteEvents = sourceObservedLogFile
        && path.resolve(logPath) === path.resolve(sourceObservedLogFile)
        ? normalizeLatestAdmPositionTimestamps(
          streamed.emoteEvents || [],
          streamed.sourceObservedAt,
          sourceObservedAt
        )
        : streamed.emoteEvents || [];
      await saveEmoteEvents(db, serverId, emoteEvents, platform, serverContext.id);
    } catch (err) {
      console.error(`  ❌ Error reading ${logPath}:`, err.message);
      failedLogFiles.push(path.basename(logPath));
    }
  }

  // Parse RPT logs: extract players AND cleanup (despawn) events and save them
  let totalCleanupSaved = 0;
  for (const logPath of allRptLogs) {
    try {
      let rptLog = readLogFileSafely(logPath, { fullHistory, rootDir: baseDir });
      const rptLines = rptLog.split('\n'); // split once; pass array to parseRPTLog
      rptLog = null; // free the raw string before iterating

      // Merge player identity info from RPT
      parseRPTLog(rptLines, platform).forEach(player => {
        const key = (player.playerName || player.platformUserId || '').toLowerCase();
        if (playerMap.has(key)) {
          playerMap.get(key).deviceId = player.deviceId || playerMap.get(key).deviceId;
        } else {
          playerMap.set(key, player);
        }
      });

      // Parse cleanup/despawn events and persist them so loot despawn pipeline is populated
      try {
        const rptDate = extractRPTLogDate(logPath, baseDir);
        const cleanups = parseCleanupEvents(rptLines, rptDate);
        if (cleanups && cleanups.length > 0) {
          const saved = await saveCleanupEvents(db, serverId, cleanups, serverContext.id);
          totalCleanupSaved += saved || 0;
          console.log(`  ✓ ${path.basename(logPath)}: ${cleanups.length} cleanup events (${saved} new)`);
        }
      } catch (cleanupErr) {
        console.error(`  ❌ Error parsing/saving cleanup events for ${logPath}:`, cleanupErr.message);
        failedLogFiles.push(path.basename(logPath));
      }

    } catch (err) {
      console.error(`  ❌ Error reading ${logPath}:`, err.message);
      failedLogFiles.push(path.basename(logPath));
    }
  }

  if (failedLogFiles.length > 0) {
    throw new Error(`Failed to parse ${new Set(failedLogFiles).size} ADM/RPT log file(s)`);
  }

  const players = Array.from(playerMap.values());
  if (totalCleanupSaved > 0) console.log(`  ✅ Saved ${totalCleanupSaved} total cleanup events for server ${serverId}`);
  const allHealthUpdates = Array.from(healthUpdatesMap.values());

  await savePlayersToDatabase(db, userId, serverId, players, platform, serverContext.id);
  await refreshPlayerServerActivity(db, serverId, serverContext.id);
  await saveHealthUpdates(db, serverId, allHealthUpdates, platform, serverContext.id);

  // Update online player cache using the accumulated state across all log files.
  // This correctly handles players who connected in an earlier log file and are
  // still online — they won't have a connect event in the last file, so
  // looking only at the last file would miss them.
  const onlineCachePublished = await updateOnlineCache(
    db,
    serverId,
    Array.from(onlinePlayersMap.values()),
    platform,
    serverContext.id,
    normalizeSourceObservedAt(latestSourceObservedAt, sourceObservedAt),
    scanGeneration
  );

  if (onlineCachePublished) {
    await db.transaction(transactionDb => markTeleportArrivals(transactionDb, serverContext.id));
    const cleanupOutcomes = await processTeleportCleanups(db, serverContext.id);
    for (const outcome of cleanupOutcomes.filter(item => item.status === 'retry')) {
      console.error(`  ❌ Teleport cleanup ${outcome.id} remains queued: ${outcome.error}`);
    }

    const teleportOutcomes = await processWaitingTeleports(db, serverContext.id);
    for (const outcome of teleportOutcomes.filter(item => item.status === 'retry')) {
      console.error(`  ❌ Teleport request ${outcome.id} remains queued: ${outcome.error}`);
    }
  }

  return {
    players: players.length,
    totalPlayers: players.length,
    killEvents: totalKillsSaved,
    onlineCachePublished,
    filesScanned: { admCount: allAdmLogs.length, rptCount: allRptLogs.length }
  };
}

module.exports = router;
module.exports.scanLogsForServer = scanLogsForServer;
module.exports.allocateOnlineCacheScanGeneration = allocateOnlineCacheScanGeneration;
module.exports.updateOnlineCache = updateOnlineCache;
module.exports.normalizeSourceObservedAt = normalizeSourceObservedAt;
module.exports.normalizeLatestAdmPositionTimestamps = normalizeLatestAdmPositionTimestamps;
module.exports.findLogFile = findLogFile;
module.exports.findAllLogFiles = findAllLogFiles;
module.exports.streamLogLines = streamLogLines;
module.exports.extractLogDateFromFilePath = extractLogDateFromFilePath;
module.exports.extractRPTLogDate = extractRPTLogDate;
module.exports.parseADMLog = parseADMLog;
module.exports.parseADMFileStream = parseADMFileStream;
module.exports.normalizeParsedEventIdentities = normalizeParsedEventIdentities;
module.exports.resolveServerPlatform = resolveServerPlatform;
module.exports.parseCombatEvents = parseCombatEvents;
module.exports.saveKillEvents = saveKillEvents;
module.exports.saveDisconnectPositions = saveDisconnectPositions;
module.exports.saveSessions = saveSessions;
module.exports.saveCleanupEvents = saveCleanupEvents;
module.exports.savePositionSnapshots = savePositionSnapshots;
module.exports.saveDamageEvents = saveDamageEvents;
module.exports.saveTerritoryEvents = saveTerritoryEvents;
module.exports.saveEmoteEvents = saveEmoteEvents;
