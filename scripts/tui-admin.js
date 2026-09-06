#!/usr/bin/env node
const blessed = require('blessed');
const contrib = require('blessed-contrib');
const { initializeDatabase } = require('../db/abstraction');
const { performLogSyncConcurrent } = require('../services/logSyncService');

// Helper: fetch servers; accepts optional db to avoid redundant connects
async function fetchServers(db) {
  const _db = db || await initializeDatabase();
  const rows = await _db.query('SELECT id, name, platform, platform_server_id FROM servers ORDER BY id');
  return rows;
}

// Helper: fetch online players for a server; accepts optional db
async function fetchOnlinePlayers(serverId, db) {
  const _db = db || await initializeDatabase();
  try {
    const rows = await _db.query(
      `SELECT cache.gamertag, cache.login_at, cache.updated_at
         FROM server_online_cache cache
         JOIN server_online_cache_snapshots snapshot
           ON snapshot.server_id = cache.server_id
        WHERE cache.server_id = ?
          AND snapshot.source_observed_at >= clock_timestamp() - INTERVAL '120 minutes'
          AND snapshot.source_observed_at <= clock_timestamp() + INTERVAL '5 minutes'
        ORDER BY cache.login_at ASC`,
      [serverId]
    );
    return rows;
  } catch (e) {
    return [];
  }
}

async function run() {
  const db = await initializeDatabase();
  const screen = blessed.screen({ smartCSR: true, title: 'DayZ Admin TUI' });

  const grid = new contrib.grid({ rows: 12, cols: 12, screen: screen });

  const serverList = grid.set(0, 0, 8, 4, contrib.table, {
    keys: true,
    fg: 'white',
    selectedFg: 'white',
    selectedBg: 'blue',
    interactive: true,
    label: 'Servers',
    width: '30%',
    columnSpacing: 1,
    columnWidth: [6, 24, 8, 10]
  });

  const detailsBox = grid.set(0, 4, 8, 8, blessed.box, { label: 'Details', content: 'Select a server', tags: true, scrollable: true, alwaysScroll: true, keys: true, vi: true });

  const footer = grid.set(8, 0, 4, 12, blessed.box, { height: 4, content: 'q=quit, r=refresh, s=sync, e=edit name, d=delete', tags: true });

  async function refresh() {
    const servers = await fetchServers(db);
    const data = servers.map(s => [String(s.id), s.name || 'Unnamed', s.platform || '?', String(s.platform_server_id || '')]);
    serverList.setData({ headers: ['ID', 'Name', 'Platform', 'SvcID'], data });
    screen.render();
  }

  serverList.rows.on('select', async item => {
    try {
      const id = parseInt(item.content.split(' ')[0], 10);
      const players = await fetchOnlinePlayers(id, db);
      const lines = players.map(player => {
        const loginAt = player.login_at ? new Date(player.login_at).toLocaleString() : 'unknown';
        return `${player.gamertag || 'Unknown'} (login: ${loginAt})`;
      });
      detailsBox.setContent(lines.join('\n') || 'No players online');
      screen.render();
    } catch (e) { detailsBox.setContent('Error loading details: ' + e.message); screen.render(); }
  });

  // Key bindings
  screen.key(['q', 'C-c'], () => process.exit(0));
  screen.key(['r'], () => refresh());
  screen.key(['s'], async () => {
    footer.setContent('Starting log sync...');
    screen.render();
    try {
      const servers = await fetchServers(db);
      const ids = servers.map(s => String(s.platform_server_id));
      const row = await db.get(
        `SELECT token_hash
         FROM guild_tokens
         WHERE token_type = ?
         ORDER BY created_at DESC
         LIMIT 1`,
        ['nitrado']
      );
      const enc = require('../utils/encryption');
      const token = row && row.token_hash ? enc.decryptToken(row.token_hash) : null;
      const out = await performLogSyncConcurrent(db, 1, token, ids);
      footer.setContent('Log sync finished: ' + JSON.stringify(out));
    } catch (e) { footer.setContent('Log sync error: ' + e.message); }
    screen.render();
  });

  screen.key(['e'], async () => {
    const idx = serverList.selected;
    if (idx == null) return;
    const row = serverList.rows.items[idx].content.split(/\s+/);
    const id = parseInt(row[0], 10);
    const prompt = blessed.prompt({ parent: screen, border: 'line', height: 7, width: '50%', top: 'center', left: 'center', label: 'Set custom name' });
    prompt.input('Custom display name:', '', async (err, value) => {
      if (!err && value) {
        await db.query(
          `INSERT INTO server_features (server_id, feature_name, config)
           VALUES (?, ?, ?)
           ON CONFLICT (server_id, feature_name) DO UPDATE SET config = EXCLUDED.config`,
          [id, 'custom_name', JSON.stringify({ value })]
        );
        footer.setContent('Custom name set for server ' + id);
        refresh();
      }
      prompt.destroy();
      screen.render();
    });
  });

  screen.key(['d'], async () => {
    const idx = serverList.selected;
    if (idx == null) return;
    const row = serverList.rows.items[idx].content.split(/\s+/);
    const id = parseInt(row[0], 10);
    try {
      await db.query("UPDATE servers SET status = 'inactive' WHERE id = ? AND status = 'active'", [id]);
      footer.setContent('Deactivated server ' + id);
      refresh();
    } catch (e) { footer.setContent('Delete error: ' + e.message); }
    screen.render();
  });

  await refresh();
  serverList.focus();
  screen.render();
}

run().catch(e => { console.error(e); process.exit(1); });
