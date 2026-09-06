const express = require('express');
const router = express.Router();
const { decryptToken } = require('../utils/encryption');
const {
  ensureApprovedGuildOperator,
  ensureGuildOwner,
  ensurePlatformServerOwner,
} = require('../middleware/serverAccess');
const nitradoService = require('../services/nitradoService');
const { mutateProviderSettings } = require('../services/providerSettingMutationService');
const { sendExternalApiError } = require('../utils/externalApiResponse');
const { isConsolePlatform, platformLabel } = require('../utils/dayzPlatform');
const { normalizeNitradoServiceId } = require('../utils/nitradoIds');
const {
  classifyNitradoHostname,
  nitradoHostnameValue,
  normalizeProviderServerName,
  normalizeCustomServerName,
  resolveServerDisplayName,
} = require('../utils/serverNames');

function parseCustomNameConfig(value) {
  if (!value) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return normalizeCustomServerName(parsed?.value);
  } catch (_) {
    return null;
  }
}

function providerNameFor(service) {
  return normalizeProviderServerName(service?.name, service?.id);
}

async function assertCurrentGuildOwner(db, guildId, userId) {
  const owner = await db.get(
    `SELECT g.id
     FROM guilds g
     JOIN guild_roles gr ON gr.guild_id = g.id
     WHERE g.id = ?
       AND g.status = 'approved'
       AND gr.user_id = ?
       AND gr.role = 'owner'
     FOR UPDATE OF g, gr`,
    [guildId, userId]
  );
  if (!owner) {
    const error = new Error('Guild owner access was revoked; retry after refreshing');
    error.statusCode = 403;
    throw error;
  }
}

async function assertCurrentPlatformServerOperator(db, access, userId) {
  const operator = await db.get(
    `SELECT s.id
     FROM guilds g
     JOIN servers s ON s.guild_id = g.id
     WHERE g.id = ?
       AND g.status = 'approved'
       AND s.id = ?
       AND s.platform_server_id = ?
       AND s.status = 'active'
       AND (
         EXISTS (
           SELECT 1 FROM guild_roles gr
           WHERE gr.guild_id = g.id AND gr.user_id = ? AND gr.role IN ('owner', 'admin')
         )
         OR EXISTS (
           SELECT 1 FROM server_role_assignments sra
           WHERE sra.server_id = s.id AND sra.guild_id = s.guild_id
             AND sra.user_id = ? AND sra.role = 'admin' AND sra.status = 'active'
         )
       )
     FOR UPDATE OF g, s`,
    [access.guildId, access.serverId, access.platformServerId, userId, userId]
  );
  if (!operator) {
    const error = new Error('Server operator access was revoked; retry after refreshing');
    error.statusCode = 403;
    throw error;
  }
  return operator;
}

async function getVerifiedGuildServices(db, guildId, options = {}) {
  const lockClause = options.forUpdate ? ' FOR UPDATE' : '';
  const tokenRow = await db.get(
    `SELECT token_hash, nitrado_user_id
     FROM guild_tokens
     WHERE guild_id = ?
       AND token_type = 'nitrado'
       AND nitrado_user_id IS NOT NULL${lockClause}`,
    [guildId]
  );
  if (!tokenRow?.token_hash) {
    const error = new Error('This guild does not have a verified Nitrado account binding');
    error.statusCode = 403;
    throw error;
  }

  const token = decryptToken(tokenRow.token_hash);
  const [services, identity] = await Promise.all([
    nitradoService.listGameServers(token),
    nitradoService.getAuthenticatedUser(token),
  ]);
  if (String(identity.id) !== String(tokenRow.nitrado_user_id)) {
    const error = new Error('The current Nitrado credential no longer matches the bound account');
    error.statusCode = 409;
    throw error;
  }
  return { services, token, tokenRow };
}

function accountServiceOrThrow(services, serviceId) {
  const service = services.find(item => String(item.id) === serviceId);
  if (!service) {
    const error = new Error('This DayZ service is not available on the bound Nitrado account');
    error.statusCode = 403;
    throw error;
  }
  return service;
}

function namingError(res, error, operation) {
  if (error.status || error.statusCode || error.code === '23505') {
    const status = error.status || error.statusCode || 409;
    return res.status(status).json({
      success: false,
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  }
  console.error(`❌ Error ${operation}:`, error.code || error.name);
  return sendExternalApiError(res, error, 'Nitrado');
}


/**
 * POST /api/nitrado/register-server
 * Manual registration was replaced by the account-derived dashboard toggles.
 */
router.post('/register-server', ensureGuildOwner, (req, res) => {
  res.status(410).json({
    success: false,
    error: 'Manual server registration is disabled. Use the Nitrado server toggles on the dashboard.',
  });
});

/** List the bound account's DayZ services and exact-guild selection state. */
router.get('/account-servers', ensureGuildOwner, async (req, res) => {
  const db = req.app.locals.db;
  try {
    const { services } = await getVerifiedGuildServices(db, req.guildAccess.guildId);
    const registered = await db.query(
      `SELECT s.id, s.platform_server_id, s.status, s.name, s.platform, sf.config AS custom_name_config
       FROM servers s
       LEFT JOIN server_features sf
         ON sf.server_id = s.id AND sf.feature_name = 'custom_name'
       WHERE s.guild_id = ?`,
      [req.guildAccess.guildId]
    );
    const byServiceId = new Map(registered.map(row => [String(row.platform_server_id), row]));
    const accountServers = services.map(service => {
      const registeredServer = byServiceId.get(String(service.id));
      const customName = parseCustomNameConfig(registeredServer?.custom_name_config);
      const providerName = providerNameFor(service);
      return {
        serviceId: String(service.id),
        providerName,
        customName,
        displayName: resolveServerDisplayName(providerName, customName, service.id),
        platform: service.platform,
        platformLabel: platformLabel(service.platform),
        providerStatus: service.status,
        enabled: registeredServer?.status === 'active',
        registeredServerId: registeredServer?.id || null,
      };
    });
    res.json({ success: true, servers: accountServers });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    console.error('❌ Error listing account servers:', error.code || error.name);
    return sendExternalApiError(res, error, 'Nitrado');
  }
});

/** Enable/disable one account-derived service and optionally set its display name. */
router.put('/account-servers/:serviceId', ensureGuildOwner, async (req, res) => {
  const serviceId = String(req.params.serviceId || '');
  const { enabled } = req.body || {};
  if (!/^\d+$/.test(serviceId)) {
    return res.status(400).json({ success: false, error: 'Invalid Nitrado service ID' });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
  }

  const hasCustomName = Object.prototype.hasOwnProperty.call(req.body || {}, 'customName');
  let requestedCustomName;
  try {
    requestedCustomName = hasCustomName ? normalizeCustomServerName(req.body.customName) : undefined;
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }

  const db = req.app.locals.db;
  try {
    const result = await db.transaction(async () => {
      await assertCurrentGuildOwner(db, req.guildAccess.guildId, req.user.id);
      const { services } = await getVerifiedGuildServices(db, req.guildAccess.guildId, { forUpdate: true });
      const service = services.find(item => String(item.id) === serviceId);
      if (!service) {
        const error = new Error('This DayZ service is not available on the bound Nitrado account');
        error.statusCode = 403;
        throw error;
      }
      if (!['xbox', 'playstation', 'switch2', 'pc'].includes(service.platform)) {
        const error = new Error('This DayZ service uses an unsupported platform');
        error.statusCode = 422;
        throw error;
      }

      const existing = await db.get(
        'SELECT id, guild_id, status FROM servers WHERE platform_server_id = ? FOR UPDATE',
        [serviceId]
      );
      if (existing && Number(existing.guild_id) !== Number(req.guildAccess.guildId)) {
        const error = new Error('This Nitrado service is already assigned to another Discord guild');
        error.statusCode = 409;
        throw error;
      }
      if (!existing && !enabled && hasCustomName) {
        const error = new Error('Enable this server before saving a custom name');
        error.statusCode = 409;
        throw error;
      }

      let existingCustomName = null;
      if (existing) {
        const customFeature = await db.get(
          `SELECT config FROM server_features
           WHERE server_id = ? AND feature_name = 'custom_name'`,
          [existing.id]
        );
        existingCustomName = parseCustomNameConfig(customFeature?.config);
      }
      const customName = hasCustomName ? requestedCustomName : existingCustomName;
      const providerName = providerNameFor(service);
      const displayName = resolveServerDisplayName(providerName, customName, serviceId);

      let serverId = existing?.id || null;
      if (existing) {
        if (!enabled) {
          const activeBounty = await db.get(
            `SELECT id FROM bounties
             WHERE server_id = ? AND status = 'active'
             ORDER BY id LIMIT 1 FOR UPDATE`,
            [existing.id]
          );
          const activeCasino = await db.get(
            `SELECT session_id FROM casino_sessions
             WHERE server_id = ? AND status = 'active' AND reserved_wager > 0
             ORDER BY session_id LIMIT 1 FOR UPDATE`,
            [existing.id]
          );
          if (activeBounty || activeCasino) {
            const error = new Error('Server cannot be disabled while active financial escrow exists');
            error.statusCode = 409;
            throw error;
          }
        }
        await db.run(
          `UPDATE servers
           SET name = ?, platform = ?, status = ?
           WHERE id = ? AND guild_id = ?`,
          [displayName, service.platform, enabled ? 'active' : 'inactive', existing.id, req.guildAccess.guildId]
        );
      } else if (enabled) {
        const insert = await db.run(
          `INSERT INTO servers (guild_id, platform_server_id, name, platform, status)
           VALUES (?, ?, ?, ?, 'active')
           RETURNING id`,
          [req.guildAccess.guildId, serviceId, displayName, service.platform]
        );
        serverId = insert.lastID;
      }

      if (serverId && hasCustomName) {
        if (customName) {
          await db.run(
            `INSERT INTO server_features (server_id, feature_name, enabled, config, updated_at)
             VALUES (?, 'custom_name', 1, ?, CURRENT_TIMESTAMP)
             ON CONFLICT (server_id, feature_name) DO UPDATE SET
               enabled = 1, config = EXCLUDED.config, updated_at = CURRENT_TIMESTAMP`,
            [serverId, JSON.stringify({ value: customName })]
          );
        } else {
          await db.run(
            `DELETE FROM server_features
             WHERE server_id = ? AND feature_name = 'custom_name'`,
            [serverId]
          );
        }
      }

      return {
        serviceId,
        registeredServerId: serverId,
        providerName,
        customName,
        displayName,
        platform: service.platform,
        platformLabel: platformLabel(service.platform),
        enabled: Boolean(serverId && enabled),
      };
    });
    return res.json({ success: true, server: result });
  } catch (error) {
    if (error.code === 'P0001') {
      return res.status(409).json({
        success: false,
        error: 'Server cannot be disabled while active financial escrow or teleport state exists',
      });
    }
    if (error.statusCode || error.code === '23505') {
      return res.status(error.statusCode || 409).json({
        success: false,
        error: error.statusCode ? error.message : 'This Nitrado service is already assigned',
      });
    }
    console.error('❌ Error updating account server selection:', error.code || error.name);
    return sendExternalApiError(res, error, 'Nitrado');
  }
});

/** Return safe application naming state without exposing raw control characters. */
router.get('/account-servers/:serviceId/naming', ensurePlatformServerOwner, async (req, res) => {
  let serviceId;
  try {
    serviceId = normalizeNitradoServiceId(req.params.serviceId);
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }

  const db = req.app.locals.db;
  try {
    const { services, token } = await getVerifiedGuildServices(db, req.platformServerAccess.guildId);
    const service = accountServiceOrThrow(services, serviceId);
    const server = await db.get(
      `SELECT s.id, s.name, sf.config AS custom_name_config
       FROM servers s
       LEFT JOIN server_features sf
         ON sf.server_id = s.id AND sf.feature_name = 'custom_name'
       WHERE s.platform_server_id = ? AND s.guild_id = ? AND s.status = 'active'`,
      [serviceId, req.platformServerAccess.guildId]
    );
    if (!server) return res.status(404).json({ success: false, error: 'Active server not found' });

    const supportsInvisibleHostname = isConsolePlatform(service.platform);
    const hostnameState = supportsInvisibleHostname
      ? classifyNitradoHostname((await nitradoService.getSettings(token, serviceId))?.config?.hostname)
      : { mode: 'unsupported', hostname: null };
    const customName = parseCustomNameConfig(server.custom_name_config);
    const providerName = providerNameFor(service);
    return res.json({
      success: true,
      naming: {
        displayName: resolveServerDisplayName(providerName, customName, serviceId),
        customName,
        platform: service.platform,
        supportsInvisibleHostname,
        ...hostnameState,
      },
    });
  } catch (error) {
    return namingError(res, error, 'loading server naming settings');
  }
});

/** Update the safe local name used throughout the dashboard, shop, and Discord bot. */
router.put('/account-servers/:serviceId/display-name', ensurePlatformServerOwner, async (req, res) => {
  if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'displayName')) {
    return res.status(400).json({ success: false, error: 'displayName is required' });
  }
  let serviceId;
  let customName;
  try {
    serviceId = normalizeNitradoServiceId(req.params.serviceId);
    customName = normalizeCustomServerName(req.body?.displayName);
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }

  const db = req.app.locals.db;
  try {
    const result = await db.transaction(async () => {
      await assertCurrentPlatformServerOperator(db, req.platformServerAccess, req.user.id);
      const { services } = await getVerifiedGuildServices(db, req.platformServerAccess.guildId, { forUpdate: true });
      const service = accountServiceOrThrow(services, serviceId);
      const server = await db.get(
        `SELECT id FROM servers
         WHERE platform_server_id = ? AND guild_id = ? AND status = 'active'
         FOR UPDATE`,
        [serviceId, req.platformServerAccess.guildId]
      );
      if (!server) {
        const error = new Error('Active server not found');
        error.statusCode = 404;
        throw error;
      }

      const providerName = providerNameFor(service);
      const displayName = resolveServerDisplayName(providerName, customName, serviceId);
      if (customName) {
        await db.run(
          `INSERT INTO server_features (server_id, feature_name, enabled, config, updated_at)
           VALUES (?, 'custom_name', 1, ?, CURRENT_TIMESTAMP)
           ON CONFLICT (server_id, feature_name) DO UPDATE SET
             enabled = 1, config = EXCLUDED.config, updated_at = CURRENT_TIMESTAMP`,
          [server.id, JSON.stringify({ value: customName })]
        );
      } else {
        await db.run(
          `DELETE FROM server_features WHERE server_id = ? AND feature_name = 'custom_name'`,
          [server.id]
        );
      }
      await db.run(
        `UPDATE servers SET name = ? WHERE id = ? AND guild_id = ?`,
        [displayName, server.id, req.platformServerAccess.guildId]
      );
      return { displayName, customName };
    });
    return res.json({ success: true, naming: result });
  } catch (error) {
    return namingError(res, error, 'updating server display name');
  }
});

/** Update the real Nitrado hostname and verify the provider readback. */
router.put('/account-servers/:serviceId/hostname', ensurePlatformServerOwner, async (req, res) => {
  let serviceId;
  let hostnameValue;
  try {
    serviceId = normalizeNitradoServiceId(req.params.serviceId);
    hostnameValue = nitradoHostnameValue(req.body?.mode, req.body?.hostname);
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }

  const db = req.app.locals.db;
  try {
    await mutateProviderSettings({
      db,
      internalServerId: req.platformServerAccess.serverId,
      expectedPlatformServerId: serviceId,
      allowedPlatforms: ['xbox', 'playstation', 'switch2'],
      actor: req.user,
      entries: [{ category: 'config', key: 'hostname', value: hostnameValue }],
      action: 'hostname',
      contextType: 'nitrado_hostname',
    });
    return res.json({ success: true, naming: classifyNitradoHostname(hostnameValue) });
  } catch (error) {
    return namingError(res, error, 'updating Nitrado hostname');
  }
});

/**
 * GET /api/nitrado/registered-servers
 * Get all servers the current user has access to (via guild roles)
 */
router.get('/registered-servers', async (req, res) => {
  const db = req.app.locals.db;

  try {
    const rows = await db.query(
      `SELECT
         s.id,
         s.guild_id,
         s.name as server_name,
         s.platform_server_id as nitrado_server_id,
         s.platform,
         s.status,
         s.created_at,
         g.name as guild_name,
         g.icon_url as guild_icon,
         g.discord_guild_id,
         COALESCE(sra.role, gr.role) as user_role
       FROM servers s
       JOIN guilds g ON s.guild_id = g.id
       LEFT JOIN guild_roles gr
         ON gr.guild_id = g.id AND gr.user_id = ?
       LEFT JOIN server_role_assignments sra
         ON sra.server_id = s.id
        AND sra.guild_id = s.guild_id
        AND sra.user_id = ?
        AND sra.status = 'active'
       WHERE g.status = 'approved'
         AND s.status = 'active'
         AND (
           gr.role IN ('owner', 'admin')
           OR sra.role IN ('admin', 'moderator')
         )
       ORDER BY s.created_at DESC`,
      [req.user.id, req.user.id]
    );
    const servers = rows.map(row => ({
      ...row,
      server_name: normalizeProviderServerName(row.server_name, row.nitrado_server_id),
    }));
    console.log(`✅ User ${req.user.username} has access to ${servers.length} server(s)`);
    res.json({ success: true, servers });
  } catch (err) {
    console.error('❌ Error fetching registered servers:', err);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

/**
 * GET /api/nitrado/servers
 * Fetch servers from Nitrado API using guild token
 */
router.get('/servers', ensureApprovedGuildOperator, async (req, res) => {
  const { guildId } = req.query;

  if (!guildId) {
    return res.status(400).json({
      success: false,
      error: 'guildId is required'
    });
  }

  const db = req.app.locals.db;

  try {
    // Get guild's token
    // Get guild's token from guild_tokens
    const tokenRow = await db.get(
      `SELECT token_hash FROM guild_tokens
       WHERE guild_id = ? AND token_type = ? AND nitrado_user_id IS NOT NULL`,
      [req.guildAccess.guildId, 'nitrado']
    );
    if (!tokenRow || !tokenRow.token_hash) {
      return res.status(404).json({
        success: false,
        error: 'No Nitrado token registered for this guild. Use /register-token in Discord.'
      });
    }

    const token = decryptToken(tokenRow.token_hash);
    const dayzServers = (await nitradoService.listGameServers(token)).map(service => ({
      ...service,
      name: normalizeProviderServerName(service.name, service.id),
    }));

    res.json({ success: true, servers: dayzServers });
  } catch (error) {
    console.error('Error fetching servers:', error.code || error.name);
    sendExternalApiError(res, error, 'Nitrado');
  }
});

module.exports = router;
