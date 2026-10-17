'use strict';

/*
 * Data-Driven Tuning (AI feature 3/7)
 *
 * Deterministic, data-grounded reports for four tuning areas, plus an
 * optional AI suggestion path that turns each report into patch-backed
 * config suggestions (reusing the aiConfigIntelligenceService
 * parse-and-materialize + aiConfigPatchService machinery, so every
 * suggestion is a validated xml-search-replace / json-merge patch).
 *
 *   1. loot      — join loot_despawn_events (log_date) with the spawn
 *                  nominal in types.xml → per-class spawn/despawn imbalance
 *                  ("5.56 despawns 3x more than spawned").
 *   2. weapons   — weekly weapon kill-share + dominance detection from
 *                  kill_events.
 *   3. deathzones— cluster kill_events by position → top hot death zones.
 *   4. economy   — item nominal/value drift over time (economy_snapshots
 *                  per run) → flag inflation creep.
 *
 * DESIGN SPLIT (matches feature 2's convention):
 *   - The deterministic report is ALWAYS computed and returned. It is
 *     pure SQL + local XML reading; no provider involved.
 *   - The suggestion path (body.suggest === true) is the only thing that
 *     calls a provider. When no provider is available the route still
 *     returns the full report and a null `suggestions` — it never 500s.
 *
 * Every generated suggestion carries a `prediction` (one-paragraph
 * before/after forecast), stored on ai_suggestions.prediction (migration
 * 103). The prediction is generated deterministically from the report so
 * it exists even when the provider prose path is skipped.
 *
 * The provider does the weapon-display-name → config-class reasoning and
 * emits the patch; this module supplies the real report + the real config
 * files so the patch is grounded in live data and live files.
 */

const fs = require('fs');
const path = require('path');
const { resolveExistingContainedPath } = require('../utils/safePath');
const { MISSION_SUBDIRS } = require('../utils/dayzPlatform');
const { getGuildDownloadPath } = require('./logSyncService');
const aiService = require('./aiService');
const configIntelligenceService = require('./aiConfigIntelligenceService');

const MAP_FOLDER_SUFFIX = {
  chernarusplus: 'dayzOffline.chernarusplus',
  enoch:         'dayzOffline.enoch',
  sakhal:        'dayzOffline.sakhal',
  nasdara:       'dayzOffline.nasdara',
};
const RE_MAP_STORAGE = /mpmissions\\dayzOffline\.(\w+)\\/;

const MAX_DAYS = 90;
const GRID_SIZE = 100;          // meters per death-zone bin
const TOP_N = 15;               // rows per report section
const LOOT_IMBALANCE_RATIO = 3; // despawns / spawn-min considered imbalanced
const DOMINANCE_SHARE = 0.35;   // single weapon above this share = dominant
const ECONOMY_DRIFT_PCT = 10;   // % nominal drift to flag

// ─── Errors ─────────────────────────────────────────────────────────────────

function tuningError(code, message, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

// ─── Working-copy resolution ────────────────────────────────────────────────

/**
 * Resolve the on-disk working-copy mission dir (dayzOffline.<map>) for the
 * exact authorized server, or null when nothing is ingested. Mirrors
 * lootParserService.resolveMapDir but takes an absolute server root so the
 * caller controls the authorization scope (routes/ai.js already gates the
 * platformServerId).
 */
function resolveMissionDir(serverRoot, mapName) {
  const suffix = MAP_FOLDER_SUFFIX[mapName];
  if (!serverRoot || !suffix) return null;
  const candidates = [suffix, ...MISSION_SUBDIRS.map(dir => path.join(dir, suffix))];
  for (const relative of candidates) {
    try {
      const candidate = resolveExistingContainedPath(serverRoot, relative);
      if (fs.lstatSync(candidate).isDirectory()) return candidate;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Detect the active map from the newest ingested RPT header
 * (mpmissions\dayzOffline.<map>\). Returns a map name or null.
 */
function detectActiveMap(serverRoot) {
  let configDir;
  try {
    configDir = resolveExistingContainedPath(serverRoot, 'config');
  } catch {
    return null;
  }
  let entries;
  try {
    entries = fs.readdirSync(configDir).filter(n => n.endsWith('.RPT'));
  } catch {
    return null;
  }
  if (!entries.length) return null;
  entries.sort().reverse(); // newest filename (timestamp) first
  for (const name of entries) {
    try {
      const fd = fs.openSync(path.join(configDir, name), 'r');
      try {
        const buf = Buffer.alloc(16384);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        const match = RE_MAP_STORAGE.exec(buf.slice(0, read).toString('utf8'));
        if (match && MAP_FOLDER_SUFFIX[match[1]]) return match[1];
      } finally {
        fs.closeSync(fd);
      }
    } catch { /* try next file */ }
  }
  return null;
}

/**
 * Resolve the mission dir for a report: explicit `map` wins; otherwise the
 * active map from the RPT header; otherwise the first on-disk mission dir.
 */
function resolveMapForReport(access, requestedMap) {
  let serverRoot;
  try {
    serverRoot = getGuildDownloadPath(access.discordGuildId, access.platformServerId);
  } catch {
    return null;
  }
  if (requestedMap) {
    const dir = resolveMissionDir(serverRoot, requestedMap);
    if (dir) return { mapName: requestedMap, mapDir: dir };
    throw tuningError('DATA_TUNING_MAP_MISSING', `No working copy for map "${requestedMap}" on this server`, 404);
  }
  const detected = detectActiveMap(serverRoot);
  if (detected) {
    const dir = resolveMissionDir(serverRoot, detected);
    if (dir) return { mapName: detected, mapDir: dir };
  }
  // Fallback: first mission dir that exists on disk.
  for (const name of Object.keys(MAP_FOLDER_SUFFIX)) {
    const dir = resolveMissionDir(serverRoot, name);
    if (dir) return { mapName: name, mapDir: dir };
  }
  return null;
}

// ─── types.xml reading (nominal per class) ──────────────────────────────────

const { XMLParser } = require('fast-xml-parser');
const TYPES_PARSER = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/** Parse a types.xml into { className: {nominal, min, lifetime, restock} }. */
function parseTypesXml(content) {
  if (typeof content !== 'string' || !content.trim()) return {};
  let doc;
  try { doc = TYPES_PARSER.parse(content); } catch { return {}; }
  if (!doc || !doc.types || !doc.types.type) return {};
  const out = {};
  for (const t of [].concat(doc.types.type)) {
    const name = t['@_name'];
    if (!name) continue;
    const int = v => {
      const raw = Array.isArray(v) ? v[0] : v;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : 0;
    };
    out[name] = {
      nominal:  int(t.nominal),
      min:      int(t.min),
      lifetime: int(t.lifetime),
      restock:  int(t.restock),
    };
  }
  return out;
}

/**
 * Merge the base types.xml (db/types.xml) with any custom overrides
 * (custom/types.xml + custom/cfgspawnabletypes*.xml). Later files override
 * earlier ones per class, mirroring lootParserService.mergeTypes ordering.
 * Returns { items: Map-like object, files: [readable filenames] }.
 */
function loadSpawnConfig(mapDir) {
  const readRel = (rel) => {
    try {
      const abs = resolveExistingContainedPath(mapDir, rel);
      return fs.readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  };
  const base = parseTypesXml(readRel(path.join('db', 'types.xml')) || '');
  const customRel = [];
  try {
    const customDir = resolveExistingContainedPath(mapDir, 'custom');
    for (const n of fs.readdirSync(customDir)) {
      if (n === 'types.xml' || (/^cfgspawnabletypes.*\.xml$/.test(n))) customRel.push(path.join('custom', n));
    }
  } catch { /* no custom dir */ }
  // types.xml first so it has lowest priority among custom files.
  customRel.sort((a, b) => (path.basename(a) === 'types.xml' ? -1 : path.basename(b) === 'types.xml' ? 1 : 0));

  const items = { ...base };
  const files = [];
  if (Object.keys(base).length) files.push('db/types.xml');
  for (const rel of customRel) {
    const content = readRel(rel);
    if (!content) continue;
    files.push(rel);
    Object.assign(items, parseTypesXml(content));
  }
  return { items, files: files.length ? files : ['db/types.xml'] };
}

// ─── Deterministic reports ──────────────────────────────────────────────────

/**
 * 1. LOOT — join despawn events with spawn nominal per class.
 * @returns {{area, map, days, total, rows, imbalances, summary}}
 */
async function lootReport(db, serverId, days, spawnConfig) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await db.query(
    `SELECT item_class, COUNT(*)::int AS despawns
     FROM loot_despawn_events
     WHERE server_id = $1 AND log_date >= $2::date
     GROUP BY item_class
     ORDER BY despawns DESC, item_class ASC
     LIMIT $3`,
    [serverId, since, TOP_N * 3]
  );

  const items = spawnConfig ? spawnConfig.items : {};
  const enriched = rows.map(r => {
    const nominal = items[r.item_class] ? items[r.item_class].nominal : null;
    const ratio = nominal && nominal > 0 ? Number((r.despawns / nominal).toFixed(2)) : null;
    return {
      class: r.item_class,
      despawns: r.despawns,
      nominal,
      ratio,
      inSpawnConfig: nominal !== null,
      imbalanced: ratio !== null && ratio >= LOOT_IMBALANCE_RATIO,
    };
  });

  const imbalances = enriched.filter(r => r.imbalanced);
  const summary = [
    `Loot spawn/despawn report (last ${days}d, map ${spawnConfig ? spawnConfig.files.join(', ') : 'no config'}).`,
    `${rows.length} classes with despawn events; ${imbalances.length} show despawn/spawn ratio ≥ ${LOOT_IMBALANCE_RATIO}x.`,
    imbalances.length
      ? `Most imbalanced: ${imbalances.slice(0, 5).map(r => `${r.class} (despawns ${r.despawns} vs nominal ${r.nominal}, ~${r.ratio}x)`).join('; ')}.`
      : 'No class exceeds the imbalance threshold.',
  ].join('\n');

  // Guarantee deterministic ordering (highest despawns first) even if the
  // backend does not honor the SQL ORDER BY.
  const sorted = enriched.slice().sort((a, b) =>
    b.despawns - a.despawns || String(a.class).localeCompare(String(b.class)));
  return { area: 'loot', days, total: rows.reduce((s, r) => s + r.despawns, 0), rows: sorted.slice(0, TOP_N), imbalances: imbalances.sort((a, b) => b.despawns - a.despawns), summary };
}

/**
 * 2. WEAPONS — weekly kill share + dominance.
 * @returns {{area, days, total, top, weekly, dominance, summary}}
 */
async function weaponReport(db, serverId, days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const top = await db.query(
    `SELECT weapon, COUNT(*)::int AS kills
     FROM kill_events
     WHERE server_id = $1 AND timestamp >= $2
     GROUP BY weapon
     ORDER BY kills DESC, weapon ASC
     LIMIT $3`,
    [serverId, since, TOP_N]
  );
  const totalRow = await db.get(
    `SELECT COUNT(*)::int AS c FROM kill_events WHERE server_id = $1 AND timestamp >= $2`,
    [serverId, since]
  );
  const total = totalRow?.c || 0;

  const topEnriched = top.map(r => ({
    weapon: r.weapon,
    kills: r.kills,
    share: total ? Number((r.kills / total).toFixed(4)) : 0,
  }));

  const weekly = await db.query(
    `SELECT to_char(date_trunc('week', timestamp), 'YYYY-MM-DD') AS week,
            weapon,
            COUNT(*)::int AS kills
     FROM kill_events
     WHERE server_id = $1 AND timestamp >= $2
     GROUP BY 1, 2
     ORDER BY 1 DESC, 3 DESC`,
    [serverId, since]
  );

  const top3Share = topEnriched.slice(0, 3).reduce((s, r) => s + r.share, 0);
  const hhi = topEnriched.reduce((s, r) => s + r.share * r.share, 0);
  const dominant = topEnriched.find(r => r.share >= DOMINANCE_SHARE);
  const dominance = {
    topWeapon: topEnriched[0] ? topEnriched[0].weapon : null,
    topShare: topEnriched[0] ? topEnriched[0].share : 0,
    top3Share: Number(top3Share.toFixed(4)),
    hhi: Number(hhi.toFixed(4)),
    dominant,
  };

  const summary = [
    `Weapon balance report (last ${days}d).`,
    `${total} total kills across ${top.length} weapons.`,
    dominance.dominant
      ? `DOMINANT: ${dominant.weapon} holds ${(dominant.share * 100).toFixed(1)}% of kills (≥ ${(DOMINANCE_SHARE * 100).toFixed(0)}%).`
      : `No single weapon dominates (top: ${dominance.topWeapon} at ${(dominance.topShare * 100).toFixed(1)}%).`,
    `Concentration: top-3 = ${(top3Share * 100).toFixed(1)}%, HHI = ${dominance.hhi} (higher = more concentrated).`,
  ].join('\n');

  return { area: 'weapons', days, total, top: topEnriched, weekly: weekly.slice(0, TOP_N * 7), dominance, summary };
}

/**
 * 3. DEATHZONES — cluster kill positions into a grid, rank hot zones.
 * @returns {{area, days, total, zones, grid, summary}}
 */
async function deathzoneReport(db, serverId, days) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await db.query(
    `SELECT victim_position
     FROM kill_events
     WHERE server_id = $1 AND timestamp >= $2 AND victim_position IS NOT NULL`,
    [serverId, since]
  );

  const bins = new Map();
  let placed = 0;
  for (const r of rows) {
    const parts = String(r.victim_position || '').split(',');
    if (parts.length < 2) continue;
    const x = parseFloat(parts[0]);
    const z = parseFloat(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    const gx = Math.round(x / GRID_SIZE);
    const gz = Math.round(z / GRID_SIZE);
    const key = `${gx},${gz}`;
    const bin = bins.get(key) || { gx, gz, kills: 0, xs: [], zs: [] };
    bin.kills += 1;
    bin.xs.push(x);
    bin.zs.push(z);
    bins.set(key, bin);
    placed += 1;
  }

  const zones = Array.from(bins.values())
    .map(b => ({
      grid: `${b.gx},${b.gz}`,
      center: { x: Math.round(b.xs.reduce((s, v) => s + v, 0) / b.xs.length), z: Math.round(b.zs.reduce((s, v) => s + v, 0) / b.zs.length) },
      kills: b.kills,
    }))
    .sort((a, b) => b.kills - a.kills)
    .slice(0, TOP_N);

  const total = placed;
  const summary = [
    `Hot death-zone report (last ${days}d, ${GRID_SIZE}m grid).`,
    `${total} kills with a position across ${bins.size} grid cells.`,
    zones.length
      ? `Hottest: ${zones.slice(0, 5).map(z => `(${z.center.x},${z.center.z}) with ${z.kills} kills`).join('; ')}.`
      : 'No positioned kills to cluster.',
  ].join('\n');

  return { area: 'deathzones', days, total, grid: GRID_SIZE, zones, summary };
}

/**
 * 4. ECONOMY — snapshot current nominal per class, then compare the oldest
 * vs newest snapshot to surface drift. Flags inflation/deflation creep.
 * Writes one economy_snapshots row per class (idempotent per date).
 * @returns {{area, map, snapshotDate, classes, drift, flags, summary}}
 */
async function economyReport(db, serverId, spawnConfig) {
  const snapshotDate = new Date().toISOString().slice(0, 10);
  const items = spawnConfig ? spawnConfig.items : {};
  const classes = Object.entries(items)
    .filter(([, v]) => v.nominal > 0)
    .map(([cls, v]) => ({ item_class: cls, nominal: v.nominal, min: v.min, lifetime: v.lifetime, restock: v.restock }))
    .sort((a, b) => b.nominal - a.nominal);

  if (classes.length) {
    for (const c of classes) {
      await db.query(
        `INSERT INTO economy_snapshots (server_id, item_class, nominal, min, lifetime, restock, snapshot_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (server_id, item_class, snapshot_date) DO UPDATE
           SET nominal = EXCLUDED.nominal, min = EXCLUDED.min,
               lifetime = EXCLUDED.lifetime, restock = EXCLUDED.restock`,
        [serverId, c.item_class, c.nominal, c.min, c.lifetime, c.restock, snapshotDate]
      );
    }
  }

  // Drift between oldest and newest snapshot date.
  const distinct = await db.query(
    `SELECT snapshot_date, MIN(nominal) AS min_nominal, MAX(nominal) AS max_nominal
     FROM economy_snapshots WHERE server_id = $1
     GROUP BY snapshot_date ORDER BY snapshot_date ASC`,
    [serverId]
  );
  let drift = [];
  if (distinct.length >= 2) {
    const oldest = await db.query(
      `SELECT item_class, nominal FROM economy_snapshots WHERE server_id = $1 AND snapshot_date = (SELECT MIN(snapshot_date) FROM economy_snapshots WHERE server_id = $1)`,
      [serverId]
    );
    const newest = await db.query(
      `SELECT item_class, nominal FROM economy_snapshots WHERE server_id = $1 AND snapshot_date = (SELECT MAX(snapshot_date) FROM economy_snapshots WHERE server_id = $1)`,
      [serverId]
    );
    const newestMap = Object.fromEntries(newest.map(r => [r.item_class, r.nominal]));
    drift = oldest
      .map(o => {
        const now = newestMap[o.item_class];
        if (now === undefined || o.nominal === 0) return null;
        const pct = Number(((now - o.nominal) / o.nominal) * 100).toFixed(1);
        return { item_class: o.item_class, from: o.nominal, to: now, driftPct: Number(pct) };
      })
      .filter(Boolean)
      .sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct))
      .slice(0, TOP_N);
  }

  const flags = drift.filter(d => Math.abs(d.driftPct) >= ECONOMY_DRIFT_PCT);
  const inflation = flags.filter(f => f.driftPct > 0);
  const deflation = flags.filter(f => f.driftPct < 0);
  const summary = [
    `Economy health report (map ${spawnConfig ? spawnConfig.files.join(', ') : 'no config'}).`,
    spawnConfig ? `${classes.length} classes with nominal > 0 snapshotted on ${snapshotDate}.` : 'No spawn config present to snapshot.',
    distinct.length >= 2
      ? `${flags.length} of ${drift.length} tracked classes drifted ≥ ${ECONOMY_DRIFT_PCT}% since the oldest snapshot; ${inflation.length} inflating, ${deflation.length} deflating.`
      : 'Only one snapshot on record yet — drift needs ≥ 2 snapshots (re-run after the next wipe/sync).',
  ].join('\n');

  return { area: 'economy', snapshotDate, classes: classes.slice(0, TOP_N), drift, flags, summary };
}

// ─── Predictions (deterministic, per suggestion) ────────────────────────────

/**
 * One-paragraph before/after prediction for a data-tuning suggestion.
 * Deterministic from the report so it exists even without a provider.
 */
function deterministicPrediction(report, suggestion) {
  const file = suggestion.filename;
  const change = suggestion.diffSummary ? suggestion.diffSummary.summary : 'n/a';
  const lead = {
    loot: `Applying this edit to ${file} (${change})`,
    weapons: `Applying this edit to ${file} (${change})`,
    deathzones: `Applying this edit to ${file} (${change})`,
    economy: `Applying this edit to ${file} (${change})`,
  }[report.area] || `Applying this edit to ${file} (${change})`;
  const expectation = {
    loot: 'should shift spawn volume toward the flagged classes, easing the despawn-over-spawn pressure on over-spawned loot while the CE restock cycle redistributes the remainder.',
    weapons: 'should narrow the kill-share gap by trimming the dominant weapon\'s availability, nudging players toward the broader arsenal and flattening the dominance curve.',
    deathzones: 'should reduce concentrated deaths in the flagged zones by adjusting the referenced spawn/event coverage, lowering repeatable kill-farm pressure in those coordinates.',
    economy: 'should counter the nominal drift on the flagged classes, slowing the inflation/deflation creep so item value stays stable across wipes.',
  }[report.area] || 'will change the referenced config values.';
  return `${lead} ${expectation} Verify the effect by re-running the ${report.area} report after the next wipe.`;
}

// ─── Suggestion planning (provider) ─────────────────────────────────────────

/**
 * Map an area to the config files an AI suggestion may target. The report
 * supplies the data; the provider supplies the patch. Files are read from
 * the real working copy so the patch validates against live content.
 */
function targetFilesForArea(area, mapDir, spawnConfig) {
  const readRel = (rel) => {
    try { return { filename: rel, content: fs.readFileSync(resolveExistingContainedPath(mapDir, rel), 'utf8') }; }
    catch { return null; }
  };
  const files = [];
  if (area === 'loot' || area === 'weapons' || area === 'economy') {
    for (const f of (spawnConfig ? spawnConfig.files : [])) {
      const r = readRel(f);
      if (r) files.push(r);
    }
  }
  if (area === 'deathzones') {
    for (const f of [path.join('custom', 'cfgeventspawns.xml'), path.join('cfgeventspawns.xml'), path.join('custom', 'cfgrandompresets.xml')]) {
      const r = readRel(f);
      if (r) files.push(r);
    }
    if (!files.length) { const r = readRel(path.join('custom', 'types.xml')); if (r) files.push(r); }
  }
  // Weapons/economy/loot also allow the randompresets as a secondary lever.
  if (area === 'weapons' || area === 'loot' || area === 'economy') {
    const rp = readRel(path.join('cfgrandompresets.xml')) || readRel(path.join('custom', 'cfgrandompresets.xml'));
    if (rp) files.push(rp);
  }
  return files.slice(0, 5);
}

function tuningPrompt(area, report, files) {
  const task = {
    loot: `DATA-DRIVEN LOOT TUNING. The server data shows these classes despawn far more than their spawn nominal (imbalanced). Suggest minimal nominal/loot tweaks to rebalance.`,
    weapons: `DATA-DRIVEN WEAPON BALANCE. The kill data shows this weapon dominance profile. Suggest nominal / loot-nominal / damage tweaks to flatten the dominance curve.`,
    deathzones: `DATA-DRIVEN DEATH-ZONE TUNING. The kill-position data shows these hot zones. Suggest spawn/event tweaks referencing the included event/spawn files to reduce the concentration.`,
    economy: `DATA-DRIVEN ECONOMY TUNING. The nominal drift over time shows these classes drifting. Suggest price/nominal changes to counter the inflation or deflation creep.`,
  }[area];
  const fileLines = files.map(f => `- ${f.filename}`).join('\n');
  const fileTexts = files.map(f => `--- File: ${f.filename} ---\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');
  return [
    task,
    '',
    `DETERMINISTIC REPORT (real server data, last ${report.days}d):`,
    report.summary,
    '',
    'Include these files (use their exact names in "file"):',
    fileLines,
    '',
    fileTexts,
    '',
    'Respond now with exactly one fenced ```json block per the patch protocol. Keep edits minimal and grounded in the report.',
  ].join('\n');
}

/**
 * Produce validated, materialized patch suggestions for an area. Reuses the
 * feature-2 parse-and-materialize pipeline so every suggestion is a valid
 * xml-search-replace / json-merge patch against the live working copy.
 *
 * @param {string} area        - 'loot' | 'weapons' | 'deathzones' | 'economy'
 * @param {object} report      - the deterministic report for the area
 * @param {Array}  files       - {filename, fileContent} working copies to patch
 * @param {object} provider    - resolved provider descriptor
 * @returns {Promise<Array>} materialized suggestions (each with a prediction)
 */
async function planSuggestions(area, report, files, provider) {
  if (!files.length) return [];
  const system = configIntelligenceService.PATCH_SYSTEM;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: tuningPrompt(area, report, files) },
  ];
  const response = await aiService.callProvider(messages, 0.2, provider);
  const materialized = configIntelligenceService.parseAndMaterialize(response, files);
  return materialized.suggestions.map(s => ({
    ...s,
    prediction: deterministicPrediction(report, s),
  }));
}

module.exports = {
  MAP_FOLDER_SUFFIX,
  GRID_SIZE,
  MAX_DAYS,
  tuningError,
  detectActiveMap,
  resolveMapForReport,
  loadSpawnConfig,
  parseTypesXml,
  lootReport,
  weaponReport,
  deathzoneReport,
  economyReport,
  deterministicPrediction,
  targetFilesForArea,
  tuningPrompt,
  planSuggestions,
};
