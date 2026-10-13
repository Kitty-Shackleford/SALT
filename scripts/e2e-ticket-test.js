'use strict';
// E2E ticket test: open ticket -> post messages -> close -> verify transcript.
// Uses the real bot client + ticketService. Cleans up after itself.
require('dotenv').config({ path: '/app/.env' });
const { Client, GatewayIntentBits } = require('discord.js');
const service = require('/app/bot/services/ticketService');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let failed = false;

client.once('ready', async () => {
  try {
    // 1. pick the ticket channel (guild 789326430571855893, channel 1079191113665085600)
    const guild = client.guilds.cache.get('789326430571855893');
    const channel = guild.channels.cache.get('1079191113665085600');
    if (!channel) throw new Error('ticket channel not found in cache');

    // 2. open
    const { thread, ticketId } = await service.openTicket({ channel, user: client.user, subject: 'E2E TEST' });
    console.log('OPENED ticketId=' + ticketId + ' thread=' + thread.id + ' name=' + thread.name);

    // 3. post a couple of messages in the thread
    await thread.send('E2E test message 1');
    await thread.send('E2E test message 2');
    await new Promise(r => setTimeout(r, 1500));

    // 4. close
    const res = await service.closeTicket({ thread, closedBy: client.user, reason: 'e2e-test' });
    console.log('CLOSED ticketId=' + res.ticketId + ' messages=' + res.messageCount);

    // 5. verify transcript rows
    const { pool } = await import('/app/bot/db.js').then(m => ({ pool: m.default || m }));
    const rows = await pool.query('SELECT count(*)::int AS n FROM ticket_messages WHERE ticket_id = $1', [ticketId]);
    const n = rows.rows[0].n;
    console.log('DB transcript rows for ticket ' + ticketId + ': ' + n);
    const status = await pool.query(
      'SELECT closed_at IS NOT NULL AS closed, message_count, close_reason FROM tickets WHERE id = $1',
      [ticketId]
    );
    console.log('DB ticket row: ' + JSON.stringify(status.rows[0]));

    // 6. verify dashboard route SQL (same queries supportHub.js uses)
    const guildRows = await pool.query(
      'SELECT id, channel_id, subject, closed_at FROM tickets WHERE id = $1', [ticketId]
    );
    console.log('dashboard list query finds ticket: ' + (guildRows.rows.length === 1));

    const ok = n >= 3 && status.rows[0].closed && status.rows[0].message_count >= 3;
    console.log(ok ? 'E2E PASS' : 'E2E FAIL');
    failed = !ok;

    // 7. cleanup: delete thread + DB rows for this test ticket
    await thread.delete('e2e test cleanup').catch(() => {});
    await pool.query('DELETE FROM ticket_messages WHERE ticket_id = $1', [ticketId]);
    await pool.query('DELETE FROM tickets WHERE id = $1', [ticketId]);
    const left = await pool.query('SELECT count(*)::int AS n FROM tickets');
    console.log('CLEANUP done, tickets remaining: ' + left.rows[0].n);
  } catch (e) {
    console.log('E2E ERROR: ' + e.message);
    console.log(e.stack.split('\n').slice(0, 5).join('\n'));
    failed = true;
  } finally {
    await client.destroy();
    process.exit(failed ? 1 : 0);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
