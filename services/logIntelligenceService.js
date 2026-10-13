/**
 * logIntelligenceService.js
 *
 * AI-powered log intelligence for ingested RPT / ADM / server.log data.
 *
 * Three capabilities (all exact-server scoped, gated upstream by
 * ensureAiServerManage -> per-server SERVER_MANAGE):
 *
 *   1. RPT error summarizer      — cluster exceptions/warnings per crash or
 *                                  restart window and rank root-cause
 *                                  candidates.
 *   2. "Why did it crash/lag at X" — correlate RPT timestamps with ADM tick
 *                                  data (CE Loop telemetry, sessions, deaths)
 *                                  around a moment in time.
 *   3. Config-drift / warning     — recurring RPT warnings mapped to a
 *                                  data-driven known DayZ issues table.
 *
 * Determinism + grounding: every analysis is first computed from the real
 * ingested files / DB rows. The LLM (when a provider is available) is only
 * ever given a compact digest of that computed data plus a bounded excerpt of
 * the actual raw lines, and is instructed to cite only what it is given — so
 * the answer is grounded, not a hallucination. When no provider is
 * configured the caller still receives the full deterministic structure.
 *
 * The known-issue table is data-driven: it ships as an embedded seed and is
 * overlaid by `data/dayz-rpt-issues.json` when present on the box, so the
 * operator can grow it without a code change.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { listContainedDirectorySync, openContainedFileSync } = require('../utils/safePath');
const { isSupportedRptFilename, logStartTimeMs } = require('../utils/logFileChronology');

// How much of a (potentially huge) RPT file to read from the tail when
// extracting signals. Mirrors the log-scanner's 20MB working window so we
// always capture the most recent events without exhausting the heap.
const MAX_RPT_SCAN_BYTES = 20 * 1024 * 1024;
const MAX_CRASH_SCAN_BYTES = 256 * 1024;
const MAX_RAW_EXCERPT_LINES = 400;
const MAX_AI_DIGEST_CHARS = 24000;

// ─── Known DayZ issues table (data-driven) ──────────────────────────────────
// Each entry: { id, patterns[], severity, title, cause, fix, actionable }
//   severity: 'fatal' | 'warning' | 'info'
//   actionable: true when the warning usually reflects a real server-side
//               problem an owner should act on (vs. a benign engine warning).
// `patterns` are case-insensitive substring or RegExp tests, first match wins
// in array order.
const SEED_DAYZ_ISSUES = [
  {
    id: 'ce-loop-slow',
    patterns: [/CE Loop took\s+([\d.]+)\s*\(sec\)/i],
    severity: 'warning',
    title: 'Server tick (CE Loop) exceeded budget',
    cause: 'A single server tick took too long — the most common cause of lag spikes. Usually a burst of player/loot/infected entities in one area or a mod system doing heavy work each tick.',
    fix: 'Check the players/loot/infected counts on the same line. Look for a large gathering (looting event, horde) or a mod that scans the world every tick; consider capping concurrent entities or optimizing the offending mod.',
    actionable: true,
    dynamic: (m) => ({ durationSeconds: Number(m[1]) }),
  },
  {
    id: 'null-pointer-script',
    patterns: [/NULL pointer to instance/i],
    severity: 'warning',
    title: 'Script NULL-pointer reference',
    cause: 'A (mod) script dereferenced a null object. Benign when logged under VMErrorMode=log_only, but recurring NULL pointers from the same function can be the precursor to a hard crash.',
    fix: 'Correlate the Class/Function and stack trace below the line with a mod; if it repeats and a crash follows, update or remove the mod that owns that class.',
    actionable: true,
  },
  {
    id: 'inventory-no-item',
    patterns: [/No item in hands/i],
    severity: 'info',
    title: 'Inventory: no item in hands (HumanInventory)',
    cause: 'A script tried to replace a held item that was null. Common with inventory/torch mods; logged as an engine Error but does not stop the server.',
    fix: 'Usually safe to ignore. If it spikes together with a crash, check the inventory/torch mod version.',
    actionable: false,
  },
  {
    id: 'weapon-chamber-error',
    patterns: [/cannot load chamber/i, /chamberFromAttachedMagazine/i],
    severity: 'info',
    title: 'Weapon chamber could not be loaded (wpnfsm)',
    cause: 'A weapon finite-state-machine could not load its chamber from the attached magazine. Harmless engine noise for most weapons; can point to a broken weapon mod.',
    fix: 'If limited to one weapon class, the weapon mod may have a bad chamber definition. Otherwise safe to ignore.',
    actionable: false,
  },
  {
    id: 'access-error-value',
    patterns: [/Trying to access error value/i],
    severity: 'info',
    title: 'Script accessed an error value',
    cause: 'A mod read an undefined/error return value. The engine warns but continues. High volume is normal on busy servers.',
    fix: 'Benign. Track only if a specific mod starts emitting it right before a crash.',
    actionable: false,
  },
  {
    id: 'localization-missing',
    patterns: [/Localization not present/i, /listed twice in/i],
    severity: 'info',
    title: 'Missing / duplicated localization string',
    cause: 'A locale string is absent or defined twice. Purely cosmetic; emitted at every server start.',
    fix: 'Safe to ignore, or fix by correcting the localization override in the mod/config.',
    actionable: false,
  },
  {
    id: 'spawn-failed',
    patterns: [/(failed|Failed) to spawn/i],
    severity: 'warning',
    title: 'Object spawn failed',
    cause: 'The engine could not place a loot/vehicle/infected object — often a missing asset, a mod item class, or a full/invalid spawn position. Recurring spawn failures can degrade world content.',
    fix: 'Look at the object name on the same line. If a specific mod item fails repeatedly, the class/asset is missing — update the mod or remove the spawn placement.',
    actionable: true,
  },
  {
    id: 'animation-missing',
    patterns: [/Animation source .* not found in bin/i],
    severity: 'info',
    title: 'Animation source missing from bin',
    cause: 'An animation referenced by an item/weapon has no matching entry in the bin. Cosmetic only.',
    fix: 'Safe to ignore, or add the animation to the mod.',
    actionable: false,
  },
  {
    id: 'bad-vehicle-type',
    patterns: [/Bad vehicle type/i],
    severity: 'info',
    title: 'Bad vehicle type in config',
    cause: 'A vehicle class in a mod does not match an expected vehicle type. Cosmetic; the vehicle still spawns.',
    fix: 'Safe to ignore, or correct the vehicle class in the mod.',
    actionable: false,
  },
  {
    id: 'cannot-open-object',
    patterns: [/Cannot open object/i, /Failed to open/i, /Failed to read/i],
    severity: 'info',
    title: 'Asset / texture failed to open',
    cause: 'A texture, model, or config object could not be opened. Usually a missing asset; cosmetic on most servers.',
    fix: 'Safe to ignore unless the missing asset is a core one you need.',
    actionable: false,
  },
  {
    id: 'cfg-actionsound-missing',
    patterns: [/unable to load .* from CfgActionSounds/i],
    severity: 'info',
    title: 'Missing CfgActionSounds entry',
    cause: 'A door/weapon action sound has no CfgActionSounds entry. Cosmetic.',
    fix: 'Safe to ignore, or add the sound entry.',
    actionable: false,
  },
  {
    id: 'oom-crash',
    patterns: [/out of memory/i, /OutOfMemory/i, /segmentation fault/i, /access violation/i],
    severity: 'fatal',
    title: 'Out-of-memory / segmentation fault',
    cause: 'The server process ran out of memory or hit a fault and will stop. This is a fatal, root-cause-level failure.',
    fix: 'Increase the server memory allocation, cap concurrent entities, and look for a mod leak. Correlate with the largest CE Loop / entity counts just before the crash.',
    actionable: true,
  },
  {
    id: 'fatal-exception',
    patterns: [/^Exception:/i, /FATAL/i, /ASSERT/i, /Failed to start the server/i, /Server failed to start/i],
    severity: 'fatal',
    title: 'Fatal exception / failed to start',
    cause: 'An unhandled exception or a failed startup. Treat as a top root-cause candidate.',
    fix: 'Read the full stack trace in the crash log. This is the most likely direct cause of a crash window.',
    actionable: true,
  },
];

/**
 * Load the effective known-issue table: embedded seed overlaid by an
 * operator-provided `data/dayz-rpt-issues.json` (adds/replaces by id). The
 * override file is optional and lives outside git (data/ is gitignored) so the
 * table can grow per deployment without shipping a code change.
 */
function loadKnownIssues(overridePath = path.join(__dirname, '..', 'data', 'dayz-rpt-issues.json')) {
  const table = SEED_DAYZ_ISSUES.map(issue => ({ ...issue, patterns: issue.patterns.map(p => p instanceof RegExp ? p : new RegExp(p, 'i')) }));
  let override = [];
  try {
    if (overridePath && fs.existsSync(overridePath)) {
      const parsed = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
      override = Array.isArray(parsed) ? parsed : parsed.issues || [];
    }
  } catch (_error) {
    override = []; // a malformed override must never break log analysis
  }
  const byId = new Map(table.map(issue => [issue.id, issue]));
  for (const entry of override) {
    if (!entry || typeof entry.id !== 'string') continue;
    const patterns = Array.isArray(entry.patterns)
      ? entry.patterns.map(p => (typeof p === 'string' ? new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : p))
      : [];
    byId.set(entry.id, { ...entry, patterns });
  }
  return Array.from(byId.values());
}

// ─── Signal extraction ───────────────────────────────────────────────────────

// Timestamp at the start of an RPT line: " 4:28:21.624" or "11:07:06.670".
const RPT_LINE_TIME = /^\s*(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)/;
const CE_LOOP_LINE = /\*\*\*\s*CE Loop took\s+([\d.]+)\s*\(sec\)/i;
const CE_COUNTS_LINE = /players:\s*(\d+),\s*loot:\s*(\d+),\s*infected:\s*(\d+),\s*animals:\s*(\d+)/i;
const SHUTDOWN_LINE = /\[Shutdown\]\s+Shutting down in\s+([\d]+)\s+seconds/i;
const CRASH_BLOCK_TIME = /(\d{1,2}\.\d{2})\s+\d{4}\s+(\d{2}):(\d{2}):(\d{2})/;
const CRASH_DIVIDER = /^-+\s*$/;

function extractTimeMs(line, logDate, chronology) {
  const match = line.match(RPT_LINE_TIME);
  if (!match) return null;
  const dateMatch = String(logDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return null;
  const base = Date.parse(`${logDate}T00:00:00.000Z`);
  if (!Number.isFinite(base)) return null;
  const [, h, m, s, frac = ''] = match[1].match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  const hour = Number(h), minute = Number(m), second = Number(s);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const ms = Number((frac || '').padEnd(3, '0').slice(0, 3));
  let ts = base + (hour * 3600 + minute * 60 + second) * 1000 + ms;
  // Rollover: if this timestamp is far behind the previous line, we crossed
  // midnight (same logic as utils/rptChronology, self-contained here).
  if (chronology.previousMs !== null && ts + 12 * 3600 * 1000 < chronology.previousMs) {
    chronology.dayOffset += 1;
    ts += 86400000;
  }
  chronology.previousMs = ts;
  return ts;
}

/**
 * Extract the signals we care about from already-read RPT/crash text.
 * Returns { warnings, ceLoops, shutdowns, firstMs, lastMs } where `warnings`
 * are individual matched known-issue rows (for clustering/drift) and
 * `ceLoops` are timed tick-spike samples.
 */
function extractSignals(lines, issues, logDate = null) {
  const chronology = { dayOffset: 0, previousMs: null };
  const warnings = [];
  const ceLoops = [];
  const shutdowns = [];
  let firstMs = null;
  let lastMs = null;

  // The `players: N, loot: N, infected: N, animals: N` line that DayZ emits as
  // part of a CE Loop tick is normally on the line *after* the CE Loop line
  // (see routes/logParser and the rpt-telemetry tests), though some builds put
  // it inline. Look ahead up to 3 lines for the counts belonging to a tick.
  function nearestCounts(afterIdx) {
    for (let j = afterIdx + 1; j < lines.length && j <= afterIdx + 3; j++) {
      const m = String(lines[j]).match(CE_COUNTS_LINE);
      if (m) return m;
    }
    return null;
  }

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = String(raw).replace(/\r$/, '');
    if (!line.trim()) continue;
    const ts = extractTimeMs(line, logDate, chronology);
    if (ts !== null) {
      if (firstMs === null) firstMs = ts;
      lastMs = ts;
    }

    const loop = line.match(CE_LOOP_LINE);
    if (loop && ts !== null) {
      const durationSeconds = Number(loop[1]);
      if (Number.isFinite(durationSeconds)) {
        const counts = line.match(CE_COUNTS_LINE) || nearestCounts(li);
        ceLoops.push({
          atMs: ts,
          durationSeconds,
          players: counts ? Number(counts[1]) : null,
          loot: counts ? Number(counts[2]) : null,
          infected: counts ? Number(counts[3]) : null,
          animals: counts ? Number(counts[4]) : null,
        });
      }
    }

    const down = line.match(SHUTDOWN_LINE);
    if (down && ts !== null) {
      shutdowns.push({ atMs: ts, remainingSeconds: Number(down[1]) });
    }

    for (const issue of issues) {
      const pattern = issue.patterns[0];
      if (!pattern) continue;
      const m = pattern.exec(line);
      if (m) {
        warnings.push({
          issueId: issue.id,
          severity: issue.severity,
          title: issue.title,
          actionable: Boolean(issue.actionable),
          sample: line.length > 240 ? `${line.slice(0, 240)}…` : line,
          atMs: ts,
          dynamic: issue.dynamic ? issue.dynamic(m) : null,
        });
        break; // first matching issue wins
      }
    }
  }

  return { warnings, ceLoops, shutdowns, firstMs, lastMs };
}

// ─── File discovery + bounded reading (dependency-injectable) ───────────────

function findLogFiles(listFiles, dir) {
  let entries;
  try {
    entries = listFiles(dir);
  } catch (_error) {
    return { rpt: [], crash: [], serverLog: null };
  }
  const rpt = [];
  const crash = [];
  let serverLog = null;
  for (const entry of entries) {
    const name = entry.name || (typeof entry === 'string' ? entry : '');
    if (!name) continue;
    if (name.toLowerCase() === 'server.log') serverLog = name;
    else if (isSupportedRptFilename(name)) rpt.push(name);
    else if (/^crash_.*\.log$/i.test(name)) crash.push(name);
  }
  const byStart = (a, b) => (logStartTimeMs(a) ?? 0) - (logStartTimeMs(b) ?? 0) || a.localeCompare(b);
  return { rpt: rpt.sort(byStart), crash: crash.sort(byStart), serverLog };
}

/**
 * Read up to the last `maxBytes` of a file inside `rootDir`, always returning
 * complete lines (discards the partial leading line). The `reader` is
 * dependency-injected (defaults to openContainedFileSync) so tests can supply
 * in-memory files without touching the real filesystem.
 */
function tailLinesSimple(reader, rootDir, filename, maxBytes) {
  const opened = reader(rootDir, filename);
  const { fd, stat } = opened;
  try {
    if (stat.size === 0) return [];
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    let position = 0;
    while (position < length) {
      const bytesRead = fs.readSync(fd, buffer, position, length - position, stat.size - length + position);
      if (bytesRead === 0) break;
      position += bytesRead;
    }
    let text = buffer.subarray(0, position).toString('utf8');
    if (stat.size > maxBytes) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1); // drop partial leading line
    }
    return text.split('\n');
  } finally {
    fs.closeSync(fd);
  }
}

function logDateFromRptFilename(filename, fallback) {
  const startMs = logStartTimeMs(filename);
  if (startMs !== null) return new Date(startMs).toISOString().slice(0, 10);
  return fallback || new Date().toISOString().slice(0, 10);
}

// ─── Clustering ──────────────────────────────────────────────────────────────

/**
 * Cluster extracted warnings into repeated offenders, and compute crash /
 * restart windows with ranked root-cause candidates.
 */
function clusterWarnings(warnings) {
  const byIssue = new Map();
  for (const w of warnings) {
    const key = w.issueId;
    if (!byIssue.has(key)) {
      byIssue.set(key, {
        issueId: w.issueId,
        severity: w.severity,
        title: w.title,
        actionable: w.actionable,
        count: 0,
        firstAt: null,
        lastAt: null,
        samples: [],
      });
    }
    const bucket = byIssue.get(key);
    bucket.count += 1;
    if (bucket.firstAt === null || (w.atMs && w.atMs < bucket.firstAt)) bucket.firstAt = w.atMs;
    if (w.atMs && w.atMs > (bucket.lastAt ?? 0)) bucket.lastAt = w.atMs;
    if (bucket.samples.length < 3 && w.sample) bucket.samples.push(w.sample);
  }
  const list = Array.from(byIssue.values());
  // Rank: actionable + high severity + high frequency first.
  const rank = { fatal: 3, warning: 2, info: 1 };
  return list.sort((a, b) =>
    (Number(b.actionable) - Number(a.actionable)) ||
    ((rank[b.severity] || 0) - (rank[a.severity] || 0)) ||
    (b.count - a.count));
}

/**
 * Build crash / restart windows. A window is a span ending at a fatal signal
 * or a shutdown; root-cause candidates are the fatal + warning signals that
 * appear in the ~10 minutes before the window end, ranked by recency.
 */
function buildCrashWindows(warnings, shutdowns, { windowMs = 10 * 60 * 1000 } = {}) {
  const ends = [];
  for (const w of warnings) if (w.severity === 'fatal' && w.atMs) ends.push({ atMs: w.atMs, kind: 'fatal', signal: w });
  for (const s of shutdowns) ends.push({ atMs: s.atMs, kind: 'restart', signal: { sample: `[Shutdown] ${s.remainingSeconds}s`, title: 'Scheduled shutdown' } });
  if (ends.length === 0) return [];
  ends.sort((a, b) => a.atMs - b.atMs);

  const windows = [];
  let cursor = 0;
  for (const end of ends) {
    if (cursor > 0 && end.atMs - ends[cursor - 1].atMs < windowMs) continue; // coalesce near-duplicates
    cursor += 1;
    const since = end.atMs - windowMs;
    const candidates = warnings
      .filter(w => w.atMs !== null && w.atMs <= end.atMs && w.atMs >= since)
      .filter(w => w.severity !== 'info' || w.actionable)
      .sort((a, b) => b.atMs - a.atMs)
      .slice(0, 8)
      .map(w => ({
        issueId: w.issueId,
        title: w.title,
        severity: w.severity,
        at: w.atMs,
        sample: w.sample,
      }));
    windows.push({
      endsAt: end.atMs,
      kind: end.kind,
      candidateCount: candidates.length,
      rootCauseCandidates: candidates,
    });
  }
  return windows.slice(-10); // most recent windows
}

// ─── Digest builders (compact, bounded, grounded) ───────────────────────────

function iso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

/**
 * Deterministic summary of a server's ingested RPT/crash data. No AI.
 *
 * @param {object} deps
 * @param {function} deps.listFiles (dir) => entries
 * @param {function} deps.readTail (rootDir, filename, maxBytes) => lines[]
 * @param {string}   deps.configDir absolute path to .../config
 * @param {string[]} [deps.rptFiles] restrict to specific RPT files
 * @param {object}   [deps.issues]  known-issue table
 */
function summarizeRptErrors({ listFiles, readTail, configDir, rptFiles, issues = loadKnownIssues() } = {}) {
  if (!configDir) throw new Error('configDir is required');
  const discovered = findLogFiles(listFiles, configDir);
  const files = (rptFiles && rptFiles.length) ? rptFiles : discovered.rpt.slice(-3);
  const warnings = [];
  const ceLoops = [];
  const shutdowns = [];
  const perFile = [];

  for (const file of files) {
    const lines = readTail(configDir, file, MAX_RPT_SCAN_BYTES);
    const signals = extractSignals(lines, issues, logDateFromRptFilename(file));
    warnings.push(...signals.warnings);
    ceLoops.push(...signals.ceLoops);
    shutdowns.push(...signals.shutdowns);
    perFile.push({
      file,
      lines: lines.length,
      warnings: signals.warnings.length,
      ceLoopSamples: signals.ceLoops.length,
      shutdowns: signals.shutdowns.length,
      firstAt: iso(signals.firstMs),
      lastAt: iso(signals.lastMs),
    });
  }

  // Crash-log signals (fatal root causes).
  for (const file of discovered.crash.slice(-3)) {
    try {
      const crashLines = readTail(configDir, file, MAX_CRASH_SCAN_BYTES);
      const crashSignals = extractSignals(crashLines, issues, null);
      for (const w of crashSignals.warnings) { w.sourceFile = file; warnings.push(w); }
      for (const line of crashLines) {
        if (w_lineIsFatal(line, issues)) {
          warnings.push({
            issueId: 'fatal-exception', severity: 'fatal', title: 'Fatal exception / failed to start',
            actionable: true, sample: truncate(line, 240), atMs: crashTimeMs(line, file), sourceFile: file, dynamic: null,
          });
        }
      }
    } catch (_error) { /* unreadable crash file is non-fatal */ }
  }

  const offenders = clusterWarnings(warnings);
  const crashWindows = buildCrashWindows(warnings, shutdowns);
  const ceStats = ceLoopStats(ceLoops);

  return {
    server: configDir,
    filesScanned: perFile,
    totalWarnings: warnings.length,
    repeatedOffenders: offenders,
    crashWindows,
    ceLoop: ceStats,
  };
}

function w_lineIsFatal(line, issues) {
  const text = String(line || '').trim();
  if (!text) return false;
  for (const issue of issues) {
    if (issue.severity !== 'fatal') continue;
    if (issue.patterns[0] && issue.patterns[0].test(text)) return true;
  }
  return false;
}

function crashTimeMs(line, file) {
  const m = String(line || '').match(CRASH_BLOCK_TIME);
  if (m) {
    const [, moDay, hh, mm, ss] = m;
    const [mo, day] = String(moDay).split('.').map(Number);
    const date = logDateFromRptFilename(file);
    const base = Date.parse(`${date}T00:00:00.000Z`);
    if (Number.isFinite(base) && mo >= 1 && mo <= 12) {
      return base + ((day - 1) * 86400000) + ((Number(hh) * 3600 + Number(mm) * 60 + Number(ss)) * 1000);
    }
  }
  const startMs = logStartTimeMs(file);
  return startMs;
}

function ceLoopStats(ceLoops) {
  if (ceLoops.length === 0) return null;
  const durations = ceLoops.map(l => l.durationSeconds).filter(d => Number.isFinite(d));
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const max = Math.max(...durations);
  const slow = ceLoops.filter(l => l.durationSeconds >= 2);
  return {
    samples: ceLoops.length,
    avgSeconds: Math.round(avg * 100) / 100,
    maxSeconds: Math.round(max * 100) / 100,
    slowSamples: slow.length,
    slowest: slow.slice().sort((a, b) => b.durationSeconds - a.durationSeconds).slice(0, 5)
      .map(l => ({ at: iso(l.atMs), durationSeconds: l.durationSeconds, players: l.players, loot: l.loot, infected: l.infected })),
  };
}

function truncate(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ─── Grounded AI digest + provider call ─────────────────────────────────────

/**
 * Build a compact, bounded digest of the deterministic analysis that we feed
 * to the LLM. This is the grounding guarantee: the model only ever sees the
 * computed clusters + a bounded raw excerpt, never the raw multi-MB file.
 */
function buildAiDigest(summary, { maxChars = MAX_AI_DIGEST_CHARS } = {}) {
  const parts = [];
  parts.push(`Files scanned: ${summary.filesScanned.map(f => `${f.file} (${f.lines} lines, ${f.warnings} warnings)`).join(', ') || 'none'}`);
  if (summary.ceLoop) {
    parts.push(`CE Loop (server tick): ${summary.ceLoop.samples} samples, avg ${summary.ceLoop.avgSeconds}s, max ${summary.ceLoop.maxSeconds}s, ${summary.ceLoop.slowSamples} slow (>=2s).`);
    if (summary.ceLoop.slowest.length) {
      parts.push(`Slowest ticks: ${summary.ceLoop.slowest.map(s => `${s.at} ${s.durationSeconds}s (players=${s.players}, loot=${s.loot}, infected=${s.infected})`).join('; ')}`);
    }
  }
  parts.push('Repeated warnings/offenders (ranked):');
  for (const o of summary.repeatedOffenders.slice(0, 12)) {
    parts.push(`- [${o.severity}${o.actionable ? ', actionable' : ''}] ${o.title}: ${o.count} occurrence(s)${o.firstAt ? ` since ${new Date(o.firstAt).toISOString()}` : ''}`);
    for (const s of o.samples.slice(0, 2)) parts.push(`    e.g. ${s}`);
  }
  if (summary.crashWindows.length) {
    parts.push('Crash/restart windows (root-cause candidates, most recent last):');
    for (const w of summary.crashWindows.slice(-5)) {
      parts.push(`- ${iso(w.endsAt)} (${w.kind}): ${w.rootCauseCandidates.map(c => c.title).join(', ') || 'no candidates'}`);
    }
  }
  let digest = parts.join('\n');
  if (digest.length > maxChars) digest = `${digest.slice(0, maxChars)}\n[truncated]`;
  return digest;
}

const GROUNDED_SYSTEM = [
  'You are a DayZ server log analyst.',
  'You are given a grounded digest of REAL ingested RPT/crash data for one server.',
  'Answer ONLY from the data you are given. Cite the specific warnings, CE Loop numbers, or timestamps that support each claim.',
  'If the data does not answer the question, say so explicitly — do NOT invent causes.',
  'Keep the answer short, concrete, and actionable for the server owner.',
].join('\n');

/**
 * Optional grounded AI prose on top of a deterministic summary.
 * @param {object}  provider  resolved provider descriptor (may carry `transport` for tests)
 * @param {string}  question  the user's question (e.g. "why did it lag at 14:00?")
 * @param {object}  summary   the deterministic summary
 * @param {object}  [rawExcerpt] bounded raw lines (optional extra grounding)
 */
async function explainWithAi(provider, question, summary, rawExcerpt = null, { maxOutputTokens } = {}) {
  const userText = [
    'Grounded log digest for this server (real ingested data):',
    buildAiDigest(summary),
    rawExcerpt ? `\nRelevant raw log lines:\n${rawExcerpt.slice(0, MAX_RAW_EXCERPT_LINES).join('\n')}` : '',
    ``,
    `Question: ${question}`,
  ].filter(Boolean).join('\n');

  const messages = [
    { role: 'system', content: GROUNDED_SYSTEM },
    { role: 'user', content: userText },
  ];
  const ai = require('./aiService');
  return ai.callProvider(messages, 0.2, {
    ...provider,
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  });
}

// ─── "Why at X" — RPT/ADM correlation ───────────────────────────────────────

/**
 * Assemble grounded evidence around a moment in time for a "why did it
 * crash / lag at X" question. Pulls ADM-side tick telemetry from the DB and
 * RPT-side warnings/ticks from the files. Pure + injectable.
 *
 * @param {object} deps
 * @param {function} deps.listFiles
 * @param {function} deps.readTail
 * @param {string}   deps.configDir
 * @param {object}   [deps.db]        db abstraction (query) for tick/session rows
 * @param {number}   [deps.serverId]  internal servers.id
 * @param {number}   atMs             the moment under investigation
 * @param {string}   [deps.issues]
 */
function whyAtMoment({ listFiles, readTail, configDir, db, serverId, atMs, issues = loadKnownIssues() } = {}) {
  const discovered = findLogFiles(listFiles, configDir);
  const since = atMs - 30 * 60 * 1000;
  const until = atMs + 5 * 60 * 1000;

  // Pick the RPT generation(s) that actually straddle the moment: the newest
  // file that started on/before the moment, plus the following one (a crash may
  // straddle a restart). This is the file we scan, not just "the latest 4".
  const candidates = [];
  let best = null;
  for (const file of discovered.rpt) {
    const start = logStartTimeMs(file);
    if (start === null) continue;
    if (start <= atMs && (best === null || start > best.start)) best = { file, start };
  }
  if (best) candidates.push(best.file);
  const nextIdx = discovered.rpt.indexOf(best.file);
  if (nextIdx >= 0 && nextIdx + 1 < discovered.rpt.length) candidates.push(discovered.rpt[nextIdx + 1]);
  if (candidates.length === 0) candidates.push(...discovered.rpt.slice(-4)); // no timestamps: fall back to recent

  const warnings = [];
  const ceLoops = [];
  for (const file of candidates) {
    const lines = readTail(configDir, file, MAX_RPT_SCAN_BYTES);
    const signals = extractSignals(lines, issues, logDateFromRptFilename(file));
    for (const w of signals.warnings) if (w.atMs !== null && w.atMs >= since && w.atMs <= until) warnings.push(w);
    for (const c of signals.ceLoops) if (c.atMs >= since && c.atMs <= until) ceLoops.push(c);
  }
  // Crash logs: a crash_*.log accumulates every crash since it was created, so
  // the filename timestamp only marks the FIRST crash. Scan the recent crash
  // files and keep the individual crash blocks whose parsed block-time falls in
  // the investigation window.
  const crashSignals = [];
  for (const file of discovered.crash.slice(-3)) {
    try {
      const lines = readTail(configDir, file, MAX_CRASH_SCAN_BYTES);
      const blockTimes = [];
      let currentBlock = [];
      for (const line of lines) {
        if (line.trim() === '') {
          if (currentBlock.length) blockTimes.push({ time: crashTimeMs(currentBlock[0], file), lines: currentBlock });
          currentBlock = [];
          continue;
        }
        if (CRASH_DIVIDER.test(line.trim())) {
          if (currentBlock.length) blockTimes.push({ time: crashTimeMs(currentBlock[0], file), lines: currentBlock });
          currentBlock = [];
          continue;
        }
        currentBlock.push(line.trim());
      }
      if (currentBlock.length) blockTimes.push({ time: crashTimeMs(currentBlock[0], file), lines: currentBlock });
      const matching = blockTimes.filter(b => b.time !== null && b.time >= since && b.time <= until + 15 * 60 * 1000);
      if (matching.length) {
        crashSignals.push({ file, blocks: matching.slice(0, 5).map(b => b.lines.filter(l => l).slice(0, 12)) });
      }
    } catch (_error) { /* skip unreadable */ }
  }

  // ADM / DB side: tick telemetry (CE Loop) + session/death activity near atMs.
  const dbEvidence = [];
  if (db && serverId && typeof db.query === 'function') {
    dbEvidence.push({ source: 'rpt_telemetry_events(CE Loop)', rows: null, note: 'queried' });
  }

  const tickWindow = ceLoops
    .filter(c => c.durationSeconds >= 2)
    .sort((a, b) => b.durationSeconds - a.durationSeconds)
    .slice(0, 10)
    .map(c => ({ at: iso(c.atMs), durationSeconds: c.durationSeconds, players: c.players, loot: c.loot, infected: c.infected }));

  const offenders = clusterWarnings(warnings).slice(0, 8);
  const rootCauses = [];
  for (const o of offenders) {
    if (o.severity === 'info' && !o.actionable) continue;
    rootCauses.push({ issueId: o.issueId, title: o.title, severity: o.severity, count: o.count, evidence: o.samples[0] || null });
  }
  for (const c of crashSignals) {
    for (const block of c.blocks) {
      rootCauses.push({ issueId: 'crash-log', title: `Crash log ${c.file}`, severity: 'fatal', count: 1, evidence: block[0] || null });
    }
  }

  return {
    atMs: iso(atMs),
    window: { since: iso(since), until: iso(until) },
    tickWindow,
    tickSamples: ceLoops.length,
    warningsInWindow: warnings.length,
    topWarnings: offenders,
    rootCauseCandidates: rootCauses,
    crashLogs: crashSignals.map(c => ({ file: c.file, blocks: c.blocks })),
  };
}

async function enrichWhyWithDb(db, serverId, atMs) {
  if (!db || !serverId || typeof db.query !== 'function') return null;
  const sinceIso = new Date(atMs - 30 * 60 * 1000).toISOString();
  const untilIso = new Date(atMs + 5 * 60 * 1000).toISOString();
  const result = {};
  try {
    const ce = await db.query(
      `SELECT observed_at, payload FROM rpt_telemetry_events
       WHERE server_id = ? AND event_type = 'dayz.ce.loop' AND deleted_at IS NULL
         AND observed_at >= ? AND observed_at <= ?
       ORDER BY observed_at LIMIT 40`,
      [serverId, sinceIso, untilIso]
    );
    result.ceLoopRows = (ce || []).map(r => ({
      at: new Date(r.observed_at).toISOString(),
      payload: typeof r.payload === 'string' ? safeParse(r.payload) : r.payload,
    }));
  } catch (_error) { result.ceLoopRows = null; }
  try {
    const kills = await db.get(
      `SELECT COUNT(*) AS c FROM kill_events WHERE server_id = ? AND timestamp >= ? AND timestamp <= ?`,
      [serverId, sinceIso, untilIso]
    );
    result.killsInWindow = Number(kills?.c || 0);
  } catch (_error) { result.killsInWindow = null; }
  try {
    const deaths = await db.get(
      `SELECT COUNT(*) AS c FROM player_death_events WHERE server_id = ? AND timestamp >= ? AND timestamp <= ?`,
      [serverId, sinceIso, untilIso]
    );
    result.deathsInWindow = Number(deaths?.c || 0);
  } catch (_error) { result.deathsInWindow = null; }
  try {
    const sessions = await db.query(
      `SELECT login_at, logout_at FROM player_sessions
       WHERE server_id = ? AND (login_at >= ? OR logout_at >= ?)
         AND (login_at <= ? OR logout_at <= ?)
       ORDER BY login_at DESC LIMIT 20`,
      [serverId, sinceIso, sinceIso, untilIso, untilIso]
    );
    result.sessionChanges = (sessions || []).map(r => ({ loginAt: r.login_at ? new Date(r.login_at).toISOString() : null, logoutAt: r.logout_at ? new Date(r.logout_at).toISOString() : null }));
  } catch (_error) { result.sessionChanges = null; }
  return result;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch (_error) { return null; }
}

/**
 * Assemble the grounded "why" evidence and optionally add AI prose.
 */
async function analyzeMoment(deps, provider = null, question = 'Why did the server crash or lag at this time?') {
  const deterministic = whyAtMoment(deps);
  let dbEvidence = null;
  if (deps.db && deps.serverId) {
    dbEvidence = await enrichWhyWithDb(deps.db, deps.serverId, deps.atMs);
  }
  const merged = { ...deterministic, dbEvidence };
  let aiExplanation = null;
  if (provider) {
    const digestInput = {
      filesScanned: deterministic.crashLogs.map(c => ({ file: c.file, lines: c.blocks.length, warnings: 0 })),
      ceLoop: deterministic.tickWindow.length
        ? {
            samples: deterministic.tickSamples,
            avgSeconds: null,
            maxSeconds: deterministic.tickWindow.reduce((m, t) => Math.max(m, t.durationSeconds), 0),
            slowSamples: deterministic.tickWindow.length,
            slowest: deterministic.tickWindow.slice(0, 5).map(t => ({ at: t.at, durationSeconds: t.durationSeconds, players: t.players, loot: t.loot, infected: t.infected })),
          }
        : null,
      repeatedOffenders: deterministic.topWarnings,
      crashWindows: deterministic.rootCauseCandidates.length
        ? [{ endsAt: deps.atMs, kind: 'investigation', candidateCount: deterministic.rootCauseCandidates.length, rootCauseCandidates: deterministic.rootCauseCandidates }]
        : [],
    };
    try {
      aiExplanation = await explainWithAi(provider, question, digestInput, null);
    } catch (error) {
      // Deterministic result still stands; only the prose is unavailable.
      aiExplanation = null;
      merged.aiError = error && error.message ? error.message : 'AI explanation unavailable';
    }
  }
  return { ...merged, aiExplanation };
}

// Default dependency set wired to the real filesystem (used by routes).
function defaultDeps(configDir) {
  return {
    listFiles: (dir) => listContainedDirectorySync(dir),
    readTail: (rootDir, filename, maxBytes) => tailLinesSimple(
      (r, f) => openContainedFileSync(r, f),
      rootDir, filename, maxBytes,
    ),
    configDir,
  };
}

module.exports = {
  SEED_DAYZ_ISSUES,
  loadKnownIssues,
  extractSignals,
  clusterWarnings,
  buildCrashWindows,
  ceLoopStats,
  findLogFiles,
  summarizeRptErrors,
  buildAiDigest,
  explainWithAi,
  whyAtMoment,
  enrichWhyWithDb,
  analyzeMoment,
  defaultDeps,
  tailLinesSimple,
  logDateFromRptFilename,
  MAX_RPT_SCAN_BYTES,
};
