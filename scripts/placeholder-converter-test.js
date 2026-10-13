#!/usr/bin/env node
/**
 * db:placeholder-converter-test
 *
 * Regression test for the legacy `?` -> `$n` placeholder converter in
 * db/abstraction/postgres.js.
 *
 * The original implementation was a bare `sql.replace(/\?/g, ...)` which
 * rewrote `?` characters INSIDE single-quoted SQL string literals as well.
 * The operations-map kill query uses DayZ coordinate validator regexes such
 * as '^[+-]?[0-9]+([.][0-9]+)?$' — their `?` characters were rewritten to
 * $1/$2, shifting the real parameters and making PostgreSQL report
 * "could not determine data type of parameter $1" on every call. The
 * operations map was 100% broken until the converter became
 * string-literal-aware.
 *
 * Part 1 (always runs): unit tests of _convertPlaceholders on the class.
 * Part 2 (runs when a DB is reachable): executes the exact operations-map
 * kill query against a real PostgreSQL database.
 *
 * Usage:
 *   npm run test:placeholders
 *
 * Environment (same as the main application):
 *   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD
 */

'use strict';

require('dotenv').config();

const assert = require('assert').strict;
const PostgreSQLAdapter = require('../db/abstraction/postgres');

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}

(async () => {
  const adapter = new PostgreSQLAdapter({});

  // ── Part 1: pure converter unit tests ─────────────────────────────────
  await test('converts simple sequential placeholders', () => {
    assert.equal(
      adapter._convertPlaceholders('SELECT * FROM users WHERE id = ? AND name = ?'),
      'SELECT * FROM users WHERE id = $1 AND name = $2'
    );
  });

  await test('preserves ? inside single-quoted string literals (DayZ validator regex)', () => {
    const sql = `SELECT id,
        CASE WHEN SPLIT_PART(victim_position, ',', 1) ~ '^[+-]?[0-9]+([.][0-9]+)?$'
             THEN CAST(SPLIT_PART(victim_position, ',', 1) AS DOUBLE PRECISION) END AS east
   FROM kill_events
  WHERE server_id = ? AND timestamp >= ?
  ORDER BY timestamp DESC, id DESC LIMIT 1000`;
    assert.equal(
      adapter._convertPlaceholders(sql),
      sql.replace(/WHERE server_id = \?/, 'WHERE server_id = $1')
         .replace(/timestamp >= \?/, 'timestamp >= $2')
    );
    // The converted SQL must still contain the validator regex verbatim.
    assert.match(adapter._convertPlaceholders(sql), /~ '\^\[\+\-\]\?\[0-9\]\+\(\[\.\]\[0-9\]\+\)\?\$/);
    // And it must NOT contain any $ inside the regex string literal.
    const converted = adapter._convertPlaceholders(sql);
    const literal = converted.match(/'[^']*\$\d[^']*'/);
    assert.equal(literal, null, `parameter leaked into a string literal: ${literal && literal[0]}`);
  });

  await test('handles empty, NULL and quoted-string edge cases', () => {
    assert.equal(adapter._convertPlaceholders('SELECT 1'), 'SELECT 1');
    assert.equal(adapter._convertPlaceholders('SELECT ?'), 'SELECT $1');
    assert.equal(adapter._convertPlaceholders("SELECT '' AS empty"), "SELECT '' AS empty");
    assert.equal(adapter._convertPlaceholders('SELECT NULLIF(?, ?)'), 'SELECT NULLIF($1, $2)');
  });

  await test('respects escaped (doubled) quotes inside string literals', () => {
    assert.equal(
      adapter._convertPlaceholders("SELECT * FROM t WHERE name = 'it''s ?' AND id = ?"),
      "SELECT * FROM t WHERE name = 'it''s ?' AND id = $1"
    );
  });

  await test('converts placeholders after a quoted string in the same statement', () => {
    assert.equal(
      adapter._convertPlaceholders("SELECT ? FROM t WHERE note = '?' LIMIT ?"),
      "SELECT $1 FROM t WHERE note = '?' LIMIT $2"
    );
  });

  await test('does not convert dollar-quoted bodies', () => {
    // Dollar-quoted function bodies commonly contain `?` in regexes.
    const sql = 'SELECT $fn$ WHEN x ~ \'^[0-9]?$\' THEN 1 END $fn$ FROM t WHERE a = ?';
    const converted = adapter._convertPlaceholders(sql);
    assert.equal(converted, 'SELECT $fn$ WHEN x ~ \'^[0-9]?$\' THEN 1 END $fn$ FROM t WHERE a = $1');
  });

  // ── Part 2: live-DB regression (skipped when no DB is configured) ─────
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port = Number(process.env.POSTGRES_PORT || 5432);
  let pool = null;
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      host,
      port,
      database: process.env.POSTGRES_DB || 'dayz-dashboard',
      user: process.env.POSTGRES_USER || 'dayz-dashboard',
      password: process.env.POSTGRES_PASSWORD,
      ssl: process.env.POSTGRES_SSL === 'true'
        ? { rejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED !== 'false' }
        : false,
      connectionTimeoutMillis: 5000,
    });
    await pool.query('SELECT 1');
  } catch (error) {
    console.log(`  (skipping live-DB checks: database not reachable at ${host}:${port} — ${error.code || error.message})`);
    pool = null;
  }

  if (pool) {
    try {
      // The exact query shape that broke the operations map. Uses the real
      // adapter so the converter is exercised end-to-end.
      const db = new PostgreSQLAdapter({});
      db.pool = pool; // reuse the verified pool, no second connection

      await test('operations-map kill query executes (live DB)', async () => {
        const rows = await db.query(
          `SELECT id,
              CASE WHEN SPLIT_PART(victim_position, ',', 1) ~ '^[+-]?[0-9]+([.][0-9]+)?$'
                   THEN CAST(SPLIT_PART(victim_position, ',', 1) AS DOUBLE PRECISION) END AS east,
              CASE WHEN SPLIT_PART(victim_position, ',', 2) ~ '^[+-]?[0-9]+([.][0-9]+)?$'
                   THEN CAST(SPLIT_PART(victim_position, ',', 2) AS DOUBLE PRECISION) END AS north
           FROM kill_events
          WHERE server_id = ? AND timestamp >= ?
            AND victim_position IS NOT NULL
          ORDER BY timestamp DESC, id DESC
          LIMIT 10`,
          [1, new Date(Date.now() - 3600000).toISOString()]
        );
        assert.ok(Array.isArray(rows));
      });

      await test('full buildOperationsMapSnapshot succeeds (live DB)', async () => {
        const { buildOperationsMapSnapshot } = require('../services/operationsMapService');
        const snapshot = await buildOperationsMapSnapshot({
          db,
          serverId: 1,
          mapName: 'chernarusplus',
          activeSessionStartedAt: new Date(Date.now() - 3600000).toISOString(),
          windowMinutes: 60,
        });
        assert.ok(snapshot && typeof snapshot === 'object');
      });
    } finally {
      await pool.end();
    }
  }

  console.log(failures === 0 ? '✅ Placeholder converter tests passed' : `❌ ${failures} placeholder converter test(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(error => {
  console.error('Fatal:', error);
  process.exit(1);
});
