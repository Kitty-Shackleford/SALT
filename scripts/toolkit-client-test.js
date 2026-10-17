#!/usr/bin/env node
'use strict';

/*
 * Client-side DayZ Toolkit tests.
 *
 * Exercises public/js/tools/toolkit-core.js (the browser validation engine)
 * in Node via its UMD export, with an xml2js-backed parser adapter that
 * mirrors the browser DOMParser path (well-formedness + single-root check,
 * same contract as services/validationService.js). Also enforces the
 * client-side security contract on the shipped toolkit pages/scripts:
 * no eval, no network, no innerHTML with user data, no inline scripts.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

const ROOT = path.resolve(__dirname, '..');
const core = require(path.join(ROOT, 'public', 'js', 'tools', 'toolkit-core.js'));

function pass(name) {
  console.log(`  ✓ ${name}`);
}

/* ------------------------------------------------------------------ *
 * xml2js parser adapter (browser-equivalent)                          *
 * ------------------------------------------------------------------ */
function makeXml2jsParser() {
  return function parse(content) {
    try {
      const parser = new xml2js.Parser({ strict: true, explicitArray: true });
      const stream = parser.saxParser;
      const open = stream.onopentag;
      const close = stream.onclosetag;
      let depth = 0;
      let roots = 0;
      stream.onopentag = (node) => {
        if (depth === 0 && ++roots > 1) throw new Error('XML must have exactly one root element');
        depth++;
        open(node);
      };
      stream.onclosetag = (name) => {
        close(name);
        depth--;
      };
      parser.on('error', (error) => { throw error; });
      stream.write(content).close();
      const model = toModel(parser.resultObject);
      model.sourceText = content; // comment-position source for analyzeEvents
      return { ok: true, model };
    } catch (error) {
      return { ok: false, error: { message: error.message } };
    }
  };
}

function toModel(object) {
  const [rootTag, rootValue] = Object.entries(object)[0];
  // explicitArray wraps child elements in arrays, but the single root is a bare node.
  const rootNode = Array.isArray(rootValue) ? rootValue[0] : rootValue;
  return nodeToModel(rootTag, rootNode);
}

function nodeToModel(tag, node) {
  const attrs = { ...(node.$ || {}) };
  const children = [];
  let text = '';
  for (const [key, value] of Object.entries(node)) {
    if (key === '$') continue;
    if (key === '#text') {
      text += Array.isArray(value) ? value.join('') : String(value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        // explicitArray encodes bare text content of a leaf element as
        // { tag: ['text'] } — a string, not a node.
        children.push(typeof child === 'string'
          ? { tag: key, attrs: {}, children: [], text: child.trim() }
          : nodeToModel(key, child));
      }
    }
  }
  return { tag, attrs, children, text: text.trim() };
}

const parser = makeXml2jsParser();

/* ------------------------------------------------------------------ *
 * Fixtures                                                            *
 * ------------------------------------------------------------------ */
const GOOD_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<types>
  <type name="GoodLoot_Crate">
    <nominal>5</nominal>
    <lifetime>24</lifetime>
    <min>2</min>
  </type>
  <type name="GoodLoot_Box">
    <nominal>3</nominal>
    <min>0</min>
  </type>
</types>
`;

const DUP_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<types>
  <type name="DupLoot"><nominal>1</nominal></type>
  <type name="DupLoot"><nominal>2</nominal></type>
</types>
`;

const BAD_CLASSNAME_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<types>
  <type name="not-a-valid-class"><nominal>1</nominal></type>
</types>
`;

const MIN_GT_NOMINAL = `<?xml version="1.0" encoding="UTF-8"?>
<types>
  <type name="WeirdLoot">
    <nominal>1</nominal>
    <min>5</min>
  </type>
</types>
`;

const MALFORMED = `<?xml version="1.0" encoding="UTF-8"?>
<types>
  <type name="Broken">
</types>
`;

const TWO_ROOTS = `<a/><b/>`;

const WRONG_ROOT = `<?xml version="1.0" encoding="UTF-8"?>
<notypes>
  <type name="X"><nominal>1</nominal></type>
</notypes>
`;

const GOOD_SPAWNS = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<eventposdef>
  <event name="VehicleCivilianSedan">
    <pos x="12071.93" z="9129.98" a="317.95" />
    <pos x="3302.41" z="15085.14" a="196.33" />
  </event>
</eventposdef>
`;

const BAD_SPAWN_COORDS = `<?xml version="1.0" encoding="UTF-8"?>
<eventposdef>
  <event name="VehicleBroken">
    <pos x="12.5" z="not-a-number" a="1" />
  </event>
</eventposdef>
`;

const OOB_SPAWNS = `<?xml version="1.0" encoding="UTF-8"?>
<eventposdef>
  <event name="VehicleFarAway">
    <pos x="20000" z="5000" a="0" />
  </event>
</eventposdef>
`;

const GROUPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<eventgroupdef>
  <!--pos x="11254.230" z="3290.319" a="0" y="6.546" group="Train_Abandoned_Kamy"/-->
  <group name="Train_Abandoned_Kamy">
    <child type="Land_Train_Wagon_Box_DE" deloot="0" lootmax="3" lootmin="2" x="0" z="0" a="0" y="1" />
  </group>
  <!--pos x="99999" z="10" a="0" y="1" group="Train_FarAway"/-->
  <group name="Train_FarAway">
    <child type="Land_Container_1Aoh_DE" deloot="0" lootmax="1" lootmin="3" x="1" z="1" a="0" y="0.2" />
  </group>
  <!--pos x="11254.230" z="3290.319" a="0" y="6.546" group="Train_Abandoned_Kamy"/-->
  <group name="Train_Abandoned_Kamy">
    <child type="Land_Train_Wagon_Box_DE" deloot="0" lootmax="3" lootmin="1" x="0" z="0" a="0" y="1" />
  </group>
</eventgroupdef>
`;

const GOOD_GLOBALS = `<?xml version="1.0" encoding="UTF-8"?>
<variables>
  <var name="respawnTime" type="3" value="120" />
</variables>
`;

const BAD_GLOBALS = `<?xml version="1.0" encoding="UTF-8"?>
<variables>
  <var name="respawnTime" type="9" value="twelve" />
</variables>
`;

const GOOD_SPAWNABLE = `<?xml version="1.0" encoding="UTF-8"?>
<spawnabletypes>
  <type name="Barrel_Blue"><hoarder /></type>
  <type name="Barrel_Red"><hoarder /></type>
</spawnabletypes>
`;

const GOOD_JSON = '{\n  "a": [1, 2, 3],\n  "b": "x"\n}\n';
const BAD_JSON = '{ "a": [1, 2,] }';

/* ------------------------------------------------------------------ *
 * Tests                                                               *
 * ------------------------------------------------------------------ */
function codes(report) {
  return [...report.errors, ...report.warnings, ...report.info].map((f) => f.code);
}

// 1. classify
assert.strictEqual(core.classify('dayzOffline.chernarusplus/db/types.xml'), 'types.xml');
assert.strictEqual(core.classify('CFGEVENTSPAWNS.XML'), 'cfgeventspawns.xml');
assert.strictEqual(core.classify('random-file.xml'), null);
assert.strictEqual(core.classify('mission.sqm'), null);
pass('classify() resolves DayZ basenames case-insensitively');

// 2. valid types.xml
let r = core.validateXml('types.xml', GOOD_TYPES, parser);
assert.strictEqual(r.summary.valid, true, 'good types.xml should be valid: ' + JSON.stringify(r.errors));
assert.ok(codes(r).includes('ROOT_OK'));
assert.ok(codes(r).includes('SYNTAX_OK'));
assert.ok(!codes(r).includes('DUPLICATE_NAME'));
pass('valid types.xml passes with ROOT_OK + SYNTAX_OK');

// 3. duplicate type names
r = core.validateXml('types.xml', DUP_TYPES, parser);
assert.strictEqual(r.summary.valid, false);
assert.ok(codes(r).includes('DUPLICATE_NAME'), 'expected DUPLICATE_NAME');
pass('duplicate <type name> flagged');

// 4. malformed XML
r = core.validateXml('types.xml', MALFORMED, parser);
assert.strictEqual(r.summary.valid, false);
assert.ok(codes(r).includes('XML_SYNTAX_ERROR'));
pass('malformed XML reported as XML_SYNTAX_ERROR');

// 5. two roots
r = core.validateXml('events.xml', TWO_ROOTS, parser);
assert.ok(codes(r).includes('XML_SYNTAX_ERROR'));
pass('multiple root elements rejected');

// 6. wrong root
r = core.validateXml('types.xml', WRONG_ROOT, parser);
assert.ok(codes(r).includes('WRONG_ROOT'));
pass('wrong root element reported');

// 7. bad class name
r = core.validateXml('types.xml', BAD_CLASSNAME_TYPES, parser);
assert.ok(codes(r).includes('BAD_CLASS_NAME'));
pass('invalid class name (hyphen) rejected');

// 8. min > nominal warning
r = core.validateXml('types.xml', MIN_GT_NOMINAL, parser);
assert.ok(codes(r).includes('MIN_GREATER_THAN_NOMINAL'));
pass('min > nominal warns');

// 9. documentType override (pasted content)
r = core.validateXml('pasted-document.xml', GOOD_TYPES, parser, 'types.xml');
assert.ok(codes(r).includes('ROOT_OK'));
assert.strictEqual(r.summary.valid, true);
pass('documentType override applies rules to unnamed pastes');

// 10. empty / oversized / non-string
assert.ok(codes(core.validateXml('x.xml', '   ', parser)).includes('EMPTY_FILE'));
assert.ok(codes(core.validateXml('x.xml', 'a'.repeat(core.MAX_FILE_BYTES + 1), parser)).includes('INPUT_TOO_LARGE'));
assert.ok(codes(core.validateXml('x.xml', 42, parser)).includes('INVALID_CONTENT'));
pass('empty / oversized / non-string inputs rejected');

// 11. event spawns: good, bad coords
r = core.validateXml('cfgeventspawns.xml', GOOD_SPAWNS, parser);
assert.strictEqual(r.summary.valid, true);
r = core.validateXml('cfgeventspawns.xml', BAD_SPAWN_COORDS, parser);
assert.ok(codes(r).includes('INVALID_COORDINATES'));
pass('cfgeventspawns coords validated');

// 12. globals
r = core.validateXml('globals.xml', GOOD_GLOBALS, parser);
assert.strictEqual(r.summary.valid, true);
r = core.validateXml('globals.xml', BAD_GLOBALS, parser);
assert.ok(codes(r).includes('UNUSUAL_TYPE'));
assert.ok(codes(r).includes('NON_NUMERIC_VALUE'));
pass('globals var type/value checks fire');

// 13. spawnable types
r = core.validateXml('cfgspawnabletypes.xml', GOOD_SPAWNABLE, parser);
assert.strictEqual(r.summary.valid, true);
assert.ok(codes(r).includes('ROOT_OK'));
pass('cfgspawnabletypes.xml validates');

// 14. JSON valid / invalid
r = core.validateJson('cfggameplay.json', GOOD_JSON);
assert.strictEqual(r.summary.valid, true);
assert.ok(codes(r).includes('JSON_VALID'));
assert.ok(codes(r).includes('DAYZ_JSON'));
r = core.validateJson('data.json', BAD_JSON);
assert.strictEqual(r.summary.valid, false);
assert.ok(codes(r).includes('JSON_SYNTAX_ERROR'));
const jsonErr = r.errors[0];
assert.ok(jsonErr.line >= 1, 'JSON error carries a line');
pass('JSON validation with error location');

// 15. JSON splitter
let split = core.splitJsonArray(JSON.stringify([1, 2, 3, 4, 5, 6]), 'count', 4);
assert.strictEqual(split.ok, true);
assert.strictEqual(split.chunks.length, 4);
assert.deepStrictEqual(JSON.parse(split.chunks[0].content), [1, 2]);
assert.deepStrictEqual(JSON.parse(split.chunks[3].content), [6]);
split = core.splitJsonArray(JSON.stringify([1, 2, 3, 4, 5, 6]), 'count', 'not-a-number');
assert.strictEqual(split.chunks.length, 1, 'invalid count falls back to 1 part');
split = core.splitJsonArray(JSON.stringify({ a: [1, 2] }), 'count', 2);
assert.strictEqual(split.ok, false);
pass('JSON splitter: count mode + non-array rejection');

// 16. splitter size mode keeps every part under budget
const big = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, name: 'object_' + i })));
split = core.splitJsonArray(big, 'size', 2048);
assert.strictEqual(split.ok, true);
assert.ok(split.chunks.length > 2);
split.chunks.forEach((chunk) => {
  assert.ok(chunk.content.length <= 2048 + 500, 'part ' + chunk.name + ' under budget (+overhead tolerance)');
  JSON.parse(chunk.content); // each part must be valid JSON
});
pass('JSON splitter: size mode');

// 17. collectNamed + findDuplicates (intra- and cross-file)
const modelA = parser(GOOD_TYPES).model;
const entriesA = core.collectNamed(modelA);
assert.strictEqual(entriesA.length, 2);
assert.strictEqual(entriesA[0].tag, 'type');
const dups = core.findDuplicates([
  { fileName: 'types.xml', entries: entriesA },
  { fileName: 'other/types.xml', entries: [{ tag: 'type', name: 'GoodLoot_Crate' }, { tag: 'type', name: 'Extra' }] }
]);
assert.strictEqual(dups.length, 1);
assert.strictEqual(dups[0].name, 'GoodLoot_Crate');
assert.strictEqual(dups[0].crossFile, true);
// Different file kinds sharing a name are NOT duplicates.
const dups2 = core.findDuplicates([
  { fileName: 'types.xml', entries: [{ tag: 'type', name: 'Barrel_Blue' }] },
  { fileName: 'cfgspawnabletypes.xml', entries: [{ tag: 'type', name: 'Barrel_Blue' }] }
]);
assert.strictEqual(dups2.length, 0, 'cross-kind names must not be flagged');
pass('duplicate detection: intra/cross-file same-kind only');

// 18. map bounds
assert.strictEqual(core.mapIdFromMissionName('dayzOffline.chernarusplus'), 'chernarusplus');
assert.strictEqual(core.mapIdFromMissionName('ChristmasOffline.Enoch'), 'enoch');
assert.strictEqual(core.mapIdFromMissionName('dayzOffline.zoo'), null);
assert.strictEqual(core.checkMapBounds(15360, 15360, 'chernarusplus').ok, true);
assert.strictEqual(core.checkMapBounds(15361, 0, 'chernarusplus').ok, false);
assert.strictEqual(core.checkMapBounds(99999, 0, 'unknownmap').unchecked, true);
pass('map id detection + bounds');

// 19. event conflict analysis — spawns
let ev = core.analyzeEvents('dayzOffline.chernarusplus/cfgeventspawns.xml', parser(OOB_SPAWNS).model, 'chernarusplus');
assert.ok(ev.warnings.some((w) => w.code === 'OUT_OF_MAP_BOUNDS'));
ev = core.analyzeEvents('cfgeventspawns.xml', parser(GOOD_SPAWNS).model, 'chernarusplus');
assert.strictEqual(ev.errors.length, 0);
assert.strictEqual(ev.warnings.length, 0);
pass('event spawn bounds check (15360 m chernarusplus)');

// 20. event conflict analysis — groups
let structuralGroups = core.validateXml('cfgeventgroups.xml', GROUPS, parser);
assert.ok(codes(structuralGroups).includes('DUPLICATE_NAME'), 'structural: duplicate group name');
assert.ok(codes(structuralGroups).includes('LOOTMIN_GREATER_THAN_LOOTMAX'), 'structural: lootmin > lootmax');
ev = core.analyzeEvents('cfgeventgroups.xml', parser(GROUPS).model, 'sakhal');
const evCodes = [...ev.errors, ...ev.warnings, ...ev.info].map((f) => f.code);
assert.ok(evCodes.includes('DUPLICATE_EVENT_NAME'), 'duplicate group name (conflict pass)');
assert.ok(evCodes.includes('OUT_OF_MAP_BOUNDS'), 'group out of sakhal bounds (99999)');
pass('event group conflicts: shadowed name, loot inversion, OOB position');

// 21. init.c checks
r = core.validateInitC('init.c', 'class X : Y {\n\tprivate void Init() { if (true) {}\n}\n}\n');
assert.strictEqual(r.summary.valid, true);
assert.ok(codes(r).includes('BRACES_BALANCED'));
r = core.validateInitC('init.c', 'class X : Y {\n\tprivate void Init() {\n}\n');
assert.ok(codes(r).includes('UNBALANCED_BRACES'));
pass('init.c brace/paren balance');

// 22. safe cleanup
let clean = core.safeCleanupXml('<types>\n  <type name="A">\n</types>\n');
assert.ok(clean.hasChanges);
assert.ok(clean.fixed.startsWith('<?xml version="1.0"'));
assert.ok(codes ? clean.fixes.length >= 1 : true);
clean = core.safeCleanupJson('{\n  "a":1 \n}\r\n');
assert.ok(clean.fixed === '{\n  "a": 1\n}\n');
assert.ok(core.safeCleanupJson('{bad').error);
pass('safe cleanup: xml declaration + json reformat');

// 23. mission structure
let mission = core.missionStructureReport({ 'mission.sqm': 1, 'init.c': 1, 'areaflags.map': 1, 'cfgeconomycore.xml': 1, 'db/messages.xml': 1, 'env': 1, 'pra': 1 });
assert.strictEqual(mission.summary.valid, true);
mission = core.missionStructureReport({ 'init.c': 1 });
assert.ok(mission.errors.some((e) => e.code === 'MISSING_REQUIRED_FILE'));
pass('mission structure checklist');

// 24. security contract on shipped toolkit files
const toolkitJs = fs.readdirSync(path.join(ROOT, 'public', 'js', 'tools'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => path.join(ROOT, 'public', 'js', 'tools', f));
const forbidden = [
  { re: /\beval\s*\(/, why: 'eval' },
  { re: /new\s+Function\s*\(/, why: 'new Function' },
  { re: /\bfetch\s*\(/, why: 'fetch (network)' },
  { re: /XMLHttpRequest/, why: 'XMLHttpRequest (network)' },
  { re: /WebSocket/, why: 'WebSocket' },
  { re: /document\.write\s*\(/, why: 'document.write' },
  { re: /innerHTML\s*=/, why: 'innerHTML assignment (XSS surface)' },
  { re: /importScripts/, why: 'worker importScripts' }
];
toolkitJs.forEach((file) => {
  const source = fs.readFileSync(file, 'utf8');
  forbidden.forEach(({ re, why }) => {
    assert.ok(!re.test(source), `${path.basename(file)} contains forbidden pattern: ${why}`);
  });
  assert.ok(!source.includes('http://') && !/["'\`]https:\/\/(?!saltskrew)/.test(source.replace(/\/\*[\s\S]*?\*\//g, ' ')),
    `${path.basename(file)} references an external host`);
});
// No inline scripts in toolkit pages.
fs.readdirSync(path.join(ROOT, 'public', 'tools'))
  .filter((f) => f.endsWith('.html'))
  .forEach((f) => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'tools', f), 'utf8');
    const inline = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g) || [];
    assert.strictEqual(inline.length, 0, `${f} has inline <script> blocks (CSP violation)`);
  });
// Every toolkit page references the core + dom layer (except the index landing).
['xml-validator.html', 'json-validator.html', 'mission-validator.html', 'duplicate-checker.html', 'event-conflicts.html'].forEach((f) => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'tools', f), 'utf8');
  assert.ok(html.includes('/js/tools/toolkit-core.js'), `${f} missing core script`);
  assert.ok(html.includes('/js/tools/toolkit-dom.js'), `${f} missing dom script`);
});
pass('security contract: no eval/network/innerHTML/inline scripts');

// 25. routes registered (source contract)
const routesSource = fs.readFileSync(path.join(ROOT, 'src', 'app', 'registerRoutes.js'), 'utf8');
['/tools', '/tools/xml-validator', '/tools/json-validator', '/tools/mission-validator', '/tools/duplicate-checker', '/tools/event-conflicts'].forEach((route) => {
  assert.ok(routesSource.includes(`app.get('${route}'`), `route ${route} not registered`);
  const idx = routesSource.indexOf(`app.get('${route}'`);
  assert.ok(!routesSource.slice(idx, idx + 220).includes('ensureAuthenticated'), `${route} must be public (no auth)`);
});
pass('all /tools routes registered and public');

console.log(`\n✅ toolkit-client suite passed`);
