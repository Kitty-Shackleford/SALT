const express = require('express');
const router = express.Router();
const axios = require('../utils/nitradoHttp');
const { getNitradoTransferToken, getNitradoTextBody } = require('../utils/nitradoHttp');
const nitradoService = require('../services/nitradoService');
const { resolveGameDataPath } = require('../utils/dayzPlatform');
const { ensureServerOwner, ensureServerAccess } = require('../middleware/serverAccess');
const { decryptToken } = require('../utils/encryption');
const { sanitizeServerName } = require('../utils/textSanitizer');
const { mutateProviderList } = require('../services/providerListMutationService');
const { assertProviderListVerified } = require('../utils/providerListVerification');
const { wipePlayer: wipePlayerData, wipeServer: wipeServerData } = require('../services/wipeService');
const {
  loadAltCandidates,
  normalizeReviewStatus,
} = require('../services/altAccountCandidateService');

const VALID_LIST_TYPES = ['whitelist', 'blacklist', 'prioritylist'];

const LIST_FILENAMES = { whitelist: 'whitelist.txt', blacklist: 'ban.txt', prioritylist: 'priority.txt' };

function respondProviderRecoveryPending(res, error) {
  if (error?.code !== 'PROVIDER_RECOVERY_PENDING') return false;
  res.status(409).json({ error: error.message, recoveryPending: true });
  return true;
}

async function assertProviderListMutationAuthority(
  db,
  serverId,
  userId,
  expectedPlatformServerId,
  expectedToken,
  listType,
  expectedDir,
  expectedFilename,
  ownerOnly = false
) {
  const scope = await db.get(
    `SELECT s.id, s.guild_id, s.platform_server_id, gt.token_hash
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id
     JOIN guild_tokens gt ON gt.guild_id = s.guild_id
       AND gt.token_type = 'nitrado'
       AND gt.nitrado_user_id IS NOT NULL
     WHERE s.id = ? AND s.status = 'active' AND g.status = 'approved'
     FOR NO KEY UPDATE OF s, g, gt`,
    [serverId]
  );
  if (
    !scope ||
    String(scope.platform_server_id) !== String(expectedPlatformServerId) ||
    decryptToken(scope.token_hash) !== expectedToken
  ) {
    const error = new Error('Resource not found');
    error.code = 'RESOURCE_NOT_FOUND';
    throw error;
  }
  const currentPath = await resolveListFile(expectedToken, expectedPlatformServerId, listType);
  if (currentPath.dir !== expectedDir || currentPath.filename !== expectedFilename) {
    const error = new Error('Provider list path changed before execution');
    error.code = 'SERVER_AUTHORIZATION_MISMATCH';
    throw error;
  }
  const guildRole = await db.get(
    `SELECT role FROM guild_roles
     WHERE guild_id = ? AND user_id = ?
     FOR UPDATE`,
    [scope.guild_id, userId]
  );
  if (guildRole?.role === 'owner' || (!ownerOnly && guildRole?.role === 'admin')) return;
  if (!ownerOnly) {
    const serverRole = await db.get(
      `SELECT role FROM server_role_assignments
       WHERE server_id = ? AND guild_id = ? AND user_id = ?
         AND role = 'admin' AND status = 'active'
       FOR UPDATE`,
      [serverId, scope.guild_id, userId]
    );
    if (serverRole) return;
  }
  const error = new Error('Resource not found');
  error.code = 'RESOURCE_NOT_FOUND';
  throw error;
}

async function resolveListFile(token, platformServerId, listType) {
  const gameserver = await nitradoService.getRawGameserver(token, platformServerId);
  const dataPath = resolveGameDataPath(gameserver);
  const namespace = dataPath.match(/^(\/games\/[^/]+)\/(?:noftp|ftproot)\//)?.[1];
  if (!namespace) throw new Error('Nitrado service path is unavailable');
  const dir = listType === 'prioritylist'
    ? `${namespace}/ftproot/`
    : `${dataPath}/`;
  return { dir, filename: LIST_FILENAMES[listType] };
}

/**
 * Get decrypted Nitrado token for a server (by database server id)
 */
async function getTokenForServer(db, serverId) {
  const row = await db.get(
    `SELECT gt.token_hash, s.platform_server_id
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id
     JOIN guild_tokens gt ON gt.guild_id = s.guild_id
     WHERE s.id = ?
       AND s.status = 'active'
       AND g.status = 'approved'
       AND gt.token_type = 'nitrado'
       AND gt.nitrado_user_id IS NOT NULL
     LIMIT 1`,
    [serverId]
  );
  if (!row || !row.token_hash) return null;
  const token = decryptToken(row.token_hash);
  return { token, platformServerId: row.platform_server_id };
}

/**
 * Read a list file from the Nitrado game server.
 * Returns an array of non-empty trimmed lines.
 * Returns [] if the file does not exist yet (404).
 */
async function readNitradoList(token, platformServerId, dir, filename) {
  const filePath = dir + filename;
  let tokenRes;
  try {
    tokenRes = await axios.get(
      `https://api.nitrado.net/services/${platformServerId}/gameservers/file_server/download`,
      {
        params: { file: filePath },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000
      }
    );
  } catch (err) {
    // File not found → treat as empty list
    if (err.response?.status === 404) return [];
    throw err;
  }
  const { url: downloadUrl } = getNitradoTransferToken(tokenRes);

  const fileRes = await axios.get(downloadUrl, { responseType: 'text', timeout: 15000 });
  const content = getNitradoTextBody(fileRes);
  return content.split('\n').map(l => l.trim()).filter(Boolean);
}

/**
 * Write a list file to the Nitrado game server (two-step upload).
 * Uses multipart FormData, matching the confirmed working upload in missionFileService.
 */
async function writeNitradoList(token, platformServerId, dir, filename, lines) {
  const FormData = require('form-data');
  const content = lines.join('\n') + (lines.length ? '\n' : '');

  const formData = new FormData();
  formData.append('path', dir);
  formData.append('file', filename);

  console.log(`📤 writeNitradoList: uploading ${filename} to ${dir} (${platformServerId}), ${lines.length} entries`);

  let step1;
  try {
    step1 = await axios.post(
      `https://api.nitrado.net/services/${platformServerId}/gameservers/file_server/upload`,
      formData,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...formData.getHeaders()
        },
        timeout: 10000
      }
    );
  } catch (err) {
    console.error('❌ Nitrado upload step1 failed:', err.response?.status || err.code || err.name);
    throw new Error('Nitrado upload token request failed');
  }

  const { url: uploadUrl, token: uploadToken } = getNitradoTransferToken(step1, { requireToken: true });
  console.log(`📤 writeNitradoList: got upload URL, posting content (${content.length} bytes)`);

  try {
    await axios.post(uploadUrl, Buffer.from(content, 'utf8'), {
      headers: {
        token: uploadToken,
        'Content-Type': 'application/octet-stream'
      },
      timeout: 15000
    });
  } catch (err) {
    console.error('❌ Nitrado upload step2 failed:', err.response?.status || err.code || err.name);
    throw new Error('Nitrado file upload failed');
  }

  const verifiedLines = await readNitradoList(token, platformServerId, dir, filename);
  assertProviderListVerified(lines, verifiedLines);
  console.log(`✅ writeNitradoList: ${filename} uploaded and verified successfully`);
}

// Middleware to ensure guild is approved
async function ensureGuildApproved(req, res, next) {
  const db = req.app.locals.db;
  const userId = req.user.id;

  try {
    // Get user's guilds via guild_roles
    const guilds = await db.query(
      `SELECT g.* FROM guilds g
        JOIN guild_roles gr ON gr.guild_id = g.id
       WHERE gr.user_id = ? AND gr.role = 'owner' AND g.status = 'approved'`,
      [userId]
    );

    if (guilds.length === 0) {
      return res.status(403).json({
        error: 'Your guild is pending approval or has been disabled. Contact an administrator.',
        status: 'pending_or_disabled'
      });
    }

    next();
  } catch (err) {
    console.error('Error checking guild status:', err);
    res.status(500).json({ error: 'Failed to check permissions' });
  }
}

// Apply to owner routes
router.use(ensureGuildApproved);

/**
 * GET /api/owner/servers
 * List servers for guilds where user has a role
 */
router.get('/servers', async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.user.id;
  // Correlated subqueries avoid GROUP BY on s.* which PostgreSQL rejects.
  const query = `
      SELECT
        s.*,
        g.name as "guildName",
        g.icon_url as "guildIcon",
        gr.role as "userRole",
        (SELECT or2.user_id FROM guild_roles or2 WHERE or2.guild_id = g.id AND or2.role = 'owner' LIMIT 1) as "ownerId",
        (SELECT u2.username FROM users u2
           JOIN guild_roles or3 ON or3.user_id = u2.id
           WHERE or3.guild_id = g.id AND or3.role = 'owner' LIMIT 1) as "ownerUsername",
        (SELECT COUNT(DISTINCT pi.id)
           FROM player_server_activity psa
           JOIN player_identities pi ON pi.id = psa.identity_id
           WHERE psa.server_id = s.id) as "gameAccountCount"
      FROM servers s
      JOIN guilds g ON s.guild_id = g.id
      JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = ? AND gr.role = 'owner'
      WHERE g.status = 'approved' AND s.status = 'active'
      ORDER BY s.created_at DESC
    `;

  try {
    const rows = await db.query(query, [userId]);
    res.json({ success: true, servers: rows });
  } catch (err) {
    console.error('❌ Error fetching owner servers:', err);
    res.status(500).json({ error: 'Failed to fetch servers' });
  }
});

/**
 * GET /api/owner/servers/:id
 * Get server details (owner only)
 */
router.get('/servers/:id', ensureServerAccess, async (req, res) => {
  const db = req.app.locals.db;
  const serverId = req.params.id;

  // Correlated subqueries avoid GROUP BY on s.* which PostgreSQL rejects.
  const query = `
    SELECT
      s.*,
      g.name as "guildName",
      g.icon_url as "guildIcon",
      (SELECT or2.user_id FROM guild_roles or2 WHERE or2.guild_id = g.id AND or2.role = 'owner' LIMIT 1) as "ownerId",
      (SELECT u2.username FROM users u2
         JOIN guild_roles or3 ON or3.user_id = u2.id
         WHERE or3.guild_id = g.id AND or3.role = 'owner' LIMIT 1) as "ownerUsername",
      (SELECT COUNT(DISTINCT pi.id)
         FROM player_server_activity psa
         JOIN player_identities pi ON pi.id = psa.identity_id
         WHERE psa.server_id = s.id) as "gameAccountCount",
      (SELECT COUNT(DISTINCT la.id)
         FROM server_player_memberships spm
         JOIN linked_accounts la
           ON spm.source_link_id = la.id
          AND la.identity_id = spm.identity_id
          AND la.user_id = spm.user_id
          AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
         WHERE spm.server_id = s.id AND spm.status = 'active') as "linkedAccountCount"
    FROM servers s
    JOIN guilds g ON s.guild_id = g.id
    WHERE s.id = ?
      AND s.status = 'active'
      AND g.status = 'approved'
  `;

  try {
    const row = await db.get(query, [serverId]);
    if (!row) return res.status(404).json({ error: 'Server not found' });
    res.json({ success: true, server: row, isOwner: req.isOwner });
  } catch (err) {
    console.error('❌ Error fetching server details:', err);
    res.status(500).json({ error: 'Failed to fetch server details' });
  }
});

/**
 * GET /api/owner/servers/:id/players
 * Paginated, searchable, sortable player list for a server.
 *
 * Query params:
 *   page    - page number (default 1)
 *   limit   - rows per page, 10–100 (default 50)
 *   sort    - column: gamertag|lastSeen|platform|totalKills|totalDeaths|totalPlaytime|is_alt
 *   dir     - asc|desc (default desc)
 *   search  - gamertag substring filter
 *   filter  - '' | 'alts' | 'linked'
 *
 * Returns: { success, players, total, page, limit, stats: {total,alts,linked}, isOwner }
 */
router.get('/servers/:id/players', ensureServerAccess, async (req, res) => {
  const db = req.app.locals.db;
  const serverId = req.params.id;

  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(100, Math.max(10, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;
  const search = (req.query.search || '').trim();
  const filter = req.query.filter || '';

  // Whitelist of sortable columns → SQL expressions.
  // Kills/deaths/playtime use correlated subqueries because player_stats is a
  // pre-computed cache that may be empty; the event tables are always accurate.
  const SORT_MAP = {
    gamertag:      'pg.gamertag',
    lastSeen:      'psa.last_seen',
    platform:      'pi.platform',
    platform_user_id: 'pi.platform_user_id',
    totalKills:    '(SELECT COUNT(*) FROM kill_events ke WHERE ke.killer_identity_id = pi.id AND ke.server_id = psa.server_id)',
    totalDeaths:   '(SELECT COUNT(*) FROM kill_events ke WHERE ke.victim_identity_id = pi.id AND ke.server_id = psa.server_id)',
    totalPlaytime: '(SELECT COALESCE(SUM(ps2.duration), 0) FROM player_sessions ps2 WHERE ps2.identity_id = pi.id AND ps2.server_id = psa.server_id)',
    is_alt:        'CASE WHEN cai.identity_id IS NOT NULL THEN 1 ELSE 0 END',
  };
  const sortExpr = SORT_MAP[req.query.sort] || 'psa.last_seen';
  const sortDir  = req.query.dir === 'asc' ? 'ASC' : 'DESC';

  // Build dynamic WHERE clauses
  const filterClauses = [];
  const filterParams  = [];
  if (search) {
    filterClauses.push('LOWER(pg.gamertag) LIKE LOWER(?)');
    filterParams.push(`%${search}%`);
  }
  if (filter === 'alts')   filterClauses.push('cai.identity_id IS NOT NULL');
  if (filter === 'linked') filterClauses.push('la.user_id IS NOT NULL');
  const whereStr = filterClauses.length ? 'AND ' + filterClauses.join(' AND ') : '';

  // Confirmed review decisions identify accounts already verified by an owner.
  const altCTE = `
    WITH confirmed_alt_identities AS (
      SELECT aar.identity_id_low AS identity_id
      FROM alt_account_reviews aar
      WHERE aar.server_id = ? AND aar.status = 'confirmed'
      UNION
      SELECT aar.identity_id_high AS identity_id
      FROM alt_account_reviews aar
      WHERE aar.server_id = ? AND aar.status = 'confirmed'
    )
  `;

  const baseJoins = `
    FROM player_identities pi
    JOIN player_server_activity psa ON pi.id = psa.identity_id AND psa.server_id = ?
    JOIN player_gamertags pg
      ON pi.id = pg.identity_id
     AND pg.server_id = psa.server_id
     AND pg.is_current_gamertag = 1
    JOIN servers s ON s.id = psa.server_id AND s.status = 'active'
    JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
    LEFT JOIN server_player_memberships spm
      ON spm.identity_id = pi.id
     AND spm.server_id = psa.server_id
     AND spm.status = 'active'
    LEFT JOIN linked_accounts la
      ON spm.source_link_id = la.id
     AND la.identity_id = spm.identity_id
     AND la.user_id = spm.user_id
     AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
    LEFT JOIN users u ON la.user_id = u.id
    LEFT JOIN confirmed_alt_identities cai ON cai.identity_id = pi.id
    WHERE 1=1 ${whereStr}
  `;

  const dataQuery = `${altCTE}
    SELECT
      pi.id,
      pi.platform,
      pi.platform_user_id,
      pg.gamertag,
      psa.last_seen      AS "lastSeen",
      la.user_id         AS "linkedUserId",
      u.username         AS "linkedUsername",
      (SELECT COUNT(*) FROM kill_events ke WHERE ke.killer_identity_id = pi.id AND ke.server_id = psa.server_id)                   AS "totalKills",
      (SELECT COUNT(*) FROM kill_events ke WHERE ke.victim_identity_id = pi.id AND ke.server_id = psa.server_id)                   AS "totalDeaths",
      (SELECT COALESCE(SUM(ps2.duration), 0) FROM player_sessions ps2 WHERE ps2.identity_id = pi.id AND ps2.server_id = psa.server_id) AS "totalPlaytime",
      CASE WHEN cai.identity_id IS NOT NULL THEN 1 ELSE 0 END AS is_alt
    ${baseJoins}
    ORDER BY ${sortExpr} ${sortDir}
    LIMIT ? OFFSET ?
  `;

  const countQuery = `${altCTE}
    SELECT COUNT(DISTINCT pi.id) AS total
    ${baseJoins}
  `;

  // Overall server stats (unfiltered — always the full picture)
  const statsQuery = `
    WITH confirmed_alt_identities AS (
      SELECT aar.identity_id_low AS identity_id
      FROM alt_account_reviews aar
      WHERE aar.server_id = ? AND aar.status = 'confirmed'
      UNION
      SELECT aar.identity_id_high AS identity_id
      FROM alt_account_reviews aar
      WHERE aar.server_id = ? AND aar.status = 'confirmed'
    )
    SELECT
      COUNT(DISTINCT pi.id) AS total,
      COUNT(DISTINCT CASE WHEN cai.identity_id IS NOT NULL THEN pi.id END) AS alts,
      COUNT(DISTINCT la.identity_id) AS linked
    FROM player_identities pi
    JOIN player_server_activity psa ON pi.id = psa.identity_id AND psa.server_id = ?
    JOIN servers s ON s.id = psa.server_id AND s.status = 'active'
    JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
    LEFT JOIN server_player_memberships spm
      ON spm.identity_id = pi.id
     AND spm.server_id = psa.server_id
     AND spm.status = 'active'
    LEFT JOIN linked_accounts la
      ON spm.source_link_id = la.id
     AND la.identity_id = spm.identity_id
     AND la.user_id = spm.user_id
     AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
    LEFT JOIN confirmed_alt_identities cai ON cai.identity_id = pi.id
  `;

  // Param arrays: review CTE server IDs + psa JOIN serverId + filter + pagination
  const dataParams  = [serverId, serverId, serverId, ...filterParams, limit, offset];
  const countParams = [serverId, serverId, serverId, ...filterParams];

  try {
    const [rows, countRow, statsRow] = await Promise.all([
      db.query(dataQuery, dataParams),
      db.get(countQuery, countParams),
      db.get(statsQuery, [serverId, serverId, serverId]),
    ]);

    res.json({
      success: true,
      players:  rows,
      total:    Number(countRow?.total  || 0),
      page,
      limit,
      stats: {
        total:  Number(statsRow?.total  || 0),
        alts:   Number(statsRow?.alts   || 0),
        linked: Number(statsRow?.linked || 0),
      },
      isOwner: req.isOwner,
    });
  } catch (err) {
    console.error('❌ Error fetching server players:', err);
    res.status(500).json({ error: 'Failed to fetch players' });
  }
});

/**
 * GET /api/owner/dashboard/stats
 * Get dashboard overview statistics
 */
router.get('/dashboard/stats', async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.user.id;
  try {
    const [serversRow, playersRow, guildsRow] = await Promise.all([
      db.get(`
        SELECT COUNT(DISTINCT s.id) as count
        FROM servers s
        JOIN guilds g ON g.id = s.guild_id
        JOIN guild_roles gr ON gr.guild_id = s.guild_id
        WHERE gr.user_id = ? AND gr.role = 'owner'
          AND s.status = 'active'
          AND g.status = 'approved'
      `, [userId]),
      db.get(`
        SELECT COUNT(DISTINCT la.user_id) as count
        FROM server_player_memberships spm
        JOIN linked_accounts la
          ON spm.source_link_id = la.id
         AND la.identity_id = spm.identity_id
         AND la.user_id = spm.user_id
         AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
        JOIN servers s ON s.id = spm.server_id AND s.guild_id = spm.guild_id
        JOIN guilds g ON g.id = s.guild_id
        JOIN guild_roles gr ON gr.guild_id = s.guild_id
        WHERE gr.user_id = ? AND gr.role = 'owner'
          AND spm.status = 'active'
          AND s.status = 'active'
          AND g.status = 'approved'
      `, [userId]),
      db.get(`
        SELECT COUNT(DISTINCT g.id) as count
        FROM guilds g
        JOIN guild_roles gr ON gr.guild_id = g.id
        WHERE gr.user_id = ? AND gr.role = 'owner' AND g.status = 'approved'
      `, [userId])
    ]);

    res.json({
      success: true,
      stats: {
        totalServers: serversRow?.count || 0,
        totalPlayers: playersRow?.count || 0,
        activeGuilds: guildsRow?.count || 0,
        healthStatus: 'healthy'
      }
    });
  } catch (err) {
    console.error('Error fetching dashboard stats:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

/**
 * GET /api/owner/dashboard/activity
 * Get recent activity for user's guilds
 */
router.get('/dashboard/activity', async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.user.id;
  try {
    const [recentServers, recentLinks] = await Promise.all([
      db.query(`
        SELECT
          s.name as server_name,
          s.created_at as timestamp,
          'server_registered' as type,
          g.name as "guildName"
        FROM servers s
        JOIN guilds g ON s.guild_id = g.id
        JOIN guild_roles gr ON gr.guild_id = g.id
        WHERE gr.user_id = ? AND gr.role = 'owner'
          AND s.status = 'active'
          AND g.status = 'approved'
        ORDER BY s.created_at DESC
        LIMIT 5
      `, [userId]),
      db.query(`
        SELECT
          u.username,
          la.linked_at as timestamp,
          'player_linked' as type,
          g.name as "guildName"
        FROM server_player_memberships spm
        JOIN linked_accounts la
          ON spm.source_link_id = la.id
         AND la.identity_id = spm.identity_id
         AND la.user_id = spm.user_id
         AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
        JOIN users u ON la.user_id = u.id
        JOIN servers s ON s.id = spm.server_id AND s.guild_id = spm.guild_id
        JOIN guilds g ON s.guild_id = g.id
        JOIN guild_roles gr ON gr.guild_id = g.id
        WHERE gr.user_id = ? AND gr.role = 'owner'
          AND spm.status = 'active'
          AND s.status = 'active'
          AND g.status = 'approved'
        ORDER BY la.linked_at DESC
        LIMIT 5
      `, [userId])
    ]);

    const activities = [...recentServers, ...recentLinks]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 10)
      .map(activity => ({
        type: activity.type,
        description: activity.type === 'server_registered'
          ? `Server "${activity.server_name}" registered to ${activity.guildName}`
          : `${activity.username} linked their account in ${activity.guildName}`,
        timestamp: activity.timestamp
      }));

    res.json({
      success: true,
      activities
    });
  } catch (err) {
    console.error('Error fetching activity:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch activity' });
  }
});

/**
 * DELETE /api/owner/servers/:id
 * Delete a server (owner only)
 */
router.delete('/servers/:id', ensureServerOwner, async (req, res) => {
  const db = req.app.locals.db;
  const serverId = req.params.id;

  try {
    const deactivated = await db.get(
      `UPDATE servers s
       SET status = 'inactive'
       FROM guilds g, guild_roles gr
       WHERE s.id = ?
         AND s.status = 'active'
         AND g.id = s.guild_id
         AND g.status = 'approved'
         AND gr.guild_id = g.id
         AND gr.user_id = ?
         AND gr.role = 'owner'
       RETURNING s.id`,
      [serverId, req.user.id]
    );
    if (!deactivated) return res.status(404).json({ error: 'Resource not found' });
    console.log(`✅ Server ${serverId} deactivated by owner ${req.user.username}`);
    res.json({ success: true, message: 'Server removed successfully' });
  } catch (err) {
    console.error('❌ Error deleting server:', err);
    if (err.code === 'P0001') {
      return res.status(409).json({ error: 'Server has active protected financial or teleport state' });
    }
    res.status(500).json({ error: 'Failed to delete server' });
  }
});

/**
 * GET /api/owner/servers/:id/list/:listType
 * Read a list file from the Nitrado game server
 */
router.get('/servers/:id/list/:listType', ensureServerAccess, async (req, res) => {
  const { id, listType } = req.params;
  if (!VALID_LIST_TYPES.includes(listType)) {
    return res.status(400).json({ error: 'Invalid list type' });
  }
  try {
    const creds = await getTokenForServer(req.app.locals.db, id);
    if (!creds) return res.status(404).json({ error: 'No Nitrado token found for this server' });

    const { dir, filename } = await resolveListFile(creds.token, creds.platformServerId, listType);
    const entries = await readNitradoList(creds.token, creds.platformServerId, dir, filename);
    res.json({ success: true, entries });
  } catch (err) {
    console.error(`❌ Error reading ${listType}:`, err.message);
    res.status(500).json({ error: 'Failed to read list file' });
  }
});

/**
 * POST /api/owner/servers/:id/list/:listType/add
 * Add a gamertag to a list file
 */
router.post('/servers/:id/list/:listType/add', ensureServerAccess, async (req, res) => {
  const { id, listType } = req.params;
  if (!VALID_LIST_TYPES.includes(listType)) {
    return res.status(400).json({ error: 'Invalid list type' });
  }
  const gamertag = sanitizeServerName(req.body.gamertag || '');
  if (!gamertag) return res.status(400).json({ error: 'Gamertag is required' });

  try {
    const creds = await getTokenForServer(req.app.locals.db, id);
    if (!creds) return res.status(404).json({ error: 'No Nitrado token found for this server' });

    const { dir, filename } = await resolveListFile(creds.token, creds.platformServerId, listType);
    const result = await mutateProviderList({
      db: req.app.locals.db,
      internalServerId: Number(id),
      platformServerId: creds.platformServerId,
      token: creds.token,
      dir,
      filename,
      listType,
      action: 'add',
      triggeredBy: `user:${req.user.id}`,
      beforeMutation: transactionDb => assertProviderListMutationAuthority(
        transactionDb,
        Number(id),
        req.user.id,
        creds.platformServerId,
        creds.token,
        listType,
        dir,
        filename
      ),
      mutate: entries => {
        if (entries.some(entry => entry.toLowerCase() === gamertag.toLowerCase())) {
          return { lines: entries, result: 'exists' };
        }
        return { lines: [...entries, gamertag], result: 'added' };
      },
    });
    if (result.result === 'exists') {
      return res.json({ success: true, message: 'Already in list' });
    }
    res.json({ success: true, message: `Added ${gamertag} to ${listType}` });
  } catch (err) {
    if (respondProviderRecoveryPending(res, err)) return;
    console.error(`❌ Error adding to ${listType}:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to update list file' });
  }
});

/**
 * POST /api/owner/servers/:id/list/:listType/remove
 * Remove a gamertag from a list file
 */
router.post('/servers/:id/list/:listType/remove', ensureServerAccess, async (req, res) => {
  const { id, listType } = req.params;
  if (!VALID_LIST_TYPES.includes(listType)) {
    return res.status(400).json({ error: 'Invalid list type' });
  }
  const gamertag = sanitizeServerName(req.body.gamertag || '');
  if (!gamertag) return res.status(400).json({ error: 'Gamertag is required' });

  try {
    const creds = await getTokenForServer(req.app.locals.db, id);
    if (!creds) return res.status(404).json({ error: 'No Nitrado token found for this server' });

    const { dir, filename } = await resolveListFile(creds.token, creds.platformServerId, listType);

    await mutateProviderList({
      db: req.app.locals.db,
      internalServerId: Number(id),
      platformServerId: creds.platformServerId,
      token: creds.token,
      dir,
      filename,
      listType,
      action: 'remove',
      triggeredBy: `user:${req.user.id}`,
      beforeMutation: transactionDb => assertProviderListMutationAuthority(
        transactionDb,
        Number(id),
        req.user.id,
        creds.platformServerId,
        creds.token,
        listType,
        dir,
        filename
      ),
      mutate: entries => ({
        lines: entries.filter(entry => entry.toLowerCase() !== gamertag.toLowerCase()),
        result: 'removed',
      }),
      localWriter: listType === 'blacklist'
        ? transactionDb => transactionDb.get(
          `INSERT INTO alt_ban_exemptions (server_id, gamertag, exempted_by)
           VALUES (?, ?, ?)
           ON CONFLICT (server_id, gamertag) DO UPDATE SET gamertag = excluded.gamertag
           RETURNING server_id`,
          [id, gamertag, req.user.id]
        )
        : null,
    });

    res.json({ success: true, message: `Removed ${gamertag} from ${listType}` });
  } catch (err) {
    if (respondProviderRecoveryPending(res, err)) return;
    if (err.code === 'RESOURCE_NOT_FOUND') {
      return res.status(404).json({ error: 'Resource not found' });
    }
    console.error(`❌ Error removing from ${listType}:`, err.message);
    res.status(500).json({ error: 'Failed to update list file' });
  }
});

/**
 * POST /api/owner/servers/:id/list/:listType/clear
 * Wipe all entries from a list file (owner-only).
 */
router.post('/servers/:id/list/:listType/clear', ensureServerOwner, async (req, res) => {
  const { id, listType } = req.params;
  if (!VALID_LIST_TYPES.includes(listType)) {
    return res.status(400).json({ error: 'Invalid list type' });
  }
  try {
    const creds = await getTokenForServer(req.app.locals.db, id);
    if (!creds) return res.status(404).json({ error: 'No Nitrado token found for this server' });

    const { dir, filename } = await resolveListFile(creds.token, creds.platformServerId, listType);
    await mutateProviderList({
      db: req.app.locals.db,
      internalServerId: Number(id),
      platformServerId: creds.platformServerId,
      token: creds.token,
      dir,
      filename,
      listType,
      action: 'clear',
      triggeredBy: `user:${req.user.id}`,
      beforeMutation: transactionDb => assertProviderListMutationAuthority(
        transactionDb,
        Number(id),
        req.user.id,
        creds.platformServerId,
        creds.token,
        listType,
        dir,
        filename,
        true
      ),
      mutate: () => ({ lines: [], result: 'cleared' }),
    });
    res.json({ success: true, message: `${listType} cleared` });
  } catch (err) {
    if (respondProviderRecoveryPending(res, err)) return;
    console.error(`❌ Error clearing ${listType}:`, err.message);
    res.status(500).json({ error: 'Failed to clear list file' });
  }
});

/**
 * GET /api/owner/servers/:id/settings
 * Get per-server settings. Automatic alt enforcement is intentionally disabled:
 * current console logs no longer provide a device identifier.
 */
router.get('/servers/:id/settings', ensureServerAccess, async (req, res) => {
  const db = req.app.locals.db;
  const serverId = req.params.id;

  try {
    const row = await db.get(
      `SELECT ss.auto_ban_alts
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
       LEFT JOIN server_settings ss ON ss.server_id = s.id
       WHERE s.id = ? AND s.status = 'active'`,
      [serverId]
    );
    if (!row) return res.status(404).json({ error: 'Resource not found' });
    res.json({ success: true, settings: { autoBanAlts: false, possibleAltReview: true } });
  } catch (err) {
    console.error('❌ Error fetching server settings:', err);
    res.status(500).json({ error: 'Failed to fetch server settings' });
  }
});

/**
 * POST /api/owner/servers/:id/settings/auto-ban-alts
 * Legacy compatibility endpoint. Automatic enforcement can only be disabled;
 * possible-alt evidence is reviewed manually.
 */
router.post('/servers/:id/settings/auto-ban-alts', ensureServerOwner, async (req, res) => {
  const db = req.app.locals.db;
  const serverId = req.params.id;
  if (req.body.enabled) {
    return res.status(409).json({
      error: 'Automatic alt banning is unavailable because current console logs do not provide device IDs',
      autoBanAlts: false,
    });
  }

  try {
    const updated = await db.get(
      `INSERT INTO server_settings (server_id, auto_ban_alts, updated_at)
       SELECT s.id, 0, CURRENT_TIMESTAMP
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
       JOIN guild_roles gr
         ON gr.guild_id = g.id
        AND gr.user_id = ?
        AND gr.role = 'owner'
       WHERE s.id = ? AND s.status = 'active'
       ON CONFLICT(server_id) DO UPDATE
         SET auto_ban_alts = 0,
             updated_at = CURRENT_TIMESTAMP
       RETURNING server_id`,
      [req.user.id, serverId]
    );
    if (!updated) return res.status(404).json({ error: 'Resource not found' });
    res.json({ success: true, autoBanAlts: false, newlyBanned: [] });
  } catch (err) {
    console.error('❌ Error disabling legacy auto-ban:', err);
    res.status(500).json({ error: 'Failed to disable auto-ban' });
  }
});

/**
 * GET /api/owner/servers/:id/alt-ban-exemptions
 * List gamertags that are protected from auto-ban for this server
 */
router.get('/servers/:id/alt-ban-exemptions', ensureServerOwner, async (req, res) => {
  const db = req.app.locals.db;
  const serverId = req.params.id;

  try {
    const rows = await db.query(
      `SELECT abe.gamertag, abe.exempted_at
       FROM alt_ban_exemptions abe
       JOIN servers s ON s.id = abe.server_id AND s.status = 'active'
       JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
       WHERE abe.server_id = ?
       ORDER BY abe.exempted_at DESC`,
      [serverId]
    );
    res.json({ success: true, exemptions: rows || [] });
  } catch (err) {
    console.error('❌ Error fetching alt ban exemptions:', err);
    res.status(500).json({ error: 'Failed to fetch exemptions' });
  }
});

/**
 * POST /api/owner/servers/:id/alt-ban-exemptions
 * Manually add a gamertag to the exemptions list (protected from auto-ban)
 */
router.post('/servers/:id/alt-ban-exemptions', ensureServerOwner, async (req, res) => {
  const db = req.app.locals.db;
  const serverId = req.params.id;
  const gamertag = sanitizeServerName(req.body.gamertag || '');
  if (!gamertag) return res.status(400).json({ error: 'Gamertag is required' });

  try {
    const inserted = await db.get(
      `INSERT INTO alt_ban_exemptions (server_id, gamertag, exempted_by)
       SELECT s.id, ?, ?
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
       JOIN guild_roles gr
         ON gr.guild_id = g.id
        AND gr.user_id = ?
        AND gr.role = 'owner'
       WHERE s.id = ? AND s.status = 'active'
       ON CONFLICT (server_id, gamertag) DO UPDATE SET gamertag = excluded.gamertag
       RETURNING server_id`,
      [gamertag, req.user.id, req.user.id, serverId]
    );
    if (!inserted) return res.status(404).json({ error: 'Resource not found' });
    res.json({ success: true, message: `${gamertag} is now protected from auto-ban` });
  } catch (err) {
    console.error('❌ Error adding exemption:', err);
    res.status(500).json({ error: 'Failed to add exemption' });
  }
});

/**
 * DELETE /api/owner/servers/:id/alt-ban-exemptions/:gamertag
 * Remove a gamertag's exemption so auto-ban can affect them again
 */
router.delete('/servers/:id/alt-ban-exemptions/:gamertag', ensureServerOwner, async (req, res) => {
  const db = req.app.locals.db;
  const serverId = req.params.id;
  const gamertag = req.params.gamertag;

  try {
    const result = await db.get(
      `WITH authorized_server AS (
         SELECT s.id
         FROM servers s
         JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
         JOIN guild_roles gr
           ON gr.guild_id = g.id
          AND gr.user_id = ?
          AND gr.role = 'owner'
         WHERE s.id = ? AND s.status = 'active'
       ), deleted AS (
         DELETE FROM alt_ban_exemptions abe
         WHERE abe.server_id IN (SELECT id FROM authorized_server)
           AND abe.gamertag = ?
         RETURNING abe.server_id
       )
       SELECT EXISTS(SELECT 1 FROM authorized_server) AS authorized,
              EXISTS(SELECT 1 FROM deleted) AS deleted`,
      [req.user.id, serverId, gamertag]
    );
    if (!result?.authorized) return res.status(404).json({ error: 'Resource not found' });
    res.json({ success: true, message: `Exemption removed for ${gamertag}` });
  } catch (err) {
    console.error('❌ Error removing alt ban exemption:', err);
    res.status(500).json({ error: 'Failed to remove exemption' });
  }
});

/**
 * GET /api/owner/servers/:id/alts
 * Return explainable possible-alt candidates for one exact server.
 */
router.get('/servers/:id/alts', ensureServerAccess, async (req, res) => {
  try {
    const candidates = await loadAltCandidates(req.app.locals.db, req.params.id);
    res.json({
      success: true,
      candidates,
      canReview: req.authorization?.guild?.role === 'owner',
      policy: {
        automaticEnforcement: false,
        behavioralEvidenceRequiresReview: true,
      },
    });
  } catch (err) {
    console.error('❌ Error fetching possible-alt candidates:', err);
    res.status(500).json({ error: 'Failed to fetch possible-alt candidates' });
  }
});

/**
 * POST /api/owner/servers/:id/alts/review
 * Save an owner decision for a candidate pair. This never modifies Nitrado
 * lists; enforcement remains a separate, explicit owner action.
 */
router.post('/servers/:id/alts/review', ensureServerOwner, async (req, res) => {
  const db = req.app.locals.db;
  const serverId = req.params.id;
  const firstId = Number(req.body.identityIdA);
  const secondId = Number(req.body.identityIdB);
  const notes = String(req.body.notes || '').trim().slice(0, 1000);
  let status;

  try {
    status = normalizeReviewStatus(req.body.status);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!Number.isSafeInteger(firstId) || !Number.isSafeInteger(secondId) || firstId <= 0 || secondId <= 0 || firstId === secondId) {
    return res.status(400).json({ error: 'Two different valid identity IDs are required' });
  }

  const identityIdLow = Math.min(firstId, secondId);
  const identityIdHigh = Math.max(firstId, secondId);

  try {
    const outcome = await db.transaction(async tx => {
      const lockedScope = await tx.get(
        `SELECT s.id, s.guild_id
         FROM servers s
         JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
         WHERE s.id = ? AND s.status = 'active'
         FOR UPDATE OF s`,
        [serverId]
      );
      if (!lockedScope) return { status: 404, error: 'Resource not found' };
      const lockedOwner = await tx.get(
        `SELECT gr.role FROM guild_roles gr
         WHERE gr.guild_id = ? AND gr.user_id = ? AND gr.role = 'owner'
         FOR UPDATE OF gr`,
        [lockedScope.guild_id, req.user.id]
      );
      if (!lockedOwner) return { status: 404, error: 'Resource not found' };

      const existingReview = await tx.get(
        `SELECT 1
         FROM alt_account_reviews
         WHERE server_id = ? AND identity_id_low = ? AND identity_id_high = ?`,
        [serverId, identityIdLow, identityIdHigh]
      );
      if (!existingReview) {
        const candidates = await loadAltCandidates(tx, serverId);
        const candidateExists = candidates.some(candidate =>
          candidate.identityIds[0] === identityIdLow && candidate.identityIds[1] === identityIdHigh
        );
        if (!candidateExists) return { status: 404, error: 'Possible-alt candidate not found' };
      }

      const reviewed = await tx.get(
        `INSERT INTO alt_account_reviews (
           server_id, identity_id_low, identity_id_high, status, notes,
           reviewed_by, reviewed_at, updated_at
         )
         SELECT s.id, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         FROM servers s
         JOIN player_server_activity low_psa
           ON low_psa.server_id = s.id AND low_psa.identity_id = ?
         JOIN player_server_activity high_psa
           ON high_psa.server_id = s.id AND high_psa.identity_id = ?
         WHERE s.id = ? AND s.status = 'active'
         ON CONFLICT (server_id, identity_id_low, identity_id_high) DO UPDATE
           SET status = excluded.status,
               notes = excluded.notes,
               reviewed_by = excluded.reviewed_by,
               reviewed_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
         RETURNING server_id, identity_id_low, identity_id_high, status, notes, reviewed_at`,
        [
          identityIdLow,
          identityIdHigh,
          status,
          notes,
          req.user.id,
          identityIdLow,
          identityIdHigh,
          serverId,
        ]
      );
      if (!reviewed) return { status: 404, error: 'Resource not found' };
      return { reviewed };
    });
    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ success: true, review: outcome.reviewed });
  } catch (err) {
    console.error('❌ Error saving possible-alt review:', err);
    res.status(500).json({ error: 'Failed to save possible-alt review' });
  }
});

/**
 * POST /api/owner/servers/:id/players/:identityId/wipe
 * Full wipe of all tracked data for a single player on this server.
 * Owner-only. Verifies the identity belongs to this server before wiping.
 */
router.post('/servers/:id/players/:identityId/wipe', ensureServerOwner, async (req, res) => {
  const db = req.app.locals.db;
  const serverId = req.params.id;
  const identityId = req.params.identityId;
  const requestedByUserId = req.user.id;

  try {
    await wipePlayerData(db, { serverId, identityId, requestedByUserId });
    console.log(`🗑️  Player wipe: identityId=${identityId} serverId=${serverId} by userId=${requestedByUserId}`);
    res.json({ success: true, message: 'Player data wiped successfully' });
  } catch (err) {
    if (err.code === 'RESOURCE_NOT_FOUND') {
      return res.status(404).json({ error: 'Resource not found' });
    }
    console.error('❌ Error during player wipe:', err);
    res.status(500).json({ error: 'Database error while verifying player or wiping data' });
  }
});

/**
 * POST /api/owner/servers/:id/wipe
 * Full wipe of ALL tracked data for every player on this server.
 * Owner-only. Runs atomically in a single database transaction.
 */
router.post('/servers/:id/wipe', ensureServerOwner, async (req, res) => {
  const db = req.app.locals.db;
  const serverId = req.params.id;
  const requestedByUserId = req.user.id;

  try {
    await wipeServerData(db, { serverId, requestedByUserId });
    console.log(`🗑️  Server wipe: serverId=${serverId} by userId=${requestedByUserId}`);
    res.json({ success: true, message: 'All server data wiped successfully' });
  } catch (err) {
    if (err.code === 'RESOURCE_NOT_FOUND') {
      return res.status(404).json({ error: 'Resource not found' });
    }
    console.error('❌ Error during server wipe:', err);
    res.status(500).json({ error: 'Failed to wipe server data' });
  }
});

router._test = { writeNitradoList };

module.exports = router;
