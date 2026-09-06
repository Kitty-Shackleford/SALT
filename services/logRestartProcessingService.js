'use strict';

const fs = require('fs');
const path = require('path');
const { getGuildDownloadPath } = require('./logSyncService');
const { openContainedFileSync, readContainedFileSync } = require('../utils/safePath');
const {
  isSupportedRptFilename,
  logStartTimeMs,
  parseStrictTimestampMs,
} = require('../utils/logFileChronology');
const { parseServerLog, processRestartEvents } = require('./shopRestartService');

const DOWNLOAD_ROOT = path.join(__dirname, '..', 'downloads');
const RPT_EVIDENCE_TAIL_BYTES = 256 * 1024;
const RPT_START_CORRELATION_MS = 30 * 60 * 1000;
const RPT_CLOCK_MATCH_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function normalizeProviderTimestampMs(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    const timestamp = numeric < 1e12 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
    return Number.isFinite(new Date(timestamp).getTime()) ? timestamp : null;
  }
  return parseStrictTimestampMs(value);
}

function rptFilenameMatchesProviderStart(filePath, startedAtMs) {
  const rptName = path.basename(filePath);
  if (!isSupportedRptFilename(rptName)) return false;
  const localClockMs = logStartTimeMs(rptName);
  const difference = startedAtMs - localClockMs;
  const timezoneHours = Math.round(difference / HOUR_MS);
  return Math.abs(timezoneHours) <= 14
    && Math.abs(difference - timezoneHours * HOUR_MS) <= RPT_CLOCK_MATCH_MS;
}

function readContainedTailSync(root, relativePath, maxBytes) {
  const { fd } = openContainedFileSync(root, relativePath);
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeServerContext(context) {
  const serverId = Number(context?.serverId);
  const platformServerId = String(context?.platformServerId || '');
  if (!Number.isInteger(serverId) || serverId <= 0 || !platformServerId) {
    throw new Error('Restart evidence requires an exact internal and platform server identity');
  }
  return { serverId, platformServerId };
}

function serverLogTimestampMatchesProviderStart(value, startedAtMs) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(value)) {
    return false;
  }
  const localClockMs = parseStrictTimestampMs(`${value.replace(' ', 'T')}Z`);
  if (localClockMs === null) return false;
  const difference = startedAtMs - localClockMs;
  const timezoneHours = Math.round(difference / HOUR_MS);
  return Math.abs(timezoneHours) <= 14
    && Math.abs(difference - timezoneHours * HOUR_MS) <= RPT_START_CORRELATION_MS;
}

function restartTimestamp(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function readDownloadedServerLogEvents(serverRow, platformServerId, serverLogPath) {
  const expectedPath = path.join(
    getGuildDownloadPath(serverRow.discord_guild_id, platformServerId),
    'config',
    'server.log'
  );
  if (path.resolve(serverLogPath) !== path.resolve(expectedPath)) {
    throw new Error(`Server ${platformServerId} restart log path does not match its authorized directory`);
  }
  const relativePath = path.relative(DOWNLOAD_ROOT, expectedPath);
  return parseServerLog(readContainedFileSync(DOWNLOAD_ROOT, relativePath, 'utf8'));
}

async function processDownloadedRestartEvidence(db, context, evidence) {
  const serverContext = normalizeServerContext(context);
  const { serverId, platformServerId } = serverContext;
  let serverRow = null;
  let restartEvents = [];
  if (evidence?.serverLogPath) {
    serverRow = await resolveActiveServer(db, serverContext);
    restartEvents = readDownloadedServerLogEvents(serverRow, platformServerId, evidence.serverLogPath);
  }

  const startedAtMs = evidence?.gameserverStatus === 'started'
    ? normalizeProviderTimestampMs(evidence?.lastStatusChange)
    : null;
  const providerRestartId = startedAtMs === null
    ? null
    : `provider-start:${platformServerId}:${startedAtMs}`;
  const latestRptModifiedAtMs = normalizeProviderTimestampMs(evidence?.latestRptModifiedAt);
  const latestIsCurrentSession = startedAtMs !== null && evidence?.latestRptPath
    ? rptFilenameMatchesProviderStart(evidence.latestRptPath, startedAtMs)
    : false;
  const evidenceSourceFile = latestIsCurrentSession
    ? path.basename(evidence.latestRptPath)
    : null;

  if (providerRestartId) {
    for (let index = restartEvents.length - 1; index >= 0; index--) {
      if (!serverLogTimestampMatchesProviderStart(restartEvents[index].detectedAt, startedAtMs)) continue;
      restartEvents[index] = {
        ...restartEvents[index],
        biosSessionId: providerRestartId,
        detectedAt: restartTimestamp(startedAtMs),
        providerStartedAt: restartTimestamp(startedAtMs),
        evidenceSourceFile,
      };
      break;
    }
  }

  if (restartEvents.length > 0) {
    await processRestartEvents(db, serverRow.id, restartEvents);
  }
  const parsedFromServerLog = restartEvents.length;
  if (!providerRestartId) return parsedFromServerLog;

  if (parsedFromServerLog > 0) {
    const currentRestart = await db.get(
      `SELECT id
       FROM server_restart_log
       WHERE server_id = ? AND bios_session_id = ?
       LIMIT 1`,
      [serverId, providerRestartId]
    );
    if (currentRestart) return Math.max(1, parsedFromServerLog);
  }

  if (!evidence.latestRptPath
      || latestRptModifiedAtMs === null
      || latestRptModifiedAtMs < startedAtMs - RPT_START_CORRELATION_MS) {
    return parsedFromServerLog;
  }
  if (!latestIsCurrentSession
      && Math.abs(latestRptModifiedAtMs - startedAtMs) > RPT_START_CORRELATION_MS) {
    return parsedFromServerLog;
  }
  const shutdownRptPath = latestIsCurrentSession
    ? evidence.previousRptPath
    : evidence.latestRptPath;
  const shutdownRptModifiedAtMs = latestIsCurrentSession
    ? normalizeProviderTimestampMs(evidence.previousRptModifiedAt)
    : latestRptModifiedAtMs;
  if (!shutdownRptPath || shutdownRptModifiedAtMs === null ||
      Math.abs(shutdownRptModifiedAtMs - startedAtMs) > RPT_START_CORRELATION_MS) {
    return parsedFromServerLog;
  }

  if (!serverRow) serverRow = await resolveActiveServer(db, serverContext);
  const expectedDirectory = path.join(
    getGuildDownloadPath(serverRow.discord_guild_id, platformServerId),
    'config'
  );
  const rptPath = path.resolve(shutdownRptPath);
  const rptName = path.basename(rptPath);
  if (path.dirname(rptPath) !== path.resolve(expectedDirectory)
      || !isSupportedRptFilename(rptName)) {
    throw new Error(`Server ${platformServerId} RPT evidence path does not match its authorized directory`);
  }
  const rptContent = readContainedTailSync(
    DOWNLOAD_ROOT,
    path.relative(DOWNLOAD_ROOT, rptPath),
    RPT_EVIDENCE_TAIL_BYTES
  );
  const isScheduled = /\[Shutdown\]\s+Saving players, locking server and kicking all players\./i
    .test(rptContent);
  const detectedAt = restartTimestamp(startedAtMs);
  await processRestartEvents(db, serverRow.id, [{
    biosSessionId: providerRestartId,
    detectedAt,
    providerStartedAt: detectedAt,
    evidenceSourceFile,
    isScheduled,
  }]);
  return 1;
}

async function resolveActiveServer(db, context) {
  const { serverId, platformServerId } = normalizeServerContext(context);
  const serverRow = await db.get(
    `SELECT s.id, g.discord_guild_id
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id
     WHERE s.id = ?
       AND s.platform_server_id = ?
       AND s.status = 'active'
       AND g.status = 'approved'`,
    [serverId, platformServerId]
  );
  if (!serverRow) {
    throw new Error(`Active server ${serverId}/${platformServerId} not found in database`);
  }
  return serverRow;
}

async function processDownloadedServerLog(db, context, serverLogPath) {
  const serverContext = normalizeServerContext(context);
  const { platformServerId } = serverContext;
  const serverRow = await resolveActiveServer(db, serverContext);
  const restartEvents = readDownloadedServerLogEvents(serverRow, platformServerId, serverLogPath);
  if (restartEvents.length > 0) {
    await processRestartEvents(db, serverRow.id, restartEvents);
  }
  return restartEvents.length;
}

module.exports = {
  isSupportedRptFilename,
  normalizeProviderTimestampMs,
  serverLogTimestampMatchesProviderStart,
  processDownloadedServerLog,
  processDownloadedRestartEvidence,
};
