'use strict';

const express = require('express');
const { ensureAuthenticated } = require('../middleware/auth');
const { ensurePlayerServerAccess, requireServerCapability } = require('../middleware/serverAccess');
const { strictLimiter } = require('../middleware/rateLimiter');
const { CAPABILITIES } = require('../services/authorizationService');
const bountyService = require('../services/bountyService');
const { parseIdempotencyKey } = require('../utils/financialIdempotency');

const router = express.Router();
router.use(ensureAuthenticated);

function validatePositiveIdParam(req, res, next, value) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    return res.status(400).json({ error: 'Invalid resource identifier' });
  }
  return next();
}

router.param('serverId', validatePositiveIdParam);
router.param('bountyId', validatePositiveIdParam);
const requireServerManage = requireServerCapability(CAPABILITIES.SERVER_MANAGE);

function playerContext(req) {
  const context = req.playerServerAccess;
  if (!context?.serverId || !context?.identityId) throw new Error('Player membership required');
  return { ...context, userId: req.user.id };
}

function serializePublicBounty(row, viewerIdentityId) {
  const bounty = {
    ...bountyService.serializeBounty(row),
    targetGamertag: row.target_gamertag || null,
    posterGamertag: row.poster_gamertag || null,
    canCancel: Number(row.poster_identity_id) === Number(viewerIdentityId),
    status: row.cancellation_requested_at ? 'pending_cancellation' : row.status,
    pendingCancellation: Boolean(row.cancellation_requested_at),
  };
  if (bounty.creatorType === 'faction') {
    delete bounty.posterIdentityId;
    delete bounty.posterGamertag;
  }
  if (bounty.targetType === 'faction') {
    delete bounty.progressKills;
  }
  return bounty;
}

router.get('/admin/:serverId/settings', requireServerManage, async (req, res) => {
  try {
    const serverId = req.authorization.server.id;
    const row = await req.app.locals.db.get(
      `SELECT server_id, require_target_online, online_freshness_minutes,
              faction_kills_required, version
       FROM bounty_settings WHERE server_id = ?`,
      [serverId]
    );
    return res.json({
      success: true,
      settings: {
        serverId,
        requireTargetOnline: row?.require_target_online !== false,
        onlineFreshnessMinutes: Number(row?.online_freshness_minutes || 30),
        factionKillsRequired: Number(row?.faction_kills_required || 3),
        version: Number(row?.version || 1),
      },
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load bounty settings' });
  }
});

router.put('/admin/:serverId/settings', requireServerManage, strictLimiter, async (req, res) => {
  const db = req.app.locals.db;
  try {
    const settings = await db.transaction(() => bountyService.updateBountySettingsInTransaction(
      db,
      {
        serverId: req.authorization.server.id,
        guildId: req.authorization.guild.id,
        userId: req.user.id,
      },
      {
        requireTargetOnline: req.body?.requireTargetOnline,
        factionKillsRequired: req.body?.factionKillsRequired,
        expectedVersion: req.body?.expectedVersion,
      }
    ));
    return res.json({ success: true, settings });
  } catch (error) {
    const status = /boolean|settings version/i.test(error.message) ? 400
      : /changed.*reload/i.test(error.message) ? 409
      : /permission|required|unavailable/i.test(error.message) ? 403 : 500;
    return res.status(status).json({
      error: status === 500 ? 'Failed to update bounty settings' : error.message,
    });
  }
});

router.get('/:serverId/options', ensurePlayerServerAccess, async (req, res) => {
  try {
    const { serverId, guildId, identityId } = playerContext(req);
    const sponsor = await req.app.locals.db.get(
      `SELECT f.id, f.name, f.tag, fm.rank
       FROM faction_members fm
       JOIN factions f ON f.id = fm.faction_id AND f.guild_id = fm.guild_id
       WHERE fm.guild_id = ? AND fm.identity_id = ?`,
      [guildId, identityId]
    );
    const sponsorFilter = sponsor ? 'AND f.id <> ?' : '';
    const factionParams = sponsor
      ? [serverId, guildId, Number(sponsor.id)] : [serverId, guildId];
    const factions = await req.app.locals.db.query(
      `SELECT f.id, f.name, f.tag, COUNT(spm.identity_id) AS eligible_member_count
       FROM factions f
       LEFT JOIN faction_members fm
         ON fm.faction_id = f.id AND fm.guild_id = f.guild_id
       LEFT JOIN server_player_memberships spm
         ON spm.identity_id = fm.identity_id AND spm.server_id = ? AND spm.status = 'active'
       WHERE f.guild_id = ? ${sponsorFilter}
       GROUP BY f.id, f.name, f.tag
       HAVING COUNT(spm.identity_id) > 0
       ORDER BY f.name`,
      factionParams
    );
    const settings = await req.app.locals.db.get(
      'SELECT faction_kills_required FROM bounty_settings WHERE server_id = ?',
      [serverId]
    );
    return res.json({
      success: true,
      factions: factions.map(faction => ({
        id: Number(faction.id),
        name: faction.name,
        tag: faction.tag,
        eligibleMemberCount: Number(faction.eligible_member_count),
      })),
      sponsorFaction: sponsor ? {
        id: Number(sponsor.id), name: sponsor.name, tag: sponsor.tag, rank: sponsor.rank,
      } : null,
      canSponsorFactionBounty: ['leader', 'officer'].includes(sponsor?.rank),
      factionKillsRequired: Number(settings?.faction_kills_required || 3),
    });
  } catch (error) {
    return res.status(error.message === 'Player membership required' ? 403 : 500)
      .json({ error: error.message === 'Player membership required' ? error.message : 'Failed to load bounty options' });
  }
});

router.get('/:serverId/history', ensurePlayerServerAccess, async (req, res) => {
  try {
    const { serverId, identityId } = playerContext(req);
    const rows = await req.app.locals.db.query(
      `SELECT b.*,
              target_tag.gamertag AS target_gamertag,
              (SELECT COUNT(*) FROM bounty_faction_members bfm
               WHERE bfm.bounty_id = b.id AND bfm.member_role = 'target') AS eligible_member_count,
              (SELECT COUNT(DISTINCT boe.victim_identity_id) FROM bounty_objective_events boe
               WHERE boe.bounty_id = b.id) AS progress_kills
       FROM bounties b
       LEFT JOIN player_gamertags target_tag
         ON b.target_type = 'player' AND target_tag.identity_id = b.target_identity_id
        AND target_tag.server_id = b.server_id AND target_tag.is_current_gamertag = 1
       WHERE b.server_id = ?
         AND (b.poster_identity_id = ? OR b.claimed_by_identity_id = ?)
       ORDER BY b.id DESC LIMIT 100`,
      [serverId, identityId, identityId]
    );
    return res.json({
      success: true,
      bounties: rows.map(row => serializePublicBounty(row, identityId)),
    });
  } catch (error) {
    return res.status(error.message === 'Player membership required' ? 403 : 500)
      .json({ error: error.message === 'Player membership required' ? error.message : 'Failed to load bounty history' });
  }
});

router.get('/:serverId', ensurePlayerServerAccess, async (req, res) => {
  try {
    const { serverId, identityId } = playerContext(req);
    const rows = await req.app.locals.db.query(
      `SELECT b.*,
              target_tag.gamertag AS target_gamertag,
              poster_tag.gamertag AS poster_gamertag,
              (SELECT COUNT(*) FROM bounty_faction_members bfm
               WHERE bfm.bounty_id = b.id AND bfm.member_role = 'target') AS eligible_member_count,
              (SELECT COUNT(DISTINCT boe.victim_identity_id) FROM bounty_objective_events boe
               WHERE boe.bounty_id = b.id) AS progress_kills
       FROM bounties b
       LEFT JOIN player_gamertags target_tag
         ON b.target_type = 'player'
        AND target_tag.identity_id = b.target_identity_id
        AND target_tag.server_id = b.server_id
        AND target_tag.is_current_gamertag = 1
       LEFT JOIN player_gamertags poster_tag
         ON poster_tag.identity_id = b.poster_identity_id
        AND poster_tag.server_id = b.server_id
        AND poster_tag.is_current_gamertag = 1
       WHERE b.server_id = ? AND b.status IN ('active', 'suspended') AND b.expires_at > NOW()
       ORDER BY b.amount DESC, b.id ASC
       LIMIT 200`,
      [serverId]
    );
    return res.json({
      success: true,
      serverId,
      bounties: rows.map(row => serializePublicBounty(row, identityId)),
    });
  } catch (error) {
    return res.status(error.message === 'Player membership required' ? 403 : 500)
      .json({ error: error.message === 'Player membership required' ? error.message : 'Failed to load bounties' });
  }
});

router.post('/:serverId', ensurePlayerServerAccess, strictLimiter, async (req, res) => {
  const db = req.app.locals.db;
  try {
    const context = playerContext(req);
    const idempotencyKey = parseIdempotencyKey(req);
    const targetType = req.body?.targetType || (req.body?.targetFactionId ? 'faction' : 'player');
    if (!['player', 'faction'].includes(targetType)) throw new Error('Target type is invalid');
    const create = targetType === 'faction'
      ? bountyService.createFactionBountyInTransaction
      : bountyService.createPlayerBountyInTransaction;
    const bounty = await db.transaction(() => create(
      db,
      context,
      {
        targetType,
        targetIdentityId: req.body.targetIdentityId,
        targetFactionId: req.body.targetFactionId,
        amount: req.body.amount,
        reason: req.body.reason,
        expiryHours: req.body.expiryHours,
        idempotencyKey,
      }
    ));
    return res.status(201).json({ success: true, bounty });
  } catch (error) {
    const status = error.status === 400 ? 400
      : /leader or officer permission/i.test(error.message) ? 403
        : /required|invalid|outside|cannot place/i.test(error.message) ? 400
          : /disabled|membership|unavailable|not active|inactive/i.test(error.message) ? 403
            : /Insufficient|Idempotency key conflicts|freshly online|needs at least/i.test(error.message) ? 409 : 500;
    return res.status(status).json({ error: status === 500 ? 'Failed to create bounty' : error.message });
  }
});

router.post('/:serverId/:bountyId/cancel', ensurePlayerServerAccess, strictLimiter, async (req, res) => {
  const db = req.app.locals.db;
  try {
    const result = await db.transaction(() => bountyService.cancelBountyInTransaction(
      db,
      playerContext(req),
      req.params.bountyId,
      req.body.reason
    ));
    return res.json({ success: true, result });
  } catch (error) {
    const status = error.status === 409 ? 409
      : /required|invalid/i.test(error.message) ? 400
        : /membership|unavailable|not active|inactive/i.test(error.message) ? 403
          : /not found/i.test(error.message) ? 404
            : /already settled/i.test(error.message) ? 409 : 500;
    return res.status(status).json({ error: status === 500 ? 'Failed to cancel bounty' : error.message });
  }
});

router.post('/:serverId/refunds/claim', ensurePlayerServerAccess, strictLimiter, async (req, res) => {
  const db = req.app.locals.db;
  try {
    const context = playerContext(req);
    const result = await db.transaction(() => bountyService.claimFinancialRefundsInTransaction(
      db,
      { ...context, userId: req.user.id }
    ));
    res.json(result);
  } catch (error) {
    const message = String(error.message || '');
    if (/required|invalid/i.test(message)) return res.status(400).json({ error: message });
    if (/revoked|not active|unavailable/i.test(message)) return res.status(403).json({ error: message });
    console.error('Failed to claim deferred refunds:', error);
    res.status(500).json({ error: 'Failed to claim deferred refunds' });
  }
});

module.exports = router;
