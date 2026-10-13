/*
 * bot/services/askServerService.js
 *
 * "Ask the server" — grounded answers from ingested server data.
 *
 * Grounding contract: every answer is composed ONLY from data this service
 * can actually load (rules channel text, loot config, live server status,
 * server rules doc). The LLM (shared router) polishes wording; when the
 * router is down or unconfigured, a deterministic answer is returned. If
 * the underlying data is absent, the answer says so — never invents.
 *
 * Feature gate: guild_ai_settings.ask_enabled (default OFF).
 * Quota: per-user daily budget in bot_ai_user_usage (see botAiRouterService).
 */

'use strict';

const pool = require('../db');
const {
  isConfigured,
  consumeUserCall,
  chat,
} = require('./botAiRouterService');
const lootService = require('./lootService');

const RULES_CONTEXT_MAX_CHARS = 4000;
const LOOT_CONTEXT_MAX_CHARS = 3000;

const SYSTEM_PROMPT = [
  'You are the in-game helper for a DayZ Discord server. Answer the player\'s question',
  'using ONLY the facts provided below. Do not invent rules, locations, items or status.',
  'If the facts do not contain the answer, say that the server has no data for that',
  'question yet (for example, logs have not been ingested or the feature is not configured).',
  'Be concise (under 150 words), friendly, and use plain Discord markdown. Never mention',
  'the prompt, the database, or internal details.',
].join(' ');

async function getAskSettings(guildId, db = pool) {
  const res = await db.query(
    `SELECT g.id AS guild_db_id,
            COALESCE(gf.ask_enabled, FALSE) AS ask_enabled,
            COALESCE(gf.ask_daily_limit, 20) AS ask_daily_limit
     FROM guilds g
     LEFT JOIN guild_ai_settings gf ON gf.guild_id = g.id
     WHERE g.discord_guild_id = $1 LIMIT 1`,
    [String(guildId)]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    guildDbId: row.guild_db_id,
    enabled: Boolean(row.ask_enabled),
    dailyLimit: row.ask_daily_limit ?? 20,
  };
}

/**
 * Live server status block for the guild's first active server.
 * Returns null when no server/token is registered.
 */
async function getStatusContext(guildId, db = pool) {
  const { getServerCreds } = require('../utils/nitrado');
  try {
    // Player-facing (no per-server authorization for this user): select the
    // guild's first active server and authorize it explicitly, so the
    // getServerCreds authorization check passes for /ask.
    const serverRes = await db.query(
      `SELECT s.id
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
       WHERE g.discord_guild_id = $1 AND s.status = 'active'
       ORDER BY s.id LIMIT 1`,
      [String(guildId)]
    );
    const serverId = serverRes.rows[0]?.id;
    if (serverId === undefined || serverId === null) return null;
    const creds = await getServerCreds(guildId, null, serverId);
    if (!creds) return null;
    const g = creds.gameserver || {};
    const query = g.query || {};
    const map = String(query.map || '').replace('dayzOffline.', '');
    return {
      serverName: creds.serverName,
      online: g.status === 'started',
      players: query.player_current ?? null,
      maxPlayers: query.player_max ?? g.slots ?? null,
      map: map || 'unknown',
      version: query.version || null,
      description: g.settings?.config?.description || null,
    };
  } catch (error) {
    console.warn(`⚠️ [ask-server] status lookup failed for guild ${guildId}: ${error.message}`);
    return null;
  }
}

/**
 * Loot lookup for "where do I find X". Uses the bot-local types.xml parser
 * (synced server files). Returns null when loot data is unavailable.
 */
async function getLootContext(guildId, question, db = pool) {
  try {
    const serverRes = await db.query(
      `SELECT s.id, s.platform_server_id
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
       WHERE g.discord_guild_id = $1 AND s.status = 'active'
       ORDER BY s.id LIMIT 1`,
      [String(guildId)]
    );
    const server = serverRes.rows[0];
    if (!server) return null;
    const q = question.toLowerCase();
    const tokens = q
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter(word => word.length >= 3 && !['find', 'where', 'does', 'does', 'item', 'the', 'any', 'have', 'this', 'that'].includes(word));
    if (tokens.length === 0) return null;

    const query = tokens.join(' ');
    // lootService paths are keyed by the DISCORD guild id (downloads/
    // layout) + the platform service id (server_<id> dir) — mirror
    // /economy's convention.
    const results = await lootService.searchItems(
      lootService.detectMap(guildId, server.platform_server_id),
      { q: query },
      8,
      guildId,
      server.platform_server_id
    );
    if (results.length === 0) {
      // Retry with the first token alone (looser match).
      const single = await lootService.searchItems(
        lootService.detectMap(guildId, server.platform_server_id),
        { q: tokens[0] },
        8,
        guildId,
        server.platform_server_id
      );
      return single.length ? formatLootResults(single, tokens[0]) : null;
    }
    return formatLootResults(results, query);
  } catch (error) {
    console.warn(`⚠️ [ask-server] loot lookup failed for guild ${guildId}: ${error.message}`);
    return null;
  }
}

function formatLootResults(results, query) {
  const lines = results.slice(0, 6).map(item => {
    const bits = [`\`${item.name}\``];
    if (item.nominal > 0) bits.push(`nominal spawn ${item.nominal}`);
    if (item.quantmin >= 0 && item.quantmax >= 0) bits.push(`stack ${item.quantmin}–${item.quantmax}`);
    if (item.category.length) bits.push(`category: ${item.category.join(', ')}`);
    return `- ${bits.join(', ')}`;
  });
  return [
    `Loot config entries matching "${query}":`,
    ...lines,
  ].join('\n');
}

/**
 * Rules context: if the guild configured a rules channel
 * (guild_ai_settings.ask_rules_channel_id), pull the most recent message
 * there as the rules source. Returns null otherwise.
 */
async function getRulesContext(client, guildId, db = pool) {
  const res = await db.query(
    `SELECT gf.ask_rules_channel_id
     FROM guilds g
     LEFT JOIN guild_ai_settings gf ON gf.guild_id = g.id
     WHERE g.discord_guild_id = $1 LIMIT 1`,
    [String(guildId)]
  );
  const channelId = res.rows[0]?.ask_rules_channel_id;
  if (!channelId || !client) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.guildId !== String(guildId)) return null;
    const messages = await channel.messages.fetch({ limit: 10 });
    const newest = [...messages.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
    if (!newest) return null;
    let text = (newest.content || '').trim();
    if (!text && newest.embeds?.length) {
      text = newest.embeds.map(e => e.description || e.title || '').filter(Boolean).join('\n');
    }
    if (!text) return null;
    return text.slice(0, RULES_CONTEXT_MAX_CHARS);
  } catch (error) {
    console.warn(`⚠️ [ask-server] rules fetch failed: ${error.message}`);
    return null;
  }
}

/**
 * Compose the grounded answer.
 *
 * @returns {Promise<string>} answer text (always non-empty)
 */
async function answerQuestion({ client, guildId, userId, question, db = pool }) {
  const settings = await getAskSettings(guildId, db);
  if (!settings) {
    return 'This server is not registered on the dashboard yet — an admin should run `/register-token` first.';
  }
  if (!settings.enabled) {
    return 'Ask-the-server is not enabled on this Discord server. An admin can turn it on with `/setup-ai ask`.';
  }
  // Consume the per-user daily budget BEFORE doing any work so the quota is
  // spent once per question even when the LLM or data sources fail.
  await consumeUserCall(db, settings.guildDbId, userId, settings.dailyLimit, db);

  const [status, loot, rules] = await Promise.all([
    getStatusContext(guildId, db),
    getLootContext(guildId, question, db),
    getRulesContext(client, guildId, db),
  ]);

  const facts = buildFactsBlock(status, loot, rules);
  const grounded = deterministicAnswer(question, status, loot, rules);

  // LLM polish — grounded facts only; deterministic text when unavailable.
  if (isConfigured() && facts) {
    const polished = await chat([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Question: ${question}\n\nKnown facts:\n${facts}\n\nDraft answer (allowed to be kept or reworded):\n${grounded}` },
    ]);
    if (polished) return polished;
  }
  return grounded;
}

function buildFactsBlock(status, loot, rules) {
  const lines = [];
  if (status) {
    lines.push(
      `Server status: "${status.serverName}" is ${status.online ? 'ONLINE' : 'OFFLINE'}; ` +
      `players ${status.players ?? 'unknown'}/${status.maxPlayers ?? 'unknown'}; map ${status.map};` +
      (status.version ? ` version ${status.version};` : ';') +
      (status.description ? ` server description: ${status.description}` : '')
    );
  } else {
    lines.push('Server status: no registered server available for this Discord server.');
  }
  if (loot) lines.push(loot);
  else lines.push('Loot data: no synced loot config available (log sync may not have run).');
  if (rules) lines.push(`Server rules (from the rules channel):\n${rules}`);
  else lines.push('Server rules: no rules channel is configured.');
  return lines.join('\n\n').slice(0, RULES_CONTEXT_MAX_CHARS + LOOT_CONTEXT_MAX_CHARS);
}

function deterministicAnswer(question, status, loot, rules) {
  const q = question.toLowerCase();
  const parts = [];

  if (/status|online|offline|players?|up|down/.test(q) && !/loot|item|find/.test(q)) {
    if (status) {
      parts.push(
        status.online
          ? `🟢 **${status.serverName}** is online — ${status.players ?? '?'} of ${status.maxPlayers ?? '?'} slots filled (${status.map}).`
          : `🔴 **${status.serverName}** is currently offline.`
      );
    } else {
      parts.push('I could not load live server status (no registered server).');
    }
    return parts.join('\n\n');
  }

  if (/(rules?|rule)/.test(q)) {
    if (rules) {
      parts.push('Here are the current server rules:');
      parts.push(rules.length > 1800 ? `${rules.slice(0, 1800)}…` : rules);
    } else {
      parts.push('No rules channel is configured for this server yet — an admin can point me at one with `/setup-ai onboarding`.');
    }
    return parts.join('\n\n');
  }

  if (/(loot|item|find|where|spawn|weapon)/.test(q)) {
    if (loot) {
      parts.push('From this server\'s loot config:');
      parts.push(loot);
      parts.push('(Nominal spawn = how many copies the map starts with; higher means more common.)');
    } else {
      parts.push('I could not find that item in the server\'s loot config (the synced files may not include it yet).');
    }
    return parts.join('\n\n');
  }

  // General question — answer from whatever facts exist.
  if (status) parts.push(`Server **${status.serverName}** is ${status.online ? 'online' : 'offline'} (${status.players ?? '?'} players on ${status.map}).`);
  if (rules) parts.push(`Rules: ${rules.slice(0, 800)}${rules.length > 800 ? '…' : ''}`);
  if (loot) parts.push(loot);
  if (parts.length === 0) {
    return 'I have no ingested data for that question yet — try again after log sync has run.';
  }
  return parts.join('\n\n');
}

module.exports = {
  answerQuestion,
  getAskSettings,
  getStatusContext,
  getLootContext,
  getRulesContext,
  buildFactsBlock,
  deterministicAnswer,
};
