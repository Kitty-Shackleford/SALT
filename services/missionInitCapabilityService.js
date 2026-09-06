'use strict';

const crypto = require('crypto');
const net = require('net');
const path = require('path');
const defaultHttp = require('../utils/nitradoHttp');
const defaultNitradoService = require('./nitradoService');
const {
  assertMissionPathComponent,
  getNitradoBinaryBody,
  getNitradoFileEntries,
  getNitradoTransferToken,
} = require('../utils/nitradoHttp');
const {
  CAPABILITIES,
  authorizeServer: defaultAuthorizeServer,
  authorizeServerMutation: defaultAuthorizeServerMutation,
} = require('./authorizationService');
const {
  detectDayzPlatform,
  inspectNitradoRootEntries,
} = require('../utils/dayzPlatform');
const { createPublicAddressLookup, isPublicAddress } = require('../utils/publicAddressLookup');

const DEFAULT_MAX_INIT_BYTES = 256 * 1024;
const DEFAULT_MAX_LISTING_BYTES = 512 * 1024;

function unknownReason(error) {
  if (error?.code === 'NITRADO_TIMEOUT') return 'provider_timeout';
  if (error?.code === 'NITRADO_CANCELLED') return 'provider_cancelled';
  if (error?.code === 'NITRADO_RATE_LIMITED') return 'provider_rate_limited';
  if (error?.code === 'NITRADO_INVALID_RESPONSE') return 'provider_invalid_response';
  if (error?.code === 'INIT_C_TOO_LARGE') return 'init_c_too_large';
  return 'provider_unavailable';
}

function publicCapability({ now, platform, activeMission, status, reasonCode, readable, extra = {} }) {
  return {
    capability: 'mission.init_c',
    status,
    reasonCode,
    platform,
    activeMission,
    observedAt: now().toISOString(),
    readable,
    writable: false,
    runtimeVerified: false,
    supportLevel: status === 'supported' ? 'readable' : (status === 'absent' ? 'unsupported' : 'unknown'),
    rolloutEnabled: platform === 'pc' && status === 'supported',
    ...extra,
  };
}

function invalidListing() {
  const error = new Error('Nitrado returned an invalid active mission listing');
  error.code = 'NITRADO_INVALID_RESPONSE';
  return error;
}

function assertPositiveSafeInteger(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function createMissionInitCapabilityService(options = {}) {
  const http = options.http || defaultHttp;
  const nitradoService = options.nitradoService || defaultNitradoService;
  const now = options.now || (() => new Date());
  const maxBytes = assertPositiveSafeInteger(
    options.maxBytes ?? DEFAULT_MAX_INIT_BYTES,
    'maxBytes'
  );
  const maxListingBytes = assertPositiveSafeInteger(
    options.maxListingBytes ?? DEFAULT_MAX_LISTING_BYTES,
    'maxListingBytes'
  );
  const publicAddressLookup = options.publicAddressLookup || createPublicAddressLookup();

  function transferRequestOptions(transferUrl) {
    const parsedUrl = new URL(transferUrl);
    const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
    if (parsedUrl.username || parsedUrl.password ||
        (net.isIP(hostname) && !isPublicAddress(hostname))) {
      throw invalidListing();
    }
    return {
      responseType: 'arraybuffer',
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      maxRedirects: 0,
      proxy: false,
      lookup: publicAddressLookup,
    };
  }

  async function probe({
    platformServerId,
    token,
    includeContent = false,
    includeProviderPath = false,
  }) {
    let platform = 'unknown';
    let activeMission = null;
    try {
      const baseUrl = `https://api.nitrado.net/services/${encodeURIComponent(platformServerId)}/gameservers`;
      const headers = { Authorization: `Bearer ${token}` };
      const gameserver = await nitradoService.getRawGameserverFresh(token, platformServerId);
      platform = detectDayzPlatform(gameserver);
      activeMission = assertMissionPathComponent(
        gameserver?.settings?.config?.mission || gameserver?.query?.map
      );
      const listingOptions = {
        headers,
        maxContentLength: maxListingBytes,
        maxBodyLength: maxListingBytes,
      };
      const rootResponse = await http.get(`${baseUrl}/file_server/list`, listingOptions);
      const structure = inspectNitradoRootEntries(getNitradoFileEntries(rootResponse), gameserver);
      if (!structure.missionsPath || structure.platform !== platform) throw invalidListing();
      const activeMissionPath = path.posix.join(structure.missionsPath, activeMission);
      const listingResponse = await http.get(
        `${baseUrl}/file_server/list?dir=${encodeURIComponent(activeMissionPath)}`,
        listingOptions
      );
      const entries = getNitradoFileEntries(listingResponse);
      const initPath = path.posix.join(activeMissionPath, 'init.c');
      const namedMatches = entries.filter(entry => entry.name === 'init.c');
      if (namedMatches.length === 0) {
        return publicCapability({
          now,
          platform,
          activeMission,
          status: 'absent',
          reasonCode: 'init_c_absent',
          readable: false,
        });
      }
      if (namedMatches.length !== 1 || namedMatches[0].type !== 'file' || namedMatches[0].path !== initPath) {
        throw invalidListing();
      }
      const advertisedSizeValue = namedMatches[0].size;
      if ((typeof advertisedSizeValue !== 'number' && typeof advertisedSizeValue !== 'string') ||
          Object.is(advertisedSizeValue, -0)) {
        throw invalidListing();
      }
      const advertisedSizeText = String(advertisedSizeValue);
      if (!/^(0|[1-9]\d*)$/.test(advertisedSizeText)) {
        throw invalidListing();
      }
      const advertisedSize = Number(advertisedSizeText);
      if (!Number.isSafeInteger(advertisedSize) || advertisedSize < 0) {
        throw invalidListing();
      }
      if (advertisedSize > maxBytes) {
        const error = new Error('Active mission init.c exceeds the supported size limit');
        error.code = 'INIT_C_TOO_LARGE';
        throw error;
      }

      const transferResponse = await http.get(
        `${baseUrl}/file_server/download?file=${encodeURIComponent(initPath)}`,
        {
          headers,
          maxContentLength: maxListingBytes,
          maxBodyLength: maxListingBytes,
        }
      );
      const transfer = getNitradoTransferToken(transferResponse);
      const contentResponse = await http.get(
        transfer.url,
        transferRequestOptions(transfer.url)
      );
      const bytes = Buffer.from(getNitradoBinaryBody(contentResponse));
      if (bytes.length > maxBytes) {
        const error = new Error('Active mission init.c exceeds the supported size limit');
        error.code = 'INIT_C_TOO_LARGE';
        throw error;
      }
      if (bytes.length !== advertisedSize) {
        throw invalidListing();
      }
      let content;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (_) {
        throw invalidListing();
      }
      return publicCapability({
        now,
        platform,
        activeMission,
        status: 'supported',
        reasonCode: 'init_c_readable',
        readable: true,
        extra: {
          size: bytes.length,
          hash: crypto.createHash('sha256').update(bytes).digest('hex'),
          ...(includeContent ? { content } : {}),
          ...(includeProviderPath ? { providerPath: initPath } : {}),
        },
      });
    } catch (error) {
      return publicCapability({
        now,
        platform,
        activeMission,
        status: 'unknown',
        reasonCode: unknownReason(error),
        readable: false,
      });
    }
  }

  return { probe };
}

function controlledError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function parseInternalServerId(value) {
  const text = String(value || '');
  if (!/^[1-9]\d*$/.test(text)) {
    throw controlledError(400, 'INVALID_SERVER_ID', 'A valid internal server ID is required');
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw controlledError(400, 'INVALID_SERVER_ID', 'A valid internal server ID is required');
  }
  return parsed;
}

function createMissionInitAccessService(options = {}) {
  const authorizeServer = options.authorizeServer || defaultAuthorizeServer;
  const authorizeServerMutation = options.authorizeServerMutation ||
    options.authorizeServer || defaultAuthorizeServerMutation;
  const decryptToken = options.decryptToken || require('../utils/encryption').decryptToken;
  const capabilityService = options.capabilityService || createMissionInitCapabilityService(options);

  async function probeForActor({ db, actor, internalServerId, includeContent = false }) {
    const serverId = parseInternalServerId(internalServerId);
    const authorization = await authorizeServer(
      db,
      actor,
      serverId,
      CAPABILITIES.SERVER_MANAGE
    );
    if (!authorization) {
      throw controlledError(404, 'SERVER_NOT_FOUND', 'Server not found');
    }
    const row = await db.get(
      `SELECT s.platform_server_id, gt.token_hash
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
       JOIN guild_tokens gt ON gt.guild_id = g.id AND gt.token_type = 'nitrado'
       WHERE s.id = ? AND s.guild_id = ?
         AND s.status = 'active' AND g.status = 'approved'
         AND gt.nitrado_user_id IS NOT NULL
       LIMIT 1`,
      [authorization.server.id, authorization.guild.id]
    );
    if (!row?.platform_server_id || !row?.token_hash ||
        String(row.platform_server_id) !== String(authorization.server.platformServerId)) {
      throw controlledError(409, 'NITRADO_CONTEXT_UNAVAILABLE', 'Nitrado access is unavailable for this server');
    }
    const token = decryptToken(row.token_hash);
    if (!token) {
      throw controlledError(409, 'NITRADO_CONTEXT_UNAVAILABLE', 'Nitrado access is unavailable for this server');
    }
    return capabilityService.probe({
      platformServerId: String(row.platform_server_id),
      token,
      includeContent,
    });
  }

  async function resolveDeploymentContext({ db, actor, internalServerId }) {
    const serverId = parseInternalServerId(internalServerId);
    const authorization = await authorizeServerMutation(
      db,
      actor,
      serverId,
      CAPABILITIES.SERVER_MANAGE
    );
    if (!authorization) {
      throw controlledError(404, 'SERVER_NOT_FOUND', 'Server not found');
    }
    const row = await db.get(
      `SELECT s.platform_server_id, gt.token_hash
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
       JOIN guild_tokens gt ON gt.guild_id = g.id AND gt.token_type = 'nitrado'
       WHERE s.id = ? AND s.guild_id = ?
         AND s.status = 'active' AND g.status = 'approved'
         AND gt.nitrado_user_id IS NOT NULL
       LIMIT 1
       FOR NO KEY UPDATE OF s, g, gt`,
      [authorization.server.id, authorization.guild.id]
    );
    if (!row?.platform_server_id || !row?.token_hash ||
        String(row.platform_server_id) !== String(authorization.server.platformServerId)) {
      throw controlledError(409, 'NITRADO_CONTEXT_UNAVAILABLE', 'Nitrado access is unavailable for this server');
    }
    const token = decryptToken(row.token_hash);
    if (!token) {
      throw controlledError(409, 'NITRADO_CONTEXT_UNAVAILABLE', 'Nitrado access is unavailable for this server');
    }
    const platformServerId = String(row.platform_server_id);
    const capability = await capabilityService.probe({
      platformServerId,
      token,
      includeContent: true,
      includeProviderPath: true,
    });
    if (capability.status !== 'supported' || !capability.rolloutEnabled ||
        capability.platform !== 'pc' || typeof capability.content !== 'string' ||
        typeof capability.providerPath !== 'string') {
      throw controlledError(409, 'MISSION_INIT_DEPLOYMENT_UNAVAILABLE',
        'Mission init deployment is unavailable for this server');
    }
    return {
      platformServerId,
      token,
      filePath: capability.providerPath,
      sourceHash: capability.hash,
    };
  }

  return { probeForActor, resolveDeploymentContext };
}

module.exports = {
  DEFAULT_MAX_INIT_BYTES,
  DEFAULT_MAX_LISTING_BYTES,
  createMissionInitCapabilityService,
  createMissionInitAccessService,
};
