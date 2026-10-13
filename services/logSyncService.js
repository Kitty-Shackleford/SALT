/**
 * Log Sync Service (retry + telemetry)
 */

const http = require('../utils/httpRetry');
const telemetry = require('../utils/telemetry');
const fs = require('fs');
const path = require('path');
const { decryptToken } = require('../utils/encryption');
const {
  ProviderLogStorageUnavailableError,
  providerLogAvailability,
} = require('../utils/providerLogAvailability');
const { getNitradoBinaryBody, getNitradoFileEntries, getNitradoTransferToken } = require('../utils/nitradoHttp');
const {
  ensureContainedDirectorySync,
  normalizeStorageIdentifier,
  openContainedFileSync,
  writeContainedFileAtomicSync,
} = require('../utils/safePath');
const { inspectNitradoRootEntries } = require('../utils/dayzPlatform');
const {
  compareLogFileEntries,
  isSupportedAdmFilename,
  isSupportedRptFilename,
  logStartTimeMs,
  parseStrictTimestampMs,
} = require('../utils/logFileChronology');
const { createNitradoService } = require('./nitradoService');

const DOWNLOAD_ROOT = path.join(__dirname, '..', 'downloads');
const MAX_LOG_FILE_BYTES = 128 * 1024 * 1024;
const MAX_LOG_BATCH_BYTES = 512 * 1024 * 1024;
const FTPROOT_LISTING_WAF_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Circuit breaker for Nitrado ftproot RAW (un-normalized) directory
 * listings. Nitrado's WAF 401s that endpoint per egress IP on some
 * console servers; retrying it every few minutes deepens the ban. The
 * breaker is keyed by guild token (each guild is an independent Nitrado
 * account, so 15580969/guild-1 and 16000564/guild-15 keep separate
 * state), and a single 401 suppresses raw listings for that guild for at
 * least an hour. The file DOWNLOAD endpoint is not WAF-blocked, so the
 * direct server.log transfer-token request is never gated by this
 * breaker.
 */
function createFtprootListingBreaker({ cooldownMs = FTPROOT_LISTING_WAF_COOLDOWN_MS } = {}) {
  const cooldown = Math.max(60 * 1000, Number(cooldownMs) || FTPROOT_LISTING_WAF_COOLDOWN_MS);
  const trips = new Map();
  function isTripped(key, now = Date.now()) {
    const trip = trips.get(String(key));
    if (!trip) return false;
    if (Number(now) >= trip.retryAtMs) {
      trips.delete(String(key));
      return false;
    }
    return true;
  }
  function trip(key, now = Date.now()) {
    const retryAtMs = Number(now) + cooldown;
    trips.set(String(key), { retryAtMs });
    return retryAtMs;
  }
  function reset(key) {
    trips.delete(String(key));
  }
  function resetAll() {
    trips.clear();
  }
  function retryAt(key) {
    return trips.get(String(key))?.retryAtMs ?? null;
  }
  return { isTripped, trip, reset, resetAll, retryAt };
}

const ftprootListingBreaker = createFtprootListingBreaker();
function resetFtprootListingBreaker() {
  ftprootListingBreaker.resetAll();
}
const nitradoService = createNitradoService();
if (!fs.existsSync(DOWNLOAD_ROOT)) fs.mkdirSync(DOWNLOAD_ROOT, { recursive: true });

function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function normalizeNitradoFilePath(filePath) {
  return filePath.replace(/\/ftproot\/(dayzxb|dayzps|dayzswitch|dayzstandalone|dayz)(?=\/|$)/g, '/noftp/$1');
}

function validateLogFileEntry(configRoot, entry) {
  if (!entry || entry.type !== 'file' || typeof entry.name !== 'string' ||
      !/^[A-Za-z0-9._-]+$/.test(entry.name) || path.posix.basename(entry.name) !== entry.name ||
      typeof entry.path !== 'string' || !entry.path.startsWith('/') || entry.path.includes('\\') || entry.path.includes('\0')) {
    throw new Error('Nitrado returned an invalid log file path');
  }
  const providerPath = entry.path.replace(/\/+$/, '');
  const normalizedRoot = normalizeNitradoFilePath(configRoot).replace(/\/+$/, '');
  const normalizedPath = normalizeNitradoFilePath(providerPath);
  if (path.posix.normalize(providerPath) !== providerPath ||
      path.posix.normalize(normalizedPath) !== normalizedPath ||
      normalizedPath !== `${normalizedRoot}/${entry.name}`) {
    throw new Error('Nitrado returned an invalid log file path');
  }
  return { ...entry, path: providerPath };
}

function classifyLogEntry(configPath, entry) {
  const localPath = path.join(configPath, entry.name);
  if (!fs.existsSync(localPath)) return 'new';
  const localStat = fs.lstatSync(localPath);
  if (localStat.isSymbolicLink()) {
    throw new Error('Local log destination is a symbolic link');
  }
  if (!localStat.isFile()) {
    throw new Error('Local log destination is not a regular file');
  }
  // Nitrado does not provide a trustworthy content digest. Equal byte size does
  // not prove equal content, so refresh every retained provider log atomically.
  return 'updated';
}

function getGuildDownloadPath(guildDiscordId, serverId) {
  const basePath = DOWNLOAD_ROOT;
  const guildPath = path.join(
    basePath,
    normalizeStorageIdentifier(guildDiscordId, 'guild storage identifier')
  );
  const serverPath = path.join(
    guildPath,
    `server_${normalizeStorageIdentifier(serverId, 'server storage identifier')}`
  );

  ensureContainedDirectorySync(basePath, path.relative(basePath, serverPath));

  return serverPath;
}

const getUserDownloadPath = getGuildDownloadPath;

async function resolveGuildDiscordId(db, userId, platformServerId) {
  const row = await db.get(
    `SELECT g.discord_guild_id
     FROM guilds g
     JOIN servers s ON s.guild_id = g.id
     LEFT JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = ?
     WHERE CAST(s.platform_server_id AS TEXT) = ?
       AND g.status = 'approved'
       AND s.status = 'active'
       AND (
         gr.role IN ('owner', 'admin')
         OR EXISTS (
           SELECT 1 FROM server_role_assignments sra
           WHERE sra.server_id = s.id
             AND sra.guild_id = g.id
             AND sra.user_id = ?
             AND sra.role = 'admin'
             AND sra.status = 'active'
         )
       )
     LIMIT 1`,
    [userId, String(platformServerId), userId]
  );
  return row ? row.discord_guild_id : null;
}

async function resolveOperationalServers(db, userId, serverIds) {
  const uniqueServerIds = Array.from(new Set((serverIds || []).map(id => String(id).trim()).filter(Boolean)));
  const servers = [];

  for (const platformServerId of uniqueServerIds) {
    const sql = `SELECT s.id, s.platform_server_id, g.discord_guild_id, gt.token_hash
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
       LEFT JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = ?
       JOIN guild_tokens gt ON gt.guild_id = g.id AND gt.token_type = 'nitrado'
       WHERE CAST(s.platform_server_id AS TEXT) = ?
         AND g.status = 'approved'
         AND s.status = 'active'
         AND (
           gr.role IN ('owner', 'admin')
           OR EXISTS (
             SELECT 1 FROM server_role_assignments sra
             WHERE sra.server_id = s.id
               AND sra.guild_id = g.id
               AND sra.user_id = ?
               AND sra.role = 'admin'
               AND sra.status = 'active'
           )
         )
         AND gt.nitrado_user_id IS NOT NULL`;
    const params = [userId, platformServerId, userId];
    // Production adapters expose query(), which is required to reject ambiguous
    // provider IDs. The get() fallback keeps isolated legacy test doubles usable.
    const rows = typeof db.query === 'function'
      ? await db.query(sql, params)
      : [await db.get(sql, params)].filter(Boolean);
    if (!rows || rows.length !== 1) return null;
    const row = rows[0];
    servers.push({
      id: Number(row.id),
      platformServerId: String(row.platform_server_id),
      guildDiscordId: row.discord_guild_id,
      tokenHash: row.token_hash,
    });
  }

  return servers;
}

async function resolveOperationalServer(db, userId, serverId, token) {
  const servers = await resolveOperationalServers(db, userId, [serverId]);
  if (!servers || servers.length !== 1) return null;
  if (decryptToken(servers[0].tokenHash) !== token) return null;
  return servers[0];
}

async function resolveOperationalServerByInternalId(db, serverId, token) {
  const rows = await db.query(
    `SELECT s.id, s.platform_server_id, g.discord_guild_id, gt.token_hash
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
     JOIN guild_tokens gt ON gt.guild_id = g.id
       AND gt.token_type = 'nitrado' AND gt.nitrado_user_id IS NOT NULL
     WHERE s.id = ? AND s.status = 'active'`,
    [serverId]
  );
  if (!rows || rows.length !== 1 || decryptToken(rows[0].token_hash) !== token) return null;
  return {
    id: rows[0].id,
    platformServerId: String(rows[0].platform_server_id),
    guildDiscordId: String(rows[0].discord_guild_id),
    tokenHash: rows[0].token_hash,
  };
}

async function getDecryptedToken(db, userId, serverIds = []) {
  let query;
  let params;

  if (serverIds && serverIds.length > 0) {
    const servers = await resolveOperationalServers(db, userId, serverIds);
    if (!servers || servers.length === 0) return null;
    const tokens = servers.map(server => decryptToken(server.tokenHash));
    if (new Set(tokens).size !== 1) return null;
    return tokens[0];
  } else {
    query = `
      SELECT MIN(gt.token_hash) AS token_hash
      FROM guild_tokens gt
      JOIN guilds g ON g.id = gt.guild_id
      JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = ?
      WHERE gt.token_type = 'nitrado'
        AND gt.nitrado_user_id IS NOT NULL
        AND g.status = 'approved'
        AND gr.role IN ('owner', 'admin')
      HAVING COUNT(DISTINCT gt.id) = 1
    `;
    params = [userId];
  }

  const row = await db.get(query, params);
  if (!row || !row.token_hash) return null;
  return decryptToken(row.token_hash);
}

function localFileMatchesBody(localPath, fileBody) {
  let opened;
  try {
    opened = openContainedFileSync(DOWNLOAD_ROOT, path.relative(DOWNLOAD_ROOT, localPath));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }

  const { fd, stat } = opened;
  try {
    if (stat.size !== fileBody.byteLength) return false;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, fileBody.byteLength)));
    let position = 0;
    while (position < fileBody.byteLength) {
      const length = Math.min(chunk.length, fileBody.byteLength - position);
      const bytesRead = fs.readSync(fd, chunk, 0, length, position);
      if (bytesRead !== length || !chunk.subarray(0, bytesRead).equals(fileBody.subarray(position, position + bytesRead))) {
        return false;
      }
      position += bytesRead;
    }
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

class IncompleteLogDownloadError extends Error {
  constructor(expectedBytes, receivedBytes) {
    super('Nitrado returned an incomplete log file download');
    this.name = 'IncompleteLogDownloadError';
    this.expectedBytes = expectedBytes;
    this.receivedBytes = receivedBytes;
  }
}

async function downloadLogFile(token, serverId, file, localPath) {
  const advertisedBytes = file.size == null ? null : Number(file.size);
  if (advertisedBytes !== null &&
      (!Number.isSafeInteger(advertisedBytes) || advertisedBytes < 0 || advertisedBytes > MAX_LOG_FILE_BYTES)) {
    throw new Error('Nitrado log file exceeds the transfer size limit');
  }
  return telemetry.timeAsync(`downloadLog:${serverId}:${file.name}`, async () => {
    const tokenRes = await http.get(
      `https://api.nitrado.net/services/${serverId}/gameservers/file_server/download?file=${encodeURIComponent(file.path)}`,
      { headers: { Authorization: 'Bearer ' + token }, timeout: 10000 }
    );

    const { url: downloadUrl } = getNitradoTransferToken(tokenRes);
    let expectedBytes = advertisedBytes;

    const fileRes = await http.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: MAX_LOG_FILE_BYTES,
      maxBodyLength: MAX_LOG_FILE_BYTES,
    });
    const fileBody = getNitradoBinaryBody(fileRes);
    const fileBodyBuffer = Buffer.isBuffer(fileBody) ? fileBody : Buffer.from(fileBody);
    const receivedBytes = Number(fileBodyBuffer.byteLength);
    if (expectedBytes === null) {
      // Direct transfer-token requests bypass the (WAF-blocked) ftproot
      // listing, so the file size is not advertised by a listing entry; use
      // the file response's Content-Length for truncation validation when
      // the provider offers one, otherwise trust the bounded maxContentLength
      // on the axios request.
      const contentLength = Number(fileRes?.headers?.['content-length']);
      if (Number.isSafeInteger(contentLength) && contentLength >= 0 && receivedBytes !== contentLength) {
        throw new IncompleteLogDownloadError(contentLength, receivedBytes);
      }
    } else if (receivedBytes !== expectedBytes) {
      throw new IncompleteLogDownloadError(expectedBytes, receivedBytes);
    }
    if (localFileMatchesBody(localPath, fileBodyBuffer)) {
      telemetry.incr('download.bytes', receivedBytes);
      console.log(`      ↔ Unchanged (${receivedBytes} bytes)`);
      return false;
    }
    writeContainedFileAtomicSync(DOWNLOAD_ROOT, path.relative(DOWNLOAD_ROOT, localPath), fileBodyBuffer);
    telemetry.incr('download.bytes', receivedBytes);
    console.log(`      ✅ Saved (${receivedBytes} bytes)`);
    return true;
  });
}

function isLogArtifactName(name) {
  return typeof name === 'string' && /\.(ADM|RPT)$/i.test(name);
}

function configListPathForStructure(structure) {
  const rawConfigPath = structure.configPath.replace(/\/+$/, '');
  return structure.platform === 'pc'
    ? rawConfigPath
    : normalizeNitradoFilePath(rawConfigPath);
}

/**
 * Nitrado serves the same on-disk config directory under two namespaced
 * paths (ftproot vs noftp) and does NOT expose every file under both: for
 * Xbox/console DayZ servers the file_server list API only returns
 * server.log under the RAW ftproot path and refuses noftp downloads with
 * "Permission denied". The normal sync listing therefore misses it.
 *
 * Live-verified in production (2026-10-11): the RAW ftproot DIRECTORY
 * LISTING is what Nitrado's WAF 401s per egress IP, while the
 * file_server DOWNLOAD endpoint for the deterministic raw path
 * (.../ftproot/<game>/config/server.log) issues a transfer token without
 * a ban. The previous flow (raw listing -> 401 -> noftp fallback ->
 * "not found" -> retry) therefore looped ~every few minutes, re-tripping
 * the WAF ban each time.
 *
 * Resolution: request the download token for the KNOWN deterministic
 * ftproot path directly (no listing required); only if that transfer is
 * refused fall back to the raw ftproot listing, which is now best-effort
 * and gated by a per-guild circuit breaker (a single 401 suppresses raw
 * listings for that guild for at least an hour, so a banned egress IP
 * stops hammering Nitrado into deeper bans).
 */
async function fetchServerLogEntryFromRawConfigPath(http, token, serverId, structure, {
  breaker = ftprootListingBreaker,
  breakerKey = `nitrado:${token}`,
  nowMs = Date.now,
} = {}) {
  if (!structure || !structure.configPath) return null;
  const rawConfigPath = structure.configPath.replace(/\/+$/, '');
  const normalListedPath = configListPathForStructure(structure).replace(/\/+$/, '');
  if (normalListedPath === rawConfigPath) {
    // The normal sync listing already used this raw config directory (PC
    // servers), so server.log is visible through it; there is no separate
    // ftproot view to fall back to.
    return null;
  }

  const rawServerLogPath = `${rawConfigPath}/server.log`;
  const directEntry = { type: 'file', name: 'server.log', path: rawServerLogPath, size: null };
  try {
    await http.get(
      `https://api.nitrado.net/services/${serverId}/gameservers/file_server/download?file=${encodeURIComponent(rawServerLogPath)}`,
      { headers: { Authorization: 'Bearer ' + token }, timeout: 10000 }
    );
    console.log(`   🔁 server.log resolved via direct ftproot transfer token for ${serverId}`);
    return directEntry;
  } catch (error) {
    // The transfer token endpoint was refused (e.g. Permission denied for
    // noftp paths, or a missing file). The raw listing is the only other
    // view that can confirm existence, but it is the WAF-blocked endpoint
    // — run it best-effort behind the per-guild circuit breaker.
    if (breaker.isTripped(breakerKey, nowMs())) {
      const retryAtMs = breaker.retryAt(breakerKey);
      console.log(
        `   ⚠️  server.log ftproot fallback: raw listing suppressed by WAF backoff for ${serverId}`
        + ` until ${new Date(retryAtMs).toISOString()}`
      );
      return null;
    }
    let listRes;
    try {
      listRes = await http.get(
        `https://api.nitrado.net/services/${serverId}/gameservers/file_server/list?dir=${encodeURIComponent(rawConfigPath)}`,
        { headers: { Authorization: 'Bearer ' + token }, timeout: 10000 }
      );
    } catch (error) {
      const status = Number(error?.response?.status);
      if (status === 401 || status === 403) {
        // Nitrado WAF bans per egress IP: stop retrying raw listings for
        // this guild token for the cooldown window instead of re-tripping
        // the ban every few minutes.
        const retryAtMs = breaker.trip(breakerKey, nowMs());
        console.log(
          `   ⚠️  server.log ftproot fallback: raw listing failed for ${serverId}: ${error.message}`
          + ` — backing off raw listings until ${new Date(retryAtMs).toISOString()}`
        );
      } else {
        console.log(`   ⚠️  server.log ftproot fallback: raw listing failed for ${serverId}: ${error.message}`);
      }
      return null;
    }
    const entries = getNitradoFileEntries(listRes);
    const entry = entries.find(item => item?.type === 'file' && item.name === 'server.log');
    if (!entry) {
      console.log(`   ⚠️  server.log ftproot fallback: not present in raw listing for ${serverId} (${entries.length} entries)`);
      return null;
    }
    try {
      const validated = validateLogFileEntry(rawConfigPath, entry);
      console.log(`   🔁 server.log found via ftproot fallback for ${serverId} (${validated.size} bytes)`);
      return validated;
    } catch (error) {
      console.log(`   ⚠️  server.log ftproot fallback: entry validation failed for ${serverId}: ${error.message}`);
      return null;
    }
  }
}

function getLogSyncConfigEntries(response) {
  const entries = response?.data?.data?.entries;
  if (response?.data?.status !== 'success' || !Array.isArray(entries)) {
    getNitradoFileEntries(response);
  }
  const listedLogEntries = entries.filter(entry => isLogArtifactName(entry?.name));
  const otherEntries = entries.filter(entry => !isLogArtifactName(entry?.name));
  const validatedOtherEntries = getNitradoFileEntries({
    data: {
      ...response.data,
      data: { ...response.data.data, entries: otherEntries },
    },
  });
  return { listedLogEntries, validatedOtherEntries };
}

async function downloadActiveServerLog(token, serverId, file, localPath, {
  gameserver,
  configPathOnProvider,
} = {}) {
  try {
    return await downloadLogFile(token, serverId, file, localPath);
  } catch (error) {
    const active = String(gameserver?.status || '').toLowerCase() === 'started';
    if (!(error instanceof IncompleteLogDownloadError) || !active || !configPathOnProvider) {
      throw error;
    }

    const listRes = await http.get(
      `https://api.nitrado.net/services/${serverId}/gameservers/file_server/list?dir=${encodeURIComponent(configPathOnProvider)}`,
      { headers: { Authorization: 'Bearer ' + token }, timeout: 10000 }
    );
    const configEntries = getLogSyncConfigEntries(listRes);
    const refreshedEntry = configEntries.validatedOtherEntries
      .filter(entry => entry?.type === 'file')
      .map(entry => validateLogFileEntry(configPathOnProvider, entry))
      .find(entry => entry.name === 'server.log');
    if (!refreshedEntry) throw error;
    return downloadLogFile(token, serverId, refreshedEntry, localPath);
  }
}

function validateLogArtifactSizes(logFiles) {
  return logFiles.map(file => {
    const size = Number(file.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_LOG_FILE_BYTES) {
      throw new Error(`Invalid log artifact size: ${file.name}`);
    }
    return { ...file, size };
  });
}

function preflightLogArtifacts(configRoot, configPath, logFiles) {
  const accepted = [];
  const rejected = [];
  for (const file of logFiles) {
    try {
      const validatedEntry = validateLogFileEntry(configRoot, file);
      const [validatedFile] = validateLogArtifactSizes([validatedEntry]);
      classifyLogEntry(configPath, validatedFile);
      accepted.push(validatedFile);
    } catch (error) {
      rejected.push({ file, error });
    }
  }
  return { accepted, rejected };
}

function compareProviderModifiedAt(left, right) {
  const leftModifiedAt = Number(left.modified_at);
  const rightModifiedAt = Number(right.modified_at);
  const leftProviderTime = Number.isFinite(leftModifiedAt) ? leftModifiedAt : 0;
  const rightProviderTime = Number.isFinite(rightModifiedAt) ? rightModifiedAt : 0;
  return leftProviderTime - rightProviderTime || compareLogFileEntries(
    { name: left.name, mtimeMs: leftProviderTime },
    { name: right.name, mtimeMs: rightProviderTime }
  );
}

function providerModifiedAtMs(value) {
  let parsed = null;
  if (value instanceof Date) {
    parsed = value.getTime();
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    parsed = Math.abs(value) < 1e12 ? value * 1000 : value;
  } else if (typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    parsed = Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
  } else {
    parsed = parseStrictTimestampMs(value);
  }
  const minimum = Date.UTC(2000, 0, 1);
  const maximum = Date.UTC(2100, 0, 1);
  return Number.isFinite(parsed) && parsed >= minimum && parsed < maximum ? parsed : null;
}

function selectLatestAdmEntries(logFiles) {
  const supported = [...logFiles].filter(file => isSupportedAdmFilename(file?.name));
  for (const file of supported) {
    if (providerModifiedAtMs(file.modified_at) === null) {
      throw new Error(`Provider returned invalid modified_at for ADM file ${file.name}`);
    }
  }
  return supported
    .sort((left, right) => {
      const providerOrder = providerModifiedAtMs(left.modified_at) - providerModifiedAtMs(right.modified_at);
      return providerOrder || compareLogFileEntries(
        { name: left.name, mtimeMs: providerModifiedAtMs(left.modified_at) },
        { name: right.name, mtimeMs: providerModifiedAtMs(right.modified_at) }
      );
    })
    .slice(-2);
}

function activeRptPathForGameserver(logFiles, gameserver) {
  if (gameserver?.status !== 'started') return null;
  const startedAtMs = providerModifiedAtMs(gameserver.last_status_change);
  if (startedAtMs === null) return null;
  const newestRpt = [...logFiles]
    .filter(file => isSupportedRptFilename(file?.name))
    .sort((left, right) => compareLogFileEntries(
      { name: left.name, mtimeMs: Number(left.modified_at || 0) },
      { name: right.name, mtimeMs: Number(right.modified_at || 0) }
    ))
    .at(-1);
  if (!newestRpt) return null;

  // A matching filename alone is ambiguous on fixed whole-hour restart
  // schedules. Require provider metadata showing this generation was observed
  // during the current session; otherwise keep strict transfer validation.
  const modifiedAtMs = providerModifiedAtMs(newestRpt.modified_at);
  if (modifiedAtMs === null || modifiedAtMs < startedAtMs) return null;

  const filenameStartMs = logStartTimeMs(newestRpt.name);
  if (!Number.isFinite(filenameStartMs)) return null;
  const hourMs = 60 * 60 * 1000;
  const difference = startedAtMs - filenameStartMs;
  const timezoneHours = Math.round(difference / hourMs);
  if (Math.abs(timezoneHours) > 14 || Math.abs(difference - timezoneHours * hourMs) > 10 * 60 * 1000) {
    return null;
  }
  return newestRpt.path || newestRpt.name;
}

function selectLogSyncBatch(configPath, logFiles, {
  maxFiles = 8,
  maxBytes = MAX_LOG_BATCH_BYTES,
  gameserver = null,
} = {}) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Invalid routine log synchronization batch limits');
  }
  const validatedLogFiles = validateLogArtifactSizes(logFiles);
  const activeRptPath = activeRptPathForGameserver(validatedLogFiles, gameserver);
  const eligibleLogFiles = activeRptPath === null
    ? validatedLogFiles
    : validatedLogFiles.filter(file => (file.path || file.name) !== activeRptPath);
  const sorted = [...eligibleLogFiles].sort((left, right) => compareLogFileEntries(
    { name: left.name, mtimeMs: Number(left.modified_at || 0) },
    { name: right.name, mtimeMs: Number(right.modified_at || 0) }
  ));
  const recent = [
    ...eligibleLogFiles
      .filter(file => file.name.toUpperCase().endsWith('.ADM'))
      .sort(compareProviderModifiedAt)
      .slice(-2),
    ...sorted
      .filter(file => file.name.toUpperCase().endsWith('.RPT'))
      .slice(-2),
  ];
  const recentPaths = new Set(recent.map(file => file.path || file.name));
  const historical = sorted.filter(file => {
    if (recentPaths.has(file.path || file.name)) return false;
    const localPath = path.join(configPath, file.name);
    if (!fs.existsSync(localPath)) return true;
    // Selection decides which historical entries fit this batch; destination
    // validation belongs to the per-file sync boundary so failures retain ADM
    // versus RPT authority instead of becoming whole-server failures.
    try {
      const stat = fs.lstatSync(localPath);
      if (stat.isSymbolicLink() || !stat.isFile()) return true;
      return stat.size !== Number(file.size);
    } catch {
      return true;
    }
  });
  const selected = [...recent];
  let selectedBytes = selected.reduce((total, file) => total + Number(file.size), 0);
  if (selected.length > maxFiles || !Number.isSafeInteger(selectedBytes) || selectedBytes > maxBytes) {
    throw new Error('Current log artifacts exceed routine synchronization batch limits');
  }
  let selectedHistorical = 0;
  for (const file of historical) {
    const size = Number(file.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Historical log artifact has an invalid size: ${file.name}`);
    }
    if (size > maxBytes || selected.length >= maxFiles || selectedBytes + size > maxBytes) continue;
    selected.push(file);
    selectedBytes += size;
    selectedHistorical++;
  }
  if (historical.length > 0 && selectedHistorical === 0) {
    throw new Error('Current log artifacts leave no history synchronization capacity');
  }
  return selected.sort((left, right) => compareLogFileEntries(
    { name: left.name, mtimeMs: Number(left.modified_at || 0) },
    { name: right.name, mtimeMs: Number(right.modified_at || 0) }
  ));
}

function buildRestartEvidence(configPath, gameserver, serverLogPath, logFiles) {
  const sortedRpts = (logFiles || [])
    .filter(file => isSupportedRptFilename(file.name))
    .sort((left, right) => compareLogFileEntries(
      { name: left.name, mtimeMs: Number(left.modified_at || 0) },
      { name: right.name, mtimeMs: Number(right.modified_at || 0) }
    ));
  const sortedAdms = (logFiles || [])
    .filter(file => /\.ADM$/i.test(file.name))
    .sort(compareProviderModifiedAt);
  const latestRpt = sortedRpts.at(-1);
  const previousRpt = sortedRpts.at(-2);
  const latestAdm = sortedAdms.at(-1);
  return {
    serverLogPath,
    latestRptPath: latestRpt ? path.join(configPath, latestRpt.name) : null,
    latestRptModifiedAt: latestRpt?.modified_at ?? null,
    previousRptPath: previousRpt ? path.join(configPath, previousRpt.name) : null,
    previousRptModifiedAt: previousRpt?.modified_at ?? null,
    latestAdmPath: latestAdm ? path.join(configPath, latestAdm.name) : null,
    latestAdmModifiedAt: latestAdm?.modified_at ?? null,
    gameserverStatus: gameserver?.status || null,
    lastStatusChange: gameserver?.last_status_change ?? null,
  };
}

async function performLogSync(db, userId, token, serverIds, {
  respectAvailabilityBackoff = false,
  availabilityTracker = providerLogAvailability,
  nowMs = Date.now,
} = {}) {
  // legacy sync — keep for backwards compatibility
  let totalFilesDownloaded = 0;
  let totalFilesUpdated = 0;
  let totalFilesSkipped = 0;
  const errors = [];
  const blockingErrors = [];
  const failedServerIds = new Set();
  const parseBlockedServerIds = new Set();
  const rptBlockedServerIds = new Set();
  const recordError = (
    serverId,
    message,
    { blocksParsing = true, blocksRptParsing = false } = {}
  ) => {
    errors.push(message);
    failedServerIds.add(String(serverId));
    if (blocksParsing) parseBlockedServerIds.add(String(serverId));
    if (blocksRptParsing) rptBlockedServerIds.add(String(serverId));
    if (blocksParsing) blockingErrors.push(message);
    // Log at the point of recording so a later "Sync run incomplete" can be
    // traced back to its cause. Some call sites (preflight rejections, missing
    // server.log, availability backoff) otherwise fail completely silently.
    console.error(`   ⚠️  [logsync] server ${serverId} rejected: ${message}${blocksParsing ? '' : ' (non-blocking)'}`);
  };
  const serverLogPaths = {};
  const restartEvidence = {};
  const changedServerIds = [];

  for (const serverId of serverIds) {
    let serverChanged = false;
    try {
      console.log(`\n📥 Syncing logs from server ${serverId}...`);
      const authorizedServer = await resolveOperationalServer(db, userId, serverId, token);
      if (!authorizedServer) { recordError(serverId, `Server ${serverId}: Could not authorize server credentials`); continue; }
      if (respectAvailabilityBackoff && !availabilityTracker.canAttempt(serverId, nowMs())) {
        // A backoff is a temporary skip, not a failure: marking it non-blocking
        // lets the run still complete (and advance lastRun) while the tracker
        // expires on its own. Previously this was a blocking error, so a single
        // transient provider failure parked the whole auto-sync forever.
        recordError(serverId, `Server ${serverId}: DayZ log storage is temporarily backed off`, { blocksParsing: false });
        continue;
      }
      const guildDiscordId = authorizedServer.guildDiscordId;

      const serverPath = getGuildDownloadPath(guildDiscordId, serverId);
      const configPath = path.join(serverPath, 'config');
      ensureContainedDirectorySync(DOWNLOAD_ROOT, path.relative(DOWNLOAD_ROOT, configPath));

      const [gameserver, listRes] = await Promise.all([
        nitradoService.getRawGameserver(token, serverId),
        http.get(`https://api.nitrado.net/services/${serverId}/gameservers/file_server/list`, { headers: { Authorization: 'Bearer ' + token }, timeout: 10000 }),
      ]);
      const entries = getNitradoFileEntries(listRes);
      console.log(`   📁 Root entries: ${entries.map(e => e.name).join(', ')}`);

      const structure = inspectNitradoRootEntries(entries, gameserver);
      if (!structure.configPath) {
        availabilityTracker.recordUnavailable(serverId, nowMs());
        recordError(serverId, `Server ${serverId}: No DayZ config directory found`);
        continue;
      }
      availabilityTracker.recordAvailable(serverId);
      const configPathOnProvider = configListPathForStructure(structure);
      const configListRes = await http.get(`https://api.nitrado.net/services/${serverId}/gameservers/file_server/list?dir=${encodeURIComponent(configPathOnProvider)}`, { headers: { Authorization: 'Bearer ' + token }, timeout: 10000 });
      const configEntries = getLogSyncConfigEntries(configListRes);
      const configFiles = configEntries.validatedOtherEntries
        .filter(entry => entry?.type === 'file')
        .map(entry => validateLogFileEntry(configPathOnProvider, entry));

      const preflight = preflightLogArtifacts(
        configPathOnProvider,
        configPath,
        configEntries.listedLogEntries
      );
      for (const { file, error } of preflight.rejected) {
        recordError(serverId, `${file.name}: ${error.message}`, {
          blocksParsing: /\.ADM$/i.test(file.name),
          blocksRptParsing: /\.RPT$/i.test(file.name),
        });
      }
      const logFiles = selectLogSyncBatch(configPath, preflight.accepted, { gameserver });
      let serverLogEntry = configFiles.find(f => f.type === 'file' && f.name === 'server.log');
      if (!serverLogEntry) {
        // The noftp listing does not expose server.log on some console
        // servers; try the raw ftproot view where the file_server API
        // actually serves it.
        serverLogEntry = await fetchServerLogEntryFromRawConfigPath(http, token, serverId, structure);
      }
      if (preflight.accepted.length === 0) {
        recordError(serverId, `Server ${serverId}: No ADM/RPT log files found`);
      }
      if (!serverLogEntry) {
        recordError(serverId, `Server ${serverId}: No server.log file found (direct ftproot transfer refused and raw listing inconclusive)`, { blocksParsing: false });
      }

      let serverLogLocalPath = null;

      if (serverLogEntry) {
        const localPath = path.join(configPath, 'server.log');
        serverLogLocalPath = localPath;
        try {
          const fileState = classifyLogEntry(configPath, serverLogEntry);
          if (fileState) {
            const changed = await downloadActiveServerLog(token, serverId, serverLogEntry, localPath, {
              gameserver,
              configPathOnProvider,
            });
            if (!changed) totalFilesSkipped++;
            else if (fileState === 'new') totalFilesDownloaded++;
            else totalFilesUpdated++;
          }
        } catch (slErr) {
          console.error(`   ⚠️  Could not download server.log:`, slErr.message);
          recordError(serverId, `Server ${serverId} server.log: ${slErr.message}`, { blocksParsing: false });
          serverLogLocalPath = null;
        }
      }

      serverLogPaths[serverId] = serverLogLocalPath;

      for (const file of logFiles) {
        const localPath = path.join(configPath, file.name);
        try {
          const fileState = classifyLogEntry(configPath, file);
          if (fileState === 'new') {
            const changed = await downloadLogFile(token, serverId, file, localPath);
            if (changed) {
              totalFilesDownloaded++;
              serverChanged = true;
            } else {
              totalFilesSkipped++;
            }
          } else if (fileState === 'updated') {
            const changed = await downloadLogFile(token, serverId, file, localPath);
            if (changed) {
              totalFilesUpdated++;
              serverChanged = true;
            } else {
              totalFilesSkipped++;
            }
          } else {
            totalFilesSkipped++;
          }
        } catch (fileErr) {
          console.error(`   ❌ Error processing ${file.name}:`, fileErr.message);
          recordError(serverId, `${file.name}: ${fileErr.message}`, {
            blocksParsing: /\.ADM$/i.test(file.name),
            blocksRptParsing: /\.RPT$/i.test(file.name),
          });
        }
      }
      restartEvidence[serverId] = buildRestartEvidence(
        configPath,
        gameserver,
        serverLogLocalPath,
        preflight.accepted
      );
      if (serverChanged) changedServerIds.push(String(serverId));
    } catch (serverErr) { console.error(`❌ Error syncing server ${serverId}:`, serverErr.message); recordError(serverId, `Server ${serverId}: ${serverErr.message}`); }
  }

  return {
    totalFilesDownloaded,
    totalFilesUpdated,
    totalFilesSkipped,
    errors,
    blockingErrors,
    failedServerIds: Array.from(failedServerIds),
    parseBlockedServerIds: Array.from(parseBlockedServerIds),
    rptBlockedServerIds: Array.from(rptBlockedServerIds),
    serverLogPaths,
    restartEvidence,
    changedServerIds,
  };
}

async function performLogSyncConcurrent(
  db,
  userId,
  token,
  serverIds,
  authorizedServers = null,
  {
    respectAvailabilityBackoff = false,
    availabilityTracker = providerLogAvailability,
    nowMs = Date.now,
  } = {}
) {
  const globalConcurrency = parseInt(process.env.LOGSYNC_GLOBAL_CONCURRENCY || '2', 10);
  const perServerConcurrency = parseInt(process.env.LOGSYNC_PER_SERVER_CONCURRENCY || '3', 10);

  let totalFilesDownloaded = 0;
  let totalFilesUpdated = 0;
  let totalFilesSkipped = 0;
  const errors = [];
  const blockingErrors = [];
  const failedServerIds = new Set();
  const parseBlockedServerIds = new Set();
  const rptBlockedServerIds = new Set();
  const recordError = (
    serverId,
    message,
    { blocksParsing = true, blocksRptParsing = false } = {}
  ) => {
    errors.push(message);
    failedServerIds.add(String(serverId));
    if (blocksParsing) parseBlockedServerIds.add(String(serverId));
    if (blocksRptParsing) rptBlockedServerIds.add(String(serverId));
    if (blocksParsing) blockingErrors.push(message);
    // Log at the point of recording so a later "Sync run incomplete" can be
    // traced back to its cause (the concurrent path previously had no per-error
    // log line for silent failures like preflight rejections).
    console.error(`   ⚠️  [logsync] server ${serverId} rejected: ${message}${blocksParsing ? '' : ' (non-blocking)'}`);
  };
  const serverLogPaths = {};
  const restartEvidence = {};
  const changedServerIds = [];

  async function limitedParallel(items, worker, concurrency) {
    let i = 0;
    const pool = [];
    while (i < items.length) {
      while (pool.length < concurrency && i < items.length) {
        const item = items[i++];
        const p = (async () => worker(item))();
        p.finally(() => { const idx = pool.indexOf(p); if (idx >= 0) pool.splice(idx, 1); });
        pool.push(p);
      }
      if (pool.length > 0) await Promise.race(pool).catch(() => {});
    }
    await Promise.all(pool);
  }

  async function syncServer(serverId) {
    return telemetry.timeAsync(`logSync:server:${serverId}`, async () => {
      let serverChanged = false;
      try {
        console.log(`\n📥 Syncing logs from server ${serverId}...`);

        const authorizedServer = authorizedServers?.get(String(serverId)) ||
          await resolveOperationalServer(db, userId, serverId, token);
        if (!authorizedServer) { recordError(serverId, `Server ${serverId}: Could not authorize server credentials`); return; }
        if (respectAvailabilityBackoff && !availabilityTracker.canAttempt(serverId, nowMs())) {
          // Backoff is a temporary skip, not a failure (see legacy path above).
          recordError(serverId, `Server ${serverId}: DayZ log storage is temporarily backed off`, { blocksParsing: false });
          return;
        }
        const guildDiscordId = authorizedServer.guildDiscordId;

        const serverPath = getGuildDownloadPath(guildDiscordId, serverId);
        const configPath = path.join(serverPath, 'config');
        ensureContainedDirectorySync(DOWNLOAD_ROOT, path.relative(DOWNLOAD_ROOT, configPath));

        const [gameserver, listRes] = await Promise.all([
          nitradoService.getRawGameserver(token, serverId),
          http.get(`https://api.nitrado.net/services/${serverId}/gameservers/file_server/list`, { headers: { Authorization: 'Bearer ' + token }, timeout: 10000 }),
        ]);
        const entries = getNitradoFileEntries(listRes);
        const structure = inspectNitradoRootEntries(entries, gameserver);
        if (!structure.configPath) {
          availabilityTracker.recordUnavailable(serverId, nowMs());
          recordError(serverId, `Server ${serverId}: No DayZ config directory found`);
          return;
        }
        availabilityTracker.recordAvailable(serverId);
        const configPathOnProvider = configListPathForStructure(structure);
        const configListRes = await http.get(`https://api.nitrado.net/services/${serverId}/gameservers/file_server/list?dir=${encodeURIComponent(configPathOnProvider)}`, { headers: { Authorization: 'Bearer ' + token }, timeout: 10000 });

        const configEntries = getLogSyncConfigEntries(configListRes);
        const configFiles = configEntries.validatedOtherEntries
          .filter(entry => entry?.type === 'file')
          .map(entry => validateLogFileEntry(configPathOnProvider, entry));
        const preflight = preflightLogArtifacts(
          configPathOnProvider,
          configPath,
          configEntries.listedLogEntries
        );
        for (const { file, error } of preflight.rejected) {
          recordError(serverId, `${file.name}: ${error.message}`, {
            blocksParsing: /\.ADM$/i.test(file.name),
            blocksRptParsing: /\.RPT$/i.test(file.name),
          });
        }
        const logFiles = selectLogSyncBatch(configPath, preflight.accepted, { gameserver });
        let serverLogEntry = configFiles.find(f => f.type === 'file' && f.name === 'server.log');
        if (!serverLogEntry) {
          // The noftp listing does not expose server.log on some console
          // servers; try the raw ftproot view where the file_server API
          // actually serves it.
          serverLogEntry = await fetchServerLogEntryFromRawConfigPath(http, token, serverId, structure);
        }
        if (preflight.accepted.length === 0) {
          recordError(serverId, `Server ${serverId}: No ADM/RPT log files found`);
        }
        if (!serverLogEntry) {
          recordError(serverId, `Server ${serverId}: No server.log file found (direct ftproot transfer refused and raw listing inconclusive)`, { blocksParsing: false });
        }

        let serverLogLocalPath = null;

        const fileTasks = [];

        if (serverLogEntry) {
          const localPath = path.join(configPath, 'server.log');
          serverLogLocalPath = localPath;
          fileTasks.push(async () => {
            try {
              const fileState = classifyLogEntry(configPath, serverLogEntry);
              if (fileState) {
                const changed = await downloadActiveServerLog(token, serverId, serverLogEntry, localPath, {
                  gameserver,
                  configPathOnProvider,
                });
                if (!changed) totalFilesSkipped++;
                else if (fileState === 'new') totalFilesDownloaded++;
                else totalFilesUpdated++;
              }
            } catch (err) {
              console.error(`   ⚠️  Could not download server.log:`, err.message);
              recordError(serverId, `Server ${serverId} server.log: ${err.message}`, { blocksParsing: false });
              serverLogLocalPath = null;
            }
          });
        }

        for (const file of logFiles) {
          const localPath = path.join(configPath, file.name);
          fileTasks.push(async () => {
            try {
              const fileState = classifyLogEntry(configPath, file);
              if (fileState === 'new' || fileState === 'updated') {
                const changed = await downloadLogFile(token, serverId, file, localPath);
                if (changed) {
                  if (fileState === 'new') totalFilesDownloaded++;
                  else totalFilesUpdated++;
                  serverChanged = true;
                } else {
                  totalFilesSkipped++;
                }
              } else {
                totalFilesSkipped++;
              }
            } catch (err) {
              console.error(`   ❌ Error processing ${file.name}:`, err.message);
              recordError(serverId, `${file.name}: ${err.message}`, {
                blocksParsing: /\.ADM$/i.test(file.name),
                blocksRptParsing: /\.RPT$/i.test(file.name),
              });
            }
          });
        }

        await limitedParallel(fileTasks, task => task(), perServerConcurrency);

        serverLogPaths[serverId] = serverLogLocalPath;
        restartEvidence[serverId] = buildRestartEvidence(
          configPath,
          gameserver,
          serverLogLocalPath,
          preflight.accepted
        );
        if (serverChanged) changedServerIds.push(String(serverId));

      } catch (err) { console.error(`❌ Error syncing server ${serverId}:`, err.message); recordError(serverId, `Server ${serverId}: ${err.message}`); }
    });
  }

  await limitedParallel(serverIds, sid => syncServer(sid), globalConcurrency);

  return {
    totalFilesDownloaded,
    totalFilesUpdated,
    totalFilesSkipped,
    errors,
    blockingErrors,
    failedServerIds: Array.from(failedServerIds),
    parseBlockedServerIds: Array.from(parseBlockedServerIds),
    rptBlockedServerIds: Array.from(rptBlockedServerIds),
    serverLogPaths,
    restartEvidence,
    changedServerIds,
  };
}

async function syncLatestAdmForExactServer(db, serverId, token, {
  authorizeServer = resolveOperationalServerByInternalId,
  getRawGameserver = (...args) => nitradoService.getRawGameserver(...args),
  httpGet = (...args) => http.get(...args),
  downloadFile = downloadLogFile,
} = {}) {
  const server = await authorizeServer(db, serverId, token);
  if (!server || Number(server.id) !== Number(serverId)) {
    throw new Error(`Active exact server ${serverId} could not be authorized for ADM sync`);
  }

  const platformServerId = String(server.platformServerId);
  const serverPath = getGuildDownloadPath(server.guildDiscordId, platformServerId);
  const configPath = path.join(serverPath, 'config');
  ensureContainedDirectorySync(DOWNLOAD_ROOT, path.relative(DOWNLOAD_ROOT, configPath));

  const [gameserver, listRes] = await Promise.all([
    getRawGameserver(token, platformServerId),
    httpGet(
      `https://api.nitrado.net/services/${platformServerId}/gameservers/file_server/list`,
      { headers: { Authorization: 'Bearer ' + token }, timeout: 10000 }
    ),
  ]);
  const structure = inspectNitradoRootEntries(getNitradoFileEntries(listRes), gameserver);
  if (!structure.configPath) throw new ProviderLogStorageUnavailableError(platformServerId);

  const configPathOnProvider = configListPathForStructure(structure);
  const configListRes = await httpGet(
    `https://api.nitrado.net/services/${platformServerId}/gameservers/file_server/list?dir=${encodeURIComponent(configPathOnProvider)}`,
    { headers: { Authorization: 'Bearer ' + token }, timeout: 10000 }
  );
  const configEntries = getLogSyncConfigEntries(configListRes);
  const listedAdmEntries = configEntries.listedLogEntries.filter(entry => /\.ADM$/i.test(entry?.name || ''));
  const preflight = preflightLogArtifacts(configPathOnProvider, configPath, listedAdmEntries);
  if (preflight.rejected.length > 0) {
    throw new Error(`Nitrado returned ${preflight.rejected.length} invalid ADM artifact(s)`);
  }

  const selected = selectLatestAdmEntries(preflight.accepted);
  if (selected.length === 0) throw new Error('No ADM log files found');

  let changed = false;
  for (const entry of selected) {
    const localPath = path.join(configPath, entry.name);
    if (await downloadFile(token, platformServerId, entry, localPath)) changed = true;
  }

  const latest = selected[selected.length - 1];
  return {
    changed,
    platformServerId,
    marker: selected.map(entry => `${entry.name}:${entry.modified_at ?? ''}:${entry.size}`).join('|'),
    admFiles: selected.map(entry => ({
      name: entry.name,
      remotePath: entry.path,
      localPath: path.join(configPath, entry.name),
      size: entry.size,
      modifiedAt: entry.modified_at ?? null,
    })),
    sourceObservedAt: latest.modified_at ?? null,
    sourceObservedLogFile: path.join(configPath, latest.name),
  };
}

async function performExactServerLogSync(db, serverId, token) {
  const server = await resolveOperationalServerByInternalId(db, serverId, token);
  if (!server) throw new Error(`Active exact server ${serverId} could not be authorized for log sync`);
  return performLogSyncConcurrent(
    db,
    null,
    token,
    [server.platformServerId],
    new Map([[server.platformServerId, server]])
  );
}

module.exports = {
  sanitizeFilename,
  normalizeNitradoFilePath,
  validateLogFileEntry,
  classifyLogEntry,
  selectLatestAdmEntries,
  providerModifiedAtMs,
  selectLogSyncBatch,
  buildRestartEvidence,
  getGuildDownloadPath,
  getUserDownloadPath,
  resolveGuildDiscordId,
  resolveOperationalServers,
  resolveOperationalServer,
  resolveOperationalServerByInternalId,
  getDecryptedToken,
  downloadActiveServerLog,
  downloadLogFile,
  fetchServerLogEntryFromRawConfigPath,
  createFtprootListingBreaker,
  resetFtprootListingBreaker,
  syncLatestAdmForExactServer,
  performLogSync,
  performLogSyncConcurrent,
  performExactServerLogSync,
};
