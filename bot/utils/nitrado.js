/*
 * bot/utils/nitrado.js
 *
 * Shared helpers for Nitrado API calls used by bot commands.
 * Handles server credential lookup and provider list-file reads/writes.
 *
 * File paths are built dynamically from the server's Nitrado username (no hardcoded paths).
 */

const axios = require('../../utils/nitradoHttp');
const { getNitradoTransferToken, getNitradoTextBody } = require('../../utils/nitradoHttp');
const nitradoService = require('../../services/nitradoService');
const { detectDayzPlatform, resolveGameDataPath } = require('../../utils/dayzPlatform');
const { assertProviderListVerified } = require('../../utils/providerListVerification');
const { mutateProviderList } = require('../../services/providerListMutationService');
const missionFileService = require('../../services/missionFileService');
const PostgreSQLAdapter = require('../../db/abstraction/postgres');
const FormData = require('form-data');
// pool and decryptToken are required lazily inside functions so that
// deploy-commands.js can import command files without needing the DB connection.

const NITRADO_BASE = 'https://api.nitrado.net';

/**
 * Fetches the raw gameserver object from the Nitrado API.
 * Returns null on failure.
 */
async function fetchGameserver(token, platformServerId) {
  try {
    return await nitradoService.getRawGameserver(token, platformServerId);
  } catch {
    return null;
  }
}

/**
 * Looks up the active server + decrypted Nitrado token for a Discord guild.
 * Also fetches the server's Nitrado username so file paths can be built dynamically.
 *
 * Returns { token, platformServerId, serverName, serverId, username, gameserver }
 * or null if no server/token is registered for the guild.
 */
function serverSelectionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function selectServerForGuild(servers, requestedServerId) {
  if (!Array.isArray(servers) || servers.length === 0) {
    throw serverSelectionError('SERVER_NOT_FOUND', 'No active DayZ server is registered for this guild.');
  }

  if (requestedServerId !== undefined && requestedServerId !== null && requestedServerId !== '') {
    const requested = String(requestedServerId);
    const selected = servers.find(server =>
      String(server.id) === requested || String(server.platform_server_id) === requested
    );
    if (!selected) {
      throw serverSelectionError('SERVER_NOT_FOUND', 'The selected server is not registered to this guild.');
    }
    return selected;
  }

  if (servers.length !== 1) {
    throw serverSelectionError(
      'SERVER_SELECTION_REQUIRED',
      'This guild has multiple DayZ servers. Select a server explicitly.'
    );
  }
  return servers[0];
}

async function getServerCreds(guildDiscordId, requestedServerId = null, authorizedServerId = null) {
  const pool = require('../db');
  const { decryptToken } = require('../../utils/encryption');
  const guildRes = await pool.query(
    `SELECT id FROM guilds
     WHERE discord_guild_id = $1 AND status = 'approved'`,
    [guildDiscordId]
  );
  if (!guildRes.rows[0]) return null;
  const guildDbId = guildRes.rows[0].id;

  const serverRes = await pool.query(
    `SELECT s.id, s.platform_server_id, s.name, gt.token_hash
     FROM servers s
     JOIN guild_tokens gt ON gt.guild_id = s.guild_id AND gt.token_type = 'nitrado'
     WHERE s.guild_id = $1
       AND s.status = 'active'
       AND gt.nitrado_user_id IS NOT NULL
     ORDER BY s.id ASC`,
    [guildDbId]
  );
  if (!serverRes.rows[0]) return null;

  const selectedServer = selectServerForGuild(serverRes.rows, requestedServerId);
  if (authorizedServerId === null || Number(selectedServer.id) !== Number(authorizedServerId)) {
    throw serverSelectionError('SERVER_AUTHORIZATION_MISMATCH', 'The selected server was not authorized.');
  }
  const { id, platform_server_id, name, token_hash } = selectedServer;
  const token = decryptToken(token_hash);

  // Fetch live server data to get the Nitrado username for dynamic path construction
  const gameserver = await fetchGameserver(token, platform_server_id);
  const username = gameserver?.username || null;

  return {
    token,
    platformServerId: platform_server_id,
    serverName: name,
    serverId: id,
    username,
    gameserver,
    platform: detectDayzPlatform(gameserver),
    game: gameserver?.game || null,
  };
}

/**
 * Constructs platform-specific Nitrado list-file paths.
 */
function getFilePaths(gameserver) {
  const dataPath = resolveGameDataPath(gameserver);
  const namespace = dataPath.match(/^(\/games\/[^/]+)\/(?:noftp|ftproot)\//)?.[1];
  if (!namespace) throw new Error('Nitrado service path is unavailable');
  return {
    ftpBase: `${dataPath}/`,
    ftpRootBase: `${namespace}/ftproot/`
  };
}

/**
 * Convert a Nitrado API/listing path to the path exposed by the FTP account.
 * API paths include the per-service /games/.../(ftproot|noftp) prefix, while
 * FTP sessions start directly at that virtual root.
 */
function toNitradoFtpPath(filePath) {
  const value = String(filePath || '');
  const match = value.match(/^\/games\/[^/]+\/(?:ftproot|noftp)(\/.*)$/);
  return match ? match[1] : value;
}

/**
 * Downloads a file from the Nitrado file server and returns its lines as an array.
 * Returns [] if the file does not exist (404).
 */
async function readNitradoList(token, platformServerId, filePath) {
  let tokenRes;
  try {
    tokenRes = await axios.get(
      `${NITRADO_BASE}/services/${platformServerId}/gameservers/file_server/download`,
      {
        params: { file: filePath },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      }
    );
  } catch (err) {
    // Nitrado returns 404 or 500 when the file does not exist yet — treat both as empty
    if (err.response?.status === 404 || err.response?.status === 500) return [];
    throw err;
  }

  const { url: downloadUrl } = getNitradoTransferToken(tokenRes);

  const fileRes = await axios.get(downloadUrl, { responseType: 'text', timeout: 15000 });
  const content = getNitradoTextBody(fileRes);
  return content.split('\n').map(l => l.trim()).filter(Boolean);
}

/**
 * Uploads an array of lines to a file on the Nitrado file server (two-step process:
 * first request an upload token, then POST the actual content).
 */
async function writeNitradoList(token, platformServerId, dir, filename, lines) {
  const content = lines.join('\n') + (lines.length ? '\n' : '');

  // Step 1: request an upload token from Nitrado
  const formData = new FormData();
  formData.append('path', dir);
  formData.append('file', filename);

  const step1 = await axios.post(
    `${NITRADO_BASE}/services/${platformServerId}/gameservers/file_server/upload`,
    formData,
    {
      headers: { Authorization: `Bearer ${token}`, ...formData.getHeaders() },
      timeout: 10000
    }
  );

  const { url: uploadUrl, token: uploadToken } = getNitradoTransferToken(step1, { requireToken: true });

  // Step 2: upload the actual file content to the signed URL
  await axios.post(uploadUrl, Buffer.from(content, 'utf8'), {
    headers: { token: uploadToken, 'Content-Type': 'application/octet-stream' },
    timeout: 15000
  });
  const filePath = `${String(dir).replace(/\/?$/, '/')}${filename}`;
  const verifiedLines = await readNitradoList(token, platformServerId, filePath);
  assertProviderListVerified(lines, verifiedLines);
}

async function assertBotProviderMutationContext(db, {
  serverId,
  platformServerId,
  guildDiscordId,
  token,
}) {
  const authorized = await db.get(
    `SELECT s.id, gt.token_hash
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id
     JOIN guild_tokens gt ON gt.guild_id = g.id
       AND gt.token_type = 'nitrado' AND gt.nitrado_user_id IS NOT NULL
     WHERE s.id = ?
       AND s.status = 'active'
       AND g.status = 'approved'
       AND s.platform_server_id = ?
       AND g.discord_guild_id = ?
     FOR NO KEY UPDATE OF s, g, gt`,
    [Number(serverId), String(platformServerId), String(guildDiscordId)]
  );
  const { decryptToken } = require('../../utils/encryption');
  if (!authorized || decryptToken(authorized.token_hash) !== token) {
    const error = new Error('Bot provider mutation context changed before execution');
    error.code = 'SERVER_AUTHORIZATION_MISMATCH';
    throw error;
  }
}

async function mutateNitradoList({
  serverId,
  platformServerId,
  token,
  dir,
  filename,
  listType,
  action,
  triggeredBy,
  guildDiscordId,
  authorizeActor,
  mutate,
}) {
  if (typeof authorizeActor !== 'function') {
    throw new TypeError('Bot provider mutation actor authorization is required');
  }
  const pool = require('../db');
  const db = new PostgreSQLAdapter();
  db.pool = pool;
  const outcome = await mutateProviderList({
    db,
    internalServerId: serverId,
    platformServerId,
    token,
    dir,
    filename,
    listType,
    action,
    triggeredBy,
    mutate,
    beforeMutation: async transactionDb => {
      await assertBotProviderMutationContext(transactionDb, {
        serverId,
        platformServerId,
        guildDiscordId,
        token,
      });
      await authorizeActor();
    },
    fileService: missionFileService,
  });
  return outcome.result;
}

module.exports = {
  getServerCreds,
  selectServerForGuild,
  getFilePaths,
  toNitradoFtpPath,
  readNitradoList,
  writeNitradoList,
  mutateNitradoList,
  fetchGameserver,
};
