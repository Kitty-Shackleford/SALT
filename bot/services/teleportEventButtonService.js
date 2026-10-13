'use strict';

/**
 * teleportEventButtonService.js
 *
 * Bridges the generic button foundation (interactionButtons) to the teleport
 * event domain: resolves the event + the clicker's player identity, then
 * calls the teleportEventService join/leave functions and replies. Kept here
 * (rather than in the command file) so the button path and any Phase B reuse
 * share one implementation.
 */

const { MessageFlags } = require('discord.js');
const db = require('../db');
const {
  resolvePlayerIdentityForUser,
  signUpForEvent,
  leaveEvent,
} = require('../../services/teleportEventService');

async function loadEventForButton(eventId) {
  return db.get(
    `SELECT e.*, s.guild_id
     FROM event_teleport_signups e
     JOIN servers s ON s.id = e.server_id
     WHERE e.id = ?`,
    [eventId]
  );
}

function replyOrFollowUp(interaction, content) {
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  }
  return interaction.editReply({ content, flags: MessageFlags.Ephemeral });
}

function buildSignUpHandlers() {
  return {
    async handleJoin({ interaction, eventId }) {
      const event = await loadEventForButton(eventId);
      if (!event) {
        await replyOrFollowUp(interaction, 'This event is no longer available.');
        return;
      }
      const identityId = await resolvePlayerIdentityForUser(db, {
        serverId: event.server_id,
        discordUserId: interaction.user.id,
      });
      if (!identityId) {
        await replyOrFollowUp(interaction,
          '❌ You must have an active, verified link to a player on this server to sign up.');
        return;
      }
      try {
        const { event: updatedEvent } = await db.transaction(async transactionDb =>
          signUpForEvent(transactionDb, {
            eventId,
            serverId: event.server_id,
            guildId: event.guild_id,
            identityId,
          })
        );
        await replyOrFollowUp(interaction,
          `✅ You are signed up for **${updatedEvent.event_name}**. ` +
          'You will be teleported when the event closes or expires.');
      } catch (error) {
        // EVENT_FULL / EVENT_CLOSED / ALREADY_JOINED — surface the public message.
        await replyOrFollowUp(interaction,
          `❌ ${error.publicMessage || 'Could not sign you up for this event.'}`);
      }
    },

    async handleLeave({ interaction, eventId }) {
      const event = await loadEventForButton(eventId);
      if (!event) {
        await replyOrFollowUp(interaction, 'This event is no longer available.');
        return;
      }
      const identityId = await resolvePlayerIdentityForUser(db, {
        serverId: event.server_id,
        discordUserId: interaction.user.id,
      });
      if (!identityId) {
        await replyOrFollowUp(interaction,
          '❌ You must have an active, verified link to a player on this server.');
        return;
      }
      try {
        await db.transaction(async transactionDb =>
          leaveEvent(transactionDb, {
            eventId,
            serverId: event.server_id,
            identityId,
          })
        );
        await replyOrFollowUp(interaction, `✅ You left **${event.event_name}**. You won't be teleported.`);
      } catch (error) {
        await replyOrFollowUp(interaction,
          `❌ ${error.publicMessage || 'Could not update your sign-up.'}`);
      }
    },
  };
}

module.exports = { buildSignUpHandlers, loadEventForButton };
