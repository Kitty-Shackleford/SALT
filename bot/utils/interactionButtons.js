'use strict';

/**
 * interactionButtons.js
 *
 * Reusable button-card foundation for sign-up style flows (Phase A:
 * event teleport sign-ups; reused by Phase B). Owns the button customId
 * convention, the card builder, and the click handler. Kept generic on
 * purpose: `onSignUpInteraction` only knows how to route a Join/Leave click
 * to a service function — it does not own the domain rules (cap enforcement,
 * identity resolution, cap/closed/expired state) so Phase B can reuse it.
 */

const { ActionRowBuilder, ButtonBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

// customId convention: `sign_up:<eventId>:<action>` — versioned prefix so a
// future schema bump (v2) can route to new handlers without colliding.
const SIGN_UP_BUTTON_PREFIX = 'sign_up';
const JOIN_ACTION = 'join';
const LEAVE_ACTION = 'leave';

function signUpButtonId(eventId, action) {
  return `${SIGN_UP_BUTTON_PREFIX}:${Number(eventId)}:${action}`;
}

/**
 * HARD GUARD (mirrors ticketButtonService): only a genuine MESSAGE_COMPONENT
 * button interaction whose customId matches `sign_up:<eventId>:<action>` is
 * handled. Synchronous, no async pitfalls.
 */
function isSignUpButton(interaction) {
  try {
    if (!interaction || typeof interaction !== 'object') return false;
    if (typeof interaction.type === 'number' && interaction.type !== 3) return false;
    if (typeof interaction.isButton !== 'function') return false;
    if (!interaction.isButton()) return false;
    return typeof interaction.customId === 'string'
      && interaction.customId.startsWith(`${SIGN_UP_BUTTON_PREFIX}:`);
  } catch {
    return false;
  }
}

function parseSignUpCustomId(customId) {
  if (typeof customId !== 'string') return null;
  const [prefix, rawEventId, action] = customId.split(':');
  if (prefix !== SIGN_UP_BUTTON_PREFIX) return null;
  const eventId = Number(rawEventId);
  if (!Number.isSafeInteger(eventId) || eventId < 1) return null;
  if (action !== JOIN_ACTION && action !== LEAVE_ACTION) return null;
  return { eventId, action };
}

/**
 * Build the sign-up embed + ActionRow for an event.
 * @param {object} event event_teleport_signups row (id, event_name, cap, status)
 * @param {number} joined current join count
 */
function buildSignUpCard(event, joined) {
  const statusText = event.status === 'active'
    ? `Expires ${new Date(event.expires_at).toLocaleString()}`
    : `Event is ${event.status}.`;
  const embed = new EmbedBuilder()
    .setTitle(`📣 ${event.event_name}`)
    .setDescription(`Join the ${event.event_name} teleport event.`)
    .addFields(
      { name: 'Status', value: statusText, inline: true },
      { name: 'Signed up', value: `${joined} / ${event.cap}`, inline: true },
    )
    .setColor(event.status === 'active' ? 0x57f287 : 0xed4245);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(signUpButtonId(event.id, JOIN_ACTION))
      .setLabel('Join')
      .setStyle(2) // Primary
      .setDisabled(event.status !== 'active'),
    new ButtonBuilder()
      .setCustomId(signUpButtonId(event.id, LEAVE_ACTION))
      .setLabel('Leave')
      .setStyle(4), // Danger
  );
  return { embeds: [embed], components: [row] };
}

/**
 * Route a sign-up button click. `handlers` is injected so the module stays
 * decoupled from services (and unit-testable): { handleJoin, handleLeave }.
 * Both receive ({ interaction, eventId }) and must reply/edit the interaction
 * themselves; returning a message string lets us fall back to a generic
 * error reply if they did not.
 */
async function onSignUpInteraction(interaction, handlers) {
  if (!isSignUpButton(interaction)) return;
  const parsed = parseSignUpCustomId(interaction.customId);
  if (!parsed) return;
  const { eventId, action } = parsed;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const handler = action === JOIN_ACTION ? handlers.handleJoin : handlers.handleLeave;
    if (typeof handler !== 'function') throw new Error('sign-up handler is unavailable');
    await handler({ interaction, eventId });
  } catch (error) {
    // Duplicate clicks, expired components, and interaction races all land
    // here; log + best-effort reply, never crash the interaction loop.
    console.error('Sign-up button failed:', error && error.message || error);
    const content = error && typeof error.publicMessage === 'string'
      ? error.publicMessage
      : 'Something went wrong with that button. Please try again.';
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.editReply({ content, flags: MessageFlags.Ephemeral });
      }
    } catch {
      // Already replied or the interaction expired — nothing more to do.
    }
  }
}

module.exports = {
  SIGN_UP_BUTTON_PREFIX,
  signUpButtonId,
  isSignUpButton,
  parseSignUpCustomId,
  buildSignUpCard,
  onSignUpInteraction,
};
