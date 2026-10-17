'use strict';

/**
 * Fleet-wide stats for the public splash page.
 *
 * Reuses the exact data path behind the admin/owner per-server player stats:
 * - Player counts come from player_server_activity (the source of truth for
 *   per-server player lists in routes/admin.js and routes/ownerDashboard.js).
 *   Total = every distinct identity seen on any server (registered AND
 *   unregistered); registered = identities with a linked account (the same
 *   linked_accounts join the admin per-server player_count uses).
 * - Server count matches GET /api/admin/stats (SELECT COUNT(*) FROM servers).
 * - Guild count uses the documented active-guild filter (status='approved');
 *   removed guilds are soft-disabled (status='disabled') and excluded.
 */

async function getFleetStats(db) {
  const [players, servers, guilds] = await Promise.all([
    db.get(`
      SELECT COUNT(DISTINCT psa.identity_id) AS total,
             COUNT(DISTINCT la.id) AS registered
      FROM player_server_activity psa
      LEFT JOIN player_identities pi ON pi.id = psa.identity_id
      LEFT JOIN linked_accounts la ON la.identity_id = pi.id
    `, []),
    db.get(`
      SELECT COUNT(*) AS total,
             COUNT(*) FILTER (WHERE status = 'active') AS active
      FROM servers
    `, []),
    db.get(`
      SELECT COUNT(*) AS active
      FROM guilds
      WHERE status = 'approved'
    `, [])
  ]);

  return {
    players: {
      total: Number(players.total) || 0,
      registered: Number(players.registered) || 0
    },
    servers: {
      total: Number(servers.total) || 0,
      active: Number(servers.active) || 0
    },
    guilds: {
      active: Number(guilds.active) || 0
    }
  };
}

module.exports = { getFleetStats };
