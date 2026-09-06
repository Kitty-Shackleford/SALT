const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  buildAltCandidates,
  loadAltCandidates,
  normalizeReviewStatus,
} = require('../services/altAccountCandidateService');

function session(identityId, loginAt, logoutAt) {
  return { identity_id: identityId, login_at: loginAt, logout_at: logoutAt };
}

async function run() {
  const accounts = [
    { identity_id: 1, gamertag: 'Alpha', platform: 'xbox', linked_user_id: 10, verification_method: 'emote_challenge' },
    { identity_id: 2, gamertag: 'Bravo', platform: 'xbox', linked_user_id: 10, verification_method: 'admin_approved' },
    { identity_id: 3, gamertag: 'Charlie', platform: 'xbox', linked_user_id: 11, verification_method: 'self_asserted' },
  ];

  const confirmed = buildAltCandidates({ accounts, sessions: [], reviews: [] });
  assert.strictEqual(confirmed.length, 1);
  assert.strictEqual(confirmed[0].confidence, 'confirmed');
  assert.deepStrictEqual(confirmed[0].identityIds, [1, 2]);
  assert.ok(confirmed[0].evidence.some(item => item.type === 'verified_discord_owner'));

  const behavioralAccounts = accounts.map(account => ({ ...account, linked_user_id: null, verification_method: null }));
  const behavioralSessions = [
    session(1, '2026-08-01T10:00:00Z', '2026-08-01T10:10:00Z'),
    session(2, '2026-08-01T10:11:00Z', '2026-08-01T10:20:00Z'),
    session(1, '2026-08-02T11:00:00Z', '2026-08-02T11:10:00Z'),
    session(2, '2026-08-02T11:11:30Z', '2026-08-02T11:20:00Z'),
    session(2, '2026-08-03T12:00:00Z', '2026-08-03T12:10:00Z'),
    session(1, '2026-08-03T12:11:00Z', '2026-08-03T12:20:00Z'),
  ];
  const behavioral = buildAltCandidates({ accounts: behavioralAccounts, sessions: behavioralSessions, reviews: [] });
  assert.strictEqual(behavioral.length, 1);
  assert.strictEqual(behavioral[0].confidence, 'likely');
  assert.strictEqual(Object.hasOwn(behavioral[0], 'enforcementEligible'), false,
    'candidate API must not imply that detection alone authorizes enforcement');
  assert.strictEqual(behavioral[0].evidence.find(item => item.type === 'rapid_switches').count, 3);
  assert.strictEqual(behavioral[0].evidence.find(item => item.type === 'distinct_days').count, 3);

  const overlapping = behavioralSessions.concat([
    session(1, '2026-08-04T10:00:00Z', '2026-08-04T11:00:00Z'),
    session(2, '2026-08-04T10:30:00Z', '2026-08-04T10:45:00Z'),
  ]);
  assert.strictEqual(buildAltCandidates({ accounts: behavioralAccounts, sessions: overlapping, reviews: [] }).length, 0);

  const reviewed = buildAltCandidates({
    accounts: behavioralAccounts,
    sessions: behavioralSessions,
    reviews: [{ identity_id_low: 1, identity_id_high: 2, status: 'dismissed', notes: 'Known siblings' }],
  });
  assert.strictEqual(reviewed[0].review.status, 'dismissed');
  assert.strictEqual(reviewed[0].review.notes, 'Known siblings');

  const staleReview = buildAltCandidates({
    accounts: behavioralAccounts,
    sessions: [],
    reviews: [{ identity_id_low: 1, identity_id_high: 2, status: 'confirmed', notes: 'Previously reviewed' }],
  });
  assert.strictEqual(staleReview.length, 1, 'persisted reviews must remain manageable after evidence ages out');
  assert.strictEqual(staleReview[0].review.status, 'confirmed');
  assert.ok(staleReview[0].evidence.some(item => item.type === 'persisted_review'));

  const strictOnOneDay = behavioralSessions.map((item, index) =>
    index === 4 || index === 5
      ? { ...item, login_at: item.login_at.replace('2026-08-03', '2026-08-02'), logout_at: item.logout_at.replace('2026-08-03', '2026-08-02') }
      : item
  );
  strictOnOneDay[3] = session(2, '2026-08-02T11:14:00Z', '2026-08-02T11:20:00Z');
  const oneDayLikely = buildAltCandidates({ accounts: behavioralAccounts, sessions: strictOnOneDay, reviews: [] });
  assert.ok(oneDayLikely.every(candidate => candidate.confidence !== 'likely'),
    'likely confidence requires strict switches on separate days');

  assert.strictEqual(normalizeReviewStatus('confirmed'), 'confirmed');
  assert.strictEqual(normalizeReviewStatus('dismissed'), 'dismissed');
  assert.strictEqual(normalizeReviewStatus('pending'), 'pending');
  assert.throws(() => normalizeReviewStatus('banned'), /Invalid review status/);

  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('AS event_count')) return [{
        identity_id_low: 1,
        identity_id_high: 2,
        event_count: 3,
        strict_count: 3,
        distinct_days: 3,
        strict_distinct_days: 3,
        minimum_delay_seconds: 60,
      }];
      if (sql.includes('FROM alt_account_reviews')) return [];
      return behavioralAccounts;
    },
  };
  await loadAltCandidates(db, 44);
  assert.ok(calls.length >= 3);
  calls.forEach(call => assert.ok(call.params.includes(44), 'every candidate query must bind the exact server'));
  assert.ok(calls.some(call => /spm\.server_id = \?/.test(call.sql)), 'linked ownership must be exact-server scoped');
  const behaviorCall = calls.find(call => call.sql.includes('AS event_count'));
  assert.ok(behaviorCall, 'behavioral correlation must run in bounded SQL');
  assert.match(behaviorCall.sql, /JOIN LATERAL/,
    'rapid-switch correlation must use an indexable range lookup');
  assert.doesNotMatch(behaviorCall.sql, /WITH recent_sessions/,
    'request-time correlation must not self-join a materialized session CTE');
  assert.match(behaviorCall.sql, /tstzrange\(newer\.login_at, newer\.logout_at, '\[\)'\)\s*&&\s*tstzrange\(older\.login_at, older\.logout_at, '\[\)'\)/,
    'historical overlap exclusion must use PostgreSQL range overlap');
  assert.doesNotMatch(behaviorCall.sql, /older\.login_at < newer\.logout_at/,
    'historical overlap exclusion must not use a quadratic interval inequality join');
  assert.doesNotMatch(behaviorCall.sql, /LIMIT\s+\?/, 'candidate correctness must not depend on truncating sessions');
  assert.ok(calls.some(call => /aar\.server_id = \?/.test(call.sql)), 'reviews must be exact-server scoped');

  const ownerSource = fs.readFileSync(path.join(ROOT, 'routes/ownerDashboard.js'), 'utf8');
  assert.doesNotMatch(ownerSource, /async function runAutoBanForServer/,
    'obsolete device-based automatic banning must be removed');
  assert.match(ownerSource, /router\.post\('\/servers\/:id\/alts\/review'/,
    'review mutation endpoint must exist');
  const reviewArea = ownerSource.slice(ownerSource.indexOf("router.post('/servers/:id/alts/review'"));
  assert.match(reviewArea, /ensureServerOwner/);
  assert.match(reviewArea, /identity_id_low/);
  assert.match(reviewArea, /identity_id_high/);
  assert.match(reviewArea, /existingReview/,
    'persisted decisions must be mutable without recalculating behavioral evidence');

  const migration = fs.readFileSync(path.join(ROOT, 'db/migrations/061_alt_account_reviews.js'), 'utf8');
  assert.match(migration, /UNIQUE\(server_id, identity_id_low, identity_id_high\)/);
  assert.match(migration, /CHECK \(identity_id_low < identity_id_high\)/);
  assert.match(migration, /status IN \('pending', 'confirmed', 'dismissed'\)/);
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS btree_gist/,
    'combined scalar/range GiST indexing requires btree_gist');
  assert.match(migration, /USING GIST \(\s*server_id,\s*identity_id,\s*tstzrange\(login_at, logout_at, '\[\)'\)\s*\)/,
    'completed-session overlap checks need an exact-server, exact-identity range index');
  assert.match(migration, /WHERE logout_at IS NOT NULL/,
    'session range index must exclude incomplete sessions');
  assert.match(migration, /UPDATE server_settings SET auto_ban_alts = 0/,
    'upgrade must fail closed by disabling legacy automatic enforcement');

  const html = fs.readFileSync(path.join(ROOT, 'public/server-players.html'), 'utf8');
  assert.doesNotMatch(html, /Auto-Ban Alts/);
  assert.match(html, /Possible Alt Review/);
  const browserSource = fs.readFileSync(path.join(ROOT, 'public/js/server-players.js'), 'utf8');
  assert.doesNotMatch(browserSource, /Ban All|data-alt-group|autoBanToggleBtn/);
  assert.match(browserSource, /data\.canReview \?/);
  assert.match(browserSource, /dataset\.reviewNotes/,
    'status changes must preserve existing moderator notes');
  assert.match(browserSource, /data-review-status/);

  console.log('Alt account candidate tests passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
