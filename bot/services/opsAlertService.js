/*
 * bot/services/opsAlertService.js
 *
 * Optional per-guild Discord alerts for NEW high/critical ops warnings
 * (AI feature 7d). Posts with the existing bot identity into a configured
 * channel, reusing the digestService channel-posting pattern (fetch channel,
 * verify guild, send, 4000-char cap) and its state-backed watermark
 * convention (guild_ai_settings.ops_alert_state) so each warning is posted
 * at most once per 24h.
 *
 * Source: the ops_warnings table, persisted by the ops-intelligence
 * endpoints (services/opsIntelligenceService.persistWarnings). Only high /
 * critical rows alert; medium/low stay dashboard-only. The rollback advisor
 * is advisory-only (never persisted) and is intentionally out of scope here —
 * alerting on it would need new state, i.e. new alerting infrastructure.
 *
 * Feature gate: guild_ai_settings.ops_alert_enabled (default OFF).
 */

'use strict';

const pool = require('../db');

const ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

function dashboardUrl(env = process.env) {
  const raw = env.DASHBOARD_URL || env.BASE_URL || '';
  return raw ? String(raw).replace(/\/+$/, '') : '';
}

function parseState(value) {
  if (!value) return {};
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } }
  return value;
}

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } }
  return value;
}

/**
 * Build one compact ops alert message: server, pattern name, severity,
 * "preceded a crash on <date>" context (when correlated), and a dashboard link.
 */
function buildAlertContent(warning, { dashboardBase } = {}) {
  const payload = parsePayload(warning.payload);
  const label = payload.label || warning.precursor_id || 'unknown pattern';
  const serverName = warning.server_name || warning.platform_server_id || 'unknown server';
  const lines = [];
  lines.push(`🚨 **Ops alert — ${serverName}**`);
  lines.push(`**${label}** — severity \`${warning.severity}\``);
  const preceded = payload.lastCrashPreceded;
  if (preceded && preceded.atMs) {
    lines.push(`Matched a pattern that **preceded a crash on ${new Date(preceded.atMs).toISOString().slice(0, 10)}** (${preceded.occurrences} crash window${preceded.occurrences === 1 ? '' : 's'}).`);
  }
  if (payload.occurrences) {
    lines.push(`${payload.occurrences} occurrence${payload.occurrences === 1 ? '' : 's'} in the last 24h; last seen ${new Date(warning.detected_at).toISOString().slice(0, 10)}.`);
  }
  const link = dashboardBase ? `${dashboardBase}/dashboard/server-stats` : null;
  if (link) lines.push(`[Open the dashboard server panel](${link})`);
  return lines.join('\n').slice(0, 4000);
}

/**
 * One ops-alert pass across all enabled guilds. Returns the number of
 * alerts posted.
 */
async function runOpsAlertPass(client, db = pool, nowMs = Date.now()) {
  const dashboardBase = dashboardUrl(process.env);
  const since = new Date(nowMs - ALERT_WINDOW_MS);

  const res = await db.query(
    `SELECT g.id AS guild_db_id, g.discord_guild_id,
            gf.ops_alert_channel_id AS channel_id,
            gf.ops_alert_state
     FROM guilds g
     JOIN guild_ai_settings gf ON gf.guild_id = g.id
     WHERE g.status = 'approved'
       AND gf.ops_alert_enabled = TRUE
       AND gf.ops_alert_channel_id IS NOT NULL
     ORDER BY g.id`
  );

  let posted = 0;
  for (const row of res.rows) {
    const watermark = Number(parseState(row.ops_alert_state).lastId || 0);
    let highestPostedId = watermark;
    try {
      const alerts = await db.query(
        `SELECT w.id, w.precursor_id, w.severity, w.detected_at, w.payload,
                s.name AS server_name, s.platform_server_id
         FROM ops_warnings w
         JOIN servers s ON s.id = w.server_id
         JOIN guilds g ON g.id = s.guild_id
         WHERE g.discord_guild_id = $1
           AND w.id > $2
           AND w.severity IN ('high', 'critical')
           AND w.deleted_at IS NULL
           AND w.detected_at >= $3
         ORDER BY w.id`,
        [row.discord_guild_id, watermark, since]
      );

      if (alerts.rows.length) {
        const channel = await client.channels.fetch(String(row.channel_id));
        if (!channel || channel.guildId !== String(row.discord_guild_id)) {
          console.warn(`⚠️ [ops-alert] channel ${row.channel_id} not usable in guild ${row.discord_guild_id}`);
        } else {
          for (const warning of alerts.rows) {
            await channel.send(buildAlertContent(warning, { dashboardBase }));
            posted += 1;
            highestPostedId = warning.id;
            console.log(`✅ [ops-alert] posted ${warning.severity} alert (${warning.precursor_id}) for guild ${row.discord_guild_id}`);
          }
        }
      }
    } catch (error) {
      console.error(`❌ [ops-alert] pass failed for guild ${row.discord_guild_id}:`, error.message);
    }

    // Advance the watermark only up to the highest successfully posted id, so
    // a failed send never skips a warning (it is retried on the next pass).
    if (highestPostedId > watermark) {
      await db.query(
        `INSERT INTO guild_ai_settings (guild_id, ops_alert_state)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (guild_id) DO UPDATE SET ops_alert_state = EXCLUDED.ops_alert_state, updated_at = NOW()`,
        [row.guild_db_id, JSON.stringify({ lastId: highestPostedId })]
      );
    }
  }
  return posted;
}

/**
 * Start the ops-alert loop (5-minute tick; the watermark + 24h window mean a
 * tick only ever posts a genuinely new high/critical warning).
 */
function startOpsAlertLoop(client, { intervalMs = 5 * 60 * 1000, db = pool } = {}) {
  console.log(`🚨 Ops-alert loop started (interval: ${intervalMs / 1000}s)`);
  const tick = () => {
    runOpsAlertPass(client, db).catch(error =>
      console.error('❌ [ops-alert] runOpsAlertPass error:', error.message)
    );
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return timer;
}

module.exports = {
  ALERT_WINDOW_MS,
  buildAlertContent,
  runOpsAlertPass,
  startOpsAlertLoop,
};
