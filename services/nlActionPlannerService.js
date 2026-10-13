'use strict';

/*
 * NL Action Planner (AI feature 4/7 — natural-language admin, deliverable 2)
 *
 * English request in -> an explicit, human-confirmable ACTION PLAN out.
 *
 *   - TEXT-TO-BOUNDED-ACTION, not free-form execution: the provider only
 *     picks an action + resolver from a fixed catalog and fills typed
 *     params. It never emits API calls or SQL.
 *   - Targets are resolved DETERMINISTICALLY against whitelisted tables
 *     (read-only, server-scoped) so the plan shows exactly who/what will
 *     be affected, with the evidence (query rows) attached.
 *   - Execution is NEVER part of planning. A plan is stored (migration 104)
 *     as `pending`; the confirm route re-checks ownership + plan freshness
 *     and then drives the EXISTING ownerDashboard route handlers
 *     (list add/remove, player wipe) with the real caller's auth context.
 *     There are no new mutation paths in this feature.
 *   - Destructive actions are flagged per action; the confirm route
 *     requires every planned action id to be explicitly listed.
 */

const aiService = require('./aiService');

// ─── Error helper ────────────────────────────────────────────────────────────

function nlActionError(code, message, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

// ─── Action catalog ──────────────────────────────────────────────────────────

/**
 * Every action the NL layer may plan, mapped to an EXISTING ownerDashboard
 * endpoint (path template + body builder). `destructive` marks actions that
 * can lock a player out or destroy tracked data.
 */
const ACTION_CATALOG = Object.freeze({
  ban_player: {
    description: 'Add a player to the server ban list (ban.txt)',
    destructive: true,
    path: (ctx) => `/api/owner/servers/${ctx.serverId}/list/blacklist/add`,
    method: 'POST',
    body: (target) => ({ gamertag: target.gamertag }),
    listType: 'blacklist',
  },
  unban_player: {
    description: 'Remove a player from the server ban list (ban.txt)',
    destructive: false,
    path: (ctx) => `/api/owner/servers/${ctx.serverId}/list/blacklist/remove`,
    method: 'POST',
    body: (target) => ({ gamertag: target.gamertag }),
    listType: 'blacklist',
  },
  whitelist_player: {
    description: 'Add a player to the server whitelist (whitelist.txt)',
    destructive: false,
    path: (ctx) => `/api/owner/servers/${ctx.serverId}/list/whitelist/add`,
    method: 'POST',
    body: (target) => ({ gamertag: target.gamertag }),
    listType: 'whitelist',
  },
  remove_whitelist_player: {
    description: 'Remove a player from the server whitelist (may lock them out on a whitelist-only server)',
    destructive: true,
    path: (ctx) => `/api/owner/servers/${ctx.serverId}/list/whitelist/remove`,
    method: 'POST',
    body: (target) => ({ gamertag: target.gamertag }),
    listType: 'whitelist',
  },
  wipe_player: {
    description: 'Wipe all tracked dashboard data for one player on this server (owner-only, irreversible)',
    destructive: true,
    path: (ctx, target) => `/api/owner/servers/${ctx.serverId}/players/${target.identityId}/wipe`,
    method: 'POST',
    body: () => ({}),
    listType: null,
  },
});

const MAX_TARGETS_PER_ACTION = 25;

// ─── Deterministic target resolvers ─────────────────────────────────────────

/**
 * Resolver catalog. Each resolver takes (db, serverId, params) and returns
 * { targets: [{gamertag, identityId?, platformUserId?}], evidence: [...] }.
 * All resolvers are read-only, server-scoped, and bounded.
 */
const RESOLVERS = {
  explicit_gamertag: {
    description: 'A single named player (exact or case-insensitive gamertag match)',
    params: { gamertag: { type: 'string', required: true, maxLen: 80 } },
    async resolve(db, serverId, p) {
      const rows = await db.query(
        `SELECT pi.id AS identity_id, pi.platform_user_id, pi.platform,
                pg.gamertag,
                (pg.gamertag = ?) AS exact_match
         FROM player_gamertags pg
         JOIN player_identities pi ON pi.id = pg.identity_id
        WHERE pg.server_id = ?
          AND pg.is_current_gamertag = 1
          AND (pg.gamertag = ? OR lower(pg.gamertag) = lower(?))
        ORDER BY exact_match DESC, pg.last_seen DESC
        LIMIT 5`,
        [p.gamertag, serverId, p.gamertag, p.gamertag]
      );
      if (!rows.length) {
        throw nlActionError('NL_ACTION_TARGET_NOT_FOUND', `No current gamertag matches "${p.gamertag}" on this server`);
      }
      return {
        targets: rows.map(r => ({ gamertag: r.gamertag, identityId: r.identity_id, platformUserId: r.platform_user_id || null })),
        evidence: rows.slice(0, 5).map(r => `${r.gamertag} (identity ${r.identity_id}, exact=${r.exact_match})`),
      };
    },
  },
  near_last_kill: {
    description: 'Players whose last seen position (or kill) was within a radius of the most recent kill on the server ("near the last grief")',
    params: {
      within_m:  { type: 'int', min: 10, max: 500, required: false, default: 100 },
      window_minutes: { type: 'int', min: 5, max: 24 * 60, required: false, default: 60 },
    },
    async resolve(db, serverId, p) {
      // victim_position is a stored "x, y, z" string; the repo parses it with
      // SPLIT_PART (see scripts/map-coordinate-regression-test.js), with 1=East
      // (pos_x) and 2=North (pos_z) in the 2D distance math.
      const anchor = await db.get(
        `SELECT victim_position, killer_gamertag, weapon, timestamp
         FROM kill_events
        WHERE server_id = ?
          AND victim_position IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT 1`,
        [serverId]
      );
      if (!anchor) {
        throw nlActionError('NL_ACTION_NO_ANCHOR', 'No recent positioned kill exists on this server to anchor "near the last grief"');
      }
      const positionParts = String(anchor.victim_position || '').split(',');
      const ax = parseFloat(positionParts[0]);
      const az = parseFloat(positionParts[1]);
      if (!Number.isFinite(ax) || !Number.isFinite(az)) {
        throw nlActionError('NL_ACTION_NO_ANCHOR', 'Most recent kill has no usable position');
      }
      const rows = await db.query(
        `SELECT
           identity_id,
           player_gamertag,
           MIN(SQRT(POWER(pos_x - ?, 2) + POWER(pos_z - ?, 2)))::int AS min_dist_m
         FROM player_position_snapshots
        WHERE server_id = ?
          AND identity_id IS NOT NULL
          AND timestamp >= NOW() - (? || ' minutes')::interval
          AND SQRT(POWER(pos_x - ?, 2) + POWER(pos_z - ?, 2)) <= ?
        GROUP BY identity_id, player_gamertag
        ORDER BY min_dist_m ASC, player_gamertag ASC
        LIMIT ?`,
        [ax, az, serverId, p.window_minutes, ax, az, p.within_m, MAX_TARGETS_PER_ACTION]
      );
      return {
        targets: rows.map(r => ({ gamertag: r.player_gamertag, identityId: r.identity_id })),
        // Per-target evidence, aligned 1:1 with targets (buildActionPlan
        // indexes evidence by target position).
        evidence: rows.map(r =>
          `Anchor: latest kill at (${ax.toFixed(0)}, ${az.toFixed(0)}) — ${anchor.killer_gamertag || 'unknown'} killed with ${anchor.weapon || '?'} at ${new Date(anchor.timestamp).toISOString()}; target ${r.player_gamertag} last seen ~${r.min_dist_m}m from anchor`
        ),
      };
    },
  },
  top_killer: {
    description: 'The single top killer over a period',
    params: {
      days: { type: 'int', min: 1, max: 365, required: false, default: 7 },
    },
    async resolve(db, serverId, p) {
      const row = await db.get(
        `SELECT pi.id AS identity_id, pi.platform_username AS gamertag, COUNT(*) AS kills
         FROM kill_events ke
         JOIN player_identities pi ON pi.id = ke.killer_identity_id
        WHERE ke.server_id = ? AND ke.killer_identity_id IS NOT NULL
          AND ke.timestamp >= NOW() - (? || ' days')::interval
        GROUP BY pi.id
        ORDER BY kills DESC, pi.platform_username ASC
        LIMIT 1`,
        [serverId, p.days]
      );
      if (!row) throw nlActionError('NL_ACTION_TARGET_NOT_FOUND', `No killers recorded in the last ${p.days} day(s)`);
      return {
        targets: [{ gamertag: row.gamertag, identityId: row.identity_id }],
        evidence: [`${row.gamertag}: ${row.kills} kills in the last ${p.days} day(s)`],
      };
    },
  },
  open_reports: {
    description: 'Players currently subject to open abuse reports on this server',
    params: {},
    async resolve(db, serverId) {
      const rows = await db.query(
        `SELECT reported_gamertag, COUNT(*)::int AS reports, MAX(created_at) AS latest
         FROM player_reports
        WHERE server_id = ? AND status = 'open'
        GROUP BY reported_gamertag
        ORDER BY reports DESC, latest DESC
        LIMIT ?`,
        [serverId, MAX_TARGETS_PER_ACTION]
      );
      if (!rows.length) {
        throw nlActionError('NL_ACTION_NO_TARGETS', 'No open player reports on this server', 422);
      }
      return {
        targets: rows.map(r => ({ gamertag: r.reported_gamertag })),
        // Per-target evidence, aligned 1:1 with targets (buildActionPlan
        // indexes evidence by target position).
        evidence: rows.map(r => `${r.reported_gamertag} (${r.reports} open report(s), latest ${new Date(r.latest).toISOString()})`),
      };
    },
  },
};

// Actions allowed per resolver (a resolver may only feed some actions).
const ALLOWED_ACTIONS = {
  explicit_gamertag: ['ban_player', 'unban_player', 'whitelist_player', 'remove_whitelist_player', 'wipe_player'],
  near_last_kill: ['ban_player', 'unban_player', 'remove_whitelist_player'],
  top_killer: ['ban_player', 'wipe_player', 'unban_player'],
  open_reports: ['ban_player', 'wipe_player'],
};

// ─── Validation ──────────────────────────────────────────────────────────────

/** Type-check + range-check resolver params. Throws nlActionError on violation. */
function validateResolverParams(resolverName, params) {
  const resolver = RESOLVERS[resolverName];
  if (!resolver) {
    throw nlActionError('NL_ACTION_RESOLVER_NOT_WHITELISTED', `Resolver "${resolverName || '(none)'}" is not in the whitelist`);
  }
  const out = {};
  const raw = params && typeof params === 'object' ? params : {};
  for (const [key, value] of Object.entries(raw)) {
    const rule = resolver.params[key];
    if (!rule) throw nlActionError('NL_ACTION_PARAM_NOT_WHITELISTED', `Parameter "${key}" is not allowed for resolver "${resolverName}"`);
    if (rule.type === 'int') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < rule.min || n > rule.max) {
        throw nlActionError('NL_ACTION_PARAM_OUT_OF_RANGE', `Parameter "${key}" must be an integer between ${rule.min} and ${rule.max}`);
      }
      out[key] = n;
    } else if (rule.type === 'string') {
      if (typeof value !== 'string' || !value.trim() || value.length > rule.maxLen) {
        throw nlActionError('NL_ACTION_PARAM_INVALID', `Parameter "${key}" must be a non-empty string of at most ${rule.maxLen} chars`);
      }
      out[key] = value.trim();
    }
  }
  for (const [key, rule] of Object.entries(resolver.params)) {
    if (rule.required && out[key] === undefined) {
      throw nlActionError('NL_ACTION_PARAM_MISSING', `Parameter "${key}" is required for resolver "${resolverName}"`);
    }
  }
  return out;
}

/**
 * Validate the full plan request: action must exist, resolver must exist and
 * be permitted to feed that action. Returns { action, resolver, params }.
 */
function validateRequest({ action, resolver, params }) {
  const actionSpec = ACTION_CATALOG[action];
  if (!actionSpec) {
    throw nlActionError('NL_ACTION_NOT_WHITELISTED', `Action "${action || '(none)'}" is not in the whitelist`);
  }
  const allowed = ALLOWED_ACTIONS[resolver] || [];
  if (!allowed.includes(action)) {
    throw nlActionError('NL_ACTION_RESOLVER_MISMATCH', `Resolver "${resolver}" cannot target action "${action}"`);
  }
  return { action, resolver, params: validateResolverParams(resolver, params) };
}

// ─── Provider planning (text -> bounded action spec) ─────────────────────────

const PLAN_SYSTEM = [
  'You plan server-admin actions for a DayZ dashboard. You NEVER execute anything and NEVER write API calls or SQL.',
  'You pick exactly one ACTION and one RESOLVER from the catalogs and fill their parameters.',
  '',
  'ACTIONS:',
  ...Object.entries(ACTION_CATALOG).map(([name, spec]) => `  ${name} — ${spec.description}${spec.destructive ? ' [DESTRUCTIVE]' : ''}`),
  '',
  'RESOLVERS (how targets are resolved; each lists its allowed actions):',
  ...Object.entries(RESOLVERS).map(([name, spec]) => {
    const p = Object.entries(spec.params)
      .map(([k, r]) => r.type === 'int' ? `${k}: int ${r.min}..${r.max} (default ${r.default})` : `${k}: string (required)`)
      .join(', ') || '(no params)';
    return `  ${name} — ${spec.description} [params: ${p}] -> ${ALLOWED_ACTIONS[name].join(', ')}`;
  }),
  '',
  'Respond with ONE fenced ```json block of exactly this shape:',
  '{ "action": "<action name>", "resolver": "<resolver name>", "params": { ... }, "rationale": "one sentence for the owner" }',
  'Set "days"/"window_minutes" only when the user named a time span; set "within_m" only when a radius was named.',
  'If no action+resolver combination fits the request, return {"action": "none"}.',
].join('\n');

/**
 * Ask the provider to resolve an NL admin request into a bounded action spec.
 * Throws nlActionError when the provider output is unusable.
 */
async function planAction(request, provider) {
  const clean = String(request || '').trim().slice(0, 2000);
  if (!clean) throw nlActionError('NL_ACTION_REQUEST_REQUIRED', 'request is required');

  const response = await aiService.callProvider(
    [
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: `Admin request: ${clean}` },
    ],
    0.1,
    provider
  );

  const match = String(response || '').match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (!match) throw nlActionError('NL_ACTION_PLAN_NO_BLOCK', 'AI response had no fenced JSON block');
  let raw;
  try {
    raw = JSON.parse(match[1].trim());
  } catch (error) {
    throw nlActionError('NL_ACTION_PLAN_INVALID_JSON', `AI plan is not valid JSON: ${error.message}`);
  }
  if (raw && raw.action === 'none') {
    throw nlActionError('NL_ACTION_NO_FITTING_PLAN', 'No whitelisted action answers this request', 422);
  }
  const validated = validateRequest(raw);
  return {
    ...validated,
    rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 500) : null,
  };
}

// ─── Plan materialization (deterministic resolution) ─────────────────────────

/**
 * Build the full action plan: resolve targets deterministically, then emit
 * one explicit action entry per affected player with the exact existing
 * API call that will execute it. NO mutation happens here.
 * @returns {{ planId: null, actions: Array, summary, request }}
 */
async function buildActionPlan(db, serverId, { request, action, resolver, params, rationale }) {
  const spec = ACTION_CATALOG[action];
  const resolved = await RESOLVERS[resolver].resolve(db, serverId, params);
  if (!resolved.targets.length) {
    throw nlActionError('NL_ACTION_NO_TARGETS', `Resolver "${resolver}" found no players to act on`, 422);
  }
  const ctx = { serverId };
  const actions = resolved.targets.map((target, index) => ({
    index,
    action,
    destructive: spec.destructive,
    target,
    api: { method: spec.method, path: spec.path(ctx, target), body: spec.body(target) },
    evidence: resolved.evidence[index] || resolved.evidence[0] || null,
  }));
  const summary = [
    `${action} x${actions.length} (resolver: ${resolver})`,
    resolved.targets.map(t => t.gamertag).join(', '),
    rationale ? `AI rationale: ${rationale}` : '',
  ].filter(Boolean).join('\n');
  return { request, action, resolver, params, actions, summary };
}

// ─── Confirm-time execution ──────────────────────────────────────────────────

/**
 * Execute one planned action by driving the EXISTING ownerDashboard route
 * handler (loaded lazily to avoid a require cycle). The caller's real req
 * (app locals + user + authorization context) is carried into a synthetic
 * request so the route's own authorization middleware and the provider-list
 * mutation authority checks run unmodified.
 *
 * Route matching is done segment-by-segment against each route's Express
 * PATH TEMPLATE (concrete planned segments vs ':param' template segments),
 * never by literal equality — a concrete path like
 * /servers/7/list/blacklist/add only ever equals its own template, never the
 * route template /servers/:id/list/:listType/add.
 */
function findOwnerRoute(ownerDashboardRouter, method, relPath) {
  const wanted = relPath.split('/').filter(Boolean).map(String);
  for (const layer of ownerDashboardRouter.stack) {
    if (!layer.route) continue;
    const methodKey = method.toLowerCase();
    if (!layer.route.methods[methodKey]) continue;
    const template = layer.route.path.split('/').filter(Boolean).map(String);
    if (template.length !== wanted.length) continue;
    const bound = {};
    let matches = true;
    for (let i = 0; i < template.length; i += 1) {
      const segment = template[i];
      if (segment.startsWith(':')) {
        bound[segment.slice(1)] = wanted[i];
      } else if (segment !== wanted[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return { route: layer.route, params: bound };
  }
  return null;
}

/**
 * Build the synthetic request for one planned action. req.params is bound
 * from the route template, and serverId is written into every request slot
 * the ownerDashboard middleware reads (params/query/body) so
 * ensureServerAccess / getTokenForServer resolve the same exact server the
 * caller was authorized for by the NL route.
 */
function buildSyntheticActionRequest(callerReq, relPath, boundParams, actionBody) {
  // Planned paths are /servers/<serverId>/... — segment index 1 is the id.
  const platformServerId = String(relPath.split('/').filter(Boolean)[1] || '');
  const body = { ...(actionBody || {}) };
  return {
    app: callerReq.app,
    user: callerReq.user,
    authorization: callerReq.authorization || null,
    params: { ...boundParams, serverId: platformServerId },
    query: { serverId: platformServerId },
    body,
    isAuthenticated: () => true,
  };
}

async function executePlannedAction(callerReq, action) {
  const ownerDashboard = require('../routes/ownerDashboard');
  const relPath = action.api.path.replace('/api/owner', '');
  const method = String(action.api.method || 'POST').toUpperCase();
  const found = findOwnerRoute(ownerDashboard, method, relPath);
  if (!found) {
    throw nlActionError('NL_ACTION_ENDPOINT_MISSING', `No route matches ${method} ${action.api.path}`, 500);
  }

  // Run the route's FULL stack — authorization middleware (ensureServerAccess
  // / ensureServerOwner) included — so the existing RBAC is the only
  // execution path.
  const syntheticReq = buildSyntheticActionRequest(callerReq, relPath, found.params, action.api.body);

  let done = false;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; done = true; return this; },
    end() { done = true; return this; },
    redirect() { done = true; return this; },
  };
  for (const layer of found.route.stack) {
    if (done) break;
    if (layer.route) continue; // skip nested-route placeholders
    // eslint-disable-next-line no-await-in-loop
    await layer.handle(syntheticReq, res, () => {});
  }
  if (!done) throw nlActionError('NL_ACTION_ENDPOINT_NO_RESPONSE', `Route ${action.api.path} ended without a response`, 500);
  if (res.statusCode >= 400) {
    const error = nlActionError(
      'NL_ACTION_EXECUTION_REJECTED',
      `Action rejected by existing authorization path: ${res.body?.error || res.statusCode}`,
      res.statusCode >= 400 && res.statusCode < 500 ? res.statusCode : 500
    );
    error.detail = res.body;
    throw error;
  }
  return res.body;
}

module.exports = {
  ACTION_CATALOG,
  RESOLVERS,
  ALLOWED_ACTIONS,
  MAX_TARGETS_PER_ACTION,
  nlActionError,
  validateRequest,
  validateResolverParams,
  planAction,
  buildActionPlan,
  executePlannedAction,
  findOwnerRoute,
  buildSyntheticActionRequest,
};
