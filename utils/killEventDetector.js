/**
 * Detect kill events from log entries and queue them for feed posting
 */

/**
 * Process a kill event and queue for feed posting
 */
async function queueKillEvent(db, guildId, serverId, killData) {
  const { killer, victim, weapon, distance, type } = killData;

  let feedType = 'kill_feed';
  let eventType;

  if (type === 'player') {
    eventType = 'player_kill';
  } else if (type === 'zombie') {
    eventType = 'zombie_kill';
  } else if (type === 'animal') {
    eventType = 'animal_kill';
  } else {
    eventType = 'other';
  }

  const eventData = JSON.stringify({
    killer,
    victim,
    weapon,
    distance,
    timestamp: new Date().toISOString()
  });

  await db.run(
    `INSERT INTO feed_events (guild_id, server_id, feed_type, event_type, event_data)
     VALUES (?, ?, ?, ?, ?)`,
    [guildId, serverId, feedType, eventType, eventData]
  );
}

module.exports = {
  queueKillEvent
};
