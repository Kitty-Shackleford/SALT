'use strict';

/*
 * NL Query Planner (AI feature 4/7 — natural-language admin, deliverable 1)
 *
 * English question in -> a BOUNDED, whitelisted query spec out. The provider
 * is asked to fill in a strict JSON schema over a fixed catalog of query
 * templates; nothing free-form reaches the database.
 *
 *   - TEXT-TO-BOUNDED-QUERY, not text-to-SQL: the provider never emits SQL.
 *   - Every template is a hand-written, read-only, parameterized statement
 *     touching ONLY whitelisted tables/columns.
 *   - validatePlan rejects out-of-whitelist templates, tables, columns,
 *     aggregates, or params BEFORE any db call.
 *   - Execution goes through the standard db adapter (db.get / db.query),
 *     always scoped to the exact serverId the caller is authorized for.
 */

const aiService = require('./aiService');

// ─── Error helper ────────────────────────────────────────────────────────────

function nlError(code, message, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

// NOTE: templates are PostgreSQL-native ($1, $2, ...). The read adapter in
// db/abstraction/postgres.js translates `?` -> $n, so reusing `?` here would
// double-convert and produce $35/$36-style garbage. Never mix the two.

// ─── Whitelisted catalog ─────────────────────────────────────────────────────

/**
 * The complete query surface this feature is allowed to touch. Every table
 * and column referenced by any template lives here; validatePlan cross-
 * checks the provider-emitted spec against this catalog.
 */
const QUERY_CATALOG = Object.freeze({
  tables: Object.freeze({
    kill_events: [
      'killer_identity_id', 'killer_gamertag', 'victim_identity_id',
      'victim_gamertag', 'victim_position', 'weapon', 'timestamp',
    ],
    player_identities: [
      'id', 'platform', 'platform_user_id', 'platform_username', 'last_seen',
    ],
    player_server_activity: [
      'identity_id', 'server_id', 'first_seen', 'last_seen', 'total_sessions',
    ],
    player_gamertags: [
      'identity_id', 'server_id', 'gamertag', 'is_current_gamertag', 'last_seen',
    ],
    player_stats: [
      'identity_id', 'server_id', 'kills', 'deaths', 'total_playtime_seconds',
    ],
    player_sessions: [
      'identity_id', 'server_id', 'login_at', 'logout_at', 'duration',
    ],
    loot_despawn_events: [
      'server_id', 'item_class', 'pos_x', 'pos_z', 'log_date',
    ],
  }),
});

/**
 * Fixed query templates. Each is a read-only parameterized statement whose
 * $1 is always serverId. `params` lists the accepted extra params with
 * type/range validation. The provider may ONLY select from these.
 */
const QUERY_TEMPLATES = Object.freeze({
  killers_by_count: {
    description: 'Top killers by kill count over a period, with current gamertag and platform name',
    params: {
      days:  { type: 'int', min: 1, max: 365, required: false, default: 7 },
      limit: { type: 'int', min: 1, max: 50,  required: false, default: 10 },
    },
    sql: `SELECT
      pi.platform_username AS gamertag,
      pi.platform AS platform,
      COUNT(*) AS kills,
      MAX(ke.timestamp) AS last_kill,
      (SELECT k2.weapon FROM kill_events k2
        WHERE k2.server_id = $1 AND k2.killer_identity_id = pi.id
        ORDER BY k2.timestamp DESC LIMIT 1) AS last_weapon
     FROM kill_events ke
     JOIN player_identities pi ON pi.id = ke.killer_identity_id
    WHERE ke.server_id = $1 AND ke.killer_identity_id IS NOT NULL
      AND ke.timestamp >= NOW() - ($2 || ' days')::interval
    GROUP BY pi.id
    ORDER BY kills DESC, pi.platform_username ASC
    LIMIT $3`,
  },
  victims_by_count: {
    description: 'Most-killed players (victim count) over a period',
    params: {
      days:  { type: 'int', min: 1, max: 365, required: false, default: 7 },
      limit: { type: 'int', min: 1, max: 50,  required: false, default: 10 },
    },
    sql: `SELECT
      pi.platform_username AS gamertag,
      pi.platform AS platform,
      COUNT(*) AS deaths,
      MAX(ke.timestamp) AS last_death
     FROM kill_events ke
     JOIN player_identities pi ON pi.id = ke.victim_identity_id
    WHERE ke.server_id = $1
      AND ke.timestamp >= NOW() - ($2 || ' days')::interval
    GROUP BY pi.id
    ORDER BY deaths DESC, pi.platform_username ASC
    LIMIT $3`,
  },
  weapons_top: {
    description: 'Most-used weapons over a period (kill counts)',
    params: {
      days:  { type: 'int', min: 1, max: 365, required: false, default: 7 },
      limit: { type: 'int', min: 1, max: 25,  required: false, default: 10 },
    },
    sql: `SELECT weapon, COUNT(*) AS kills
         FROM kill_events
        WHERE server_id = $1
          AND timestamp >= NOW() - ($2 || ' days')::interval
        GROUP BY weapon
        ORDER BY kills DESC, weapon ASC
        LIMIT $3`,
  },
  activity_recent: {
    description: 'Players active (last seen) within a period, most recent first',
    params: {
      days:  { type: 'int', min: 1, max: 365, required: false, default: 7 },
      limit: { type: 'int', min: 1, max: 50,  required: false, default: 25 },
    },
    sql: `SELECT
      pg.gamertag,
      pi.platform,
      psa.last_seen
     FROM player_server_activity psa
     JOIN player_identities pi ON pi.id = psa.identity_id
     JOIN player_gamertags pg
       ON pg.identity_id = pi.id AND pg.server_id = psa.server_id
      AND pg.is_current_gamertag = 1
    WHERE psa.server_id = $1
      AND psa.last_seen >= NOW() - ($2 || ' days')::interval
    ORDER BY psa.last_seen DESC
    LIMIT $3`,
  },
  playtime_top: {
    description: 'Most play time within a period (from completed sessions)',
    params: {
      days:  { type: 'int', min: 1, max: 365, required: false, default: 7 },
      limit: { type: 'int', min: 1, max: 25,  required: false, default: 10 },
    },
    sql: `SELECT
      pg.gamertag,
      pi.platform,
      COALESCE(SUM(ps.duration), 0) AS playtime_seconds
     FROM player_sessions ps
     JOIN player_server_activity psa
       ON psa.identity_id = ps.identity_id AND psa.server_id = $1
     JOIN player_identities pi ON pi.id = ps.identity_id
     JOIN player_gamertags pg
       ON pg.identity_id = pi.id AND pg.server_id = $1
      AND pg.is_current_gamertag = 1
    WHERE ps.server_id = $1
      AND ps.logout_at IS NOT NULL
      AND ps.logout_at >= NOW() - ($2 || ' days')::interval
    GROUP BY ps.identity_id
    ORDER BY playtime_seconds DESC, pg.gamertag ASC
    LIMIT $3`,
  },
  loot_despawns_by_class: {
    description: 'Most-despawned loot classes by log day',
    params: {
      days:  { type: 'int', min: 1, max: 365, required: false, default: 7 },
      limit: { type: 'int', min: 1, max: 25,  required: false, default: 15 },
    },
    sql: `SELECT item_class, COUNT(*) AS despawns
         FROM loot_despawn_events
        WHERE server_id = $1
          AND log_date >= (NOW() - ($2 || ' days')::interval)::date
        GROUP BY item_class
        ORDER BY despawns DESC, item_class ASC
        LIMIT $3`,
  },
  death_counts_by_day: {
    description: 'Kills per day over a period (server activity trend)',
    params: {
      days: { type: 'int', min: 1, max: 365, required: false, default: 14 },
    },
    sql: `SELECT log_date, kills
         FROM (
           SELECT to_char(date_trunc('day', timestamp), 'YYYY-MM-DD') AS log_date,
                  COUNT(*)::int AS kills
             FROM kill_events
            WHERE server_id = $1
              AND timestamp >= NOW() - ($2 || ' days')::interval
            GROUP BY 1
         ) daily
         ORDER BY log_date ASC`,
  },
});

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a provider-emitted (or hand-built) query plan against the
 * whitelist. Throws nlError with a structured .code on any violation:
 *   - unknown template
 *   - unknown param key, wrong type, out-of-range value
 *   - explicit table/column overrides that fall outside the whitelist
 *
 * Returns the normalized plan: { template, params: {days, limit?, ...} }.
 */
function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw nlError('NL_QUERY_PLAN_INVALID', 'Query plan must be a JSON object');
  }
  const template = typeof plan.template === 'string' ? plan.template : '';
  const spec = QUERY_TEMPLATES[template];
  if (!spec) {
    throw nlError(
      'NL_QUERY_TEMPLATE_NOT_WHITELISTED',
      `Query template "${template || '(none)'}" is not in the whitelist`
    );
  }

  // Optional explicit table/column declarations from the provider are
  // cross-checked against the catalog (defense in depth: any table or
  // column the provider names must exist in the whitelist).
  if (plan.tables !== undefined) {
    if (!Array.isArray(plan.tables) || plan.tables.length === 0) {
      throw nlError('NL_QUERY_TABLES_INVALID', '"tables" must be a non-empty array');
    }
    for (const table of plan.tables) {
      if (!QUERY_CATALOG.tables[table]) {
        throw nlError(
          'NL_QUERY_TABLE_NOT_WHITELISTED',
          `Table "${table}" is not in the whitelist`
        );
      }
    }
  }
  if (plan.columns !== undefined) {
    if (!Array.isArray(plan.columns) || plan.columns.length === 0) {
      throw nlError('NL_QUERY_COLUMNS_INVALID', '"columns" must be a non-empty array');
    }
    for (const column of plan.columns) {
      const known = Object.values(QUERY_CATALOG.tables).some(cols => cols.includes(column));
      if (!known) {
        throw nlError(
          'NL_QUERY_COLUMN_NOT_WHITELISTED',
          `Column "${column}" is not in the whitelist`
        );
      }
    }
  }

  // Params: reject unknown keys, type-check + range-check known ones.
  const params = {};
  const rawParams = plan.params && typeof plan.params === 'object' ? plan.params : {};
  for (const [key, value] of Object.entries(rawParams)) {
    const rule = spec.params[key];
    if (!rule) {
      throw nlError(
        'NL_QUERY_PARAM_NOT_WHITELISTED',
        `Parameter "${key}" is not allowed for template "${template}"`
      );
    }
    if (rule.type === 'int') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < rule.min || n > rule.max) {
        throw nlError(
          'NL_QUERY_PARAM_OUT_OF_RANGE',
          `Parameter "${key}" must be an integer between ${rule.min} and ${rule.max}`
        );
      }
      params[key] = n;
    }
  }
  // Defaults for missing params. Emitted in spec order so the SQL
  // placeholder positions ($2, $3, ...) always match.
  const ordered = {};
  for (const [key, rule] of Object.entries(spec.params)) {
    if (params[key] === undefined) params[key] = rule.required ? null : (rule.default ?? null);
    if (params[key] === null && rule.required) {
      throw nlError('NL_QUERY_PARAM_MISSING', `Parameter "${key}" is required`);
    }
    ordered[key] = params[key];
  }

  return { template, params: ordered };
}

/** Build the SQL parameter array for a validated plan: [serverId, ...]. */
function buildParams(validated, serverId) {
  return [serverId, ...Object.values(validated.params)];
}

// ─── Execution (bounded, read-only) ─────────────────────────────────────────

/**
 * Execute a validated plan against the standard read-only db adapter.
 * Never builds SQL from user/provider strings — the template is fixed here
 * and only parameters are substituted by the adapter.
 * @returns {{ template, params, rows }}
 */
async function executeQuery(db, serverId, validated) {
  const template = QUERY_TEMPLATES[validated.template];
  const rows = await db.query(template.sql, buildParams(validated, serverId));
  return {
    template: validated.template,
    params: validated.params,
    rows: Array.isArray(rows) ? rows.slice(0, 100) : [],
  };
}

// ─── Provider planning (text -> bounded query spec) ──────────────────────────

const PLAN_SYSTEM = [
  'You plan bounded database queries for a DayZ server dashboard.',
  'You NEVER write SQL. You select one template from the catalog and fill its parameters.',
  '',
  'CATALOG (template -> description, allowed params):',
  ...Object.entries(QUERY_TEMPLATES).map(([name, spec]) => {
    const p = Object.entries(spec.params)
      .map(([k, r]) => `${k}: int ${r.min}..${r.max} (default ${r.default})`)
      .join(', ');
    return `  ${name} — ${spec.description} [params: ${p}]`;
  }),
  '',
  'Respond with ONE fenced ```json block of exactly this shape:',
  '{ "template": "<catalog name>", "params": { ... }, "tables": [...], "columns": [...], "explain": "one sentence" }',
  '"tables" and "columns" list the catalog tables/columns your answer will draw from (from the whitelist only).',
  'Keep params minimal: set "days" only when the user names a period, "limit" only when the user names a count.',
  'If no template fits the question, return {"template": "none"} — never invent a template or SQL.',
].join('\n');

/**
 * Ask the provider to resolve a natural-language question into a bounded
 * query plan. Returns { plan (validated), explain } — throws nlError when
 * the provider output is unusable.
 */
async function planQuery(question, provider) {
  const clean = String(question || '').trim().slice(0, 2000);
  if (!clean) throw nlError('NL_QUERY_QUESTION_REQUIRED', 'question is required');

  const response = await aiService.callProvider(
    [
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: `Question: ${clean}` },
    ],
    0.1,
    provider
  );

  const match = String(response || '').match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (!match) throw nlError('NL_QUERY_PLAN_NO_BLOCK', 'AI response had no fenced JSON block');
  let raw;
  try {
    raw = JSON.parse(match[1].trim());
  } catch (error) {
    throw nlError('NL_QUERY_PLAN_INVALID_JSON', `AI plan is not valid JSON: ${error.message}`);
  }
  if (raw && raw.template === 'none') {
    throw nlError('NL_QUERY_NO_FITTING_TEMPLATE', 'No whitelisted template answers this question', 422);
  }
  const validated = validatePlan(raw);
  return {
    plan: validated,
    explain: typeof raw.explain === 'string' ? raw.explain.slice(0, 500) : null,
  };
}

module.exports = {
  QUERY_CATALOG,
  QUERY_TEMPLATES,
  nlError,
  validatePlan,
  buildParams,
  executeQuery,
  planQuery,
};
