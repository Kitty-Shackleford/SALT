'use strict';

/*
 * Event / Content Generation (AI feature 5/7)
 *
 * Deterministic generators for mission content, all validated against the
 * ACTUAL DayZ XML shapes found in the authorized server's working copy:
 *
 *   - Event generator: theme ("winter", ...) -> coherent set of config blocks:
 *       cfgeventgroups.xml   <group> entries (landmark + loot children)
 *       cfgeventspawns.xml   <event name=...> entries (<zone> + <pos> rows)
 *       cfgweather.xml       per-parameter weather overrides (search-replace
 *                            on the existing <current .../> lines)
 *     Every block is materialized through the feature-2 patch engine
 *     (services/aiConfigPatchService.js applyPatch) and run through the
 *     config validator + CE-registration typing from
 *     missionFileInspectionService.readWorkingCopyFile — suggestions are
 *     NEVER auto-applied; they surface through the standard
 *     ai_suggestions / apply pipeline.
 *
 *   - Spawn point / loot designer: new <group> spawn bubbles with
 *     map-coordinate validation against the mission map bounds
 *     (public/js/dayz-map-coordinates.js world extents), plus types.xml
 *     loot entries whose nominal/bias stay inside the server's economy
 *     bounds (spawn-config nominal caps, card 3 data-tuning reuse).
 *
 *   - Season planner: theme + duration -> reviewable markdown schedule of
 *     events across the server's mission(s), plus the per-mission config
 *     suggestions generated from that schedule.
 *
 * AI layer (optional): when a provider is configured the theme prompt is
 * grounded in the REAL mission state (existing group/event names, map
 * bounds, current weather values) and the provider's fenced JSON is run
 * through the same parse-and-materialize + validation pipeline; a failed
 * AI plan never sinks the request — the deterministic template plan is
 * returned alongside the plan error (same convention as data-tuning).
 */

const fs = require('fs');
const path = require('path');
const { XMLValidator, XMLParser } = require('fast-xml-parser');

const dataTuningService = require('./dataTuningService');
const patchEngine = require('./aiConfigPatchService');
const configIntelligenceService = require('./aiConfigIntelligenceService');
const configValidatorService = require('./configValidatorService');
const missionFileInspectionService = require('./missionFileInspectionService');

const { resolveExistingContainedPath } = require('../utils/safePath');

const SEASONS = new Set(['winter', 'summer', 'spring', 'autumn', 'storm', 'festival']);
const MAX_POSITIONS_PER_EVENT = 24;
const MARGIN_FROM_EDGE = 500; // meters kept away from map edges for spawns

function eventError(code, message, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

// ─── Map bounds ──────────────────────────────────────────────────────────────

const MAP_BOUNDS = {
  enoch:         { width: 12800, origin: 0 },
  chernarusplus: { width: 15360, origin: 0 },
  sakhal:        { width: 15360, origin: 0 },
};

function mapBounds(mapName) {
  const def = MAP_BOUNDS[mapName] || null;
  if (!def) return null;
  // Prefer the live renderer definition (it is the source of truth the UI
  // uses for map coordinates); fall back to the pinned extents above.
  try {
    const coords = require('../public/js/dayz-map-coordinates');
    const live = coords.getMapDefinition ? coords.getMapDefinition(mapName) : null;
    if (live && Number.isFinite(live.worldWidth)) {
      return {
        min: typeof live.worldMinEast === 'number' ? live.worldMinEast : def.origin,
        max: (typeof live.worldMinEast === 'number' ? live.worldMinEast : def.origin) + live.worldWidth,
      };
    }
  } catch { /* fall through to pinned extents */ }
  return { min: def.origin, max: def.origin + def.width };
}

/** Validate a map coordinate [x, z] (meters) against the mission map bounds. */
function validateMapCoordinate(mapName, x, z) {
  const bounds = mapBounds(mapName);
  if (!bounds) throw eventError('MAP_UNKNOWN', `No map bounds known for "${mapName}"`, 404);
  const issues = [];
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    issues.push('coordinates must be finite numbers');
  } else {
    if (x < bounds.min + MARGIN_FROM_EDGE || x > bounds.max - MARGIN_FROM_EDGE) {
      issues.push(`x=${x} is outside the safe map area (x in [${bounds.min + MARGIN_FROM_EDGE}, ${bounds.max - MARGIN_FROM_EDGE}])`);
    }
    if (z < bounds.min + MARGIN_FROM_EDGE || z > bounds.max - MARGIN_FROM_EDGE) {
      issues.push(`z=${z} is outside the safe map area (z in [${bounds.min + MARGIN_FROM_EDGE}, ${bounds.max - MARGIN_FROM_EDGE}])`);
    }
  }
  if (issues.length) throw eventError('COORD_OUT_OF_BOUNDS', issues.join('; '), 422);
  return { x, z };
}

// ─── Mission XML reading (bounded, read-only) ───────────────────────────────

function readMissionFile(mapDir, rel) {
  try {
    return fs.readFileSync(resolveExistingContainedPath(mapDir, rel), 'utf8');
  } catch {
    return null;
  }
}

/** Parse cfgeventspawns.xml -> ordered { name, zone, posCount } list. */
function parseEventSpawns(content) {
  if (typeof content !== 'string' || !content.trim()) return [];
  try {
    const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
      .parse(content);
    const events = [].concat(doc?.eventposdef?.event || []);
    const out = [];
    for (const ev of events) {
      const zone = ev.zone;
      out.push({
        name: ev['@_name'] || null,
        zone: zone ? {
          smin: parseInt(zone['@_smin'], 10),
          smax: parseInt(zone['@_smax'], 10),
          dmin: parseInt(zone['@_dmin'], 10),
          dmax: parseInt(zone['@_dmax'], 10),
          r: parseInt(zone['@_r'], 10),
        } : null,
        posCount: [].concat(ev.pos || []).length,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Extract every <group name="..."> from a mission XML file (comments are
 * legal XML and ignored for name-collision purposes). */
function parseGroupNames(content) {
  if (typeof content !== 'string' || !content.trim()) return [];
  const out = [];
  const re = /<group\s[^>]*name="([^"]+)"/g;
  let m;
  while ((m = re.exec(content)) !== null) out.push(m[1]);
  return out;
}

/** Parse cfgeventgroups.xml -> ordered group names. */
function parseEventGroups(content) {
  if (typeof content !== 'string' || !content.trim()) return [];
  try {
    const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
      .parse(content);
    return [].concat(doc?.eventgroupdef?.group || [])
      .map(g => g['@_name'])
      .filter(Boolean);
  } catch {
    return [];
  }
}

function sanitizeTagName(raw, existing) {
  let name = String(raw || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!name) throw eventError('INVALID_NAME', 'Block name is empty after sanitization');
  if (!/^[A-Za-z]/.test(name)) name = `G_${name}`;
  name = name.slice(0, 64);
  let candidate = name;
  let n = 2;
  while (existing.has(candidate.toLowerCase())) {
    candidate = `${name}_${n}`;
    n += 1;
    if (n > 100) throw eventError('NAME_EXHAUSTED', `Could not find a unique name for "${name}"`, 422);
  }
  return candidate;
}

// ─── XML block builders (shape-verified against the mission files) ──────────

/** cfgeventgroups.xml block: <group name=...> + <child> rows. */
function buildGroupXml(name, children) {
  const lines = [`  <group name="${name}">`];
  for (const child of children) {
    lines.push(`    <child type="${child.type}" deloot="${child.deloot ?? 0}" lootmax="${child.lootmax}" lootmin="${child.lootmin}" x="${child.x}" z="${child.z}" a="${child.a}" y="${child.y}"/>`);
  }
  lines.push('  </group>');
  return lines.join('\n');
}

/** cfgeventspawns.xml block: <event name=...> + <zone/> + <pos> rows. */
function buildEventXml(name, zone, positions) {
  const lines = [
    `  <event name="${name}">`,
    `    <zone smin="${zone.smin}" smax="${zone.smax}" dmin="${zone.dmin}" dmax="${zone.dmax}" r="${zone.r}"/>`,
  ];
  for (const p of positions) {
    lines.push(`    <pos x="${p.x}" z="${p.z}" a="${p.a}"/>`);
  }
  lines.push('  </event>');
  return lines.join('\n');
}

/** cfgplayerspawnpoints.xml block: <group name=...> with <pos> bubbles. */
function buildSpawnGroupXml(name, positions, { lifetime = 240, counter = -1 } = {}) {
  const lines = [
    `    <group name="${name}" lifetime="${lifetime}" counter="${counter}">`,
  ];
  for (const p of positions) lines.push(`      <pos x="${p.x}" z="${p.z}"/>`);
  lines.push('    </group>');
  return lines.join('\n');
}

/** db/types.xml / custom types.xml block: <type name=...> economy entry. */
function buildLootTypeXml(name, { nominal, min, lifetime, restock }) {
  return [
    `  <type name="${name}">`,
    `    <nominal>${nominal}</nominal>`,
    `    <min>${min}</min>`,
    `    <lifetime>${lifetime}</lifetime>`,
    `    <restock>${restock}</restock>`,
    `  </type>`,
  ].join('\n');
}

// ─── Patch assembly (feature-2 engine) ──────────────────────────────────────

/**
 * Build a materialized suggestion that inserts `xml` immediately before the
 * closing root tag of `filename` (content). Throws via the patch engine when
 * the anchor is not unique or the result is not well-formed.
 */
function makeAppendSuggestion(filename, content, xml, rationale) {
  const closing = `</${rootTagOf(content, filename)}>`;
  const applied = patchEngine.applyPatch(filename, content, {
    kind: 'xml-search-replace',
    edits: [{ search: closing, replace: `${xml}\n${closing}` }],
  });
  const baseHash = patchEngine.contentFingerprint(content);
  const result = {
    filename,
    explanation: rationale,
    patch: { kind: 'xml-search-replace', edits: [{ search: closing, replace: `${xml}\n${closing}` }] },
    originalContent: content,
    suggestedContent: applied.content,
    appliedEdits: applied.appliedEdits,
    baseContentHash: baseHash,
    diffSummary: patchEngine.diffSummary(content, applied.content, 40),
  };
  validateSuggestedFile(result, filename, content);
  return result;
}

function rootTagOf(content, filename) {
  // The root tag is the first *element* start tag. An XML declaration
  // (<?xml ...?>), DOCTYPE, or comment on the same first line as the root
  // must not be mistaken for it — real mission files open as
  // `<?xml version="1.0" ...?><eventposdef>` on one line (e.g. chernarusplus),
  // and matching the declaration would yield a bogus `</xml>`-style anchor
  // that collides with every child element.
  const m = /<([A-Za-z][\w.-]*)(?=[\s>])/.exec(String(content || ''));
  if (!m) throw eventError('MISSION_FILE_UNREADABLE', `Cannot detect the root tag of ${filename}`);
  return m[1];
}

function makeWeatherEdit(filename, content, section, kind, value, rationale) {
  // Anchor on the WHOLE section span (<section>...</section>, comments
  // included — token matching requires comments in the search block to be
  // verbatim) and swap only the target <kind .../> line inside it. The
  // section name is unique per weather file, so the span match is unique.
  const sectionRe = new RegExp(`<${section}\\b[^>]*>[\\s\\S]*?</${section}>`);
  const spanMatch = sectionRe.exec(content);
  if (!spanMatch) {
    throw eventError('WEATHER_ANCHOR_MISSING', `No <${section}> section found in cfgweather.xml`);
  }
  const span = spanMatch[0];
  const lineRe = new RegExp(`<${kind}\\b[^>]*?/>`);
  const lineMatch = lineRe.exec(span);
  if (!lineMatch) {
    throw eventError('WEATHER_ANCHOR_MISSING', `No <${kind}> line found in the <${section}> section of cfgweather.xml`);
  }
  const search = span;
  const replace = span.replace(lineMatch[0], value);
  const applied = patchEngine.applyPatch(filename, content, {
    kind: 'xml-search-replace',
    edits: [{ search, replace }],
  });
  const result = {
    filename,
    explanation: rationale,
    patch: { kind: 'xml-search-replace', edits: [{ search, replace }] },
    originalContent: content,
    suggestedContent: applied.content,
    appliedEdits: applied.appliedEdits,
    baseContentHash: patchEngine.contentFingerprint(content),
    diffSummary: patchEngine.diffSummary(content, applied.content, 40),
  };
  validateSuggestedFile(result, filename, content);
  return result;
}

/**
 * Deterministic validation of a materialized suggestion (reuses card 2).
 * Errors are judged as a DELTA against the original content: mission files
 * often carry pre-existing error-level findings (e.g. a types.xml with
 * duplicate <type> entries from earlier edits) that our patch did not
 * introduce. We must not fail a well-formed, correct edit because the
 * working copy was already invalid; we must fail when the edit INTRODUCES
 * or INCREASES errors. Warnings are tolerated (they are advisory).
 */
function validateSuggestedFile(result, filename, originalContent) {
  const original = configValidatorService.validateConfigFile(filename, originalContent);
  const suggested = configValidatorService.validateConfigFile(filename, result.suggestedContent);
  const count = (findings) => findings.filter(f => f.severity === 'error').length;
  if (count(suggested.findings) > count(original.findings)) {
    // Surface the first NEW error (one not matched by the original count).
    const first = suggested.findings.find(f => f.severity === 'error');
    const detail = first ? first.message : 'introduced new validation errors';
    throw eventError('VALIDATION_FAILED', `Generated ${filename} introduced new validation errors: ${detail}`);
  }
  // Well-formedness of the ORIGINAL must hold too (guards against a broken
  // working copy we are patching on top of).
  const origCheck = XMLValidator.validate(originalContent, { allowBooleanAttributes: true });
  if (origCheck !== true) {
    throw eventError('MISSION_FILE_INVALID', `${filename} in the working copy is not well-formed XML; fix it before generating content`);
  }
  return suggested;
}

/**
 * CE-registration typing for a mission file (warning-level diagnostics ok).
 * `CE_MISSION_UNRESOLVED` is informational, not a failure: working copies
 * synced from the server root are laid out FLAT (dayzOffline.<map>/...)
 * without an `mpmissions/<id>/` component, so the exact-mission CE typer
 * cannot type the file — but the file still ships in the mission's own
 * registration context and validation of the content itself still applies.
 */
function ceRegistrationNote(mapDir, filename) {
  try {
    const snapshot = missionFileInspectionService.readWorkingCopyFile(mapDir, filename);
    const diagnostics = snapshot.diagnostics || [];
    const bad = diagnostics.find(d => d.code &&
      d.code !== 'CE_REGISTRATION_UNAVAILABLE' &&
      d.code !== 'CE_MISSION_UNRESOLVED');
    if (bad) return { ok: false, code: bad.code, message: bad.message };
    return { ok: true, documentType: snapshot.documentType || null };
  } catch (error) {
    return { ok: false, code: error.code || 'CE_REGISTRATION_ERROR', message: error.message };
  }
}

// ─── Weather template values per season ─────────────────────────────────────
// Values follow the shape of the mission's own cfgweather.xml /
// cfgweather_winter.xml (see dayzOffline.enoch): 0..1 for overcast/fog/
// rain/snowfall, m/s for wind magnitude.

const WEATHER_TEMPLATES = {
  winter: {
    label: 'Winter event',
    params: {
      overcast:     { current: '<current actual="0.45" time="120" duration="240"/>', limits: '<limits min="0.2" max="1.0"/>' },
      rain:         { current: '<current actual="0.0" time="60" duration="120"/>', limits: '<limits min="0.0" max="1.0"/>' },
      snowfall:     { current: '<current actual="0.6" time="240" duration="600"/>', limits: '<limits min="0.3" max="1.0"/>' },
      windMagnitude:{ current: '<current actual="9.0" time="120" duration="240"/>', limits: '<limits min="4.0" max="20.0"/>' },
    },
    event: 'StaticWinterStorm',
    zone: { smin: 1, smax: 2, dmin: 4, dmax: 6, r: 45 },
    group: { name: 'WinterSupplyDrop', landmark: 'Land_Tent_A_Winter', children: [
      ['BoxNATO_Foodration', 2, 3], ['BoxNATO_Ammo', 1, 2], ['Battery9V', 2, 4],
      ['Headtorch_Grey', 1, 2], ['WaterBottle', 2, 4],
    ] },
    groupPositions: [[9594.1, 10811.2]],
  },
  storm: {
    label: 'Storm event',
    params: {
      overcast:     { current: '<current actual="0.9" time="60" duration="300"/>', limits: '<limits min="0.7" max="1.0"/>' },
      rain:         { current: '<current actual="0.8" time="60" duration="300"/>', limits: '<limits min="0.6" max="1.0"/>' },
      windMagnitude:{ current: '<current actual="18.0" time="60" duration="180"/>', limits: '<limits min="12.0" max="25.0"/>' },
    },
    event: 'StaticStormConvoy',
    zone: { smin: 1, smax: 2, dmin: 5, dmax: 8, r: 60 },
    group: { name: 'StormConvoy', landmark: 'Land_Helicopter_wrecked', children: [
      ['M16A4_GL', 1, 1], ['105mm_HE', 1, 2], ['BoxIAmmo', 1, 2], ['FirstAidKit', 2, 3],
    ] },
    groupPositions: [[4200.0, 6800.0]],
  },
  festival: {
    label: 'Festival event',
    params: {},
    event: 'StaticFestival',
    zone: { smin: 2, smax: 3, dmin: 3, dmax: 4, r: 35 },
    group: { name: 'FestivalLoot', landmark: 'CarHatchback02', children: [
      ['TentCamp', 1, 2], ['CampingLamp_Green', 1, 2], ['Battery9V', 2, 4], ['WaterBottle', 2, 4],
    ] },
    groupPositions: [[6400.0, 5600.0]],
  },
  // Seasons without a dedicated weather file: modest drifts from the base
  // cfgweather.xml values (verified against dayzOffline.enoch).
  summer: {
    label: 'Summer event',
    params: {
      overcast: { current: '<current actual="0.15" time="120" duration="600"/>', limits: '<limits min="0.0" max="0.4"/>' },
      fog:      { current: '<current actual="0.0" time="120" duration="600"/>', limits: '<limits min="0.0" max="0.03"/>' },
    },
    event: 'StaticSummerEvent',
    zone: { smin: 1, smax: 3, dmin: 3, dmax: 5, r: 45 },
    group: { name: 'SummerCache', landmark: 'Land_wreck_truck01_aban1_blue', children: [
      ['WaterBottle', 2, 4], ['BoxNATO_Foodration', 2, 3],
    ] },
    groupPositions: [[7000.0, 4200.0]],
  },
  spring: {
    label: 'Spring event',
    params: {
      overcast: { current: '<current actual="0.35" time="120" duration="400"/>', limits: '<limits min="0.1" max="0.8"/>' },
      rain:     { current: '<current actual="0.3" time="300" duration="300"/>', limits: '<limits min="0.1" max="0.7"/>' },
    },
    event: 'StaticSpringEvent',
    zone: { smin: 1, smax: 3, dmin: 3, dmax: 5, r: 45 },
    group: { name: 'SpringCache', landmark: 'Land_wreck_truck01_aban1_blue', children: [
      ['BoxNATO_Foodration', 2, 3], ['Bandage', 2, 4],
    ] },
    groupPositions: [[5200.0, 7400.0]],
  },
  autumn: {
    label: 'Autumn event',
    params: {
      overcast: { current: '<current actual="0.5" time="120" duration="400"/>', limits: '<limits min="0.2" max="0.9"/>' },
      fog:      { current: '<current actual="0.1" time="120" duration="400"/>', limits: '<limits min="0.02" max="0.25"/>' },
    },
    event: 'StaticAutumnEvent',
    zone: { smin: 1, smax: 2, dmin: 4, dmax: 6, r: 50 },
    group: { name: 'AutumnCache', landmark: 'Land_wreck_truck01_aban1_blue', children: [
      ['WoodAxe', 1, 2], ['Battery9V', 2, 4], ['Barrel_Red', 1, 2],
    ] },
    groupPositions: [[8600.0, 3300.0]],
  },
};

function resolveSeason(theme) {
  const key = String(theme || '').trim().toLowerCase();
  if (!SEASONS.has(key)) {
    throw eventError('SEASON_UNKNOWN', `Unknown season/theme "${theme}" (known: ${[...SEASONS].join(', ')})`, 400);
  }
  return { key, template: WEATHER_TEMPLATES[key] };
}

// ─── Event generator ────────────────────────────────────────────────────────

/**
 * Generate a coherent event for a season theme.
 * @param {object} mapContext - { mapName, mapDir } from resolveMapForReport
 * @param {string} theme      - season/theme key
 * @param {object} options    - { eventPositions?: [[x,z,a]...] }
 * @returns {object} { blocks, existingEvents, existingGroups, validation }
 */
function generateEventBlocks(mapContext, theme, options = {}) {
  const season = resolveSeason(theme);
  const t = season.template;
  const mapDir = mapContext.mapDir;

  const spawnsContent = readMissionFile(mapDir, 'cfgeventspawns.xml');
  const groupsContent = readMissionFile(mapDir, 'cfgeventgroups.xml');
  const weatherContent = readMissionFile(mapDir, 'cfgweather.xml');
  if (!spawnsContent || !groupsContent) {
    throw eventError('MISSION_FILES_MISSING', `cfgeventspawns.xml / cfgeventgroups.xml not found in the ${mapContext.mapName} working copy`, 404);
  }
  if (!weatherContent) {
    throw eventError('MISSION_FILES_MISSING', `cfgweather.xml not found in the ${mapContext.mapName} working copy`, 404);
  }

  const existingEvents = parseEventSpawns(spawnsContent);
  const existingGroups = parseEventGroups(groupsContent);
  const eventNames = new Set(existingEvents.map(e => (e.name || '').toLowerCase()));
  const groupNames = new Set(existingGroups.map(n => n.toLowerCase()));

  const eventName = sanitizeTagName(t.event, eventNames);
  const groupName = sanitizeTagName(t.group.name, groupNames);

  // Positions: caller-provided (validated) or one deterministic position
  // inside the map bounds near the template's group anchor.
  const rawPositions = (options.eventPositions || t.groupPositions)
    .slice(0, MAX_POSITIONS_PER_EVENT)
    .map(([x, z, a]) => ({ x: Number(x), z: Number(z), a: Number(a) || 0 }));
  const positions = rawPositions.map(p => validateMapCoordinate(mapContext.mapName, p.x, p.z));
  if (!positions.length) throw eventError('NO_POSITIONS', 'Event needs at least one spawn position');

  const blocks = {
    event: buildEventXml(eventName, t.zone, positions),
    group: buildGroupXml(groupName, t.group.children.map(([type, lootmin, lootmax]) => ({
      type, deloot: 0, lootmin, lootmax,
      x: 0, z: 0, a: 0, y: 0,
    }))),
    weather: {},
  };

  // Weather overrides: best-effort per parameter. Real missions differ in
  // the weather sub-elements they ship (sakhal omits <windmagnitude> and
  // uses <limit> instead of <limits> in <snowfall>), so a missing anchor
  // skips that ONE override instead of sinking the whole event — the
  // event + loot group are the content core and must still generate.
  const weatherSkipped = [];
  // Anchor detection must be SECTION-SCOPED: the regex for a <kind> line
  // starts at <section> and can otherwise cross section boundaries into
  // the NEXT section when the target section omits that sub-element
  // (sakhal omits <windmagnitude>; its <winddirection> section then
  // supplied a false anchor, so the later materialization — which is
  // section-scoped — threw WEATHER_ANCHOR_MISSING mid-event).
  const sectionSpan = (section) => {
    const spanRe = new RegExp('<' + section + '\\b[^>]*>[\\s\\S]*?</' + section + '>');
    return spanRe.exec(weatherContent)?.[0] ?? null;
  };
  for (const [section, params] of Object.entries(t.params)) {
    const span = sectionSpan(section);
    for (const [kind, value] of Object.entries(params)) {
      const anchor = span && new RegExp('<' + kind + '\\b[^>]*?/>').exec(span);
      if (!span || !anchor) {
        weatherSkipped.push(`${section}.${kind}`);
        continue;
      }
      blocks.weather[`${section}.${kind}`] = {
        value,
        originalLine: anchor[0].trim(),
      };
    }
  }

  const validation = {
    ce: {
      cfgeventspawns: ceRegistrationNote(mapDir, 'cfgeventspawns.xml'),
      cfgeventgroups: ceRegistrationNote(mapDir, 'cfgeventgroups.xml'),
      cfgweather: ceRegistrationNote(mapDir, 'cfgweather.xml'),
    },
    existingEvents: existingEvents.length,
    existingGroups: existingGroups.length,
    mapBounds: mapBounds(mapContext.mapName),
    weatherSkipped,
  };

  return {
    season: season.key,
    label: t.label,
    eventName,
    groupName,
    blocks,
    validation,
    // Existing names (grounding for the AI layer; not part of the API shape).
    _eventNames: existingEvents.map(e => e.name).filter(Boolean),
    _groupNames: existingGroups,
    // Context needed to materialize patches.
    _ctx: { spawnsContent, groupsContent, weatherContent },
  };
}

/**
 * Materialize the generated blocks into real patch suggestions (feature-2
 * engine). Returns the suggestion list; throws on the first validation
 * failure (each suggestion is independently validated before assembly).
 */
function materializeEventSuggestions(plan) {
  const { spawnsContent, groupsContent } = plan._ctx;
  const suggestions = [];

  suggestions.push(makeAppendSuggestion(
    'cfgeventspawns.xml', spawnsContent, plan.blocks.event,
    `Add event "${plan.eventName}" (${plan.label}) with ${plan.blocks.event.match(/<pos /g).length} spawn position(s) and its spawn zone.`,
  ));
  suggestions.push(makeAppendSuggestion(
    'cfgeventgroups.xml', groupsContent, plan.blocks.group,
    `Add loot group "${plan.groupName}" (${plan.label}) with ${plan.blocks.group.match(/<child /g).length} loot child(ren) — a themed lootable landmark for the event.`,
  ));

  for (const [key, entry] of Object.entries(plan.blocks.weather)) {
    const [section, kind] = key.split('.');
    suggestions.push(makeWeatherEdit(
      'cfgweather.xml', plan._ctx.weatherContent, section, kind, entry.value,
      `${plan.label}: ${section} ${kind} -> ${entry.value.replace(/<[^>]*>/g, '').trim()} (template value for the "${plan.season}" season).`,
    ));
  }
  return suggestions;
}

// ─── Spawn point designer ───────────────────────────────────────────────────

/**
 * Design a new player-spawn group (cfgplayerspawnpoints.xml) with every
 * position validated against the mission map bounds.
 */
function designSpawnGroup(mapContext, name, positions, options = {}) {
  const spawnContent = readMissionFile(mapContext.mapDir, 'cfgplayerspawnpoints.xml');
  if (!spawnContent) {
    throw eventError('MISSION_FILES_MISSING', `cfgplayerspawnpoints.xml not found in the ${mapContext.mapName} working copy`, 404);
  }
  const existing = new Set(parseGroupNames(spawnContent).map(n => n.toLowerCase()));
  const cleanName = sanitizeTagName(name, existing);
  const validated = [];
  for (const p of positions.slice(0, 48)) {
    const [x, z] = Array.isArray(p) ? p : [p.x, p.z];
    validated.push(validateMapCoordinate(mapContext.mapName, Number(x), Number(z)));
  }
  if (!validated.length) throw eventError('NO_POSITIONS', 'Spawn group needs at least one position');
  const xml = buildSpawnGroupXml(cleanName, validated, {
    lifetime: options.lifetime ?? 240,
    counter: options.counter ?? -1,
  });
  const suggestion = makeAppendSuggestion(
    'cfgplayerspawnpoints.xml', spawnContent, xml,
    `Add spawn group "${cleanName}" (${validated.length} position(s)) — coordinates validated against ${mapContext.mapName} map bounds.`,
  );
  return { name: cleanName, positions: validated, suggestion };
}

// ─── Loot table designer ────────────────────────────────────────────────────

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Design a types.xml loot entry with nominal/bias inside the server's
 * economy bounds: new classes default to nominal 20 / min 1, capped at
 * MAX_LOOT_NOMINAL; existing classes are updated IN PLACE (patching the
 * existing <type> block) and their nominal cannot exceed existing +50% —
 * the server's economy bounds (card 3 spawn config reuse).
 */
function designLootEntry(mapContext, itemClass, requested) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(itemClass)) {
    throw eventError('INVALID_CLASS_NAME', `item_class "${itemClass}" must be a plain DayZ class name`);
  }
  const spawnConfig = dataTuningService.loadSpawnConfig(mapContext.mapDir);
  const existing = spawnConfig.items[itemClass] || null;
  const MAX_NOMINAL = 100;
  let nominal = Math.min(Math.max(parseInt(requested?.nominal, 10) || (existing ? existing.nominal : 20), 1),
    existing ? existing.nominal + Math.max(1, Math.ceil(existing.nominal * 0.5)) : MAX_NOMINAL);
  let min = Math.min(Math.max(parseInt(requested?.min, 10) || (existing ? existing.min || 1 : 1), 0), nominal);
  if (min > nominal) min = nominal;
  const entry = {
    item_class: itemClass,
    nominal,
    min,
    lifetime: parseInt(requested?.lifetime, 10) || (existing ? existing.lifetime || 14400 : 14400),
    restock: parseInt(requested?.restock, 10) || (existing ? existing.restock || 1800 : 1800),
    existing: existing ? { nominal: existing.nominal, min: existing.min } : null,
  };

  // Prefer the mission's own custom/types.xml when present (that is where
  // server-specific loot lives); otherwise db/types.xml.
  const customRel = 'custom/types.xml';
  const dbRel = 'db/types.xml';
  const customContent = readMissionFile(mapContext.mapDir, customRel);
  const rel = customContent !== null ? customRel : dbRel;
  const content = customContent !== null ? customContent : readMissionFile(mapContext.mapDir, dbRel);
  if (!content) {
    throw eventError('MISSION_FILES_MISSING', `No types.xml working copy in the ${mapContext.mapName} mission`, 404);
  }

  const boundNote = existing
    ? `existing nominal ${existing.nominal} (cap +50%)`
    : `default cap ${MAX_NOMINAL}`;

  if (existing) {
    // Update the existing <type> block in place (unique block search).
    const blockRe = new RegExp(`<type name="${escapeRegex(itemClass)}"[\\s>][\\s\\S]*?</type>`, 'g');
    const matches = [...content.matchAll(blockRe)];
    if (matches.length === 0) {
      throw eventError('LOOT_BLOCK_NOT_FOUND', `"${itemClass}" exists in the spawn config but its <type> block was not found in ${rel}`);
    }
    if (matches.length > 1) {
      // Duplicate <type> blocks for the same class: editing "the block"
      // is ambiguous (which copy?). The delta validator cannot disambiguate
      // either — fail with a precise code instead of PATCH_SEARCH_AMBIGUOUS
      // deep in the patch engine.
      throw eventError('LOOT_BLOCK_AMBIGUOUS', `"${itemClass}" appears in ${matches.length} <type> blocks in ${rel}; dedupe the class before tuning it`);
    }
    const blockMatch = matches[0][0];
    const updatedBlock = blockMatch
      .replace(/<nominal>[^<]*<\/nominal>/, `<nominal>${entry.nominal}</nominal>`)
      .replace(/<min>[^<]*<\/min>/, `<min>${entry.min}</min>`);
    const applied = patchEngine.applyPatch(rel, content, {
      kind: 'xml-search-replace',
      edits: [{ search: blockMatch, replace: updatedBlock }],
    });
    const result = {
      filename: rel,
      explanation: `Adjust loot class "${itemClass}" nominal ${existing.nominal} -> ${entry.nominal} (min ${entry.min}) — bounded by the server's economy (${boundNote}).`,
      patch: { kind: 'xml-search-replace', edits: [{ search: blockMatch, replace: updatedBlock }] },
      originalContent: content,
      suggestedContent: applied.content,
      appliedEdits: applied.appliedEdits,
      baseContentHash: patchEngine.contentFingerprint(content),
      diffSummary: patchEngine.diffSummary(content, applied.content, 40),
    };
    validateSuggestedFile(result, rel, content);
    return { ...entry, suggestion: result };
  }

  const xml = buildLootTypeXml(itemClass, entry);
  const suggestion = makeAppendSuggestion(
    rel, content, xml,
    `Add loot class "${itemClass}" (nominal ${entry.nominal}, min ${entry.min}) — bounded by the server's economy (${boundNote}).`,
  );
  return { ...entry, suggestion };
}

// ─── Season planner ─────────────────────────────────────────────────────────

/** Resolve the mission working-copy dir for a map name under a server root. */
function resolveMissionDir(serverRoot, mapName) {
  const suffix = dataTuningService.MAP_FOLDER_SUFFIX[mapName];
  if (!serverRoot || !suffix) return null;
  const candidates = [suffix, path.join('config', suffix), path.join('mpmissions', suffix)];
  for (const relative of candidates) {
    try {
      const candidate = resolveExistingContainedPath(serverRoot, relative);
      if (fs.lstatSync(candidate).isDirectory()) return candidate;
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Build a reviewable markdown season plan: theme + duration -> schedule of
 * event waves across the server's mission(s) + per-mission config
 * suggestions. Pure planning + generation; no AI call.
 * @param {object} serverRoot - downloads/<guild>/server_<psid>
 * @param {string} theme
 * @param {number} durationDays
 * @returns {{ markdown: string, missions: Array<{mapName, plan, suggestions}> }}
 */
function planSeason(serverRoot, theme, durationDays) {
  const days = Math.min(Math.max(parseInt(durationDays, 10) || 30, 1), 180);
  const season = resolveSeason(theme);
  const missions = [];
  const scheduleRows = [];

  for (const mapName of Object.keys(dataTuningService.MAP_FOLDER_SUFFIX)) {
    const mapContext = { mapName, mapDir: resolveMissionDir(serverRoot, mapName) };
    if (!mapContext.mapDir) continue;
    let plan = null;
    let planError = null;
    try {
      plan = generateEventBlocks(mapContext, season.key, {});
    } catch (error) {
      planError = { code: error.code || 'PLAN_FAILED', message: error.message };
    }
    let waves = null;
    const waveLines = [];
    if (plan) {
      waves = Math.max(1, Math.min(4, Math.round(days / 7))); // ~weekly waves, capped
      for (let i = 1; i <= waves; i++) {
        const start = Math.floor((days / waves) * (i - 1));
        const end = i === waves ? days : Math.floor((days / waves) * i);
        waveLines.push(`| Wave ${i} | day ${start + 1} – ${end} | ${plan.eventName} | ${plan.groupName} |`);
        scheduleRows.push({ mission: mapName, wave: i, startDay: start + 1, endDay: end });
      }
    }
    let suggestions = null;
    let suggestionError = null;
    if (plan) {
      try {
        suggestions = materializeEventSuggestions(plan);
      } catch (error) {
        suggestionError = { code: error.code || 'MATERIALIZE_FAILED', message: error.message };
      }
    }
    missions.push({
      mapName,
      theme: season.key,
      eventName: plan ? plan.eventName : null,
      groupName: plan ? plan.groupName : null,
      waves: waves,
      durationDays: days,
      schedule: waveLines,
      blocks: plan ? plan.blocks : null,
      suggestions,
      suggestionError,
      planError,
      validation: plan ? plan.validation : null,
    });
  }
  if (!missions.length) {
    throw eventError('NO_MISSIONS', 'No mission working copies found on this server', 404);
  }

  const markdown = [
    `# Season plan — ${season.template.label} (${days} days)`,
    '',
    `Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by the dayz-dashboard event planner.`,
    '',
    `## Theme: ${season.key}`,
    season.template.label + ' — ' + seasonWaveNotes(season.key),
    '',
    `## Schedule (${missions.length} mission${missions.length > 1 ? 's' : ''})`,
    '',
    '| Mission | Window | Event | Loot group |',
    '| --- | --- | --- | --- |',
    ...scheduleRows.map(r => `| ${r.mission} | day ${r.startDay} – ${r.endDay} | wave ${r.wave} | ${missions.find(m => m.mapName === r.mission).eventName} | ${missions.find(m => m.mapName === r.mission).groupName} |`),
    '',
    '## Per-mission content blocks',
    '',
    ...missions.map(m => {
      const lines = [`### ${m.mapName}`, ''];
      if (!m.blocks) {
        lines.push(`Plan error: ${m.planError.code} — ${m.planError.message}`, '');
        return lines.join('\n');
      }
      const weatherText = Object.keys(m.blocks.weather).length
        ? 'Weather overrides (cfgweather.xml): ' + Object.entries(m.blocks.weather).map(([k, v]) => `${k} → \`${v.value}\``).join('; ')
        : 'No weather overrides for this theme (content-only event).';
      const skipText = m.validation && m.validation.weatherSkipped && m.validation.weatherSkipped.length
        ? `Skipped weather anchors not present in this mission: ${m.validation.weatherSkipped.join(', ')}.`
        : '';
      lines.push(
        `Event **${m.eventName}** (${m.waves} waves over ${m.durationDays} days):`,
        '```xml', m.blocks.event, '```',
        '',
        `Loot group **${m.groupName}**:`,
        '```xml', m.blocks.group, '```',
        '',
        weatherText,
        ...(skipText ? ['', skipText] : []),
        '',
        m.suggestions
          ? `Config suggestions: ${m.suggestions.length} patch-backed suggestion(s) ready for review (never auto-applied).`
          : `Suggestion error: ${m.suggestionError.code} — ${m.suggestionError.message}`,
        '',
      );
      return lines.join('\n');
    }),
    '',
    '## Review notes',
    '- All coordinates were validated against the mission map bounds.',
    '- All blocks were validated against the actual DayZ XML shapes in the working copy (well-formedness, unique names, CE registration where available).',
    '- Suggestions are patch-backed via the config intelligence engine; apply them from the AI config screen after review.',
  ].join('\n');

  return { markdown, missions, theme: season.key, durationDays: days };
}

function seasonWaveNotes(key) {
  switch (key) {
    case 'winter': return 'cold, snowy weather with rare rain; a supply-drop loot event and winter-camp group anchor the theme.';
    case 'storm': return 'extreme overcast, heavy rain, high wind; a military convoy crash event drops high-value military loot.';
    case 'festival': return 'content-only community event (no weather drift): a themed loot group + spawn wave.';
    case 'summer': return 'clear skies, minimal fog — a light supply cache event.';
    case 'spring': return 'mild overcast with frequent rain — a light supply cache event.';
    case 'autumn': return 'grey skies, low fog — a supply cache event with heavier weather.';
    default: return '';
  }
}

// ─── AI layer (optional, grounded) ──────────────────────────────────────────

const EVENT_SYSTEM = [
  'You are an expert DayZ server administrator assistant.',
  'You design mission event content (event spawn blocks, loot groups, weather overrides).',
  '',
  'PATCH PROTOCOL (follow exactly):',
  'Return ONE fenced ```json block containing ONLY a JSON document of this shape:',
  '{"suggestions": [{"file": "<exact filename from the request>", "rationale": "<one or two sentences>", "patch": {"kind": "xml-search-replace", "edits": [{"search": "<verbatim block copied from the file>", "replace": "<new block>"}]}}]}',
  '',
  'Rules:',
  '- Copy every "search" block verbatim from the provided files (whitespace-insensitive, unique in-file match).',
  '- The result of each patch must stay well-formed XML matching the file\'s existing element shapes EXACTLY (<group>/<child>, <event>/<zone>/<pos>, <current>/<limits> weather lines).',
  '- Never invent element names or attributes not present in the provided files.',
  '- Keep edits minimal; no prose inside the JSON block.',
].join('\n');

function buildEventPrompt(plan, mapName) {
  const b = plan.validation;
  return [
    `DESIGN AN EVENT: theme "${plan.season}" (${plan.label}) for map ${mapName}.`,
    '',
    `Map bounds (meters, keep spawns inside): x/z in [${b.mapBounds.min}, ${b.mapBounds.max}].`,
    `Existing event names (do NOT reuse): ${(plan._eventNames || []).join(', ') || '(none)'}.`,
    `Existing group names (do NOT reuse): ${(plan._groupNames || []).join(', ') || '(none)'}.`,
    '',
    'Produce ONE coherent event: an <event name="..."> block (zone + 1-6 <pos> positions inside the bounds), a <group name="..."> loot group with 3-8 <child> loot rows (plausible DayZ classes, deloot/lootmin/lootmax attributes as in the file), and optional weather <current>/<limits> overrides per the theme.',
    'New names must be unique against the existing lists above.',
  ].join('\n');
}

/**
 * AI plan with grounding: call the provider, materialize through the same
 * parse-and-materialize pipeline, then validate each suggestion. Throws with
 * a structured error the route converts to a fallback.
 */
async function planEventWithProvider(plan, mapName, files, provider) {
  const context = `--- Mission context ---\nmap=${mapName}\nexisting events: ${(plan._eventNames || []).join(', ')}\nexisting groups: ${(plan._groupNames || []).join(', ')}`;
  const messages = [
    { role: 'system', content: [EVENT_SYSTEM, '', context].join('\n') },
    { role: 'user', content: [buildEventPrompt(plan, mapName), '', ...files.map(f => `--- File: ${f.filename} ---\n\`\`\`\n${truncateForPrompt(f.content)}\n\`\`\``)].join('\n') },
  ];
  const aiService = require('./aiService');
  const response = await aiService.callProvider(messages, 0.2, provider);
  const materialized = configIntelligenceService.parseAndMaterialize(response, files);
  for (const s of materialized.suggestions) {
    validateSuggestedFile(s, s.filename, s.originalContent);
  }
  return materialized.suggestions;
}

function truncateForPrompt(content, maxChars = 20000) {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n<!-- truncated: ${content.length - maxChars} chars omitted -->`;
}

module.exports = {
  SEASONS,
  MAP_BOUNDS,
  MAX_POSITIONS_PER_EVENT,
  mapBounds,
  validateMapCoordinate,
  resolveMissionDir,
  parseEventSpawns,
  parseEventGroups,
  parseGroupNames,
  generateEventBlocks,
  materializeEventSuggestions,
  designSpawnGroup,
  designLootEntry,
  planSeason,
  planEventWithProvider,
  validateSuggestedFile,
  ceRegistrationNote,
  eventError,
};
