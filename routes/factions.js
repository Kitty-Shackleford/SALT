/*
 * DayZ Dashboard — Faction Routes
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * Handles all /api/factions/:guildId/* endpoints.
 * Auth (ensureAuthenticated) is applied at mount in registerRoutes.js.
 *
 * guildId in URL params is always the Discord guild ID (string).
 * Internally we resolve it to guilds.id (integer) via resolveGuild().
 */

const express = require('express');
const router = express.Router();

const FLAG_IMAGE_ORIGIN = 'https://static.wikia.nocookie.net';
const FLAG_IMAGE_PATH_PREFIX = '/dayz_gamepedia/images/';

function isAllowedFlagUrl(value) {
  if (!value) return true;
  if (!/^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/.test(value)) return false;
  try {
    const parsed = new URL(value);
    const queryEntries = [...parsed.searchParams.entries()];
    const hasAllowedCacheBust = queryEntries.length === 0 || (
      queryEntries.length === 1
      && queryEntries[0][0] === 'cb'
      && /^\d{14}$/.test(queryEntries[0][1])
    );
    return parsed.origin === FLAG_IMAGE_ORIGIN
      && parsed.pathname.startsWith(FLAG_IMAGE_PATH_PREFIX)
      && !parsed.username
      && !parsed.password
      && hasAllowedCacheBust
      && !parsed.hash;
  } catch {
    return false;
  }
}
const { verifyGuildMembership } = require('../utils/discordAPI');
const { ensurePlayerGuildAccess } = require('../middleware/serverAccess');
const { admTupleToWorld } = require('../utils/dayzCoordinates');
const { isPlayerMapFeatureEnabled, parsePlayerMapSettings } = require('../utils/playerMapPolicy');

router.param('guildId', ensurePlayerGuildAccess);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a Discord guild ID string to the internal guilds.id integer.
 * Returns null if the guild is not found.
 */
async function resolveGuild(db, discordGuildId) {
  const row = await db.get(
    'SELECT id FROM guilds WHERE discord_guild_id = ?',
    [discordGuildId]
  );
  return row ? row.id : null;
}

/**
 * Resolves a faction only when it belongs to the already-authorized guild.
 * Caller-controlled faction IDs must never be used before this binding.
 */
async function resolveFactionInGuild(db, factionId, internalGuildId) {
  return db.get(
    'SELECT * FROM factions WHERE id = ? AND guild_id = ?',
    [factionId, internalGuildId]
  );
}

async function lockFactionInGuild(db, factionId, internalGuildId) {
  return db.get(
    'SELECT * FROM factions WHERE id = ? AND guild_id = ? FOR UPDATE',
    [factionId, internalGuildId]
  );
}

/**
 * Returns the player_identities.id for the logged-in user within the given
 * internal guild. A user may have linked accounts across multiple servers; we
 * pick the first identity that belongs to a server in this guild.
 * Returns null if the user has no linked identity in this guild.
 */
async function getCallerIdentity(db, userId, internalGuildId, lockAuthorization = false) {
  const row = await db.get(
    `SELECT spm.identity_id AS id
     FROM server_player_memberships spm
     JOIN linked_accounts la
       ON la.id = spm.source_link_id
      AND la.identity_id = spm.identity_id
      AND la.user_id = spm.user_id
     JOIN servers s ON s.id = spm.server_id AND s.guild_id = spm.guild_id
     JOIN guilds g ON g.id = s.guild_id
     WHERE spm.user_id = ?
       AND spm.guild_id = ?
       AND spm.status = 'active'
       AND s.status = 'active'
       AND g.status = 'approved'
       AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
     ORDER BY spm.server_id
     LIMIT 1${lockAuthorization ? '\n     FOR UPDATE OF spm' : ''}`,
    [userId, internalGuildId]
  );
  return row ? row.id : null;
}

async function getCallerIdentityForServer(
  db,
  userId,
  internalGuildId,
  serverId,
  lockAuthorization = false
) {
  const row = await db.get(
    `SELECT spm.identity_id AS id
     FROM server_player_memberships spm
     JOIN linked_accounts la
       ON la.id = spm.source_link_id
      AND la.identity_id = spm.identity_id
      AND la.user_id = spm.user_id
      AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
     WHERE spm.user_id = ? AND spm.guild_id = ? AND spm.server_id = ?
       AND spm.status = 'active'
     LIMIT 1${lockAuthorization ? '\n     FOR UPDATE OF spm' : ''}`,
    [userId, internalGuildId, serverId]
  );
  return row ? row.id : null;
}

async function lockActiveServer(db, serverId, internalGuildId) {
  return db.get(
    `SELECT s.id
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id
     WHERE s.id = ? AND s.guild_id = ?
       AND s.status = 'active' AND g.status = 'approved'
     FOR UPDATE OF s`,
    [serverId, internalGuildId]
  );
}

async function lockPlayerMapPolicy(db, serverId) {
  const row = await db.get(
    "SELECT config FROM server_features WHERE server_id = ? AND feature_name = 'player_map' FOR UPDATE",
    [serverId]
  );
  return parsePlayerMapSettings(row?.config);
}

/**
 * Returns the caller's faction membership row for a specific faction,
 * or null if they are not a member.
 */
async function getCallerMembership(db, factionId, identityId) {
  return db.get(
    'SELECT * FROM faction_members WHERE faction_id = ? AND identity_id = ?',
    [factionId, identityId]
  );
}

async function getFactionMembershipForUpdate(db, factionId, identityId) {
  return db.get(
    'SELECT * FROM faction_members WHERE faction_id = ? AND identity_id = ? FOR UPDATE',
    [factionId, identityId]
  );
}

/**
 * Returns true if the identity already belongs to any faction within the guild.
 * Enforces the one-faction-per-guild rule.
 */
async function isInAnyFaction(db, internalGuildId, identityId) {
  const row = await db.get(
    `SELECT fm.id
     FROM faction_members fm
     JOIN factions f ON f.id = fm.faction_id
     WHERE f.guild_id = ? AND fm.identity_id = ?
     LIMIT 1`,
    [internalGuildId, identityId]
  );
  return !!row;
}

// ---------------------------------------------------------------------------
// GET /:guildId — List all factions in a guild with member counts
// ---------------------------------------------------------------------------

router.get('/:guildId', async (req, res) => {
  const db = req.app.locals.db;
  const { guildId } = req.params;
  const userId = req.user.id;

  try {
    // Verify the user is a member of this Discord guild
    const accessToken = req.user.access_token;
    const isMember = await verifyGuildMembership(accessToken, guildId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this guild' });
    }

    const internalGuildId = await resolveGuild(db, guildId);
    if (!internalGuildId) {
      return res.status(404).json({ error: 'Guild not found' });
    }

    // Fetch all factions with their member counts using a correlated subquery
    // (avoids GROUP BY on f.* which PostgreSQL rejects)
    const factions = await db.all(
      `SELECT f.*,
              (SELECT COUNT(fm.id) FROM faction_members fm WHERE fm.faction_id = f.id) AS member_count
       FROM factions f
       WHERE f.guild_id = ?
       ORDER BY f.name ASC`,
      [internalGuildId]
    );

    // Also resolve the caller's identity so the client knows if they're in a faction
    const callerIdentityId = await getCallerIdentity(db, userId, internalGuildId);
    let callerFactionId = null;
    if (callerIdentityId) {
      const membership = await db.get(
        'SELECT faction_id FROM faction_members WHERE identity_id = ? AND guild_id = ?',
        [callerIdentityId, internalGuildId]
      );
      callerFactionId = membership ? membership.faction_id : null;
    }

    res.json({
      success: true,
      factions,
      callerIdentityId,
      callerFactionId,
    });
  } catch (err) {
    console.error('GET /api/factions/:guildId error:', err);
    res.status(500).json({ error: 'Failed to load factions' });
  }
});

// ---------------------------------------------------------------------------
// GET /:guildId/:factionId — Get one faction with full member roster
// ---------------------------------------------------------------------------

router.get('/:guildId/:factionId', async (req, res) => {
  const db = req.app.locals.db;
  const { guildId, factionId } = req.params;
  const userId = req.user.id;

  try {
    const accessToken = req.user.access_token;
    const isMember = await verifyGuildMembership(accessToken, guildId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this guild' });
    }

    const internalGuildId = await resolveGuild(db, guildId);
    if (!internalGuildId) {
      return res.status(404).json({ error: 'Guild not found' });
    }

    // Get faction (scoped to guild for safety)
    const faction = await db.get(
      'SELECT * FROM factions WHERE id = ? AND guild_id = ?',
      [factionId, internalGuildId]
    );
    if (!faction) {
      return res.status(404).json({ error: 'Faction not found' });
    }

    // Get full member roster with player names
    const members = await db.all(
      `SELECT fm.identity_id, fm.rank, fm.joined_at,
              COALESCE(pg.gamertag, pi.platform_username) AS player_name
       FROM faction_members fm
       JOIN player_identities pi ON pi.id = fm.identity_id
       LEFT JOIN LATERAL (
         SELECT gamertag FROM player_gamertags
         WHERE identity_id = fm.identity_id AND is_current_gamertag = 1
         ORDER BY last_seen DESC NULLS LAST LIMIT 1
       ) pg ON TRUE
       WHERE fm.faction_id = ?
       ORDER BY
         CASE fm.rank
           WHEN 'leader'  THEN 1
           WHEN 'officer' THEN 2
           ELSE                3
         END,
         fm.joined_at ASC`,
      [factionId]
    );

    const callerIdentityId = await getCallerIdentity(db, userId, internalGuildId);
    const callerMembership = callerIdentityId
      ? await getCallerMembership(db, factionId, callerIdentityId)
      : null;

    res.json({
      success: true,
      faction,
      members,
      callerIdentityId,
      callerRank: callerMembership ? callerMembership.rank : null,
    });
  } catch (err) {
    console.error('GET /api/factions/:guildId/:factionId error:', err);
    res.status(500).json({ error: 'Failed to load faction' });
  }
});

// ---------------------------------------------------------------------------
// POST /:guildId — Create a new faction (caller becomes leader)
// ---------------------------------------------------------------------------

router.post('/:guildId', async (req, res) => {
  const db = req.app.locals.db;
  const { guildId } = req.params;
  const { name, tag, description, emblem, is_open, flag_url } = req.body;
  const userId = req.user.id;

  if (!name || !tag) {
    return res.status(400).json({ error: 'name and tag are required' });
  }
  if (tag.length < 2 || tag.length > 5) {
    return res.status(400).json({ error: 'tag must be 2–5 characters' });
  }
  if (!isAllowedFlagUrl(flag_url)) {
    return res.status(400).json({ error: 'Invalid flag_url' });
  }

  try {
    const accessToken = req.user.access_token;
    const isMember = await verifyGuildMembership(accessToken, guildId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this guild' });
    }

    const internalGuildId = await resolveGuild(db, guildId);
    if (!internalGuildId) {
      return res.status(404).json({ error: 'Guild not found' });
    }

    // Lock current authorization evidence and create both rows on one checked-out client.
    let creationResult;
    try {
      creationResult = await db.transaction(async tx => {
        const callerIdentityId = await getCallerIdentity(tx, userId, internalGuildId, true);
        if (!callerIdentityId) {
          return { rejection: { status: 403, error: 'You must have a linked account in this guild' } };
        }

        if (await isInAnyFaction(tx, internalGuildId, callerIdentityId)) {
          return { rejection: { status: 409, error: 'You are already in a faction in this guild' } };
        }

        await tx.run(
          `INSERT INTO factions (guild_id, name, tag, description, emblem, is_open, flag_url, created_by_identity_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            internalGuildId,
            name.trim(),
            tag.trim().toUpperCase(),
            description ? description.trim() : null,
            emblem || '⚔️',
            is_open !== false ? 1 : 0,
            flag_url || null,
            callerIdentityId,
          ]
        );

        const createdFaction = await tx.get(
          'SELECT * FROM factions WHERE guild_id = ? AND tag = ?',
          [internalGuildId, tag.trim().toUpperCase()]
        );

        await tx.run(
          'INSERT INTO faction_members (faction_id, guild_id, identity_id, rank) VALUES (?, ?, ?, ?)',
          [createdFaction.id, internalGuildId, callerIdentityId, 'leader']
        );
        return { faction: createdFaction };
      });
    } catch (innerErr) {
      if (innerErr.code === '23505' &&
          innerErr.constraint === 'faction_members_guild_identity_unique') {
        return res.status(409).json({ error: 'You are already in a faction in this guild' });
      }
      if (innerErr.code === '23505' || (innerErr.message && innerErr.message.includes('UNIQUE'))) {
        return res.status(409).json({ error: 'A faction with that name or tag already exists' });
      }
      throw innerErr;
    }

    if (creationResult.rejection) {
      return res.status(creationResult.rejection.status).json({ error: creationResult.rejection.error });
    }

    res.status(201).json({ success: true, faction: creationResult.faction });
  } catch (err) {
    console.error('POST /api/factions/:guildId error:', err);
    res.status(500).json({ error: 'Failed to create faction' });
  }
});

// ---------------------------------------------------------------------------
// PUT /:guildId/:factionId — Update faction metadata (leader only)
// ---------------------------------------------------------------------------

router.put('/:guildId/:factionId', async (req, res) => {
  const db = req.app.locals.db;
  const { guildId, factionId } = req.params;
  const { name, tag, description, emblem, is_open, flag_url } = req.body;
  const userId = req.user.id;

  try {
    const accessToken = req.user.access_token;
    const isMember = await verifyGuildMembership(accessToken, guildId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this guild' });
    }
    if (!isAllowedFlagUrl(flag_url)) {
      return res.status(400).json({ error: 'Invalid flag_url' });
    }

    const internalGuildId = await resolveGuild(db, guildId);
    if (!internalGuildId) return res.status(404).json({ error: 'Guild not found' });

    const faction = await resolveFactionInGuild(db, factionId, internalGuildId);
    if (!faction) return res.status(404).json({ error: 'Faction not found' });

    // Build update with only provided fields
    const updates = {};
    if (name !== undefined) updates.name = name.trim();
    if (tag !== undefined) updates.tag = tag.trim().toUpperCase();
    if (description !== undefined) updates.description = description ? description.trim() : null;
    if (emblem !== undefined) updates.emblem = emblem;
    if (is_open !== undefined) updates.is_open = is_open ? 1 : 0;
    if (flag_url !== undefined) updates.flag_url = flag_url || null;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), faction.id, internalGuildId];

    let result;
    try {
      result = await db.transaction(async tx => {
        const lockedFaction = await lockFactionInGuild(tx, faction.id, internalGuildId);
        if (!lockedFaction) {
          return { rejection: { status: 404, error: 'Faction not found' } };
        }

        const callerIdentityId = await getCallerIdentity(tx, userId, internalGuildId, true);
        const membership = callerIdentityId
          ? await getFactionMembershipForUpdate(tx, faction.id, callerIdentityId)
          : null;
        if (!membership || membership.rank !== 'leader') {
          return {
            rejection: { status: 403, error: 'Only the faction leader can update faction details' },
          };
        }

        await tx.run(
          `UPDATE factions SET ${setClauses} WHERE id = ? AND guild_id = ?`,
          values
        );
        const updated = await tx.get(
          'SELECT * FROM factions WHERE id = ? AND guild_id = ?',
          [faction.id, internalGuildId]
        );
        return { faction: updated };
      });
    } catch (innerErr) {
      if (innerErr.code === '23505' || (innerErr.message && innerErr.message.includes('UNIQUE'))) {
        return res.status(409).json({ error: 'A faction with that name or tag already exists' });
      }
      throw innerErr;
    }

    if (result.rejection) {
      return res.status(result.rejection.status).json({ error: result.rejection.error });
    }
    res.json({ success: true, faction: result.faction });
  } catch (err) {
    console.error('PUT /api/factions/:guildId/:factionId error:', err);
    res.status(500).json({ error: 'Failed to update faction' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /:guildId/:factionId — Disband faction (leader only)
// ---------------------------------------------------------------------------

router.delete('/:guildId/:factionId', async (req, res) => {
  const db = req.app.locals.db;
  const { guildId, factionId } = req.params;
  const userId = req.user.id;

  try {
    const accessToken = req.user.access_token;
    const isMember = await verifyGuildMembership(accessToken, guildId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this guild' });
    }

    const internalGuildId = await resolveGuild(db, guildId);
    if (!internalGuildId) return res.status(404).json({ error: 'Guild not found' });

    const faction = await resolveFactionInGuild(db, factionId, internalGuildId);
    if (!faction) return res.status(404).json({ error: 'Faction not found' });

    const rejection = await db.transaction(async tx => {
      const lockedFaction = await lockFactionInGuild(tx, faction.id, internalGuildId);
      if (!lockedFaction) return { status: 404, error: 'Faction not found' };

      const callerIdentityId = await getCallerIdentity(tx, userId, internalGuildId, true);
      const membership = callerIdentityId
        ? await getFactionMembershipForUpdate(tx, faction.id, callerIdentityId)
        : null;
      if (!membership || membership.rank !== 'leader') {
        return { status: 403, error: 'Only the faction leader can disband the faction' };
      }

      // CASCADE constraints handle faction_members and faction_invites cleanup.
      await tx.run(
        'DELETE FROM factions WHERE id = ? AND guild_id = ?',
        [faction.id, internalGuildId]
      );
      return null;
    });

    if (rejection) {
      return res.status(rejection.status).json({ error: rejection.error });
    }
    res.json({ success: true, message: 'Faction disbanded' });
  } catch (err) {
    console.error('DELETE /api/factions/:guildId/:factionId error:', err);
    res.status(500).json({ error: 'Failed to disband faction' });
  }
});

// ---------------------------------------------------------------------------
// POST /:guildId/:factionId/join — Join an open faction
// ---------------------------------------------------------------------------

router.post('/:guildId/:factionId/join', async (req, res) => {
  const db = req.app.locals.db;
  const { guildId, factionId } = req.params;
  const userId = req.user.id;

  try {
    const accessToken = req.user.access_token;
    const isMember = await verifyGuildMembership(accessToken, guildId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this guild' });
    }

    const internalGuildId = await resolveGuild(db, guildId);
    if (!internalGuildId) return res.status(404).json({ error: 'Guild not found' });

    const faction = await resolveFactionInGuild(db, factionId, internalGuildId);
    if (!faction) return res.status(404).json({ error: 'Faction not found' });

    let rejection;
    try {
      rejection = await db.transaction(async tx => {
        const lockedFaction = await lockFactionInGuild(tx, faction.id, internalGuildId);
        if (!lockedFaction) return { status: 404, error: 'Faction not found' };
        if (!lockedFaction.is_open) {
          return { status: 403, error: 'This faction is invite-only' };
        }

        const callerIdentityId = await getCallerIdentity(tx, userId, internalGuildId, true);
        if (!callerIdentityId) {
          return { status: 403, error: 'You must have a linked account in this guild' };
        }
        if (await isInAnyFaction(tx, internalGuildId, callerIdentityId)) {
          return { status: 409, error: 'You are already in a faction in this guild' };
        }

        await tx.run(
          'INSERT INTO faction_members (faction_id, guild_id, identity_id, rank) VALUES (?, ?, ?, ?)',
          [faction.id, internalGuildId, callerIdentityId, 'member']
        );
        return null;
      });
    } catch (innerErr) {
      if (innerErr.code === '23505' || (innerErr.message && innerErr.message.includes('UNIQUE'))) {
        return res.status(409).json({ error: 'You are already in a faction in this guild' });
      }
      throw innerErr;
    }

    if (rejection) {
      return res.status(rejection.status).json({ error: rejection.error });
    }
    res.json({ success: true, message: 'Joined faction' });
  } catch (err) {
    console.error('POST /:guildId/:factionId/join error:', err);
    res.status(500).json({ error: 'Failed to join faction' });
  }
});

// ---------------------------------------------------------------------------
// POST /:guildId/:factionId/leave — Leave a faction
// Leaders must transfer leadership or disband before leaving.
// ---------------------------------------------------------------------------

router.post('/:guildId/:factionId/leave', async (req, res) => {
  const db = req.app.locals.db;
  const { guildId, factionId } = req.params;
  const userId = req.user.id;

  try {
    const accessToken = req.user.access_token;
    const isMember = await verifyGuildMembership(accessToken, guildId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this guild' });
    }

    const internalGuildId = await resolveGuild(db, guildId);
    if (!internalGuildId) return res.status(404).json({ error: 'Guild not found' });

    const faction = await resolveFactionInGuild(db, factionId, internalGuildId);
    if (!faction) return res.status(404).json({ error: 'Faction not found' });

    const rejection = await db.transaction(async tx => {
      const lockedFaction = await lockFactionInGuild(tx, faction.id, internalGuildId);
      if (!lockedFaction) return { status: 404, error: 'Faction not found' };

      const callerIdentityId = await getCallerIdentity(tx, userId, internalGuildId, true);
      const membership = callerIdentityId
        ? await getFactionMembershipForUpdate(tx, faction.id, callerIdentityId)
        : null;
      if (!membership) {
        return { status: 403, error: 'You are not a member of this faction' };
      }
      if (membership.rank === 'leader') {
        return {
          status: 409,
          error: 'Leaders must transfer leadership or disband the faction before leaving',
        };
      }

      await tx.run(
        'DELETE FROM faction_members WHERE faction_id = ? AND identity_id = ?',
        [faction.id, callerIdentityId]
      );
      return null;
    });

    if (rejection) {
      return res.status(rejection.status).json({ error: rejection.error });
    }
    res.json({ success: true, message: 'Left faction' });
  } catch (err) {
    console.error('POST /:guildId/:factionId/leave error:', err);
    res.status(500).json({ error: 'Failed to leave faction' });
  }
});

// ---------------------------------------------------------------------------
// PUT /:guildId/:factionId/members/:identityId — Promote or demote a member
// Allowed by leader or officer (officers cannot promote to leader).
// Body: { rank: 'officer' | 'member' }
// ---------------------------------------------------------------------------

router.put('/:guildId/:factionId/members/:identityId', async (req, res) => {
  const db = req.app.locals.db;
  const { guildId, factionId, identityId } = req.params;
  const { rank } = req.body;
  const userId = req.user.id;

  const validRanks = ['officer', 'member'];
  if (!rank || !validRanks.includes(rank)) {
    return res.status(400).json({ error: 'rank must be "officer" or "member"' });
  }

  try {
    const accessToken = req.user.access_token;
    const isMember = await verifyGuildMembership(accessToken, guildId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this guild' });
    }

    const internalGuildId = await resolveGuild(db, guildId);
    if (!internalGuildId) return res.status(404).json({ error: 'Guild not found' });

    const faction = await resolveFactionInGuild(db, factionId, internalGuildId);
    if (!faction) return res.status(404).json({ error: 'Faction not found' });

    const rejection = await db.transaction(async tx => {
      const lockedFaction = await lockFactionInGuild(tx, faction.id, internalGuildId);
      if (!lockedFaction) return { status: 404, error: 'Faction not found' };

      const callerIdentityId = await getCallerIdentity(tx, userId, internalGuildId, true);
      const callerMembership = callerIdentityId
        ? await getFactionMembershipForUpdate(tx, faction.id, callerIdentityId)
        : null;

      if (!callerMembership || !['leader', 'officer'].includes(callerMembership.rank)) {
        return { status: 403, error: 'Only leaders and officers can change member ranks' };
      }

      // Officers cannot promote to officer — only leaders can
      if (rank === 'officer' && callerMembership.rank !== 'leader') {
        return { status: 403, error: 'Only the leader can promote members to officer' };
      }

      const targetMembership = await getFactionMembershipForUpdate(tx, faction.id, identityId);
      if (!targetMembership) {
        return { status: 404, error: 'That player is not a member of this faction' };
      }
      if (targetMembership.rank === 'leader') {
        return { status: 403, error: 'Cannot change the rank of the faction leader' };
      }

      await tx.run(
        'UPDATE faction_members SET rank = ? WHERE faction_id = ? AND identity_id = ?',
        [rank, faction.id, identityId]
      );
      return null;
    });

    if (rejection) {
      return res.status(rejection.status).json({ error: rejection.error });
    }

    res.json({ success: true, message: `Member rank updated to ${rank}` });
  } catch (err) {
    console.error('PUT /:guildId/:factionId/members/:identityId error:', err);
    res.status(500).json({ error: 'Failed to update member rank' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /:guildId/:factionId/members/:identityId — Kick a member
// Allowed by leader or officer; cannot kick the leader.
// ---------------------------------------------------------------------------

router.delete('/:guildId/:factionId/members/:identityId', async (req, res) => {
  const db = req.app.locals.db;
  const { guildId, factionId, identityId } = req.params;
  const userId = req.user.id;

  try {
    const accessToken = req.user.access_token;
    const isMember = await verifyGuildMembership(accessToken, guildId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this guild' });
    }

    const internalGuildId = await resolveGuild(db, guildId);
    if (!internalGuildId) return res.status(404).json({ error: 'Guild not found' });

    const faction = await resolveFactionInGuild(db, factionId, internalGuildId);
    if (!faction) return res.status(404).json({ error: 'Faction not found' });

    const rejection = await db.transaction(async tx => {
      const lockedFaction = await lockFactionInGuild(tx, faction.id, internalGuildId);
      if (!lockedFaction) return { status: 404, error: 'Faction not found' };

      const callerIdentityId = await getCallerIdentity(tx, userId, internalGuildId, true);
      const callerMembership = callerIdentityId
        ? await getFactionMembershipForUpdate(tx, faction.id, callerIdentityId)
        : null;

      if (!callerMembership || !['leader', 'officer'].includes(callerMembership.rank)) {
        return { status: 403, error: 'Only leaders and officers can kick members' };
      }

      const targetMembership = await getFactionMembershipForUpdate(tx, faction.id, identityId);
      if (!targetMembership) {
        return { status: 404, error: 'That player is not a member of this faction' };
      }
      if (targetMembership.rank === 'leader') {
        return { status: 403, error: 'Cannot kick the faction leader' };
      }
      // Officers cannot kick other officers — only the leader can
      if (callerMembership.rank === 'officer' && targetMembership.rank === 'officer') {
        return { status: 403, error: 'Officers cannot kick other officers' };
      }

      await tx.run(
        'DELETE FROM faction_members WHERE faction_id = ? AND identity_id = ?',
        [faction.id, identityId]
      );
      return null;
    });

    if (rejection) {
      return res.status(rejection.status).json({ error: rejection.error });
    }

    res.json({ success: true, message: 'Member kicked' });
  } catch (err) {
    console.error('DELETE /:guildId/:factionId/members/:identityId error:', err);
    res.status(500).json({ error: 'Failed to kick member' });
  }
});

// ---------------------------------------------------------------------------
// POST /:guildId/:factionId/invites — Send invite to a player
// Faction must be closed (is_open = false). Caller must be leader or officer.
// Body: { identityId: number }
// ---------------------------------------------------------------------------

router.post('/:guildId/:factionId/invites', async (req, res) => {
  const db = req.app.locals.db;
  const { guildId, factionId } = req.params;
  const { identityId: inviteeIdentityId } = req.body;
  const userId = req.user.id;

  if (!inviteeIdentityId) {
    return res.status(400).json({ error: 'identityId is required' });
  }

  try {
    const accessToken = req.user.access_token;
    const isMember = await verifyGuildMembership(accessToken, guildId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this guild' });
    }

    const internalGuildId = await resolveGuild(db, guildId);
    if (!internalGuildId) return res.status(404).json({ error: 'Guild not found' });

    const faction = await resolveFactionInGuild(db, factionId, internalGuildId);
    if (!faction) return res.status(404).json({ error: 'Faction not found' });

    let rejection;
    try {
      rejection = await db.transaction(async tx => {
        const lockedFaction = await lockFactionInGuild(tx, faction.id, internalGuildId);
        if (!lockedFaction) return { status: 404, error: 'Faction not found' };
        if (lockedFaction.is_open) {
          return { status: 403, error: 'Open factions do not use invitations' };
        }

        const callerIdentityId = await getCallerIdentity(tx, userId, internalGuildId, true);
        const callerMembership = callerIdentityId
          ? await getFactionMembershipForUpdate(tx, faction.id, callerIdentityId)
          : null;
        if (!callerMembership || !['leader', 'officer'].includes(callerMembership.rank)) {
          return { status: 403, error: 'Only leaders and officers can send invites' };
        }

        if (await isInAnyFaction(tx, internalGuildId, inviteeIdentityId)) {
          return { status: 409, error: 'That player is already in a faction' };
        }

        const inviteeInGuild = await tx.get(
          `SELECT pi.id
           FROM player_identities pi
           JOIN player_server_activity psa ON psa.identity_id = pi.id
           JOIN servers s ON s.id = psa.server_id
           WHERE pi.id = ? AND s.guild_id = ?
           LIMIT 1`,
          [inviteeIdentityId, internalGuildId]
        );
        if (!inviteeInGuild) {
          return { status: 404, error: 'That player is not in this guild' };
        }

        await tx.run(
          `INSERT INTO faction_invites (faction_id, inviter_identity_id, invitee_identity_id)
           VALUES (?, ?, ?)`,
          [faction.id, callerIdentityId, inviteeIdentityId]
        );
        return null;
      });
    } catch (innerErr) {
      if (innerErr.code === '23505' || (innerErr.message && innerErr.message.includes('UNIQUE'))) {
        return res.status(409).json({ error: 'An invite for this player already exists' });
      }
      throw innerErr;
    }

    if (rejection) {
      return res.status(rejection.status).json({ error: rejection.error });
    }
    res.status(201).json({ success: true, message: 'Invite sent' });
  } catch (err) {
    console.error('POST /:guildId/:factionId/invites error:', err);
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

// ---------------------------------------------------------------------------
// GET /:guildId/invites/pending — Get pending invites for the current user
// ---------------------------------------------------------------------------

router.get('/:guildId/invites/pending', async (req, res) => {
  const db = req.app.locals.db;
  const { guildId } = req.params;
  const userId = req.user.id;

  try {
    const accessToken = req.user.access_token;
    const isMember = await verifyGuildMembership(accessToken, guildId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this guild' });
    }

    const internalGuildId = await resolveGuild(db, guildId);
    if (!internalGuildId) return res.status(404).json({ error: 'Guild not found' });

    const callerIdentityId = await getCallerIdentity(db, userId, internalGuildId);
    if (!callerIdentityId) {
      return res.json({ success: true, invites: [] });
    }

    const invites = await db.all(
      `SELECT fi.id, fi.faction_id, fi.created_at, fi.expires_at,
              f.name AS faction_name, f.tag AS faction_tag, f.emblem AS faction_emblem,
              COALESCE(pg.gamertag, pi.platform_username) AS inviter_name
       FROM faction_invites fi
       JOIN factions f ON f.id = fi.faction_id
       JOIN player_identities pi ON pi.id = fi.inviter_identity_id
       LEFT JOIN LATERAL (
         SELECT gamertag FROM player_gamertags
         WHERE identity_id = fi.inviter_identity_id AND is_current_gamertag = 1
         ORDER BY last_seen DESC NULLS LAST LIMIT 1
       ) pg ON TRUE
       WHERE fi.invitee_identity_id = ?
         AND fi.expires_at > NOW()
         AND f.guild_id = ?
       ORDER BY fi.created_at DESC`,
      [callerIdentityId, internalGuildId]
    );

    res.json({ success: true, invites });
  } catch (err) {
    console.error('GET /:guildId/invites/pending error:', err);
    res.status(500).json({ error: 'Failed to load invites' });
  }
});

// ---------------------------------------------------------------------------
// POST /invites/:inviteId/accept — Accept a pending invite
// ---------------------------------------------------------------------------

router.post('/invites/:inviteId/accept', async (req, res) => {
  const db = req.app.locals.db;
  const { inviteId } = req.params;
  const userId = req.user.id;

  try {
    try {
      const rejection = await db.transaction(async tx => {
        // Lock the parent faction before its invite row. Faction deletion follows
        // the same parent-first order before cascading to child invite rows.
        const lockedFaction = await tx.get(
          `SELECT f.id, f.guild_id
           FROM faction_invites fi
           JOIN factions f ON f.id = fi.faction_id
           WHERE fi.id = ?
           FOR UPDATE OF f`,
          [inviteId]
        );
        if (!lockedFaction) {
          return { status: 404, error: 'Invite not found or expired' };
        }

        // Lock and revalidate the invite on the same client used for membership
        // creation so expiration, decline, and cancellation cannot race acceptance.
        const invite = await tx.get(
          `SELECT fi.*, f.guild_id AS internal_guild_id
           FROM faction_invites fi
           JOIN factions f ON f.id = fi.faction_id
           WHERE fi.id = ? AND fi.faction_id = ? AND f.guild_id = ?
           FOR UPDATE OF fi`,
          [inviteId, lockedFaction.id, lockedFaction.guild_id]
        );
        if (!invite) {
          return { status: 404, error: 'Invite not found or expired' };
        }
        const expiry = await tx.get(
          'SELECT expires_at > clock_timestamp() AS unexpired FROM faction_invites WHERE id = ?',
          [inviteId]
        );
        if (!expiry?.unexpired) {
          return { status: 404, error: 'Invite not found or expired' };
        }

        const callerIdentityId = await getCallerIdentity(tx, userId, invite.internal_guild_id, true);
        if (!callerIdentityId || callerIdentityId !== invite.invitee_identity_id) {
          return { status: 403, error: 'This invite is not for you' };
        }

        if (await isInAnyFaction(tx, invite.internal_guild_id, callerIdentityId)) {
          return { status: 409, error: 'You are already in a faction in this guild' };
        }

        await tx.run(
          'INSERT INTO faction_members (faction_id, guild_id, identity_id, rank) VALUES (?, ?, ?, ?)',
          [invite.faction_id, invite.internal_guild_id, callerIdentityId, 'member']
        );
        await tx.run('DELETE FROM faction_invites WHERE id = ?', [inviteId]);
        return null;
      });

      if (rejection) {
        return res.status(rejection.status).json({ error: rejection.error });
      }
    } catch (innerErr) {
      if (innerErr.code === '23505' || (innerErr.message && innerErr.message.includes('UNIQUE'))) {
        return res.status(409).json({ error: 'You are already in a faction in this guild' });
      }
      throw innerErr;
    }

    res.json({ success: true, message: 'Invite accepted' });
  } catch (err) {
    console.error('POST /invites/:inviteId/accept error:', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /invites/:inviteId — Decline or cancel an invite
// Invitee can decline; leader/officer of the faction can cancel.
// ---------------------------------------------------------------------------

router.delete('/invites/:inviteId', async (req, res) => {
  const db = req.app.locals.db;
  const { inviteId } = req.params;
  const userId = req.user.id;

  try {
    const rejection = await db.transaction(async tx => {
      const lockedFaction = await tx.get(
        `SELECT f.id, f.guild_id
         FROM faction_invites fi
         JOIN factions f ON f.id = fi.faction_id
         WHERE fi.id = ?
         FOR UPDATE OF f`,
        [inviteId]
      );
      if (!lockedFaction) return { status: 404, error: 'Invite not found' };

      const invite = await tx.get(
        `SELECT fi.*, f.guild_id AS internal_guild_id
         FROM faction_invites fi
         JOIN factions f ON f.id = fi.faction_id
         WHERE fi.id = ? AND fi.faction_id = ? AND f.guild_id = ?
         FOR UPDATE OF fi`,
        [inviteId, lockedFaction.id, lockedFaction.guild_id]
      );
      if (!invite) return { status: 404, error: 'Invite not found' };

      const callerIdentityId = await getCallerIdentity(tx, userId, invite.internal_guild_id, true);
      const isInvitee = callerIdentityId && callerIdentityId === invite.invitee_identity_id;

      let isOfficer = false;
      if (!isInvitee && callerIdentityId) {
        const callerMembership = await getFactionMembershipForUpdate(
          tx,
          invite.faction_id,
          callerIdentityId
        );
        isOfficer = Boolean(
          callerMembership && ['leader', 'officer'].includes(callerMembership.rank)
        );
      }

      if (!isInvitee && !isOfficer) {
        return { status: 403, error: 'You cannot cancel this invite' };
      }

      await tx.run(
        'DELETE FROM faction_invites WHERE id = ? AND faction_id = ?',
        [inviteId, invite.faction_id]
      );
      return null;
    });

    if (rejection) {
      return res.status(rejection.status).json({ error: rejection.error });
    }
    res.json({ success: true, message: 'Invite removed' });
  } catch (err) {
    console.error('DELETE /invites/:inviteId error:', err);
    res.status(500).json({ error: 'Failed to remove invite' });
  }
});

// ---------------------------------------------------------------------------
// GET /:guildId/:factionId/map — Faction map data (markers + member positions)
//
// Query param: ?mapName=chernarusplus (defaults to chernarusplus)
//
// Returns:
//   markers      — all faction_markers for this faction on this map
//   members      — all faction member last positions from player_health_status
//   callerIdentityId — so the client can highlight "you" on the map
// ---------------------------------------------------------------------------

router.get('/:guildId/:factionId/map', async (req, res) => {
  const db = req.app.locals.db;
  const { guildId, factionId } = req.params;
  const mapName = req.query.mapName || 'chernarusplus';
  const serverId = req.query.serverId;
  const userId = req.user.id;

  if (!/^\d+$/.test(String(serverId || ''))) {
    return res.status(400).json({ error: 'serverId is required' });
  }

  try {
    const accessToken = req.user.access_token;
    const isMember = await verifyGuildMembership(accessToken, guildId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this guild' });
    }

    const internalGuildId = await resolveGuild(db, guildId);
    if (!internalGuildId) return res.status(404).json({ error: 'Guild not found' });

    const server = await db.get(
      `SELECT s.id
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
       WHERE s.id = ? AND s.guild_id = ?
         AND s.status = 'active' AND g.status = 'approved'`,
      [serverId, internalGuildId]
    );
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const policyRow = await db.get(
      "SELECT config FROM server_features WHERE server_id = ? AND feature_name = 'player_map'",
      [server.id]
    );
    const playerMapSettings = parsePlayerMapSettings(policyRow?.config);

    // Verify faction belongs to guild
    const faction = await db.get(
      'SELECT id FROM factions WHERE id = ? AND guild_id = ?',
      [factionId, internalGuildId]
    );
    if (!faction) return res.status(404).json({ error: 'Faction not found' });

    // Caller must have trusted membership on the exact active server.
    const callerRow = await db.get(
      `SELECT spm.identity_id AS id
       FROM server_player_memberships spm
       JOIN linked_accounts la
         ON la.id = spm.source_link_id
        AND la.identity_id = spm.identity_id
        AND la.user_id = spm.user_id
        AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
       WHERE spm.user_id = ? AND spm.guild_id = ? AND spm.server_id = ?
         AND spm.status = 'active'
       LIMIT 1`,
      [userId, internalGuildId, server.id]
    );
    const callerIdentityId = callerRow?.id || null;
    if (!callerIdentityId) {
      return res.status(403).json({ error: 'You must have a linked account in this guild' });
    }
    const callerMembership = await getCallerMembership(db, factionId, callerIdentityId);
    if (!callerMembership) {
      return res.status(403).json({ error: 'You are not a member of this faction' });
    }

    // Fetch markers only when the exact server policy permits them.
    const markers = isPlayerMapFeatureEnabled(playerMapSettings, 'factionMarkers')
      ? await db.all(
      `SELECT fm.*,
              COALESCE(pg.gamertag, pi.platform_username) AS creator_name
       FROM faction_markers fm
       JOIN player_identities pi ON pi.id = fm.created_by_identity_id
       LEFT JOIN LATERAL (
         SELECT gamertag FROM player_gamertags
         WHERE identity_id = fm.created_by_identity_id AND is_current_gamertag = 1
         ORDER BY last_seen DESC NULLS LAST LIMIT 1
       ) pg ON TRUE
       WHERE fm.faction_id = ? AND fm.server_id = ? AND fm.map_name = ?
       ORDER BY fm.created_at DESC`,
      [factionId, server.id, mapName]
    ) : [];

    // Fetch newest regular PlayerList position for each faction member only when
    // health timestamps are intentionally separate from location freshness.
    const members = isPlayerMapFeatureEnabled(playerMapSettings, 'factionMembers')
      ? await db.all(
      `SELECT ps.identity_id,
              ps.pos_x,
              ps.pos_y,
              ps.pos_z,
              ps.timestamp AS last_updated,
              COALESCE(pg.gamertag, pi.platform_username) AS player_name
       FROM faction_members fmem
       JOIN player_identities pi ON pi.id = fmem.identity_id
       JOIN server_player_memberships spm
         ON spm.identity_id = fmem.identity_id
        AND spm.server_id = ?
        AND spm.guild_id = ?
        AND spm.status = 'active'
       LEFT JOIN LATERAL (
         SELECT gamertag FROM player_gamertags
         WHERE identity_id = fmem.identity_id AND server_id = ? AND is_current_gamertag = 1
         ORDER BY last_seen DESC NULLS LAST LIMIT 1
       ) pg ON TRUE
       LEFT JOIN LATERAL (
         SELECT identity_id, pos_x, pos_y, pos_z, timestamp
         FROM player_position_snapshots
         WHERE identity_id = fmem.identity_id AND server_id = ?
           AND pos_x IS NOT NULL AND pos_y IS NOT NULL
         ORDER BY timestamp DESC, id DESC
         LIMIT 1
       ) ps ON TRUE
       WHERE fmem.faction_id = ?
       ORDER BY player_name ASC`,
      [server.id, internalGuildId, server.id, server.id, factionId]
    ) : [];

    res.json({
      success: true,
      mapName,
      markers,
      members: members.map(member => ({
        ...member,
        position: member.pos_x == null || member.pos_y == null
          ? null
          : admTupleToWorld(member),
      })),
      callerIdentityId,
      callerRank: callerMembership.rank,
    });
  } catch (err) {
    console.error('GET /api/factions/:guildId/:factionId/map error:', err);
    res.status(500).json({ error: 'Failed to load faction map data' });
  }
});

// ---------------------------------------------------------------------------
// POST /:guildId/:factionId/markers — Place a faction map marker
// Body: { mapName, posX, posY, title, note, icon }
// Auth: must be a faction member
// ---------------------------------------------------------------------------

router.post('/:guildId/:factionId/markers', async (req, res) => {
  const db = req.app.locals.db;
  const { guildId, factionId } = req.params;
  const { serverId, mapName, posX, posY, title, note, icon } = req.body;
  const userId = req.user.id;

  if (!/^\d+$/.test(String(serverId || ''))) {
    return res.status(400).json({ error: 'serverId is required' });
  }
  if (!mapName || posX == null || posY == null) {
    return res.status(400).json({ error: 'mapName, posX, and posY are required' });
  }

  try {
    const accessToken = req.user.access_token;
    const isMember = await verifyGuildMembership(accessToken, guildId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this guild' });
    }

    const internalGuildId = await resolveGuild(db, guildId);
    if (!internalGuildId) return res.status(404).json({ error: 'Guild not found' });

    const faction = await resolveFactionInGuild(db, factionId, internalGuildId);
    if (!faction) return res.status(404).json({ error: 'Faction not found' });

    const result = await db.transaction(async tx => {
      const lockedServer = await lockActiveServer(tx, Number(serverId), internalGuildId);
      if (!lockedServer) {
        return { rejection: { status: 404, error: 'Server not found' } };
      }
      const playerMapSettings = await lockPlayerMapPolicy(tx, lockedServer.id);
      if (!isPlayerMapFeatureEnabled(playerMapSettings, 'factionMarkers')) {
        return { rejection: { status: 403, error: 'Faction markers are disabled' } };
      }
      const callerIdentityId = await getCallerIdentityForServer(
        tx,
        userId,
        internalGuildId,
        lockedServer.id,
        true
      );
      if (!callerIdentityId) {
        return { rejection: { status: 403, error: 'Access denied' } };
      }
      const lockedFaction = await lockFactionInGuild(tx, faction.id, internalGuildId);
      if (!lockedFaction) {
        return { rejection: { status: 404, error: 'Faction not found' } };
      }

      const membership = await getFactionMembershipForUpdate(tx, faction.id, callerIdentityId);
      if (!membership) {
        return {
          rejection: { status: 403, error: 'You are not a member of this faction' },
        };
      }

      const marker = await tx.get(
        `INSERT INTO faction_markers
           (server_id, faction_id, created_by_identity_id, map_name, pos_x, pos_y, title, note, icon)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
        [
          lockedServer.id,
          faction.id,
          callerIdentityId,
          mapName,
          parseFloat(posX),
          parseFloat(posY),
          (title || 'Marker').trim(),
          note ? note.trim() : null,
          icon || '📍',
        ]
      );
      return { marker };
    });

    if (result.rejection) {
      return res.status(result.rejection.status).json({ error: result.rejection.error });
    }
    res.status(201).json({ success: true, marker: result.marker });
  } catch (err) {
    console.error('POST /markers error:', err);
    res.status(500).json({ error: 'Failed to place marker' });
  }
});

// ---------------------------------------------------------------------------
// PUT /:guildId/:factionId/markers/:markerId — Edit a marker's title/note/icon
// Body: { title, note, icon }  (position is immutable — delete + recreate instead)
// Auth: own marker OR leader/officer
// ---------------------------------------------------------------------------

router.put('/:guildId/:factionId/markers/:markerId', async (req, res) => {
  const db = req.app.locals.db;
  const { guildId, factionId, markerId } = req.params;
  const { serverId, title, note, icon } = req.body;
  const userId = req.user.id;

  if (!/^\d+$/.test(String(serverId || ''))) {
    return res.status(400).json({ error: 'serverId is required' });
  }

  try {
    const accessToken = req.user.access_token;
    const isMember = await verifyGuildMembership(accessToken, guildId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this guild' });
    }

    const internalGuildId = await resolveGuild(db, guildId);
    if (!internalGuildId) return res.status(404).json({ error: 'Guild not found' });

    const faction = await resolveFactionInGuild(db, factionId, internalGuildId);
    if (!faction) return res.status(404).json({ error: 'Faction not found' });

    const result = await db.transaction(async tx => {
      const lockedServer = await lockActiveServer(tx, Number(serverId), internalGuildId);
      if (!lockedServer) return { rejection: { status: 404, error: 'Server not found' } };
      const playerMapSettings = await lockPlayerMapPolicy(tx, lockedServer.id);
      if (!isPlayerMapFeatureEnabled(playerMapSettings, 'factionMarkers')) {
        return { rejection: { status: 403, error: 'Faction markers are disabled' } };
      }
      const callerIdentityId = await getCallerIdentityForServer(
        tx,
        userId,
        internalGuildId,
        lockedServer.id,
        true
      );
      if (!callerIdentityId) return { rejection: { status: 403, error: 'Access denied' } };
      const lockedFaction = await lockFactionInGuild(tx, faction.id, internalGuildId);
      if (!lockedFaction) return { rejection: { status: 404, error: 'Faction not found' } };

      const marker = await tx.get(
        'SELECT * FROM faction_markers WHERE id = ? AND faction_id = ? AND server_id = ? FOR UPDATE',
        [markerId, faction.id, lockedServer.id]
      );
      if (!marker) return { rejection: { status: 404, error: 'Marker not found' } };

      const callerMembership = await getFactionMembershipForUpdate(tx, faction.id, callerIdentityId);

      const isOwner = callerIdentityId === marker.created_by_identity_id;
      const canManage = callerMembership && ['leader', 'officer'].includes(callerMembership.rank);

      if (!isOwner && !canManage) {
        return { rejection: { status: 403, error: 'You do not have permission to edit this marker' } };
      }

      const updates = {};
      if (title !== undefined) updates.title = title.trim();
      if (note !== undefined) updates.note = note ? note.trim() : null;
      if (icon !== undefined) updates.icon = icon;
      updates.updated_at = new Date().toISOString();

      if (Object.keys(updates).length === 1) { // only updated_at
        return { rejection: { status: 400, error: 'No fields to update' } };
      }

      const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      await tx.run(
        `UPDATE faction_markers SET ${setClauses} WHERE id = ? AND faction_id = ? AND server_id = ?`,
        [...Object.values(updates), markerId, faction.id, lockedServer.id]
      );

      const updated = await tx.get(
        'SELECT * FROM faction_markers WHERE id = ? AND faction_id = ? AND server_id = ?',
        [markerId, faction.id, lockedServer.id]
      );
      return { marker: updated };
    });

    if (result.rejection) {
      return res.status(result.rejection.status).json({ error: result.rejection.error });
    }
    res.json({ success: true, marker: result.marker });
  } catch (err) {
    console.error('PUT /markers/:markerId error:', err);
    res.status(500).json({ error: 'Failed to update marker' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /:guildId/:factionId/markers/:markerId — Remove a faction marker
// Auth: own marker OR leader/officer
// ---------------------------------------------------------------------------

router.delete('/:guildId/:factionId/markers/:markerId', async (req, res) => {
  const db = req.app.locals.db;
  const { guildId, factionId, markerId } = req.params;
  const serverId = req.query.serverId;
  const userId = req.user.id;

  if (!/^\d+$/.test(String(serverId || ''))) {
    return res.status(400).json({ error: 'serverId is required' });
  }

  try {
    const accessToken = req.user.access_token;
    const isMember = await verifyGuildMembership(accessToken, guildId);
    if (!isMember) {
      return res.status(403).json({ error: 'You are not a member of this guild' });
    }

    const internalGuildId = await resolveGuild(db, guildId);
    if (!internalGuildId) return res.status(404).json({ error: 'Guild not found' });

    const faction = await resolveFactionInGuild(db, factionId, internalGuildId);
    if (!faction) return res.status(404).json({ error: 'Faction not found' });

    const rejection = await db.transaction(async tx => {
      const lockedServer = await lockActiveServer(tx, Number(serverId), internalGuildId);
      if (!lockedServer) return { status: 404, error: 'Server not found' };
      const playerMapSettings = await lockPlayerMapPolicy(tx, lockedServer.id);
      if (!isPlayerMapFeatureEnabled(playerMapSettings, 'factionMarkers')) {
        return { status: 403, error: 'Faction markers are disabled' };
      }
      const callerIdentityId = await getCallerIdentityForServer(
        tx,
        userId,
        internalGuildId,
        lockedServer.id,
        true
      );
      if (!callerIdentityId) return { status: 403, error: 'Access denied' };
      const lockedFaction = await lockFactionInGuild(tx, faction.id, internalGuildId);
      if (!lockedFaction) return { status: 404, error: 'Faction not found' };

      const marker = await tx.get(
        'SELECT * FROM faction_markers WHERE id = ? AND faction_id = ? AND server_id = ? FOR UPDATE',
        [markerId, faction.id, lockedServer.id]
      );
      if (!marker) return { status: 404, error: 'Marker not found' };

      const callerMembership = await getFactionMembershipForUpdate(tx, faction.id, callerIdentityId);

      const isOwner = callerIdentityId === marker.created_by_identity_id;
      const canManage = callerMembership && ['leader', 'officer'].includes(callerMembership.rank);

      if (!isOwner && !canManage) {
        return { status: 403, error: 'You do not have permission to delete this marker' };
      }

      await tx.run(
        'DELETE FROM faction_markers WHERE id = ? AND faction_id = ? AND server_id = ?',
        [markerId, faction.id, lockedServer.id]
      );
      return null;
    });

    if (rejection) {
      return res.status(rejection.status).json({ error: rejection.error });
    }
    res.json({ success: true, message: 'Marker deleted' });
  } catch (err) {
    console.error('DELETE /markers/:markerId error:', err);
    res.status(500).json({ error: 'Failed to delete marker' });
  }
});

module.exports = router;
