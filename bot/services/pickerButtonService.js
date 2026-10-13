'use strict';

/**
 * pickerButtonService.js
 *
 * Single-panel reaction-role picker: one button per (emoji, role) binding,
 * posted as one (or a few) message(s) in a channel. Clicking a button
 * toggles the bound role for the clicking member (add if missing, remove if
 * present) — same effect as reacting, without needing the emoji.
 *
 * Reuses the `reaction_roles` table read by reactionRoleService; the picker
 * is a view over that table, so it stays in sync automatically with
 * /setup-reactions add/remove. The picker message itself is NOT stored as a
 * binding (it is not bound to a single emoji), so re-run the picker command
 * to refresh a panel after bindings change.
 *
 * customId convention: `rr_btn:<emoji>:<roleId>` — versioned prefix (rr_btn)
 * so a future schema bump can route to new handlers without colliding.
 * Emoji names contain no ':' (custom names are [a-z0-9_]+; unicode emoji are
 * not ':'), so the customId is unambiguously splittable.
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const pool = require('../db');
const { normalizeEmoji } = require('./reactionRoleService');

const RR_PICKER_PREFIX = 'rr_btn';
const BUTTONS_PER_ROW = 5;
const BUTTONS_PER_MESSAGE = 25; // Discord hard cap for components per message

function rrPickerButtonId(emoji, roleId) {
  return `${RR_PICKER_PREFIX}:${String(emoji)}:${String(roleId)}`;
}

/**
 * HARD GUARD (mirrors ticketButtonService / interactionButtons): only a
 * genuine MESSAGE_COMPONENT button interaction whose customId starts with
 * `rr_btn:` is handled. Synchronous, no async pitfalls.
 */
function isPickerButton(interaction) {
  try {
    if (!interaction || typeof interaction !== 'object') return false;
    if (typeof interaction.type === 'number' && interaction.type !== 3) return false;
    if (typeof interaction.isButton !== 'function') return false;
    if (!interaction.isButton()) return false;
    return typeof interaction.customId === 'string'
      && interaction.customId.startsWith(`${RR_PICKER_PREFIX}:`);
  } catch {
    return false;
  }
}

/**
 * Parse `rr_btn:<emoji>:<roleId>` -> { emoji, roleId } | null.
 */
function parsePickerCustomId(customId) {
  if (typeof customId !== 'string') return null;
  const [prefix, emoji, roleId] = customId.split(':');
  if (prefix !== RR_PICKER_PREFIX) return null;
  if (!emoji) return null;
  if (!/^\d+$/.test(roleId)) return null;
  return { emoji, roleId: String(roleId) };
}

/**
 * Build the picker embed(s) + button rows for a list of bindings.
 *
 * @param {Array<{emoji:string, displayEmoji:string, roleId:string, roleName:string}>} bindings
 *   `emoji` is the normalized (colon-free) form used in the button customId;
 *   `displayEmoji` is the setEmoji-safe form shown on the button.
 * @returns {Array<{embeds: Array, components: Array}>} one content object per
 *   message needed (>=1 message when bindings is non-empty).
 */
function buildPickerMessages(bindings) {
  if (!bindings.length) return [];

  const allRows = [];
  for (let i = 0; i < bindings.length; i += BUTTONS_PER_ROW) {
    const chunk = bindings.slice(i, i + BUTTONS_PER_ROW);
    const row = new ActionRowBuilder().addComponents(
      ...chunk.map(b => {
        const button = new ButtonBuilder()
          .setCustomId(rrPickerButtonId(b.emoji, b.roleId))
          .setLabel(b.roleName)
          .setStyle(2); // Primary
        try {
          button.setEmoji(b.displayEmoji || b.emoji);
        } catch {
          // Unparseable emoji (e.g. a custom name the cache missed): post
          // the button without an emoji rather than failing the panel.
        }
        return button;
      })
    );
    allRows.push(row);
  }

  const messages = [];
  for (let i = 0; i < allRows.length; i += Math.floor(BUTTONS_PER_MESSAGE / BUTTONS_PER_ROW)) {
    const rows = allRows.slice(i, i + Math.floor(BUTTONS_PER_MESSAGE / BUTTONS_PER_ROW));
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Reaction Roles')
      .setDescription('Click a button to toggle the role.');
    messages.push({ embeds: [embed], components: rows });
  }
  return messages;
}

/**
 * Stale-panel guard: the picker button must still correspond to a live
 * binding in `reaction_roles`. Panels are snapshots — admins re-post with
 * /setup-reactions picker after bindings change, and a deleted binding must
 * not keep granting its role through an old panel.
 */
async function isLiveBinding(guildId, emoji, roleId, database = pool) {
  const r = await database.query(
    `SELECT 1
     FROM guilds g
     JOIN reaction_roles rr ON rr.guild_id = g.id
     WHERE g.discord_guild_id = $1
       AND rr.emoji = $2
       AND rr.role_id = $3
     LIMIT 1`,
    [String(guildId), String(emoji), String(roleId)]
  );
  return r.rows.length > 0;
}

/**
 * Handle a picker button click: toggle the bound role on the member.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {{database?: object}} [opts] database override (tests)
 */
async function handlePickerClick(interaction, opts = {}) {
  const database = opts.database || pool;
  if (!isPickerButton(interaction)) return;
  const parsed = parsePickerCustomId(interaction.customId);
  if (!parsed) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  if (!guild) {
    return interaction.editReply({ content: '❌ This button only works inside a server.', flags: MessageFlags.Ephemeral });
  }

  // Custom-emoji names are stored without the <:name:id> wrapper, but the
  // button customId carries what the admin typed (normalized at add time).
  // Normalize here too so a custom-emoji binding matches.

  let live;
  try {
    live = await isLiveBinding(guild.id, normalizeEmoji(parsed.emoji), parsed.roleId, database);
  } catch (err) {
    console.warn(`⚠️ [picker] binding lookup failed: ${err.message}`);
    return interaction.editReply({ content: '❌ Could not verify this button. An admin should re-post the picker.', flags: MessageFlags.Ephemeral });
  }
  if (!live) {
    return interaction.editReply({ content: '❌ That binding no longer exists. An admin should re-post the picker.', flags: MessageFlags.Ephemeral });
  }

  let member;
  try {
    member = await guild.members.fetch(interaction.user.id);
  } catch (err) {
    console.warn(`⚠️ [picker] member fetch failed for ${interaction.user.id}: ${err.message}`);
    return interaction.editReply({ content: '❌ Could not load your member info. Try again.', flags: MessageFlags.Ephemeral });
  }

  const role = guild.roles.cache.get(parsed.roleId);
  if (!role) {
    return interaction.editReply({ content: '❌ That role no longer exists. An admin should re-post the picker.', flags: MessageFlags.Ephemeral });
  }

  try {
    const has = member.roles.cache.has(parsed.roleId);
    if (has) {
      await member.roles.remove(parsed.roleId, `reaction role picker (${parsed.emoji})`);
      return interaction.editReply({
        content: `🔻 Removed **${role.name}** from you.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    await member.roles.add(parsed.roleId, `reaction role picker (${parsed.emoji})`);
    return interaction.editReply({
      content: `✅ Added **${role.name}** to you.`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    console.error(`❌ [picker] role toggle failed for member ${interaction.user.id} role ${parsed.roleId}:`, err.message);
    // Missing ManageRoles or insufficient role hierarchy are the common causes.
    const isPerm = /Missing Permissions|Missing required permissions|hierarch/i.test(err.message);
    return interaction.editReply({
      content: isPerm
        ? '❌ The bot lacks permission to manage that role (needs Manage Roles and a higher role in the hierarchy).'
        : '❌ Could not change your role. Please try again.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

module.exports = {
  RR_PICKER_PREFIX,
  rrPickerButtonId,
  isPickerButton,
  parsePickerCustomId,
  buildPickerMessages,
  handlePickerClick,
};
