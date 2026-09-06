'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  composeMissionInitSource,
  previewMissionInitDeployment,
} = require('../services/missionInitCompositionService');

const SOURCE = `void main()\n{\n}\n\nclass CustomMission: MissionServer\n{\n    override void StartingEquipSetup(PlayerBase player, bool clothesChosen)\n    {\n        EntityAI itemEnt;\n        itemEnt = player.GetInventory().CreateInInventory("BandageDressing");\n    }\n};\n\nMission CreateCustomMission(string path)\n{\n    return new CustomMission();\n}\n`;

const CONFIG_HASH_A = 'a'.repeat(64);
const CONFIG_HASH_B = 'b'.repeat(64);
const MANAGED_BEGIN_FOR_TEST = '// DAYZ_DASHBOARD_TEAM_CONFIG_BEGIN ';
const MANAGED_END_FOR_TEST = '// DAYZ_DASHBOARD_TEAM_CONFIG_END';
const FRAGMENT = `${MANAGED_BEGIN_FOR_TEST}${CONFIG_HASH_A}\nif (player)\n{\n    return;\n}\n${MANAGED_END_FOR_TEST}\n`;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function testInsertsFragmentOnlyIntoApprovedRecognizedSource() {
  const result = composeMissionInitSource(SOURCE, FRAGMENT, {
    approvedSourceHashes: new Set([hash(SOURCE)]),
  });

  assert.strictEqual(result.mode, 'inserted');
  assert.strictEqual(result.sourceHash, hash(SOURCE));
  assert.strictEqual(result.candidateHash, hash(result.source));
  assert(result.source.includes('StartingEquipSetup(PlayerBase player, bool clothesChosen)\n    {\n// DAYZ_DASHBOARD_TEAM_CONFIG_BEGIN'));
  assert(result.source.indexOf('// DAYZ_DASHBOARD_TEAM_CONFIG_END') < result.source.indexOf('EntityAI itemEnt;'));
  assert.strictEqual(SOURCE.includes('DAYZ_DASHBOARD_TEAM_CONFIG'), false);
}

function testRejectsUnapprovedUnmanagedSource() {
  assert.throws(
    () => composeMissionInitSource(SOURCE, FRAGMENT, { approvedSourceHashes: new Set() }),
    /recognized preimage|manual review/i
  );
}

function testReplacesOneExistingManagedBlockInsideStartingEquipSetup() {
  const inserted = composeMissionInitSource(SOURCE, FRAGMENT, {
    approvedSourceHashes: new Set([hash(SOURCE)]),
  });
  const replacement = FRAGMENT.replace(CONFIG_HASH_A, CONFIG_HASH_B);
  assert.throws(
    () => composeMissionInitSource(inserted.source, replacement, {
      approvedSourceHashes: new Set(),
    }),
    /recognized preimage|manual review/i
  );
  const replaced = composeMissionInitSource(inserted.source, replacement, {
    approvedSourceHashes: new Set([inserted.candidateHash]),
  });

  assert.strictEqual(replaced.mode, 'replaced');
  assert.strictEqual(replaced.sourceHash, inserted.candidateHash);
  assert(replaced.source.includes(`DAYZ_DASHBOARD_TEAM_CONFIG_BEGIN ${CONFIG_HASH_B}`));
  assert(!replaced.source.includes(`DAYZ_DASHBOARD_TEAM_CONFIG_BEGIN ${CONFIG_HASH_A}`));
  assert.strictEqual(replaced.source.split('DAYZ_DASHBOARD_TEAM_CONFIG_BEGIN').length - 1, 1);
}

function testRejectsMalformedOrOutOfMethodManagedMarkers() {
  const outside = `${FRAGMENT}\n${SOURCE}`;
  assert.throws(
    () => composeMissionInitSource(outside, FRAGMENT, {
      approvedSourceHashes: new Set([hash(outside)]),
    }),
    /managed|StartingEquipSetup/i
  );

  const duplicate = SOURCE.replace(
    'EntityAI itemEnt;',
    `${FRAGMENT}${FRAGMENT}        EntityAI itemEnt;`
  );
  assert.throws(
    () => composeMissionInitSource(duplicate, FRAGMENT, {
      approvedSourceHashes: new Set([hash(duplicate)]),
    }),
    /managed/i
  );
}

function testRejectsManagedMarkerTextOutsideExactCommentLines() {
  const cases = [
    SOURCE.replace(
      'EntityAI itemEnt;',
      `string begin = "${MANAGED_BEGIN_FOR_TEST}${CONFIG_HASH_A}";\n        string end = "${MANAGED_END_FOR_TEST}";\n        EntityAI itemEnt;`
    ),
    SOURCE.replace(
      'EntityAI itemEnt;',
      `/*\n        ${MANAGED_BEGIN_FOR_TEST}${CONFIG_HASH_A}\n        ${MANAGED_END_FOR_TEST}\n        */\n        EntityAI itemEnt;`
    ),
    SOURCE.replace(
      'EntityAI itemEnt;',
      `${MANAGED_BEGIN_FOR_TEST}not-a-valid-hash\n        ${MANAGED_END_FOR_TEST}\n        EntityAI itemEnt;`
    ),
    SOURCE.replace(
      'EntityAI itemEnt;',
      `${MANAGED_BEGIN_FOR_TEST}${CONFIG_HASH_A} trailing-text\n        ${MANAGED_END_FOR_TEST}\n        EntityAI itemEnt;`
    ),
    SOURCE.replace(
      'EntityAI itemEnt;',
      `${MANAGED_BEGIN_FOR_TEST}${CONFIG_HASH_A} ${MANAGED_END_FOR_TEST}\n        EntityAI itemEnt;`
    ),
    SOURCE.replace(
      'EntityAI itemEnt;',
      `${FRAGMENT}        string note = "// DAYZ_DASHBOARD_TEAM_CONFIG_BEGIN";\n        EntityAI itemEnt;`
    ),
  ];

  for (const source of cases) {
    assert.throws(
      () => composeMissionInitSource(source, FRAGMENT, {
        approvedSourceHashes: new Set([hash(source)]),
      }),
      /managed/i
    );
  }
}

function testRejectsFakeStartingEquipSignaturesOutsideCode() {
  const fakeSignature = 'override void StartingEquipSetup(PlayerBase player, bool clothesChosen)';
  const cases = [
    `void main()\n{\n    string fake = "${fakeSignature}";\n    if (true)\n    {\n${FRAGMENT}    }\n}\n`,
    `void main()\n{\n    // ${fakeSignature}\n    if (true)\n    {\n${FRAGMENT}    }\n}\n`,
    `void main()\n{\n    /* ${fakeSignature} */\n    if (true)\n    {\n${FRAGMENT}    }\n}\n`,
    `#ifdef NEVER_DEFINED\n${fakeSignature}\n#endif\nvoid Other()\n{\n${FRAGMENT}}\n`,
    `#ifdef NEVER_DEFINED\n${fakeSignature}\n{\n${FRAGMENT}}\n#endif\n`,
    `/* comment */ #ifdef NEVER_DEFINED\n${fakeSignature}\n{\n${FRAGMENT}}\n#endif\n`,
    `\f#ifdef NEVER_DEFINED\n${fakeSignature}\n{\n${FRAGMENT}}\n#endif\n`,
    `my${fakeSignature}\n{\n${FRAGMENT}}\n`,
    `class X\n{\n    void f()\n    {\n        foo.${fakeSignature}\n        {\n${FRAGMENT}        }\n    }\n}\n`,
    `class X\n{\n    void f()\n    {\n        foo. ${fakeSignature}\n        {\n${FRAGMENT}        }\n    }\n}\n`,
  ];

  for (const source of cases) {
    assert.throws(
      () => composeMissionInitSource(source, FRAGMENT, {
        approvedSourceHashes: new Set([hash(source)]),
      }),
      /StartingEquipSetup|preprocessor|CustomMission|MissionServer/i
    );
  }
}

function testRequiresCanonicalMissionServerClassScope() {
  const fakeSignature = 'override void StartingEquipSetup(PlayerBase player, bool clothesChosen)';
  const malformedPredecessors = ['foo.', 'foo +', 'foo ?', 'foo ::', 'foo ,', 'foo ='];
  const cases = malformedPredecessors.map(prefix => SOURCE.replace(
    '    override void StartingEquipSetup',
    `    ${prefix}\n    override void StartingEquipSetup`
  ));
  cases.push(
    SOURCE.replace('class CustomMission: MissionServer', 'foo +\nclass CustomMission: MissionServer'),
    SOURCE.replace('class CustomMission: MissionServer', 'class NotAMission: Inventory_Base'),
    `${fakeSignature}\n{\n${FRAGMENT}}\n`,
    `class CustomMission: MissionServer\n{\n    void Nested()\n    {\n        ${fakeSignature}\n        {\n${FRAGMENT}        }\n    }\n}\n`
  );

  for (const source of cases) {
    assert.throws(
      () => composeMissionInitSource(source, FRAGMENT, {
        approvedSourceHashes: new Set([hash(source)]),
      }),
      /CustomMission|MissionServer|StartingEquipSetup|declaration|scope/i
    );
  }
}

function testRejectsLexicallyMalformedOrNoncanonicalManagedSource() {
  const inserted = composeMissionInitSource(SOURCE, FRAGMENT, {
    approvedSourceHashes: new Set([hash(SOURCE)]),
  }).source;
  const malformedSources = [
    `${inserted}\nstring trailing = "unterminated;`,
    `${inserted}\nstring trailing = 'unterminated;`,
    `${inserted}\nstring trailing = "line1\\` + '\n' + `line2";`,
    `${inserted}\nstring trailing = "line1\\` + '\r\n' + `line2";`,
    `${inserted}\nstring trailing = 'line1\\` + '\n' + `line2';`,
    `${inserted}\nstring trailing = 'line1\\` + '\r\n' + `line2';`,
    `${inserted}\n/* unterminated`,
    `${inserted}\n}`,
    inserted.replace(
      'StartingEquipSetup(PlayerBase player, bool clothesChosen)\n    {',
      'StartingEquipSetup(PlayerBase player, bool clothesChosen)\u00a0{'
    ),
    inserted.replace(
      'StartingEquipSetup(PlayerBase player, bool clothesChosen)\n    {',
      'StartingEquipSetup(PlayerBase player, bool clothesChosen)\v{'
    ),
  ];

  for (const source of malformedSources) {
    assert.throws(
      () => composeMissionInitSource(source, FRAGMENT, {
        approvedSourceHashes: new Set([hash(source)]),
      }),
      /lexical|brace|StartingEquipSetup/i
    );
  }
}

function testRejectsMalformedGeneratedFragment() {
  const duplicateBegin = FRAGMENT.replace(
    'if (player)',
    `// DAYZ_DASHBOARD_TEAM_CONFIG_BEGIN ${CONFIG_HASH_B}\nif (player)`
  );
  assert.throws(
    () => composeMissionInitSource(SOURCE, duplicateBegin, {
      approvedSourceHashes: new Set([hash(SOURCE)]),
    }),
    /fragment/i
  );

  const invalidHash = FRAGMENT.replace(CONFIG_HASH_A, 'not-a-hash');
  assert.throws(
    () => composeMissionInitSource(SOURCE, invalidHash, {
      approvedSourceHashes: new Set([hash(SOURCE)]),
    }),
    /fragment/i
  );

  const ambiguousPrefix = FRAGMENT.replace(
    'if (player)',
    'string marker = "// DAYZ_DASHBOARD_TEAM_CONFIG_BEGINX";\nif (player)'
  );
  assert.throws(
    () => composeMissionInitSource(SOURCE, ambiguousPrefix, {
      approvedSourceHashes: new Set([hash(SOURCE)]),
    }),
    /fragment/i
  );
}

function testBraceScannerIgnoresCommentsAndStringLiterals() {
  const source = SOURCE.replace(
    'EntityAI itemEnt;',
    'string braces = "{ not structural }"; // } ignored\n        /* { ignored } */\n        EntityAI itemEnt;'
  );
  const result = composeMissionInitSource(source, FRAGMENT, {
    approvedSourceHashes: new Set([hash(source)]),
  });

  assert.strictEqual(result.mode, 'inserted');
  assert(result.source.includes('string braces = "{ not structural }";'));
}

function testBuildsMinimalDeploymentPreviewFromValidatedConfiguration() {
  const configuration = {
    version: 1,
    mapName: 'chernarusplus',
    unknownPlayerPolicy: 'vanilla',
    inventoryPolicy: 'replace',
    teams: [{
      id: 'alpha',
      members: [{ identityKind: 'dayz_protected', identityId: 'Protected_AAAAAAAA' }],
      spawn: { east: 5000, elevation: 100, north: 6000 },
      loadout: [{ className: 'BandageDressing', quantity: 1 }],
    }],
  };
  const preview = previewMissionInitDeployment({
    source: SOURCE,
    approvedSourceHash: hash(SOURCE),
    configuration,
    allowedItemClasses: new Set(['BandageDressing']),
  });

  assert.strictEqual(preview.sourceHash, hash(SOURCE));
  assert.strictEqual(preview.configurationHash.length, 64);
  assert.strictEqual(preview.candidateHash, hash(preview.source));
  assert.strictEqual(Object.hasOwn(preview, 'configuration'), false);
  assert(preview.source.includes(`DAYZ_DASHBOARD_TEAM_CONFIG_BEGIN ${preview.configurationHash}`));
}

function main() {
  testInsertsFragmentOnlyIntoApprovedRecognizedSource();
  testRejectsUnapprovedUnmanagedSource();
  testReplacesOneExistingManagedBlockInsideStartingEquipSetup();
  testRejectsMalformedOrOutOfMethodManagedMarkers();
  testRejectsManagedMarkerTextOutsideExactCommentLines();
  testRejectsFakeStartingEquipSignaturesOutsideCode();
  testRequiresCanonicalMissionServerClassScope();
  testRejectsLexicallyMalformedOrNoncanonicalManagedSource();
  testRejectsMalformedGeneratedFragment();
  testBraceScannerIgnoresCommentsAndStringLiterals();
  testBuildsMinimalDeploymentPreviewFromValidatedConfiguration();
  console.log('mission init composition tests passed');
}

try {
  main();
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
