'use strict';

const { PermissionFlagsBits } = require('discord.js');
const pool = require('../db');

async function setIssue(guildId, issueType, details) {
  await pool.query(
    `INSERT INTO guild_ownership_reconciliation (guild_id, issue_code, details, status, detected_at, resolved_at)
     VALUES ($1, $2, $3::jsonb, 'open', NOW(), NULL)
     ON CONFLICT (guild_id) DO UPDATE SET
       issue_code = EXCLUDED.issue_code,
       details = EXCLUDED.details,
       status = 'open',
       detected_at = NOW(),
       resolved_at = NULL,
       resolved_by_user_id = NULL`,
    [guildId, issueType, JSON.stringify(details)]
  );
}

async function clearIssue(guildId) {
  await pool.query(
    `UPDATE guild_ownership_reconciliation
        SET status = 'resolved', resolved_at = NOW(), resolved_by_user_id = NULL
      WHERE guild_id = $1 AND resolved_at IS NULL`,
    [guildId]
  );
}

async function reconcileGuildOwnership(client) {
  const result = await pool.query(
    `SELECT g.id, g.discord_guild_id, g.name,
            COUNT(gr.id) FILTER (WHERE gr.role = 'owner')::integer AS owner_count,
            MIN(u.discord_id) FILTER (WHERE gr.role = 'owner') AS owner_discord_id
       FROM guilds g
       LEFT JOIN guild_roles gr ON gr.guild_id = g.id
       LEFT JOIN users u ON u.id = gr.user_id
      WHERE g.status <> 'disabled'
      GROUP BY g.id, g.discord_guild_id, g.name`
  );

  for (const row of result.rows) {
    if (row.owner_count === 0) {
      await setIssue(row.id, 'missing_owner', { guildName: row.name });
      continue;
    }
    if (row.owner_count > 1) {
      await setIssue(row.id, 'multiple_owners', { ownerCount: row.owner_count });
      continue;
    }

    const discordGuild = client.guilds.cache.get(String(row.discord_guild_id));
    if (!discordGuild) {
      await setIssue(row.id, 'bot_not_installed', {});
      continue;
    }

    let member;
    try {
      member = await discordGuild.members.fetch(String(row.owner_discord_id));
    } catch (_) {
      await setIssue(row.id, 'owner_not_in_discord', { ownerDiscordId: row.owner_discord_id });
      continue;
    }

    const eligible = discordGuild.ownerId === member.id || member.permissions.has(PermissionFlagsBits.Administrator);
    if (!eligible) {
      await setIssue(row.id, 'owner_missing_discord_permission', { ownerDiscordId: row.owner_discord_id });
      continue;
    }

    await clearIssue(row.id);
  }
}

function startGuildOwnershipReconciliation(client, intervalMs = 6 * 60 * 60 * 1000) {
  const run = () => reconcileGuildOwnership(client).catch(error => {
    console.error('[ownership-reconciliation] failed:', error.message);
  });
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = { reconcileGuildOwnership, startGuildOwnershipReconciliation };
