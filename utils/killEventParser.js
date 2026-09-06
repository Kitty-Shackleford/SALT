/**
 * Parse kill events from DayZ log entries
 * Detects player kills, zombie kills, animal kills, and suicides
 */

const { queueKillEvent } = require('./feedEventQueue');

/**
 * Parse a kill event from log line
 * Example formats:
 * - Player kill: "Player 'Killer' (id=123) killed by Player 'Victim' (id=456) with weapon at 150m"
 * - Zombie kill: "Player 'PlayerName' (id=123) killed Infected with weapon"
 * - Animal kill: "Player 'PlayerName' (id=123) killed Animal(Deer) with weapon"
 * - Suicide: "Player 'PlayerName' (id=123) committed suicide"
 */

/**
 * Main parser function
 */
async function parseKillEvent(db, logEntry, guildId, serverId) {
  const { message, timestamp } = logEntry;

  // Try a detailed player-kill pattern that captures optional positions and explicit distance
  // Groups (roughly): killerName, killerId, killerX,killerY,killerZ (optional), victimName, victimId, victimX,victimY,victimZ (optional), weapon, distance (optional)
  const detailedPattern = /'([^']+)'\s*\(id=([A-Fa-f0-9]+)(?:\s*pos=<([\d.]+),\s*([\d.]+),\s*([\d.]+)>)?\).*?killed.*?'([^']+)'\s*\(id=([A-Fa-f0-9]+)(?:\s*pos=<([\d.]+),\s*([\d.]+),\s*([\d.]+)>)?\).*?with\s+(.+?)(?:\s+(?:at|from)\s+(\d+(?:\.\d+)?)m)?/i;
  const detailedMatch = message.match(detailedPattern);

  if (detailedMatch) {
    const [
      ,
      killer,
      killerId,
      killerX,
      killerY,
      killerZ,
      victim,
      victimId,
      victimX,
      victimY,
      victimZ,
      weapon,
      distance
    ] = detailedMatch;

    // Compute distance: prefer explicit distance from log, otherwise compute from positions when both present
    let computedDistance = null;
    if (distance) {
      computedDistance = parseFloat(distance);
    } else if (killerX && killerY && killerZ && victimX && victimY && victimZ) {
      try {
        const kx = parseFloat(killerX);
        const ky = parseFloat(killerY);
        const kz = parseFloat(killerZ);
        const vx = parseFloat(victimX);
        const vy = parseFloat(victimY);
        const vz = parseFloat(victimZ);
        const dx = kx - vx;
        const dy = ky - vy;
        const dz = kz - vz;
        computedDistance = Math.sqrt(dx*dx + dy*dy + dz*dz);
      } catch (e) {
        computedDistance = null;
      }
    }

    const killData = {
      type: 'player',
      killer: killer.trim(),
      killerId: killerId,
      victim: victim.trim(),
      victimId: victimId,
      weapon: cleanWeaponName(weapon),
      distance: computedDistance,
      timestamp: timestamp || new Date().toISOString()
    };

    await queueKillEvent(db, guildId, serverId, 'kill_feed', 'player_kill', killData);
    return killData;
  }

  // Fallback: simpler pattern (older logs may not include positions)
  // Groups: (1) killer name, (2) killer id, (3) victim name, (4) victim id, (5) weapon, (6) optional distance in meters
  const playerKillPattern = /'([^']+)'\s*\(id=(\d+)\).*?killed.*?'([^']+)'\s*\(id=(\d+)\).*?with\s+(.+?)(?:\s+at\s+(\d+(?:\.\d+)?)m)?/i;
  const playerKillMatch = message.match(playerKillPattern);

  if (playerKillMatch) {
    const [, killer, killerId, victim, victimId, weapon, distance] = playerKillMatch;

    const killData = {
      type: 'player',
      killer: killer.trim(),
      killerId: killerId,
      victim: victim.trim(),
      victimId: victimId,
      weapon: cleanWeaponName(weapon),
      distance: distance ? parseFloat(distance) : null,
      timestamp: timestamp || new Date().toISOString()
    };

    await queueKillEvent(db, guildId, serverId, 'kill_feed', 'player_kill', killData);
    return killData;
  }

  // Zombie kill pattern
  const zombieKillPattern = /'([^']+)'\s*\(id=(\d+)\).*?killed.*?(?:Infected|Zombie).*?with\s+(.+)/i;
  const zombieKillMatch = message.match(zombieKillPattern);

  if (zombieKillMatch) {
    const [, player, playerId, weapon] = zombieKillMatch;

    const killData = {
      type: 'zombie',
      player: player.trim(),
      playerId: playerId,
      weapon: cleanWeaponName(weapon),
      timestamp: timestamp || new Date().toISOString()
    };

    await queueKillEvent(db, guildId, serverId, 'kill_feed', 'zombie_kill', killData);
    return killData;
  }

  // Animal kill pattern
  const animalKillPattern = /'([^']+)'\s*\(id=(\d+)\).*?killed.*?Animal\(([^)]+)\).*?with\s+(.+)/i;
  const animalKillMatch = message.match(animalKillPattern);

  if (animalKillMatch) {
    const [, player, playerId, animal, weapon] = animalKillMatch;

    const killData = {
      type: 'animal',
      player: player.trim(),
      playerId: playerId,
      animal: animal.trim(),
      weapon: cleanWeaponName(weapon),
      timestamp: timestamp || new Date().toISOString()
    };

    await queueKillEvent(db, guildId, serverId, 'kill_feed', 'animal_kill', killData);
    return killData;
  }

  // Suicide pattern
  const suicidePattern = /'([^']+)'\s*\(id=(\d+)\).*?(?:committed suicide|died)/i;
  const suicideMatch = message.match(suicidePattern);

  if (suicideMatch) {
    const [, player, playerId] = suicideMatch;

    const killData = {
      type: 'suicide',
      player: player.trim(),
      playerId: playerId,
      timestamp: timestamp || new Date().toISOString()
    };

    await queueKillEvent(db, guildId, serverId, 'kill_feed', 'suicide', killData);
    return killData;
  }

  return null;
}

/**
 * Clean weapon names for better display
 */
function cleanWeaponName(weapon) {
  if (!weapon) return 'Unknown';

  // Remove common prefixes/suffixes
  weapon = weapon
    .replace(/^(melee|ranged|firearm|weapon)_/i, '')
    .replace(/_weapon$/i, '')
    .replace(/_/g, ' ')
    .trim();

  // Capitalize first letter of each word
  return weapon
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

module.exports = {
  parseKillEvent,
  cleanWeaponName
};
