const PostgreSQLAdapter = require('./postgres');

/**
 * PostgreSQL database connection factory.
 */

let dbInstance = null;

/**
 * Initialize the PostgreSQL database connection.
 * @param {Object} config - Optional configuration override
 * @returns {Promise<PostgreSQLAdapter>} Database adapter
 */
async function initializeDatabase(config = {}) {
  if (dbInstance) {
    return dbInstance;
  }

  console.log('🔧 Initializing PostgreSQL database...');
  dbInstance = new PostgreSQLAdapter(config);

  await dbInstance.connect();
  return dbInstance;
}

/**
 * Get the current database instance
 * @returns {PostgreSQLAdapter|null} Database adapter or null if not initialized
 */
function getDatabaseInstance() {
  return dbInstance;
}

/**
 * Close the database connection
 */
async function closeDatabase() {
  if (dbInstance) {
    await dbInstance.close();
    dbInstance = null;
  }
}

module.exports = {
  initializeDatabase,
  getDatabaseInstance,
  closeDatabase,
  PostgreSQLAdapter
};
