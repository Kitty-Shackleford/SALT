'use strict';

/**
 * aiSharedRouterService.js
 *
 * Shared (free) LLM router fallback for dashboard AI features.
 *
 * The router (e.g. a self-hosted FreeLLMAPI) is an OpenAI-compatible
 * endpoint configured operator-side via env. It is a cost-reduction
 * fallback: it only kicks in when the user has no AI provider of their own
 * connected, so per-user keys and Copilot keep full priority.
 *
 * Security model
 *   - The router URL/key are server-side env only — never user-supplied —
 *     so no user can redirect AI traffic to their own endpoint.
 *   - Because the operator configures it (not the user), the public-address
 *     SSRF guard is NOT applied to it (enforcePublicAddress: false), matching
 *     the operator-key tier.
 *   - The router sees only the per-server context block the dashboard builds
 *     (kills/loot/players for the one server the actor administers) plus the
 *     chat messages. It has no DB/Nitrado/route access, so it cannot break
 *     guild isolation — authorization happens upstream of the provider call.
 *
 * Quota
 *   Shared free tiers are a shared pool, so each user is rate-limited to a
 *   daily call budget (AI_SHARED_DAILY_LIMIT, default 50). The counter is in
 *   the ai_shared_usage table (migration 101) and is incremented atomically
 *   per call. Users who connect their own provider bypass the counter.
 */

const DEFAULT_SHARED_DAILY_LIMIT = 50;

function isEnabled(env = process.env) {
  return Boolean(env.AI_SHARED_ROUTER_BASE_URL && env.AI_SHARED_ROUTER_API_KEY);
}

/**
 * Build the shared-router provider descriptor. Only valid when isEnabled.
 * Model defaults to 'auto' (let the router pick); overridable via env.
 */
function provider(env = process.env) {
  return {
    type: 'openai-compatible',
    source: 'shared-router',
    apiKey: env.AI_SHARED_ROUTER_API_KEY,
    baseURL: env.AI_SHARED_ROUTER_BASE_URL,
    model: String(env.AI_SHARED_ROUTER_MODEL || 'auto').trim() || 'auto',
    enforcePublicAddress: false,
    // Operator-configured host on the trusted docker network (HTTP, not
    // HTTPS) — exempt from the client's TLS requirement, same tier as the
    // loopback allowance. Never user-supplied, so no SSRF surface.
    allowInsecure: true,
  };
}

function dailyLimit(env = process.env) {
  const n = parseInt(env.AI_SHARED_DAILY_LIMIT, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SHARED_DAILY_LIMIT;
}

function todayKey() {
  // Local date key (UTC) so the bucket rolls at midnight consistently.
  return new Date().toISOString().slice(0, 10);
}

/**
 * Atomically consume one shared-router call for a user.
 *
 * Uses INSERT ... ON CONFLICT ... RETURNING to both create and increment in
 * a single race-safe statement. If the resulting count exceeds the limit, the
 * increment is rolled back and a 429-coded error is thrown.
 *
 * @param {object} db      - db abstraction (query)
 * @param {number} userId  - internal users.id
 * @param {object} [env]   - env override (tests)
 * @returns {Promise<{count:number, limit:number, remaining:number}>}
 */
async function consumeCall(db, userId, env = process.env) {
  const limit = dailyLimit(env);
  const day = todayKey();

  const inserted = await db.query(
    `INSERT INTO ai_shared_usage (user_id, day, calls)
     VALUES ($1, $2::date, 1)
     ON CONFLICT (user_id, day)
       DO UPDATE SET calls = ai_shared_usage.calls + 1
     RETURNING calls`,
    [userId, day]
  );
  const count = Number(inserted[0]?.calls ?? 0);

  if (count > limit) {
    // Undo the over-limit increment so the user's budget is not burned.
    await db.query(
      `UPDATE ai_shared_usage SET calls = calls - 1
       WHERE user_id = $1 AND day = $2::date`,
      [userId, day]
    );
    const error = new Error(
      `Daily shared-AI limit reached (${limit}/day). ` +
      'Connect your own AI provider to continue, or try again tomorrow.'
    );
    error.code = 'AI_SHARED_RATE_LIMITED';
    error.status = 429;
    error.category = 'rate_limited'; // routes/ai.js maps this to HTTP 429
    throw error;
  }
  return { count, limit, remaining: limit - count };
}

/**
 * Read the user's remaining shared-router budget today (no increment).
 * Returns null when the shared router is not enabled.
 */
async function remaining(db, userId, env = process.env) {
  if (!isEnabled(env)) return null;
  const limit = dailyLimit(env);
  const row = await db.get(
    'SELECT calls FROM ai_shared_usage WHERE user_id = $1 AND day = $2::date',
    [userId, todayKey()]
  );
  const used = Number(row?.calls ?? 0);
  return { limit, used, remaining: Math.max(0, limit - used) };
}

module.exports = {
  isEnabled,
  provider,
  dailyLimit,
  todayKey,
  consumeCall,
  remaining,
  DEFAULT_SHARED_DAILY_LIMIT,
};
