/**
 * server.js – Application bootstrap
 *
 * This file is intentionally thin.  Its only responsibilities are:
 *   1. Load and validate environment variables.
 *   2. Initialise the database.
 *   3. Create the Express application via createApp().
 *   4. Start the HTTP listener.
 *   5. Start background jobs (scheduler, economy scheduler, feed processor).
 *
 * To add features, edit the appropriate module under src/app/ or create a
 * new route module under routes/.  See README.md for the full project layout.
 */

require('dotenv').config();

const { validateEnv } = require('./utils/envValidator');
const { getListenHost } = require('./utils/publicConfig');
validateEnv();

const { initializeDatabase } = require('./db/schema');
const { createApp } = require('./src/app/createApp');
const { startScheduler } = require('./scheduler');
const { startEconomyScheduler } = require('./utils/economyScheduler');
const { startFeedProcessor } = require('./workers/feedProcessor');

async function startServer() {
  try {
    console.log('\n🔧 Starting DayZ Dashboard...\n');

    const db = await initializeDatabase();
    const app = createApp(db);

    const PORT = process.env.PORT || 3000;
    const listenHost = getListenHost();
    app.listen(PORT, listenHost, () => {
      console.log(`\n🚀 Server running on http://${listenHost}:${PORT}`);
      console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log('   Database: PostgreSQL');
      console.log(`   Rate limiting: ${process.env.RATE_LIMIT_ENABLED !== 'false' ? 'ENABLED' : 'DISABLED'}`);
      console.log(`   Secure cookies: ${process.env.SESSION_SECURE_COOKIE === 'true' ? 'YES' : 'NO'}`);
      console.log('');

      startScheduler(db);
      startEconomyScheduler(db);
      startFeedProcessor(db, 30);
      console.log('✅ Feed processor started');

      // Start telemetry exporter (if configured)
      try {
        const { startTelemetryExporter } = require('./utils/telemetryExporter');
        startTelemetryExporter();
      } catch (err) {
        console.warn('Telemetry exporter failed to start:', err.message);
      }
    });
  } catch (error) {
    console.error('\n❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
