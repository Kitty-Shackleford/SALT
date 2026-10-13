'use strict';

/*
 * ops-intelligence-test.js
 *
 * Fixture suite for the ops-intelligence service (AI feature 7/7):
 * predictive warnings, lag remediation, rollback advisor. All deterministic —
 * no live data, no DB, no provider.
 *
 *   - detectPredictiveWarnings against a fake RPT tail + fake issues map
 *     (slow CE Loop ticks + spawn failures precede an out-of-memory crash)
 *   - persistWarnings idempotency (in-memory db: same fingerprint → update,
 *     no duplicate rows)
 *   - warningSummary shape (what the dashboard endpoint returns)
 *   - planLagSuggestions with synthetic density + extreme-tick causes
 *     (patch-backed maxPlayers / loot-chance edits, validated by the patch
 *     engine)
 *   - analyzeLagCauses with synthetic CE Loop telemetry rows (db path) and
 *     with an RPT-tail fallback (filesystem path, recent-crashes cause)
 *   - adviseRollbacks with synthetic before/after degradation around a
 *     backup timestamp (the advisor flags the degraded edit — and skips
 *     edits with too little data on either side)
 *   - collectBackupGroups / listBackups against a temp backup tree
 *     (data/backups/<user>/server_<psid>/<file>.<ts>.backup convention)
 *
 * No external fixture dir: everything is built inline so the suite is
 * portable to any checkout.
 */

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const ROOT = path.join(__dirname, '..');
const svc = require(path.join(ROOT, 'services', 'opsIntelligenceService'));

const FAKE_CONFIG_DIR = '/nonexistent/config'; // never touched — readTail is injected

// ─── Fixtures: fake RPT tail + fake issues map ───────────────────────────────
//
// File starts 20 minutes before the current top-of-hour (UTC), so every
// fixture timestamp lands inside the last 24h lookback window on any run.

const startMs = Math.floor(Date.now() / 3600e3) * 3600e3 - 20 * 60e3;
const crashMs = startMs + 40e3;

function rptName(ms) {
  const d = new Date(ms).toISOString();
  return `DayZServer_X1_x64_${d.slice(0, 10)}_${d.slice(11, 19).replace(/:/g, '-')}.RPT`;
}
const RPT_FILE = rptName(startMs);

function line(offsetSec, text) {
  const t = new Date(startMs + offsetSec * 1000).toISOString().slice(11, 23);
  return ` ${t} ${text}`;
}

function fixtureRptLines() {
  return [
    line(10, '*** CE Loop took 3.4 (sec)...'),
    line(10, 'players: 55, loot: 41000, infected: 120, animals: 15'),
    line(20, 'Error: Failed to spawn Object Litter_Small'),
    line(30, '*** CE Loop took 2.1 (sec)...'),
    line(30, 'players: 60, loot: 44000, infected: 125, animals: 18'),
    line(40, 'Fatal error: out of memory — shutting down'),
    line(50, '*** CE Loop took 2.7 (sec)...'),
    line(50, 'players: 58, loot: 42000, infected: 118, animals: 14'),
    line(60, 'Error: Failed to spawn Object Vehicle_C'),
  ];
}

// Fake known-issue table (same ids/severities as the seed entries the
// precursor set mirrors, so the "preceded a crash" correlation can fire).
const FAKE_ISSUES = [
  { id: 'ce-loop-slow', patterns: [/CE Loop took\s+([\d.]+)\s*\(sec\)/i], severity: 'warning', title: 'Tick over budget', actionable: true, dynamic: m => ({ durationSeconds: Number(m[1]) }) },
  { id: 'spawn-failed', patterns: [/(failed|Failed) to spawn/i], severity: 'warning', title: 'Spawn failed', actionable: true },
  { id: 'oom-crash', patterns: [/out of memory/i], severity: 'fatal', title: 'Out of memory', actionable: true },
  { id: 'fatal-exception', patterns: [/^Exception:/], severity: 'fatal', title: 'Fatal exception', actionable: true },
];

function fakeDeps() {
  return {
    listFiles: () => [{ name: RPT_FILE }, { name: 'server.log' }, { name: 'config.xml' }],
    readTail: () => fixtureRptLines(),
    configDir: FAKE_CONFIG_DIR,
    issues: FAKE_ISSUES,
  };
}

function testDetectPredictiveWarnings() {
  const detection = svc.detectPredictiveWarnings(fakeDeps());

  // One fatal crash window ending at the OOM line.
  assert.equal(detection.crashWindows.length, 1);
  assert.equal(detection.crashWindows[0].endsAt, crashMs);
  assert.equal(detection.crashWindows[0].kind, 'fatal');
  assert.ok(detection.crashWindows[0].candidates.length >= 4, 'crash window carries root-cause candidates');
  assert.equal(detection.lastCrashAt, crashMs);

  // Precursors, sorted severity-first: oom (critical), ce-loop (high), spawn (medium).
  const ids = detection.precursors.map(p => p.id);
  assert.deepEqual(ids, ['oom-crash', 'ce-loop-slow', 'spawn-failed']);

  const oom = detection.precursors[0];
  assert.equal(oom.severity, 'critical');
  assert.equal(oom.occurrences, 1);
  assert.equal(oom.lastSeenAt, crashMs);
  assert.ok(oom.lastCrashPreceded, 'oom precursor preceded this server\'s own crash');
  assert.equal(oom.lastCrashPreceded.atMs, crashMs);
  assert.equal(oom.lastCrashPreceded.occurrences, 1);

  const ce = detection.precursors[1];
  assert.equal(ce.severity, 'high');
  assert.equal(ce.occurrences, 3); // all three slow ticks are in the recent window
  assert.equal(ce.lastSeenAt, startMs + 50e3);
  assert.equal(ce.lastCrashPreceded.occurrences, 1); // one crash window preceded by this pattern
  assert.equal(ce.lastCrashPreceded.atMs, crashMs);

  const spawn = detection.precursors[2];
  assert.equal(spawn.occurrences, 2);
  assert.equal(spawn.lastCrashPreceded.occurrences, 1);

  // CE Loop stats over the three ticks.
  assert.equal(detection.ceLoop.samples, 3);
  assert.equal(detection.ceLoop.slowSamples, 3);
  assert.equal(detection.ceLoop.maxSeconds, 3.4);
  assert.equal(detection.ceLoop.avgSeconds, 2.73);

  // Deterministic: same input, same output.
  assert.deepEqual(svc.detectPredictiveWarnings(fakeDeps()), detection);
}

// ─── In-memory db for persistWarnings / rollback advisor ────────────────────

function fakeOpsDb() {
  const rows = new Map();
  let nextId = 1;
  const active = () => [...rows.values()].filter(r => !r.deleted_at);
  return {
    _rows: rows,
    async get(sql, params) {
      const [serverId, fingerprint] = params;
      const row = active().find(r => r.server_id === serverId && r.fingerprint === fingerprint);
      return row ? { id: row.id } : null;
    },
    async query(sql, params) {
      if (/^INSERT INTO ops_warnings/i.test(sql)) {
        const [server_id, precursor_id, severity, fingerprint, payload] = params;
        const row = { id: nextId++, server_id, precursor_id, severity, fingerprint, payload, detected_at: Date.now(), deleted_at: null };
        rows.set(row.id, row);
        return [row];
      }
      if (/^UPDATE ops_warnings SET detected_at/i.test(sql)) {
        const [payload, id] = params;
        const row = rows.get(id);
        if (row && !row.deleted_at) { row.payload = payload; row.detected_at = Date.now(); }
        return [];
      }
      if (/^UPDATE ops_warnings SET deleted_at/i.test(sql)) {
        const dayAgo = Date.now() - 24 * 3600 * 1000;
        for (const row of rows.values()) {
          if (row.server_id === params[0] && !row.deleted_at && row.detected_at < dayAgo) row.deleted_at = Date.now();
        }
        return [];
      }
      throw new Error('unexpected ops_warnings SQL: ' + sql.slice(0, 60));
    },
  };
}

async function testPersistWarningsIdempotent() {
  const detection = svc.detectPredictiveWarnings(fakeDeps());
  const db = fakeOpsDb();

  const run1 = await svc.persistWarnings(db, 42, detection);
  assert.equal(run1.length, 3);
  assert.equal(db._rows.size, 3);
  assert.ok(run1.every(r => Number.isInteger(r.id)), 'persisted rows carry the DB row id');
  assert.ok(run1.every(r => r.precursor_id), 'persisted rows carry the precursor id for the summary');

  // Same detection again → same fingerprints → UPDATE, no new rows.
  const run2 = await svc.persistWarnings(db, 42, detection);
  assert.equal(run2.length, 3);
  assert.equal(db._rows.size, 3, 'idempotent: no duplicate rows');
  assert.deepEqual(run2.map(r => r.id), run1.map(r => r.id), 'idempotent: same row ids');
  assert.equal(run2[0].payload, run1[0].payload, 'idempotent: same payload on re-persist');

  // A different server persists its own rows.
  const other = await svc.persistWarnings(db, 43, detection);
  assert.equal(db._rows.size, 6);
  assert.notDeepEqual(other.map(r => r.id), run1.map(r => r.id));

  return { detection, persisted: run2 };
}

function testWarningSummary(detection, persisted) {
  const summary = svc.warningSummary(detection, persisted);

  assert.ok(typeof summary.generatedAt === 'string' && !Number.isNaN(Date.parse(summary.generatedAt)));
  assert.equal(summary.lastCrashAt, new Date(crashMs).toISOString());
  assert.equal(summary.recentCrashCount, 1);
  assert.equal(summary.precursorsSeen, 3);
  assert.equal(summary.ceLoop.samples, 3);

  assert.equal(summary.activeWarnings.length, 3);
  const oom = summary.activeWarnings.find(w => w.precursorId === 'oom-crash');
  assert.ok(oom, 'summary exposes the oom warning');
  assert.ok(Number.isInteger(oom.id), 'summary row keeps the DB id');
  assert.equal(oom.severity, 'critical');
  assert.equal(oom.occurrences, 1);
  assert.equal(new Date(oom.lastSeenAt).toISOString(), new Date(crashMs).toISOString());
  assert.equal(oom.lastCrashPreceded.at, new Date(crashMs).toISOString());
  assert.equal(oom.lastCrashPreceded.occurrences, 1);
  assert.ok(typeof oom.sample === 'string' && oom.sample.includes('out of memory'));
}

// ─── Lag remediation ─────────────────────────────────────────────────────────

function testPlanLagSuggestions() {
  const analysis = {
    causes: [
      { id: 'entity-density', severity: 'high', label: 'Entity density overload', evidence: 'e', fix: 'f', lever: 'loot-infection-density' },
      { id: 'ce-loop-extreme', severity: 'critical', label: 'Extreme tick overrun', evidence: 'e', fix: 'f', lever: 'max-players' },
    ],
    ceLoopStats: { samples: 120, slowSamples: 21, avgSeconds: 2.4, maxSeconds: 12.5 },
  };
  const profile = '<properties>\n  <property name="maxPlayers" value="100" />\n  <property name="name" value="SALT" />\n</properties>\n';
  const preset = '<class Name="CfgRandomPresets">\n  <cargo chance="0.2" name="LootCrateSmall" />\n  <cargo chance="0.6" name="LootCrateBig" />\n</class>\n';

  const suggestions = svc.planLagSuggestions(analysis, [
    { filename: 'serverProfile.xml', content: profile },
    { filename: 'cfgrandompresets.xml', content: preset },
  ]);
  assert.equal(suggestions.length, 2, 'one validated suggestion per available lever');

  const maxS = suggestions.find(s => s.filename === 'serverProfile.xml');
  assert.ok(maxS, 'maxPlayers suggestion');
  assert.equal(maxS.cause, 'ce-loop-extreme');
  assert.ok(maxS.suggestedContent.includes('value="50"'));
  assert.ok(!maxS.suggestedContent.includes('value="100"'));

  const lootS = suggestions.find(s => s.filename === 'cfgrandompresets.xml');
  assert.ok(lootS, 'loot-density suggestion');
  assert.equal(lootS.cause, 'entity-density');
  assert.ok(lootS.suggestedContent.includes('chance="0.3"'), 'highest-chance cargo halved');
  assert.ok(!lootS.suggestedContent.includes('chance="0.6"'));

  for (const s of suggestions) {
    assert.ok(s.explanation.length > 0);
    assert.equal(s.originalContent, s.filename === 'serverProfile.xml' ? profile : preset);
    assert.ok(s.patch && s.patch.kind === 'xml-search-replace');
    assert.ok(s.patch.edits.length === 1);
    assert.ok(typeof s.baseContentHash === 'string' && s.baseContentHash.length === 64);
    assert.ok(s.diffSummary.addedCount >= 1 && s.diffSummary.removedCount >= 1);
    assert.ok(s.prediction.length > 0);
  }

  // No patchable files → no suggestions (the causes still surface upstream).
  assert.deepEqual(svc.planLagSuggestions(analysis, []), []);
  assert.deepEqual(svc.planLagSuggestions(analysis, null), []);
}

function telemetryRowsDb(rows) {
  return {
    async query(sql) {
      if (/observed_at, payload/.test(sql) && /dayz\.ce\.loop/.test(sql)) return rows;
      throw new Error('unexpected telemetry SQL: ' + sql.slice(0, 80));
    },
  };
}

async function testAnalyzeLagCausesDbPath() {
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < 9; i++) {
    rows.push({
      observed_at: new Date(now - (i + 1) * 5 * 60e3).toISOString(),
      payload: { durationSeconds: 0.9 + (i % 3) * 0.1, players: 20, loot: 5000, infected: 30, animals: 5 },
    });
  }
  [2.5, 3.1, 4.0].forEach((d, i) => {
    rows.push({
      observed_at: new Date(now - (i + 1) * 3 * 60e3).toISOString(),
      payload: { durationSeconds: d, players: 55 + i, loot: 45000 - i * 1000, infected: 110, animals: 20 },
    });
  });

  const analysis = await svc.analyzeLagCauses({ db: telemetryRowsDb(rows), serverId: 7, sinceMs: now - 24 * 3600e3 });
  assert.equal(analysis.sampleCount, 12);
  const density = analysis.causes.find(c => c.id === 'entity-density');
  assert.ok(density, 'entity-density cause from synthetic slow-tick share');
  assert.equal(density.lever, 'loot-infection-density');
  assert.equal(density.severity, 'high');
  assert.ok(!analysis.causes.some(c => c.id === 'ce-loop-extreme'), 'max tick 4.0s is not extreme');
  assert.equal(analysis.ceLoopStats.samples, 12);
  assert.equal(analysis.ceLoopStats.slowSamples, 3);

  // Same rows + one extreme tick → ce-loop-extreme cause appears.
  rows.push({ observed_at: new Date(now - 60e3).toISOString(), payload: { durationSeconds: 12.5, players: 70, loot: 51000, infected: 140, animals: 30 } });
  const extreme = await svc.analyzeLagCauses({ db: telemetryRowsDb(rows), serverId: 7, sinceMs: now - 24 * 3600e3 });
  assert.ok(extreme.causes.some(c => c.id === 'ce-loop-extreme'), '12.5s tick is an extreme overrun');
  assert.equal(extreme.ceLoopStats.maxSeconds, 12.5);
}

async function testAnalyzeLagCausesRptFallback() {
  // No db — RPT-tail fallback path (the same fixture as detection: 3 slow
  // ticks + a crash window inside the last 24h).
  const analysis = await svc.analyzeLagCauses({ filesystem: fakeDeps(), sinceMs: Date.now() - 24 * 3600e3 });
  assert.equal(analysis.sampleCount, 3, 'slow ticks pulled from the RPT tail when no telemetry rows exist');
  assert.ok(analysis.causes.some(c => c.id === 'recent-crashes'), 'crash window in window → recent-crashes cause');
  assert.ok(!analysis.causes.some(c => c.id === 'entity-density'), 'fewer than 10 samples → no density verdict');
}

// ─── Rollback advisor ────────────────────────────────────────────────────────

// Synthetic telemetry around the recent edit T2: ticks 60% slower after the
// edit, plus a crash that only appears after it. The older edit T1 sits in a
// flat period (no degradation).
function makeAdvisorDb({ T2, crashAt }) {
  return {
    async query(sql, params) {
      const from = Date.parse(params[1]);
      const to = Date.parse(params[2]);
      if (/COUNT\(\*\)::int AS samples/.test(sql)) {
        if (to <= T2) return [{ samples: 30, avg_seconds: 1.0, max_seconds: 1.2, slow: 0 }];
        if (from >= T2) return [{ samples: 30, avg_seconds: 1.6, max_seconds: 3.1, slow: 9 }];
        return [{ samples: 5, avg_seconds: 1.3, max_seconds: 1.5, slow: 1 }]; // too thin
      }
      if (/event_type = 'dayz\.crash'/.test(sql)) {
        if (crashAt !== null && from <= crashAt && crashAt <= to) {
          return [{ observed_at: new Date(crashAt).toISOString() }];
        }
        return [];
      }
      throw new Error('unexpected advisor SQL: ' + sql.slice(0, 80));
    },
  };
}

// Flat ticks everywhere except a +10% step around T1 (below the 20%
// degradation threshold); a crash lands only in T2's after window.
function makeCrashRegressionDb({ T1, T2, crashAt }) {
  return {
    async query(sql, params) {
      const from = Date.parse(params[1]);
      const to = Date.parse(params[2]);
      if (/COUNT\(\*\)::int AS samples/.test(sql)) {
        if (to <= T1) return [{ samples: 30, avg_seconds: 1.0, max_seconds: 1.2, slow: 0 }];
        if (from >= T1 && to <= T2) return [{ samples: 30, avg_seconds: 1.1, max_seconds: 1.3, slow: 0 }];
        if (from >= T2) return [{ samples: 30, avg_seconds: 1.1, max_seconds: 1.3, slow: 0 }];
        return [{ samples: 30, avg_seconds: 1.05, max_seconds: 1.25, slow: 0 }];
      }
      if (/event_type = 'dayz\.crash'/.test(sql)) {
        if (crashAt !== null && from <= crashAt && crashAt <= to) {
          return [{ observed_at: new Date(crashAt).toISOString() }];
        }
        return [];
      }
      throw new Error('unexpected advisor SQL: ' + sql.slice(0, 80));
    },
  };
}

async function testAdviseRollbacks() {
  const now = Date.now();
  const T2 = now - 3600e3; // recent edit: degraded
  const T1 = T2 - 5 * 3600e3; // older edit: flat
  const crashAt = T2 + 3600e3;

  const groups = {
    'serverProfile.xml': [
      { backupFile: `serverProfile.xml.${T2}.backup`, timestampMs: T2, atMs: T2 },
      { backupFile: `serverProfile.xml.${T1}.backup`, timestampMs: T1, atMs: T1 },
    ],
    'cfgdayz.xml': [ // both edits land in thin-data windows → must be skipped
      { backupFile: `cfgdayz.xml.${T2 - 3600e3}.backup`, timestampMs: T2 - 3600e3, atMs: T2 - 3600e3 },
      { backupFile: `cfgdayz.xml.${T2 - 3000e3}.backup`, timestampMs: T2 - 3000e3, atMs: T2 - 3000e3 },
    ],
    'cfgsingle.xml': [
      { backupFile: `cfgsingle.xml.${T1}.backup`, timestampMs: T1, atMs: T1 }, // < 2 backups → ignored
    ],
    _allFiles: ['x'],
  };

  const results = await svc.adviseRollbacks(makeAdvisorDb({ T2, crashAt }), 7, groups, { windowHours: 2, maxBackups: 8 });

  assert.equal(results.length, 1, 'only the file with a data-backed edit is reported');
  const res = results[0];
  assert.equal(res.fileName, 'serverProfile.xml');
  assert.equal(res.totalBackups, 2);
  assert.equal(res.editsAnalyzed, 2);

  const t2 = res.edits.find(e => e.atMs === T2);
  assert.ok(t2, 'recent edit analyzed');
  assert.equal(t2.before.avgSeconds, 1.0);
  assert.equal(t2.after.avgSeconds, 1.6);
  assert.equal(t2.deltaPct, 60);
  assert.equal(t2.degraded, true, 'advisor flags the degraded edit');
  assert.equal(t2.improved, false);

  const t1 = res.edits.find(e => e.atMs === T1);
  assert.equal(t1.deltaPct, 0);
  assert.equal(t1.degraded, false, 'flat period is not flagged');

  assert.equal(res.worstEdit.atMs, T2, 'worst edit is the degraded one');
  assert.equal(res.worstEdit.degraded, true);

  // A crash-regression-only degradation must rank as the worst edit even
  // when another edit carries a larger non-degrading tick delta (+10% here,
  // below the 20% threshold): the dashboard headline reads worstEdit.degraded.
  const results2 = await svc.adviseRollbacks(makeCrashRegressionDb({ T1, T2, crashAt: T2 + 1800e3 }), 7, {
    'serverProfile.xml': [
      { backupFile: `serverProfile.xml.${T2}.backup`, timestampMs: T2, atMs: T2 },
      { backupFile: `serverProfile.xml.${T1}.backup`, timestampMs: T1, atMs: T1 },
    ],
    _allFiles: ['x'],
  }, { windowHours: 2, maxBackups: 8 });
  const res2 = results2[0];
  assert.equal(res2.edits.find(e => e.atMs === T2).degraded, true, 'crash regression alone degrades the edit');
  assert.equal(res2.edits.find(e => e.atMs === T1).degraded, false, '+10% tick delta stays below the degradation threshold');
  assert.equal(res2.worstEdit.atMs, T2, 'worst edit is the crash-regressed one, not the higher-delta flat one');
  assert.equal(res2.worstEdit.degraded, true);

  // ceLoopWindow / crashWindowStats directly against the same windows.
  const before = await svc.ceLoopWindow(makeAdvisorDb({ T2, crashAt }), 7, T2 - 2 * 3600e3, T2);
  assert.deepEqual(before, { samples: 30, avg: 1.0, max: 1.2, slow: 0 });
}

// ─── Backup discovery (mission-files backup convention) ──────────────────────

function testBackupDiscovery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-backups-'));
  try {
    const mk = (rel, ts) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '');
    };
    mk('user1/server_123/serverProfile.xml.1000.backup', 1000);
    mk('user1/server_123/serverProfile.xml.2000.backup', 2000);
    mk('user1/server_123/cfgdayz.xml.1500.backup', 1500);
    mk('user2/server_123/serverProfile.xml.2000.backup', 2000); // same (file, ts) via another user → deduped
    mk('user2/server_123/cfgother.json.3000.backup', 3000);
    mk('user9/server_999/cfgx.xml.500.backup', 500); // different server → excluded

    const single = svc.listBackups(root, 'user1', '123');
    assert.deepEqual(single['serverProfile.xml'].map(b => b.timestampMs), [2000, 1000], 'newest first');
    assert.equal(single._allFiles.length, 3);

    const groups = svc.collectBackupGroups(root, '123');
    assert.deepEqual(groups['serverProfile.xml'].map(b => b.timestampMs), [2000, 1000], 'cross-user dedupe by (file, ts)');
    assert.equal(groups['cfgdayz.xml'].length, 1);
    assert.equal(groups['cfgother.json'].length, 1, 'edits by other users count as config edits');
    assert.equal(groups._allFiles.length, 5, 'server_999 backups excluded');

    assert.deepEqual(svc.scanBackupDirs(root, '123').length, 2, 'two users hold backups for this server');
    assert.deepEqual(svc.scanBackupDirs(root, '999').length, 1);
    assert.deepEqual(svc.collectBackupGroups(path.join(root, 'does-not-exist'), '123'), { _allFiles: [] }, 'missing root is safe');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  testDetectPredictiveWarnings();
  const { detection, persisted } = await testPersistWarningsIdempotent();
  testWarningSummary(detection, persisted);
  testPlanLagSuggestions();
  await testAnalyzeLagCausesDbPath();
  await testAnalyzeLagCausesRptFallback();
  await testAdviseRollbacks();
  testBackupDiscovery();
  console.log('✅ Ops intelligence tests passed (7 fixture groups, offline)');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
