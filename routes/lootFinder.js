/*
 * DayZ Dashboard — Loot Finder Routes
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * API endpoints for the loot finder tool.
 * All player endpoints require ?serverId= (Nitrado platform server ID).
 * The server is resolved to its guild's shared download directory so all
 * guild members read the same files regardless of who triggered the sync.
 *
 * Player endpoints: search items, get categories, get item detail.
 * Admin endpoints: live CE LootRespawner data, economy health.
 */

const express = require('express');
const router = express.Router();
const { ensureAuthenticated, ensureAdmin } = require('../middleware/auth');
const { ensurePlatformServerOwner } = require('../middleware/serverAccess');

const lootParser = require('../services/lootParserService');
const lootLive   = require('../services/lootLiveService');
const { resolveGuildDiscordId } = require('../services/logSyncService');

const VALID_MAPS = new Set(lootParser.SUPPORTED_MAPS);

/**
 * Validate the ?map= query parameter.
 * Defaults to 'chernarusplus' if omitted or invalid.
 */
function resolveMap(req) {
  const m = (req.query.map || '').toLowerCase().trim();
  return VALID_MAPS.has(m) ? m : 'chernarusplus';
}

/**
 * Require ?serverId= and resolve the guild's shared download directory for it.
 * The serverId must be a Nitrado platform server ID belonging to a guild
 * the requesting user is a member of.
 *
 * Returns { serverId, guildDiscordId } or sends a 400/404 and returns null.
 */
async function requireServer(req, res) {
  const serverId = (req.query.serverId || '').trim();
  if (!serverId) {
    res.status(400).json({ ok: false, error: 'Missing required query parameter: serverId' });
    return null;
  }

  const guildDiscordId = await resolveGuildDiscordId(req.app.locals.db, req.user.id, serverId);
  if (!guildDiscordId) {
    res.status(404).json({ ok: false, error: 'Server not found or you do not have access to it' });
    return null;
  }

  return { serverId, guildDiscordId };
}

// ─── Player Endpoints ─────────────────────────────────────────────────────────

/**
 * GET /api/loot/categories?serverId=123&map=chernarusplus
 * Returns all unique filter options (categories, usage zones, tiers) for a map.
 * Used to populate filter dropdowns in the UI.
 */
router.get('/categories', ensureAuthenticated, async (req, res) => {
  try {
    const server = await requireServer(req, res);
    if (!server) return;

    const mapName = resolveMap(req);
    const result = await lootParser.getAllCategories(mapName, server.guildDiscordId, server.serverId);
    res.json({ ok: true, mapName, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/loot/search?serverId=123&map=chernarusplus&q=AK101&category=weapons&usage=Military&value=Tier3&limit=50
 * Search items by name (partial), category, usage zone, and/or tier.
 * Returns matching items with spawn point coordinates.
 */
router.get('/search', ensureAuthenticated, async (req, res) => {
  try {
    const server = await requireServer(req, res);
    if (!server) return;

    const mapName = resolveMap(req);
    const limit   = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const filters = {
      q:        req.query.q        || '',
      category: req.query.category || '',
      usage:    req.query.usage    || '',
      value:    req.query.value    || '',
    };

    const items = await lootParser.searchItems(mapName, filters, limit, server.guildDiscordId, server.serverId);

    const results = items.map(item => ({
      name:        item.name,
      nominal:     item.nominal,
      min:         item.min,
      lifetime:    item.lifetime,
      restock:     item.restock,
      quantmin:    item.quantmin,
      quantmax:    item.quantmax,
      category:    item.category,
      usages:      item.usages,
      values:      item.values,
      tags:        item.tags,
      spawnCount:  item.spawnPoints.length,
      spawnPoints: item.spawnPoints.slice(0, 500),
    }));

    res.json({ ok: true, mapName, count: results.length, items: results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/loot/item/:name?serverId=123&map=chernarusplus
 * Get full detail for a single item including all spawn points.
 */
router.get('/item/:name', ensureAuthenticated, async (req, res) => {
  try {
    const server = await requireServer(req, res);
    if (!server) return;

    const mapName  = resolveMap(req);
    const itemName = req.params.name;

    if (!itemName || itemName.length > 100) {
      return res.status(400).json({ ok: false, error: 'Invalid item name.' });
    }

    const item = await lootParser.getItem(mapName, itemName, server.guildDiscordId, server.serverId);
    if (!item) {
      return res.status(404).json({ ok: false, error: `Item not found: ${itemName}` });
    }

    res.json({
      ok: true,
      mapName,
      item: {
        name:        item.name,
        nominal:     item.nominal,
        min:         item.min,
        lifetime:    item.lifetime,
        restock:     item.restock,
        quantmin:    item.quantmin,
        quantmax:    item.quantmax,
        cost:        item.cost,
        category:    item.category,
        usages:      item.usages,
        values:      item.values,
        tags:        item.tags,
        flags:       item.flags,
        spawnCount:  item.spawnPoints.length,
        spawnPoints: item.spawnPoints,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Admin-Only Endpoints ─────────────────────────────────────────────────────

/**
 * GET /api/loot/live?serverId=123&map=chernarusplus
 * Returns live loot data parsed from the most recent RPT log. Admin only.
 */
router.get('/live', ensureAuthenticated, ensureAdmin, async (req, res) => {
  try {
    const server = await requireServer(req, res);
    if (!server) return;
    const mapName = resolveMap(req);
    const data = await lootLive.getLiveSpawns(mapName, server.guildDiscordId, server.serverId);
    res.json({ ok: true, mapName, ...data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/loot/economy-health?serverId=123&map=chernarusplus
 * Returns CE economy health summary. Admin only.
 */
router.get('/economy-health', ensureAuthenticated, ensureAdmin, async (req, res) => {
  try {
    const server = await requireServer(req, res);
    if (!server) return;
    const mapName = resolveMap(req);
    const data = await lootLive.getLiveSpawns(mapName, server.guildDiscordId, server.serverId);
    res.json({
      ok: true,
      mapName,
      economyHealth: data.economyHealth,
      topMissing:    data.candidates.slice(0, 20),
      lastUpdated:   data.lastUpdated,
      rptFile:       data.rptFile,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/loot/logs?serverId=123
 * List available RPT log files with their map associations. Admin only.
 */
router.get('/logs', ensureAuthenticated, ensureAdmin, async (req, res) => {
  try {
    const server = await requireServer(req, res);
    if (!server) return;
    const logs = lootLive.listAvailableLogs(server.guildDiscordId, server.serverId);
    res.json({ ok: true, logs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/loot/heatmap
 * Returns grid-aggregated loot despawn data for the heatmap overlay.
 *
 * Query params:
 *   serverId  {string}  — Nitrado platform server ID (required)
 *   days      {number}  — look-back window in days (default: 7)
 *   filter    {string}  — "all" | "infected" | "items" (default: "all")
 *   search    {string}  — optional item class substring filter
 *   gridSize  {number}  — grid cell size in meters (default: 200)
 */
router.get('/heatmap', ensureAuthenticated, ensurePlatformServerOwner, async (req, res) => {
  const db = req.app.locals.db;
  const { serverId, days = 7, filter = 'all', search = '', gridSize = 200 } = req.query;

  if (!serverId) return res.status(400).json({ ok: false, error: 'serverId required' });

  try {
    const server = { id: req.platformServerAccess.serverId };

    const grid   = Math.max(50, Math.min(1000, parseInt(gridSize, 10) || 200));
    const window = Math.max(1,  Math.min(90,   parseInt(days, 10)    || 7));

    // Build category filter clause
    let classFilter = '';
    const params = [server.id, window, grid];
    if (filter === 'infected') {
      classFilter = "AND item_class LIKE 'Zmb%'";
    } else if (filter === 'items') {
      classFilter = "AND item_class NOT LIKE 'Zmb%'";
    }
    if (search && search.trim()) {
      classFilter += ` AND item_class ILIKE $${params.length + 1}`;
      params.push(`%${search.trim()}%`);
    }

    // Grid-aggregate: group positions into cells, return cell centre + count
    const pointsRes = await db.query(
      `SELECT
         ROUND(pos_x / $3) * $3 + $3 / 2.0 AS cx,
         ROUND(pos_z / $3) * $3 + $3 / 2.0 AS cz,
         COUNT(*)::int                       AS cnt
       FROM loot_despawn_events
       WHERE server_id = $1
         AND log_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
         ${classFilter}
       GROUP BY 1, 2
       ORDER BY cnt DESC`,
      params
    );

    // Top 25 most despawned item types
    const topParams = [server.id, window];
    let topClassFilter = '';
    if (filter === 'infected') {
      topClassFilter = "AND item_class LIKE 'Zmb%'";
    } else if (filter === 'items') {
      topClassFilter = "AND item_class NOT LIKE 'Zmb%'";
    }
    if (search && search.trim()) {
      topClassFilter += ` AND item_class ILIKE $${topParams.length + 1}`;
      topParams.push(`%${search.trim()}%`);
    }

    const topRes = await db.query(
      `SELECT item_class, COUNT(*)::int AS cnt
       FROM loot_despawn_events
       WHERE server_id = $1
         AND log_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
         ${topClassFilter}
       GROUP BY item_class
       ORDER BY cnt DESC
       LIMIT 25`,
      topParams
    );

    const points = pointsRes.map(r => [
      parseFloat(r.cx),
      parseFloat(r.cz),
      parseInt(r.cnt, 10),
    ]);
    const total  = points.reduce((s, p) => s + p[2], 0);

    res.json({
      ok: true,
      points,
      topItems: topRes,
      total,
      gridSize: grid,
      days:     window,
    });
  } catch (err) {
    console.error('❌ /api/loot/heatmap error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
