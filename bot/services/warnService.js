'use strict';

/**
 * warnService.js
 *
 * Tiered, identity-linked moderation for Discord members.
 *
 * A Discord member is resolved to their linked in-game identity (via
 * linked_accounts + server_player_memberships) so warnings follow the PLAYER,
 * not just the Discord account — this is what catches alts.
 *
 * The ladder:
 *   warn     — log only (level increments)
 *   timeout  — timed silence (member.timeout)
 *   mute     — mute role if configured, else long timeout fallback
 *   kick     — remove from guild
 *
 * Every action is recorded in `mod_actions` (see migration 094) with the
 * resolved identity_id, so `/cases` can group warnings by player across
 * every Discord account they use.
 */

const pool = require('../db');

// Ladder ordering (escalation). `warn` is the base.
const ACTION_LEVELS = { warn: 1, timeout: 2, mute: 3, kick: 4 };

/**
 * Resolve a Discord member to their linked in-game identities for this guild.
 *
 * @returns {Promise<Array<{identity_id, gamertag, platform}>>}
 */
async function resolveIdentities(discordGuildId, discordUserId, database = pool) {
  const r = await database.query(
    `SELECT DISTINCT ON (pi.id)
       pi.id        AS identity_id,
       pg.gamertag,
       pi.platform
     FROM guilds g
     JOIN users u              ON u.discord_id = $2
     JOIN linked_accounts la   ON la.user_id = u.id
     JOIN player_identities pi ON la.identity_id = pi.id
     JOIN server_player_memberships spm
            ON spm.source_link_id = la.id
           AND spm.user_id = la.user_id
           AND spm.identity_id = la.identity_id
           AND spm.guild_id = g.id
           AND spm.status = 'active'
     JOIN player_gamertags pg  ON pi.id = pg.identity_id
                              AND pg.server_id = spm.server_id
                              AND pg.is_current_gamertag = 1
     WHERE g.discord_guild_id = $1
       AND la.verification_method IN ('emote_challenge','admin_approved','self_asserted')
     ORDER BY pi.id, pg.last_seen DESC NULLS LAST`,
    [String(discordGuildId), String(discordUserId)]
  );
  return r.rows;
}

/**
 * Count unresolved warnings on the identity (or 0). Used to show escalation.
 */
async function countOpenWarnings(identityId, database = pool) {
  if (!identityId) return 0;
  const r = await database.query(
    `SELECT COUNT(*)::int AS n FROM mod_actions
     WHERE identity_id = $1 AND action = 'warn' AND resolved_at IS NULL`,
    [identityId]
  );
  return r.rows[0]?.n || 0;
}

/**
 * Record a mod action (does NOT perform the Discord side effect — callers do
 * that first, then call this to persist).
 */
async function recordAction(ctx, database = pool) {
  const {
    guildDiscordId,
    serverId = null,
    identityId = null,
    targetDiscordId,
    action,
    reason = '',
    actorUserId = null,
    actorDiscordId = null,
  } = ctx;

  const level = ACTION_LEVELS[action] || 1;
  const r = await database.query(
    `INSERT INTO mod_actions
       (guild_id, server_id, identity_id, target_discord_id,
        action, level, reason, acted_by_user_id, acted_by_discord_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, level`,
    [
      await guildDbId(guildDiscordId, database),
      serverId,
      identityId,
      targetDiscordId,
      action,
      level,
      String(reason || '').slice(0, 1000),
      actorUserId,
      actorDiscordId,
    ]
  );
  return r.rows[0];
}

async function guildDbId(discordGuildId, database) {
  const r = await database.query('SELECT id FROM guilds WHERE discord_guild_id = $1 LIMIT 1', [String(discordGuildId)]);
  return r.rows[0]?.id ?? null;
}

/**
 * Perform a Discord member moderation action, then record it.
 *
 * @returns {Promise<{recorded, detail, openWarnings, identities}>}
 */
async function moderateMember({ member, action, reason, durationMinutes, actorUserId, actorDiscordId, serverId = null, database = pool }) {
  const identities = await resolveIdentities(member.guild.id, member.id, database);
  const primaryIdentity = identities[0]?.identity_id ?? null;

  // --- Discord side effect ---
  let detail = '';
  switch (action) {
    case 'warn':
      detail = 'recorded (no in-chat action)';
      break;
    case 'timeout': {
      const dur = Math.max(1, durationMinutes || 10) * 60000;
      await member.timeout(dur, reason || `timed out by moderation (${actorDiscordId})`);
      detail = `timed out ${Math.round(dur / 60000)}m`;
      break;
    }
    case 'mute': {
      // Prefer a configured mute role if one is bound to this guild.
      const role = await getMuteRole(member.guild.id, database);
      if (role) {
        await member.roles.add(role, reason || 'mute (mod action)');
        detail = `muted via role ${role}`;
      } else {
        // Fallback: 24h timeout (Discord "mute" is effectively a timed silence).
        await member.timeout(24 * 3600 * 1000, reason || 'muted (mod action)');
        detail = 'muted via 24h timeout (no mute role configured)';
      }
      break;
    }
    case 'kick':
      await member.kick(reason || 'kicked by moderation');
      detail = 'kicked from guild';
      break;
    default:
      throw new Error(`Unsupported mod action: ${action}`);
  }

  const recorded = await recordAction({
    guildDiscordId: member.guild.id,
    serverId,
    identityId: primaryIdentity,
    targetDiscordId: member.id,
    action,
    reason,
    actorUserId,
    actorDiscordId,
  }, database);

  const openWarnings = await countOpenWarnings(primaryIdentity, database);
  return { recorded, detail, openWarnings, identities };
}

/**
 * Read the configured mute role id for a guild (guild_features feature
 * name `mute_role`, config { role_id }). Returns null when unset.
 */
async function getMuteRole(discordGuildId, database = pool) {
  try {
    const r = await database.query(
      `SELECT gf.config FROM guilds g
       JOIN guild_features gf ON gf.guild_id = g.id
       WHERE g.discord_guild_id = $1 AND gf.feature_name = 'mute_role'
         AND gf.enabled = 1 LIMIT 1`,
      [String(discordGuildId)]
    );
    const cfg = r.rows[0]?.config;
    const parsed = typeof cfg === 'string' ? JSON.parse(cfg || '{}') : (cfg || {});
    return parsed.role_id ? String(parsed.role_id) : null;
  } catch {
    return null;
  }
}

module.exports = {
  ACTION_LEVELS,
  resolveIdentities,
  countOpenWarnings,
  recordAction,
  moderateMember,
  getMuteRole,
};
