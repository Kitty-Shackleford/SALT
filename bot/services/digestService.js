/*
 * bot/services/digestService.js
 *
 * Daily/weekly server digest — AI-written summary of ingested data, posted
 * by the existing bot identity into the configured per-guild channel.
 *
 * Data sources (all ingested, none invented):
 *   - server_restart_log        restarts/crashes in the window
 *   - kill_events               top killers / kill counts in the window
 *   - loot_despawn_events       loot throughput trends in the window
 *   - discord_member_events     joins/leaves in the window
 *   - server_online_cache       current player count (live snapshot)
 *
 * The LLM (shared router) polishes the wording; when it is down or
 * unconfigured, a deterministic digest is posted instead. The window is
 * recorded in guild_ai_settings.digest_state so the same period is never
 * posted twice (safe across bot restarts).
 *
 * Feature gate: guild_ai_settings.digest_enabled (default OFF).
 */

'use strict';

const pool = require('../db');
const { isConfigured, chat } = require('./botAiRouterService');

const DIGEST_SYSTEM_PROMPT = [
  'You write a short, friendly server digest for a DayZ Discord community.',
  'Use ONLY the numbers and facts provided. Never invent players, events or stats.',
  'When a section has no data, say so briefly. Keep the whole digest under 250 words.',
  'Plain Discord markdown. Open with a one-line summary of the period.',
].join(' ');

const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const WEEKLY_WINDOW_MS = 7 * DAILY_WINDOW_MS;

async function getDigestSettings(guildId, db = pool) {
  const res = await db.query(
    `SELECT g.id AS guild_db_id,
            COALESCE(gf.digest_enabled, FALSE) AS digest_enabled,
            gf.digest_channel_id,
            COALESCE(gf.digest_interval, 'daily') AS digest_interval,
            gf.digest_state
     FROM guilds g
     LEFT JOIN guild_ai_settings gf ON gf.guild_id = g.id
     WHERE g.discord_guild_id = $1 LIMIT 1`,
    [String(guildId)]
  );
  const row = res.rows[0];
  if (!row) return null;
  let state = {};
  if (row.digest_state) {
    try {
      state = typeof row.digest_state === 'string'
        ? JSON.parse(row.digest_state)
        : row.digest_state;
    } catch {
      state = {};
    }
  }
  return {
    guildDbId: row.guild_db_id,
    enabled: Boolean(row.digest_enabled),
    channelId: row.digest_channel_id,
    interval: row.digest_interval === 'weekly' ? 'weekly' : 'daily',
    state,
  };
}

function windowForInterval(interval) {
  return interval === 'weekly' ? WEEKLY_WINDOW_MS : DAILY_WINDOW_MS;
}

/**
 * True when a digest is due for this guild (no state, or the last posted
 * window is older than the configured interval).
 */
function isDue(settings, nowMs = Date.now()) {
  const lastPosted = Number(settings.state?.lastPostedMs || 0);
  return nowMs - lastPosted >= windowForInterval(settings.interval);
}

/**
 * Collect the digest data blocks from ingested tables.
 * All queries are best-effort: a missing table or empty result yields a
 * "no data" line, never a failure.
 */
async function collectDigestData(guildDbId, sinceMs, db = pool) {
  const since = new Date(sinceMs);
  const data = {
    restarts: null,
    topKillers: null,
    killsTotal: null,
    lootTop: null,
    lootTotal: null,
    joins: 0,
    leaves: 0,
    onlineNow: null,
    opsWarnings: null,
  };

  // Server rows for this guild (active).
  const serverRes = await db.query(
    `SELECT id, name FROM servers WHERE guild_id = $1 AND status = 'active' ORDER BY id`,
    [guildDbId]
  );
  const serverIds = serverRes.rows.map(row => row.id);
  if (serverIds.length === 0) return data;

  try {
    const restarts = await db.query(
      `SELECT restart_type, COUNT(*) AS count
       FROM server_restart_log
       WHERE server_id = ANY($1::int[]) AND detected_at >= $2
       GROUP BY restart_type`,
      [serverIds, since]
    );
    if (restarts.rows.length) {
      data.restarts = restarts.rows.map(r => `${r.count} ${r.restart_type}`).join(', ');
    }
  } catch (err) {
    console.warn(`⚠️ [digest] restarts query failed: ${err.message}`);
  }

  try {
    const killers = await db.query(
      `SELECT killer_gamertag, COUNT(*) AS kills
       FROM kill_events
       WHERE server_id = ANY($1::int[])
         AND timestamp >= $2
         AND killer_gamertag IS NOT NULL AND killer_gamertag <> ''
       GROUP BY killer_gamertag
       ORDER BY kills DESC
       LIMIT 5`,
      [serverIds, since]
    );
    if (killers.rows.length) {
      data.topKillers = killers.rows.map((r, i) =>
        `${i + 1}. **${r.killer_gamertag}** — ${r.kills} kill${r.kills === 1 ? '' : 's'}`
      ).join('\n');
      const total = await db.query(
        `SELECT COUNT(*) AS c FROM kill_events WHERE server_id = ANY($1::int[]) AND timestamp >= $2`,
        [serverIds, since]
      );
      data.killsTotal = Number(total.rows[0]?.c ?? 0);
    }
  } catch (err) {
    console.warn(`⚠️ [digest] kill query failed: ${err.message}`);
  }

  try {
    const loot = await db.query(
      `SELECT item_class, COUNT(*) AS despawns
       FROM loot_despawn_events
       WHERE server_id = ANY($1::int[]) AND log_date >= $2::date
       GROUP BY item_class
       ORDER BY despawns DESC
       LIMIT 5`,
      [serverIds, since.toISOString().slice(0, 10)]
    );
    if (loot.rows.length) {
      data.lootTop = loot.rows.map(r => `- \`${r.item_class}\` — ${r.despawns} despawn${r.despawns === 1 ? '' : 's'}`).join('\n');
      data.lootTotal = Number(loot.rows.reduce((sum, r) => sum + r.despawns, 0));
    }
  } catch (err) {
    console.warn(`⚠️ [digest] loot query failed: ${err.message}`);
  }

  try {
    const members = await db.query(
      `SELECT kind, COUNT(*) AS c
       FROM discord_member_events
       WHERE guild_id = $1 AND occurred_at >= $2
       GROUP BY kind`,
      [guildDbId, since]
    );
    for (const row of members.rows) {
      if (row.kind === 'join') data.joins = Number(row.c);
      else if (row.kind === 'leave') data.leaves = Number(row.c);
    }
  } catch (err) {
    console.warn(`⚠️ [digest] member events query failed: ${err.message}`);
  }

  try {
    const online = await db.query(
      `SELECT COUNT(*) AS c FROM (
         SELECT DISTINCT soc.server_id, soc.gamertag
         FROM server_online_cache soc
         JOIN server_online_cache_snapshots snapshot ON snapshot.server_id = soc.server_id
         WHERE soc.server_id = ANY($1::int[])
           AND snapshot.source_observed_at >= clock_timestamp() - INTERVAL '60 minutes'
           AND snapshot.source_observed_at <= clock_timestamp() + INTERVAL '5 minutes'
       ) t`,
      [serverIds]
    );
    const c = Number(online.rows[0]?.c ?? 0);
    data.onlineNow = c > 0 ? c : 0;
  } catch (err) {
    console.warn(`⚠️ [digest] online count query failed: ${err.message}`);
  }

  // New ops warnings in this window (best-effort; the ops-intelligence
  // endpoints persist these to ops_warnings). Appended to the digest only.
  try {
    const ops = await db.query(
      `SELECT w.severity, w.payload->>'label' AS label
       FROM ops_warnings w
       JOIN servers s ON s.id = w.server_id
       WHERE s.guild_id = $1
         AND w.deleted_at IS NULL
         AND w.detected_at >= $2
       ORDER BY w.detected_at DESC
       LIMIT 5`,
      [guildDbId, since]
    );
    if (ops.rows.length) {
      data.opsWarnings = ops.rows
        .map(r => `- \`${r.severity}\` ${r.label || 'ops warning'}`)
        .join('\n');
    }
  } catch (err) {
    console.warn(`⚠️ [digest] ops warnings query failed: ${err.message}`);
  }

  return data;
}

function buildDigestFacts(data, interval, sinceMs) {
  const sinceLabel = new Date(sinceMs).toISOString().slice(0, 10);
  const lines = [
    `Period: ${interval} digest, covering since ${sinceLabel}.`,
    data.restarts
      ? `Restarts/crashes: ${data.restarts}.`
      : 'Restarts/crashes: none recorded in this window.',
    data.killsTotal !== null && data.killsTotal > 0
      ? `Kills recorded: ${data.killsTotal}. Top killers:\n${data.topKillers}`
      : 'Kills: none recorded in this window.',
    data.lootTop
      ? `Loot cleanup activity (top despawned items):\n${data.lootTop}`
      : 'Loot: no despawn events ingested in this window.',
    `Discord community: ${data.joins} join(s), ${data.leaves} leave(s).`,
    data.onlineNow !== null
      ? `Currently online (fresh log evidence): ${data.onlineNow} player(s).`
      : 'Currently online: unknown.',
    data.opsWarnings
      ? `New ops warnings in this window:\n${data.opsWarnings}`
      : 'Ops warnings: none new in this window.',
  ];
  return lines.join('\n');
}

function deterministicDigest(data, interval) {
  const header = interval === 'weekly' ? '📈 **Weekly server digest**' : '📅 **Daily server digest**';
  const sections = [];
  sections.push(data.restarts
    ? `**Restarts/crashes:** ${data.restarts}`
    : '**Restarts/crashes:** none recorded.');
  if (data.topKillers) {
    sections.push(`**Top killers (${data.killsTotal} kills):**\n${data.topKillers}`);
  } else {
    sections.push('**Kills:** none recorded.');
  }
  sections.push(data.lootTop ? `**Loot movement (top items cleaned up):**\n${data.lootTop}` : '**Loot:** no despawn activity recorded.');
  sections.push(`**Community:** ${data.joins} joined, ${data.leaves} left.`);
  if (data.onlineNow !== null) sections.push(`**Now online:** ${data.onlineNow} player(s).`);
  sections.push(data.opsWarnings ? `**New ops warnings:**\n${data.opsWarnings}` : '**Ops warnings:** none new recorded.');
  return `${header}\n\n${sections.join('\n\n')}`;
}

/**
 * Build the digest content (LLM-polished when available).
 */
async function buildDigestContent(data, interval, sinceMs, env = process.env) {
  const facts = buildDigestFacts(data, interval, sinceMs);
  if (isConfigured(env)) {
    const polished = await chat([
      { role: 'system', content: DIGEST_SYSTEM_PROMPT },
      { role: 'user', content: facts },
    ], env);
    if (polished) return polished;
  }
  return deterministicDigest(data, interval);
}

/**
 * One digest pass across all enabled guilds. Returns the number of
 * digests posted.
 */
async function runDigestPass(client, db = pool, nowMs = Date.now()) {
  const res = await db.query(
    `SELECT g.id AS guild_db_id, g.discord_guild_id
     FROM guilds g
     JOIN guild_ai_settings gf ON gf.guild_id = g.id
     WHERE g.status = 'approved'
       AND gf.digest_enabled = TRUE
       AND gf.digest_channel_id IS NOT NULL
     ORDER BY g.id`
  );

  let posted = 0;
  for (const row of res.rows) {
    try {
      const settings = await getDigestSettings(row.discord_guild_id, db);
      if (!settings?.enabled || !settings.channelId) continue;
      if (!isDue(settings, nowMs)) continue;

      const windowMs = windowForInterval(settings.interval);
      const sinceMs = nowMs - windowMs;
      const data = await collectDigestData(settings.guildDbId, sinceMs, db);
      const content = await buildDigestContent(data, settings.interval, sinceMs);

      const channel = await client.channels.fetch(settings.channelId);
      if (!channel || channel.guildId !== String(row.discord_guild_id)) {
        console.warn(`⚠️ [digest] channel ${settings.channelId} not usable in guild ${row.discord_guild_id}`);
        continue;
      }
      await channel.send(content.slice(0, 4000));

      // Mark posted only after a successful send, so a failure retries next pass.
      await db.query(
        `INSERT INTO guild_ai_settings (guild_id, digest_state)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (guild_id) DO UPDATE SET digest_state = EXCLUDED.digest_state, updated_at = NOW()`,
        [settings.guildDbId, JSON.stringify({ lastPostedMs: nowMs, interval: settings.interval })]
      );
      posted += 1;
      console.log(`✅ [digest] posted ${settings.interval} digest for guild ${row.discord_guild_id}`);
    } catch (error) {
      console.error(`❌ [digest] pass failed for guild ${row.discord_guild_id}:`, error.message);
    }
  }
  return posted;
}

/**
 * Start the digest loop (5-minute tick; the due check is per-guild and
 * state-backed, so the tick only ever posts a digest that is genuinely due).
 */
function startDigestLoop(client, { intervalMs = 5 * 60 * 1000, db = pool } = {}) {
  console.log(`📊 Digest loop started (interval: ${intervalMs / 1000}s)`);
  const tick = () => {
    runDigestPass(client, db).catch(error =>
      console.error('❌ [digest] runDigestPass error:', error.message)
    );
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return timer;
}

module.exports = {
  getDigestSettings,
  windowForInterval,
  isDue,
  collectDigestData,
  buildDigestFacts,
  deterministicDigest,
  buildDigestContent,
  runDigestPass,
  startDigestLoop,
};
