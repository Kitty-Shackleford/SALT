#!/usr/bin/env node
// Exports up to 100 territory_events with structure_type='unknown' and their log_source
const Postgres = require('../db/abstraction/postgres');
(async ()=>{
  const db = new Postgres();
  try {
    await db.connect();
    const rows = await db.query(
      `SELECT id, server_id, player_gamertag, event_type, structure_type, position, pos_x, pos_y, pos_z, timestamp, log_source
       FROM territory_events WHERE structure_type=$1 ORDER BY id DESC LIMIT 100`,
      ['unknown']
    );
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error('ERROR:', err && err.message ? err.message : err);
    process.exit(1);
  } finally {
    try { await db.close(); } catch(_){}
  }
})();
