'use strict';

/**
 * ticketButtonService.js
 *
 * Handles the "Open Ticket" and "Close Ticket" button clicks. Wired from
 * bot/index.js's interactionCreate handler.
 */

const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const { openTicket, closeTicket } = require('./ticketService');

const OPEN_BUTTON_ID = 'ticket_open';
const CLOSE_BUTTON_ID = 'ticket_close';

/**
 * HARD GUARD: only a genuine button interaction whose customId is exactly
 * 'ticket_open' is treated as the Open Ticket button. Anything else — chat
 * commands, autocompletes, selects, malformed interactions — is rejected.
 *
 * Root-cause context: the previous guard was declared `async` and called
 * WITHOUT await, so it returned a (truthy) Promise for EVERY interaction and
 * every slash command fell through to handleTicketOpen — spawning a phantom
 * ticket thread per command. This guard is synchronous and version-stable:
 * it relies on the canonical isButton() method (present on both the Button
 * and non-Button Interaction shapes) plus the raw numeric gateway type (3 =
 * MESSAGE_COMPONENT) as defense in depth, and a strict customId match.
 */
function isTicketOpenButton(interaction) {
  try {
    if (!interaction || typeof interaction !== 'object') return false;
    // Raw gateway type: 3 = MESSAGE_COMPONENT (button/select/modal). Chat
    // commands are 2, autocompletes 4. Using the literal avoids enum-name
    // differences across discord.js builds.
    if (typeof interaction.type === 'number' && interaction.type !== 3) return false;
    if (typeof interaction.isButton !== 'function') return false;
    if (!interaction.isButton()) return false;
    return interaction.customId === OPEN_BUTTON_ID;
  } catch {
    return false;
  }
}

async function handleTicketOpen(interaction) {
  // Second guard (defense in depth): refuse to proceed unless this is an
  // unambiguous Open-Ticket button interaction. Never trust the caller's
  // classification.
  if (!isTicketOpenButton(interaction)) {
    console.error('🚫 [ticket] handleTicketOpen called for a NON-button interaction — refusing. id=', interaction?.id, 'type=', interaction?.type, 'customId=', interaction?.customId, 'ctor=', interaction?.constructor?.name);
    if (interaction?.responded === false && interaction?.deferReply) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }
  // Acknowledge immediately; the thread create + greet can take a moment.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased()) {
    return interaction.editReply({ content: '❌ Tickets can only be opened in a text channel.', flags: MessageFlags.Ephemeral });
  }
  if (channel.isThread()) {
    return interaction.editReply({ content: '❌ Already in a thread.', flags: MessageFlags.Ephemeral });
  }

  try {
    const { thread } = await openTicket({ channel, user: interaction.user });
    await interaction.editReply({
      content: `✅ Ticket opened: **${thread.name}**\nYou were added to it automatically. A staff member will join shortly.`,
    });
  } catch (err) {
    console.error('❌ [ticket] open failed:', err.message);
    return interaction.editReply({ content: '❌ Could not open a ticket. Please try again or contact staff directly.', flags: MessageFlags.Ephemeral });
  }
}

/**
 * Handle the Close Ticket button. Only valid inside a ticket thread.
 */
async function handleTicketClose(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = interaction.channel;
  if (!channel?.isThread?.()) {
    return interaction.editReply({ content: '❌ Close Ticket only works inside a ticket thread.', flags: MessageFlags.Ephemeral });
  }

  // Moderator check: the button is already permission-gated, but enforce it
  // server-side as well (defense in depth against misconfigured perms).
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
    return interaction.editReply({ content: '❌ You need Moderator permission to close a ticket.', flags: MessageFlags.Ephemeral });
  }

  try {
    const result = await closeTicket({ thread: channel, closedBy: interaction.user, reason: `closed by ${interaction.user.username || interaction.user.id}` });
    return interaction.editReply({
      content: `✅ Ticket closed. ${result.messageCount} messages archived to the dashboard **Support** section.`,
    });
  } catch (err) {
    console.error('❌ [ticket] close failed:', err.message);
    return interaction.editReply({ content: '❌ Could not close the ticket. Please ask a mod to use `/ticket close`.', flags: MessageFlags.Ephemeral });
  }
}

module.exports = { isTicketOpenButton, handleTicketOpen, handleTicketClose, OPEN_BUTTON_ID, CLOSE_BUTTON_ID };
