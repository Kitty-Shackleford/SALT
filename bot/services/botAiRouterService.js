/*
 * bot/services/botAiRouterService.js
 *
 * Bot-side access to the shared LLM router (FreeLLMAPI) for the
 * player-facing AI features (ask-the-server, digests, onboarding).
 *
 * Config
 *   BOT_AI_ROUTER_BASE_URL / BOT_AI_ROUTER_API_KEY / BOT_AI_ROUTER_MODEL
 *   fall back to AI_SHARED_ROUTER_* (the dashboard's shared-router env),
 *   because the bot container shares the backend .env on the docker
 *   network. The router URL/key are server-side env only — never
 *   user-supplied — so no SSRF surface (same trust tier as the
 *   dashboard's shared router: allowInsecure HTTP on the trusted
 *   docker network).
 *
 * Quota
 *   Plain Discord members have no users.id row, so the daily budget is
 *   tracked in bot_ai_user_usage keyed by (discord_user_id, guild_id,
 *   day). The limit is per-guild (guild_ai_settings.ask_daily_limit,
 *   default 20) with a hard ceiling enforced here.
 */

'use strict';

const axios = require('axios');
const pool = require('../db');

const DEFAULT_DAILY_LIMIT = 20;
const HARD_DAILY_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 45 * 1000;

function routerConfig(env = process.env) {
  const baseURL = env.BOT_AI_ROUTER_BASE_URL || env.AI_SHARED_ROUTER_BASE_URL;
  const apiKey = env.BOT_AI_ROUTER_API_KEY || env.AI_SHARED_ROUTER_API_KEY;
  const model = String(
    env.BOT_AI_ROUTER_MODEL || env.AI_SHARED_ROUTER_MODEL || 'auto'
  ).trim() || 'auto';
  if (!baseURL || !apiKey) return null;
  return {
    baseURL: String(baseURL).replace(/\/+$/, ''),
    apiKey,
    model,
  };
}

function isConfigured(env = process.env) {
  return Boolean(routerConfig(env));
}

function clampLimit(limit) {
  const n = parseInt(limit, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DAILY_LIMIT;
  return Math.min(n, HARD_DAILY_LIMIT);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Atomically consume one ask-the-server call for a Discord user in a guild.
 * Rolls back the increment when the daily limit is exceeded (mirrors
 * services/aiSharedRouterService.consumeCall).
 *
 * @param {object} db        - db abstraction (query)
 * @param {string} guildDbId - guilds.id
 * @param {string} discordUserId
 * @param {number} [limit]
 * @returns {Promise<{count:number, limit:number, remaining:number}>}
 */
async function consumeUserCall(db, guildDbId, discordUserId, limit, database = db) {
  const effectiveLimit = clampLimit(limit);
  const day = todayKey();

  const inserted = await database.query(
    `INSERT INTO bot_ai_user_usage (discord_user_id, guild_id, day, calls)
     VALUES ($1, $2, $3::date, 1)
     ON CONFLICT (discord_user_id, guild_id, day)
       DO UPDATE SET calls = bot_ai_user_usage.calls + 1
     RETURNING calls`,
    [String(discordUserId), guildDbId, day]
  );
  const count = Number((inserted.rows || inserted)[0]?.calls ?? 0);

  if (count > effectiveLimit) {
    await database.query(
      `UPDATE bot_ai_user_usage SET calls = calls - 1
       WHERE discord_user_id = $1 AND guild_id = $2 AND day = $3::date`,
      [String(discordUserId), guildDbId, day]
    );
    const error = new Error(
      `Daily limit reached (${effectiveLimit}/day) for ask-the-server. Try again tomorrow.`
    );
    error.code = 'BOT_AI_RATE_LIMITED';
    throw error;
  }
  return { count, limit: effectiveLimit, remaining: effectiveLimit - count };
}

/**
 * One OpenAI-compatible chat completion against the router.
 * Returns the assistant's content string, or null when the router is
 * unconfigured or the call fails (callers must have a deterministic
 * fallback — grounded features never fail because the LLM is down).
 */
async function chat(messages, env = process.env, options = {}) {
  const config = routerConfig(env);
  if (!config) return null;
  try {
    const res = await axios.post(
      `${config.baseURL}/chat/completions`,
      {
        model: config.model,
        messages,
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? 700,
      },
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
        // Operator-configured host on the trusted docker network (HTTP),
        // same allowInsecure tier as services/aiSharedRouterService.
        https: false,
      }
    );
    const content = res?.data?.choices?.[0]?.message?.content;
    return typeof content === 'string' && content.trim() ? content.trim() : null;
  } catch (error) {
    console.warn(`⚠️ [bot-ai-router] chat failed: ${error.message}`);
    return null;
  }
}

module.exports = {
  routerConfig,
  isConfigured,
  clampLimit,
  todayKey,
  consumeUserCall,
  chat,
  DEFAULT_DAILY_LIMIT,
  HARD_DAILY_LIMIT,
  _pool: pool,
};
