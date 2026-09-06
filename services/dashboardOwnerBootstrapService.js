'use strict';

const {
  configuredDashboardOwnerId,
  isConfiguredDashboardOwner,
} = require('../utils/configuredDashboardOwner');

const TRUSTED_IDENTITY_SOURCES = new Set(['discord_oauth', 'discord_guild_membership']);

async function reconcileConfiguredDashboardOwner(db, identity, options = {}) {
  const configuredDiscordId = configuredDashboardOwnerId(options.configuredDiscordId);
  if (!configuredDiscordId) return { status: 'not_configured' };
  if (!isConfiguredDashboardOwner(identity?.discordId, configuredDiscordId)) {
    return { status: 'not_configured_owner' };
  }

  const source = String(options.source || '');
  if (!TRUSTED_IDENTITY_SOURCES.has(source)) {
    throw new Error('Configured Dashboard Owner requires a trusted Discord identity source');
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('dashboard_owner'))");

    const ownerResult = await client.query(
      `SELECT id, discord_id
         FROM users
        WHERE platform_role = 'dashboard_owner'
        FOR UPDATE`
    );
    if (ownerResult.rows.length > 0 && String(ownerResult.rows[0].discord_id) !== configuredDiscordId) {
      await client.query('ROLLBACK');
      return { status: 'owner_conflict' };
    }

    const alreadyOwner = ownerResult.rows.length === 1;
    const userResult = await client.query(
      `INSERT INTO users (discord_id, username, avatar, is_admin)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (discord_id) DO UPDATE SET
         username = EXCLUDED.username,
         avatar = EXCLUDED.avatar
       RETURNING id`,
      [configuredDiscordId, identity.username || 'Dashboard Owner', identity.avatar || null]
    );
    const userId = userResult.rows[0].id;

    await client.query(
      `UPDATE users SET platform_role = 'dashboard_owner', is_admin = 1
        WHERE id = $1`,
      [userId]
    );
    if (!alreadyOwner) {
      await client.query(
        `INSERT INTO security_audit_events
           (actor_user_id, action, result, target_type, target_id, metadata)
         VALUES (NULL, 'platform_role.bootstrap_env', 'allowed', 'user', $1,
                 jsonb_build_object('guildDiscordId', $2::text, 'source', $3::text))`,
        [String(userId), options.guildDiscordId ? String(options.guildDiscordId) : null, source]
      );
    }
    await client.query('COMMIT');
    return { status: alreadyOwner ? 'existing' : 'assigned', userId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  reconcileConfiguredDashboardOwner,
  TRUSTED_IDENTITY_SOURCES,
};
