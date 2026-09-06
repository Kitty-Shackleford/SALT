'use strict';

const pool = require('../db');
const {
  configuredDashboardOwnerId,
} = require('../../utils/configuredDashboardOwner');
const {
  reconcileConfiguredDashboardOwner,
} = require('../../services/dashboardOwnerBootstrapService');

async function bootstrapConfiguredDashboardOwner(
  guild,
  db = pool,
  configuredDiscordId
) {
  const discordId = configuredDashboardOwnerId(configuredDiscordId);
  if (!discordId) return { status: 'not_configured' };

  let member;
  try {
    member = await guild.members.fetch({ user: discordId, force: true, cache: false });
  } catch (_error) {
    return { status: 'not_member' };
  }
  if (!member?.user || String(member.user.id) !== discordId) return { status: 'not_member' };

  return reconcileConfiguredDashboardOwner(db, {
    discordId,
    username: member.user.username,
    avatar: member.user.avatar || null,
  }, {
    configuredDiscordId,
    source: 'discord_guild_membership',
    guildDiscordId: guild.id,
  });
}

module.exports = {
  bootstrapConfiguredDashboardOwner,
  configuredOwnerDiscordId: configuredDashboardOwnerId,
};
