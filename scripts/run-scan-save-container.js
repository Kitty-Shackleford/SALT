// run-scan-save-container.js
// Run scanLogsForServer and persist parsed players (creates identities).
// Run inside container as:
// USER_ID=<internal user id> PLATFORM_SERVER_ID=<Nitrado service id> node /app/scripts/run-scan-save-container.js

(async function(){
  try {
    if (!process.env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is required');
    const userId = Number(process.env.USER_ID);
    const platformServerId = process.env.PLATFORM_SERVER_ID;
    if (!Number.isInteger(userId) || userId <= 0 || !platformServerId) {
      throw new Error('USER_ID and PLATFORM_SERVER_ID are required');
    }

    console.log('Starting scanLogsForServer (will save identities). This may take a few minutes...');

    const { initializeDatabase, closeDatabase } = require('../db/abstraction');
    const lp = require('../routes/logParser');

    const db = await initializeDatabase();
    try {
      const res = await lp.scanLogsForServer(db, userId, platformServerId, /* token */ null);
      console.log('\nSCAN_RESULT:', JSON.stringify(res, null, 2));

      // Optionally verify selected platform user IDs and a gamertag.
      const keysToCheck = (process.env.PLATFORM_USER_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
      const rows = [];
      for (const k of keysToCheck) {
        try {
          const idRow = await db.get('SELECT id, player_id, platform, platform_user_id, dpnid, device_id FROM player_identities WHERE platform_user_id = ?', [k]);
          if (idRow) rows.push({key:k, identity: idRow});
        } catch (e) {
          // ignore
        }
      }

      const gamertag = process.env.GAMERTAG;
      let gamertags = [];
      if (gamertag) {
        gamertags = await db.query(
          'SELECT pg.*, p.id as player_id FROM player_gamertags pg JOIN player_identities pi ON pg.identity_id = pi.id JOIN players p ON pi.player_id = p.id WHERE LOWER(pg.gamertag) = LOWER(?)',
          [gamertag]
        );
      }

      console.log('\nIDENTITIES_FOUND_FOR_KEYS:', JSON.stringify(rows, null, 2));
      console.log('\nGAMERTAGS_FOUND:', JSON.stringify(gamertags, null, 2));

    } finally {
      await closeDatabase();
    }

    console.log('\nDone.');
  } catch (err) {
    console.error('FATAL_ERROR:', err && err.stack ? err.stack : err);
    process.exitCode = 2;
  }
})();
