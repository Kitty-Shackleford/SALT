/**
 * PostgreSQL connection helper for the Discord bot.
 *
 * Returns a shared pg Pool configured from environment variables.
 * Call db.query(sql, params) for parameterised queries.
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'dayz-dashboard',
  user: process.env.POSTGRES_USER || 'dayz-dashboard',
  password: process.env.POSTGRES_PASSWORD,
  ssl: process.env.POSTGRES_SSL === 'true'
    ? { rejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED !== 'false' }
    : false,
  connectionTimeoutMillis: 10000,
  query_timeout: 30000,
  statement_timeout: 30000,
  idle_in_transaction_session_timeout: 900000
});

module.exports = pool;
