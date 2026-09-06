'use strict';

const { FINANCIAL_LINK_METHODS, isFinancialLinkMethod } = require('../utils/linkTrust');
const { lockUserRoleMutations } = require('../utils/roleMutationLocks');
const {
  parseCents, parseCentsBigInt, checkedAddCents, centsToAmount, centsToDecimal,
  centsForResponse, amountForResponse,
} = require('../utils/money');
const { getOrCreateWallet } = require('../utils/economy');
const { insertOrVerifyPendingRefundClaim } = require('../utils/refundClaimManager');

function positiveId(value, label) {
  const canonical = typeof value === 'number'
    ? Number.isSafeInteger(value) && value > 0
    : typeof value === 'string' && /^[1-9]\d*$/.test(value);
  if (!canonical) throw new Error(`${label} is required`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} is required`);
  return number;
}

function monetaryAmount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('A valid monetary amount is required');
  }
  let cents;
  try {
    cents = parseCents(value, 'Bounty amount');
  } catch (_) {
    throw new Error('A valid monetary amount with at most two decimals is required');
  }
  if (cents <= 0) throw new Error('A valid monetary amount is required');
  return centsToAmount(cents);
}

function storedAmountCents(value, label = 'Bounty amount') {
  const cents = parseCents(value, label);
  if (cents <= 0) throw new Error(`${label} must be positive`);
  return cents;
}

function storedAmountCentsBigInt(value, label) {
  const cents = parseCentsBigInt(value, label);
  if (cents <= 0n) throw new Error(`${label} must be positive`);
  return cents;
}

function canonicalBigIntId(value, label) {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`${label} is required`);
  const id = BigInt(text);
  return id > BigInt(Number.MAX_SAFE_INTEGER) ? text : Number(id);
}

function boundedText(value, maximum, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > maximum) throw new Error(`${label} is invalid`);
  return value.trim() || null;
}

async function appendBountyEvent(db, {
  bountyId, serverId, eventType, actorUserId = null, actorIdentityId = null,
  killEventId = null, metadata = {}, createdAt = null,
}) {
  await db.run(
    `INSERT INTO bounty_events
     (bounty_id, server_id, event_type, actor_user_id, actor_identity_id, kill_event_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, clock_timestamp()))`,
    [bountyId, serverId, eventType, actorUserId, actorIdentityId, killEventId,
      JSON.stringify(metadata), createdAt]
  );
}

async function lockFaction(db, factionId, guildId) {
  const faction = await db.get(
    `SELECT id, guild_id, name, tag FROM factions
     WHERE id = ? AND guild_id = ? FOR UPDATE`,
    [factionId, guildId]
  );
  if (!faction) throw new Error('Faction is unavailable');
  return faction;
}

async function lockFactionRoster(db, factionId, guildId, serverId) {
  const rows = await db.query(
    `SELECT fm.identity_id
     FROM faction_members fm
     JOIN server_player_memberships spm
       ON spm.identity_id = fm.identity_id
      AND spm.server_id = ?
      AND spm.status = 'active'
     WHERE fm.faction_id = ? AND fm.guild_id = ?
     ORDER BY fm.identity_id
     FOR UPDATE OF fm, spm`,
    [serverId, factionId, guildId]
  );
  return (rows || []).map(row => positiveId(row.identity_id, 'Faction member identity'));
}

async function lockActiveMembership(db, serverId, identityId, userId = null, sourceLinkId = null) {
  const userClause = userId === null ? '' : ' AND user_id = ?';
  const sourceClause = sourceLinkId === null ? '' : ' AND source_link_id = ?';
  const params = [serverId, identityId];
  if (userId !== null) params.push(userId);
  if (sourceLinkId !== null) params.push(sourceLinkId);
  return db.get(
    `SELECT identity_id FROM server_player_memberships
     WHERE server_id = ? AND identity_id = ?${userClause}${sourceClause} AND status = 'active'
     FOR UPDATE`,
    params
  );
}

async function lockApprovedActiveServer(db, serverId, guildId) {
  guildId = positiveId(guildId, 'Canonical guild context');
  const guild = await db.get(
    "SELECT id FROM guilds WHERE id = ? AND status = 'approved' FOR UPDATE",
    [guildId]
  );
  if (!guild) throw new Error('Guild approval is unavailable');
  const server = await db.get(
    "SELECT id, guild_id FROM servers WHERE id = ? AND guild_id = ? AND status = 'active' FOR UPDATE",
    [serverId, guildId]
  );
  if (!server) throw new Error('Server is unavailable');
  return server;
}

async function lockPlayerAuthority(db, serverId, identityId, userId) {
  const financialMethods = [...FINANCIAL_LINK_METHODS];
  const account = await db.get(
    `SELECT id, verification_method FROM linked_accounts
     WHERE user_id = ? AND identity_id = ?
       AND verification_method IN (${financialMethods.map(() => '?').join(', ')})
     FOR UPDATE`,
    [userId, identityId, ...financialMethods]
  );
  if (!account || !isFinancialLinkMethod(account.verification_method)) {
    throw new Error('Player identity link was revoked');
  }
  const membership = await lockActiveMembership(db, serverId, identityId, userId, account.id);
  if (!membership) throw new Error('Player identity is not active on this server');
  return membership;
}

function serializeBounty(row) {
  const targetType = row.target_type || 'player';
  const creatorType = row.creator_type || 'player';
  return {
    id: Number(row.id),
    serverId: Number(row.server_id),
    targetType,
    targetIdentityId: row.target_identity_id == null ? null : Number(row.target_identity_id),
    targetFactionId: row.target_faction_id_snapshot == null
      ? (row.target_faction_id == null ? null : Number(row.target_faction_id))
      : Number(row.target_faction_id_snapshot),
    targetFactionName: row.target_faction_name_snapshot ?? null,
    targetFactionTag: row.target_faction_tag_snapshot ?? null,
    creatorType,
    creatorFactionId: row.creator_faction_id_snapshot == null
      ? (row.creator_faction_id == null ? null : Number(row.creator_faction_id))
      : Number(row.creator_faction_id_snapshot),
    creatorFactionName: row.creator_faction_name_snapshot ?? null,
    creatorFactionTag: row.creator_faction_tag_snapshot ?? null,
    posterIdentityId: Number(row.poster_identity_id),
    fundingType: row.funding_type,
    amount: amountForResponse(row.amount, 'Bounty amount'),
    reason: row.reason ?? null,
    status: row.status,
    objectiveType: row.objective_type ?? null,
    requiredKills: row.required_kills == null ? null : Number(row.required_kills),
    eligibleMemberCount: row.eligible_member_count == null ? null : Number(row.eligible_member_count),
    progressKills: Number(row.progress_kills || 0),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
  };
}

async function lockActiveServer(db, serverId) {
  const server = await db.get(
    "SELECT id, guild_id FROM servers WHERE id = ? AND status = 'active' FOR UPDATE",
    [serverId]
  );
  if (!server) throw new Error('Server is unavailable');
  return server;
}

async function lockEconomyConfig(db, serverId) {
  const config = await db.get(
    'SELECT server_id FROM guild_economy_config WHERE server_id = ? FOR UPDATE',
    [serverId]
  );
  if (!config) throw new Error('Economy configuration is unavailable');
  return config;
}

async function requireFreshOnlineTarget(db, serverId, identityId, freshnessMinutes) {
  const marker = await db.get(
    `SELECT source_observed_at >= clock_timestamp() - (?::int * INTERVAL '1 minute') AS fresh,
            source_observed_at <= clock_timestamp() + INTERVAL '5 minutes' AS plausible
     FROM server_online_cache_snapshots
     WHERE server_id = ?
     FOR UPDATE`,
    [freshnessMinutes, serverId]
  );
  if (!marker?.fresh || !marker?.plausible) {
    throw new Error('Target player must be freshly online on this server');
  }
  const online = await db.get(
    `SELECT identity_id FROM server_online_cache
     WHERE server_id = ? AND identity_id = ?
     FOR UPDATE`,
    [serverId, identityId]
  );
  if (!online) throw new Error('Target player must be freshly online on this server');
}

function serializeBountySettings(row) {
  return {
    serverId: Number(row.server_id),
    requireTargetOnline: row.require_target_online !== false,
    onlineFreshnessMinutes: Number(row.online_freshness_minutes),
    factionKillsRequired: Number(row.faction_kills_required || 3),
    version: Number(row.version),
  };
}

async function lockBountyAdminAuthority(db, context) {
  const serverId = positiveId(context?.serverId, 'Canonical server context');
  const guildId = positiveId(context?.guildId, 'Canonical guild context');
  const userId = positiveId(context?.userId, 'Authenticated user');
  await lockUserRoleMutations(db, [userId]);
  const server = await lockApprovedActiveServer(db, serverId, guildId);
  const guildRole = await db.get(
    'SELECT role FROM guild_roles WHERE guild_id = ? AND user_id = ? FOR UPDATE',
    [server.guild_id, userId]
  );
  const serverRole = await db.get(
    `SELECT role, status FROM server_role_assignments
     WHERE server_id = ? AND guild_id = ? AND user_id = ? FOR UPDATE`,
    [serverId, server.guild_id, userId]
  );
  const authorized = ['owner', 'admin'].includes(guildRole?.role)
    || (serverRole?.role === 'admin' && serverRole.status === 'active');
  if (!authorized) throw new Error('Server management permission is required');
  return { serverId, guildId, userId };
}

async function updateBountySettingsInTransaction(db, context, input) {
  if (typeof input?.requireTargetOnline !== 'boolean') {
    throw new Error('requireTargetOnline must be a boolean');
  }
  const factionKillsRequired = input?.factionKillsRequired === undefined
    ? null : positiveId(input.factionKillsRequired, 'Faction kills required');
  if (factionKillsRequired !== null && factionKillsRequired > 100) {
    throw new Error('Faction kills required must be between 1 and 100');
  }
  const expectedVersion = positiveId(input?.expectedVersion, 'Bounty settings version');
  const { serverId } = await lockBountyAdminAuthority(db, context);

  await db.run(
    'INSERT INTO bounty_settings (server_id) VALUES (?) ON CONFLICT (server_id) DO NOTHING',
    [serverId]
  );
  const settings = await db.get(
    `UPDATE bounty_settings
     SET require_target_online = ?,
         faction_kills_required = COALESCE(?, faction_kills_required),
         version = version + 1, updated_at = NOW()
     WHERE server_id = ? AND version = ?
     RETURNING server_id, require_target_online, online_freshness_minutes,
               faction_kills_required, version`,
    [input.requireTargetOnline, factionKillsRequired, serverId, expectedVersion]
  );
  if (!settings) throw new Error('Bounty settings changed; reload before saving');
  return serializeBountySettings(settings);
}

async function databaseNow(db) {
  const row = await db.get('SELECT clock_timestamp() AS observed_at');
  const observed = new Date(row?.observed_at);
  if (!Number.isFinite(observed.getTime())) throw new Error('Database clock is unavailable');
  return observed.toISOString();
}

async function cancelBountyInTransaction(db, context, bountyId, reason) {
  const serverId = positiveId(context?.serverId, 'Canonical server context');
  const guildId = positiveId(context?.guildId, 'Canonical guild context');
  const posterIdentityId = positiveId(context?.identityId, 'Player identity');
  const userId = positiveId(context?.userId, 'Authenticated user');
  bountyId = positiveId(bountyId, 'Bounty');
  reason = boundedText(reason, 500, 'Cancellation reason');

  await lockUserRoleMutations(db, [userId]);
  await lockApprovedActiveServer(db, serverId, guildId);
  await lockPlayerAuthority(db, serverId, posterIdentityId, userId);
  await lockEconomyConfig(db, serverId);
  const bounty = await db.get(
    `SELECT id, server_id, poster_identity_id, funding_type, amount, status,
            cancellation_requested_at,
            expires_at > clock_timestamp() AS unexpired
     FROM bounties
     WHERE id = ? AND server_id = ? AND poster_identity_id = ?
       AND funding_type = 'player_wallet'
     FOR UPDATE`,
    [bountyId, serverId, posterIdentityId]
  );
  if (!bounty) throw new Error('Bounty not found');
  if (bounty.status !== 'active' || !bounty.unexpired) throw new Error('Bounty was already settled');
  if (bounty.cancellation_requested_at) {
    return { bountyId, status: 'pending_cancellation', refundedAmount: 0 };
  }

  const timestamp = await databaseNow(db);
  const statusChange = await db.run(
    `UPDATE bounties SET cancellation_requested_at = ?, cancel_reason = ?
     WHERE id = ? AND server_id = ? AND status = 'active'
       AND cancellation_requested_at IS NULL`,
    [timestamp, reason || 'cancelled_by_poster', bountyId, serverId]
  );
  if (statusChange.changes !== 1) throw new Error('Bounty was already settled');
  await appendBountyEvent(db, {
    bountyId, serverId, eventType: 'cancellation_requested', actorUserId: userId,
    actorIdentityId: posterIdentityId, createdAt: timestamp,
    metadata: { reason: reason || 'cancelled_by_poster' },
  });
  return { bountyId, status: 'pending_cancellation', refundedAmount: 0 };
}

async function expireBounties(db, serverId, now = null) {
  serverId = positiveId(serverId, 'Canonical server context');
  const expiresThrough = now === null
    ? await databaseNow(db)
    : (() => {
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new Error('A valid expiry time is required');
      }
      return now.toISOString();
    })();

  await lockActiveServer(db, serverId);
  await lockEconomyConfig(db, serverId);
  const rows = await db.query(
    `SELECT b.id, b.server_id, b.poster_identity_id, b.funding_type, b.amount,
            b.cancel_reason,
            CASE WHEN b.cancellation_requested_at IS NOT NULL
                   AND b.cancellation_requested_at <= b.expires_at
                 THEN 'cancelled' ELSE 'expired' END AS settlement_status
     FROM bounties b
     JOIN servers s ON s.id = b.server_id
     WHERE b.server_id = ? AND b.funding_type = 'player_wallet' AND b.status = 'active'
       AND (b.expires_at <= ? OR b.cancellation_requested_at IS NOT NULL)
       AND s.log_parse_watermark_at >= LEAST(
             b.expires_at, COALESCE(b.cancellation_requested_at, b.expires_at))
     ORDER BY b.id
     FOR UPDATE OF b SKIP LOCKED
     LIMIT ?`,
    [serverId, expiresThrough, 100]
  );
  const bounties = (rows || []).slice().sort((a, b) => Number(a.id) - Number(b.id));
  if (!bounties.length) return {
    expiredCount: 0, refundedAmount: 0, walletCreditedAmount: 0,
    deferredClaimAmount: 0, bountyIds: [], walletCreditedBountyIds: [],
    deferredBountyIds: [], deferredClaimIds: [],
  };

  const identityIds = [...new Set(bounties.map(row => positiveId(row.poster_identity_id, 'Poster identity')))]
    .sort((a, b) => a - b);
  const lockedBalances = new Map();
  for (const identityId of identityIds) {
    await getOrCreateWallet(db, identityId, serverId);
    const wallet = await db.get(
      'SELECT cash_on_hand FROM player_wallets WHERE identity_id = ? AND server_id = ? FOR UPDATE',
      [identityId, serverId]
    );
    lockedBalances.set(identityId, parseCents(wallet.cash_on_hand, 'Wallet balance'));
  }

  const timestamp = expiresThrough;
  const bountyIds = [];
  const walletCreditedBountyIds = [];
  const deferredBountyIds = [];
  const deferredClaimIds = [];
  let walletCreditedCents = 0;
  let deferredClaimCents = 0;
  for (const bounty of bounties) {
    const bountyId = positiveId(bounty.id, 'Bounty');
    const posterIdentityId = positiveId(bounty.poster_identity_id, 'Poster identity');
    const amountCents = storedAmountCents(bounty.amount);
    const settlementStatus = bounty.settlement_status === 'cancelled' ? 'cancelled' : 'expired';
    const refundReason = settlementStatus === 'cancelled'
      ? (bounty.cancel_reason || 'cancelled_by_poster') : 'expired';
    let newBalanceCents = null;
    let refundDeferred = false;
    try {
      newBalanceCents = checkedAddCents(
        lockedBalances.get(posterIdentityId), amountCents, 'Bounty refund wallet');
    } catch (error) {
      if (error.status !== 409) throw error;
      refundDeferred = true;
    }
    const statusChange = await db.run(
      `UPDATE bounties SET status = ?, settled_at = ?, cancel_reason = ?
       WHERE id = ? AND server_id = ? AND status = 'active'
         AND (expires_at <= ? OR cancellation_requested_at IS NOT NULL)`,
      [settlementStatus, timestamp, refundReason, bountyId, serverId, expiresThrough]
    );
    if (statusChange.changes !== 1) continue;
    await appendBountyEvent(db, {
      bountyId, serverId, eventType: settlementStatus, createdAt: timestamp,
      metadata: { reason: refundReason },
    });

    if (refundDeferred) {
      const claimId = await insertOrVerifyPendingRefundClaim(db, {
        serverId, identityId: posterIdentityId, amountCents, sourceType: 'bounty',
        sourceKey: bountyId, reason: refundReason, createdAt: timestamp,
      });
      deferredBountyIds.push(bountyId);
      deferredClaimIds.push(claimId);
      deferredClaimCents += amountCents;
    } else {
      const updated = await db.get(
        `UPDATE player_wallets SET cash_on_hand = ?, last_updated = ?
         WHERE identity_id = ? AND server_id = ? RETURNING cash_on_hand`,
        [centsToDecimal(newBalanceCents), timestamp, posterIdentityId, serverId]
      );
      if (!updated) throw new Error('Player wallet credit failed');
      const resultingBalanceCents = parseCents(updated.cash_on_hand, 'Wallet balance');
      lockedBalances.set(posterIdentityId, resultingBalanceCents);
      await db.run(
        `INSERT INTO economy_transactions
         (identity_id, server_id, transaction_type, amount, balance_after, account_type, source, description, metadata, timestamp)
         VALUES (?, ?, 'earn', ?, ?, 'wallet', ?, ?, ?, ?)`,
        [posterIdentityId, serverId, centsToDecimal(amountCents), centsToDecimal(newBalanceCents),
          'bounty_refund', settlementStatus === 'expired'
            ? 'Expired bounty escrow refunded' : 'Cancelled bounty escrow refunded',
          JSON.stringify({ bountyId, reason: refundReason }), timestamp]
      );
      await appendBountyEvent(db, {
        bountyId, serverId, eventType: 'refunded', actorIdentityId: posterIdentityId,
        createdAt: timestamp, metadata: { amount: centsToDecimal(amountCents), reason: refundReason },
      });
      walletCreditedBountyIds.push(bountyId);
      walletCreditedCents += amountCents;
    }
    bountyIds.push(bountyId);
  }

  return {
    expiredCount: bountyIds.length,
    refundedAmount: centsToAmount(walletCreditedCents),
    walletCreditedAmount: centsToAmount(walletCreditedCents),
    deferredClaimAmount: centsToAmount(deferredClaimCents),
    bountyIds, walletCreditedBountyIds, deferredBountyIds, deferredClaimIds,
  };
}

async function claimBountiesForKillInTransaction(db, killEvent) {
  const killEventId = positiveId(killEvent?.killEventId, 'Kill event');
  const serverId = positiveId(killEvent?.serverId, 'Canonical server context');

  await lockActiveServer(db, serverId);
  const authoritativeKill = await db.get(
    `SELECT id, server_id, killer_identity_id, victim_identity_id, timestamp
     FROM kill_events
     WHERE id = ? AND server_id = ?
     FOR UPDATE`,
    [killEventId, serverId]
  );
  if (!authoritativeKill) throw new Error('Authoritative kill event is unavailable');
  const killerIdentityId = positiveId(authoritativeKill.killer_identity_id, 'Killer identity');
  const victimIdentityId = positiveId(authoritativeKill.victim_identity_id, 'Victim identity');
  const killTime = new Date(authoritativeKill.timestamp);
  if (!Number.isFinite(killTime.getTime())) throw new Error('Authoritative kill time is invalid');
  const killTimestamp = killTime.toISOString();

  const empty = {
    killEventId,
    claimedAmount: 0, claimedBountyIds: [],
    refundedAmount: 0, refundedBountyIds: [],
    publicFeedAwardAmount: 0, publicFeedDeferredAwardAmount: 0,
    walletCreditedAmount: 0, deferredClaimAmount: 0,
    deferredAwardAmount: 0, deferredRefundAmount: 0,
    deferredClaimIds: [], deferredBountyIds: [], settledBountyIds: [],
    factionProgress: [],
  };
  const factionRows = await db.query(
    `SELECT b.guild_id, b.target_faction_id, b.creator_faction_id
     FROM bounties b
     WHERE b.server_id = ? AND b.funding_type = 'player_wallet'
       AND b.target_type = 'faction'
       AND EXISTS (
         SELECT 1 FROM bounty_faction_members bfm
         WHERE bfm.bounty_id = b.id AND bfm.server_id = b.server_id
           AND bfm.member_role = 'target' AND bfm.identity_id = ?
       )
       AND b.status = 'active' AND b.created_at <= ? AND b.expires_at > ?
       AND (b.cancellation_requested_at IS NULL OR b.cancellation_requested_at >= ?)
     ORDER BY b.id`,
    [serverId, victimIdentityId, killTimestamp, killTimestamp, killTimestamp]
  );
  const factionLocks = new Map();
  for (const row of factionRows || []) {
    const guildId = positiveId(row.guild_id, 'Bounty guild');
    for (const value of [row.target_faction_id, row.creator_faction_id]) {
      const factionId = positiveId(value, 'Bounty faction');
      factionLocks.set(`${guildId}:${factionId}`, { guildId, factionId });
    }
  }
  for (const { guildId, factionId } of [...factionLocks.values()]
    .sort((a, b) => a.guildId - b.guildId || a.factionId - b.factionId)) {
    await lockFaction(db, factionId, guildId);
  }

  for (const identityId of [...new Set([killerIdentityId, victimIdentityId])].sort((a, b) => a - b)) {
    if (!await lockActiveMembership(db, serverId, identityId)) {
      return empty;
    }
  }
  await lockEconomyConfig(db, serverId);

  const candidate = await db.get(
    `SELECT b.id FROM bounties b
     WHERE b.server_id = ? AND b.funding_type = 'player_wallet'
       AND (
         (b.target_type = 'player' AND b.target_identity_id = ?)
         OR (b.target_type = 'faction' AND EXISTS (
           SELECT 1 FROM bounty_faction_members bfm
           WHERE bfm.bounty_id = b.id AND bfm.server_id = b.server_id
             AND bfm.member_role = 'target' AND bfm.identity_id = ?
         ))
       )
       AND b.status = 'active' AND b.created_at <= ? AND b.expires_at > ?
       AND (b.cancellation_requested_at IS NULL OR b.cancellation_requested_at >= ?)
     ORDER BY b.id LIMIT 1`,
    [serverId, victimIdentityId, victimIdentityId, killTimestamp, killTimestamp, killTimestamp]
  );
  if (!candidate || killerIdentityId === victimIdentityId) return empty;

  const rows = await db.query(
    `SELECT b.id, b.server_id, b.guild_id, b.target_type, b.target_identity_id,
            b.target_faction_id, b.target_faction_id_snapshot,
            b.creator_faction_id, b.creator_faction_id_snapshot,
            b.objective_claimant_identity_id, b.required_kills,
            b.poster_identity_id, b.funding_type, b.amount
     FROM bounties b
     WHERE b.server_id = ? AND b.funding_type = 'player_wallet'
       AND (
         (b.target_type = 'player' AND b.target_identity_id = ?)
         OR (b.target_type = 'faction' AND EXISTS (
           SELECT 1 FROM bounty_faction_members bfm
           WHERE bfm.bounty_id = b.id AND bfm.server_id = b.server_id
             AND bfm.member_role = 'target' AND bfm.identity_id = ?
         ))
       )
       AND b.status = 'active' AND b.created_at <= ? AND b.expires_at > ?
       AND (b.cancellation_requested_at IS NULL OR b.cancellation_requested_at >= ?)
     ORDER BY b.id
     FOR UPDATE OF b`,
    [serverId, victimIdentityId, victimIdentityId, killTimestamp, killTimestamp, killTimestamp]
  );
  const candidates = (rows || []).slice().sort((a, b) => Number(a.id) - Number(b.id));
  if (!candidates.length) return empty;

  const altReview = await db.get(
    `SELECT id, status FROM alt_account_reviews
     WHERE server_id = ? AND identity_id_low = LEAST(?::int, ?::int)
       AND identity_id_high = GREATEST(?::int, ?::int)
     FOR UPDATE`,
    [serverId, killerIdentityId, victimIdentityId, killerIdentityId, victimIdentityId]
  );
  if (altReview?.status === 'confirmed') return empty;

  const bounties = [];
  const factionProgress = [];
  const progressTimestamp = await databaseNow(db);
  for (const bounty of candidates) {
    if ((bounty.target_type || 'player') === 'player') {
      bounties.push(bounty);
      continue;
    }
    const bountyId = positiveId(bounty.id, 'Bounty');
    const excluded = await db.get(
      `SELECT member_role FROM bounty_faction_members
       WHERE bounty_id = ? AND server_id = ? AND identity_id = ?
         AND member_role IN ('target', 'sponsor')
       ORDER BY member_role LIMIT 1
       FOR UPDATE`,
      [bountyId, serverId, killerIdentityId]
    );
    if (excluded) continue;
    const targetFactionId = bounty.target_faction_id_snapshot ?? bounty.target_faction_id;
    const creatorFactionId = bounty.creator_faction_id_snapshot ?? bounty.creator_faction_id;
    const currentExcludedMembership = await db.get(
      `SELECT faction_id FROM faction_members
       WHERE guild_id = ? AND identity_id = ?
         AND faction_id IN (?, ?)
       FOR UPDATE`,
      [bounty.guild_id, killerIdentityId, targetFactionId, creatorFactionId]
    );
    if (currentExcludedMembership) continue;

    let objectiveClaimantId = bounty.objective_claimant_identity_id == null
      ? null : positiveId(bounty.objective_claimant_identity_id, 'Objective claimant');
    if (objectiveClaimantId === null) {
      const claimed = await db.run(
        `UPDATE bounties SET objective_claimant_identity_id = ?
         WHERE id = ? AND server_id = ? AND status = 'active'
           AND objective_claimant_identity_id IS NULL`,
        [killerIdentityId, bountyId, serverId]
      );
      if (claimed.changes !== 1) continue;
      objectiveClaimantId = killerIdentityId;
    }
    if (objectiveClaimantId !== killerIdentityId) continue;

    const insertedProgress = await db.get(
      `INSERT INTO bounty_objective_events
       (bounty_id, server_id, kill_event_id, claimant_identity_id, victim_identity_id, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING RETURNING id`,
      [bountyId, serverId, killEventId, killerIdentityId, victimIdentityId, progressTimestamp]
    );
    if (!insertedProgress) continue;
    const progress = await db.get(
      `SELECT COUNT(DISTINCT victim_identity_id) AS progress_kills
       FROM bounty_objective_events
       WHERE bounty_id = ? AND server_id = ? AND claimant_identity_id = ?`,
      [bountyId, serverId, killerIdentityId]
    );
    const progressKills = Number(progress?.progress_kills || 0);
    const requiredKills = positiveId(bounty.required_kills, 'Required kills');
    await appendBountyEvent(db, {
      bountyId, serverId, eventType: 'objective_progress', actorIdentityId: killerIdentityId,
      killEventId, createdAt: progressTimestamp,
      metadata: { victimIdentityId, progressKills, requiredKills },
    });
    factionProgress.push({ bountyId, progressKills, requiredKills });
    if (progressKills >= requiredKills) bounties.push(bounty);
  }
  empty.factionProgress = factionProgress;
  if (!bounties.length) return empty;

  await getOrCreateWallet(db, killerIdentityId, serverId);
  const wallet = await db.get(
    'SELECT cash_on_hand FROM player_wallets WHERE identity_id = ? AND server_id = ? FOR UPDATE',
    [killerIdentityId, serverId]
  );
  let balanceCents = parseCents(wallet.cash_on_hand, 'Wallet balance');
  let claimedCents = 0;
  let refundedCents = 0;
  let deferredClaimCents = 0;
  let deferredAwardCents = 0;
  let deferredRefundCents = 0;
  let publicFeedAwardCents = 0;
  let publicFeedDeferredAwardCents = 0;
  const claimedBountyIds = [];
  const refundedBountyIds = [];
  const deferredClaimIds = [];
  const deferredBountyIds = [];
  const settledBountyIds = [];
  const timestamp = await databaseNow(db);

  for (const bounty of bounties) {
    const bountyId = positiveId(bounty.id, 'Bounty');
    const posterIdentityId = positiveId(bounty.poster_identity_id, 'Poster identity');
    const amountCents = storedAmountCents(bounty.amount);
    let creditedBalanceCents = null;
    let creditDeferred = false;
    try {
      creditedBalanceCents = checkedAddCents(
        balanceCents, amountCents, 'Bounty claimant wallet');
    } catch (error) {
      if (error.status !== 409) throw error;
      creditDeferred = true;
    }
    const ownContract = (bounty.target_type || 'player') === 'player'
      && posterIdentityId === killerIdentityId;
    let statusChange;
    if (ownContract) {
      statusChange = await db.run(
        `UPDATE bounties SET status = 'cancelled', settled_at = ?, cancel_reason = ?
         WHERE id = ? AND server_id = ? AND status = 'active'
           AND created_at <= ? AND expires_at > ?
           AND (cancellation_requested_at IS NULL OR cancellation_requested_at >= ?)`,
        [timestamp, 'poster_killed_target', bountyId, serverId,
          killTimestamp, killTimestamp, killTimestamp]
      );
    } else {
      const nextStatus = creditDeferred ? 'claimed' : 'settled';
      statusChange = await db.run(
        `UPDATE bounties SET status = ?, claimed_at = ?, settled_at = ?,
             claimed_by_identity_id = ?, claim_kill_event_id = ?
         WHERE id = ? AND server_id = ? AND status = 'active'
           AND created_at <= ? AND expires_at > ?
           AND (cancellation_requested_at IS NULL OR cancellation_requested_at >= ?)`,
        [nextStatus, timestamp, creditDeferred ? null : timestamp,
          killerIdentityId, killEventId, bountyId, serverId,
          killTimestamp, killTimestamp, killTimestamp]
      );
    }
    if (statusChange.changes !== 1) continue;

    if (ownContract) {
      await appendBountyEvent(db, {
        bountyId, serverId, eventType: 'cancelled', actorIdentityId: killerIdentityId,
        killEventId, createdAt: timestamp, metadata: { reason: 'poster_killed_target' },
      });
    } else {
      await appendBountyEvent(db, {
        bountyId, serverId, eventType: 'claimed', actorIdentityId: killerIdentityId,
        killEventId, createdAt: timestamp,
        metadata: { victimIdentityId, targetType: bounty.target_type || 'player' },
      });
    }

    const source = ownContract ? 'bounty_refund' : 'bounty_claim';
    if (creditDeferred) {
      const claimId = await insertOrVerifyPendingRefundClaim(db, {
        serverId, identityId: killerIdentityId, amountCents,
        sourceType: ownContract ? 'bounty_refund' : 'bounty_award',
        sourceKey: bountyId,
        reason: ownContract ? 'poster_killed_target' : 'destination_wallet_capacity_exceeded',
        createdAt: timestamp,
      });
      deferredClaimIds.push(claimId);
      deferredBountyIds.push(bountyId);
      deferredClaimCents += amountCents;
      if (ownContract) deferredRefundCents += amountCents;
      else deferredAwardCents += amountCents;
    } else {
      const updated = await db.get(
        `UPDATE player_wallets SET cash_on_hand = ?, last_updated = ?
         WHERE identity_id = ? AND server_id = ? RETURNING cash_on_hand`,
        [centsToDecimal(creditedBalanceCents), timestamp, killerIdentityId, serverId]
      );
      if (!updated) throw new Error('Claimant wallet credit failed');
      balanceCents = parseCents(updated.cash_on_hand, 'Wallet balance');
      await db.run(
        `INSERT INTO economy_transactions
         (identity_id, server_id, transaction_type, amount, balance_after, account_type, source, description, metadata, timestamp)
         VALUES (?, ?, 'earn', ?, ?, 'wallet', ?, ?, ?, ?)`,
        [killerIdentityId, serverId, centsToDecimal(amountCents), centsToDecimal(balanceCents), source,
          ownContract ? 'Bounty escrow refunded after poster kill' : 'Bounty claimed',
          JSON.stringify({ bountyId, killEventId, victimIdentityId }), timestamp]
      );
    }

    if (!creditDeferred) {
      await appendBountyEvent(db, {
        bountyId, serverId, eventType: ownContract ? 'refunded' : 'settled',
        actorIdentityId: killerIdentityId, killEventId, createdAt: timestamp,
        metadata: { amount: centsToDecimal(amountCents) },
      });
    }

    if (!creditDeferred) settledBountyIds.push(bountyId);
    if (ownContract) {
      if (!creditDeferred) {
        refundedBountyIds.push(bountyId);
        refundedCents += amountCents;
      }
    } else {
      await db.run(
        `INSERT INTO bounty_claims
         (bounty_id, server_id, kill_event_id, claimant_identity_id, victim_identity_id, amount, claimed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [bountyId, serverId, killEventId, killerIdentityId, victimIdentityId,
          centsToDecimal(amountCents), timestamp]
      );
      if (!creditDeferred) {
        claimedBountyIds.push(bountyId);
        claimedCents += amountCents;
      }
      if ((bounty.target_type || 'player') === 'player') {
        if (creditDeferred) publicFeedDeferredAwardCents += amountCents;
        else publicFeedAwardCents += amountCents;
      }
    }
  }

  return {
    killEventId,
    claimedAmount: centsToAmount(claimedCents),
    publicFeedAwardAmount: centsToAmount(publicFeedAwardCents),
    publicFeedDeferredAwardAmount: centsToAmount(publicFeedDeferredAwardCents),
    claimedBountyIds,
    refundedAmount: centsToAmount(refundedCents),
    refundedBountyIds,
    walletCreditedAmount: centsToAmount(claimedCents + refundedCents),
    deferredClaimAmount: centsToAmount(deferredClaimCents),
    deferredAwardAmount: centsToAmount(deferredAwardCents),
    deferredRefundAmount: centsToAmount(deferredRefundCents),
    deferredClaimIds,
    deferredBountyIds,
    settledBountyIds,
    factionProgress,
  };
}

async function claimFinancialRefundsInTransaction(db, context) {
  const serverId = positiveId(context?.serverId, 'Canonical server context');
  const guildId = positiveId(context?.guildId, 'Canonical guild context');
  const identityId = positiveId(context?.identityId, 'Player identity');
  const userId = positiveId(context?.userId, 'Authenticated user');
  await lockUserRoleMutations(db, [userId]);
  await lockApprovedActiveServer(db, serverId, guildId);
  await lockPlayerAuthority(db, serverId, identityId, userId);
  await lockEconomyConfig(db, serverId);
  await getOrCreateWallet(db, identityId, serverId);
  const wallet = await db.get(
    'SELECT cash_on_hand FROM player_wallets WHERE identity_id = ? AND server_id = ? FOR UPDATE',
    [identityId, serverId]
  );
  let balanceCents = parseCentsBigInt(wallet.cash_on_hand, 'Wallet balance');
  const claims = await db.query(
    `SELECT id, amount, source_type, source_key FROM financial_refund_claims
     WHERE server_id = ? AND identity_id = ? AND status = 'pending'
     ORDER BY id FOR UPDATE`,
    [serverId, identityId]
  );
  const accepted = [];
  for (const claim of claims || []) {
    const amountCents = storedAmountCentsBigInt(claim.amount, 'Refund claim amount');
    try {
      balanceCents = checkedAddCents(balanceCents, amountCents, 'Refund claim wallet');
      accepted.push({
        id: canonicalBigIntId(claim.id, 'Refund claim'),
        amountCents,
        sourceType: claim.source_type,
        sourceKey: claim.source_key,
      });
    } catch (error) {
      if (error.status !== 409) throw error;
      break;
    }
  }
  if (!accepted.length) return { claimedAmount: 0, claimIds: [] };
  const timestamp = await databaseNow(db);
  const walletUpdate = await db.run(
    `UPDATE player_wallets SET cash_on_hand = ?, last_updated = ?
     WHERE identity_id = ? AND server_id = ?`,
    [centsToDecimal(balanceCents), timestamp, identityId, serverId]
  );
  if (walletUpdate.changes !== 1) throw new Error('Refund wallet credit failed');
  let runningBalance = parseCentsBigInt(wallet.cash_on_hand, 'Wallet balance');
  for (const claim of accepted) {
    runningBalance = checkedAddCents(runningBalance, claim.amountCents, 'Refund claim ledger balance');
    const claimed = await db.run(
      `UPDATE financial_refund_claims SET status = 'claimed', claimed_at = ?
       WHERE id = ? AND server_id = ? AND identity_id = ? AND status = 'pending'`,
      [timestamp, claim.id, serverId, identityId]
    );
    if (claimed.changes !== 1) throw new Error('Refund claim conflict');
    await db.run(
      `INSERT INTO economy_transactions
       (identity_id, server_id, transaction_type, amount, balance_after, account_type, source, refund_claim_id, description, metadata, timestamp)
       VALUES (?, ?, 'earn', ?, ?, 'wallet', 'deferred_refund_claim', ?, ?, ?, ?)`,
      [identityId, serverId, centsToDecimal(claim.amountCents), centsToDecimal(runningBalance),
        claim.id, 'Deferred financial refund claimed',
        JSON.stringify({ claimId: claim.id }), timestamp]
    );
    if (claim.sourceType === 'bounty_award') {
      const bountyId = positiveId(claim.sourceKey, 'Bounty');
      const settled = await db.run(
        `UPDATE bounties SET status = 'settled', settled_at = ?
         WHERE id = ? AND server_id = ? AND status = 'claimed'
           AND claimed_by_identity_id = ?`,
        [timestamp, bountyId, serverId, identityId]
      );
      if (settled.changes !== 1) throw new Error('Deferred bounty settlement conflict');
      await appendBountyEvent(db, {
        bountyId, serverId, eventType: 'settled', actorUserId: userId,
        actorIdentityId: identityId, createdAt: timestamp,
        metadata: { claimId: claim.id, amount: centsToDecimal(claim.amountCents) },
      });
    } else if (claim.sourceType === 'bounty_refund' || claim.sourceType === 'bounty') {
      const bountyId = positiveId(claim.sourceKey, 'Bounty');
      await appendBountyEvent(db, {
        bountyId, serverId, eventType: 'refunded', actorUserId: userId,
        actorIdentityId: identityId, createdAt: timestamp,
        metadata: { claimId: claim.id, amount: centsToDecimal(claim.amountCents) },
      });
    }
  }
  const claimedCents = accepted.reduce((sum, claim) => sum + claim.amountCents, 0n);
  return { claimedAmount: centsForResponse(claimedCents), claimIds: accepted.map(claim => claim.id) };
}

async function createPlayerBountyInTransaction(db, context, input) {
  if (input?.targetFactionId !== undefined && input?.targetFactionId !== null && input?.targetFactionId !== '') {
    throw new Error('Exactly one bounty target is required');
  }
  const amount = monetaryAmount(input?.amount);
  const amountCents = storedAmountCents(amount);
  const serverId = positiveId(context?.serverId, 'Canonical server context');
  const guildId = positiveId(context?.guildId, 'Canonical guild context');
  const posterIdentityId = positiveId(context?.identityId, 'Player identity');
  const userId = positiveId(context?.userId, 'Authenticated user');
  const targetIdentityId = positiveId(input?.targetIdentityId, 'Target identity');
  if (posterIdentityId === targetIdentityId) throw new Error('Players cannot place a bounty on themselves');
  const idempotencyKey = boundedText(input?.idempotencyKey, 128, 'Idempotency key');
  if (!idempotencyKey) throw new Error('Idempotency key is required');
  const reason = boundedText(input?.reason, 500, 'Reason');

  await lockUserRoleMutations(db, [userId]);
  await lockApprovedActiveServer(db, serverId, guildId);
  await lockPlayerAuthority(db, serverId, posterIdentityId, userId);

  if (!await lockActiveMembership(db, serverId, targetIdentityId)) {
    throw new Error('Player identity is not active on this server');
  }

  await db.run(
    'INSERT INTO bounty_settings (server_id) VALUES (?) ON CONFLICT (server_id) DO NOTHING',
    [serverId]
  );
  const settings = await db.get(
    `SELECT bs.*, gec.enabled AS economy_enabled
     FROM bounty_settings bs
     JOIN guild_economy_config gec ON gec.server_id = bs.server_id
     WHERE bs.server_id = ? FOR UPDATE`,
    [serverId]
  );
  if (!settings?.economy_enabled || !settings.enabled || !settings.player_posting_enabled) {
    throw new Error('Player bounties are disabled');
  }
  if (amountCents < parseCents(settings.minimum_amount, 'Minimum bounty amount') ||
      amountCents > parseCents(settings.maximum_amount, 'Maximum bounty amount')) {
    throw new Error('Bounty amount is outside configured limits');
  }

  const requestedExpiry = input?.expiryHours === undefined
    ? Number(settings.default_expiry_hours)
    : positiveId(input.expiryHours, 'Expiry');
  if (!Number.isSafeInteger(requestedExpiry) || requestedExpiry <= 0
      || requestedExpiry > Number(settings.maximum_expiry_hours)) {
    throw new Error('Expiry is outside configured limits');
  }
  const idempotencyFingerprint = JSON.stringify({
    targetIdentityId, amount, reason, expiryHours: requestedExpiry,
  });

  const existing = await db.get(
    `SELECT * FROM bounties
     WHERE server_id = ? AND poster_identity_id = ? AND idempotency_key = ?
     FOR UPDATE`,
    [serverId, posterIdentityId, idempotencyKey]
  );
  if (existing) {
    if (existing.idempotency_fingerprint !== idempotencyFingerprint) {
      throw new Error('Idempotency key conflicts with another request');
    }
    return serializeBounty(existing);
  }

  if (settings.require_target_online !== false) {
    const freshnessMinutes = Number(settings.online_freshness_minutes);
    if (!Number.isSafeInteger(freshnessMinutes) || freshnessMinutes < 5 || freshnessMinutes > 120) {
      throw new Error('Bounty online policy is invalid');
    }
    await requireFreshOnlineTarget(db, serverId, targetIdentityId, freshnessMinutes);
  }

  const wallet = await db.get(
    'SELECT cash_on_hand FROM player_wallets WHERE identity_id = ? AND server_id = ? FOR UPDATE',
    [posterIdentityId, serverId]
  );
  if (!wallet || parseCents(wallet.cash_on_hand, 'Wallet balance') < amountCents) {
    throw new Error('Insufficient wallet funds');
  }
  const timestamp = await databaseNow(db);
  const expiresAt = new Date(
    new Date(timestamp).getTime() + requestedExpiry * 60 * 60 * 1000
  ).toISOString();

  const updated = await db.get(
    `UPDATE player_wallets SET cash_on_hand = cash_on_hand - ?, last_updated = ?
     WHERE identity_id = ? AND server_id = ? AND cash_on_hand >= ?
     RETURNING cash_on_hand`,
    [centsToDecimal(amountCents), timestamp, posterIdentityId, serverId, centsToDecimal(amountCents)]
  );
  if (!updated) throw new Error('Insufficient wallet funds');
  const newBalanceCents = parseCents(updated.cash_on_hand, 'Wallet balance');
  await db.run(
    `INSERT INTO economy_transactions
     (identity_id, server_id, transaction_type, amount, balance_after, account_type, source, description, metadata, timestamp)
     VALUES (?, ?, 'penalty', ?, ?, 'wallet', 'bounty_escrow', ?, ?, ?)`,
    [posterIdentityId, serverId, centsToDecimal(-amountCents), centsToDecimal(newBalanceCents),
      'Bounty escrow reserved',
      JSON.stringify({ targetIdentityId, idempotencyKey }), timestamp]
  );
  const inserted = await db.run(
    `INSERT INTO bounties
     (server_id, guild_id, target_type, target_identity_id, creator_type,
      poster_identity_id, created_by_user_id, funding_type, amount, reason,
      idempotency_key, idempotency_fingerprint, created_at, expires_at)
     VALUES (?, ?, 'player', ?, 'player', ?, ?, 'player_wallet', ?, ?, ?, ?, ?, ?) RETURNING id`,
    [serverId, guildId, targetIdentityId, posterIdentityId, userId, centsToDecimal(amountCents), reason,
      idempotencyKey, idempotencyFingerprint, timestamp, expiresAt]
  );
  await appendBountyEvent(db, {
    bountyId: inserted.lastID, serverId, eventType: 'created', actorUserId: userId,
    actorIdentityId: posterIdentityId, createdAt: timestamp,
    metadata: { targetType: 'player', targetIdentityId },
  });
  await appendBountyEvent(db, {
    bountyId: inserted.lastID, serverId, eventType: 'funded', actorUserId: userId,
    actorIdentityId: posterIdentityId, createdAt: timestamp,
    metadata: { fundingType: 'player_wallet', amount: centsToDecimal(amountCents) },
  });

  return {
    id: inserted.lastID,
    serverId,
    targetType: 'player',
    targetIdentityId,
    targetFactionId: null,
    targetFactionName: null,
    targetFactionTag: null,
    creatorType: 'player',
    creatorFactionId: null,
    creatorFactionName: null,
    creatorFactionTag: null,
    posterIdentityId,
    fundingType: 'player_wallet',
    amount,
    reason,
    status: 'active',
    objectiveType: null,
    requiredKills: null,
    eligibleMemberCount: null,
    progressKills: 0,
    createdAt: timestamp,
    expiresAt,
  };
}

async function createFactionBountyInTransaction(db, context, input) {
  if (input?.targetIdentityId !== undefined && input?.targetIdentityId !== null && input?.targetIdentityId !== '') {
    throw new Error('Exactly one bounty target is required');
  }
  const amount = monetaryAmount(input?.amount);
  const amountCents = storedAmountCents(amount);
  const serverId = positiveId(context?.serverId, 'Canonical server context');
  const guildId = positiveId(context?.guildId, 'Canonical guild context');
  const posterIdentityId = positiveId(context?.identityId, 'Player identity');
  const userId = positiveId(context?.userId, 'Authenticated user');
  const targetFactionId = positiveId(input?.targetFactionId, 'Target faction');
  const idempotencyKey = boundedText(input?.idempotencyKey, 128, 'Idempotency key');
  if (!idempotencyKey) throw new Error('Idempotency key is required');
  const reason = boundedText(input?.reason, 500, 'Reason');
  const requestedExpiryInput = input?.expiryHours === undefined
    ? null : positiveId(input.expiryHours, 'Expiry');
  const idempotencyFingerprint = JSON.stringify({
    targetType: 'faction', targetFactionId, amount, reason,
    expiryHours: requestedExpiryInput,
  });

  await lockUserRoleMutations(db, [userId]);
  await lockApprovedActiveServer(db, serverId, guildId);

  // A replay does not touch faction state, so keep its established
  // server -> player authority -> bounty lock order. New commands follow the
  // faction routes' faction -> player membership order below.
  const existingProbe = await db.get(
    `SELECT id FROM bounties
     WHERE server_id = ? AND poster_identity_id = ? AND idempotency_key = ?`,
    [serverId, posterIdentityId, idempotencyKey]
  );
  if (existingProbe) {
    await lockPlayerAuthority(db, serverId, posterIdentityId, userId);
    const existing = await db.get(
      `SELECT *,
         (SELECT COUNT(*) FROM bounty_faction_members bfm
          WHERE bfm.bounty_id = bounties.id AND bfm.member_role = 'target') AS eligible_member_count,
         (SELECT COUNT(DISTINCT victim_identity_id) FROM bounty_objective_events boe
          WHERE boe.bounty_id = bounties.id) AS progress_kills
       FROM bounties
       WHERE server_id = ? AND poster_identity_id = ? AND idempotency_key = ?
       FOR UPDATE`,
      [serverId, posterIdentityId, idempotencyKey]
    );
    if (existing) {
      if (existing.idempotency_fingerprint !== idempotencyFingerprint) {
        throw new Error('Idempotency key conflicts with another request');
      }
      return serializeBounty(existing);
    }
  }

  const creatorReference = await db.get(
    `SELECT faction_id FROM faction_members
     WHERE guild_id = ? AND identity_id = ? AND rank IN ('leader', 'officer')`,
    [guildId, posterIdentityId]
  );
  if (!creatorReference) throw new Error('Faction leader or officer permission is required');
  const creatorFactionId = positiveId(creatorReference.faction_id, 'Creator faction');
  if (creatorFactionId === targetFactionId) {
    throw new Error('Factions cannot place a bounty on themselves');
  }

  const lockedFactions = new Map();
  for (const factionId of [creatorFactionId, targetFactionId].sort((a, b) => a - b)) {
    lockedFactions.set(factionId, await lockFaction(db, factionId, guildId));
  }
  await lockPlayerAuthority(db, serverId, posterIdentityId, userId);

  // Another request with this key may have committed while this transaction
  // waited for the faction locks. Recheck under lock before reserving funds.
  const existing = await db.get(
    `SELECT *,
       (SELECT COUNT(*) FROM bounty_faction_members bfm
        WHERE bfm.bounty_id = bounties.id AND bfm.member_role = 'target') AS eligible_member_count,
       (SELECT COUNT(DISTINCT victim_identity_id) FROM bounty_objective_events boe
        WHERE boe.bounty_id = bounties.id) AS progress_kills
     FROM bounties
     WHERE server_id = ? AND poster_identity_id = ? AND idempotency_key = ?
     FOR UPDATE`,
    [serverId, posterIdentityId, idempotencyKey]
  );
  if (existing) {
    if (existing.idempotency_fingerprint !== idempotencyFingerprint) {
      throw new Error('Idempotency key conflicts with another request');
    }
    return serializeBounty(existing);
  }

  const creatorMembership = await db.get(
    `SELECT faction_id, identity_id, rank FROM faction_members
     WHERE faction_id = ? AND guild_id = ? AND identity_id = ?
       AND rank IN ('leader', 'officer')
     FOR UPDATE`,
    [creatorFactionId, guildId, posterIdentityId]
  );
  if (!creatorMembership) throw new Error('Faction leader or officer permission is required');

  const rosters = new Map();
  for (const factionId of [creatorFactionId, targetFactionId].sort((a, b) => a - b)) {
    rosters.set(factionId, await lockFactionRoster(db, factionId, guildId, serverId));
  }
  const targetRoster = rosters.get(targetFactionId);
  const sponsorRoster = rosters.get(creatorFactionId);
  if (!sponsorRoster.includes(posterIdentityId)) {
    throw new Error('Faction sponsor is not active on this server');
  }

  await db.run(
    'INSERT INTO bounty_settings (server_id) VALUES (?) ON CONFLICT (server_id) DO NOTHING',
    [serverId]
  );
  const settings = await db.get(
    `SELECT bs.*, gec.enabled AS economy_enabled
     FROM bounty_settings bs
     JOIN guild_economy_config gec ON gec.server_id = bs.server_id
     WHERE bs.server_id = ? FOR UPDATE`,
    [serverId]
  );
  if (!settings?.economy_enabled || !settings.enabled || !settings.player_posting_enabled) {
    throw new Error('Faction bounties are disabled');
  }
  if (amountCents < parseCents(settings.minimum_amount, 'Minimum bounty amount') ||
      amountCents > parseCents(settings.maximum_amount, 'Maximum bounty amount')) {
    throw new Error('Bounty amount is outside configured limits');
  }
  const requiredKills = positiveId(settings.faction_kills_required || 3, 'Faction kills required');
  if (targetRoster.length < requiredKills) {
    throw new Error(`Target faction needs at least ${requiredKills} active members on this server`);
  }
  const requestedExpiry = requestedExpiryInput == null
    ? Number(settings.default_expiry_hours)
    : requestedExpiryInput;
  if (!Number.isSafeInteger(requestedExpiry) || requestedExpiry <= 0
      || requestedExpiry > Number(settings.maximum_expiry_hours)) {
    throw new Error('Expiry is outside configured limits');
  }

  const wallet = await db.get(
    'SELECT cash_on_hand FROM player_wallets WHERE identity_id = ? AND server_id = ? FOR UPDATE',
    [posterIdentityId, serverId]
  );
  if (!wallet || parseCents(wallet.cash_on_hand, 'Wallet balance') < amountCents) {
    throw new Error('Insufficient wallet funds');
  }
  const timestamp = await databaseNow(db);
  const expiresAt = new Date(
    new Date(timestamp).getTime() + requestedExpiry * 60 * 60 * 1000
  ).toISOString();
  const updated = await db.get(
    `UPDATE player_wallets SET cash_on_hand = cash_on_hand - ?, last_updated = ?
     WHERE identity_id = ? AND server_id = ? AND cash_on_hand >= ?
     RETURNING cash_on_hand`,
    [centsToDecimal(amountCents), timestamp, posterIdentityId, serverId, centsToDecimal(amountCents)]
  );
  if (!updated) throw new Error('Insufficient wallet funds');
  const newBalanceCents = parseCents(updated.cash_on_hand, 'Wallet balance');
  await db.run(
    `INSERT INTO economy_transactions
     (identity_id, server_id, transaction_type, amount, balance_after, account_type, source, description, metadata, timestamp)
     VALUES (?, ?, 'penalty', ?, ?, 'wallet', 'bounty_escrow', ?, ?, ?)`,
    [posterIdentityId, serverId, centsToDecimal(-amountCents), centsToDecimal(newBalanceCents),
      'Faction bounty escrow reserved',
      JSON.stringify({ targetType: 'faction', targetFactionId, creatorFactionId, idempotencyKey }), timestamp]
  );

  const targetFaction = lockedFactions.get(targetFactionId);
  const creatorFaction = lockedFactions.get(creatorFactionId);
  const inserted = await db.run(
    `INSERT INTO bounties
     (server_id, guild_id, target_type, target_faction_id, target_faction_id_snapshot,
      target_faction_name_snapshot, target_faction_tag_snapshot,
      creator_type, creator_faction_id, creator_faction_id_snapshot,
      creator_faction_name_snapshot, creator_faction_tag_snapshot,
      poster_identity_id, created_by_user_id, funding_type, amount, reason,
      objective_type, required_kills, idempotency_key, idempotency_fingerprint, created_at, expires_at)
     VALUES (?, ?, 'faction', ?, ?, ?, ?, 'faction', ?, ?, ?, ?, ?, ?, 'player_wallet', ?, ?,
       'target_member_kill_count', ?, ?, ?, ?, ?) RETURNING id`,
    [serverId, guildId, targetFactionId, targetFactionId, targetFaction.name, targetFaction.tag,
      creatorFactionId, creatorFactionId, creatorFaction.name, creatorFaction.tag,
      posterIdentityId, userId, centsToDecimal(amountCents), reason, requiredKills, idempotencyKey,
      idempotencyFingerprint, timestamp, expiresAt]
  );
  const bountyId = positiveId(inserted.lastID, 'Created bounty');
  for (const identityId of targetRoster) {
    await db.run(
      `INSERT INTO bounty_faction_members
       (bounty_id, server_id, member_role, identity_id, captured_at)
       VALUES (?, ?, 'target', ?, ?)`,
      [bountyId, serverId, identityId, timestamp]
    );
  }
  for (const identityId of sponsorRoster) {
    await db.run(
      `INSERT INTO bounty_faction_members
       (bounty_id, server_id, member_role, identity_id, captured_at)
       VALUES (?, ?, 'sponsor', ?, ?)`,
      [bountyId, serverId, identityId, timestamp]
    );
  }
  await appendBountyEvent(db, {
    bountyId, serverId, eventType: 'created', actorUserId: userId,
    actorIdentityId: posterIdentityId, createdAt: timestamp,
    metadata: { targetType: 'faction', targetFactionId, creatorFactionId,
      eligibleMemberCount: targetRoster.length, requiredKills },
  });
  await appendBountyEvent(db, {
    bountyId, serverId, eventType: 'funded', actorUserId: userId,
    actorIdentityId: posterIdentityId, createdAt: timestamp,
    metadata: { fundingType: 'player_wallet', amount: centsToDecimal(amountCents) },
  });

  return {
    id: bountyId,
    serverId,
    targetType: 'faction',
    targetIdentityId: null,
    targetFactionId,
    targetFactionName: targetFaction.name,
    targetFactionTag: targetFaction.tag,
    creatorType: 'faction',
    creatorFactionId,
    creatorFactionName: creatorFaction.name,
    creatorFactionTag: creatorFaction.tag,
    posterIdentityId,
    fundingType: 'player_wallet',
    amount,
    reason,
    status: 'active',
    objectiveType: 'target_member_kill_count',
    requiredKills,
    eligibleMemberCount: targetRoster.length,
    progressKills: 0,
    createdAt: timestamp,
    expiresAt,
  };
}

async function createBountyInTransaction(db, context, input) {
  const targetType = input?.targetType || (input?.targetFactionId ? 'faction' : 'player');
  if (targetType === 'player') return createPlayerBountyInTransaction(db, context, input);
  if (targetType === 'faction') return createFactionBountyInTransaction(db, context, input);
  throw new Error('Bounty target type is invalid');
}

module.exports = {
  monetaryAmount,
  serializeBounty,
  createBountyInTransaction,
  createPlayerBountyInTransaction,
  createFactionBountyInTransaction,
  cancelBountyInTransaction,
  expireBounties,
  claimBountiesForKillInTransaction,
  claimFinancialRefundsInTransaction,
  insertOrVerifyPendingRefundClaim,
  lockBountyAdminAuthority,
  updateBountySettingsInTransaction,
};
