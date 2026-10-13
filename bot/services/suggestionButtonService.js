'use strict';

/**
 * suggestionButtonService.js
 *
 * Accept/Deny buttons on a posted suggestion message. The suggestion row is
 * looked up by the clicked message id (the button lives on that message), so
 * the customId is a static action token — same shape as the ticket buttons.
 *
 * customId convention: `sugg_accept` / `sugg_deny`.
 */

const { EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const pool = require('../db');

const ACCEPT_BUTTON_ID = 'sugg_accept';
const DENY_BUTTON_ID = 'sugg_deny';

/**
 * HARD GUARD (mirrors ticketButtonService / pickerButtonService): only a
 * genuine MESSAGE_COMPONENT button interaction whose customId is exactly one
 * of the suggestion action tokens is handled. Synchronous, no async pitfalls.
 */
function isSuggestionButton(interaction) {
  try {
    if (!interaction || typeof interaction !== 'object') return false;
    if (typeof interaction.type === 'number' && interaction.type !== 3) return false;
    if (typeof interaction.isButton !== 'function') return false;
    if (!interaction.isButton()) return false;
    return interaction.customId === ACCEPT_BUTTON_ID || interaction.customId === DENY_BUTTON_ID;
  } catch {
    return false;
  }
}

/**
 * Look up the suggestion row for a posted message in a guild.
 * @returns {Promise<object|null>}
 */
async function getSuggestionByMessage(guildId, messageId, database = pool) {
  const r = await database.query(
    `SELECT s.*
     FROM guilds g
     JOIN suggestions s ON s.guild_id = g.id
     WHERE g.discord_guild_id = $1 AND s.discord_message_id = $2
     LIMIT 1`,
    [String(guildId), String(messageId)]
  );
  return r.rows[0] || null;
}

/**
 * Idempotently flip a pending suggestion to a terminal status.
 * @returns {Promise<{ok:boolean, already?:string, row?:object}>}
 */
async function decideSuggestion(suggestion, decision, deciderId, database = pool) {
  const status = decision === 'accept' ? 'accepted' : 'denied';
  const r = await database.query(
    `UPDATE suggestions
     SET status = $1, decided_by_discord_id = $2, decided_at = NOW()
     WHERE guild_id = $3 AND id = $4 AND status = 'pending'
     RETURNING id, body, submitter_discord_id`,
    [status, String(deciderId), suggestion.guild_id, suggestion.id]
  );
  if (r.rowCount === 0) {
    return { ok: false, already: suggestion.status };
  }
  return { ok: true, row: r.rows[0] };
}

/**
 * Handle an Accept/Deny button click on a suggestion message.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {{database?: object}} [opts] database override (tests)
 */
async function handleSuggestionClick(interaction, opts = {}) {
  const database = opts.database || pool;
  if (!isSuggestionButton(interaction)) return;
  const decision = interaction.customId === ACCEPT_BUTTON_ID ? 'accept' : 'deny';

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  if (!guild) {
    return interaction.editReply({ content: '❌ This button only works inside a server.', flags: MessageFlags.Ephemeral });
  }

  // Buttons can't carry a permission gate, so enforce it here: only
  // members who can manage messages should be able to decide suggestions.
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    return interaction.editReply({
      content: '❌ You need the **Manage Messages** permission to accept or deny suggestions.',
      flags: MessageFlags.Ephemeral,
    });
  }

  let suggestion;
  try {
    suggestion = await getSuggestionByMessage(guild.id, interaction.message?.id, database);
  } catch (err) {
    console.warn(`⚠️ [suggestions] lookup failed: ${err.message}`);
    return interaction.editReply({ content: '❌ Could not find that suggestion.', flags: MessageFlags.Ephemeral });
  }
  if (!suggestion) {
    return interaction.editReply({ content: '❌ That message is not a tracked suggestion.', flags: MessageFlags.Ephemeral });
  }

  const result = await decideSuggestion(suggestion, decision, interaction.user.id, database);
  if (!result.ok) {
    return interaction.editReply({
      content: `❌ That suggestion was already **${result.already}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // Annotate the posted message in place (clear the buttons).
  const label = decision === 'accept' ? 'Accepted' : 'Denied';
  try {
    if (interaction.message && typeof interaction.message.edit === 'function') {
      await interaction.message.edit({
        embeds: [new EmbedBuilder()
          .setColor(decision === 'accept' ? 0x57f287 : 0xed4245)
          .setTitle(`💡 Suggestion — ${label}`)
          .setDescription(suggestion.body)
          .setFooter({ text: `Submitted by <@${suggestion.submitter_discord_id}> · ${label} by ${interaction.user.username}` })],
        components: [],
      });
    }
  } catch (err) {
    console.warn(`⚠️ [suggestions] in-place edit failed: ${err.message}`);
  }

  // DM the submitter (best-effort; their DMs may be closed or they may be absent).
  try {
    const submitter = await interaction.client?.users?.fetch?.(suggestion.submitter_discord_id);
    if (submitter) {
      await submitter.send({
        content: decision === 'accept'
          ? `✅ Your suggestion in **${guild.name}** was accepted:\n\n${suggestion.body}`
          : `❌ Your suggestion in **${guild.name}** was denied:\n\n${suggestion.body}`,
      }).catch(() => {});
    }
  } catch (err) {
    console.warn(`⚠️ [suggestions] submitter DM failed: ${err.message}`);
  }

  return interaction.editReply({
    content: decision === 'accept' ? '✅ Suggestion accepted.' : '❌ Suggestion denied.',
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = {
  ACCEPT_BUTTON_ID,
  DENY_BUTTON_ID,
  isSuggestionButton,
  getSuggestionByMessage,
  decideSuggestion,
  handleSuggestionClick,
};
