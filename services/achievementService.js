'use strict';

const ACHIEVEMENT_CATALOG = Object.freeze([
  { name: 'First Steps', icon: '🥾', tier: 'survival', tierLabel: '🥉 Survival', stat: 'sessions', required: 1, unit: 'completed sessions', description: 'Complete your first tracked session.' },
  { name: 'Regular', icon: '📅', tier: 'survival', tierLabel: '🥉 Survival', stat: 'sessions', required: 10, unit: 'completed sessions', description: 'Complete 10 tracked sessions.' },
  { name: 'Dedicated Survivor', icon: '⏱️', tier: 'survival', tierLabel: '🥉 Survival', stat: 'playtimeSeconds', required: 36000, unit: 'hours played', divisor: 3600, description: 'Accumulate 10 hours of tracked playtime.' },
  { name: 'Marathon Survivor', icon: '🏕️', tier: 'survival', tierLabel: '🥉 Survival', stat: 'playtimeSeconds', required: 180000, unit: 'hours played', divisor: 3600, description: 'Accumulate 50 hours of tracked playtime.' },
  { name: 'Iron Will', icon: '💪', tier: 'survival', tierLabel: '🥉 Survival', stat: 'timesRevived', required: 3, unit: 'recoveries', description: 'Regain consciousness three times.' },

  { name: 'First Blood', icon: '🩸', tier: 'combat', tierLabel: '🥈 Combat', stat: 'kills', required: 1, unit: 'player kills', description: 'Record your first player kill.' },
  { name: 'Skirmisher', icon: '⚔️', tier: 'combat', tierLabel: '🥈 Combat', stat: 'kills', required: 10, unit: 'player kills', description: 'Record 10 player kills.' },
  { name: 'Veteran', icon: '🎖️', tier: 'combat', tierLabel: '🥈 Combat', stat: 'kills', required: 50, unit: 'player kills', description: 'Record 50 player kills.' },
  { name: 'Centurion', icon: '💯', tier: 'combat', tierLabel: '🥈 Combat', stat: 'kills', required: 100, unit: 'player kills', description: 'Record 100 player kills.' },
  { name: 'Close and Personal', icon: '🔪', tier: 'combat', tierLabel: '🥈 Combat', stat: 'meleeKills', required: 15, unit: 'melee kills', description: 'Record 15 kills with tracked melee weapons.' },
  { name: 'Long Shot', icon: '🏹', tier: 'combat', tierLabel: '🥈 Combat', stat: 'longShots', required: 1, unit: 'kills at 200m+', description: 'Record a kill from at least 200 metres.' },
  { name: 'Lobotomy', icon: '🧠', tier: 'combat', tierLabel: '🥈 Combat', stat: 'headshots', required: 20, unit: 'lethal head hits', description: 'Record 20 lethal hits to the head.' },
  { name: 'Arsenal', icon: '🔫', tier: 'combat', tierLabel: '🥈 Combat', stat: 'uniqueWeapons', required: 10, unit: 'kill weapons', description: 'Record kills with 10 different weapons.' },
  { name: 'Damage Dealer', icon: '💥', tier: 'combat', tierLabel: '🥈 Combat', stat: 'damageDealt', required: 5000, unit: 'damage dealt', description: 'Deal 5,000 tracked points of damage.' },

  { name: 'Builder', icon: '🏗️', tier: 'building', tierLabel: '🥇 Building', stat: 'structuresBuilt', required: 1, unit: 'structures built', description: 'Complete your first tracked build action.' },
  { name: 'Architect', icon: '🧱', tier: 'building', tierLabel: '🥇 Building', stat: 'structuresBuilt', required: 25, unit: 'structures built', description: 'Complete 25 tracked build actions.' },
  { name: 'Doomsday Prepper', icon: '🛢️', tier: 'building', tierLabel: '🥇 Building', stat: 'storagePlaced', required: 5, unit: 'storage items placed', description: 'Place five tracked storage containers.' },

  { name: 'Friendly Face', icon: '👋', tier: 'community', tierLabel: '🏆 Community', stat: 'emotes', required: 10, unit: 'emotes', description: 'Use 10 tracked emotes.' },
  { name: 'Social Butterfly', icon: '🦋', tier: 'community', tierLabel: '🏆 Community', stat: 'emotes', required: 100, unit: 'emotes', description: 'Use 100 tracked emotes.' },
]);

function safeMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function buildAchievementProgress(stats = {}) {
  return ACHIEVEMENT_CATALOG.map(item => {
    const current = safeMetric(stats[item.stat]);
    const divisor = item.divisor || 1;
    return {
      ...item,
      current,
      unlocked: current >= item.required,
      progressLabel: `${Math.floor(current / divisor)}/${Math.floor(item.required / divisor)} ${item.unit}`,
    };
  });
}

async function loadAchievementStats(db, identityId, serverId) {
  const row = await db.get(`
    WITH target AS (SELECT ?::bigint AS identity_id, ?::bigint AS server_id)
    SELECT
      (SELECT COUNT(*) FROM kill_events ke CROSS JOIN target t
       WHERE ke.killer_identity_id = t.identity_id AND ke.server_id = t.server_id) AS kills,
      (SELECT COUNT(*) FROM player_sessions ps CROSS JOIN target t
       WHERE ps.identity_id = t.identity_id AND ps.server_id = t.server_id AND ps.duration > 0) AS sessions,
      (SELECT COALESCE(SUM(ps.duration), 0) FROM player_sessions ps CROSS JOIN target t
       WHERE ps.identity_id = t.identity_id AND ps.server_id = t.server_id AND ps.duration > 0) AS playtime_seconds,
      (SELECT COUNT(*) FROM kill_events ke CROSS JOIN target t
       WHERE ke.killer_identity_id = t.identity_id AND ke.server_id = t.server_id
         AND (ke.weapon ILIKE '%knife%' OR ke.weapon ILIKE '%axe%' OR ke.weapon ILIKE '%bat%'
           OR ke.weapon ILIKE '%machete%' OR ke.weapon ILIKE '%shovel%' OR ke.weapon ILIKE '%pickaxe%'
           OR ke.weapon ILIKE '%crowbar%' OR ke.weapon ILIKE '%club%' OR ke.weapon ILIKE '%sledge%'
           OR ke.weapon ILIKE '%fist%' OR ke.weapon ILIKE '%melee%' OR ke.weapon ILIKE '%hoe%'
           OR ke.weapon ILIKE '%hammer%' OR ke.weapon ILIKE '%wrench%' OR ke.weapon ILIKE '%pitchfork%')) AS melee_kills,
      (SELECT COUNT(*) FROM kill_events ke CROSS JOIN target t
       WHERE ke.killer_identity_id = t.identity_id AND ke.server_id = t.server_id AND ke.distance >= 200) AS long_shots,
      (SELECT COUNT(*) FROM damage_events de CROSS JOIN target t
       WHERE de.attacker_identity_id = t.identity_id AND de.server_id = t.server_id
         AND de.hp_after <= 0 AND de.body_part ILIKE '%Head%') AS headshots,
      (SELECT COUNT(DISTINCT ke.weapon) FROM kill_events ke CROSS JOIN target t
       WHERE ke.killer_identity_id = t.identity_id AND ke.server_id = t.server_id
         AND NULLIF(TRIM(ke.weapon), '') IS NOT NULL) AS unique_weapons,
      (SELECT COUNT(*) FROM player_unconscious_events pue CROSS JOIN target t
       WHERE pue.identity_id = t.identity_id AND pue.server_id = t.server_id
         AND pue.event_type = 'regained_consciousness') AS times_revived,
      (SELECT COUNT(*) FROM territory_events te CROSS JOIN target t
       WHERE te.identity_id = t.identity_id AND te.server_id = t.server_id
         AND te.event_type = 'built') AS structures_built,
      (SELECT COUNT(*) FROM territory_events te CROSS JOIN target t
       WHERE te.identity_id = t.identity_id AND te.server_id = t.server_id
         AND te.event_type = 'placed'
         AND (te.structure_type ILIKE '%Tent%' OR te.structure_type ILIKE '%Barrel%'
           OR te.structure_type ILIKE '%Crate%' OR te.structure_type ILIKE '%SeaChest%')) AS storage_placed,
      (SELECT COUNT(*) FROM player_emote_events pee CROSS JOIN target t
       WHERE pee.identity_id = t.identity_id AND pee.server_id = t.server_id) AS emotes,
      (SELECT COALESCE(SUM(GREATEST(de.damage, 0)), 0) FROM damage_events de CROSS JOIN target t
       WHERE de.attacker_identity_id = t.identity_id AND de.server_id = t.server_id) AS damage_dealt
  `, [identityId, serverId]);

  return {
    kills: safeMetric(row?.kills),
    sessions: safeMetric(row?.sessions),
    playtimeSeconds: safeMetric(row?.playtime_seconds),
    meleeKills: safeMetric(row?.melee_kills),
    longShots: safeMetric(row?.long_shots),
    headshots: safeMetric(row?.headshots),
    uniqueWeapons: safeMetric(row?.unique_weapons),
    timesRevived: safeMetric(row?.times_revived),
    structuresBuilt: safeMetric(row?.structures_built),
    storagePlaced: safeMetric(row?.storage_placed),
    emotes: safeMetric(row?.emotes),
    damageDealt: safeMetric(row?.damage_dealt),
  };
}

function calculatePlayerProgression(stats = {}) {
  const achievements = buildAchievementProgress(stats);
  const unlockedAchievements = achievements.filter(item => item.unlocked).length;
  const sources = [
    { key: 'kills', label: 'Player kills', xp: Math.floor(safeMetric(stats.kills)) * 100 },
    { key: 'sessions', label: 'Completed sessions', xp: Math.floor(safeMetric(stats.sessions)) * 25 },
    { key: 'playtime', label: 'Playtime', xp: Math.floor(safeMetric(stats.playtimeSeconds) / 60) },
    { key: 'meleeKills', label: 'Melee kill bonus', xp: Math.floor(safeMetric(stats.meleeKills)) * 25 },
    { key: 'longShots', label: 'Long-shot bonus', xp: Math.floor(safeMetric(stats.longShots)) * 50 },
    { key: 'headshots', label: 'Lethal head-hit bonus', xp: Math.floor(safeMetric(stats.headshots)) * 25 },
    { key: 'timesRevived', label: 'Recovery bonus', xp: Math.floor(safeMetric(stats.timesRevived)) * 50 },
    { key: 'structuresBuilt', label: 'Building', xp: Math.floor(safeMetric(stats.structuresBuilt)) * 10 },
    { key: 'storagePlaced', label: 'Storage placement', xp: Math.floor(safeMetric(stats.storagePlaced)) * 15 },
    { key: 'damageDealt', label: 'Damage dealt', xp: Math.floor(safeMetric(stats.damageDealt) / 100) },
    { key: 'achievements', label: 'Achievements', xp: unlockedAchievements * 250 },
  ];
  const totalXp = sources.reduce((sum, source) => sum + source.xp, 0);
  const level = Math.floor(Math.sqrt(totalXp / 1000)) + 1;
  const levelStart = 1000 * ((level - 1) ** 2);
  const nextLevelAt = 1000 * (level ** 2);
  const currentLevelXp = totalXp - levelStart;
  const nextLevelXp = nextLevelAt - levelStart;

  return {
    totalXp,
    level,
    currentLevelXp,
    nextLevelXp,
    progressPercent: Math.min(100, Math.floor((currentLevelXp / nextLevelXp) * 100)),
    unlockedAchievements,
    sources,
  };
}

module.exports = {
  ACHIEVEMENT_CATALOG,
  buildAchievementProgress,
  calculatePlayerProgression,
  loadAchievementStats,
};
