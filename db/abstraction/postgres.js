/**
 * PostgreSQL Database Adapter
 * Provides a unified interface for PostgreSQL database operations
 */
const { AsyncLocalStorage } = require('async_hooks');

class PostgreSQLAdapter {
  constructor(config = {}) {
    const configuredLockTimeout = Number(config.advisoryLockTimeoutMs ?? process.env.POSTGRES_ADVISORY_LOCK_TIMEOUT_MS);
    this.advisoryLockTimeoutMs = Number.isFinite(configuredLockTimeout) && configuredLockTimeout > 0
      ? Math.floor(configuredLockTimeout)
      : 10000;
    this.config = {
      host: config.host || process.env.POSTGRES_HOST || 'localhost',
      port: config.port || process.env.POSTGRES_PORT || 5432,
      database: config.database || process.env.POSTGRES_DB || 'dayz-dashboard',
      user: config.user || process.env.POSTGRES_USER || 'dayz-dashboard',
      password: config.password ?? process.env.POSTGRES_PASSWORD,
      ssl: config.ssl ?? (process.env.POSTGRES_SSL === 'true'
        ? { rejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED !== 'false' }
        : false),
      connectionTimeoutMillis: 10000,
      query_timeout: 30000,
      statement_timeout: 30000,
      idle_in_transaction_session_timeout: 900000
    };
    this.pool = null;
    this.transactionStorage = new AsyncLocalStorage();
    this.type = 'postgres';
  }

  /**
   * Initialize database connection
   */
  async connect() {
    const { Pool } = require('pg');
    this.pool = new Pool(this.config);

    // Test connection before exposing the adapter to callers.
    const client = await this.pool.connect();
    try {
      console.log(`📦 Connected to PostgreSQL database: ${this.config.database}`);
    } finally {
      client.release();
    }
  }

  /**
   * Close database connection
   */
  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  /**
   * Convert legacy question-mark placeholders to PostgreSQL parameters.
   */
  _convertPlaceholders(sql) {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  }

  /**
   * Run an operation on the current transaction client or a temporary pooled client.
   */
  async _withClient(operation) {
    const transactionClient = this.transactionStorage.getStore()?.client;
    if (transactionClient) {
      return operation(transactionClient);
    }

    const client = await this.pool.connect();
    try {
      return await operation(client);
    } finally {
      client.release();
    }
  }

  /**
   * Execute a query and return all rows
   * @param {string} sql - SQL query with ? placeholders (will be converted to $1, $2, etc.)
   * @param {Array} params - Parameters for the query
   * @returns {Promise<Array>} Array of rows
   */
  async query(sql, params = []) {
    return this._withClient(async client => {
      const convertedSql = this._convertPlaceholders(sql);
      const result = await client.query(convertedSql, params);
      return result.rows || [];
    });
  }

  /**
   * Execute a query and return all rows (alias for query, supports optional callback)
   * @param {string} sql - SQL query with ? placeholders
   * @param {Array} [params] - Parameters for the query
   * @param {Function} [callback] - Optional Node-style callback(err, rows)
   * @returns {Promise<Array>|undefined}
   */
  all(sql, params = [], callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    const promise = this.query(sql, params);
    if (typeof callback === 'function') {
      promise.then(rows => callback(null, rows)).catch(err => callback(err));
      return;
    }
    return promise;
  }

  /**
   * Execute a query and return a single row (supports optional callback)
   * @param {string} sql - SQL query with ? placeholders
   * @param {Array} [params] - Parameters for the query
   * @param {Function} [callback] - Optional Node-style callback(err, row)
   * @returns {Promise<Object|null>|undefined}
   */
  get(sql, params = [], callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    const promise = this.query(sql, params).then(rows => rows.length > 0 ? rows[0] : null);
    if (typeof callback === 'function') {
      promise.then(row => callback(null, row)).catch(err => callback(err));
      return;
    }
    return promise;
  }

  /**
   * Execute a query without returning rows (INSERT, UPDATE, DELETE)
   * Supports optional callback for backward compatibility.
   * @param {string} sql - SQL query with ? placeholders
   * @param {Array} [params] - Parameters for the query
   * @param {Function} [callback] - Optional Node-style callback(err)
   * @returns {Promise<Object>|undefined} Result with lastID and changes
   */
  run(sql, params = [], callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    const promise = (async () => {
      return this._withClient(async client => {
        const convertedSql = this._convertPlaceholders(sql);
        const result = await client.query(convertedSql, params);

        // INSERT statements with RETURNING can expose the generated ID.
        let lastID = null;
        if (result.rows && result.rows.length > 0 && result.rows[0].id) {
          lastID = result.rows[0].id;
        }

        return {
          lastID: lastID,
          changes: result.rowCount || 0
        };
      });
    })();
    if (typeof callback === 'function') {
      promise.then(() => callback(null)).catch(err => callback(err));
      return;
    }
    return promise;
  }

  /**
   * Insert a record and return the inserted ID
   * @param {string} table - Table name
   * @param {Object} data - Data to insert
   * @returns {Promise<number>} Inserted row ID
   */
  async insert(table, data) {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING id`;

    return this._withClient(async client => {
      const result = await client.query(sql, values);
      return result.rows[0]?.id || null;
    });
  }

  /**
   * Update records
   * @param {string} table - Table name
   * @param {Object} data - Data to update
   * @param {Object} where - WHERE conditions
   * @returns {Promise<number>} Number of rows changed
   */
  async update(table, data, where) {
    const setKeys = Object.keys(data);
    const whereKeys = Object.keys(where);
    const setClause = setKeys.map((key, i) => `${key} = $${i + 1}`).join(', ');
    const whereClause = whereKeys.map((key, i) => `${key} = $${setKeys.length + i + 1}`).join(' AND ');
    const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
    const params = [...Object.values(data), ...Object.values(where)];

    return this._withClient(async client => {
      const result = await client.query(sql, params);
      return result.rowCount || 0;
    });
  }

  /**
   * Delete records
   * @param {string} table - Table name
   * @param {Object} where - WHERE conditions
   * @returns {Promise<number>} Number of rows deleted
   */
  async delete(table, where) {
    const whereKeys = Object.keys(where);
    const whereClause = whereKeys.map((key, i) => `${key} = $${i + 1}`).join(' AND ');
    const sql = `DELETE FROM ${table} WHERE ${whereClause}`;

    return this._withClient(async client => {
      const result = await client.query(sql, Object.values(where));
      return result.rowCount || 0;
    });
  }

  /**
   * Legacy transaction methods cannot safely preserve request-local state.
   * Use transaction(callback) so AsyncLocalStorage can scope the client.
   */
  async beginTransaction() {
    throw new Error('Use transaction(callback) instead of beginTransaction()');
  }

  async commit() {
    throw new Error('Use transaction(callback) instead of commit()');
  }

  async rollback() {
    throw new Error('Use transaction(callback) instead of rollback()');
  }

  /**
   * Register compensating work that must run if the current transaction rolls
   * back. Ambiguous COMMIT outcomes are resolved before compensation, while
   * transaction-owned session advisory locks serialize remote file recovery.
   * @param {Function} callback
   */
  onTransactionRollback(callback, options = {}) {
    const store = this.transactionStorage.getStore();
    if (!store?.client) throw new Error('Rollback hooks require an active transaction');
    if (typeof callback !== 'function') throw new TypeError('Rollback hook must be a function');
    if (options.committed && typeof options.committed !== 'function') {
      throw new TypeError('Commit verifier must be a function');
    }
    if (options.deferred && typeof options.deferred !== 'function') {
      throw new TypeError('Deferred compensation hook must be a function');
    }
    if (options.afterRollback && typeof options.afterRollback !== 'function') {
      throw new TypeError('After-rollback hook must be a function');
    }
    store.rollbackHooks.push({
      callback,
      committed: options.committed || null,
      deferred: options.deferred || null,
      afterRollback: options.afterRollback || null,
    });
  }

  async acquireTransactionAdvisoryLock(namespace, key) {
    const store = this.transactionStorage.getStore();
    if (!store?.client) throw new Error('Advisory locks require an active transaction');
    const lockId = `${namespace}:${key}`;
    if (store.advisoryLocks.has(lockId)) return;
    try {
      await store.client.query(
        "SELECT set_config('lock_timeout', $1, true)",
        [`${this.advisoryLockTimeoutMs}ms`]
      );
      await store.client.query('SELECT pg_advisory_lock($1, $2)', [namespace, key]);
    } catch (error) {
      store.clientUnsafe = error;
      throw error;
    }
    store.advisoryLocks.set(lockId, [namespace, key]);
  }

  /** Run a transaction on a separate connection, even from an active transaction. */
  async independentTransaction(callback) {
    if (typeof callback !== 'function') throw new TypeError('Transaction callback must be a function');
    return this.transactionStorage.run(null, () => this.transaction(callback));
  }

  /**
   * Execute multiple statements in a transaction
   * @param {Function} callback - Callback function that executes queries
   */
  async transaction(callback) {
    if (this.transactionStorage.getStore()?.client) {
      throw new Error('Nested transactions are not supported');
    }

    const client = await this.pool.connect();
    return this.transactionStorage.run({ client, rollbackHooks: [], advisoryLocks: new Map(), transactionId: null, clientUnsafe: null }, async () => {
      const store = this.transactionStorage.getStore();
      let callbackCompleted = false;
      let originalReleased = false;

      const destroyOriginal = error => {
        if (originalReleased) return;
        originalReleased = true;
        store.client = null;
        client.release(error || new Error('Discarding unsafe PostgreSQL client'));
      };

      try {
        await client.query('BEGIN');
        const xidResult = await client.query('SELECT pg_current_xact_id()::text AS xid');
        store.transactionId = xidResult.rows?.[0]?.xid || null;
        const result = await callback(this);
        callbackCompleted = true;
        await client.query('COMMIT');
        return result;
      } catch (error) {
        const hookErrors = [];
        let recoveryClient = null;
        let recoveryUnsafe = false;
        let commitStatus = callbackCompleted ? 'unknown' : 'aborted';

        if (callbackCompleted && store.rollbackHooks.length > 0) {
          const verifier = store.rollbackHooks.find(hook => hook.committed)?.committed;
          try {
            // A failed COMMIT acknowledgement leaves the original session's
            // transaction outcome ambiguous. Never run the durable-state
            // verifier on that session: it could read its own uncommitted
            // writes and falsely suppress compensation.
            destroyOriginal(new Error('Discarding client before COMMIT recovery'));
            recoveryClient = await this.pool.connect();
            await recoveryClient.query(
              "SELECT set_config('lock_timeout', $1, false)",
              [`${this.advisoryLockTimeoutMs}ms`]
            );
            for (const [namespace, key] of store.advisoryLocks.values()) {
              await recoveryClient.query('SELECT pg_advisory_lock($1, $2)', [namespace, key]);
            }

            if (verifier) {
              try {
                commitStatus = await verifier((sql, params) => recoveryClient.query(sql, params))
                  ? 'committed'
                  : 'unknown';
              } catch (_) {
                commitStatus = 'unknown';
              }
            }

            if (commitStatus === 'unknown' && store.transactionId) {
              const statusResult = await recoveryClient.query(
                'SELECT pg_xact_status($1::xid8) AS status',
                [store.transactionId]
              );
              commitStatus = statusResult.rows?.[0]?.status || 'unknown';
            }
          } catch (recoveryError) {
            recoveryUnsafe = true;
            hookErrors.push(recoveryError);
          }
        }

        if (commitStatus === 'aborted') {
          for (const hook of store.rollbackHooks.slice().reverse()) {
            try {
              await hook.callback();
            } catch (hookError) {
              hookErrors.push(hookError);
            }
          }
        } else if (commitStatus === 'unknown' && store.rollbackHooks.length > 0) {
          const deferredHooks = store.rollbackHooks.filter(hook => hook.deferred);
          for (const hook of deferredHooks) {
            try {
              await hook.deferred();
            } catch (hookError) {
              hookErrors.push(hookError);
            }
          }
          hookErrors.push(new Error('Commit outcome is unknown; remote compensation was deferred'));
        }

        if (!originalReleased) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            hookErrors.push(rollbackError);
            destroyOriginal(rollbackError);
          }
        }

        if (commitStatus === 'aborted') {
          for (const hook of store.rollbackHooks) {
            if (!hook.afterRollback) continue;
            try {
              await hook.afterRollback();
            } catch (hookError) {
              hookErrors.push(hookError);
            }
          }
        }

        if (recoveryClient) {
          for (const [namespace, key] of Array.from(store.advisoryLocks.values()).reverse()) {
            try {
              const unlockResult = await recoveryClient.query(
                'SELECT pg_advisory_unlock($1, $2) AS unlocked',
                [namespace, key]
              );
              if (unlockResult.rows?.[0]?.unlocked !== true) {
                throw new Error('Recovery advisory lock was not held');
              }
            } catch (unlockError) {
              recoveryUnsafe = true;
              hookErrors.push(unlockError);
            }
          }
          try {
            await recoveryClient.query('RESET lock_timeout');
          } catch (resetError) {
            recoveryUnsafe = true;
            hookErrors.push(resetError);
          }
          recoveryClient.release(recoveryUnsafe ? new Error('Discarding unsafe recovery client') : undefined);
        }

        if (hookErrors.length > 0) {
          const compensationError = new Error(
            error.message + '; rollback compensation failed: ' +
            hookErrors.map(item => item.message).join('; ')
          );
          compensationError.cause = error;
          throw compensationError;
        }
        throw error;
      } finally {
        if (!originalReleased) {
          let cleanupError = null;
          for (const [namespace, key] of Array.from(store.advisoryLocks.values()).reverse()) {
            try {
              const unlockResult = await client.query(
                'SELECT pg_advisory_unlock($1, $2) AS unlocked',
                [namespace, key]
              );
              if (unlockResult.rows?.[0]?.unlocked !== true) {
                cleanupError = cleanupError || new Error('Transaction advisory lock was not held');
              }
            } catch (error) {
              cleanupError = cleanupError || error;
            }
          }
          store.client = null;
          originalReleased = true;
          client.release(cleanupError || store.clientUnsafe || undefined);
        }
      }
    });
  }

  /**
   * Get the native database connection pool
   * @returns {Pool} Native PostgreSQL connection pool
   */
  getNativeConnection() {
    return this.pool;
  }

  /**
   * Check if table exists
   * @param {string} tableName - Table name
   * @returns {Promise<boolean>} True if table exists
   */
  async tableExists(tableName) {
    const result = await this.get(
      `SELECT tablename FROM pg_tables WHERE tablename = $1 AND schemaname = 'public'`,
      [tableName]
    );
    return result !== null;
  }

  /**
   * Get database schema version
   * Note: PostgreSQL doesn't have PRAGMA, so we use a custom table
   * @returns {Promise<number>} Schema version
   */
  async getSchemaVersion() {
    // Create version table if it doesn't exist. Any catalog/query error must
    // abort initialization rather than masquerading as a fresh database.
    await this.run(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const result = await this.get('SELECT MAX(version) as version FROM schema_version');
    return result?.version || 0;
  }

  /**
   * Set database schema version
   * @param {number} version - Schema version
   */
  async setSchemaVersion(version) {
    await this.run('INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING', [version]);
  }
}

module.exports = PostgreSQLAdapter;
