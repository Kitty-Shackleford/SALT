#!/usr/bin/env node
// Trigger the server-side scan-local-logs flow for the synced server and parse logs into DB.
// Usage: node scripts/trigger-parse-local-logs.js <serverId> <guildDiscordId> <userId>

const serverId = process.argv[2];
const guildId = process.argv[3];
const userId = process.argv[4] || '1';
if (!serverId || !guildId) {
  console.error('Usage: node scripts/trigger-parse-local-logs.js <serverId> <guildDiscordId> [userId]');
  process.exit(2);
}

(async function(){
  try {
    const { initializeDatabase, closeDatabase } = require('../db/abstraction');
    const db = await initializeDatabase();
    const logParser = require('../routes/logParser');
    console.log('Invoking scan-local-logs flow...');
    const fakeReq = { body: { serverId, guildId }, user: { id: userId, discord_id: 'bot' }, app: { locals: { db } } };
    const fakeRes = {
      status: (code) => ({ json: (obj) => { console.log('Response status', code, JSON.stringify(obj, null, 2)); } }),
      json: (obj) => console.log('Response JSON', JSON.stringify(obj, null, 2))
    };

    await logParser.router.handle(fakeReq, fakeRes, (err) => { if (err) console.error('handler error', err); });
    await closeDatabase();
  } catch (err) {
    console.error('error running parser trigger:', err);
    process.exit(1);
  }
})();
