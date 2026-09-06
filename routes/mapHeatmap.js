/*
 * DayZ Dashboard
 * Copyright (C) 2026
 * GNU Affero General Public License
 *
 * Map heatmap API endpoints for kill, death, and movement overlays.
 * All three endpoints follow the same grid-aggregation pattern as the
 * loot despawn heatmap in routes/lootFinder.js.
 */

const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/auth');

const {
  CAPABILITIES,
  authorizePlatformServer,
} = require('../services/authorizationService');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a Nitrado platform_server_id only when the authenticated user has
 * access to that server's approved guild. This prevents membership in one
 * guild from authorizing heatmap access for another guild's server.
 */
async function resolveAuthorizedServerId(db, platformServerId, user) {
  const context = await authorizePlatformServer(
    db,
    user,
    platformServerId,
    CAPABILITIES.SERVER_VIEW
  );
  return context ? context.server.id : null;
}

/** Clamp a numeric query param between min and max with a default fallback. */
function clamp(value, min, max, defaultVal) {
  const n = parseInt(value, 10);
  if (isNaN(n)) return defaultVal;
  return Math.max(min, Math.min(max, n));
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/map/kill-heatmap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns grid-aggregated kill locations from the kill_events table.
 * ADM positions are stored in wire order "east,north,elevation" in the
 * victim_position column. The second textual slot is map northing.
 *
 * Query params:
 *   serverId  {string}  — Nitrado platform server ID (required)
 *   days      {number}  — look-back window in days (default: 7)
 *   gridSize  {number}  — grid cell size in metres (default: 200)
 */
router.get('/kill-heatmap', ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const { serverId, days = 7, gridSize = 200 } = req.query;

  if (!serverId) return res.status(400).json({ ok: false, error: 'serverId required' });

  try {
    const internalId = await resolveAuthorizedServerId(db, serverId, req.user);
    if (!internalId) return res.status(404).json({ ok: false, error: 'Server not found' });

    const grid   = clamp(gridSize, 50, 1000, 200);
    const window = clamp(days, 1, 90, 7);

    const points = await db.query(
      `SELECT
         FLOOR(CAST(SPLIT_PART(victim_position, ',', 1) AS NUMERIC) / $3) * $3 + $3/2.0 AS cx,
         FLOOR(CAST(SPLIT_PART(victim_position, ',', 2) AS NUMERIC) / $3) * $3 + $3/2.0 AS cz,
         COUNT(*)::int AS cnt
       FROM kill_events
       WHERE server_id = $1
         AND timestamp >= NOW() - ($2 || ' days')::INTERVAL
         AND victim_position IS NOT NULL
       GROUP BY 1, 2
       ORDER BY cnt DESC`,
      [internalId, window, grid]
    );

    const total = points.reduce((s, p) => s + p.cnt, 0);

    res.json({
      ok: true,
      points: points.map(p => [parseFloat(p.cx), parseFloat(p.cz), p.cnt]),
      total,
      gridSize: grid,
      days: window,
    });
  } catch (err) {
    console.error('❌ /api/map/kill-heatmap error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/map/death-heatmap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns grid-aggregated death locations from player_death_events.
 * ADM tuple slots are stored directly: pos_x is east, pos_y is north, and
 * pos_z is elevation.
 *
 * Query params: same as kill-heatmap
 */
router.get('/death-heatmap', ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const { serverId, days = 7, gridSize = 200 } = req.query;

  if (!serverId) return res.status(400).json({ ok: false, error: 'serverId required' });

  try {
    const internalId = await resolveAuthorizedServerId(db, serverId, req.user);
    if (!internalId) return res.status(404).json({ ok: false, error: 'Server not found' });

    const grid   = clamp(gridSize, 50, 1000, 200);
    const window = clamp(days, 1, 90, 7);

    const points = await db.query(
      `SELECT
         FLOOR(pos_x / $3) * $3 + $3 / 2.0 AS cx,
         FLOOR(pos_y / $3) * $3 + $3 / 2.0 AS cz,
         COUNT(*)::int                       AS cnt
       FROM player_death_events
       WHERE server_id = $1
         AND timestamp >= NOW() - ($2 || ' days')::INTERVAL
         AND pos_x IS NOT NULL
         AND pos_y IS NOT NULL
       GROUP BY 1, 2
       ORDER BY cnt DESC`,
      [internalId, window, grid]
    );

    const total = points.reduce((s, p) => s + p.cnt, 0);

    res.json({
      ok: true,
      points: points.map(p => [parseFloat(p.cx), parseFloat(p.cz), p.cnt]),
      total,
      gridSize: grid,
      days: window,
    });
  } catch (err) {
    console.error('❌ /api/map/death-heatmap error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/map/movement-heatmap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns grid-aggregated player movement density from player_position_snapshots.
 * ADM tuple slots are stored directly: pos_x is east, pos_y is north, and
 * pos_z is elevation.
 *
 * Query params: same as kill-heatmap
 */
router.get('/movement-heatmap', ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const { serverId, days = 7, gridSize = 200 } = req.query;

  if (!serverId) return res.status(400).json({ ok: false, error: 'serverId required' });

  try {
    const internalId = await resolveAuthorizedServerId(db, serverId, req.user);
    if (!internalId) return res.status(404).json({ ok: false, error: 'Server not found' });

    const grid   = clamp(gridSize, 50, 1000, 200);
    const window = clamp(days, 1, 90, 7);

    const points = await db.query(
      `SELECT
         FLOOR(pos_x / $3) * $3 + $3 / 2.0 AS cx,
         FLOOR(pos_y / $3) * $3 + $3 / 2.0 AS cz,
         COUNT(*)::int                       AS cnt
       FROM player_position_snapshots
       WHERE server_id = $1
         AND timestamp >= NOW() - ($2 || ' days')::INTERVAL
         AND pos_x IS NOT NULL
         AND pos_y IS NOT NULL
       GROUP BY 1, 2
       ORDER BY cnt DESC`,
      [internalId, window, grid]
    );

    const total = points.reduce((s, p) => s + p.cnt, 0);

    res.json({
      ok: true,
      points: points.map(p => [parseFloat(p.cx), parseFloat(p.cz), p.cnt]),
      total,
      gridSize: grid,
      days: window,
    });
  } catch (err) {
    console.error('❌ /api/map/movement-heatmap error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
