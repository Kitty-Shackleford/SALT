const { isTrustedLinkMethod } = require('../utils/linkTrust');

const REVIEW_STATUSES = new Set(['pending', 'confirmed', 'dismissed']);
const RAPID_SWITCH_SECONDS = 300;
const LIKELY_SWITCH_SECONDS = 120;

function pairKey(a, b) {
  const low = Math.min(Number(a), Number(b));
  const high = Math.max(Number(a), Number(b));
  return `${low}:${high}`;
}

function normalizeReviewStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!REVIEW_STATUSES.has(normalized)) {
    throw new Error('Invalid review status');
  }
  return normalized;
}

function accountSummary(account) {
  return {
    identityId: Number(account.identity_id),
    gamertag: account.gamertag || 'Unknown',
    platform: account.platform || 'unknown',
  };
}

function sessionsOverlap(left, right) {
  const leftStart = Date.parse(left.login_at);
  const leftEnd = Date.parse(left.logout_at);
  const rightStart = Date.parse(right.login_at);
  const rightEnd = Date.parse(right.logout_at);
  if (![leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite)) return false;
  return leftStart < rightEnd && rightStart < leftEnd;
}

function pairWasConcurrent(sessionsByIdentity, firstId, secondId) {
  const first = sessionsByIdentity.get(firstId) || [];
  const second = sessionsByIdentity.get(secondId) || [];
  for (const left of first) {
    for (const right of second) {
      if (sessionsOverlap(left, right)) return true;
    }
  }
  return false;
}

function buildReviewMap(reviews) {
  return new Map((reviews || []).map(review => [
    pairKey(review.identity_id_low, review.identity_id_high),
    {
      status: review.status || 'pending',
      notes: review.notes || '',
      reviewedAt: review.reviewed_at || null,
      reviewedBy: review.reviewed_by || null,
    },
  ]));
}

function createCandidate(accountsById, firstId, secondId, confidence, evidence, reviewMap) {
  const identityIds = [Math.min(firstId, secondId), Math.max(firstId, secondId)];
  return {
    identityIds,
    accounts: identityIds.map(id => accountSummary(accountsById.get(id))),
    confidence,
    evidence,
    review: reviewMap.get(pairKey(firstId, secondId)) || {
      status: 'pending',
      notes: '',
      reviewedAt: null,
      reviewedBy: null,
    },
  };
}

function firstSessionAfter(sessions, timestampMs) {
  let low = 0;
  let high = sessions.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Date.parse(sessions[middle].login_at) <= timestampMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function behaviorEvidenceFromAggregate(row) {
  const eventCount = Number(row.event_count);
  const strictCount = Number(row.strict_count);
  const distinctDays = Number(row.distinct_days);
  return [
    {
      type: 'rapid_switches',
      label: `Repeated account handoffs within ${RAPID_SWITCH_SECONDS / 60} minutes`,
      count: eventCount,
      strictCount,
      minimumDelaySeconds: Number(row.minimum_delay_seconds),
    },
    {
      type: 'distinct_days',
      label: 'Handoffs occurred on separate days',
      count: distinctDays,
    },
    {
      type: 'bidirectional_switches',
      label: 'Handoffs occurred in both directions',
    },
    {
      type: 'never_concurrent',
      label: 'No overlapping completed sessions were observed',
    },
  ];
}

function buildAltCandidates({ accounts = [], sessions = [], reviews = [], behaviorCandidates = [] }) {
  const accountsById = new Map(accounts.map(account => [Number(account.identity_id), account]));
  const reviewMap = buildReviewMap(reviews);
  const candidates = new Map();

  const linkedGroups = new Map();
  for (const account of accounts) {
    if (!account.linked_user_id || !isTrustedLinkMethod(account.verification_method)) continue;
    const linkedUserId = String(account.linked_user_id);
    if (!linkedGroups.has(linkedUserId)) linkedGroups.set(linkedUserId, []);
    linkedGroups.get(linkedUserId).push(Number(account.identity_id));
  }
  for (const identityIds of linkedGroups.values()) {
    const uniqueIds = [...new Set(identityIds)].sort((a, b) => a - b);
    for (let i = 0; i < uniqueIds.length; i++) {
      for (let j = i + 1; j < uniqueIds.length; j++) {
        const firstId = uniqueIds[i];
        const secondId = uniqueIds[j];
        candidates.set(pairKey(firstId, secondId), createCandidate(
          accountsById,
          firstId,
          secondId,
          'confirmed',
          [{
            type: 'verified_discord_owner',
            label: 'Both accounts have trusted ownership verification to the same Discord user',
          }],
          reviewMap
        ));
      }
    }
  }

  const validSessions = sessions
    .filter(item => accountsById.has(Number(item.identity_id)))
    .filter(item => Number.isFinite(Date.parse(item.login_at)) && Number.isFinite(Date.parse(item.logout_at)))
    .map(item => ({ ...item, identity_id: Number(item.identity_id) }))
    .sort((a, b) => Date.parse(a.login_at) - Date.parse(b.login_at));
  const sessionsByIdentity = new Map();
  for (const item of validSessions) {
    if (!sessionsByIdentity.has(item.identity_id)) sessionsByIdentity.set(item.identity_id, []);
    sessionsByIdentity.get(item.identity_id).push(item);
  }

  const transitions = new Map();
  for (const ending of validSessions) {
    const logoutMs = Date.parse(ending.logout_at);
    const firstFollowingIndex = firstSessionAfter(validSessions, logoutMs);
    for (let index = firstFollowingIndex; index < validSessions.length; index++) {
      const starting = validSessions[index];
      const loginMs = Date.parse(starting.login_at);
      const delaySeconds = Math.floor((loginMs - logoutMs) / 1000);
      if (delaySeconds > RAPID_SWITCH_SECONDS) break;
      if (ending.identity_id === starting.identity_id) continue;
      const key = pairKey(ending.identity_id, starting.identity_id);
      if (!transitions.has(key)) {
        transitions.set(key, {
          firstId: Math.min(ending.identity_id, starting.identity_id),
          secondId: Math.max(ending.identity_id, starting.identity_id),
          events: [],
          directions: new Set(),
          days: new Set(),
        });
      }
      const transition = transitions.get(key);
      transition.events.push({ delaySeconds, at: ending.logout_at });
      transition.directions.add(`${ending.identity_id}>${starting.identity_id}`);
      transition.days.add(new Date(logoutMs).toISOString().slice(0, 10));
    }
  }

  for (const transition of transitions.values()) {
    if (transition.events.length < 3 || transition.days.size < 2 || transition.directions.size < 2) continue;
    if (pairWasConcurrent(sessionsByIdentity, transition.firstId, transition.secondId)) continue;

    const strictEvents = transition.events.filter(event => event.delaySeconds <= LIKELY_SWITCH_SECONDS);
    const strictSwitches = strictEvents.length;
    const strictDays = new Set(strictEvents.map(event => String(event.at).slice(0, 10)));
    const confidence = strictSwitches >= 3 && strictDays.size >= 2 ? 'likely' : 'possible';
    const delays = transition.events.map(event => event.delaySeconds);
    const behaviorEvidence = [
      {
        type: 'rapid_switches',
        label: `Repeated account handoffs within ${RAPID_SWITCH_SECONDS / 60} minutes`,
        count: transition.events.length,
        strictCount: strictSwitches,
        minimumDelaySeconds: Math.min(...delays),
      },
      {
        type: 'distinct_days',
        label: 'Handoffs occurred on separate days',
        count: transition.days.size,
      },
      {
        type: 'bidirectional_switches',
        label: 'Handoffs occurred in both directions',
      },
      {
        type: 'never_concurrent',
        label: 'No overlapping completed sessions were observed',
      },
    ];
    const key = pairKey(transition.firstId, transition.secondId);
    const existing = candidates.get(key);
    if (existing) {
      existing.evidence.push(...behaviorEvidence);
    } else {
      candidates.set(key, createCandidate(
        accountsById,
        transition.firstId,
        transition.secondId,
        confidence,
        behaviorEvidence,
        reviewMap
      ));
    }
  }

  for (const row of behaviorCandidates) {
    const firstId = Number(row.identity_id_low);
    const secondId = Number(row.identity_id_high);
    if (!accountsById.has(firstId) || !accountsById.has(secondId)) continue;
    const strictDays = Number(row.strict_distinct_days);
    const confidence = Number(row.strict_count) >= 3 && strictDays >= 2 ? 'likely' : 'possible';
    const evidence = behaviorEvidenceFromAggregate(row);
    const key = pairKey(firstId, secondId);
    const existing = candidates.get(key);
    if (existing) existing.evidence.push(...evidence);
    else candidates.set(key, createCandidate(accountsById, firstId, secondId, confidence, evidence, reviewMap));
  }

  for (const review of reviews) {
    const firstId = Number(review.identity_id_low);
    const secondId = Number(review.identity_id_high);
    const key = pairKey(firstId, secondId);
    if (candidates.has(key) || !accountsById.has(firstId) || !accountsById.has(secondId)) continue;
    candidates.set(key, createCandidate(
      accountsById,
      firstId,
      secondId,
      review.status === 'confirmed' ? 'confirmed' : 'possible',
      [{
        type: 'persisted_review',
        label: 'Persisted moderator decision; current detection evidence is no longer available',
      }],
      reviewMap
    ));
  }

  const confidenceOrder = { confirmed: 0, likely: 1, possible: 2 };
  return [...candidates.values()].sort((a, b) =>
    confidenceOrder[a.confidence] - confidenceOrder[b.confidence]
    || a.identityIds[0] - b.identityIds[0]
    || a.identityIds[1] - b.identityIds[1]
  );
}

async function loadAltCandidates(db, serverId) {
  const [accounts, behaviorCandidates, reviews] = await Promise.all([
    db.query(`
      SELECT DISTINCT ON (pi.id)
        pi.id AS identity_id,
        pi.platform,
        pg.gamertag,
        la.user_id AS linked_user_id,
        la.verification_method
      FROM player_identities pi
      JOIN player_server_activity psa
        ON psa.identity_id = pi.id
       AND psa.server_id = ?
      JOIN player_gamertags pg
        ON pg.identity_id = pi.id
       AND pg.server_id = psa.server_id
       AND pg.is_current_gamertag = 1
      JOIN servers s ON s.id = psa.server_id AND s.status = 'active'
      JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
      LEFT JOIN server_player_memberships spm
        ON spm.identity_id = pi.id
       AND spm.server_id = ?
       AND spm.status = 'active'
      LEFT JOIN linked_accounts la
        ON la.id = spm.source_link_id
       AND la.identity_id = spm.identity_id
       AND la.user_id = spm.user_id
      ORDER BY pi.id,
        CASE la.verification_method
          WHEN 'emote_challenge' THEN 1
          WHEN 'admin_approved' THEN 2
          ELSE 3
        END
    `, [serverId, serverId]),
    db.query(`
      WITH transitions AS (
        SELECT
          LEAST(ending.identity_id, starting.identity_id) AS identity_id_low,
          GREATEST(ending.identity_id, starting.identity_id) AS identity_id_high,
          EXTRACT(EPOCH FROM (starting.login_at - ending.logout_at)) AS delay_seconds,
          (ending.logout_at AT TIME ZONE 'UTC')::date AS transition_day,
          ending.identity_id::text || '>' || starting.identity_id::text AS direction
        FROM player_sessions ending
        JOIN servers s ON s.id = ending.server_id AND s.status = 'active'
        JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
        JOIN LATERAL (
          SELECT candidate.identity_id, candidate.login_at
          FROM player_sessions candidate
          WHERE candidate.server_id = ending.server_id
            AND candidate.logout_at IS NOT NULL
            AND candidate.login_at > ending.logout_at
            AND candidate.login_at <= ending.logout_at + INTERVAL '5 minutes'
            AND candidate.identity_id <> ending.identity_id
          ORDER BY candidate.login_at
        ) starting ON TRUE
        WHERE ending.server_id = ?
          AND ending.logout_at IS NOT NULL
          AND ending.login_at >= NOW() - INTERVAL '90 days'
      ), aggregated AS (
        SELECT
          identity_id_low,
          identity_id_high,
          COUNT(*) AS event_count,
          COUNT(*) FILTER (WHERE delay_seconds <= 120) AS strict_count,
          COUNT(DISTINCT transition_day) AS distinct_days,
          COUNT(DISTINCT transition_day) FILTER (WHERE delay_seconds <= 120) AS strict_distinct_days,
          COUNT(DISTINCT direction) AS direction_count,
          MIN(delay_seconds) AS minimum_delay_seconds
        FROM transitions
        GROUP BY identity_id_low, identity_id_high
        HAVING COUNT(*) >= 3
           AND COUNT(DISTINCT transition_day) >= 2
           AND COUNT(DISTINCT direction) >= 2
      )
      SELECT aggregated.*
      FROM aggregated
      WHERE NOT EXISTS (
        SELECT 1
        FROM player_sessions older
        JOIN player_sessions newer
          ON newer.server_id = older.server_id
         AND newer.identity_id = aggregated.identity_id_high
         AND newer.logout_at IS NOT NULL
         AND tstzrange(newer.login_at, newer.logout_at, '[)')
             && tstzrange(older.login_at, older.logout_at, '[)')
        WHERE older.server_id = ?
          AND older.identity_id = aggregated.identity_id_low
          AND older.logout_at IS NOT NULL
      )
    `, [serverId, serverId]),
    db.query(`
      SELECT aar.identity_id_low, aar.identity_id_high, aar.status,
             aar.notes, aar.reviewed_at, aar.reviewed_by
      FROM alt_account_reviews aar
      JOIN servers s ON s.id = aar.server_id AND s.status = 'active'
      JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
      WHERE aar.server_id = ?
    `, [serverId]),
  ]);

  return buildAltCandidates({ accounts, behaviorCandidates, reviews });
}

module.exports = {
  buildAltCandidates,
  loadAltCandidates,
  normalizeReviewStatus,
};
