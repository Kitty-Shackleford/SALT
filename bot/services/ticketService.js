'use strict';

/**
 * ticketService.js
 *
 * Button-based support tickets. Each ticket is a Discord thread created in the
 * configured tickets channel. On close, the full thread transcript is archived
 * to the `ticket_messages` table and surfaced in the dashboard Support section.
 *
 * No real-time capture needed: on close we re-fetch every message from the
 * thread (paginated) so the transcript is complete regardless of whether the
 * bot cached each message.
 */

const { ActionRowBuilder, ButtonBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const pool = require('../db');

const CLOSE_BUTTON_ID = 'ticket_close';

/** ActionRow carrying the Close Ticket button (moderator-only via perms). */
function buildCloseRow() {
  const btn = new ButtonBuilder()
    .setCustomId(CLOSE_BUTTON_ID)
    .setLabel('Close Ticket')
    .setEmoji('📪')
    .setStyle(4); // Danger
  // Permission-gated button (Discord feature; not present in all builds).
  if (typeof btn.setPermissions === 'function') {
    btn.setPermissions(PermissionFlagsBits.ModerateMembers);
  }
  return new ActionRowBuilder().addComponents(btn);
}

async function guildDbId(discordGuildId, database) {
  const r = await database.query('SELECT id FROM guilds WHERE discord_guild_id = $1 LIMIT 1', [String(discordGuildId)]);
  return r.rows[0]?.id ?? null;
}

/**
 * Open a ticket thread.
 * @returns {Promise<{thread, ticketId}>}
 */
async function openTicket({ channel, user, subject = '', database = pool }) {
  const guild = channel.guild;
  const userName = user.username || user.id || 'unknown';
  const threadName = `ticket-${userName}-${(subject || 'support').slice(0, 24).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

  const thread = await channel.threads.create({
    name: threadName.slice(0, 90),
    // discord.js v14: single .create() on the thread manager; thread kind
    // is passed via `type` (public threads in text channels, private in
    // announcement channels where public threads are not allowed).
    type: channel.type === ChannelType.GuildAnnouncement
      ? ChannelType.PrivateThread
      : ChannelType.PublicThread,
    autoArchiveDuration: 1440,
    reason: `Ticket opened by ${userName}`,
  });

  const guildDb = await guildDbId(guild.id, database);
  const r = await database.query(
    `INSERT INTO tickets (guild_id, channel_id, subject, opened_by_discord_id, opened_by_username)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [guildDb, thread.id, String(subject || '').slice(0, 200), user.id, userName],
  );
  const ticketId = r.rows[0].id;

  // Greet in the thread.
  const closeRow = buildCloseRow();
  await thread.send({
    content:
      `<@${user.id}>, thanks for opening a ticket. A staff member will be with you shortly.\n\n` +
      `📌 **When you're done**, click **Close Ticket** below or ask a mod to run \`/ticket close\`.`,
    components: [closeRow],
  });

  return { thread, ticketId };
}

/**
 * Fetch every message in a thread, oldest → newest (paginated).
 */
async function fetchTranscript(thread) {
  const byId = new Map();
  let before = null;
  for (let guard = 0; guard < 20; guard++) { // up to ~2000 messages
    // `before` omitted on the first call returns the newest page; stepping
    // `before` to the page's oldest walks backward toward the start. Dedupe
    // by id and sort by timestamp at the end so ordering is always correct
    // regardless of how Discord paginates.
    const batch = await thread.messages.fetch({ limit: 100, before });
    if (!batch || batch.size === 0) break;
    const oldestInPage = batch.first().id;
    for (const m of batch.values()) byId.set(m.id, m);
    before = oldestInPage;
    if (batch.size < 100) break;
  }
  const out = [...byId.values()];
  out.sort((a, b) => (a.createdTimestamp < b.createdTimestamp ? -1 : a.createdTimestamp > b.createdTimestamp ? 1 : 0));
  return out;
}

/**
 * Close a ticket: archive transcript, mark closed, post a summary in the thread.
 * @returns {Promise<{ticketId, messageCount}>}
 */
async function closeTicket({ thread, closedBy, reason = null, database = pool }) {
  // Find the ticket row by channel_id.
  const find = await database.query('SELECT id FROM tickets WHERE channel_id = $1 LIMIT 1', [thread.id]);
  const ticketId = find.rows[0]?.id;

  const messages = await fetchTranscript(thread);
  if (ticketId) {
    const values = messages.map((m) => [
      ticketId,
      thread.id,
      m.author?.id || 'unknown',
      m.author?.username || 'unknown',
      String(m.content || '').slice(0, 4000),
      m.createdAt instanceof Date && !isNaN(m.createdAt.getTime())
        ? m.createdAt
        : new Date(m.createdTimestamp || Date.now()),
    ]);
    if (values.length) {
      await database.query(
        `INSERT INTO ticket_messages (ticket_id, channel_id, author_id, author_name, content, created_at)
         VALUES ` + values.map((_, i) => `($${i * 6 + 1},$${i * 6 + 2},$${i * 6 + 3},$${i * 6 + 4},$${i * 6 + 5},$${i * 6 + 6})`).join(',') + ``,
        values.flat()
      );
    }
    await database.query(
      `UPDATE tickets SET closed_at = NOW(), closed_by_discord_id = $2, close_reason = $3, message_count = $4
       WHERE id = $1`,
      [ticketId, closedBy?.id || null, reason, messages.length]
    );
  }

  await thread.send({
    content: `✅ Ticket closed${reason ? ` — **${reason}**` : ''}. Transcript archived (${messages.length} messages). ` +
      `It's now available in the dashboard **Support** section.`,
  });
  // Archive the thread so it stops appearing in the channel list.
  // v14: setArchived() (v13 had archive()); ignore failures (mod perms).
  if (typeof thread.setArchived === 'function') {
    await thread.setArchived(true).catch(() => {});
  }

  return { ticketId, messageCount: messages.length };
}

/**
 * Dashboard read: list tickets for a guild (with counts).
 */
async function listTicketsForGuild(discordGuildId, database = pool) {
  const guildDb = await guildDbId(discordGuildId, database);
  if (!guildDb) return [];
  const r = await database.query(
    `SELECT id, channel_id, subject, opened_by_discord_id, opened_by_username,
            closed_at, closed_by_discord_id, close_reason, message_count, created_at
     FROM tickets WHERE guild_id = $1
     ORDER BY created_at DESC LIMIT 100`,
    [guildDb]
  );
  return r.rows;
}

/**
 * Dashboard read: full transcript for one ticket.
 */
async function getTranscriptForTicket(ticketId, database = pool) {
  const r = await database.query(
    `SELECT author_id, author_name, content, created_at
     FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC`,
    [ticketId]
  );
  return r.rows;
}

module.exports = {
  buildCloseRow,
  openTicket,
  closeTicket,
  fetchTranscript,
  listTicketsForGuild,
  getTranscriptForTicket,
};
