/**
 * Log Scan Service
 *
 * Re-exports the standalone log-scanner from the logParser route module so
 * that the scheduler (and any future consumers) can depend on a stable
 * service interface rather than importing directly from a route file.
 */

const { scanLogsForServer } = require('../routes/logParser');

async function scanExactServerLogs(db, platformServerId, token, internalServerId) {
  return scanLogsForServer(db, null, platformServerId, token, {
    internalServerId,
    systemAuthorizedInternalServerId: internalServerId,
  });
}

module.exports = { scanExactServerLogs, scanLogsForServer };
