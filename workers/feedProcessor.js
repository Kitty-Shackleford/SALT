/**
 * Feed Event Processor
 *
 * Processes queued kill/faction events and posts them to Discord.
 * player_kill events get a full rich embed with live stats;
 * other event types use the legacy template path.
 */

const {
  claimPendingEvents,
  suppressDisabledFeedEvents,
  markEventProcessed,
  markEventFailed,
  cleanupOldEvents,
} = require('../utils/feedEventQueue');
const { formatMessage, getDefaultTemplate, formatEmbed, buildKillEmbedPayload } = require('../utils/feedMessageFormatter');
const { postToDiscord, validateDiscordDestination, MIN_DELAY_MS } = require('../utils/discordPoster');
const { amountForResponse } = require('../utils/money');
const {
  PIPELINES,
  beginPipelineRun,
  finishPipelineRun,
} = require('../services/pipelineStatusService');

let feedTickRunning = false;

/* ─── Stat helpers (queries run at post time against live DB) ─────────────── */

/**
 * Fetches kill and death counts for an identity.
 * @returns {{ kills: number, deaths: number }}
 */
async function fetchKDStats(db, identityId, serverId = null) {
  const serverFilter = serverId ? 'AND server_id = $3' : '';
  const baseArgs = [identityId, identityId];
  if (serverId) baseArgs.push(serverId);

  const row = await db.get(
    `SELECT
       (SELECT COUNT(*) FROM kill_events WHERE killer_identity_id = $1 ${serverFilter}) AS kills,
       (SELECT COUNT(*) FROM kill_events WHERE victim_identity_id  = $2 ${serverFilter}) AS deaths`,
    baseArgs
  );
  return { kills: Number(row?.kills || 0), deaths: Number(row?.deaths || 0) };
}

/**
 * Computes the current kill streak for an identity:
 * consecutive kills (as killer) with no death (as victim) at the tail of
 * the kill_events table ordered by event_at ascending.
 */
async function fetchKillStreak(db, identityId, serverId) {
  // Fetch the last 200 events involving this player (killer or victim), newest first
  const rows = await db.query(
    `SELECT killer_identity_id, victim_identity_id
     FROM kill_events
     WHERE server_id = $2
       AND (killer_identity_id = $1 OR victim_identity_id = $1)
     ORDER BY timestamp DESC
     LIMIT 200`,
    [identityId, serverId]
  );

  let streak = 0;
  for (const row of rows) {
    if (row.victim_identity_id === identityId) break; // died — stop counting
    if (row.killer_identity_id === identityId) streak++;
  }
  return Math.max(streak, 1);
}

/**
 * Computes the current death streak for an identity:
 * consecutive deaths (as victim) with no kill at the tail of kill_events.
 */
async function fetchDeathStreak(db, identityId, serverId) {
  const rows = await db.query(
    `SELECT killer_identity_id, victim_identity_id
     FROM kill_events
     WHERE server_id = $2
       AND (killer_identity_id = $1 OR victim_identity_id = $1)
     ORDER BY timestamp DESC
     LIMIT 200`,
    [identityId, serverId]
  );

  let streak = 0;
  for (const row of rows) {
    if (row.killer_identity_id === identityId) break; // killed someone — stop counting
    if (row.victim_identity_id === identityId) streak++;
  }
  return Math.max(streak, 1);
}

/**
 * Returns the global kill rank for an identity (1 = most kills).
 */
async function fetchServerRank(db, identityId, serverId) {
  const row = await db.get(
    `SELECT rank FROM (
       SELECT killer_identity_id AS identity_id,
              RANK() OVER (ORDER BY COUNT(*) DESC) AS rank
       FROM kill_events
       WHERE killer_identity_id IS NOT NULL AND server_id = $2
       GROUP BY killer_identity_id
     ) ranked
     WHERE identity_id = $1`,
    [identityId, serverId]
  );
  return row ? Number(row.rank) : null;
}

/**
 * Returns the time in milliseconds the victim was alive in their last
 * session (login_at → kill event timestamp).
 */
async function fetchVictimTimeAlive(db, identityId, serverId, killTimestamp) {
  const row = await db.get(
    `SELECT login_at FROM player_sessions
     WHERE identity_id = $1 AND server_id = $2
       AND login_at <= $3
       AND (logout_at IS NULL OR logout_at >= $3)
     ORDER BY login_at DESC
     LIMIT 1`,
    [identityId, serverId, killTimestamp]
  );
  if (!row?.login_at) return null;

  const loginMs = new Date(row.login_at).getTime();
  const killMs  = killTimestamp ? new Date(killTimestamp).getTime() : Date.now();
  const diff    = killMs - loginMs;
  return diff > 0 ? diff : null;
}

async function fetchWalletBalance(db, identityId, serverId) {
  const row = await db.get(
    `SELECT cash_on_hand FROM player_wallets
     WHERE identity_id = $1 AND server_id = $2`,
    [identityId, serverId]
  );
  return row?.cash_on_hand == null
    ? null
    : amountForResponse(row.cash_on_hand, 'Wallet balance');
}

/* ─── Main processor ──────────────────────────────────────────────────────── */

/**
 * Process all pending feed events
 */
async function processFeedEvents(db, {
  intervalSeconds = 30,
  beginStatus = beginPipelineRun,
  finishStatus = finishPipelineRun,
  processServerFeeds = processServerFeedEvents,
  cleanupEvents = cleanupOldEvents,
  logger = console,
} = {}) {
  if (feedTickRunning) {
    return { status: 'skipped', queues: 0 };
  }
  feedTickRunning = true;
  try {
    const serverQueues = await db.query(
      `SELECT DISTINCT df.guild_id, df.server_id
         FROM discord_feeds df
         JOIN servers s ON s.id = df.server_id AND s.status = 'active'
         JOIN guilds g ON g.discord_guild_id = df.guild_id AND g.id = s.guild_id
                        AND g.status = 'approved'
        WHERE df.enabled = 1
       UNION
       SELECT DISTINCT fe.guild_id, fe.server_id
         FROM feed_events fe
         JOIN servers s ON s.id = fe.server_id AND s.status = 'active'
         JOIN guilds g ON g.discord_guild_id = fe.guild_id AND g.id = s.guild_id
                        AND g.status = 'approved'
        WHERE (fe.processed = 0 AND fe.next_attempt_at <= CURRENT_TIMESTAMP)
           OR (fe.processed = 3 AND fe.lease_expires_at <= CURRENT_TIMESTAMP)`
    );

    logger.log(`📨 Processing feeds for ${serverQueues.length} server queues`);

    let failed = 0;
    for (const { guild_id, server_id } of serverQueues) {
      let pipelineRun = null;
      try {
        pipelineRun = await beginStatus(db, {
          serverId: Number(server_id),
          pipeline: PIPELINES.FEED_PROCESSOR,
          intervalSeconds,
        });
      } catch (error) {
        logger.error?.(`[feed] failed to record start for server ${server_id}:`, error.message);
      }

      let outcome;
      try {
        outcome = await processServerFeeds(db, guild_id, server_id);
      } catch (error) {
        logger.error?.(`❌ Error processing server ${server_id} feeds in guild ${guild_id}:`, error.message);
        outcome = { status: 'failed', events: 0 };
      }
      if (outcome.status === 'failed') failed += 1;
      if (pipelineRun) {
        await finishStatus(db, pipelineRun, {
          status: outcome.status === 'failed' ? 'failed' : 'healthy',
          errorCode: outcome.status === 'failed' ? 'FEED_PROCESSING_FAILED' : null,
          counters: { claimed: outcome.events || 0, failed: outcome.failed || 0 },
        }).catch(error => {
          logger.error?.(`[feed] failed to record completion for server ${server_id}:`, error.message);
        });
      }
    }

    await cleanupEvents(db);
    return {
      status: failed > 0 ? 'degraded' : 'succeeded',
      queues: serverQueues.length,
      failed,
    };
  } catch (error) {
    logger.error('❌ Error processing feed events:', error);
    return { status: 'failed', queues: 0 };
  } finally {
    feedTickRunning = false;
  }
}

/**
 * Process events for a specific server within a Discord guild.
 */
async function processServerFeedEvents(db, guildId, serverId, {
  processOne = processEvent,
} = {}) {
  try {
    const [killFeedConfig, factionFeedConfig] = await Promise.all([
      db.get(`SELECT * FROM discord_feeds WHERE guild_id = ? AND server_id = ? AND feed_type = 'kill_feed'    AND enabled = 1`, [guildId, serverId]),
      db.get(`SELECT * FROM discord_feeds WHERE guild_id = ? AND server_id = ? AND feed_type = 'faction_feed' AND enabled = 1`, [guildId, serverId]),
    ]);

    const enabledFeedTypes = [];
    if (killFeedConfig) enabledFeedTypes.push('kill_feed');
    if (factionFeedConfig) enabledFeedTypes.push('faction_feed');
    await suppressDisabledFeedEvents(db, guildId, serverId, enabledFeedTypes);

    if (!killFeedConfig && !factionFeedConfig) {
      const pendingCount = await db.get(
        `SELECT COUNT(*) AS count FROM feed_events WHERE guild_id = ? AND server_id = ? AND processed = 0`,
        [guildId, serverId]
      );
      const count = Number(pendingCount?.count || 0);
      if (count > 0) {
        console.log(`💡 Server ${serverId} in guild ${guildId} has ${count} pending events but NO feeds configured`);
      } else {
        console.log(`⏭️ No active feeds for server ${serverId} in guild ${guildId}`);
      }
      return { status: 'succeeded', events: 0 };
    }

    const events = await claimPendingEvents(db, guildId, serverId, 50, enabledFeedTypes);
    console.log(`📬 Processing ${events.length} events for server ${serverId} in guild ${guildId}`);

    const killSettings    = killFeedConfig    ? (JSON.parse(killFeedConfig.settings    || '{}')) : null;
    const factionSettings = factionFeedConfig ? (JSON.parse(factionFeedConfig.settings || '{}')) : null;

    let failed = 0;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      let outcome;

      if (event.feed_type === 'faction_feed' && factionFeedConfig) {
        outcome = await processOne(db, event, factionFeedConfig, factionSettings);
      } else if (event.feed_type === 'kill_feed' && killFeedConfig) {
        outcome = await processOne(db, event, killFeedConfig, killSettings);
      } else {
        console.log(`⏸️ Keeping ${event.feed_type} event ${event.id} pending; no matching enabled feed`);
        outcome = 'failed';
      }
      if (outcome === 'failed') failed += 1;

      if (i < events.length - 1) {
        await new Promise(resolve => setTimeout(resolve, MIN_DELAY_MS));
      }
    }
    return { status: failed > 0 ? 'failed' : 'succeeded', events: events.length, failed };
  } catch (error) {
    console.error(`❌ Error processing server ${serverId} feeds in guild ${guildId}:`, error);
    return { status: 'failed', events: 0 };
  }
}

/**
 * Process a single event.
 * player_kill events get the rich embed; everything else uses templates.
 */
async function processEvent(db, event, feedConfig, settings) {
  try {
    const eventData = JSON.parse(event.event_data);

    if (!shouldPostEvent(event.event_type, eventData, settings)) {
      console.log(`⏭️ Skipping ${event.event_type} (filtered)`);
      await markEventProcessed(db, event.id, true, event.claim_token);
      return 'succeeded';
    }

    const server = await db.get(
      `SELECT s.id, s.name, g.discord_guild_id
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
       WHERE s.id = ? AND g.discord_guild_id = ?
         AND s.status = 'active' AND g.status = 'approved'`,
      [event.server_id, event.guild_id]
    );
    if (!server) {
      await markEventProcessed(db, event.id, false, event.claim_token);
      return 'failed';
    }
    const serverName = server?.name || 'Server';

    if (!(await validateDiscordDestination(
      server.discord_guild_id,
      feedConfig.channel_id,
      feedConfig.webhook_url
    ))) {
      await markEventProcessed(db, event.id, false, event.claim_token);
      return 'failed';
    }

    let content;

    if (event.event_type === 'player_kill' && (settings?.useEmbed !== false)) {
      // Build the rich kill-feed embed with live stats
      content = await buildPlayerKillEmbed(db, eventData, settings, serverName, server.id);
    } else {
      // Legacy template path for non-kill events
      const template = await getTemplate(db, event.server_id, event.feed_type, event.event_type);
      const message  = formatMessage(template, eventData, serverName);
      const useEmbed = settings?.useEmbed || false;
      content = useEmbed
        ? formatEmbed(message, settings?.embedColor || '#ff0000', event.event_type)
        : message;
    }

    const success = await postToDiscord(
      feedConfig.channel_id,
      feedConfig.webhook_url,
      content,
      true // always send as Discord embed payload
    );

    if (success) {
      await markEventProcessed(db, event.id, true, event.claim_token);
      console.log(`✅ Posted ${event.event_type} to Discord`);
      return 'succeeded';
    }

    await markEventFailed(db, event.id, event.claim_token, new Error('Discord delivery failed'));
    console.error(`❌ Failed to post ${event.event_type}; retry scheduled`);
    return 'failed';

  } catch (error) {
    console.error(`❌ Error processing event ${event.id}:`, error);
    await markEventFailed(db, event.id, event.claim_token, error);
    return 'failed';
  }
}

/**
 * Builds the full rich kill embed by querying live DB stats.
 */
async function buildPlayerKillEmbed(db, eventData, settings, serverName, serverId) {
  const {
    killerIdentityId, victimIdentityId,
    killRewardAmount = 0, lootAmount = 0,
    bountyAwardAmount = eventData.bountyClaimAmount || 0,
    bountyRefundAmount = 0,
    bountyDeferredAwardAmount = eventData.bountyDeferredClaimAmount || 0,
    bountyDeferredRefundAmount = 0
  } = eventData;

  // Fetch all stats in parallel
  const [killerKD, victimKD, killerStreak, victimStreak, killerRank, victimRank, timeAliveMs, killerBalance] =
    await Promise.all([
      killerIdentityId ? fetchKDStats(db, killerIdentityId, serverId) : { kills: 0, deaths: 0 },
      victimIdentityId ? fetchKDStats(db, victimIdentityId, serverId) : { kills: 0, deaths: 0 },
      killerIdentityId ? fetchKillStreak(db, killerIdentityId, serverId) : 1,
      victimIdentityId ? fetchDeathStreak(db, victimIdentityId, serverId) : 1,
      killerIdentityId ? fetchServerRank(db, killerIdentityId, serverId) : null,
      victimIdentityId ? fetchServerRank(db, victimIdentityId, serverId) : null,
      (victimIdentityId && serverId)
        ? fetchVictimTimeAlive(db, victimIdentityId, serverId, eventData.timestamp)
        : Promise.resolve(null),
      (killerIdentityId && serverId)
        ? fetchWalletBalance(db, killerIdentityId, serverId)
        : Promise.resolve(null),
    ]);

  // Fetch economy config to get currency symbol
  let currencySymbol = '₽';
  try {
    if (killerIdentityId) {
      const cfg = await db.get(
        `SELECT gec.currency_symbol
         FROM servers s
         JOIN guild_economy_config gec ON gec.server_id = s.id
         WHERE s.id = $1 AND s.status = 'active' LIMIT 1`,
        [serverId]
      );
      if (cfg?.currency_symbol) currencySymbol = cfg.currency_symbol;
    }
  } catch (_) { /* leave default */ }

  const killerStats = {
    kills:       killerKD.kills,
    deaths:      killerKD.deaths,
    killStreak:  killerStreak,
    globalRank:  killerRank,
  };

  const victimStats = {
    kills:       victimKD.kills,
    deaths:      victimKD.deaths,
    deathStreak: victimStreak,
    globalRank:  victimRank,
    timeAliveMs,
  };

  // Only include economy info when there's something economy-related to show
  const hasEconomyActivity = killRewardAmount > 0 || lootAmount > 0
    || bountyAwardAmount > 0 || bountyRefundAmount > 0
    || bountyDeferredAwardAmount > 0 || bountyDeferredRefundAmount > 0 || killerBalance != null;
  const economyInfo = hasEconomyActivity
    ? {
      currencySymbol, killerBalance, killRewardAmount, lootAmount,
      bountyAwardAmount, bountyRefundAmount,
      bountyDeferredAwardAmount, bountyDeferredRefundAmount,
    }
    : null;

  return buildKillEmbedPayload(eventData, killerStats, victimStats, economyInfo, settings, serverName);
}

/* ─── Filters & templates ─────────────────────────────────────────────────── */

function shouldPostEvent(eventType, eventData, settings) {
  if (eventType === 'player_kill') {
    if (settings.showPlayers === false) return false;
    const minDistance = settings.minDistance || 0;
    if (eventData.distance < minDistance) return false;
  }
  if (eventType === 'zombie_kill'  && settings.showZombies === false) return false;
  if (eventType === 'animal_kill'  && settings.showAnimals === false) return false;
  if (eventType === 'suicide'      && settings.showSuicides === false) return false;
  return true;
}

async function getTemplate(db, serverId, feedType, eventType) {
  const row = await db.get(
    `SELECT template FROM feed_templates
     WHERE server_id = ? AND feed_type = ? AND event_type = ?`,
    [serverId, feedType, eventType]
  );
  return row?.template || getDefaultTemplate(eventType);
}

/* ─── Worker ──────────────────────────────────────────────────────────────── */

function startFeedProcessor(db, intervalSeconds = 30) {
  const run = () => processFeedEvents(db, { intervalSeconds });
  console.log(`🚀 Starting feed processor (interval: ${intervalSeconds}s)`);
  run();
  const timer = setInterval(run, intervalSeconds * 1000);
  timer.unref?.();
  return timer;
}

module.exports = {
  processFeedEvents,
  processServerFeedEvents,
  startFeedProcessor,
  fetchVictimTimeAlive,
  fetchWalletBalance,
};

