const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  parseRPTLoginWaitFile,
  parseRPTLoginWaits,
} = require('../routes/logParser');
const {
  buildAltCandidates,
  loadAltCandidates,
  normalizeReviewStatus,
} = require('../services/altAccountCandidateService');

function session(identityId, loginAt, logoutAt) {
  return { identity_id: identityId, login_at: loginAt, logout_at: logoutAt };
}

async function run() {
  const rptWaits = parseRPTLoginWaits([
    '14:30:00.500 [Login]: Adding player Alpha One (12345678) to login queue at position 0',
    '14:30:01.125 [StateMachine]: Player Alpha One (dpnid 12345678 uid AABBCCDDEEFF0011) Entering DBWaitLoginTimeLoginState',
    '14:33:27.139 [StateMachine]: Player Alpha One (dpnid 12345678 uid AABBCCDDEEFF0011) Entering DBGetCharacterLoginState',
    '14:40:00.000 [StateMachine]: Player Incomplete Two (dpnid 87654321 uid 0011AABBCCDDEEFF) Entering DBWaitLoginTimeLoginState',
  ], '2026-09-07', 'xbox', 'fixture.RPT');
  assert.deepStrictEqual(rptWaits, [{
    playerGamertag: 'Alpha One',
    platformUserId: 'AABBCCDDEEFF0011',
    queueEnteredAt: '2026-09-07T14:30:00.500Z',
    waitStartedAt: '2026-09-07T14:30:01.125Z',
    waitEndedAt: '2026-09-07T14:33:27.139Z',
    waitDurationMs: 206014,
    sourceFile: 'fixture.RPT',
    sourceLine: 2,
  }], 'RPT wait parsing must preserve names with spaces, milliseconds, and ignore incomplete waits');

  const oversizedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpt-wait-'));
  const oversizedPath = path.join(oversizedDir, 'DayZServer_X1_x64_2026-09-07_23-50-00.RPT');
  try {
    fs.writeFileSync(oversizedPath, [
      '23:59:55.000 [Login]: Adding player Midnight Alt (22222222) to login queue at position 0\n',
      '23:59:56.000 [StateMachine]: Player Midnight Alt (dpnid 22222222 uid ABCDEF0011223344) Entering DBWaitLoginTimeLoginState\n',
      `${'x'.repeat(20 * 1024 * 1024 + 1024)}\n`,
      '00:01:06.000 [StateMachine]: Player Midnight Alt (dpnid 22222222 uid ABCDEF0011223344) Entering DBGetCharacterLoginState\n',
    ].join(''));
    const oversizedWaits = await parseRPTLoginWaitFile(
      oversizedPath,
      '2026-09-07',
      'xbox',
      { rootDir: oversizedDir }
    );
    assert.strictEqual(oversizedWaits.length, 1,
      'oversized active RPT files must retain waits that begin before the moving tail');
    assert.strictEqual(oversizedWaits[0].sourceLine, 2,
      'RPT evidence must retain an absolute source line as the file grows');
    assert.strictEqual(oversizedWaits[0].waitEndedAt, '2026-09-08T00:01:06.000Z',
      'RPT evidence must preserve midnight rollover from the complete chronology');
    assert.strictEqual(oversizedWaits[0].waitDurationMs, 70000);
  } finally {
    fs.rmSync(oversizedDir, { recursive: true, force: true });
  }

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

  const oneCycleSessions = [
    session(1, '2026-09-07T14:00:00Z', '2026-09-07T14:10:00Z'),
    session(2, '2026-09-07T14:11:00Z', '2026-09-07T14:20:00Z'),
    session(1, '2026-09-07T14:21:00Z', '2026-09-07T14:30:00Z'),
  ];
  const oneCycle = buildAltCandidates({ accounts: behavioralAccounts, sessions: oneCycleSessions, reviews: [] });
  assert.strictEqual(oneCycle.length, 1,
    'a bidirectional account-switch cycle within two minutes must surface for moderator review');
  assert.strictEqual(oneCycle[0].confidence, 'possible',
    'one-day behavioral evidence must remain possible rather than likely');
  assert.strictEqual(oneCycle[0].evidence.find(item => item.type === 'rapid_switches').strictCount, 2);
  const oneCycleDays = oneCycle[0].evidence.find(item => item.type === 'distinct_days');
  assert.strictEqual(oneCycleDays.count, 1);
  assert.match(oneCycleDays.label, /one day/i);
  assert.doesNotMatch(oneCycleDays.label, /separate days/i);

  const oneDirectionOnly = [
    session(1, '2026-09-07T10:00:00Z', '2026-09-07T10:10:00Z'),
    session(2, '2026-09-07T10:11:00Z', '2026-09-07T10:20:00Z'),
    session(1, '2026-09-07T11:00:00Z', '2026-09-07T11:10:00Z'),
    session(2, '2026-09-07T11:11:00Z', '2026-09-07T11:20:00Z'),
  ];
  assert.strictEqual(
    buildAltCandidates({ accounts: behavioralAccounts, sessions: oneDirectionOnly, reviews: [] }).length,
    0,
    'repeated one-way handoffs alone must not create an alt candidate'
  );
  const enforcedDelayCandidate = buildAltCandidates({
    accounts: behavioralAccounts,
    sessions: [],
    reviews: [],
    behaviorCandidates: [{
      identity_id_low: 1,
      identity_id_high: 2,
      event_count: 1,
      strict_count: 1,
      distinct_days: 1,
      strict_distinct_days: 1,
      direction_count: 1,
      strict_direction_count: 1,
      enforced_wait_count: 1,
      minimum_delay_seconds: 91.899,
      minimum_wait_duration_ms: 206014,
      maximum_wait_duration_ms: 206014,
    }],
  });
  assert.strictEqual(enforcedDelayCandidate.length, 1,
    'one correlated RPT-enforced login delay must flag the account pair');
  assert.strictEqual(enforcedDelayCandidate[0].confidence, 'confirmed',
    'the enforced alt-account delay must be a definitive alt flag');
  assert.match(
    enforcedDelayCandidate[0].evidence.find(item => item.type === 'rapid_switches').label,
    /handoff within/i,
    'a single delay must not be described as repeated handoffs'
  );
  assert.ok(!enforcedDelayCandidate[0].evidence.some(item => item.type === 'bidirectional_switches'),
    'one enforced delay must not claim a bidirectional switch cycle');
  assert.ok(!enforcedDelayCandidate[0].evidence.some(item => item.type === 'never_concurrent'),
    'enforced-delay candidates must not claim concurrency was disproven when that check was bypassed');
  const mergedEnforcedDelayCandidate = buildAltCandidates({
    accounts: behavioralAccounts,
    sessions: oneCycleSessions,
    reviews: [],
    behaviorCandidates: [{
      identity_id_low: 1,
      identity_id_high: 2,
      event_count: 1,
      strict_count: 1,
      distinct_days: 1,
      strict_distinct_days: 1,
      direction_count: 1,
      strict_direction_count: 1,
      enforced_wait_count: 1,
      minimum_delay_seconds: 60,
      minimum_wait_duration_ms: 70000,
      maximum_wait_duration_ms: 70000,
    }],
  });
  assert.strictEqual(mergedEnforcedDelayCandidate[0].confidence, 'confirmed',
    'enforced-delay evidence must upgrade an existing behavioral candidate');
  assert.strictEqual(Object.hasOwn(enforcedDelayCandidate[0], 'enforcementEligible'), false,
    'an RPT delay flag must not silently become automatic enforcement');

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
        direction_count: 2,
        strict_direction_count: 2,
        minimum_delay_seconds: 60,
        enforced_wait_count: 2,
        minimum_wait_duration_ms: 206014,
        maximum_wait_duration_ms: 837021,
      }];
      if (sql.includes('FROM alt_account_reviews')) return [];
      return behavioralAccounts;
    },
  };
  const loadedCandidates = await loadAltCandidates(db, 44);
  assert.strictEqual(loadedCandidates[0].confidence, 'confirmed',
    'persisted enforced-delay evidence must return a definitive alt flag');
  const waitEvidence = loadedCandidates[0].evidence.find(item => item.type === 'rpt_login_wait');
  assert.deepStrictEqual(waitEvidence, {
    type: 'rpt_login_wait',
    label: 'RPT login-state waits observed: 3m 26s–13m 57s',
    count: 2,
    minimumWaitSeconds: 206.014,
    maximumWaitSeconds: 837.021,
  });
  assert.ok(calls.length >= 3);
  calls.forEach(call => assert.ok(call.params.includes(44), 'every candidate query must bind the exact server'));
  assert.ok(calls.some(call => /spm\.server_id = \?/.test(call.sql)), 'linked ownership must be exact-server scoped');
  const behaviorCall = calls.find(call => call.sql.includes('AS event_count'));
  assert.ok(behaviorCall, 'behavioral correlation must run in bounded SQL');
  assert.match(behaviorCall.sql, /FROM player_sessions starting[\s\S]*FROM player_sessions ending[\s\S]*ORDER BY ending\.logout_at DESC[\s\S]*LIMIT 1/,
    'each login must correlate only to its nearest preceding different-account logout');
  assert.doesNotMatch(behaviorCall.sql, /starting\.logout_at IS NOT NULL/,
    'an open starting session with enforced RPT delay must remain eligible');
  assert.match(behaviorCall.sql, /JOIN LATERAL/,
    'rapid-switch correlation must use an indexable range lookup');
  assert.doesNotMatch(behaviorCall.sql, /WITH recent_sessions/,
    'request-time correlation must not self-join a materialized session CTE');
  assert.match(behaviorCall.sql, /tstzrange\(newer\.login_at, newer\.logout_at, '\[\)'\)\s*&&\s*tstzrange\(older\.login_at, older\.logout_at, '\[\)'\)/,
    'historical overlap exclusion must use PostgreSQL range overlap');
  assert.doesNotMatch(behaviorCall.sql, /older\.login_at < newer\.logout_at/,
    'historical overlap exclusion must not use a quadratic interval inequality join');
  assert.doesNotMatch(behaviorCall.sql, /LIMIT\s+\?/, 'candidate correctness must not depend on truncating sessions');
  assert.match(behaviorCall.sql, /HAVING COUNT\(login_wait_duration_ms\) >= 1[\s\S]*OR/,
    'one correlated enforced RPT wait must flag the account pair without requiring a bidirectional cycle');
  assert.match(behaviorCall.sql, /login_wait\.wait_duration_ms >= 60000/,
    'ordinary approximately six-second database login work must not be classified as an enforced delay');
  assert.match(behaviorCall.sql, /COUNT\(\*\) FILTER \(WHERE delay_seconds <= 120\) >= 2/,
    'possible candidates require a strict bidirectional switch cycle');
  assert.match(behaviorCall.sql, /COUNT\(DISTINCT direction\) FILTER \(WHERE delay_seconds <= 120\) >= 2/,
    'both directions must occur inside the strict two-minute window');
  assert.match(behaviorCall.sql, /LEFT JOIN LATERAL[\s\S]*FROM rpt_login_wait_events login_wait[\s\S]*login_wait\.server_id = starting\.server_id[\s\S]*login_wait\.identity_id = starting\.identity_id/,
    'RPT waits must correlate to the starting identity on the same exact server');
  assert.match(behaviorCall.sql, /login_wait\.queue_entered_at BETWEEN starting\.login_at - INTERVAL '5 seconds'[\s\S]*starting\.login_at \+ INTERVAL '5 seconds'/,
    'RPT waits must correlate to the matching ADM login rather than arbitrary account history');
  assert.match(behaviorCall.sql, /WHERE \( aggregated\.enforced_wait_count >= 1 OR NOT EXISTS \( SELECT 1 FROM player_sessions older/,
    'authoritative enforced-delay evidence must remain flagged despite contradictory session history');
  assert.match(behaviorCall.sql, /AND \( aggregated\.enforced_wait_count >= 1 OR NOT EXISTS \( SELECT 1 FROM player_position_snapshots first_sighting/,
    'authoritative enforced-delay evidence must remain flagged despite stale position co-presence');
  assert.match(behaviorCall.sql, /FROM player_position_snapshots first_sighting[\s\S]*second_sighting\.timestamp = first_sighting\.timestamp/,
    'same-snapshot co-presence must suppress behavior-only candidates');
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

  const waitMigration = fs.readFileSync(path.join(ROOT, 'db/migrations/087_rpt_login_wait_evidence.js'), 'utf8');
  assert.match(waitMigration, /CREATE TABLE IF NOT EXISTS rpt_login_wait_events/);
  assert.match(waitMigration, /server_id INTEGER NOT NULL REFERENCES servers\(id\) ON DELETE CASCADE/);
  assert.match(waitMigration, /identity_id INTEGER NOT NULL REFERENCES player_identities\(id\) ON DELETE CASCADE/);
  assert.match(waitMigration, /UNIQUE \(server_id, source_file, source_line\)/,
    'RPT wait rescans must be idempotent per exact source line');
  assert.match(waitMigration, /CHECK \(wait_ended_at >= wait_started_at\)/);
  assert.match(
    waitMigration,
    /CREATE INDEX IF NOT EXISTS idx_player_sessions_server_logout_alt_lookup[\s\S]*ON player_sessions \(server_id, logout_at DESC\)[\s\S]*INCLUDE \(identity_id\)[\s\S]*WHERE logout_at IS NOT NULL/,
    'nearest preceding logout correlation requires a matching partial index'
  );

  const parserSource = fs.readFileSync(path.join(ROOT, 'routes/logParser.js'), 'utf8');
  assert.match(parserSource, /await parseRPTFileObservations\(logPath, rptDate, platform, \{ rootDir: baseDir \}\)/,
    'the production RPT scan must stream complete login-wait and telemetry chronology with absolute source lines');
  assert.match(parserSource, /saveRPTLoginWaitEvents\(db, serverId, allLoginWaitEvents, platform, serverContext\.id\)/,
    'the production RPT scan must persist login-wait evidence after identities exist');

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
