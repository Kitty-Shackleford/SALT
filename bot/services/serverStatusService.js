/*
 * serverStatusService.js
 *
 * Fetches live DayZ server data from Nitrado and updates Discord channels:
 *   - Edits a pinned embed in a text channel with server info and settings
 *   - Renames two voice channels to show player count and restart time
 *
 * Called from bot/events/ready.js via startLoop(client).
 */

/* eslint-disable */
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const axios = require('../../utils/nitradoHttp');
const { nitradoFetch, getNitradoTextBody, getNitradoTransferToken, resolveMissionBasePath } = require('../../utils/nitradoHttp');
const fetch = nitradoFetch;
const { EmbedBuilder } = require('discord.js');
const xml2js = require('xml2js');
const ftp = require('basic-ftp');
const pool = require('../db');
const { decryptToken } = require('../../utils/encryption');
const { detectDayzPlatform, platformDataDirectory } = require('../../utils/dayzPlatform');

const { toNitradoFtpPath } = require('../utils/nitrado');
const { createNitradoService } = require('../../services/nitradoService');
/* eslint-disable no-unused-vars, require-atomic-updates, no-inner-declarations, no-irregular-whitespace */

const nitradoService = createNitradoService();

let tokenBindingBackfillComplete = false;

async function backfillLegacyNitradoTokenBindings() {
  if (tokenBindingBackfillComplete) return;

  const result = await pool.query(
    `SELECT id, token_hash
     FROM guild_tokens
     WHERE token_type = 'nitrado' AND nitrado_user_id IS NULL`
  );
  let transientFailure = false;
  const verified = [];
  for (const row of result.rows) {
    try {
      const { id: nitradoUserId } = await nitradoService.getAuthenticatedUser(decryptToken(row.token_hash));
      verified.push({ rowId: row.id, nitradoUserId });
    } catch (error) {
      transientFailure = true;
      console.error('❌ Could not verify a legacy Nitrado token binding:', error.message);
    }
  }

  const byIdentity = new Map();
  for (const binding of verified) {
    const group = byIdentity.get(binding.nitradoUserId) || [];
    group.push(binding);
    byIdentity.set(binding.nitradoUserId, group);
  }

  for (const bindings of byIdentity.values()) {
    if (bindings.length !== 1) {
      console.error('❌ Duplicate legacy Nitrado ownership detected; all conflicting tokens remain disabled');
      continue;
    }
    const binding = bindings[0];
    try {
      await pool.query(
        `UPDATE guild_tokens
         SET nitrado_user_id = $1
         WHERE id = $2 AND nitrado_user_id IS NULL`,
        [binding.nitradoUserId, binding.rowId]
      );
    } catch (error) {
      if (error.code === '23505') {
        console.error('❌ Nitrado account is already bound to another Discord guild; legacy token remains disabled');
      } else {
        transientFailure = true;
        console.error('❌ Could not persist a legacy Nitrado token binding:', error.message);
      }
    }
  }
  tokenBindingBackfillComplete = !transientFailure;
}

// Sanitize a string for use as a filesystem path component.
function sanitizeFilename(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

// Returns the local path where log sync stores downloaded files for a server.
// Must match the path structure in services/logSyncService.js.
function getGuildDownloadPath(guildDiscordId, serverId) {
  const basePath = path.join(__dirname, '..', '..', 'downloads');
  return path.join(basePath, sanitizeFilename(guildDiscordId), `server_${serverId}`);
}

// Full provider/status refresh cadence. Voice-channel names are intentionally
// kept on this conservative interval because Discord rate-limits renames.
const UPDATE_INTERVAL_MS = 5 * 60 * 1000;
// Fresh ADM publication is tracked in PostgreSQL by the backend scanner. Poll
// that cheap local marker so player names reach the status embed promptly;
// provider reads occur only when a published cache generation actually changes.
const CACHE_REFRESH_INTERVAL_MS = 30 * 1000;

function selectChangedOnlineCacheRows(previousGenerations, rows = []) {
  return rows.filter(row => previousGenerations.get(String(row.server_db_id))
    !== String(row.scan_generation || '0'));
}

async function applyChangedOnlineCacheRows(previousGenerations, rows, updateRow, onError = () => {}) {
  const changedRows = selectChangedOnlineCacheRows(previousGenerations, rows);
  for (const row of changedRows) {
    try {
      if (await updateRow(row)) {
        previousGenerations.set(
          String(row.server_db_id), String(row.scan_generation || '0')
        );
      }
    } catch (error) {
      onError(error, row);
    }
  }
}

// DayZ day/night duration formula (Bohemia Interactive wiki):
//   realDayHrs   = DAY_HOURS / serverTimeAcceleration
//   realNightHrs = NIGHT_HOURS / (serverTimeAcceleration × serverNightTimeAcceleration)
//
// serverNightTimeAcceleration stacks ON TOP of serverTimeAcceleration during night —
// the wiki calls the combined value the "effective" night speed.
// e.g. dayMult=2, nightMult=4 → effective night = 8× faster.
//
// The 12/12 split is DayZ's approximate default; actual hours vary by in-game season.
// Estimates shown in the embed should be treated as approximations.
// Ref: https://community.bistudio.com/wiki/DayZ:Server_Configuration
const DAY_HOURS = 12;
const NIGHT_HOURS = 12;

// Tracks whether an update cycle is already running to prevent overlap.
let updateRunning = false;
const lastOnlineCacheGenerations = new Map();
const statusRenderCache = new Map();

/**
 * Fetches gameserver data from Nitrado.
 * Returns the full `data.gameserver` object, or null on failure.
 */
async function fetchServerData(token, platformServerId) {
  try {
    return await nitradoService.getRawGameserver(token, platformServerId);
  } catch (err) {
    console.error(`❌ fetchServerData error (server ${platformServerId}):`, err.message);
    return null;
  }
}

/**
 * Formats a remaining-time ms value as "Xh Ym" or "Ym" countdown.
 * Returns "Restarting…" when the deadline just passed (within the 30-min reboot window).
 * Returns null when the data is too stale to be useful (>30 min past).
 */
function formatRestartLabel(remainingMs) {
  // If the deadline passed more than 30 minutes ago, data is stale — caller shows "Unknown".
  if (remainingMs < -(30 * 60 * 1000)) return null;
  // Within the 30-min reboot window: server is cycling, show a friendly status.
  if (remainingMs <= 0) return 'Restarting…';
  const totalMins = Math.round(remainingMs / 60000);
  const hrs  = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

function formatRestartChannelName(restartAtMs, fallbackLabel = null) {
  if (!Number.isFinite(restartAtMs)) return '🔄 Restart: Unknown';
  return `🔄 Restart: ${fallbackLabel || 'Unknown'}`;
}

function formatRestartEmbedLabel(restartAtMs, fallbackLabel) {
  if (!Number.isFinite(restartAtMs) || restartAtMs <= Date.now()) {
    return fallbackLabel || 'Unknown';
  }
  const epochSeconds = Math.floor(restartAtMs / 1000);
  return `<t:${epochSeconds}:t> • <t:${epochSeconds}:R>`;
}

/**
 * Parses a Nitrado cron field (e.g. "*", "*\/4", "0,6,12,18") into an array
 * of matching integer values within [min, max].
 * Returns null if the field is unparseable.
 */
function parseCronField(field, min, max) {
  if (!field || field === '*') {
    return Array.from({ length: max - min + 1 }, (_, i) => i + min);
  }
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (isNaN(step) || step <= 0) return null;
    const values = [];
    for (let v = min; v <= max; v += step) values.push(v);
    return values;
  }
  // Comma-separated list or single value
  const parts = field.split(',').map(p => parseInt(p.trim(), 10));
  if (parts.some(isNaN)) return null;
  return parts.filter(v => v >= min && v <= max);
}

/**
 * Computes the next UTC occurrence (ms) of a cron task, looking up to 48 hours ahead.
 * Nitrado tasks store the schedule as individual cron fields: minute, hour, day, month, weekday.
 */
function getNextCronOccurrenceMs(task) {
  const minutes  = parseCronField(String(task.minute  ?? '*'), 0, 59);
  const hours    = parseCronField(String(task.hour    ?? '*'), 0, 23);
  if (!minutes || !hours || minutes.length === 0 || hours.length === 0) return null;

  const now = new Date();
  // Step forward minute-by-minute (up to 48 h) to find the first matching slot.
  for (let offsetMins = 1; offsetMins <= 48 * 60; offsetMins++) {
    const candidate = new Date(now.getTime() + offsetMins * 60 * 1000);
    if (hours.includes(candidate.getUTCHours()) && minutes.includes(candidate.getUTCMinutes())) {
      // Snap to the exact start of that minute.
      candidate.setUTCSeconds(0, 0);
      return candidate.getTime();
    }
  }
  return null;
}

/**
 * Attempts to get the next scheduled restart from Nitrado tasks.
 * Nitrado tasks use cron-style fields (minute, hour, day, month, weekday) — NOT a "time" datetime.
 * Returns { label, restartAtMs } or null if no upcoming restart is found.
 */
async function fetchNextRestart(token, platformServerId) {
  try {
    const tasks = await nitradoService.listTasks(token, platformServerId);

    const now = Date.now();
    const upcoming = tasks
      .filter(t => t.action_method === 'game_server_restart')
      .map(t => ({ ...t, nextMs: getNextCronOccurrenceMs(t) }))
      .filter(t => t.nextMs !== null && t.nextMs > now)
      .sort((a, b) => a.nextMs - b.nextMs);

    if (upcoming.length === 0) return null;

    const restartAtMs = upcoming[0].nextMs;
    return { label: formatRestartLabel(restartAtMs - now), restartAtMs };
  } catch (err) {
    console.error(`❌ fetchNextRestart error (server ${platformServerId}):`, err.message);
    return null;
  }
}

async function downloadNitradoFileViaFtp(ftpCreds, filePath) {
  if (!ftpCreds?.hostname || !ftpCreds?.username || !ftpCreds?.password) return null;

  const client = new ftp.Client();
  client.ftp.verbose = false;
  const ftpPath = toNitradoFtpPath(filePath);

  try {
    await client.access({
      host: ftpCreds.hostname,
      port: ftpCreds.port ?? 21,
      user: ftpCreds.username,
      password: ftpCreds.password,
      secure: false,
    });
    const chunks = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    await client.downloadTo(sink, ftpPath);
    console.log(`✅ downloadNitradoFileViaFtp: downloaded ${ftpPath}`);
    return Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    console.warn(`⚠️  downloadNitradoFileViaFtp: ${ftpPath} — ${err.message}`);
    return null;
  } finally {
    client.close();
  }
}

/**
 * Downloads a file from Nitrado, falling back to FTP when the file-server API
 * is unavailable. Returns its text content, or null on failure.
 */
async function downloadNitradoFile(token, platformServerId, filePath, ftpCreds = null) {
  const tryFtp = () => downloadNitradoFileViaFtp(ftpCreds, filePath);
  try {
    const tokenRes = await axios.get(
      `https://api.nitrado.net/services/${platformServerId}/gameservers/file_server/download?file=${encodeURIComponent(filePath)}`,
      { headers: { Authorization: 'Bearer ' + token }, timeout: 10000 }
    );
    const { url: downloadUrl } = getNitradoTransferToken(tokenRes);

    const fileRes = await axios.get(downloadUrl, { timeout: 15000, responseType: 'text' });
    return getNitradoTextBody(fileRes);
  } catch (err) {
    console.error(`❌ downloadNitradoFile error for ${filePath}:`, err.message);
    return tryFtp();
  }
}

/**
 * Parses cfgeconomycore.xml to find the folder and filename for the messages file.
 * DayZ servers can place messages.xml in a custom folder declared in cfgeconomycore.xml.
 * Returns a path relative to the mission folder, e.g. "custom/messages.xml".
 * Falls back to "db/messages.xml" or "custom/messages.xml" if the core file is malformed.
 */
async function resolveMessagesXmlPath(token, platformServerId, missionFolder, missionBasePath, ftpCreds) {
  const DEFAULT_PATH = 'db/messages.xml';
  const CUSTOM_FALLBACK = 'custom/messages.xml';

  try {
    const cfgPath = `${missionBasePath}/${missionFolder}/cfgeconomycore.xml`;
    let content = await downloadNitradoFile(token, platformServerId, cfgPath, ftpCreds);
    if (!content) {
      console.log(`ℹ️  resolveMessagesXmlPath: cfgeconomycore.xml not found, trying ${CUSTOM_FALLBACK}`);
      return CUSTOM_FALLBACK;
    }

    // Try to clean up common XML issues
    content = content.trim().replace(/[\r\n]+/g, '\n');

    const parsed = await xml2js.parseStringPromise(content);
    const ceEntries = parsed?.economycore?.ce || [];

    if (ceEntries.length === 0) {
      console.log(`ℹ️  resolveMessagesXmlPath: no <ce> entries in cfgeconomycore.xml, trying ${CUSTOM_FALLBACK}`);
      return CUSTOM_FALLBACK;
    }

    for (const ce of ceEntries) {
      const folder = ce?.$?.folder || '';
      const files = ce?.file || [];
      for (const file of files) {
        if (file?.$?.type === 'messages') {
          const name = file?.$?.name || 'messages.xml';
          const result = folder ? `${folder}/${name}` : name;
          console.log(`✅ resolveMessagesXmlPath: found custom messages path: ${result}`);
          return result;
        }
      }
    }
    console.log(`ℹ️  resolveMessagesXmlPath: no messages entry found, trying ${CUSTOM_FALLBACK}`);
  } catch (err) {
    console.warn(`⚠️  resolveMessagesXmlPath: error parsing cfgeconomycore.xml at line ${err.location?.line}:${err.location?.column} — ${err.message}`);
    console.log(`   Fallback: trying ${CUSTOM_FALLBACK}`);
  }
  return CUSTOM_FALLBACK;
}

/**
 * Finds the most recent locally-downloaded RPT file for a server and parses its
 * filename to determine when the server last started.
 *
 * RPT filenames encode the start datetime: DayZServer_X1_x64_YYYY-MM-DD_HH-MM-SS.RPT
 * Log sync downloads these files into: downloads/{guildDiscordId}/server_{platformServerId}/config/
 *
 * Returns the server start time in ms since epoch, or null if no RPT file is found.
 */
const RPT_TIMESTAMP_REGEX = /(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.RPT$/i;

function parseRptStartMs(filename) {
  const match = String(filename || '').match(RPT_TIMESTAMP_REGEX);
  if (!match) return null;
  const isoString = `${match[1]}T${match[2].replace(/-/g, ':')}Z`;
  const startMs = new Date(isoString).getTime();
  return isNaN(startMs) ? null : startMs;
}

function selectNewestRptStartMs(filenames) {
  const startTimes = filenames.map(parseRptStartMs).filter(Number.isFinite);
  return startTimes.length > 0 ? Math.max(...startTimes) : null;
}

function getServerStartTimeFromLogs(guildDiscordId, platformServerId) {
  try {
    const serverPath = getGuildDownloadPath(guildDiscordId, platformServerId);
    const configPath = path.join(serverPath, 'config');
    if (!fs.existsSync(configPath)) return null;

    return selectNewestRptStartMs(fs.readdirSync(configPath));
  } catch {
    return null;
  }
}

/**
 * Tails the last `tailBytes` of `server.log` via FTP and searches for the
 * most recent `[Shutdown] Shutting down in X seconds` line belonging to the
 * current server session (i.e., after the last "Connected to BIOS" line).
 *
 * DayZ appends shutdown warnings every ~60 s starting 90 min before restart:
 *   "HH:MM:SS [Shutdown] Shutting down in 300 seconds (5 minutes)."
 *
 * When found, returns the Unix ms timestamp of the predicted shutdown:
 *   shutdownAtMs = lineEpochMs + remainingSeconds * 1000
 *
 * `serverStartMs` is used to anchor the time-only HH:MM:SS values to a calendar
 * date (Nitrado servers run in UTC).  Midnight-rollover (log line crosses day
 * boundary after the server started) is handled automatically.
 *
 * Returns null if FTP credentials are missing, server.log is unreachable, or
 * no current-session [Shutdown] line is present yet (< 90 min into session).
 */
async function parseShutdownFromFtp(ftpCreds, serverStartMs, platform, game) {
  if (!ftpCreds?.hostname || !ftpCreds?.username || !ftpCreds?.password) return null;

  const TAIL_BYTES  = 512 * 1024; // 512 KB — enough for ~90 min of dense log output
  const dataDirectory = platformDataDirectory(platform, game);
  if (!dataDirectory) return null;
  const configDirectory = `/${dataDirectory}/config`;
  const SERVER_LOG  = `${configDirectory}/server.log`;

  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    await client.access({
      host:     ftpCreds.hostname,
      port:     ftpCreds.port ?? 21,
      user:     ftpCreds.username,
      password: ftpCreds.password,
      secure:   false,
    });

    // Get file size so we can compute the byte offset for the tail.
    const list = await client.list(configDirectory);
    const entry = list.find(e => e.name === 'server.log');
    if (!entry) {
      console.log('ℹ️  parseShutdownFromFtp: server.log not found in FTP listing');
      return null;
    }

    const fileSize   = entry.size;
    const startByte  = Math.max(0, fileSize - TAIL_BYTES);

    // Download the tail into an in-memory buffer.
    const chunks = [];
    const sink   = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    await client.downloadTo(sink, SERVER_LOG, startByte);
    const tail = Buffer.concat(chunks).toString('utf8');

    // Split into lines and find the last "Connected to BIOS" marker (start of
    // the current session) then look for [Shutdown] lines after it.
    const lines = tail.split('\n');
    let sessionStart = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('Connected to BIOS')) { sessionStart = i; break; }
    }
    // Search for [Shutdown] lines in current session (or full tail if no BIOS line found)
    const searchFrom = sessionStart >= 0 ? sessionStart : 0;

    const SHUTDOWN_RE = /^\s*(\d+:\d{2}:\d{2})\s+\[Shutdown\]\s+Shutting down in (\d+) seconds/;
    let lastShutdownLine = null;
    for (let i = searchFrom; i < lines.length; i++) {
      if (SHUTDOWN_RE.test(lines[i])) lastShutdownLine = lines[i];
    }

    if (!lastShutdownLine) return null;

    const m = lastShutdownLine.match(SHUTDOWN_RE);
    const [hStr, minStr, secStr] = m[1].split(':');
    const remainingSecs = parseInt(m[2], 10);

    // Convert HH:MM:SS to ms-since-epoch using serverStartMs as the date anchor.
    // The log resets the day counter on server start, so we use the server-start date.
    const startDate = new Date(serverStartMs);
    const logH   = parseInt(hStr,   10);
    const logMin = parseInt(minStr, 10);
    const logS   = parseInt(secStr, 10);

    // Build the log-line timestamp (UTC).
    let lineEpochMs = Date.UTC(
      startDate.getUTCFullYear(),
      startDate.getUTCMonth(),
      startDate.getUTCDate(),
      logH, logMin, logS
    );

    // Handle midnight rollover: if the computed timestamp is before serverStartMs,
    // the line belongs to the next calendar day.
    if (lineEpochMs < serverStartMs) lineEpochMs += 24 * 60 * 60 * 1000;

    // Reject [Shutdown] lines that predate the current server boot — these belong
    // to a previous session that's still in the tail because no BIOS line was found.
    if (lineEpochMs < serverStartMs) {
      console.log(`ℹ️  parseShutdownFromFtp: [Shutdown] line (${m[1]}) predates current boot — ignoring (previous session)`);
      return null;
    }

    const shutdownAtMs = lineEpochMs + remainingSecs * 1000;
    console.log(`✅ parseShutdownFromFtp: last [Shutdown] line="${m[1]}", remaining=${remainingSecs}s → shutdown at ${new Date(shutdownAtMs).toISOString()}`);
    return shutdownAtMs;

  } catch (err) {
    console.warn(`⚠️  parseShutdownFromFtp: ${err.message}`);
    return null;
  } finally {
    client.close();
  }
}

/**
 * Attempts to derive the next restart time from the DayZ native messages.xml schedule.
 *
 * DayZ's native restart system uses a <message> with <shutdown>1</shutdown> and a
 * <deadline> (minutes from server start) to schedule a restart.  We combine that with
 * the server start time derived from the newest local RPT file (falling back to
 * Nitrado's last_status_change) to compute the time remaining.
 *
 * Returns { label, restartAtMs } or null.
 */
async function fetchRestartFromXml(token, platformServerId, gameserver, guildDiscordId) {
  try {
    // Derive the mission folder from the gameserver settings.
    // Nitrado may return it as "dayzOffline.chernarusplus" or just the map name.
    const mission = gameserver?.settings?.config?.mission || gameserver?.query?.map;
    if (!mission) {
      console.warn(`⚠️  fetchRestartFromXml: no mission name found for server ${platformServerId}`);
      return null;
    }
    console.log(`🔍 fetchRestartFromXml: mission="${mission}" server=${platformServerId}`);

    // Resolve the platform-specific missions base path.
    const missionBasePath = resolveMissionBasePath(gameserver);

    const ftpCreds = gameserver?.credentials?.ftp;
    const messagesRelPath = await resolveMessagesXmlPath(token, platformServerId, mission, missionBasePath, ftpCreds);
    console.log(`🔍 fetchRestartFromXml: resolved messages path = ${messagesRelPath}`);

    const fullMessagesPath = `${missionBasePath}/${mission}/${messagesRelPath}`;
    const xmlContent = await downloadNitradoFile(token, platformServerId, fullMessagesPath, ftpCreds);
    if (!xmlContent) {
      console.warn(`⚠️  fetchRestartFromXml: could not download ${fullMessagesPath}`);
      return null;
    }

    const parsed = await xml2js.parseStringPromise(xmlContent);
    const messages = parsed?.messages?.message || [];
    console.log(`🔍 fetchRestartFromXml: found ${messages.length} messages in XML`);

    // Find the shutdown message with the highest deadline — the one that actually
    // triggers the server restart. Multiple warnings may appear before it.
    let deadlineMin = null;
    for (const msg of messages) {
      if (msg?.shutdown?.[0] === '1') {
        const raw = parseInt(msg?.deadline?.[0], 10);
        if (!isNaN(raw) && raw > 0) {
          if (deadlineMin === null || raw > deadlineMin) deadlineMin = raw;
        }
      }
    }
    if (deadlineMin === null) {
      console.warn(`⚠️  fetchRestartFromXml: no shutdown message found in ${messagesRelPath}`);
      return null;
    }
    console.log(`🔍 fetchRestartFromXml: shutdown deadline = ${deadlineMin} min`);

    // Helper to parse last_status_change into epoch ms.
    function parseLastStatusChange(lastChange) {
      if (!lastChange) return null;
      let ms;
      if (typeof lastChange === 'number') {
        ms = lastChange < 1e12 ? lastChange * 1000 : lastChange;
      } else {
        ms = new Date(lastChange).getTime();
      }
      return isNaN(ms) ? null : ms;
    }

    // Try RPT log first (most accurate — encoded in the filename at boot time).
    let serverStartMs = getServerStartTimeFromLogs(guildDiscordId, platformServerId);
    let startSource = 'RPT log';

    if (serverStartMs) {
      // Sanity-check: if the RPT-computed restart time is already in the past, the log
      // is stale (from a previous cycle that has already completed). Discard it and fall
      // through to last_status_change so we compute from the current boot.
      const rptRestartAtMs = serverStartMs + deadlineMin * 60 * 1000;
      if (rptRestartAtMs <= Date.now()) {
        console.log(`⚠️  fetchRestartFromXml: RPT log is stale (restart was ${new Date(rptRestartAtMs).toISOString()}, already past) — falling back to last_status_change`);
        serverStartMs = null;
      }
    }

    // Fall back to Nitrado's last_status_change if RPT logs are unavailable or stale.
    if (!serverStartMs) {
      const lastChange = gameserver?.last_status_change;
      const fallbackMs = parseLastStatusChange(lastChange);
      if (!fallbackMs) {
        console.warn(`⚠️  fetchRestartFromXml: no server start time available (no RPT logs, no last_status_change)`);
        return null;
      }
      serverStartMs = fallbackMs;
      startSource = 'last_status_change';
    }

    const restartAtMs = serverStartMs + deadlineMin * 60 * 1000;
    let   finalRestartMs = restartAtMs;

    // If server.log [Shutdown] lines are available via FTP, they give a more precise
    // shutdown time than last_status_change + deadline (accurate to the second once
    // warnings appear, vs. ~2 min drift from the deadline estimate).
    // Only trust the FTP result if it's in the future and plausible (within ±20 min
    // of the deadline-based estimate — guards against log stale-data bugs).
    if (ftpCreds && serverStartMs) {
      const ftpShutdownMs = await parseShutdownFromFtp(
        ftpCreds,
        serverStartMs,
        detectDayzPlatform(gameserver),
        gameserver?.game
      );
      if (ftpShutdownMs && ftpShutdownMs > Date.now()) {
        const driftMs = Math.abs(ftpShutdownMs - restartAtMs);
        if (driftMs < 20 * 60 * 1000) {
          console.log(`✅ fetchRestartFromXml: using FTP [Shutdown] time (${Math.round(driftMs/1000)}s delta from deadline estimate)`);
          finalRestartMs = ftpShutdownMs;
        } else {
          console.warn(`⚠️  fetchRestartFromXml: FTP shutdown time is ${Math.round(driftMs/60000)}m off from deadline estimate — ignoring`);
        }
      }
    }

    const remainingMs = finalRestartMs - Date.now();
    const label = formatRestartLabel(remainingMs);
    console.log(`✅ fetchRestartFromXml: start=${new Date(serverStartMs).toISOString()} (${startSource}), restart=${new Date(finalRestartMs).toISOString()}, remaining=${Math.round(remainingMs/60000)}m, label="${label}"`);

    // null label means data is too stale (>30 min past deadline) — signal no result.
    if (label === null) return null;
    return { label, restartAtMs: finalRestartMs };
  } catch (err) {
    console.error(`❌ fetchRestartFromXml error (server ${platformServerId}):`, err.message);
    return null;
  }
}

/**
 * Derives a human-readable server name from the Nitrado gameserver object.
 * Hostname/query.server_name are intentionally garbled (\u0001 chars) by some
 * operators to appear first in the server browser — never use those for display.
 * Falls back through: DB name → description first segment → game_human.
 */
function resolveServerName(dbName, gameserver) {
  if (dbName && dbName !== 'Unknown Server' && dbName.trim().length > 0) {
    return dbName;
  }
  // Parse the first segment of the description (e.g. "Server: SALT || No Alts || ...")
  const desc = gameserver?.settings?.config?.description || '';
  if (desc) {
    const first = desc.split('||')[0].trim();
    if (first.length > 0 && first.length < 50) return first;
  }
  return gameserver?.game_human || 'DayZ Server';
}

/**
 * Formats a flag setting as a colored emoji.
 * `value` is the raw Nitrado string ("0", "1", "true", "false").
 * `invertLogic` flips the meaning (e.g. "disable3rdPerson":"0" means 3rd person IS enabled).
 */
function flag(value, invertLogic = false) {
  const truthy = value === '1' || value === 'true';
  const enabled = invertLogic ? !truthy : truthy;
  return enabled ? '✅' : '❌';
}

/**
 * Fetches currently online players from the server_online_cache table.
 * This cache is written by the log scanner at the end of each ADM log scan,
 * reflecting only players who were connected at the end of the most recent log.
 * Returns an array of { gamertag, login_at, updated_at } objects.
 */
async function fetchOnlinePlayers(serverDbId, platformServerId = null) {
  try {
    const res = await pool.query(
      `SELECT cache.gamertag, cache.login_at, cache.updated_at
       FROM server_online_cache cache
       JOIN server_online_cache_snapshots snapshot
         ON snapshot.server_id = cache.server_id
       WHERE cache.server_id = $1
         AND snapshot.source_observed_at >= clock_timestamp() - INTERVAL '120 minutes'
         AND snapshot.source_observed_at <= clock_timestamp() + INTERVAL '5 minutes'
       ORDER BY cache.login_at ASC`,
      [serverDbId]
    );

    const count = res.rows.length;
    if (count > 0) {
      const lastUpdate = res.rows[0].updated_at;
      console.log(`✅ fetchOnlinePlayers(server_db_id=${serverDbId}): found ${count} player(s), last cache update: ${lastUpdate}`);
    } else {
      console.log(`⚠️  fetchOnlinePlayers(server_db_id=${serverDbId}): no player names backed by fresh log evidence`);
    }

    return res.rows;
  } catch (err) {
    console.error(`❌ fetchOnlinePlayers(server_db_id=${serverDbId}) error:`, err.message);
    return [];
  }
}

/**
 * Builds the Discord embed for the status channel.
 * Shows online players with session details.
 * onlinePlayers: array of { gamertag, login_at, updated_at } from fetchOnlinePlayers()
 */
function buildEmbed(serverName, gameserver, restartLabel, onlinePlayers = [], lastLogSyncTime = null, nextLogSyncTime = null, restartAtMs = null) {
  const query = gameserver.query || {};
  const cfg = gameserver.settings?.config || {};
  const status = gameserver.status === 'started' ? 'Online' : 'Offline';

  const dayMult = parseFloat(cfg.serverTimeAcceleration) || 1;
  const nightMult = parseFloat(cfg.serverNightTimeAcceleration) || 1;
  const nightEffective = dayMult * nightMult;
  const realDayHrs = (DAY_HOURS / dayMult).toFixed(1);
  const realNightHrs = (NIGHT_HOURS / nightEffective).toFixed(1);

  // Strip map prefix
  const mapRaw = query.map || '';
  const mapDisplay = mapRaw.includes('chernarus') ? 'Chernarus'
    : mapRaw.includes('livonia')   ? 'Livonia'
    : mapRaw.includes('namalsk')   ? 'Namalsk'
    : mapRaw.replace('dayzOffline.', '') || 'Unknown';

  const playerCurrent = typeof query.player_current === 'number' ? query.player_current : null;
  const playerMax = query.player_max ?? gameserver.slots ?? '?';
  const version = query.version || 'Unknown';

  const liveCount = playerCurrent ?? 0;
  const cacheCount = onlinePlayers.length;
  const displayCount = Math.max(liveCount, cacheCount);
  const restartDisplay = formatRestartEmbedLabel(restartAtMs, restartLabel);

  // Build footer with last sync time
  let footerText = 'Updated';
  if (lastLogSyncTime) {
    const lastSyncMs = typeof lastLogSyncTime === 'number' ? lastLogSyncTime : new Date(lastLogSyncTime).getTime();
    const minutesAgo = Math.round((Date.now() - lastSyncMs) / 60000);
    if (minutesAgo === 0) footerText += ': just now';
    else if (minutesAgo === 1) footerText += ': a minute ago';
    else footerText += `: ${minutesAgo} minutes ago`;
  }

  // Build last restart line
  let lastRestartLine = '';
  const lastChange = gameserver?.last_status_change;
  if (lastChange) {
    const secs = typeof lastChange === 'number'
      ? (lastChange < 1e12 ? lastChange : Math.floor(lastChange / 1000))
      : Math.floor(new Date(lastChange).getTime() / 1000);
    if (!isNaN(secs)) {
      lastRestartLine = `Last Restart <t:${secs}:R>`;
    }
  }

  // If we have player names, show them in a clean list format
  if (cacheCount > 0) {
    const playerList = onlinePlayers
      .map(p => p.gamertag)
      .sort()
      .join(',\n');

    return new EmbedBuilder()
      .setColor(gameserver.status === 'started' ? 0x57f287 : 0xed4245)
      .setTitle(`${serverName}`)
      .setDescription(`DayZ (Xbox One) • v${version}\n\n📋 Online List • ${displayCount} Players`)
      .addFields(
        {
          name: '\u200B',
          value: `${status}　　 ${liveCount} / ${playerMax}　　 ${mapDisplay}`,
          inline: false
        },
        {
          name: '─── Server Settings ───────────────────',
          value: [
            ` Day Speed　　　　${dayMult}× (~${realDayHrs} hrs)`,
            ` Night Speed　　　${nightEffective}× eff. (~${realNightHrs} hrs)`,
            `　　${dayMult}× day + ${nightMult}× night stacked — varies by season`,
            ` Darker Night　　 ${flag(cfg.lightingConfig)}`,
            ` Mouse & Keyboard ${flag(cfg.enableMouseAndKeyboard)}`,
            ` Crosshair　　　　${flag(cfg.disableCrosshair, true)}`,
            ` Third Person　　 ${flag(cfg.disable3rdPerson, true)}`,
            ` Whitelist　　　　${flag(cfg.enableWhitelist)}`
          ].join('\n'),
          inline: false
        },
        {
          name: '─── Next Restart ──────────────────────',
          value: [
            restartDisplay,
            lastRestartLine
          ].filter(Boolean).join('\n'),
          inline: false
        },
        {
          name: `─── Online Players ────────────`,
          value: playerList.slice(0, 2048) || '*No players online*',
          inline: false
        }
      )
      .setFooter({ text: footerText })
      .setTimestamp();
  }

  // Fallback if no player names are available yet
  return new EmbedBuilder()
    .setColor(gameserver.status === 'started' ? 0x57f287 : 0xed4245)
    .setTitle(`${serverName}`)
    .setDescription(`DayZ (Xbox One) • v${version}`)
    .addFields(
      {
        name: '\u200B',
        value: `${status}　　 ${liveCount} / ${playerMax}　　 ${mapDisplay}`,
        inline: false
      },
      {
        name: '─── Server Settings ───────────────────',
        value: [
          ` Day Speed　　　　${dayMult}× (~${realDayHrs} hrs)`,
          ` Night Speed　　　${nightEffective}× eff. (~${realNightHrs} hrs)`,
          `　　${dayMult}× day + ${nightMult}× night stacked — varies by season`,
          ` Darker Night　　 ${flag(cfg.lightingConfig)}`,
          ` Mouse & Keyboard ${flag(cfg.enableMouseAndKeyboard)}`,
          ` Crosshair　　　　${flag(cfg.disableCrosshair, true)}`,
          ` Third Person　　 ${flag(cfg.disable3rdPerson, true)}`,
          ` Whitelist　　　　${flag(cfg.enableWhitelist)}`
        ].join('\n'),
        inline: false
      },
      {
        name: '─── Next Restart ──────────────────────',
        value: [
          restartDisplay,
          lastRestartLine
        ].filter(Boolean).join('\n'),
        inline: false
      },
      {
        name: `─── Online Players (${displayCount}) ────────────`,
        value: liveCount > 0
          ? `*${liveCount} player${liveCount !== 1 ? 's' : ''} online — names unavailable — provider log evidence is delayed or stale*`
          : '*No players reported online*',
        inline: false
      }
    )
    .setFooter({ text: footerText })
    .setTimestamp();
}

// Tracks which (guildId + restartAtMs-minute-bucket) notifications have already been sent
// this process lifetime, to prevent spamming users on every poll cycle.
// Key: `${guildDiscordId}:${minuteBucket}`
const _notifiedBuckets = new Set();

/**
 * Sends DM notifications to all opted-in users for a guild if the next restart
 * is within their configured threshold.  Each restart-time bucket is only
 * notified once per process lifetime.
 */
async function sendRestartNotifications(client, guildDiscordId, serverId, serverName, restartAtMs) {
  try {
    const remainingMs = restartAtMs - Date.now();
    if (remainingMs < 0) return; // Restart already passed.

    // Fetch all enabled prefs for this guild.
    const prefsRes = await pool.query(
      `SELECT discord_user_id, minutes_before
         FROM restart_notify_prefs
        WHERE guild_id = $1 AND server_id = $2 AND enabled = TRUE`,
      [guildDiscordId, serverId]
    );
    if (prefsRes.rows.length === 0) return;

    const remainingMins = remainingMs / 60000;

    for (const pref of prefsRes.rows) {
      // Only notify if we're within the user's threshold.
      if (remainingMins > pref.minutes_before) continue;

      // Use a per-user bucket keyed to the restart time (rounded to minute)
      // so each user gets exactly one DM per restart event.
      const minuteBucket = Math.round(restartAtMs / 60000);
      const bucketKey    = `${guildDiscordId}:${serverId}:${pref.discord_user_id}:${minuteBucket}`;
      if (_notifiedBuckets.has(bucketKey)) continue;
      _notifiedBuckets.add(bucketKey);

      // Send the DM — errors are per-user and shouldn't stop others.
      try {
        const user = await client.users.fetch(pref.discord_user_id);
        const ts   = Math.floor(restartAtMs / 1000);
        await user.send(
          `⏰ **Server Restart Reminder**\n**${serverName || 'DayZ server'}** is restarting <t:${ts}:R> (<t:${ts}:t>).\n*To stop these DMs, use \`/notify-restart off\` for this server.*`
        );
      } catch {
        // User may have DMs disabled — silently skip.
      }
    }
  } catch (err) {
    console.error('❌ sendRestartNotifications error:', err.message);
  }
}

// Tracks which alerts have already fired for the current surge.
// Key: `${guildDiscordId}:${alertId}` — removed when count drops below threshold.
const _alertFired = new Map();

/**
 * Checks all enabled player count alerts for a guild and fires any that have
 * just crossed their threshold (low→high transition).
 *
 * @param {import('discord.js').Client} client
 * @param {string} guildDiscordId
 * @param {number} currentPlayers
 */
async function checkPlayerCountAlerts(client, guildDiscordId, serverId, currentPlayers) {
  try {
    const res = await require('../db').query(
      `SELECT id, threshold, channel_id, mention_target, mention_type
         FROM player_count_alerts
        WHERE guild_id = $1 AND server_id = $2 AND enabled = TRUE
        ORDER BY threshold ASC`,
      [guildDiscordId, serverId]
    );

    for (const alert of res.rows) {
      const key       = `${guildDiscordId}:${serverId}:${alert.id}`;
      const isAbove   = currentPlayers >= alert.threshold;
      const hasFired  = _alertFired.get(key) === true;

      if (isAbove && !hasFired) {
        // Threshold crossed upward — fire the alert.
        _alertFired.set(key, true);

        const mention = alert.mention_type === 'role'
          ? `<@&${alert.mention_target}>`
          : `<@${alert.mention_target}>`;

        try {
          const channel = await client.channels.fetch(alert.channel_id);
          if (channel && channel.guildId === guildDiscordId) {
            await channel.send({
              content: `🔔 ${mention} The server just hit **${currentPlayers} players** (threshold: ${alert.threshold})!`,
              allowedMentions: alert.mention_type === 'role'
                ? { roles: [alert.mention_target], users: [] }
                : { roles: [], users: [alert.mention_target] }
            });
          }
        } catch (err) {
          console.error(`❌ Alert #${alert.id} send error:`, err.message);
        }
      } else if (!isAbove && hasFired) {
        // Count dropped back below — reset so it can fire again next surge.
        _alertFired.delete(key);
      }
    }
  } catch (err) {
    console.error('❌ checkPlayerCountAlerts error:', err.message);
  }
}

/**
 * Returns true only when the Discord edit succeeds.
 */
async function safeEdit(fn) {
  try {
    await fn();
    return true;
  } catch (err) {
    if (err.status === 429 || err.code === 429) {
      const retryAfter = err.retryAfter || 10;
      console.warn(`⏳ Discord rate limit hit — skipping cycle, retry after ${retryAfter}s`);
      return false;
    }
    // Keep failed cache generations retryable.
    console.error('❌ Discord edit error:', err.message);
    return false;
  }
}

/**
 * Updates the status channels for a single guild config.
 */
async function updateGuild(client, guildRow, { updateVoiceChannels = true } = {}) {
  const config = JSON.parse(guildRow.config || '{}');
  const { text_channel_id, players_vc_id, restart_vc_id, pinned_message_id } = config;
  const server_db_id = guildRow.server_db_id;

  if (!text_channel_id || !pinned_message_id || !server_db_id) return false;

  // Fetch Nitrado token + service ID from DB
  const serverRes = await pool.query(
    `SELECT s.platform_server_id, s.name, gt.token_hash
     FROM servers s
     JOIN guild_tokens gt ON gt.guild_id = s.guild_id
       AND gt.token_type = 'nitrado'
       AND gt.nitrado_user_id IS NOT NULL
     WHERE s.id = $1 AND s.guild_id = $2`,
    [server_db_id, guildRow.guild_id]
  );
  if (serverRes.rows.length === 0) {
    console.warn(`⚠️  No server/token found for server_db_id ${server_db_id}`);
    return false;
  }
  const { platform_server_id, name: dbName, token_hash } = serverRes.rows[0];
  const token = decryptToken(token_hash);

  // Fetch live server data
  const gameserver = await fetchServerData(token, platform_server_id);
  if (!gameserver) return false;

  // Try Nitrado scheduled tasks first; fall back to the DayZ native messages.xml schedule.
  let restartResult = await fetchNextRestart(token, platform_server_id);
  if (!restartResult) {
    restartResult = await fetchRestartFromXml(token, platform_server_id, gameserver, guildRow.discord_guild_id);
  }
  const restartLabel = restartResult?.label || null;
  const restartAtMs  = restartResult?.restartAtMs || null;
  const serverName = resolveServerName(dbName, gameserver);

  // Fetch online player list with debugging
  const onlinePlayers = await fetchOnlinePlayers(server_db_id, platform_server_id);

  // Get sync timing info from automation_settings
  let lastLogSyncTime = null;
  let nextLogSyncTime = null;
  try {
    const settingsRes = await pool.query(
      `SELECT auto_log_sync FROM automation_settings WHERE user_id IN (
         SELECT DISTINCT gr.user_id FROM guild_roles gr WHERE gr.guild_id = (
           SELECT guild_id FROM servers WHERE id = $1
         )
       ) LIMIT 1`,
      [server_db_id]
    );
    if (settingsRes.rows.length > 0) {
      const settings = JSON.parse(settingsRes.rows[0].auto_log_sync || '{}');
      if (settings.lastRun) {
        lastLogSyncTime = new Date(settings.lastRun);
      }
      if (settings.interval && settings.lastRun) {
        const lastMs = new Date(settings.lastRun).getTime();
        const nextMs = lastMs + (settings.interval || 15) * 60 * 1000;
        nextLogSyncTime = new Date(nextMs);
      }
    }
  } catch (err) {
    console.log(`ℹ️  Could not fetch sync timing:`, err.message);
  }

  const renderState = {
    serverName,
    gameserver,
    restartLabel,
    restartAtMs,
    lastLogSyncTime,
    nextLogSyncTime,
    platformServerId: platform_server_id,
  };
  statusRenderCache.set(String(server_db_id), renderState);
  const embed = buildEmbed(
    renderState.serverName,
    renderState.gameserver,
    renderState.restartLabel,
    onlinePlayers,
    renderState.lastLogSyncTime,
    renderState.nextLogSyncTime,
    renderState.restartAtMs
  );

  // Edit the pinned embed. Cache generations are acknowledged only after this
  // primary player-name surface updates successfully.
  let statusMessageUpdated = false;
  try {
    const textChannel = await client.channels.fetch(text_channel_id);
    if (textChannel?.guildId !== guildRow.discord_guild_id) {
      throw new Error('Status channel does not belong to the configured Discord guild');
    }
    if (textChannel && pinned_message_id) {
      const msg = await textChannel.messages.fetch(pinned_message_id);
      const ok = await safeEdit(() => msg.edit({ embeds: [embed] }));
      if (!ok) return false; // rate limited — retry this generation later
      statusMessageUpdated = true;
    }
  } catch (err) {
    console.error(`❌ Could not fetch/edit status message in channel ${text_channel_id}:`, err.message);
    return false;
  }

  // Update player count voice channel only on the conservative full-refresh cadence.
  if (updateVoiceChannels && players_vc_id) {
    const playerCurrent = gameserver.query?.player_current ?? '?';
    const playerMax = gameserver.query?.player_max ?? gameserver.slots ?? '?';
    try {
      const vc = await client.channels.fetch(players_vc_id);
      if (vc?.guildId !== guildRow.discord_guild_id) {
        throw new Error('Players channel does not belong to the configured Discord guild');
      }
      if (vc) await safeEdit(() => vc.setName(`👥 Players: ${playerCurrent}/${playerMax}`));
    } catch (err) {
      console.error(`❌ Could not rename players VC ${players_vc_id}:`, err.message);
    }
  }

  // Update restart time voice channel only on the conservative full-refresh cadence.
  if (updateVoiceChannels && restart_vc_id) {
    const label = formatRestartChannelName(restartAtMs, restartLabel);
    try {
      const vc = await client.channels.fetch(restart_vc_id);
      if (vc?.guildId !== guildRow.discord_guild_id) {
        throw new Error('Restart channel does not belong to the configured Discord guild');
      }
      if (vc) await safeEdit(() => vc.setName(label));
    } catch (err) {
      console.error(`❌ Could not rename restart VC ${restart_vc_id}:`, err.message);
    }
  }

  // Send DM notifications to opted-in users if restart is approaching.
  if (restartAtMs) {
    await sendRestartNotifications(client, guildRow.discord_guild_id, server_db_id, serverName, restartAtMs);
  }

  // Fire player count threshold alerts if the count has crossed a threshold.
  const playerCurrent = gameserver.query?.player_current;
  if (typeof playerCurrent === 'number') {
    await checkPlayerCountAlerts(client, guildRow.discord_guild_id, server_db_id, playerCurrent);
  }
  return statusMessageUpdated;
}

/**
 * Refreshes only the player-name surface from local database/cache state.
 * Provider status and restart discovery remain on the five-minute full pass.
 */
async function refreshGuildPresence(client, guildRow, {
  renderCache = statusRenderCache,
  fetchPlayers = fetchOnlinePlayers,
  edit = safeEdit,
} = {}) {
  const config = JSON.parse(guildRow.config || '{}');
  const { text_channel_id, pinned_message_id } = config;
  const serverDbId = guildRow.server_db_id;
  if (!text_channel_id || !pinned_message_id || !serverDbId) return false;

  const renderState = renderCache.get(String(serverDbId));
  if (!renderState) return false;

  try {
    const onlinePlayers = await fetchPlayers(serverDbId, renderState.platformServerId);
    const embed = buildEmbed(
      renderState.serverName,
      renderState.gameserver,
      renderState.restartLabel,
      onlinePlayers,
      renderState.lastLogSyncTime,
      renderState.nextLogSyncTime,
      renderState.restartAtMs
    );
    const textChannel = await client.channels.fetch(text_channel_id);
    if (textChannel?.guildId !== guildRow.discord_guild_id) {
      throw new Error('Status channel does not belong to the configured Discord guild');
    }
    if (!textChannel) return false;
    const message = await textChannel.messages.fetch(pinned_message_id);
    return edit(() => message.edit({ embeds: [embed] }));
  } catch (error) {
    console.error(`❌ Could not refresh player names for server_db_id ${serverDbId}:`, error.message);
    return false;
  }
}

/**
 * Runs one full update pass across all guilds that have server_status enabled.
 */
async function runUpdate(client, { updateVoiceChannels = true } = {}) {
  if (updateRunning) return false;
  updateRunning = true;
  let completed = false;
  try {
    await backfillLegacyNitradoTokenBindings();
    const res = await pool.query(
      `SELECT sf.config, sf.server_id AS server_db_id, s.guild_id, g.discord_guild_id,
              COALESCE(snapshot.scan_generation, 0)::text AS scan_generation
       FROM server_features sf
       JOIN servers s ON s.id = sf.server_id AND s.status = 'active'
       JOIN guilds g ON g.id = s.guild_id
       LEFT JOIN server_online_cache_snapshots snapshot ON snapshot.server_id = sf.server_id
       WHERE sf.feature_name = 'server_status'
         AND sf.enabled = 1
         AND g.status = 'approved'`
    );
    for (const row of res.rows) {
      if (await updateGuild(client, row, { updateVoiceChannels })) {
        lastOnlineCacheGenerations.set(
          String(row.server_db_id), String(row.scan_generation || '0')
        );
      }
    }
    completed = true;
  } catch (err) {
    console.error('❌ serverStatusService runUpdate error:', err.message);
  } finally {
    updateRunning = false;
  }
  return completed;
}

async function refreshStatusOnOnlineCacheChange(client) {
  if (updateRunning) return false;
  updateRunning = true;
  try {
    const res = await pool.query(
      `SELECT sf.config, sf.server_id AS server_db_id, s.guild_id, g.discord_guild_id,
              COALESCE(snapshot.scan_generation, 0)::text AS scan_generation
       FROM server_features sf
       JOIN servers s ON s.id = sf.server_id AND s.status = 'active'
       JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
       LEFT JOIN server_online_cache_snapshots snapshot ON snapshot.server_id = sf.server_id
       WHERE sf.feature_name = 'server_status'
         AND sf.enabled = 1
       ORDER BY sf.server_id`
    );
    const activeServerIds = new Set(res.rows.map(row => String(row.server_db_id)));
    for (const serverId of lastOnlineCacheGenerations.keys()) {
      if (!activeServerIds.has(serverId)) lastOnlineCacheGenerations.delete(serverId);
    }
    await applyChangedOnlineCacheRows(
      lastOnlineCacheGenerations,
      res.rows,
      row => refreshGuildPresence(client, row),
      (error, row) => console.error(
        `❌ Could not refresh cache generation for server_db_id ${row.server_db_id}:`,
        error.message
      )
    );
    return true;
  } catch (err) {
    console.error('❌ serverStatusService cache refresh check error:', err.message);
    return false;
  } finally {
    updateRunning = false;
  }
}

/**
 * Starts the recurring status update loop.
 * Call this once from bot/events/ready.js.
 */
function startLoop(client) {
  console.log(`🔄 Server status loop started (interval: ${UPDATE_INTERVAL_MS / 1000}s)`);
  // Prime the provider render cache and cache-generation baseline immediately.
  runUpdate(client);
  setInterval(() => runUpdate(client), UPDATE_INTERVAL_MS);
  setInterval(() => refreshStatusOnOnlineCacheChange(client), CACHE_REFRESH_INTERVAL_MS);
}

module.exports = {
  backfillLegacyNitradoTokenBindings,
  startLoop,
  buildEmbed,
  applyChangedOnlineCacheRows,
  refreshGuildPresence,
  safeEdit,
  selectChangedOnlineCacheRows,
  formatRestartChannelName,
  formatRestartEmbedLabel,
  selectNewestRptStartMs,
  resolveServerName,
  fetchServerData,
};
