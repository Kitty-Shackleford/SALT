'use strict';

const assert = require('assert');
const {
  ACHIEVEMENT_CATALOG,
  buildAchievementProgress,
  calculatePlayerProgression,
  loadAchievementStats,
} = require('../services/achievementService');

const names = ACHIEVEMENT_CATALOG.map(item => item.name);
for (const removed of [
  'Bodily Needs', 'Geared', 'Act of Mercy', 'Field Cook', "I'm the Firestarter",
  'Babyface', 'Natural Instincts', 'Marksman', 'Pacify', 'Heal the World',
  'You Have the Right...', 'Kill Streak Master',
]) {
  assert(!names.includes(removed), `${removed} cannot be reliably tracked from stored events`);
}

assert.equal(new Set(names).size, names.length, 'achievement names must be unique');
assert(ACHIEVEMENT_CATALOG.length >= 16, 'replacement catalog should contain at least 16 achievements');
for (const item of ACHIEVEMENT_CATALOG) {
  assert(item.stat, `${item.name} must identify a tracked stat`);
  assert(Number.isFinite(item.required) && item.required > 0, `${item.name} must have a positive threshold`);
  assert(item.description, `${item.name} must explain how it is earned`);
}

const progress = buildAchievementProgress({
  kills: '10',
  sessions: 1,
  playtimeSeconds: 36000,
  meleeKills: 15,
  longShots: 0,
  headshots: 20,
  uniqueWeapons: 4,
  timesRevived: 3,
  structuresBuilt: 25,
  storagePlaced: 5,
  emotes: 10,
  damageDealt: 5000,
});

const byName = new Map(progress.map(item => [item.name, item]));
assert.equal(byName.get('First Blood').unlocked, true);
assert.equal(byName.get('Skirmisher').current, 10);
assert.equal(byName.get('Long Shot').unlocked, false);
assert.equal(byName.get('Dedicated Survivor').unlocked, true);
assert.equal(byName.get('Architect').unlocked, true);
assert.equal(byName.get('Friendly Face').unlocked, true);
assert.equal(byName.get('Damage Dealer').unlocked, true);
assert.equal(byName.get('Centurion').unlocked, false);

const invalid = buildAchievementProgress({ kills: 'not-a-number', sessions: -4 });
assert.equal(invalid.find(item => item.name === 'First Blood').current, 0);
assert.equal(invalid.find(item => item.name === 'First Steps').current, 0);

const routeSource = require('fs').readFileSync(require('path').join(__dirname, '../routes/playerPortal.js'), 'utf8');
assert(routeSource.includes('loadAchievementStats'));
assert(routeSource.includes('calculatePlayerProgression'));
assert(!routeSource.includes('FROM player_actions'));
const portalSource = require('fs').readFileSync(require('path').join(__dirname, '../public/js/player-portal.js'), 'utf8');
assert(portalSource.includes('progressData.achievements'));
assert(portalSource.includes('progressData.progression'));
for (const removed of ['Bodily Needs', 'Geared', 'You Have the Right...']) {
  assert(!portalSource.includes(`'${removed}'`), `${removed} should not remain in the displayed catalog`);
}

(async () => {
  let captured;
  const stats = await loadAchievementStats({
    get: async (sql, params) => {
      captured = { sql, params };
      return {
        kills: '12', sessions: '7', playtime_seconds: '42000', melee_kills: '3',
        long_shots: '1', headshots: '2', unique_weapons: '4', times_revived: '5',
        structures_built: '6', storage_placed: '2', emotes: '11', damage_dealt: '1234.5',
      };
    },
  }, 44, 9);

  assert.deepStrictEqual(captured.params, [44, 9]);
  for (const table of ['kill_events', 'damage_events', 'player_sessions', 'player_unconscious_events', 'territory_events', 'player_emote_events']) {
    assert(captured.sql.includes(table), `achievement query must use ${table}`);
  }
  assert.deepStrictEqual(stats, {
    kills: 12,
    sessions: 7,
    playtimeSeconds: 42000,
    meleeKills: 3,
    longShots: 1,
    headshots: 2,
    uniqueWeapons: 4,
    timesRevived: 5,
    structuresBuilt: 6,
    storagePlaced: 2,
    emotes: 11,
    damageDealt: 1234.5,
  });

  const playerProgression = calculatePlayerProgression(stats);
  assert.equal(playerProgression.totalXp, 4602);
  assert.equal(playerProgression.level, 3);
  assert.equal(playerProgression.currentLevelXp, 602);
  assert.equal(playerProgression.nextLevelXp, 5000);
  assert.equal(playerProgression.unlockedAchievements, 8);
  assert(playerProgression.sources.some(source => source.key === 'kills' && source.xp === 1200));

  console.log('Achievement catalog tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
