'use strict';

const assert = require('assert');
const {
  generateTeamInitFragment,
  normalizeTeamConfiguration,
} = require('../services/missionInitTeamService');

function validConfiguration() {
  return {
    version: 1,
    mapName: 'chernarusplus',
    unknownPlayerPolicy: 'vanilla',
    inventoryPolicy: 'replace',
    teams: [{
      id: 'alpha',
      members: [{ identityKind: 'dayz_protected', identityId: 'a1b2c3d4e5f6g7h8' }],
      spawn: { east: 1200, elevation: 15.5, north: 3400 },
      loadout: [{ className: 'BandageDressing', quantity: 2 }],
    }],
  };
}

function testNormalizesValidPcTeamConfiguration() {
  const normalized = normalizeTeamConfiguration(validConfiguration(), {
    allowedItemClasses: new Set(['BandageDressing']),
  });

  assert.deepStrictEqual(normalized, validConfiguration());
}

function testRejectsItemOutsideAllowlist() {
  const configuration = validConfiguration();
  configuration.teams[0].loadout[0].className = 'SurvivorBase';

  assert.throws(
    () => normalizeTeamConfiguration(configuration, {
      allowedItemClasses: new Set(['BandageDressing']),
    }),
    /allowlist/i
  );
}

function testRejectsInvalidOrDuplicateProtectedIdentities() {
  const invalidKind = validConfiguration();
  invalidKind.teams[0].members[0].identityKind = 'steam_plain';
  assert.throws(
    () => normalizeTeamConfiguration(invalidKind, { allowedItemClasses: new Set(['BandageDressing']) }),
    /protected identity/i
  );

  const invalid = validConfiguration();
  invalid.teams[0].members[0].identityId = 'bad value';
  assert.throws(
    () => normalizeTeamConfiguration(invalid, { allowedItemClasses: new Set(['BandageDressing']) }),
    /protected identity/i
  );

  const duplicate = validConfiguration();
  duplicate.teams.push({
    id: 'bravo',
    members: [{
      identityKind: 'dayz_protected',
      identityId: duplicate.teams[0].members[0].identityId,
    }],
    spawn: { east: 2200, elevation: 20, north: 4400 },
    loadout: [],
  });
  assert.throws(
    () => normalizeTeamConfiguration(duplicate, { allowedItemClasses: new Set(['BandageDressing']) }),
    /duplicate.*protected identity/i
  );
}

function testRejectsUnknownMapAndOutOfBoundsSpawn() {
  const unknownMap = validConfiguration();
  unknownMap.mapName = 'community_map';
  assert.throws(
    () => normalizeTeamConfiguration(unknownMap, { allowedItemClasses: new Set(['BandageDressing']) }),
    /verified map/i
  );

  const outOfBounds = validConfiguration();
  outOfBounds.teams[0].spawn.east = 15361;
  assert.throws(
    () => normalizeTeamConfiguration(outOfBounds, { allowedItemClasses: new Set(['BandageDressing']) }),
    /map bounds/i
  );
}

function testRejectsUnsafeClassNamesAndUnboundedQuantities() {
  const unsafeClass = validConfiguration();
  unsafeClass.teams[0].loadout[0] = {
    className: 'BandageDressing"); GetGame().RestartMission(); //',
    quantity: 1,
  };
  const allowlist = new Set([unsafeClass.teams[0].loadout[0].className]);
  assert.throws(
    () => normalizeTeamConfiguration(unsafeClass, { allowedItemClasses: allowlist }),
    /item class/i
  );

  const excessiveQuantity = validConfiguration();
  excessiveQuantity.teams[0].loadout[0].quantity = 21;
  assert.throws(
    () => normalizeTeamConfiguration(excessiveQuantity, {
      allowedItemClasses: new Set(['BandageDressing']),
    }),
    /quantity/i
  );
}

function testRejectsUnsupportedOrAmbiguousConfigurationShape() {
  const allowlist = new Set(['BandageDressing']);
  const variants = [
    null,
    { ...validConfiguration(), version: 2 },
    { ...validConfiguration(), unknownPlayerPolicy: 'armed_default' },
    { ...validConfiguration(), inventoryPolicy: 'append' },
    { ...validConfiguration(), teams: [] },
    { ...validConfiguration(), extraScript: 'GetGame().RestartMission();' },
    (() => {
      const value = validConfiguration();
      value.teams.push({
        ...value.teams[0],
        members: [{ identityKind: 'dayz_protected', identityId: 'b1b2c3d4e5f6g7h8' }],
      });
      return value;
    })(),
  ];

  for (const configuration of variants) {
    assert.throws(
      () => normalizeTeamConfiguration(configuration, { allowedItemClasses: allowlist }),
      /configuration|version|policy|team|field/i
    );
  }
}

function testNormalizationIsDeterministicWithoutMutatingInput() {
  const configuration = validConfiguration();
  configuration.teams[0].members.push({
    identityKind: 'dayz_protected',
    identityId: 'c1b2c3d4e5f6g7h8',
  });
  configuration.teams[0].loadout.push({ className: 'Apple', quantity: 1 });
  configuration.teams.push({
    id: 'bravo',
    members: [{ identityKind: 'dayz_protected', identityId: 'b1b2c3d4e5f6g7h8' }],
    spawn: { east: 2200, elevation: 20, north: 4400 },
    loadout: [],
  });
  const reversed = JSON.parse(JSON.stringify(configuration));
  reversed.teams.reverse();
  reversed.teams[1].members.reverse();
  const original = JSON.parse(JSON.stringify(reversed));
  const options = { allowedItemClasses: new Set(['BandageDressing', 'Apple']) };

  assert.deepStrictEqual(
    normalizeTeamConfiguration(configuration, options),
    normalizeTeamConfiguration(reversed, options)
  );
  assert.deepStrictEqual(reversed, original);
}

function testCanonicalizesObjectPropertyOrderForHashAndSource() {
  const configuration = validConfiguration();
  const reordered = {
    teams: [{
      loadout: [{ quantity: 2, className: 'BandageDressing' }],
      spawn: { north: 3400, east: 1200, elevation: 15.5 },
      members: [{ identityId: 'a1b2c3d4e5f6g7h8', identityKind: 'dayz_protected' }],
      id: 'alpha',
    }],
    inventoryPolicy: 'replace',
    unknownPlayerPolicy: 'vanilla',
    mapName: 'chernarusplus',
    version: 1,
  };
  const options = { allowedItemClasses: new Set(['BandageDressing']) };

  const first = generateTeamInitFragment(configuration, options);
  const second = generateTeamInitFragment(reordered, options);

  assert.strictEqual(first.configurationHash, second.configurationHash);
  assert.strictEqual(first.source, second.source);
}

function testUsesLogSafePlatformIdentityIds() {
  const configuration = validConfiguration();
  configuration.teams[0].members = [{
    identityKind: 'dayz_protected',
    identityId: 'd1b2c3d4e5f6g7h8',
  }];

  const normalized = normalizeTeamConfiguration(configuration, {
    allowedItemClasses: new Set(['BandageDressing']),
  });

  assert.deepStrictEqual(normalized.teams[0].members, configuration.teams[0].members);
}

function testGeneratesDeterministicBoundedEnforceFragment() {
  const configuration = validConfiguration();
  const reversed = validConfiguration();
  const options = { allowedItemClasses: new Set(['BandageDressing']) };

  const first = generateTeamInitFragment(configuration, options);
  const second = generateTeamInitFragment(reversed, options);

  assert.strictEqual(first.configurationHash, second.configurationHash);
  assert.strictEqual(first.source, second.source);
  assert.match(first.configurationHash, /^[a-f0-9]{64}$/);
  assert.strictEqual(Object.hasOwn(first, 'configuration'), false);
  assert(first.source.includes(`// DAYZ_DASHBOARD_TEAM_CONFIG_BEGIN ${first.configurationHash}`));
  assert(first.source.includes('PlayerIdentity dayzDashboardIdentity = player.GetIdentity();'));
  assert(first.source.includes('dayzDashboardIdentity.GetId()'));
  assert(first.source.includes('dayzDashboardIdentityId == "a1b2c3d4e5f6g7h8"'));
  assert(!first.source.includes('GetPlainId()'));
  assert(first.source.includes('player.SetPosition(Vector(1200, 15.5, 3400));'));
  assert(first.source.includes('player.RemoveAllItems();'));
  assert.strictEqual(
    first.source.split('player.GetInventory().CreateInInventory("BandageDressing");').length - 1,
    2
  );
  assert(first.source.includes('return;'));
  assert(first.source.endsWith('// DAYZ_DASHBOARD_TEAM_CONFIG_END\n'));
}

function testGroupsTeamMembersIntoOneLoadoutBranch() {
  const configuration = validConfiguration();
  configuration.teams[0].members.push({
    identityKind: 'dayz_protected',
    identityId: 'b1b2c3d4e5f6g7h8',
  });

  const result = generateTeamInitFragment(configuration, {
    allowedItemClasses: new Set(['BandageDressing']),
  });

  assert(result.source.includes('dayzDashboardIdentityId == "a1b2c3d4e5f6g7h8" ||'));
  assert(result.source.includes('dayzDashboardIdentityId == "b1b2c3d4e5f6g7h8"'));
  assert.strictEqual(result.source.split('player.RemoveAllItems();').length - 1, 1);
  assert.strictEqual(result.source.split('player.SetPosition(').length - 1, 1);
}

function testUsesUniqueItemVariablesAcrossTeams() {
  const configuration = validConfiguration();
  configuration.teams.push({
    id: 'bravo',
    members: [{ identityKind: 'dayz_protected', identityId: 'b1b2c3d4e5f6g7h8' }],
    spawn: { east: 2200, elevation: 20, north: 4400 },
    loadout: [{ className: 'Apple', quantity: 1 }],
  });

  const result = generateTeamInitFragment(configuration, {
    allowedItemClasses: new Set(['BandageDressing', 'Apple']),
  });
  const declarations = Array.from(
    result.source.matchAll(/EntityAI (dayzDashboardItem\d+) =/g),
    match => match[1]
  );

  assert.strictEqual(declarations.length, 3);
  assert.strictEqual(new Set(declarations).size, declarations.length);
}

function testRejectsGeneratedFragmentAboveSourceLimit() {
  const configuration = validConfiguration();
  configuration.teams[0].members = Array.from({ length: 256 }, (_, index) => ({
    identityKind: 'dayz_protected',
    identityId: `identity_${String(index).padStart(4, '0')}`,
  }));

  assert.throws(
    () => generateTeamInitFragment(configuration, {
      allowedItemClasses: new Set(['BandageDressing']),
      maxSourceBytes: 1024,
    }),
    /source.*limit/i
  );
}

function testRejectsImplausibleElevation() {
  const configuration = validConfiguration();
  configuration.teams[0].spawn.elevation = 10001;

  assert.throws(
    () => normalizeTeamConfiguration(configuration, {
      allowedItemClasses: new Set(['BandageDressing']),
    }),
    /elevation/i
  );
}

function testGeneratedNullIdentityFallsThroughToVanillaSetup() {
  const result = generateTeamInitFragment(validConfiguration(), {
    allowedItemClasses: new Set(['BandageDressing']),
  });

  assert(!result.source.includes('if (!dayzDashboardIdentity)'));
  assert(result.source.includes('if (dayzDashboardIdentity)'));
}

function testGeneratedLoadoutFailsClosedOnInventoryCreationFailure() {
  const result = generateTeamInitFragment(validConfiguration(), {
    allowedItemClasses: new Set(['BandageDressing']),
  });

  assert(result.source.includes('if (!dayzDashboardItem0)'));
  assert(result.source.includes('Print("[dayz-dashboard-team] item-create-failed class=BandageDressing");'));
  assert(result.source.includes('if (!dayzDashboardItem1)'));
}

function testPreservesDeclaredLoadoutCreationOrder() {
  const configuration = validConfiguration();
  configuration.teams[0].loadout = [
    { className: 'Jacket_Black', quantity: 1 },
    { className: 'BandageDressing', quantity: 1 },
  ];

  const result = generateTeamInitFragment(configuration, {
    allowedItemClasses: new Set(['Jacket_Black', 'BandageDressing']),
  });

  assert(
    result.source.indexOf('CreateInInventory("Jacket_Black")') <
      result.source.indexOf('CreateInInventory("BandageDressing")')
  );
}

function main() {
  testNormalizesValidPcTeamConfiguration();
  testRejectsItemOutsideAllowlist();
  testRejectsInvalidOrDuplicateProtectedIdentities();
  testRejectsUnknownMapAndOutOfBoundsSpawn();
  testRejectsUnsafeClassNamesAndUnboundedQuantities();
  testRejectsUnsupportedOrAmbiguousConfigurationShape();
  testNormalizationIsDeterministicWithoutMutatingInput();
  testCanonicalizesObjectPropertyOrderForHashAndSource();
  testUsesLogSafePlatformIdentityIds();
  testGeneratesDeterministicBoundedEnforceFragment();
  testGroupsTeamMembersIntoOneLoadoutBranch();
  testUsesUniqueItemVariablesAcrossTeams();
  testRejectsGeneratedFragmentAboveSourceLimit();
  testRejectsImplausibleElevation();
  testGeneratedNullIdentityFallsThroughToVanillaSetup();
  testGeneratedLoadoutFailsClosedOnInventoryCreationFailure();
  testPreservesDeclaredLoadoutCreationOrder();
  console.log('mission init team tests passed');
}

try {
  main();
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
