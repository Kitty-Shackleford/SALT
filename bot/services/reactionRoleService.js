'use strict';

/**
 * reactionRoleService.js
 *
 * Assigns/removes a Discord role when a member reacts (or un-reacts) with an
 * emoji bound in the `reaction_roles` table.
 *
 * Called from bot/events/messageReactionAdd.js and
 * bot/events/messageReactionRemove.js, which forward the v14 event signature
 * (reaction, user).
 *
 * Bindings are cached in memory for 30s to avoid a DB hit per reaction.
 */

const pool = require('../db');

const cache = new Map();      // message_id -> [{ emoji, role_id }]
const cacheExpiry = new Map(); // message_id -> timestamp

function normalizeEmoji(input) {
  const raw = String(input || '');
  const m = raw.match(/^<a?:([a-z0-9_]+):\d+>$/i);
  return m ? m[1] : raw;
}

async function getBindingsForMessage(messageId) {
  const now = Date.now();
  const cached = cache.get(String(messageId));
  if (cached && cacheExpiry.get(String(messageId)) > now) return cached;

  const r = await pool.query(
    `SELECT emoji, role_id FROM reaction_roles WHERE message_id = $1`,
    [String(messageId)]
  );
  const rows = r.rows;
  cache.set(String(messageId), rows);
  cacheExpiry.set(String(messageId), now + 30000);

  if (cache.size > 500) {
    for (const [key, exp] of cacheExpiry) {
      if (exp < now) { cache.delete(key); cacheExpiry.delete(key); }
    }
  }
  return rows;
}

/**
 * Handle a reaction (added or removed) with respect to reaction roles.
 *
 * @param {import('discord.js').Reaction} reaction
 * @param {import('discord.js').User} user
 * @param {boolean} assign true to add the role, false to remove it
 */
async function handleReaction(reaction, user, assign) {
  if (user.bot) return;
  if (!reaction.inGuild?.()) return;
  const guild = reaction.message?.guild;
  if (!guild) return;

  const emojiName = reaction.emoji?.name;
  if (!emojiName) return;

  let bindings;
  try {
    bindings = await getBindingsForMessage(reaction.message.id);
  } catch (err) {
    console.warn(`⚠️ [reaction-roles] binding lookup failed: ${err.message}`);
    return;
  }

  const matches = bindings.filter(b => normalizeEmoji(b.emoji) === normalizeEmoji(emojiName));
  if (!matches.length) return;

  for (const binding of matches) {
    try {
      const member = await guild.members.fetch(user.id);
      const hasRole = member.roles.cache.has(binding.role_id);
      if (assign && !hasRole) {
        await member.roles.add(binding.role_id, `reaction role (${normalizeEmoji(emojiName)})`);
      } else if (!assign && hasRole) {
        await member.roles.remove(binding.role_id, `reaction role removed (${normalizeEmoji(emojiName)})`);
      }
    } catch (err) {
      console.warn(
        `⚠️ [reaction-roles] ${assign ? 'assign' : 'remove'} failed for member ${user.id} role ${binding.role_id}: ${err.message}`
      );
    }
  }
}

module.exports = { handleReaction, normalizeEmoji };
