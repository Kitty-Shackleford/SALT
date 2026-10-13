'use strict';

/*
 * ai-config-intelligence-test.js
 *
 * Tests for AI feature 2/7 — config intelligence:
 *   - the deterministic patch engine (aiConfigPatchService):
 *       xml-search-replace (unique span, whitespace-insensitive, overlap
 *       detection, well-formed result, already-applied → structured error),
 *       json-merge (null deletes, recursive merge, array replace), fingerprints
 *   - the config validator (configValidatorService): known roots, types.xml /
 *       events.xml invariants, invalid XML / JSON
 *   - the intelligence service (aiConfigIntelligenceService): file-list
 *       normalization, plan parsing (all-or-nothing with per-file errors),
 *       deterministic diff explanation
 *   - the routes in routes/ai.js: registered + gated, provider/quota wiring,
 *       config-edit / balance-pass / config-validate / diff-explain handler
 *       runs with a stubbed provider + db, and the apply route
 *       RE-MATERIALIZING a stored patch against a >40k-char original (the
 *       legacy assertValidReplacement cap must NOT apply to patch-style rows)
 *       plus base-drift / claim-release behavior.
 *
 * No external fixtures: all content is built inline.
 */

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const ROOT = path.join(__dirname, '..');
const patchEngine = require(path.join(ROOT, 'services', 'aiConfigPatchService'));
const configValidatorService = require(path.join(ROOT, 'services', 'configValidatorService'));
const configIntelligenceService = require(path.join(ROOT, 'services', 'aiConfigIntelligenceService'));

// ─── Fixtures ────────────────────────────────────────────────────────────────

function fixtureTypesXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<types>',
    '	<type name="Weapon_Base">',
    '		<nominal>50</nominal>',
    '		<min>20</min>',
    '		<max>60</max>',
    '		<lifetime>3600</lifetime>',
    '	</type>',
    '	<type name="Hatchet_F">',
    '		<namedItems>',
    '			<item name="Hatchet" probability="1.0"/>',
    '		</namedItems>',
    '		<nominal>10</nominal>',
    '		<min>4</min>',
    '		<max>12</max>',
    '		<lifetime>3600</lifetime>',
    '	</type>',
    '	<type name="Ammo_9x21_F">',
    '		<namedItems>',
    '			<item name="Ammo_9x21" probability="1.0"/>',
    '		</namedItems>',
    '		<nominal>80</nominal>',
    '		<min>30</min>',
    '		<max>90</max>',
    '		<lifetime>3600</lifetime>',
    '	</type>',
    '</types>',
  ].join('\n');
}

function fixtureEventsXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<events>',
    '	<event name="CivilianVehicle1">',
    '		<nominal>20</nominal>',
    '		<min>10</min>',
    '		<max>30</max>',
    '	</event>',
    '	<event name="Helicopter1">',
    '		<nominal>2</nominal>',
    '		<min>1</min>',
    '		<max>3</max>',
    '	</event>',
    '</events>',
  ].join('\n');
}

// A large, well-formed types.xml document (> 40k chars) used to prove the
// apply route re-materializes patches instead of hitting the 40k output cap.
function bigTypesXml() {
  const header = '<?xml version="1.0" encoding="UTF-8"?>\n<types>\n';
  let body = '';
  for (let i = 1; i <= 900; i += 1) {
    body += [
      `\t<type name="Bulk_Item_${i}_F">`,
      '\t\t<namedItems>',
      `\t\t\t<item name="Bulk_Item_${i}" probability="1.0"/>`,
      '\t\t</namedItems>',
      `\t\t<nominal>${10 + (i % 5)}</nominal>`,
      '\t\t<min>5</min>',
      '\t\t<max>40</max>',
      '\t\t<lifetime>3600</lifetime>',
      '\t</type>\n',
    ].join('\n');
  }
  // One unique target class that the patch will modify.
  body += [
    '\t<type name="Target_Weapon_F">',
    '\t\t<namedItems>',
    '\t\t\t<item name="Target_Weapon" probability="1.0"/>',
    '\t\t</namedItems>',
    '\t\t<nominal>77</nominal>',
    '\t\t<min>30</min>',
    '\t\t<max>80</max>',
    '\t\t<lifetime>3600</lifetime>',
    '\t</type>\n',
  ].join('\n');
  return header + body + '</types>\n';
}

// ─── Patch engine: xml-search-replace ────────────────────────────────────────

function testXmlPatchBasics() {
  const original = fixtureTypesXml();

  const patch = {
    kind: 'xml-search-replace',
    edits: [{
      // Whitespace differs from the file on purpose (proves whitespace-insensitive match).
      search: '<type name="Hatchet_F">\n<namedItems>\n<item name="Hatchet" probability="1.0"/>\n</namedItems>\n<nominal>10</nominal>',
      replace: '<type name="Hatchet_F">\n<namedItems>\n<item name="Hatchet" probability="1.0"/>\n</namedItems>\n<nominal>12</nominal>',
    }],
  };
  const applied = patchEngine.applyPatch('types.xml', original, patch);
  assert.ok(applied.content.includes('<nominal>12</nominal>'), 'replacement present');
  assert.ok(!applied.content.includes('<nominal>10</nominal>\n\t\t<min>4'), 'old value gone');
  assert.equal(applied.appliedEdits, 1, 'one edit applied');
  // The result must stay well-formed (the engine already checked it, but prove it).
  const { XMLValidator } = require(path.join(ROOT, 'node_modules', 'fast-xml-parser'));
  assert.equal(XMLValidator.validate(applied.content, { allowBooleanAttributes: true }), true, 'result well-formed');

  // Idempotency: re-applying the same patch must throw a structured error
  // (the search span no longer exists), never silently corrupt.
  assert.throws(
    () => patchEngine.applyPatch('types.xml', applied.content, patch),
    error => error.code === 'PATCH_SEARCH_NOT_FOUND',
    'second apply of the same edit reports already-applied as PATCH_SEARCH_NOT_FOUND',
  );

  // Ambiguity: a search block that matches multiple times.
  const ambiguous = {
    kind: 'xml-search-replace',
    edits: [{ search: '<lifetime>3600</lifetime>', replace: '<lifetime>1</lifetime>' }],
  };
  assert.throws(
    () => patchEngine.applyPatch('types.xml', original, ambiguous),
    error => error.code === 'PATCH_SEARCH_AMBIGUOUS',
    'non-unique search span is rejected',
  );

  // Not found.
  const missing = {
    kind: 'xml-search-replace',
    edits: [{ search: '<type name="Nope_F"><nominal>1</nominal></type>', replace: 'x' }],
  };
  assert.throws(
    () => patchEngine.applyPatch('types.xml', original, missing),
    error => error.code === 'PATCH_SEARCH_NOT_FOUND',
    'absent search span is rejected',
  );

  // Result well-formedness: a replace that breaks XML is rejected.
  const malformed = {
    kind: 'xml-search-replace',
    edits: [{
      search: '<type name="Ammo_9x21_F">',
      replace: '<type name="Ammo_9x21_F"', // tag left open
    }],
  };
  assert.throws(
    () => patchEngine.applyPatch('types.xml', original, malformed),
    error => error.code === 'PATCH_RESULT_INVALID_XML',
    'resulting document must stay well-formed',
  );

  // Overlapping edits are rejected.
  const overlapping = {
    kind: 'xml-search-replace',
    edits: [
      { search: '<type name="Hatchet_F">', replace: '<type name="Hatchet_Renamed_F">' },
      { search: '<type name="Hatchet_F"><namedItems>', replace: '<type name="Hatchet_2_F"><namedItems>' },
    ],
  };
  assert.throws(
    () => patchEngine.applyPatch('types.xml', original, overlapping),
    error => error.code === 'PATCH_EDITS_OVERLAP',
    'two edits over the same region are rejected',
  );

  // Multiple disjoint edits in one patch all apply.
  const multi = {
    kind: 'xml-search-replace',
    edits: [
      { search: '<nominal>50</nominal>', replace: '<nominal>55</nominal>' },
      { search: '<nominal>80</nominal>', replace: '<nominal>90</nominal>' },
    ],
  };
  const multiApplied = patchEngine.applyPatch('types.xml', original, multi);
  assert.equal(multiApplied.appliedEdits, 2, 'two disjoint edits applied');
  assert.ok(multiApplied.content.includes('<nominal>55</nominal>'));
  assert.ok(multiApplied.content.includes('<nominal>90</nominal>'));

  // Unsupported kind.
  assert.throws(
    () => patchEngine.applyPatch('types.xml', original, { kind: 'nope', edits: [] }),
    error => error.code === 'PATCH_KIND_INVALID',
    'unknown patch kind rejected',
  );

  console.log('✓ patch engine xml-search-replace (unique/ambiguous/not-found/overlap/well-formed/multi/idempotent)');
}

function testJsonMerge() {
  const original = JSON.stringify({
    a: 1,
    nested: { keep: true, dropMe: 'x', bump: 2 },
    list: [1, 2, 3],
  }, null, 2) + '\n';

  const patch = {
    kind: 'json-merge',
    patch: {
      a: 9,
      nested: { dropMe: null, bump: 7 },
      list: [9],
      fresh: 'new',
    },
  };
  const applied = patchEngine.applyPatch('randompresets.json', original, patch);
  const parsed = JSON.parse(applied.content);
  assert.equal(parsed.a, 9, 'primitive replaced');
  assert.equal(parsed.nested.keep, true, 'untouched nested key preserved');
  assert.ok(!('dropMe' in parsed.nested), 'null deleted the key');
  assert.equal(parsed.nested.bump, 7, 'nested value merged');
  assert.deepEqual(parsed.list, [9], 'arrays replaced wholesale');
  assert.equal(parsed.fresh, 'new', 'new key added');

  // Non-object top level is rejected.
  assert.throws(
    () => patchEngine.applyPatch('arr.json', '[1,2]', patch),
    error => error.code === 'PATCH_TARGET_INVALID',
    'json-merge requires an object root',
  );
  // Invalid original JSON.
  assert.throws(
    () => patchEngine.applyPatch('bad.json', '{not json', patch),
    error => error.code === 'PATCH_RESULT_INVALID_JSON',
    'invalid original JSON rejected',
  );

  console.log('✓ patch engine json-merge (null delete, recursive merge, array replace, guards)');
}

function testFingerprintsAndDiff() {
  const a = 'line1\nline2\n';
  const b = 'line1\nline3\n';
  assert.equal(
    patchEngine.contentFingerprint(a),
    patchEngine.contentFingerprint(a),
    'content fingerprint is deterministic',
  );
  assert.notEqual(patchEngine.contentFingerprint(a), patchEngine.contentFingerprint(b));

  const summary = patchEngine.diffSummary(a, b, 10);
  assert.equal(summary.addedCount, 1);
  assert.equal(summary.removedCount, 1);
  assert.ok(summary.addedLines.includes('line3'));
  assert.ok(summary.removedLines.includes('line2'));
  assert.ok(summary.summary.includes('+1') && summary.summary.includes('-1'));

  const pf = patchEngine.patchFingerprint({ kind: 'x', edits: [] });
  assert.match(pf, /^[a-f0-9]{64}$/);

  console.log('✓ fingerprints + diff summary');
}

// ─── Config validator ────────────────────────────────────────────────────────

function testValidatorGoodFiles() {
  const types = configValidatorService.validateConfigFile('dayzOffline.enoch/db/types.xml', fixtureTypesXml());
  assert.equal(types.valid, true, `types.xml valid (got findings: ${JSON.stringify(types.findings)})`);
  assert.equal(types.documentType, 'types');

  const events = configValidatorService.validateConfigFile('x/events.xml', fixtureEventsXml());
  assert.equal(events.valid, true, 'events.xml valid');

  const json = configValidatorService.validateConfigFile('x/preset.json', '{"a":1}');
  assert.equal(json.valid, true);
  assert.equal(json.documentType, 'json');

  console.log('✓ validator: known-good files pass');
}

function testValidatorBadFiles() {
  const dupTypes = [
    '<?xml version="1.0"?>',
    '<types>',
    '<type name="Dup_F"><nominal>5</nominal></type>',
    '<type name="Dup_F"><nominal>6</nominal></type>',
    '</types>',
  ].join('\n');
  const typesRes = configValidatorService.validateConfigFile('types.xml', dupTypes);
  assert.equal(typesRes.valid, false);
  assert.ok(typesRes.findings.some(f => f.code === 'TYPE_DUPLICATE'), 'duplicate type flagged');

  const badNumber = [
    '<?xml version="1.0"?>',
    '<types>',
    '<type name="Bad_F"><nominal>lots</nominal></type>',
    '<type name="Weird_F"><nominal>5</nominal><min>9</min></type>',
    '</types>',
  ].join('\n');
  const badNum = configValidatorService.validateConfigFile('types.xml', badNumber);
  assert.equal(badNum.valid, false, 'non-numeric nominal is an error');
  assert.ok(badNum.findings.some(f => f.code === 'TYPE_BAD_NUMBER'));
  assert.ok(badNum.findings.some(f => f.code === 'TYPE_MIN_GT_NOMINAL'), 'min>nominal warning present');

  const badEvents = [
    '<?xml version="1.0"?>',
    '<events>',
    '<event name="E1"><nominal>5</nominal><min>9</min><max>3</max></event>',
    '</events>',
  ].join('\n');
  const eventsRes = configValidatorService.validateConfigFile('events.xml', badEvents);
  assert.ok(eventsRes.findings.some(f => f.code === 'EVENT_MAX_LT_MIN'), 'max<min flagged');

  assert.equal(
    configValidatorService.validateConfigFile('types.xml', '<types><unclosed></types>').valid,
    false,
    'malformed XML is an error',
  );
  assert.equal(
    configValidatorService.validateConfigFile('p.json', '{oops').valid,
    false,
    'invalid JSON is an error',
  );
  assert.equal(
    configValidatorService.validateConfigFile('types.xml', '').valid,
    false,
    'empty file is an error',
  );
  const wrongRoot = configValidatorService.validateConfigFile('globals.xml', '<types></types>');
  assert.ok(wrongRoot.findings.some(f => f.code === 'UNEXPECTED_ROOT'), 'unexpected root warned');

  console.log('✓ validator: invariants flagged (dups, bad numbers, ranges, malformed, root)');
}

// ─── Intelligence service ────────────────────────────────────────────────────

function testNormalizeFileList() {
  const ok = configIntelligenceService.normalizeFileList([
    { filename: 'a.xml', fileContent: '<x/>' },
    { filename: 'b.json', fileContent: '{"a":1}' },
  ]);
  assert.equal(ok.length, 2);
  assert.equal(ok[0].content, '<x/>');

  assert.throws(() => configIntelligenceService.normalizeFileList([]),
    e => e.code === 'CONFIG_FILES_REQUIRED');
  assert.throws(() => configIntelligenceService.normalizeFileList(
    [{ filename: 'a.xml', fileContent: '<x/>' }, { filename: 'a.xml', fileContent: '<y/>' }],
  ), e => e.code === 'CONFIG_FILE_DUPLICATE');
  assert.throws(() => configIntelligenceService.normalizeFileList(
    [{ filename: '', fileContent: 'x' }],
  ), e => e.code === 'CONFIG_FILE_INVALID');
  assert.throws(() => configIntelligenceService.normalizeFileList(
    Array.from({ length: 6 }, (_, i) => ({ filename: `f${i}.xml`, fileContent: '<x/>' })),
  ), e => e.code === 'CONFIG_FILES_TOO_MANY');

  console.log('✓ normalizeFileList (caps, dup, shape)');
}

function planResponseFor(files) {
  const suggestions = files.map((f, i) => ({
    file: f.filename,
    rationale: `Rationale for ${f.filename}`,
    patch: f.filename.endsWith('.json')
      ? { kind: 'json-merge', patch: { fresh: i } }
      : {
        kind: 'xml-search-replace',
        edits: [{
          search: '<nominal>10</nominal>',
          replace: `<nominal>${20 + i}</nominal>`,
        }],
      },
  }));
  return "Sure, here is the plan:\n```json\n" + JSON.stringify({ suggestions }) + "\n```\n";
}

function testParseAndMaterialize() {
  const files = [
    { filename: 'types.xml', content: fixtureTypesXml() },
    { filename: 'preset.json', content: JSON.stringify({ a: 1 }, null, 2) + '\n' },
  ];

  const good = configIntelligenceService.parseAndMaterialize(planResponseFor(files), files);
  assert.equal(good.suggestions.length, 2, 'one suggestion per file');
  const typesSug = good.suggestions.find(s => s.filename === 'types.xml');
  assert.ok(typesSug.suggestedContent.includes('<nominal>20</nominal>'), 'materialized');
  assert.equal(typesSug.originalContent, files[0].content);
  assert.ok(typesSug.baseContentHash.match(/^[a-f0-9]{64}$/));
  assert.ok(typesSug.diffSummary.addedCount >= 1 && typesSug.diffSummary.removedCount >= 1);
  const jsonSug = good.suggestions.find(s => s.filename === 'preset.json');
  assert.equal(JSON.parse(jsonSug.suggestedContent).fresh, 1);

  // Unknown file in the plan → all-or-nothing structured failure with per-file errors.
  const badPlan = JSON.stringify({ suggestions: [
    { file: 'types.xml', rationale: 'x', patch: { kind: 'xml-search-replace', edits: [{ search: '<nominal>10</nominal>', replace: '<nominal>11</nominal>' }] } },
    { file: 'not-in-request.xml', rationale: 'x', patch: { kind: 'xml-search-replace', edits: [{ search: 'a', replace: 'b' }] } },
  ] });
  assert.throws(
    () => configIntelligenceService.parseAndMaterialize(`\`\`\`json\n${badPlan}\n\`\`\``, files),
    error => {
      assert.equal(error.code, 'CONFIG_PATCH_INVALID');
      assert.ok(Array.isArray(error.fileErrors) && error.fileErrors.length === 1);
      assert.equal(error.fileErrors[0].code, 'FILE_NOT_IN_REQUEST');
      return true;
    },
    'all-or-nothing: one bad file fails the whole plan with per-file detail',
  );

  // No fenced block at all.
  assert.throws(
    () => configIntelligenceService.parseAndMaterialize('no blocks here', files),
    e => e.code === 'CONFIG_PATCH_NO_BLOCK',
  );

  console.log('✓ parseAndMaterialize (materialize, all-or-nothing, per-file errors)');
}

function testPlanPrompt() {
  const prompt = configIntelligenceService.planPrompt({
    goal: 'make early game harder',
    files: [{ filename: 'types.xml', content: '<types></types>' }],
  });
  assert.ok(prompt.includes('BALANCE PASS — Goal: make early game harder'));
  assert.ok(prompt.includes('--- File: types.xml ---'));
  assert.ok(prompt.includes('fenced ```json block'));
  const instr = configIntelligenceService.planPrompt({
    instruction: 'lower the nominal on Hatchet',
    files: [{ filename: 'types.xml', content: '<types></types>' }],
  });
  assert.ok(instr.includes('INSTRUCTION: lower the nominal on Hatchet'));

  console.log('✓ planPrompt (balance + instruction forms)');
}

function testDeterministicDiffExplanation() {
  const sug = configIntelligenceService.deterministicDiffExplanation({
    filename: 'types.xml',
    diffSummary: { addedCount: 3, removedCount: 2, addedLines: [], removedLines: [] },
  });
  assert.ok(sug.includes('types.xml') && sug.includes('adds 3') && sug.includes('removes 2'), sug);
  const none = configIntelligenceService.deterministicDiffExplanation({
    filename: 'events.xml',
    diffSummary: { addedCount: 0, removedCount: 0, addedLines: [], removedLines: [] },
  });
  assert.ok(none.includes('makes no line changes'), none);

  console.log('✓ deterministic diff explanation');
}

// ─── Routes ──────────────────────────────────────────────────────────────────

function testRoutesRegisteredAndGated() {
  const router = require(path.join(ROOT, 'routes', 'ai'));
  const routes = router.stack
    .filter(layer => layer.route)
    .map(layer => ({ method: layer.route.methods.post ? 'post' : 'get', path: layer.route.path }));
  const has = (m, p) => routes.some(r => r.method === m && r.path === p);
  assert.ok(has('post', '/config-edit'), 'config-edit registered');
  assert.ok(has('post', '/balance-pass'), 'balance-pass registered');
  assert.ok(has('post', '/config-validate'), 'config-validate registered');
  assert.ok(has('get', '/suggestion-groups/:platformServerId'), 'suggestion-groups registered');
  assert.ok(has('post', '/suggestions/:suggestionId/diff-explain'), 'diff-explain registered');

  const source = fs.readFileSync(path.join(ROOT, 'routes', 'ai.js'), 'utf8');
  assert.ok(source.includes("router.param('platformServerId', ensureAiServerManage)"), 'param gate present');
  assert.ok(source.includes('aiProviderService.resolveUserProvider'), 'provider resolver used');
  assert.ok(source.includes('aiSharedRouterService.consumeCall'), 'shared-router quota consumed');
  // The apply route must re-materialize patch-style rows through the engine.
  assert.ok(source.includes('patchEngine.applyPatch'), 'apply re-materializes via the patch engine');
  assert.ok(source.includes('PATCH_BASE_DRIFT'), 'apply detects base drift');

  // Body-limit middleware: config routes share the 12MB envelope.
  const middlewareSource = fs.readFileSync(path.join(ROOT, 'src', 'app', 'registerMiddleware.js'), 'utf8');
  assert.ok(middlewareSource.includes('/api/ai/config-edit'), 'config-edit in the large-body limit');
  assert.ok(middlewareSource.includes('/api/ai/balance-pass'), 'balance-pass in the large-body limit');
  assert.ok(middlewareSource.includes('/api/ai/config-validate'), 'config-validate in the large-body limit');

  console.log('✓ routes registered + gated + provider/quota wired + body limit widened');
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

function findHandler(router, method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `route ${method} ${routePath} present`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function testConfigEditAndBalanceHandlers() {
  const router = require(path.join(ROOT, 'routes', 'ai'));
  const aiProviderService = require(path.join(ROOT, 'services', 'aiProviderService'));
  const aiService = require(path.join(ROOT, 'services', 'aiService'));

  const originalResolve = aiProviderService.resolveUserProvider;
  const originalCallProvider = aiService.callProvider;
  const originalBuildContext = aiService.buildServerContext;

  const capturedInserts = [];
  const db = {
    async query(sql, params) {
      if (/INSERT INTO ai_suggestion_groups/i.test(sql)) return [{ id: 42 }];
      if (/INSERT INTO ai_suggestions/i.test(sql)) {
        capturedInserts.push({ sql, params });
        return [{ id: capturedInserts.length }];
      }
      return [];
    },
    async get() { return null; },
  };

  const userProvider = { type: 'openai-compatible', source: 'user', apiKey: 'k', baseURL: 'https://x.test/v1/', model: 'm' };
  let lastMessages = null;
  try {
    aiProviderService.resolveUserProvider = async () => userProvider;
    aiService.buildServerContext = async () => '';
    aiService.callProvider = async (messages) => {
      lastMessages = messages;
      const userText = messages.find(m => m.role === 'user').content;
      const filenames = ['types.xml'];
      return planResponseFor(filenames.map(name => ({ filename: name, content: fixtureTypesXml() })));
    };

    const reqBase = {
      app: { locals: { db } },
      user: { id: 1 },
      platformServerAccess: { serverId: 7, guildId: 1, discordGuildId: '789326430571855893', platformServerId: '15580969' },
      params: {},
    };

    // POST /config-edit
    const editHandler = findHandler(router, 'post', '/config-edit');
    const editRes = makeRes();
    await editHandler({
      ...reqBase,
      body: {
        platformServerId: '15580969',
        instruction: 'raise the nominal on Hatchet',
        files: [{ filename: 'types.xml', fileContent: fixtureTypesXml() }],
      },
    }, editRes);
    assert.equal(editRes.statusCode, 200, `config-edit 200, got ${editRes.statusCode}: ${JSON.stringify(editRes.body)}`);
    assert.equal(editRes.body.success, true);
    assert.equal(editRes.body.groupId, 42);
    assert.equal(editRes.body.suggestions.length, 1);
    assert.equal(editRes.body.suggestions[0].group_id, 42);
    assert.ok(editRes.body.suggestions[0].diff_explanation.includes('types.xml'));

    assert.equal(capturedInserts.length, 1, 'one suggestion insert');
    const { sql: insertSql, params: insertParams } = capturedInserts[0];
    assert.match(insertSql, /group_id, patch, base_content_hash, diff_explanation/);
    assert.equal(insertParams[3], 'multi-file', 'trigger_type is multi-file');
    assert.equal(insertParams[8], 42, 'group_id bound');
    assert.ok(JSON.parse(insertParams[9]).kind === 'xml-search-replace', 'raw patch stored');
    assert.match(insertParams[10], /^[a-f0-9]{64}$/, 'base_content_hash stored');
    assert.ok(lastMessages[0].content.includes('PATCH PROTOCOL'), 'patch protocol in the system prompt');

    // Missing instruction → 400.
    const badRes = makeRes();
    await editHandler({ ...reqBase, body: { files: [{ filename: 'types.xml', fileContent: '<x/>' }] } }, badRes);
    assert.equal(badRes.statusCode, 400, 'instruction required');

    // No provider → 409.
    aiProviderService.resolveUserProvider = async () => null;
    const noProvRes = makeRes();
    await editHandler({
      ...reqBase,
      body: { instruction: 'x', files: [{ filename: 'types.xml', fileContent: fixtureTypesXml() }] },
    }, noProvRes);
    assert.equal(noProvRes.statusCode, 409, 'no provider → 409');

    // POST /balance-pass
    aiProviderService.resolveUserProvider = async () => userProvider;
    const balanceHandler = findHandler(router, 'post', '/balance-pass');
    const balanceRes = makeRes();
    await balanceHandler({
      ...reqBase,
      body: {
        platformServerId: '15580969',
        goal: 'make early game harder',
        files: [{ filename: 'types.xml', fileContent: fixtureTypesXml() }],
      },
    }, balanceRes);
    assert.equal(balanceRes.statusCode, 200, `balance-pass 200, got ${balanceRes.statusCode}`);
    assert.equal(balanceRes.body.success, true);
    assert.equal(balanceRes.body.groupId, 42);
    const balanceInsert = capturedInserts[capturedInserts.length - 1];
    assert.equal(balanceInsert.params[3], 'balance-pass', 'trigger_type is balance-pass');
    assert.ok(capturedInserts.length >= 2, 'balance inserted a suggestion');
    assert.ok(
      String(lastMessages[1].content).includes('BALANCE PASS'),
      'balance goal goes into the prompt',
    );

    // Missing goal → 400.
    const badGoal = makeRes();
    await balanceHandler({ ...reqBase, body: { files: [{ filename: 'types.xml', fileContent: '<x/>' }] } }, badGoal);
    assert.equal(badGoal.statusCode, 400, 'goal required');

    console.log('✓ config-edit + balance-pass handlers (provider stub, group persistence, 400/409)');
  } finally {
    aiProviderService.resolveUserProvider = originalResolve;
    aiService.callProvider = originalCallProvider;
    aiService.buildServerContext = originalBuildContext;
  }
}

async function testConfigValidateHandler() {
  const router = require(path.join(ROOT, 'routes', 'ai'));
  const aiProviderService = require(path.join(ROOT, 'services', 'aiProviderService'));
  const originalResolve = aiProviderService.resolveUserProvider;

  try {
    aiProviderService.resolveUserProvider = async () => null; // deterministic-only
    const db = { async query() { return []; }, async get() { return null; } };
    const req = {
      app: { locals: { db } },
      user: { id: 1 },
      platformServerAccess: { serverId: 7, guildId: 1, discordGuildId: 'g', platformServerId: '15580969' },
      params: {},
      body: {
        platformServerId: '15580969',
        filename: 'types.xml',
        fileContent: [
          '<?xml version="1.0"?>',
          '<types>',
          '<type name="Dup_F"><nominal>5</nominal></type>',
          '<type name="Dup_F"><nominal>6</nominal></type>',
          '</types>',
        ].join('\n'),
      },
    };
    const handler = findHandler(router, 'post', '/config-validate');
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200, `config-validate 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.success, true);
    assert.equal(res.body.valid, false);
    assert.ok(res.body.findings.some(f => f.code === 'TYPE_DUPLICATE'));
    assert.equal(res.body.providerConfigured, false);
    assert.equal(res.body.aiExplanation, null, 'no provider → null AI explanation');

    // Missing content → 400.
    const bad = makeRes();
    await handler({ ...req, body: { filename: 'types.xml' } }, bad);
    assert.equal(bad.statusCode, 400, 'fileContent required');

    console.log('✓ config-validate handler (deterministic findings without a provider, 400)');
  } finally {
    aiProviderService.resolveUserProvider = originalResolve;
  }
}

async function testDiffExplainHandler() {
  const router = require(path.join(ROOT, 'routes', 'ai'));
  const aiProviderService = require(path.join(ROOT, 'services', 'aiProviderService'));
  const aiService = require(path.join(ROOT, 'services', 'aiService'));
  const originalResolve = aiProviderService.resolveUserProvider;
  const originalCall = aiService.callProvider;

  const updates = [];
  const authRow = {
    server_id: 7, guild_id: 1, discord_guild_id: 'g', guild_role: 'admin',
    server_status: 'active', guild_status: 'approved',
  };
  const db = {
    async query(sql, params) {
      if (/UPDATE ai_suggestions/i.test(sql) && /diff_explanation/i.test(sql)) updates.push(params);
      return [{ id: 1 }];
    },
    async get(sql) {
      if (/FROM ai_suggestions/i.test(sql)) {
        return {
          id: 1,
          user_id: 1,
          server_id: 7,
          filename: 'types.xml',
          explanation: 'raise nominal',
          original_content: 'a\nb\n',
          suggested_content: 'a\nc\n',
          status: 'pending',
        };
      }
      if (/FROM servers/i.test(sql)) return { ...authRow }; // authorizeServer context
      return null;
    },
  };

  try {
    aiProviderService.resolveUserProvider = async () => ({ type: 'openai-compatible', source: 'user', apiKey: 'user-key', baseURL: 'https://x.test/v1/', model: 'm' });
    aiService.callProvider = async () => 'Raises the spawn nominal so loot is scarcer early.';

    const handler = findHandler(router, 'post', '/suggestions/:suggestionId/diff-explain');
    const res = makeRes();
    await handler({
      app: { locals: { db } },
      user: { id: 1 },
      params: { suggestionId: '1' },
      body: {},
    }, res);
    assert.equal(res.statusCode, 200, `diff-explain 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.success, true);
    assert.match(res.body.diffExplanation, /scarcer early/);
    assert.equal(updates.length, 1, 'explanation persisted on the row');

    console.log('✓ diff-explain handler (AI prose persisted on the suggestion row)');
  } finally {
    aiProviderService.resolveUserProvider = originalResolve;
    aiService.callProvider = originalCall;
  }
}

// The apply route re-materializes a stored patch against the pinned original —
// including for originals far larger than the 40k provider-output cap.
async function testApplyRoutePatchRematerialization() {
  const router = require(path.join(ROOT, 'routes', 'ai'));

  const bigOriginal = bigTypesXml();
  assert.ok(bigOriginal.length > 40000, `fixture original must exceed the 40k cap (got ${bigOriginal.length})`);
  const patch = {
    kind: 'xml-search-replace',
    edits: [{
      search: '<nominal>77</nominal>',
      replace: '<nominal>60</nominal>',
    }],
  };
  const baseHash = patchEngine.contentFingerprint(bigOriginal);
  const materialized = patchEngine.applyPatch('types.xml', bigOriginal, patch).content;
  assert.ok(materialized.includes('<nominal>60</nominal>'));

  const authRow = {
    server_id: 7, guild_id: 1, discord_guild_id: 'g', guild_role: 'admin',
    server_status: 'active', guild_status: 'approved',
  };

  const row = {
    id: 99,
    user_id: 1,
    server_id: 7,
    filename: 'dayzOffline.enoch/db/types.xml',
    explanation: 'lower the target weapon nominal',
    original_content: bigOriginal,
    suggested_content: materialized,
    diff_summary: '+1 line(s), -1 line(s)',
    patch: JSON.stringify(patch),
    base_content_hash: baseHash,
    status: 'pending',
  };

  const queryLog = [];
  const db = {
    async query(sql, params) {
      queryLog.push(sql);
      if (/UPDATE ai_suggestions[\s\S]*SET status = 'applying'/i.test(sql)) return [{ ...row }];
      if (/UPDATE ai_suggestions[\s\S]*SET status = 'applied'/i.test(sql)) return [{ id: 99 }];
      if (/UPDATE ai_suggestions/i.test(sql)) return []; // claim release
      return [];
    },
    async get(sql) {
      if (/SELECT ais\.\*/i.test(sql)) return { ...row };
      if (/FROM servers/i.test(sql)) return { ...authRow }; // authorizeServer context
      return null; // no github token → no PR path
    },
  };

  const handler = findHandler(router, 'post', '/suggestions/:suggestionId/apply');
  const req = {
    app: { locals: { db } },
    user: { id: 1 },
    params: { suggestionId: '99' },
    body: {},
  };

  // Happy path: patch-style row, 700KB-class original, no 40k cap in the way.
  const okRes = makeRes();
  await handler({ ...req }, okRes);
  assert.equal(okRes.statusCode, 200, `apply 200, got ${okRes.statusCode}: ${JSON.stringify(okRes.body)}`);
  assert.equal(okRes.body.success, true);
  assert.equal(okRes.body.suggestedContent.length, bigOriginal.length, 'content length preserved by the same-length edit');
  assert.ok(okRes.body.suggestedContent.includes('<nominal>60</nominal>'), 're-materialized content carries the edit');
  assert.ok(okRes.body.suggestedContent.length > 40000, 'a >40k-char result is served (legacy cap bypassed for patch rows)');

  // Drift: base_content_hash no longer matches the stored original → fail
  // closed with a structured 4xx and release the claim.
  const driftedRow = { ...row, base_content_hash: 'f'.repeat(64) };
  const driftQueryLog = [];
  const driftDb = {
    async query(sql, params) {
      driftQueryLog.push(sql);
      if (/UPDATE ai_suggestions[\s\S]*SET status = 'applying'/i.test(sql)) return [{ ...driftedRow }];
      if (/UPDATE ai_suggestions/i.test(sql)) return [];
      return [];
    },
    async get(sql) {
      if (/SELECT ais\.\*/i.test(sql)) return { ...driftedRow };
      if (/FROM servers/i.test(sql)) return { ...authRow };
      return null;
    },
  };
  const driftRes = makeRes();
  await handler({ ...req, app: { locals: { db: driftDb } } }, driftRes);
  assert.equal(driftRes.statusCode, 422, `drift fails closed with 422, got ${driftRes.statusCode}: ${JSON.stringify(driftRes.body)}`);
  assert.equal(driftRes.body.code, 'PATCH_BASE_DRIFT');
  assert.ok(
    driftQueryLog.some(sql => /COALESCE\(application_previous_status/i.test(sql)),
    'the finalization claim was released after the drift failure',
  );

  // Legacy row (no patch column): the original 40k-cap path still applies.
  const legacyOriginal = '<types><type name="L_F"><nominal>5</nominal></type></types>';
  const legacyRow = {
    ...row,
    id: 100,
    suggested_content: '<types><type name="L_F"><nominal>6</nominal></type></types>',
    patch: null,
    base_content_hash: null,
    status: 'pending',
  };
  const legacyDb = {
    async query(sql) {
      if (/UPDATE ai_suggestions[\s\S]*SET status = 'applying'/i.test(sql)) return [{ ...legacyRow }];
      if (/UPDATE ai_suggestions[\s\S]*SET status = 'applied'/i.test(sql)) return [{ id: 100 }];
      return [];
    },
    async get(sql) {
      if (/SELECT ais\.\*/i.test(sql)) return { ...legacyRow, original_content: legacyOriginal };
      if (/FROM servers/i.test(sql)) return { ...authRow };
      return null;
    },
  };
  const legacyRes = makeRes();
  await handler({ ...req, params: { suggestionId: '100' }, app: { locals: { db: legacyDb } } }, legacyRes);
  assert.equal(legacyRes.statusCode, 200, `legacy apply 200, got ${legacyRes.statusCode}`);
  assert.match(legacyRes.body.suggestedContent, /nominal>6</);

  console.log('✓ apply route: patch re-materialization (>40k original), base-drift fail-closed + claim release, legacy path intact');
}

async function testSuggestionGroupsHandler() {
  const router = require(path.join(ROOT, 'routes', 'ai'));
  const groups = [{ id: 5, kind: 'balance', goal: 'make early game harder', file_count: 1, created_at: new Date().toISOString() }];
  const db = {
    async query(sql) {
      if (/FROM ai_suggestion_groups/i.test(sql)) return groups;
      if (/FROM ai_suggestions/i.test(sql)) return [{
        id: 1, filename: 'types.xml', trigger_type: 'balance-pass', explanation: 'x',
        diff_summary: '+1, -1', diff_explanation: 'lowered nominal', status: 'pending', created_at: new Date().toISOString(),
      }];
      return [];
    },
    async get(sql) {
      if (/FROM servers/i.test(sql)) return { id: 7 };
      return null;
    },
  };
  const req = {
    app: { locals: { db } },
    user: { id: 1 },
    params: { platformServerId: '15580969' },
    query: { limit: '10' },
  };
  const handler = findHandler(router, 'get', '/suggestion-groups/:platformServerId');
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200, `suggestion-groups 200, got ${res.statusCode}`);
  assert.equal(res.body.groups.length, 1);
  assert.equal(res.body.groups[0].suggestions.length, 1);
  assert.equal(res.body.groups[0].suggestions[0].diff_explanation, 'lowered nominal');

  console.log('✓ suggestion-groups handler (anchor + member rows)');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  testXmlPatchBasics();
  testJsonMerge();
  testFingerprintsAndDiff();
  testValidatorGoodFiles();
  testValidatorBadFiles();
  testNormalizeFileList();
  testParseAndMaterialize();
  testPlanPrompt();
  testDeterministicDiffExplanation();
  testRoutesRegisteredAndGated();
  await testConfigEditAndBalanceHandlers();
  await testConfigValidateHandler();
  await testDiffExplainHandler();
  await testApplyRoutePatchRematerialization();
  await testSuggestionGroupsHandler();
  console.log('\n✅ AI config intelligence tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
