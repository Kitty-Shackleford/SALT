'use strict';

/*
 * event-content-test.js
 *
 * Unit + route tests for event/content generation (AI feature 5/7).
 *
 *   - map-coordinate validation against mission map bounds
 *   - deterministic event generation (cfgeventgroups / cfgeventspawns /
 *     cfgweather blocks) validated against fixture mission files that
 *     mirror the real dayzOffline.enoch shapes (including the comment-
 *     interleaved weather sections)
 *   - patch materialization through the feature-2 engine: every generated
 *     block is a well-formed, unique-search xml-search-replace patch
 *   - spawn point designer (bounds-checked positions, unique group names,
 *     name-collision handling incl. commented-out groups)
 *   - loot table designer (economy bounds: existing nominal cap, min<=nominal)
 *   - season planner (markdown schedule + per-mission suggestions)
 *   - HTTP routes: registered, exact-server gated, deterministic baseline,
 *     AI plan with grounded prompt (stubbed provider), AI-failure fallback
 *
 * No external fixture dir required: all working-copy content is built
 * inline so the suite is portable to any checkout.
 */

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const ROOT = path.join(__dirname, '..');
const svc = require(path.join(ROOT, 'services', 'eventContentService'));

// ─── Fixtures (shapes mirrored from dayzOffline.enoch) ──────────────────────

function fixtureWeather() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<weather reset="1" enable="1">',
    '  <overcast>',
    '    <!-- Initial conditions of the overcast -->',
    '    <current actual="0.3" time="120" duration="600"/>',
    '    <!-- What is the range of the overcast value (0..1) -->',
    '    <limits min="0.1" max="0.7"/>',
    '    <timelimits min="900" max="1800"/>',
    '    <changelimits min="0.0" max="0.5"/>',
    '  </overcast>',
    '  <fog>',
    '    <current actual="0.0" time="120" duration="600"/>',
    '    <limits min="0.0" max="0.05"/>',
    '    <timelimits min="1200" max="1800"/>',
    '    <changelimits min="0.0" max="0.05"/>',
    '  </fog>',
    '  <rain>',
    '    <current actual="0.0" time="1800" duration="180"/>',
    '    <limits min="0.4" max="0.7"/>',
    '    <timelimits min="60" max="180"/>',
    '    <changelimits min="0.0" max="0.6"/>',
    '    <thresholds min="0.6" max="1.0" end="60"/>',
    '  </rain>',
    '  <snowfall>',
    '    <current actual="0.0" time="120" duration="0"/>',
    '    <limits min="0.0" max="0.0"/>',
    '    <timelimits min="1200" max="1800"/>',
    '    <changelimits min="0.0" max="0.5"/>',
    '    <thresholds min="0.7" max="1.0" end="120"/>',
    '  </snowfall>',
    '  <windMagnitude>',
    '    <current actual="5.0" time="120" duration="600"/>',
    '    <limits min="0.0" max="20.0"/>',
    '    <timelimits min="600" max="1200"/>',
    '    <changelimits min="0.0" max="15.0"/>',
    '  </windMagnitude>',
    '  <windDirection>',
    '    <current actual="0.0" time="120" duration="600"/>',
    '    <limits min="0.0" max="360.0"/>',
    '    <timelimits min="600" max="1200"/>',
    '    <changelimits min="0.0" max="360.0"/>',
    '  </windDirection>',
    '</weather>',
  ].join('\n');
}

function fixtureEventSpawns() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<eventposdef>',
    '  <event name="StaticMi8Crash">',
    '    <zone smin="1" smax="3" dmin="3" dmax="5" r="45"/>',
    '    <pos x="11844.371094" z="6020.828613" a="357.697601"/>',
    '    <pos x="10772.458984" z="7141.783691" a="236.599503"/>',
    '  </event>',
    '  <event name="StaticSantaCrash">',
    '    <zone smin="1" smax="2" dmin="4" dmax="6" r="45"/>',
    '    <pos x="6357.467285" z="5393.447754" a="4.996732"/>',
    '  </event>',
    '</eventposdef>',
  ].join('\n');
}

function fixtureEventGroups() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<eventgroupdef>',
    '  <group name="SupplyTruck_grabin">',
    '    <child type="Land_wreck_truck01_aban1_blue" deloot="0" lootmax="3" lootmin="1" x="1.42" z="5.35" a="184.77" y="-0.62"/>',
    '    <child type="Pliers" deloot="0" lootmax="3" lootmin="1" x="0" z="0" a="148.77" y="0"/>',
    '  </group>',
    '</eventgroupdef>',
  ].join('\n');
}

function fixturePlayerSpawns() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<playerspawnpoints>',
    '  <fresh>',
    '    <spawn_params>',
    '      <min_dist_infected>30</min_dist_infected>',
    '    </spawn_params>',
    '    <generator_params>',
    '      <grid_density>4</grid_density>',
    '    </generator_params>',
    '    <group_params>',
    '      <enablegroups>true</enablegroups>',
    '    </group_params>',
    '    <generator_posbubbles>',
    '      <!--',
    '      <group name="EastTopolin" lifetime="240" counter="-1">',
    '        <pos x="1136.6" z="8039.6"/>',
    '      </group>',
    '      -->',
    '      <group name="EastGrabin" lifetime="-1" counter="1">',
    '        <pos x="10563.3" z="10836.6"/>',
    '      </group>',
    '    </generator_posbubbles>',
    '  </fresh>',
    '</playerspawnpoints>',
  ].join('\n');
}

function fixtureTypes() {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<types>',
    '  <type name="TestItem_A">',
    '    <nominal>10</nominal>',
    '    <min>2</min>',
    '    <lifetime>14400</lifetime>',
    '    <restock>1800</restock>',
    '  </type>',
    '</types>',
  ].join('\n');
}

/** Build a temp working copy under downloads/<guild>/server_<psid>/. */
function buildTempWorkingCopy(guildId, psid, mapName) {
  const serverRoot = path.join(ROOT, 'downloads', guildId, `server_${psid}`);
  const mapDir = path.join(serverRoot, `dayzOffline.${mapName}`);
  fs.mkdirSync(mapDir, { recursive: true });
  fs.mkdirSync(path.join(mapDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(mapDir, 'custom'), { recursive: true });
  fs.writeFileSync(path.join(mapDir, 'cfgweather.xml'), fixtureWeather());
  fs.writeFileSync(path.join(mapDir, 'cfgeventspawns.xml'), fixtureEventSpawns());
  fs.writeFileSync(path.join(mapDir, 'cfgeventgroups.xml'), fixtureEventGroups());
  fs.writeFileSync(path.join(mapDir, 'cfgplayerspawnpoints.xml'), fixturePlayerSpawns());
  fs.writeFileSync(path.join(mapDir, 'db', 'types.xml'), fixtureTypes());
  return { serverRoot, mapDir };
}

function tempMapContext() {
  const guildId = `test_ec_${Date.now()}`;
  const psid = '90000001';
  const { mapDir } = buildTempWorkingCopy(guildId, psid, 'enoch');
  return { mapName: 'enoch', mapDir, cleanup: () => fs.rmSync(path.join(ROOT, 'downloads', guildId), { recursive: true, force: true }) };
}

function makeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

// ─── Unit tests ─────────────────────────────────────────────────────────────

function throwsWith(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return;
  }
  assert.fail(`expected throw with code ${code}`);
}

function testMapCoordinateValidation() {
  // enoch bounds: 0..12800 (margins 500).
  assert.doesNotThrow(() => svc.validateMapCoordinate('enoch', 6400, 6400));
  assert.doesNotThrow(() => svc.validateMapCoordinate('enoch', 12000, 800));
  throwsWith(() => svc.validateMapCoordinate('enoch', 12900, 6400), 'COORD_OUT_OF_BOUNDS');
  throwsWith(() => svc.validateMapCoordinate('enoch', -50, 6400), 'COORD_OUT_OF_BOUNDS');
  throwsWith(() => svc.validateMapCoordinate('enoch', NaN, 6400), 'COORD_OUT_OF_BOUNDS');
  // Unknown map.
  throwsWith(() => svc.validateMapCoordinate('notamap', 100, 100), 'MAP_UNKNOWN');
  console.log('✓ map coordinate validation (bounds + unknown map)');
}

function testEventGenerationDeterministic() {
  const ctx = tempMapContext();
  try {
    const plan = svc.generateEventBlocks(ctx, 'winter', {});
    assert.equal(plan.season, 'winter');
    assert.equal(plan.eventName, 'StaticWinterStorm');
    assert.equal(plan.groupName, 'WinterSupplyDrop');
    assert.ok(plan.blocks.event.includes('<event name="StaticWinterStorm">'), 'event block has event tag');
    assert.ok(plan.blocks.event.includes('<zone smin="1" smax="2" dmin="4" dmax="6" r="45"/>'), 'zone shape');
    assert.ok(plan.blocks.event.includes('<pos x="'), 'pos rows present');
    assert.ok(plan.blocks.group.includes('<group name="WinterSupplyDrop">'), 'group block');
    assert.ok(plan.blocks.group.includes('<child type="'), 'loot children');
    assert.ok(plan.blocks.weather['snowfall.current'], 'winter -> snowfall override');
    assert.ok(plan.blocks.weather['overcast.current'], 'winter -> overcast override');
    assert.equal(plan.validation.existingEvents, 2, 'parsed existing events from fixture');
    assert.equal(plan.validation.existingGroups, 1, 'parsed existing groups from fixture');

    // Materialize: every suggestion is a validated patch.
    const suggestions = svc.materializeEventSuggestions(plan);
    assert.ok(suggestions.length >= 3, `expected >=3 suggestions (event+group+weather), got ${suggestions.length}`);
    const filenames = suggestions.map(s => s.filename);
    assert.ok(filenames.includes('cfgeventspawns.xml'));
    assert.ok(filenames.includes('cfgeventgroups.xml'));
    assert.ok(filenames.includes('cfgweather.xml'));
    for (const s of suggestions) {
      assert.ok(s.patch.kind === 'xml-search-replace');
      assert.ok(s.suggestedContent.length > s.originalContent.length || s.filename === 'cfgweather.xml', 'content grew or swapped');
      assert.ok(s.baseContentHash.length === 64, 'base hash pinned');
      assert.ok(s.diffSummary && s.diffSummary.summary, 'diff summary present');
      // The suggested content must still parse as well-formed XML.
      const { XMLValidator } = require(path.join(ROOT, 'node_modules', 'fast-xml-parser'));
      assert.equal(XMLValidator.validate(s.suggestedContent, { allowBooleanAttributes: true }), true, `well-formed ${s.filename}`);
    }
    // Weather edits must have swapped only the target line inside the section.
    const weatherEdits = suggestions.filter(s => s.filename === 'cfgweather.xml');
    assert.equal(weatherEdits.length, 8, 'winter template -> 8 weather edits (4 sections x current+limits)');
    console.log('✓ event generation (winter) deterministic + materialized');
  } finally {
    ctx.cleanup();
  }
}

function testEventGenerationNameCollision() {
  const ctx = tempMapContext();
  try {
    // Force collision: StaticWinterStorm exists -> suffix appended.
    const mapDir = ctx.mapDir;
    const spawns = fs.readFileSync(path.join(mapDir, 'cfgeventspawns.xml'), 'utf8');
    fs.writeFileSync(path.join(mapDir, 'cfgeventspawns.xml'),
      spawns.replace('</eventposdef>', '  <event name="StaticWinterStorm"><zone smin="1" smax="2" dmin="4" dmax="6" r="45"/><pos x="100.0" z="100.0" a="0"/></event>\n</eventposdef>'));
    const plan = svc.generateEventBlocks(ctx, 'winter', {});
    assert.equal(plan.eventName, 'StaticWinterStorm_2', `collision suffix, got ${plan.eventName}`);
  } finally {
    ctx.cleanup();
  }
}

function testEventCustomPositions() {
  const ctx = tempMapContext();
  try {
    const ok = svc.generateEventBlocks(ctx, 'storm', {
      eventPositions: [[3000, 4000, 90], [5000, 5000, 10]],
    });
    assert.equal(ok.season, 'storm');
    assert.ok(ok.blocks.event.includes('x="3000"'), 'custom position x');
    assert.ok(ok.blocks.event.includes('z="4000"'), 'custom position z');
    throwsWith(() => svc.generateEventBlocks(ctx, 'storm', { eventPositions: [[99999, 5000]] }), 'COORD_OUT_OF_BOUNDS');
  } finally {
    ctx.cleanup();
  }
}

function testUnknownTheme() {
  const ctx = tempMapContext();
  try {
    throwsWith(() => svc.generateEventBlocks(ctx, 'monsoon', {}), 'SEASON_UNKNOWN');
  } finally {
    ctx.cleanup();
  }
}

function testSpawnGroupDesign() {
  const ctx = tempMapContext();
  try {
    const designed = svc.designSpawnGroup(ctx, 'TestZone A', [[2000, 3000], [4000, 5000]], { lifetime: 300 });
    assert.equal(designed.name, 'TestZone_A', 'name sanitized');
    assert.equal(designed.positions.length, 2);
    assert.ok(designed.suggestion.suggestedContent.includes('<group name="TestZone_A" lifetime="300" counter="-1">'));
    assert.ok(designed.suggestion.suggestedContent.includes('<pos x="2000" z="3000"/>'));

    // Collision with an EXISTING (uncommented) group.
    const again = svc.designSpawnGroup(ctx, 'EastGrabin', [[2000, 3000]]);
    assert.equal(again.name, 'EastGrabin_2', `collision with existing group, got ${again.name}`);

    // Out-of-bounds position rejected.
    throwsWith(() => svc.designSpawnGroup(ctx, 'Bad', [[20000, 3000]]), 'COORD_OUT_OF_BOUNDS');
    // No positions.
    throwsWith(() => svc.designSpawnGroup(ctx, 'Empty', []), 'NO_POSITIONS');
  } finally {
    ctx.cleanup();
  }
}

function testLootDesignEconomyBounds() {
  const ctx = tempMapContext();
  try {
    // New class: bounded by default cap.
    const fresh = svc.designLootEntry(ctx, 'NewItem_X', { nominal: 5000 });
    assert.equal(fresh.nominal, 100, 'new class clamped to cap');
    assert.ok(fresh.suggestion.suggestedContent.includes('<type name="NewItem_X">'));

    // Existing class: updated in place, bounded by existing nominal (+50%).
    const bump = svc.designLootEntry(ctx, 'TestItem_A', { nominal: 50 });
    assert.ok(bump.nominal <= 15, `existing-class bound, got ${bump.nominal}`);
    assert.equal(bump.nominal, 15, 'capped at existing +50%');
    assert.ok(bump.suggestion.explanation.includes('Adjust loot class'), 'in-place adjustment');
    assert.ok(bump.suggestion.suggestedContent.includes('<nominal>15</nominal>'), 'nominal updated in block');
    assert.ok(bump.existing && bump.existing.nominal === 10, 'existing recorded');

    // min cannot exceed nominal.
    const capped = svc.designLootEntry(ctx, 'NewItem_Y', { nominal: 2, min: 9 });
    assert.ok(capped.min <= capped.nominal, 'min<=nominal');

    // Invalid class name.
    throwsWith(() => svc.designLootEntry(ctx, 'Bad/Name', {}), 'INVALID_CLASS_NAME');
  } finally {
    ctx.cleanup();
  }
}

function testSeasonPlan() {
  const guildId = `test_ec_sp_${Date.now()}`;
  const psid = '90000002';
  const { serverRoot } = buildTempWorkingCopy(guildId, psid, 'enoch');
  try {
    const result = svc.planSeason(serverRoot, 'winter', 28);
    assert.equal(result.theme, 'winter');
    assert.equal(result.durationDays, 28);
    assert.equal(result.missions.length, 1);
    const mission = result.missions[0];
    assert.equal(mission.mapName, 'enoch');
    assert.equal(mission.waves, 4, '28 days -> 4 waves');
    assert.ok(result.markdown.includes('# Season plan'), 'markdown title');
    assert.ok(result.markdown.includes('| Mission | Window | Event | Loot group |'), 'schedule table');
    assert.ok(mission.suggestions && mission.suggestions.length >= 3, 'suggestions generated');
    assert.ok(result.markdown.includes(mission.eventName));
  } finally {
    fs.rmSync(path.join(ROOT, 'downloads', guildId), { recursive: true, force: true });
  }
}

// ─── Real-data regression tests (found via live check in production) ───────

function testRootTagOnFirstLine() {
  // chernarusplus working copies open as `<?xml ...?><eventposdef>` on ONE
  // line; the old rootTagOf matched the declaration and anchored the
  // append patch on `</event>` (41 matches -> PATCH_SEARCH_AMBIGUOUS).
  const ctx = tempMapContext();
  try {
    for (const [file] of [['cfgeventspawns.xml'], ['cfgeventgroups.xml']]) {
      const content = fs.readFileSync(path.join(ctx.mapDir, file), 'utf8');
      fs.writeFileSync(path.join(ctx.mapDir, file),
        content.replace(/^\s*<\?xml[^>]*>\s*\n</, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><'));
    }
    const spawns = fs.readFileSync(path.join(ctx.mapDir, 'cfgeventspawns.xml'), 'utf8');
    assert.ok(/^<\?xml[^>]*><eventposdef>/.test(spawns), 'declaration + root on one line');
    const plan = svc.generateEventBlocks(ctx, 'winter', {});
    const suggestions = svc.materializeEventSuggestions(plan);
    const append = suggestions.filter(s => s.filename === 'cfgeventspawns.xml');
    assert.equal(append.length, 1);
    assert.ok(append[0].suggestedContent.includes('StaticWinterStorm'), 'event appended after real root fix');
  } finally {
    ctx.cleanup();
  }
}

function testWeatherAnchorSkipped() {
  // sakhal's cfgweather.xml uses <limit> instead of <limits> in <snowfall>
  // and omits <windmagnitude> entirely: the template anchors are missing.
  // Expected: the missing overrides are SKIPPED (recorded in
  // validation.weatherSkipped), the event still generates with its
  // remaining weather edits — no WEATHER_ANCHOR_MISSING throw.
  const ctx = tempMapContext();
  try {
    const mapDir = ctx.mapDir;
    let weather = fs.readFileSync(path.join(mapDir, 'cfgweather.xml'), 'utf8');
    weather = weather.replace('<limits min="0.0" max="0.0"/>', '<limit min="0.0" max="0.0"/>');
    weather = weather.replace(/  <windMagnitude>[\s\S]*?<\/windMagnitude>\n/, '');
    fs.writeFileSync(path.join(mapDir, 'cfgweather.xml'), weather);

    const plan = svc.generateEventBlocks(ctx, 'winter', {});
    assert.ok(plan.validation.weatherSkipped.includes('snowfall.limits'), 'snowfall.limits skipped');
    assert.ok(plan.validation.weatherSkipped.includes('windMagnitude.current'), 'windMagnitude.current skipped');
    assert.ok(plan.validation.weatherSkipped.includes('windMagnitude.limits'), 'windMagnitude.limits skipped');
    assert.ok(plan.blocks.weather['snowfall.current'], 'snowfall.current still present');

    const suggestions = svc.materializeEventSuggestions(plan);
    const weatherEdits = suggestions.filter(s => s.filename === 'cfgweather.xml');
    assert.equal(weatherEdits.length, 5, `5 weather edits (8 minus 3 skipped), got ${weatherEdits.length}`);
    assert.ok(suggestions.some(s => s.filename === 'cfgeventspawns.xml'), 'event suggestion intact');
  } finally {
    ctx.cleanup();
  }
}

function testPreExistingErrorsDoNotFailSuggestion() {
  // enoch's custom/types.xml already carries error-level findings
  // (TYPE_DUPLICATE). A suggestion must fail only when it INTRODUCES
  // errors, not because the working copy was already invalid.
  // NOTE: the spawn CONFIG (db/types.xml) is where existing-class
  // detection comes from — keep DupClass OUT of it so FreshClass
  // exercises the append path.
  const ctx = tempMapContext();
  try {
    const mapDir = ctx.mapDir;
    fs.writeFileSync(path.join(mapDir, 'db', 'types.xml'), [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<types>',
      '  <type name="SpawnConfigClass"><nominal>10</nominal><min>1</min><lifetime>14400</lifetime><restock>1800</restock></type>',
      '</types>',
    ].join('\n'));
    const withDup = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<types>',
      '  <type name="DupClass"><nominal>5</nominal><min>1</min><lifetime>14400</lifetime><restock>1800</restock></type>',
      '  <type name="DupClass"><nominal>5</nominal><min>1</min><lifetime>14400</lifetime><restock>1800</restock></type>',
      '</types>',
    ].join('\n');
    fs.writeFileSync(path.join(mapDir, 'custom', 'types.xml'), withDup);

    // Fresh class appended to the already-invalid file: the TYPE_DUPLICATE
    // finding is PRE-EXISTING (count unchanged) -> suggestion must pass.
    const fresh = svc.designLootEntry(ctx, 'FreshClass', { nominal: 30 });
    assert.equal(fresh.nominal, 30);
    assert.equal(fresh.suggestion.filename, 'custom/types.xml');
    assert.ok(fresh.suggestion.suggestedContent.includes('<type name="FreshClass">'));
    // And the pre-existing duplicate must be untouched in the output.
    assert.equal((fresh.suggestion.suggestedContent.match(/name="DupClass"/g) || []).length, 2);
  } finally {
    ctx.cleanup();
  }
}

function testPreExistingErrorDeltaRejection() {
  // In-place editing of a class with DUPLICATE <type> blocks is ambiguous
  // by definition (which copy do we edit?) -> LOOT_BLOCK_AMBIGUOUS, never
  // a PATCH_SEARCH_AMBIGUOUS from deep in the patch engine.
  const ctx = tempMapContext();
  try {
    const mapDir = ctx.mapDir;
    // DupClass is in the SPAWN CONFIG (db/types.xml) so designLootEntry
    // takes the in-place branch, and its <type> block is duplicated in
    // custom/types.xml where the edit would land.
    const dupBlock = '  <type name="DupClass"><nominal>5</nominal><min>1</min><lifetime>14400</lifetime><restock>1800</restock></type>';
    fs.writeFileSync(path.join(mapDir, 'db', 'types.xml'), [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<types>',
      dupBlock,
      '</types>',
    ].join('\n'));
    fs.writeFileSync(path.join(mapDir, 'custom', 'types.xml'), [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<types>',
      dupBlock,
      dupBlock,
      '</types>',
    ].join('\n'));
    throwsWith(() => svc.designLootEntry(ctx, 'DupClass', { nominal: 30 }), 'LOOT_BLOCK_AMBIGUOUS');
  } finally {
    ctx.cleanup();
  }
  // And the VALIDATION_FAILED delta path: a suggestion that INCREASES the
  // error count over the original content is rejected (validates a pre-
  // existing-error file + a newly-introduced duplicate).
  const okFile = 'db/types.xml';
  const original = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<types>',
    '  <type name="DupClass"><nominal>5</nominal><min>1</min></type>',
    '  <type name="DupClass"><nominal>5</nominal><min>1</min></type>',
    '</types>',
  ].join('\n'); // 1 pre-existing TYPE_DUPLICATE error
  const suggested = original.replace('</types>',
    '  <type name="DupClass"><nominal>9</nominal><min>1</min></type>\n</types>'); // 2 now
  const okShape = { filename: okFile, suggestedContent: original, patch: { kind: 'xml-search-replace', edits: [] } };
  assert.doesNotThrow(() => svc.validateSuggestedFile(okShape, okFile, original), 'unchanged error count tolerated');
  throwsWith(() => svc.validateSuggestedFile({ ...okShape, suggestedContent: suggested }, okFile, original), 'VALIDATION_FAILED');
}

function testCeMissionUnresolvedIsNotAFailure() {
  // Flat working copies (dayzOffline.<map>/ directly under the server root,
  // no mpmissions/<id>/ component) cannot be CE-typed by
  // missionFileInspectionService: the diagnostic is CE_MISSION_UNRESOLVED.
  // That is informational — validation of the content itself still applies —
  // so ceRegistrationNote must report ok:true.
  const ctx = tempMapContext();
  try {
    const plan = svc.generateEventBlocks(ctx, 'winter', {});
    for (const key of ['cfgeventspawns', 'cfgeventgroups', 'cfgweather']) {
      assert.equal(plan.validation.ce[key].ok, true, `${key} CE note ok despite CE_MISSION_UNRESOLVED`);
    }
  } finally {
    ctx.cleanup();
  }
}

// ─── Route tests ────────────────────────────────────────────────────────────

function findHandler(router, method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `route ${method} ${routePath} registered`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function testRoutes() {
  const router = require(path.join(ROOT, 'routes', 'ai'));
  const guildId = `test_ec_rt_${Date.now()}`;
  const psid = '90000003';
  const { serverRoot } = buildTempWorkingCopy(guildId, psid, 'enoch');

  const capturedGroups = [];
  const db = {
    query: async (sql, params) => {
      if (/INSERT INTO ai_suggestion_groups/i.test(sql)) { capturedGroups.push({ sql, params }); return [{ id: 99 }]; }
      if (/INSERT INTO ai_suggestions/i.test(sql)) return [{ id: 1000 + capturedGroups.length * 10 }];
      return [];
    },
  };
  const reqBase = {
    app: { locals: { db } },
    user: { id: 1 },
    platformServerAccess: { serverId: 7, guildId: 1, discordGuildId: guildId, platformServerId: psid },
    params: { platformServerId: psid },
  };

  const aiProviderService = require(path.join(ROOT, 'services', 'aiProviderService'));
  const aiService = require(path.join(ROOT, 'services', 'aiService'));
  const originalResolve = aiProviderService.resolveUserProvider;
  const originalCall = aiService.callProvider;

  try {
    // ── event-generate: deterministic baseline (no provider) ──
    const genHandler = findHandler(router, 'post', '/event-generate/:platformServerId');
    aiProviderService.resolveUserProvider = async () => null;
    const genRes = makeRes();
    await genHandler({ ...reqBase, body: { theme: 'winter' } }, genRes);
    assert.equal(genRes.statusCode, 200, `event-generate 200: ${JSON.stringify(genRes.body)}`);
    assert.equal(genRes.body.theme, 'winter');
    assert.equal(genRes.body.map, 'enoch');
    assert.ok(Array.isArray(genRes.body.suggestions) && genRes.body.suggestions.length >= 3);
    assert.equal(genRes.body.groupId, 99);
    assert.equal(genRes.body.planError, null);
    assert.ok(genRes.body.suggestions[0].prediction, 'prediction stored');

    // Unknown theme -> 400.
    const badTheme = makeRes();
    await genHandler({ ...reqBase, body: { theme: 'monsoon' } }, badTheme);
    assert.equal(badTheme.statusCode, 400);
    assert.ok(Array.isArray(badTheme.body.themes));

    // ── event-generate: AI plan via stubbed provider (grounded) ──
    aiProviderService.resolveUserProvider = async () => ({ type: 'openai-compatible', source: 'user', apiKey: 'k', baseURL: 'https://x.test/v1/', model: 'm' });
    aiService.callProvider = async () => '```json\n' + JSON.stringify({
      suggestions: [{
        file: 'cfgeventspawns.xml',
        rationale: 'AI winter crash event.',
        patch: { kind: 'xml-search-replace', edits: [{
          search: '</eventposdef>',
          replace: '  <event name="StaticWinterCrash"><zone smin="1" smax="2" dmin="4" dmax="6" r="45"/><pos x="3000.0" z="3000.0" a="10"/></event>\n</eventposdef>',
        }] },
      }],
    }) + '\n```';
    const aiRes = makeRes();
    await genHandler({ ...reqBase, body: { theme: 'winter' } }, aiRes);
    assert.equal(aiRes.statusCode, 200, `AI event-generate 200: ${JSON.stringify(aiRes.body)}`);
    assert.equal(aiRes.body.source, 'user');
    assert.equal(aiRes.body.suggestions.length, 1, 'AI plan replaced deterministic');
    assert.ok(aiRes.body.suggestions[0].explanation.includes('winter crash'));

    // ── event-generate: AI failure falls back to deterministic ──
    aiService.callProvider = async () => 'I cannot do that';
    const fallbackRes = makeRes();
    await genHandler({ ...reqBase, body: { theme: 'winter' } }, fallbackRes);
    assert.equal(fallbackRes.statusCode, 200);
    assert.ok(fallbackRes.body.planError, 'planError set on AI failure');
    assert.ok(fallbackRes.body.suggestions.length >= 3, 'deterministic fallback intact');

    // ── spawn-design ──
    const spawnHandler = findHandler(router, 'post', '/spawn-design/:platformServerId');
    const spawnRes = makeRes();
    await spawnHandler({ ...reqBase, body: { name: 'SafeZone', positions: [[2000, 2000], [3000, 3000]] } }, spawnRes);
    assert.equal(spawnRes.statusCode, 200, JSON.stringify(spawnRes.body));
    assert.equal(spawnRes.body.name, 'SafeZone');
    assert.equal(spawnRes.body.suggestions.length, 1);
    const oobRes = makeRes();
    await spawnHandler({ ...reqBase, body: { name: 'Bad', positions: [[99999, 2000]] } }, oobRes);
    assert.equal(oobRes.statusCode, 422, 'out-of-bounds rejected');
    const noPos = makeRes();
    await spawnHandler({ ...reqBase, body: { name: 'NoPos', positions: [] } }, noPos);
    assert.equal(noPos.statusCode, 400);

    // ── loot-design ──
    const lootHandler = findHandler(router, 'post', '/loot-design/:platformServerId');
    const lootRes = makeRes();
    await lootHandler({ ...reqBase, body: { item_class: 'WinterItem', nominal: 999 } }, lootRes);
    assert.equal(lootRes.statusCode, 200, JSON.stringify(lootRes.body));
    assert.equal(lootRes.body.item.nominal, 100, 'clamped to cap');
    // Existing class -> in-place adjustment bounded by economy.
    const adjRes = makeRes();
    await lootHandler({ ...reqBase, body: { item_class: 'TestItem_A', nominal: 999 } }, adjRes);
    assert.equal(adjRes.statusCode, 200, JSON.stringify(adjRes.body));
    assert.equal(adjRes.body.item.nominal, 15, 'existing +50% cap');

    // ── season-plan ──
    const seasonHandler = findHandler(router, 'post', '/season-plan/:platformServerId');
    const seasonRes = makeRes();
    await seasonHandler({ ...reqBase, body: { theme: 'winter', duration_days: 21 } }, seasonRes);
    assert.equal(seasonRes.statusCode, 200, JSON.stringify(seasonRes.body));
    assert.ok(seasonRes.body.markdown.includes('# Season plan'));
    assert.equal(seasonRes.body.missions.length, 1);
    assert.ok(seasonRes.body.missions[0].group, 'per-mission suggestion group stored');
    assert.equal(seasonRes.body.missions[0].waves, 3, '21 days -> 3 waves');

    console.log('✓ routes: event-generate / spawn-design / loot-design / season-plan (temp tree + stubbed provider)');
  } finally {
    aiProviderService.resolveUserProvider = originalResolve;
    aiService.callProvider = originalCall;
    fs.rmSync(serverRoot, { recursive: true, force: true });
  }
}

// ─── Run ────────────────────────────────────────────────────────────────────

(async () => {
  const tests = [
    testMapCoordinateValidation,
    testEventGenerationDeterministic,
    testEventGenerationNameCollision,
    testEventCustomPositions,
    testUnknownTheme,
    testSpawnGroupDesign,
    testLootDesignEconomyBounds,
    testSeasonPlan,
    testRootTagOnFirstLine,
    testWeatherAnchorSkipped,
    testPreExistingErrorsDoNotFailSuggestion,
    testPreExistingErrorDeltaRejection,
    testCeMissionUnresolvedIsNotAFailure,
  ];
  for (const t of tests) t();
  await testRoutes();
  console.log(`\nALL ${tests.length + 1} TEST GROUPS PASSED`);
})().catch(err => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
