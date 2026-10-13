const {
  backfillLegacyNitradoTokenBindings,
  startLoop,
} = require('../services/serverStatusService');
const { startBotHealthHeartbeat } = require('../services/botHealthService');
const { startServerHealthMonitor } = require('../services/serverHealthMonitor');
const { startDigestLoop } = require('../services/digestService');
const { startOpsAlertLoop } = require('../services/opsAlertService');
const { startEventExpiryMonitor } = require('../utils/eventExpiry');
const { startGuildOwnershipReconciliation } = require('../services/guildOwnershipReconciliationService');
const { bootstrapConfiguredDashboardOwner } = require('../services/dashboardOwnerBootstrapService');

module.exports = {
  name: 'clientReady',
  once: true,
  async execute(client) {
    console.log(`✅ Discord bot ready! Logged in as ${client.user.tag}`);
    console.log(`📊 Connected to ${client.guilds.cache.size} guilds`);

    try {
      await backfillLegacyNitradoTokenBindings();
    } catch (error) {
      console.error('❌ Initial Nitrado token ownership backfill failed:', error.message);
    }

    for (const guild of client.guilds.cache.values()) {
      try {
        await bootstrapConfiguredDashboardOwner(guild);
      } catch (error) {
        console.error(`❌ Dashboard Owner bootstrap failed for guild ${guild.id}:`, error.message);
      }
    }

    await startBotHealthHeartbeat(client);
    startServerHealthMonitor(client);
    // Sign-up event expiry monitor (60s interval; closes expired events and
    // queues their joined sign-ups). Started here, next to the health monitor.
    startEventExpiryMonitor();
    startGuildOwnershipReconciliation(client);

    // Start the server status update loop (polls Nitrado, updates Discord channels)
    startLoop(client);
    // Player-facing AI: daily/weekly digest pass (state-backed due check).
    startDigestLoop(client);
    // Per-guild ops alerts: high/critical ops warnings (state-backed watermark).
    startOpsAlertLoop(client);
    console.log('✅ Bot initialization complete');
  }
};
