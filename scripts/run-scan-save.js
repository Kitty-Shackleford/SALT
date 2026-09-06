// Run scanLogsForServer and persist parsed players (creates identities)
// Usage: USER_ID=<internal user id> PLATFORM_SERVER_ID=<Nitrado service id> node scripts/run-scan-save.js
(async () => {
  try {
    if (!process.env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is required');
    const userId = Number(process.env.USER_ID);
    const platformServerId = process.env.PLATFORM_SERVER_ID;
    if (!Number.isInteger(userId) || userId <= 0 || !platformServerId) {
      throw new Error('USER_ID and PLATFORM_SERVER_ID are required');
    }
    console.log('Starting scanLogsForServer (this will create identities)');
    const { initializeDatabase, closeDatabase } = require('../db/abstraction');
    const lp = require('../routes/logParser');

    const db = await initializeDatabase();
    try {
      const res = await lp.scanLogsForServer(db, userId, platformServerId, /* token */ null);
      console.log('SCAN_RESULT:', res);
    } finally {
      await closeDatabase();
    }
  } catch (err) {
    console.error('FATAL:', err && err.stack ? err.stack : err);
    process.exitCode = 2;
  }
})();
