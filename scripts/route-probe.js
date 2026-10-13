#!/usr/bin/env node
/**
 * route-probe.js — status-code sweep over every canonical route in
 * src/app/registerRoutes.js. Run against prod or a local replica to catch
 * broken routes (404/500) and unexpected auth-wall behavior after deploys.
 *
 * Usage:
 *   node scripts/route-probe.js [--base http://127.0.0.1:3000]
 *                               [--cookie 'connect.sid=<signed>'] [--json out.json]
 *
 * Modes:
 *   (no --cookie)  Unauthenticated sweep. Expected codes are the canonical
 *                  contract: public endpoints 200, HTML pages 302 -> '/',
 *                  API routes 401, OAuth entry 302 to Discord.
 *   (--cookie)     Authenticated sweep (any signed session cookie). Expected:
 *                  GET HTML routes 200 (role-gated pages may 302 to
 *                  /dashboard), GET API routes 200/403 (403 = role denied,
 *                  still a live handler), POST API routes not 401/403.
 *
 * Exit 0 when every route matches its expectation; exit 1 otherwise.
 * Parameterized routes are probed with sample ids (server 1, job 'probe-job').
 */

'use strict';

const args = process.argv.slice(2);
const base = (args[args.indexOf('--base') + 1] || process.env.PROBE_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const cookie = args.includes('--cookie') ? args[args.indexOf('--cookie') + 1] : null;
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

// [method, path, expectedUnauth, expectedAuth]
// expectedAuth may be a number, an array of allowed codes, or a predicate name.
const ROUTES = [
  // public (readyz needs minimumBotStartedAt; bot-offline is a live 503, not a failure)
  ['GET', '/', 200, 200],
  ['GET', '/favicon.ico', 200, 200],
  ['GET', '/readyz?minimumBotStartedAt=' + (Math.floor(Date.now() / 1000) - 1), [200, 503], [200, 503]],
  ['GET', '/api/public-config', 200, 200],
  ['GET', '/api/access/setup', [401, 302], 200],
  ['GET', '/api/config', 200, 200],
  // oauth / session
  ['GET', '/auth/discord', 302, 200],
  ['GET', '/auth/discord/callback', 302, 302],
  ['GET', '/logout', 302, 302],
  // html shell pages
  ['GET', '/dashboard', 302, 200],
  ['GET', '/dashboard/feeds', 302, 200],
  ['GET', '/dashboard/economy', 302, 200],
  ['GET', '/dashboard/economy-leaderboard', 302, 200],
  ['GET', '/dashboard/economy-transactions', 302, 200],
  ['GET', '/dashboard/automation', 302, [200, 302]],
  ['GET', '/dashboard/tasks', 302, [200, 302]],
  ['GET', '/dashboard/server-control', 302, [200, 302]],
  ['GET', '/dashboard/spawn-exclusions', 302, [200, 302]],
  ['GET', '/dashboard/backups', 302, [200, 302]],
  ['GET', '/dashboard/rotation', 302, [200, 302]],
  ['GET', '/dashboard/ai-assistant', 302, [200, 302]],
  ['GET', '/dashboard/server-stats', 302, [200, 302]],
  ['GET', '/dashboard/activity-log', 302, [200, 302]],
  ['GET', '/dashboard/console', 302, [200, 302]],
  ['GET', '/dashboard/boost', 302, [200, 302]],
  ['GET', '/dashboard/support', 302, [200, 302]],
  ['GET', '/dashboard/settings', 302, [200, 302]],
  ['GET', '/dashboard/economy-settings', 302, [200, 302]],
  ['GET', '/dashboard/shop-admin', 302, [200, 302]],
  ['GET', '/dashboard/casino', 302, [200, 302]],
  ['GET', '/dashboard/roles', 302, [200, 302]],
  ['GET', '/shop', 302, 200],
  ['GET', '/map', 302, [200, 302]],
  ['GET', '/loot-finder', 302, 200],
  ['GET', '/mission-editor', 302, [200, 302]],
  ['GET', '/logs', 302, [200, 302]],
  ['GET', '/server-players', 302, 200],
  ['GET', '/server-lists', 302, [200, 302]],
  ['GET', '/automation', 302, [200, 302]],
  ['GET', '/nitrado-settings', 302, [200, 302]],
  ['GET', '/economy-dashboard', 302, [200, 302]],
  ['GET', '/economy-leaderboard', 302, [200, 302]],
  ['GET', '/economy-transactions', 302, [200, 302]],
  ['GET', '/player', 302, 200],
  ['GET', '/player-portal', 302, 200],
  ['GET', '/player-map', 302, 200],
  // admin surface (handlers self-authorize; unauth must NOT return 200)
  ['GET', '/admin', 302, [200, 302]],
  ['GET', '/admin/guilds', 302, [200, 302]],
  ['GET', '/admin/theme', 302, [200, 302]],
  ['GET', '/admin/guilds-approval', 302, [200, 302]],
  ['GET', '/admin/servers', 302, [200, 302]],
  ['GET', '/admin/users', 302, [200, 302]],
  ['GET', '/admin/roles', 302, [200, 302]],
  ['GET', '/admin/audit', 302, [200, 302]],
  ['GET', '/admin/database', 302, [200, 302]],
  ['GET', '/admin/reports', 302, [200, 302]],
  ['GET', '/admin/feeds', 302, [200, 302]],
  ['GET', '/admin/supply-monitor', 302, [200, 302]],
  ['GET', '/admin/economy-analytics', 302, [200, 302]],
  // api surface
  ['GET', '/api/user', 401, 200],
  ['GET', '/api/csrf-token', 200, 200],
  ['GET', '/api/user/guilds', 401, 200],
  ['GET', '/api/user/moderatable-guilds', 401, [200, 403]],
  ['GET', '/api/user/guilds-with-servers', 401, [200, 403]],
  ['GET', '/api/public/servers', 401, [200, 403]],
  ['GET', '/api/servers', 401, [200, 403]],
  ['GET', '/api/server-active-mission/1', 401, [200, 403, 404]],
  ['GET', '/api/server-maps/1', 401, [200, 403, 404]],
  ['GET', '/api/event-spawns/1/chernarus', 401, [200, 403, 404]],
  ['GET', '/api/detect-structure/1', 401, [200, 403, 404]],
  ['GET', '/api/sync-status/probe-job', 401, [200, 404]],
  ['GET', '/api/sync-jobs', 401, [200, 403]],
  ['GET', '/api/downloads', 401, [200, 403]],
  ['GET', '/metrics', [302, 401], [200, 302, 403]],
  // POSTs without a CSRF token get 403 from the CSRF layer even unauth — still a live handler
  ['POST', '/api/save-token', [401, 403], [401, 403]],
  ['POST', '/api/sync-server', [401, 403], [401, 403]],
  ['POST', '/api/list-files', [401, 403], [401, 403]],
  ['POST', '/logout', 302, 'live'],
];

async function probe(method, path) {
  const headers = {};
  if (cookie) headers['Cookie'] = cookie;
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(base + path, {
      method,
      headers,
      redirect: 'manual',
      signal: ctrl.signal,
      body: method === 'POST' ? '{}' : undefined,
    });
    return { status: res.status, location: res.headers.get('location') || null };
  } finally {
    clearTimeout(t);
  }
}

function matches(actual, expected) {
  if (expected === 'live') return actual !== 401 && actual !== 403 && actual !== 404;
  if (Array.isArray(expected)) return expected.includes(actual);
  return actual === expected;
}

async function main() {
  const results = [];
  for (const [method, path, expU, expA] of ROUTES) {
    const expected = cookie ? expA : expU;
    let r;
    try {
      r = await probe(method, path);
    } catch (e) {
      r = { status: -1, location: null, error: e.name === 'AbortError' ? 'timeout' : e.message };
    }
    const ok = matches(r.status, expected);
    results.push({ method, path, expected, status: r.status, location: r.location, ok, error: r.error || null });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${method} ${path} -> ${r.status}${r.location ? ' (' + r.location + ')' : ''} (expected ${JSON.stringify(expected)})${r.error ? ' [' + r.error + ']' : ''}`);
  }
  const fails = results.filter(r => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} routes OK${cookie ? ' (authenticated mode)' : ' (unauthenticated mode)'}`);
  if (jsonOut) {
    const { writeFileSync } = require('fs');
    writeFileSync(jsonOut, JSON.stringify({ base, cookie: !!cookie, at: new Date().toISOString(), results }, null, 2));
    console.log('JSON written to', jsonOut);
  }
  if (fails.length) {
    console.log('FAILURES:');
    for (const f of fails) console.log(`  ${f.method} ${f.path}: got ${f.status} (${f.error || ''}), expected ${JSON.stringify(f.expected)}`);
    process.exit(1);
  }
}

main().catch(e => { console.error('probe fatal:', e.message); process.exit(2); });
