/**
 * Feed message formatter
 *
 * Provides both the legacy plain-text template system (still used by
 * non-player-kill event types) and the new rich embed builder that
 * produces rich DayZ Dashboard kill cards.
 */

const { parseCentsBigInt, centsToDecimal } = require('./money');

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * Replace variables in template with actual values
 */
function formatMessage(template, variables, serverName = 'Server') {
  if (!template) return '';

  let message = template;

  Object.keys(variables).forEach(key => {
    const regex = new RegExp(`\\{${key}\\}`, 'g');
    message = message.replace(regex, variables[key] !== undefined ? variables[key] : 'Unknown');
  });

  message = message.replace(/\{server\}/g, serverName);
  message = message.replace(/\{timestamp\}/g, new Date().toLocaleString());

  return message;
}

/**
 * Get default template for non-player-kill event types
 */
function getDefaultTemplate(eventType) {
  const defaults = {
    'player_kill':  '☠️ **{killer}** killed **{victim}** with {weapon} ({distance}m)',
    'zombie_kill':  '🧟 **{player}** killed a zombie with {weapon}',
    'animal_kill':  '🦌 **{player}** killed a {animal} with {weapon}',
    'suicide':      '💀 **{player}** died',
    'faction_kill': '⚔️ **[{killerFaction}]** {killer} eliminated **[{victimFaction}]** {victim} with {weapon}',
  };

  return defaults[eventType] || '{player} did something';
}

/**
 * Parse hex color string to integer, with fallback
 */
function parseEmbedColor(colorStr, fallback = 0xff0000) {
  if (!colorStr) return fallback;
  const parsed = parseInt(colorStr.replace('#', ''), 16);
  return isNaN(parsed) ? fallback : parsed;
}

/**
 * Format message for Discord embed (legacy path, used for non-kill events)
 */
function formatEmbed(message, embedColor, eventType) {
  const customColor = parseEmbedColor(embedColor);
  const embedColors = {
    'player_kill':  customColor,
    'zombie_kill':  0x00ff00,
    'animal_kill':  0x8b4513,
    'suicide':      0x808080,
    'faction_kill': 0xffa500,
  };

  return {
    embeds: [{
      description: message,
      color: embedColors[eventType] !== undefined ? embedColors[eventType] : customColor,
      timestamp: new Date().toISOString()
    }]
  };
}

/* ─── Rich Kill Embed ─────────────────────────────────────────────────────── */

/**
 * Formats a human-readable duration from milliseconds.
 * e.g. 635_000 → "10 minutes and 35 seconds"
 */
function formatDuration(ms) {
  if (!ms || ms <= 0) return 'Unknown';
  const totalSeconds = Math.floor(ms / 1000);
  const hours   = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours)   parts.push(`${hours} hour${hours   !== 1 ? 's' : ''}`);
  if (minutes) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
  if (seconds) parts.push(`${seconds} second${seconds !== 1 ? 's' : ''}`);

  if (parts.length === 0) return 'Less than a second';
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

/**
 * Formats a K/D ratio to one decimal place.
 */
function formatKD(kills, deaths) {
  const kd = deaths > 0 ? kills / deaths : kills;
  return kd.toFixed(1);
}

function exactMoneyText(value) {
  return centsToDecimal(parseCentsBigInt(value || 0, 'Feed money', { allowNegative: true }));
}

function hasPositiveMoney(value) {
  return parseCentsBigInt(value || 0, 'Feed money', { allowNegative: true }) > 0n;
}

/**
 * Builds the rich Discord embed payload for a player_kill event.
 *
 * @param {Object} eventData    - Event data from feed_events.event_data (JSON)
 * @param {Object} killerStats  - { kills, deaths, killStreak, globalRank }
 * @param {Object} victimStats  - { kills, deaths, deathStreak, globalRank, timeAliveMs }
 * @param {Object} economyInfo  - { currencySymbol, killerBalance, killRewardAmount, lootAmount, bountyClaimAmount }
 * @param {Object} settings     - Feed settings ({ embedColor, ... })
 * @param {string} serverName   - Display name for footer
 * @returns Discord API-compatible message payload (with embeds array)
 */
function buildKillEmbedPayload(eventData, killerStats, victimStats, economyInfo, settings, serverName) {
  const color = parseEmbedColor(settings?.embedColor, 0xe74c3c);

  // ── Header line ──────────────────────────────────────────────────────────
  const killTime = eventData.timestamp
    ? new Date(eventData.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : 'Unknown time';

  const title = `• Player Kill • ${killTime}`;
  const description = `**${eventData.killer}** killed **${eventData.victim}**.`;

  // ── Details field ─────────────────────────────────────────────────────────
  const distDisplay = eventData.distance != null
    ? `${parseFloat(eventData.distance).toFixed(1)}m`
    : 'Unknown';

  const detailLines = [
    `**Weapon:** ${eventData.weapon || 'Unknown'}`,
  ];
  if (eventData.weaponExtra && eventData.weaponExtra !== eventData.weapon) {
    detailLines.push(`**Ammo:** ${eventData.weaponExtra}`);
  }
  detailLines.push(
    `**Distance:** ${distDisplay}`,
    `**Body Part:** ${eventData.bodyPart || 'Unknown'}`,
    `**Damage:** ${eventData.damage != null ? parseFloat(eventData.damage).toFixed(1) : 'Unknown'}`,
  );

  // ── Killer stats field ────────────────────────────────────────────────────
  const kKills  = killerStats?.kills  || 0;
  const kDeaths = killerStats?.deaths || 0;
  const killerLines = [
    `${formatKD(kKills, kDeaths)} K/D | ${kKills} Kill${kKills !== 1 ? 's' : ''}`,
    `${killerStats?.killStreak || 1} x Killstreak | #${killerStats?.globalRank?.toLocaleString() || '?'} Global`,
  ];

  // ── Victim stats field ────────────────────────────────────────────────────
  const vKills  = victimStats?.kills  || 0;
  const vDeaths = victimStats?.deaths || 0;
  const victimLines = [
    `${formatKD(vKills, vDeaths)} K/D | ${vDeaths} PvP Death${vDeaths !== 1 ? 's' : ''}`,
    `${victimStats?.deathStreak || 1} x Deathstreak | #${victimStats?.globalRank?.toLocaleString() || '?'} Global`,
  ];

  // ── Time alive field ──────────────────────────────────────────────────────
  const timeAliveText = victimStats?.timeAliveMs != null
    ? formatDuration(victimStats.timeAliveMs)
    : 'Unknown';

  const serverTimeText = eventData.timestamp
    ? new Date(eventData.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    : 'Unknown';

  // ── Economy field (optional) ──────────────────────────────────────────────
  const fields = [
    { name: '• Details',               value: detailLines.join('\n'),  inline: false },
    { name: `• ${eventData.killer}`,   value: killerLines.join('\n'),  inline: true  },
    { name: `• ${eventData.victim}`,   value: victimLines.join('\n'),  inline: true  },
    {
      name: '• Time Alive (Real Time)',
      value: `${timeAliveText}\nServer Time: ${serverTimeText}`,
      inline: false
    },
  ];

  // Build economy line if there is any economy activity to show
  if (economyInfo) {
    const {
      currencySymbol = '₽', killerBalance, killRewardAmount, lootAmount,
      bountyAwardAmount = economyInfo.bountyClaimAmount || 0,
      bountyRefundAmount = 0,
      bountyDeferredAwardAmount = economyInfo.bountyDeferredClaimAmount || 0,
      bountyDeferredRefundAmount = 0,
    } = economyInfo;
    const econParts = [];

    if (hasPositiveMoney(killRewardAmount)) {
      econParts.push(`+${currencySymbol}${exactMoneyText(killRewardAmount)} kill reward`);
    }
    if (hasPositiveMoney(lootAmount)) {
      econParts.push(`+${currencySymbol}${exactMoneyText(lootAmount)} looted`);
    }
    if (hasPositiveMoney(bountyAwardAmount)) {
      econParts.push(`+${currencySymbol}${exactMoneyText(bountyAwardAmount)} bounty reward`);
    }
    if (hasPositiveMoney(bountyRefundAmount)) {
      econParts.push(`+${currencySymbol}${exactMoneyText(bountyRefundAmount)} bounty refund`);
    }
    if (hasPositiveMoney(bountyDeferredAwardAmount)) {
      econParts.push(`${currencySymbol}${exactMoneyText(bountyDeferredAwardAmount)} bounty award deferred as claim`);
    }
    if (hasPositiveMoney(bountyDeferredRefundAmount)) {
      econParts.push(`${currencySymbol}${exactMoneyText(bountyDeferredRefundAmount)} bounty refund deferred as claim`);
    }

    const balanceText = killerBalance != null
      ? `${currencySymbol}${exactMoneyText(killerBalance)}`
      : 'Not linked';

    fields.push({
      name: `• ${eventData.killer} Economy`,
      value: econParts.length > 0
        ? `${econParts.join(' • ')} → Balance: ${balanceText}`
        : `Balance: ${balanceText}`,
      inline: false
    });
  }

  return {
    embeds: [{
      title,
      description,
      color,
      fields,
      footer: { text: serverName || 'DayZ' },
      timestamp: new Date().toISOString()
    }]
  };
}

module.exports = {
  formatMessage,
  getDefaultTemplate,
  formatEmbed,
  parseEmbedColor,
  buildKillEmbedPayload,
};
