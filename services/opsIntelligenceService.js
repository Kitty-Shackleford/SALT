/**
 * opsIntelligenceService.js
 *
 * AI feature 7/7 — ops/automation intelligence. Three capabilities, all
 * DETERMINISTIC (the AI only writes human explanation prose; detection never
 * depends on a provider):
 *
 *   1. Predictive warnings — pattern-match recent RPT/ADM crash windows
 *      against this server's OWN crash history: "the same precursor pattern
 *      preceded a crash at <time> last time" + severity. Persisted per
 *      server in the `ops_warnings` table (idempotent by fingerprint).
 *   2. Lag remediation    — detect likely lag causes from real data (CE
 *      Loop tick duration + entity counts, slow-tick share, crash windows)
 *      and turn them into patch-backed config suggestions that are
 *      validated all-or-nothing by aiConfigPatchService BEFORE anything is
 *      stored (suggestions are never auto-applied).
 *   3. Rollback advisor   — compare the tick/perf + crash metrics of the
 *      window before vs. after each of the last N config edits (the
 *      mission-files backup chain) and flag edits that degraded the server.
 *      Restore is left to the existing /mission-files/.../restore endpoint
 *      (authorization unchanged); this service only advises.
 *
 * Reuse, not re-derivation: crash-window detection reuses
 * logIntelligenceService (buildCrashWindows / clusterWarnings / signal
 * extraction), config edits are read from routes/missionFiles.js's backup
 * convention (data/backups/<userId>/server_<psid>/<file>.<ts>.backup), and
 * suggestions reuse the existing ai_suggestions patch machinery
 * (routes/ai.js saveSuggestionGroup convention).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const logIntelligenceService = require('./logIntelligenceService');
const patchEngine = require('./aiConfigPatchService');

const {
  extractSignals,
  buildCrashWindows,
  ceLoopStats,
  findLogFiles,
  logDateFromRptFilename,
  MAX_RPT_SCAN_BYTES,
} = logIntelligenceService;

// ─── 1. Predictive warnings ─────────────────────────────────────────────────

// Precursor patterns that precede a crash/lag spike on DayZ servers. These are
// DETERMINISTIC signals (same engine as logIntelligenceService's known-issue
// table) — they never depend on an AI provider.
// NOTE: the first two entries must mirror the `oom-crash` and `fatal-exception`
// SEVERITY table ids in logIntelligenceService — crash windows are built from
// `severity === 'fatal'` warnings, so a precursor must match the seed entry
// that classifies the same line as fatal, or the "preceded a crash" correlation
// can never fire.
const CRASH_PRECURSORS = Object.freeze([
  { id: 'oom-crash',          issueId: 'oom-crash',           patterns: [/out of memory/i, /OutOfMemory/i, /segmentation fault/i, /access violation/i], severity: 'critical', label: 'Memory / fault pressure' },
  { id: 'fatal-exception',    issueId: 'fatal-exception',     patterns: [/^Exception:/i, /FATAL/i, /ASSERT/i, /Failed to start the server/i],                severity: 'critical', label: 'Fatal exception' },
  { id: 'ce-loop-slow',       issueId: 'ce-loop-slow',        patterns: [/CE Loop took\s+(\d+[.,]\d*)\s*\(sec\)/i],                                                 severity: 'high',     label: 'Server tick (CE Loop) over budget' },
  { id: 'spawn-failed',       issueId: 'spawn-failed',        patterns: [/(failed|Failed) to spawn/i],                                                               severity: 'medium',   label: 'Repeated object spawn failures' },
  { id: 'null-pointer-script',issueId: 'null-pointer-script', patterns: [/NULL pointer to instance/i],                                                               severity: 'medium',   label: 'Recurring script NULL pointers' },
]);

const SEVERITY_RANK = Object.freeze({ critical: 3, high: 2, medium: 1, low: 0 });
const WARNING_WINDOW_MS = 24 * 3600 * 1000;      // look back this far for precursors
const PRECURSOR_LOOKBACK_MS = 10 * 60 * 1000;    // how long before a crash counts as "preceded"

/**
 * Deterministic crash-precursor history for one server.
 *
 * @param {object} deps
 * @param {function} deps.listFiles  (dir) => entries
 * @param {function} deps.readTail   (rootDir, filename, maxBytes) => lines[]
 * @param {string}   deps.configDir  absolute path to .../config
 * @param {object}   [deps.issues]   known-issue table (defaults to loadKnownIssues)
 * @returns {{precursors, crashWindows, lastCrashAt, warnings}}
 *
 * `warnings` is the ops_warnings payload: one entry per precursor issue
 * currently (within WARNING_WINDOW_MS) active on this server, each with the
 * server's OWN prior crash windows that this same precursor pattern preceded.
 */
function detectPredictiveWarnings({ listFiles, readTail, configDir, issues } = {}) {
  if (!configDir) throw new Error('configDir is required');
  const issueTable = issues || logIntelligenceService.loadKnownIssues();
  const discovered = findLogFiles(listFiles, configDir);

  // Scan the most recent RPT + crash files (bounded window, like logIntelligence).
  const warnings = [];
  const ceLoops = [];
  const shutdowns = [];
  const scanFiles = [...discovered.rpt.slice(-4), ...discovered.crash.slice(-2)];
  const seenFiles = new Set();
  for (const file of scanFiles) {
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    let lines;
    try {
      lines = readTail(configDir, file, MAX_RPT_SCAN_BYTES);
    } catch (_error) { lines = []; }
    if (!Array.isArray(lines) || lines.length === 0) continue;
    const signals = extractSignals(lines, issueTable, logDateFromRptFilename(file));
    for (const w of signals.warnings) w.sourceFile = file;
    warnings.push(...signals.warnings);
    ceLoops.push(...signals.ceLoops);
    shutdowns.push(...signals.shutdowns);
  }

  const crashWindows = buildCrashWindows(warnings, shutdowns);
  const now = Date.now();
  const recentWindows = crashWindows.filter(w => w.endsAt && now - w.endsAt <= WARNING_WINDOW_MS);
  const lastCrashAt = recentWindows.length ? recentWindows[recentWindows.length - 1].endsAt : null;

  // Cluster the CURRENT (recent) warning stream by precursor. Matching is on
  // the seed issue id so the precursor set can never drift from the table that
  // classified the lines (deterministic: same table, same rows, same output).
  const precursors = [];
  for (const precursor of CRASH_PRECURSORS) {
    const hits = warnings.filter(w => w.atMs !== null && now - w.atMs <= WARNING_WINDOW_MS)
      .filter(w => w.issueId === precursor.issueId
        && (precursor.id !== 'ce-loop-slow' || (w.dynamic && Number(w.dynamic.durationSeconds) >= 2)));
    if (!hits.length) continue;
    const slowTicks = ceLoops.filter(c => c.atMs !== null && now - c.atMs <= WARNING_WINDOW_MS);
    const lastCrashes = recentWindows.filter(w =>
      hits.some(h => h.atMs >= w.endsAt - PRECURSOR_LOOKBACK_MS && h.atMs <= w.endsAt));
    precursors.push({
      id: precursor.id,
      label: precursor.label,
      severity: precursor.severity,
      occurrences: hits.length,
      lastSeenAt: Math.max(...hits.map(h => h.atMs)),
      sample: (hits[0].sample || '').slice(0, 240),
      slowTicksRecent: slowTicks.length,
      lastCrashPreceded: lastCrashes.length
        ? { atMs: Math.max(...lastCrashes.map(w => w.endsAt)), occurrences: lastCrashes.length }
        : null,
    });
  }
  precursors.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || (b.occurrences - a.occurrences));

  return {
    precursors,
    crashWindows: crashWindows.map(w => ({ endsAt: w.endsAt, kind: w.kind, candidates: w.rootCauseCandidates })),
    lastCrashAt,
    warnings,
    ceLoop: ceLoopStats(ceLoops),
  };
}

/**
 * Persist the detected warnings idempotently.
 *
 * @param {object} db         db abstraction (query/get)
 * @param {number} serverId   internal servers.id
 * @param {object} detection  the detectPredictiveWarnings() result
 * @returns {Promise<Array>} the persisted warning rows
 */
async function persistWarnings(db, serverId, detection) {
  const rows = [];
  for (const precursor of detection.precursors) {
    const fingerprint = crypto.createHash('sha256')
      .update(`${serverId}:${precursor.id}:${new Date(precursor.lastSeenAt).toISOString().slice(0, 10)}`)
      .digest('hex');
    const existing = await db.get(
      `SELECT id FROM ops_warnings WHERE server_id = $1 AND fingerprint = $2 AND deleted_at IS NULL LIMIT 1`,
      [serverId, fingerprint]
    );
    const payload = JSON.stringify({
      label: precursor.label,
      occurrences: precursor.occurrences,
      sample: precursor.sample,
      slowTicksRecent: precursor.slowTicksRecent,
      lastCrashPreceded: precursor.lastCrashPreceded,
      crashWindows: (detection.crashWindows || []).slice(-5),
    });
    if (existing) {
      await db.query(
        `UPDATE ops_warnings SET detected_at = NOW(), payload = $1::jsonb, updated_at = NOW()
         WHERE id = $2 AND deleted_at IS NULL`,
        [payload, existing.id]
      );
      rows.push({ ...precursor, id: existing.id, precursor_id: precursor.id });
    } else {
      const created = await db.query(
        `INSERT INTO ops_warnings (server_id, precursor_id, severity, fingerprint, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
        [serverId, precursor.id, precursor.severity, fingerprint, payload]
      );
      rows.push({ ...precursor, id: created[0]?.id || null, precursor_id: precursor.id });
    }
  }
  // Mark stale warnings (same server, older than a day) as deleted so the
  // dashboard only shows the current picture.
  await db.query(
    `UPDATE ops_warnings SET deleted_at = NOW()
     WHERE server_id = $1 AND deleted_at IS NULL AND detected_at < NOW() - INTERVAL '1 day'`,
    [serverId]
  );
  return rows;
}

/** Deterministic summary for the dashboard (no AI). */
function warningSummary(detection, persistedRows) {
  return {
    generatedAt: new Date().toISOString(),
    lastCrashAt: detection.lastCrashAt ? new Date(detection.lastCrashAt).toISOString() : null,
    recentCrashCount: (detection.crashWindows || []).length,
    ceLoop: detection.ceLoop,
    activeWarnings: persistedRows.map(row => ({
      id: row.id,
      precursorId: row.precursor_id || row.precursorId,
      label: row.label,
      severity: row.severity,
      occurrences: row.occurrences,
      lastSeenAt: new Date(row.lastSeenAt).toISOString(),
      sample: row.sample,
      lastCrashPreceded: row.lastCrashPreceded
        ? { at: new Date(row.lastCrashPreceded.atMs).toISOString(), occurrences: row.lastCrashPreceded.occurrences }
        : null,
    })),
    precursorsSeen: detection.precursors.length,
  };
}

// ─── 2. Lag remediation ─────────────────────────────────────────────────────

/**
 * Deterministic lag-cause analysis from the server's recent CE Loop data.
 *
 * Uses the DB's CE Loop telemetry (rpt_telemetry_events) when db + serverId
 * are given, otherwise falls back to the RPT file tail via `filesystem`.
 * Each detected cause maps to a config lever planLagSuggestions can patch.
 *
 * @param {object} args
 * @param {object}   [args.db]
 * @param {number}   [args.serverId]
 * @param {object}   [args.filesystem]  { listFiles, readTail, configDir } for RPT fallback
 * @param {number}   [args.sinceMs]     analysis window start (default: now - 24h)
 * @returns {Promise<{causes, ceLoopStats, sampleCount, windowStart}>}
 */
async function analyzeLagCauses({ db, serverId, filesystem, sinceMs } = {}) {
  const since = sinceMs || (Date.now() - 24 * 3600 * 1000);
  const samples = [];

  if (db && serverId && typeof db.query === 'function') {
    try {
      const rows = await db.query(
        `SELECT observed_at, payload FROM rpt_telemetry_events
         WHERE server_id = $1 AND event_type = 'dayz.ce.loop' AND deleted_at IS NULL
           AND observed_at >= $2::timestamptz
         ORDER BY observed_at DESC LIMIT 200`,
        [serverId, new Date(since).toISOString()]
      );
      for (const row of rows || []) {
        const payload = typeof row.payload === 'string' ? safeParseJson(row.payload) : (row.payload || {});
        samples.push({
          atMs: row.observed_at ? new Date(row.observed_at).getTime() : NaN,
          durationSeconds: Number(payload.durationSeconds || 0),
          players: payload.players ? Number(payload.players) : null,
          loot: payload.loot ? Number(payload.loot) : null,
          infected: payload.infected ? Number(payload.infected) : null,
          animals: payload.animals ? Number(payload.animals) : null,
        });
      }
    } catch (_error) { /* fall back to filesystem below */ }
  }

  // RPT-tail detection (crash windows + slow-tick fallback) is computed ONCE
  // and reused for both the sample fallback and the recent-crashes cause.
  let detected = null;
  if (filesystem && filesystem.configDir) {
    detected = detectPredictiveWarnings(filesystem);
    if (samples.length < 5 && detected.ceLoop && detected.ceLoop.slowest) {
      for (const s of detected.ceLoop.slowest) {
        const atMs = s.at ? Date.parse(s.at) : null;
        if (atMs !== null && atMs >= since) {
          samples.push({ atMs, durationSeconds: s.durationSeconds, players: s.players, loot: s.loot, infected: s.infected, animals: s.animals });
        }
      }
    }
  }

  const stats = ceLoopStats(samples);
  const causes = [];

  if (stats) {
    const slow = samples.filter(s => s.durationSeconds >= 2);
    if (slow.length >= 2 && samples.length >= 10 && slow.length / samples.length >= 0.1) {
      const maxLoot = Math.max(...slow.map(s => s.loot || 0));
      const maxPlayers = Math.max(...slow.map(s => s.players || 0));
      causes.push({
        id: 'entity-density',
        severity: 'high',
        label: 'Entity density overload',
        evidence: `Slow ticks (>=2s): ${slow.length} of ${samples.length} recent ticks; peak loot=${maxLoot}, players=${maxPlayers}`,
        fix: 'Reduce concurrent entity load: cap loot/infected density in the spawn config, or spread event/loot hotspots so ticks don\'t spike when players gather.',
        lever: 'loot-infection-density',
      });
    }
    if (stats.maxSeconds >= 10) {
      causes.push({
        id: 'ce-loop-extreme',
        severity: 'critical',
        label: 'Extreme tick overrun',
        evidence: `Max tick ${stats.maxSeconds}s (avg ${stats.avgSeconds}s) — the server is severely overloaded.`,
        fix: 'Check mods that do heavy per-tick work, reduce maxPlayers, and verify the server has enough RAM/CPU for the current entity counts.',
        lever: 'max-players',
      });
    }
  }

  if (detected) {
    const recentCrashes = (detected.crashWindows || []).filter(w => w.endsAt >= since);
    if (recentCrashes.length) {
      causes.push({
        id: 'recent-crashes',
        severity: 'critical',
        label: `${recentCrashes.length} crash window(s) in the last 24h`,
        evidence: recentCrashes.slice(-3).map(w => new Date(w.endsAt).toISOString()).join(', '),
        fix: 'Open the Log Intelligence tab to read the crash root-cause candidates, then apply the matching config patch. Rollback advisor will flag the edit that caused it.',
        lever: 'crash-investigation',
      });
    }
  }

  return {
    causes,
    ceLoopStats: stats,
    sampleCount: samples.length,
    windowStart: new Date(since).toISOString(),
  };
}

/**
 * Turn detected lag causes into validated patch-backed suggestions.
 * Returns [] when no patchable lever is available (the caller surfaces the
 * deterministic causes either way).
 *
 * @param {object} analysis       analyzeLagCausesAsync() result
 * @param {Array}  files          [{filename, content}] working copies to patch
 * @returns {Array} validated suggestions (each with {filename, explanation,
 *                originalContent, suggestedContent, diffSummary, patch, baseContentHash})
 */
function planLagSuggestions(analysis, files) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const suggestions = [];

  for (const cause of analysis.causes) {
    if (cause.lever === 'max-players') {
      // Find a serverProfile or DayZ.serverProfile among the files and cap
      // maxPlayers if it's high.
      const profile = files.find(f => /serverprofile/i.test(f.filename));
      if (profile) {
        // Full-tag search: the patch engine matches whole tags, so the
        // search must include the closing > (or />) or it can never resolve.
        const m = String(profile.content).match(/<property\s+name="maxPlayers"[^>]*value="(\d+)"[^>]*\/?>/i);
        if (m && Number(m[1]) > 40) {
          const newMax = String(Math.floor(Number(m[1]) / 2));
          const search = m[0];
          const replace = search.replace(/value="(\d+)"/, `value="${newMax}"`);
          try {
            const applied = patchEngine.applyPatch(profile.filename, profile.content, {
              kind: 'xml-search-replace',
              edits: [{ search, replace }],
            });
            suggestions.push({
              filename: profile.filename,
              explanation: `Max players is ${m[1]}; capping to ${newMax} reduces concurrent entity load. Max tick was ${analysis.ceLoopStats?.maxSeconds}s.`,
              originalContent: profile.content,
              suggestedContent: applied.content,
              diffSummary: patchEngine.diffSummary(profile.content, applied.content),
              patch: { kind: 'xml-search-replace', edits: [{ search, replace }] },
              baseContentHash: patchEngine.contentFingerprint(profile.content),
              cause: cause.id,
              prediction: `Expected to reduce peak concurrent players from ${m[1]} to ${newMax}; tick spikes from entity overload should drop proportionally.`,
            });
          } catch (_error) { /* invalid patch — skip */ }
        }
      }
    }
    if (cause.lever === 'loot-infection-density') {
      // Find a cfgrandompresets or cfgspawnabletypes and trim a high-chance
      // loot group as a demonstration patch (the real fix is usually a mod).
      const preset = files.find(f => /cfgrandompresets|cfgspawnabletypes/i.test(f.filename));
      if (preset) {
        // Find the cargo with the highest combined chance.
        const cargoMatches = String(preset.content).matchAll(/<cargo\s+chance="([\d.]+)"\s+name="([^"]+)"[^>]*\/?>/g);
        let best = null;
        for (const m of cargoMatches) {
          const chance = Number(m[1]);
          if (best === null || chance > best.chance) best = { chance, name: m[2], search: m[0] };
        }
        if (best && best.chance > 0.1) {
          const newChance = (best.chance * 0.5).toFixed(2).replace(/\.?0+$/, '');
          const replace = best.search.replace(/chance="([\d.]+)"/, `chance="${newChance}"`);
          try {
            const applied = patchEngine.applyPatch(preset.filename, preset.content, {
              kind: 'xml-search-replace',
              edits: [{ search: best.search, replace }],
            });
            suggestions.push({
              filename: preset.filename,
              explanation: `Largest spawn group "${best.name}" (chance ${best.chance}) halved to ${newChance} to reduce per-tick entity load. Slow tick share: ${analysis.ceLoopStats?.slowSamples}/${analysis.ceLoopStats?.samples}.`,
              originalContent: preset.content,
              suggestedContent: applied.content,
              diffSummary: patchEngine.diffSummary(preset.content, applied.content),
              patch: { kind: 'xml-search-replace', edits: [{ search: best.search, replace }] },
              baseContentHash: patchEngine.contentFingerprint(preset.content),
              cause: cause.id,
              prediction: `Reducing the highest-density spawn group should cut peak entity counts by roughly half for that group; tick duration should drop.`,
            });
          } catch (_error) { /* skip */ }
        }
      }
    }
  }

  return suggestions.slice(0, 5);
}

// ─── 3. Rollback advisor ────────────────────────────────────────────────────

/**
 * Discover the per-user backup directories for a server under the
 * mission-files backup root (data/backups/<userId>/server_<psid>). The backup
 * directory is user-scoped, so this scans every user dir at most one level
 * deep (bounded) — the same convention routes/missionFiles.js uses.
 *
 * @param {string} backupRoot  data/backups
 * @param {string} platformServerId
 * @returns {string[]} absolute backup dirs (possibly empty)
 */
function scanBackupDirs(backupRoot, platformServerId) {
  const out = [];
  let userDirs;
  try {
    userDirs = fs.readdirSync(backupRoot, { withFileTypes: true });
  } catch (_error) {
    return out;
  }
  const suffix = `server_${platformServerId}`;
  for (const entry of userDirs) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(backupRoot, entry.name, suffix);
    try {
      if (fs.statSync(candidate).isDirectory()) out.push(candidate);
    } catch (_error) { /* no backup dir for this user */ }
  }
  return out;
}

/**
 * Merge listBackups() results across every user's backup dir for a server
 * (edits by different users all count as config edits). Entries are merged
 * per file, sorted newest first, deduped by (file, timestamp).
 */
function collectBackupGroups(backupRoot, platformServerId) {
  const dirs = scanBackupDirs(backupRoot, platformServerId);
  const groups = {};
  const seen = new Set();
  let allFiles = [];
  for (const dir of dirs) {
    const parsed = listBackupsAt(dir);
    allFiles = allFiles.concat(parsed._allFiles || []);
    for (const [fileName, entries] of Object.entries(parsed)) {
      if (fileName === '_allFiles') continue;
      if (!groups[fileName]) groups[fileName] = [];
      for (const entry of entries) {
        const key = `${fileName}:${entry.timestampMs}`;
        if (seen.has(key)) continue;
        seen.add(key);
        groups[fileName].push(entry);
      }
    }
  }
  for (const key of Object.keys(groups)) groups[key].sort((a, b) => b.timestampMs - a.timestampMs);
  return { ...groups, _allFiles: allFiles };
}

function listBackupsAt(dir) {
  const out = {};
  let allFiles = [];
  try {
    allFiles = fs.readdirSync(dir).filter(f => /\.backup$/.test(f));
  } catch (_error) {
    return { _allFiles: [] };
  }
  for (const file of allFiles) {
    const m = file.match(/^(.*)\.(\d+)\.backup$/);
    if (!m) continue;
    const baseName = m[1];
    const ts = parseInt(m[2], 10);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (!out[baseName]) out[baseName] = [];
    out[baseName].push({ backupFile: file, timestampMs: ts, atMs: ts });
  }
  for (const key of Object.keys(out)) out[key].sort((a, b) => b.timestampMs - a.timestampMs);
  return { ...out, _allFiles: allFiles };
}

/**
 * List the backup files for a server (the mission-files backup convention):
 *   data/backups/<userId>/server_<platformServerId>/<sanitized>.<ts>.backup
 * Returns them grouped by file, newest first.
 *
 * @param {string} backupRoot  data/backups
 * @param {string} userId
 * @param {string} platformServerId
 * @returns {{[fileName]: Array<{backupFile, timestampMs, atMs}>, _allFiles}}
 */
function listBackups(backupRoot, userId, platformServerId) {
  return listBackupsAt(path.join(backupRoot, userId, `server_${platformServerId}`));
}

/**
 * Rollback advisor: for each config file with >= 2 backups, compare the
 * server tick metrics in the window BEFORE vs. AFTER each backup (edit).
 *
 * "Before" window: the 2h up to the backup timestamp.
 * "After"  window: the 2h after the backup timestamp.
 *
 * The CE Loop telemetry (rpt_telemetry_events) is the metric source. If there
 * are no telemetry rows in either window for that time, the edit is skipped
 * (not enough data). The advisor reports the file, the edit time, before/after
 * tick stats, and a `degraded` flag when the after-window average tick is
 * >= 20% slower than the before-window (or crash windows appeared after but
 * not before).
 *
 * @param {object} db           db abstraction (async query)
 * @param {number} serverId     internal servers.id
 * @param {object} backupGroups listBackups() result for this server
 * @param {object} [options]
 * @param {number} [options.windowHours]   window size (default 2h)
 * @param {number} [options.maxBackups]   max backups per file to analyze (default 8)
 * @returns {Promise<Array>}  advisor results, one per file
 */
async function adviseRollbacks(db, serverId, backupGroups, { windowHours = 2, maxBackups = 8 } = {}) {
  const results = [];
  for (const [fileName, backups] of Object.entries(backupGroups)) {
    if (fileName === '_allFiles') continue;
    if (!Array.isArray(backups) || backups.length < 2) continue;

    const recentBackups = backups.slice(0, maxBackups).reverse(); // oldest first
    const edits = [];
    for (const backup of recentBackups) {
      const beforeStart = backup.atMs - windowHours * 3600 * 1000;
      const beforeEnd = backup.atMs;
      const afterStart = backup.atMs;
      const afterEnd = backup.atMs + windowHours * 3600 * 1000;

      const [before, after] = await Promise.all([
        ceLoopWindow(db, serverId, beforeStart, beforeEnd),
        ceLoopWindow(db, serverId, afterStart, afterEnd),
      ]);

      // Skip edits with too little data on either side.
      if (before.samples < 20 || after.samples < 20) continue;

      const deltaPct = before.avg > 0
        ? ((after.avg - before.avg) / before.avg) * 100
        : null;
      const crashesBefore = await crashWindowStats(db, serverId, beforeStart, beforeEnd);
      const crashesAfter = await crashWindowStats(db, serverId, afterStart, afterEnd);
      const crashRegression = crashesAfter.length > 0 && crashesBefore.length === 0;
      const degraded = (deltaPct !== null && deltaPct >= 20) || crashRegression;
      const improved = deltaPct !== null && deltaPct <= -20 && !crashRegression;

      edits.push({
        backupFile: backup.backupFile,
        atMs: backup.atMs,
        at: new Date(backup.atMs).toISOString(),
        before: { samples: before.samples, avgSeconds: round2(before.avg), maxSeconds: round2(before.max), slowTicks: before.slow },
        after:  { samples: after.samples,  avgSeconds: round2(after.avg),  maxSeconds: round2(after.max),  slowTicks: after.slow },
        deltaPct: deltaPct !== null ? Math.round(deltaPct * 10) / 10 : null,
        degraded,
        improved,
      });
    }
    if (edits.length) {
      results.push({
        fileName,
        totalBackups: backups.length,
        editsAnalyzed: edits.length,
        edits,
        worstEdit: edits.reduce((worst, e) => {
          if (worst === null) return e;
          // A degraded edit (crash regression included) always outranks a
          // higher non-degrading tick delta: the dashboard headline reads
          // worstEdit.degraded and must not miss a flagged edit.
          if (e.degraded !== worst.degraded) return e.degraded ? e : worst;
          const rank = ed => ed.deltaPct ?? -Infinity;
          return rank(e) > rank(worst) ? e : worst;
        }, null),
      });
    }
  }
  // Rank: degraded edits first, then by severity of degradation.
  results.sort((a, b) => {
    const aDeg = a.worstEdit?.degraded ? 1 : 0;
    const bDeg = b.worstEdit?.degraded ? 1 : 0;
    if (aDeg !== bDeg) return bDeg - aDeg;
    const aDelta = a.worstEdit?.deltaPct ?? -Infinity;
    const bDelta = b.worstEdit?.deltaPct ?? -Infinity;
    return bDelta - aDelta;
  });
  return results;
}

/**
 * CE Loop stats for a time window from rpt_telemetry_events.
 * Returns { samples, avg, max, slow } where slow = count of ticks >= 2s.
 */
async function ceLoopWindow(db, serverId, fromMs, toMs) {
  try {
    const rows = await db.query(
      `SELECT COUNT(*)::int AS samples,
              AVG((payload->>'durationSeconds')::double precision) AS avg_seconds,
              MAX((payload->>'durationSeconds')::double precision) AS max_seconds,
              COUNT(*) FILTER (WHERE (payload->>'durationSeconds')::double precision >= 2)::int AS slow
       FROM rpt_telemetry_events
       WHERE server_id = $1 AND event_type = 'dayz.ce.loop' AND deleted_at IS NULL
         AND observed_at >= $2::timestamptz AND observed_at <= $3::timestamptz`,
      [serverId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()]
    );
    const row = rows && rows[0];
    if (!row) return { samples: 0, avg: 0, max: 0, slow: 0 };
    return {
      samples: Number(row.samples || 0),
      avg: Number(row.avg_seconds || 0),
      max: Number(row.max_seconds || 0),
      slow: Number(row.slow || 0),
    };
  } catch (_error) {
    return { samples: 0, avg: 0, max: 0, slow: 0 };
  }
}

/**
 * Fatal crash-window count + end-times for a time window, from the ingested
 * telemetry (the same rpt_telemetry_events source ceLoopWindow uses). Used by
 * the rollback advisor: a crash appearing after an edit (and not before) is
 * degradation evidence even when the tick averages look similar.
 */
async function crashWindowStats(db, serverId, fromMs, toMs) {
  try {
    const rows = await db.query(
      `SELECT observed_at FROM rpt_telemetry_events
       WHERE server_id = $1 AND event_type = 'dayz.crash' AND deleted_at IS NULL
         AND observed_at >= $2::timestamptz AND observed_at <= $3::timestamptz
       ORDER BY observed_at`,
      [serverId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()]
    );
    return (rows || []).map(r => r.observed_at ? new Date(r.observed_at).getTime() : null).filter(Boolean);
  } catch (_error) {
    return [];
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function round2(n) { return Math.round((n || 0) * 100) / 100; }

function safeParseJson(text) {
  try { return JSON.parse(text); } catch (_error) { return null; }
}

module.exports = {
  CRASH_PRECURSORS,
  WARNING_WINDOW_MS,
  PRECURSOR_LOOKBACK_MS,
  // 1. Predictive
  detectPredictiveWarnings,
  persistWarnings,
  warningSummary,
  // 2. Lag remediation
  analyzeLagCauses,
  planLagSuggestions,
  // 3. Rollback advisor
  listBackups,
  collectBackupGroups,
  scanBackupDirs,
  adviseRollbacks,
  ceLoopWindow,
};
