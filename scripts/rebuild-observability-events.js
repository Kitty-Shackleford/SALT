#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function findAdmFiles(directory) {
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...findAdmFiles(entryPath));
    else if (/\.ADM$/i.test(entry.name)) results.push(entryPath);
  }
  return results.sort();
}

function logDateFromFilename(filePath) {
  const match = path.basename(filePath).match(/(\d{4}-\d{2}-\d{2})/);
  if (!match) throw new Error(`Cannot derive log date from ${filePath}`);
  return match[1];
}

async function main() {
  const platformServerId = readArg('--server');
  const expectedGuildId = readArg('--guild');
  const commit = process.argv.includes('--commit');
  if (!platformServerId || !expectedGuildId) {
    throw new Error('Usage: rebuild-observability-events.js --server <platform-server-id> --guild <discord-guild-id> [--commit]');
  }

  const { initializeDatabase, closeDatabase } = require('../db/abstraction');
  const parser = require('../routes/logParser');
  const db = await initializeDatabase();
  try {
    const matches = await db.query(
      `SELECT s.id, s.platform_server_id, s.platform, g.discord_guild_id
         FROM servers s
         JOIN guilds g ON g.id = s.guild_id
        WHERE s.platform_server_id = ? AND g.discord_guild_id = ?`,
      [String(platformServerId), String(expectedGuildId)]
    );
    if (matches.length !== 1) {
      throw new Error(`Exact target check failed: expected one server, found ${matches.length}`);
    }
    const server = matches[0];
    const downloadsRoot = process.env.DOWNLOADS_DIR || path.join(__dirname, '..', 'downloads');
    const configDir = path.join(downloadsRoot, String(expectedGuildId), `server_${platformServerId}`, 'config');
    if (!fs.existsSync(configDir)) throw new Error(`Downloaded config directory not found: ${configDir}`);

    const files = findAdmFiles(configDir);
    if (files.length === 0) throw new Error(`No ADM logs found under ${configDir}`);

    const damageEvents = [];
    const territoryEvents = [];
    const emoteEvents = [];
    for (const filePath of files) {
      const parsed = await parser.parseADMFileStream(
        filePath,
        logDateFromFilename(filePath),
        { platform: server.platform }
      );
      damageEvents.push(...parsed.damageEvents);
      territoryEvents.push(...parsed.territoryEvents);
      emoteEvents.push(...parsed.emoteEvents);
    }

    const expected = {
      damage_events: damageEvents.length,
      territory_events: territoryEvents.length,
      player_emote_events: emoteEvents.length,
    };
    console.log(JSON.stringify({ mode: commit ? 'commit' : 'dry-run', target: server, files: files.length, parsed: expected }));
    if (!commit) return;

    const before = {};
    const after = {};
    await db.transaction(async tx => {
      await tx.get('SELECT pg_advisory_xact_lock(hashtext(?), ?)', ['observability-rebuild', server.id]);
      for (const table of Object.keys(expected)) {
        before[table] = Number((await tx.get(`SELECT COUNT(*) AS count FROM ${table} WHERE server_id = ?`, [server.id])).count);
        await tx.run(`DELETE FROM ${table} WHERE server_id = ?`, [server.id]);
      }

      await parser.saveDamageEvents(tx, platformServerId, damageEvents, server.platform, server.id);
      await parser.saveTerritoryEvents(tx, platformServerId, territoryEvents, server.platform, server.id);
      await parser.saveEmoteEvents(tx, platformServerId, emoteEvents, server.platform, server.id);

      for (const table of Object.keys(expected)) {
        after[table] = Number((await tx.get(`SELECT COUNT(*) AS count FROM ${table} WHERE server_id = ?`, [server.id])).count);
        if (after[table] !== expected[table]) {
          throw new Error(`${table} verification failed: expected ${expected[table]}, found ${after[table]}`);
        }
      }
    });

    console.log(JSON.stringify({ rebuilt: true, targetServerId: server.id, before, after }));
  } finally {
    await closeDatabase();
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
