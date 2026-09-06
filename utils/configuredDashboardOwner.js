'use strict';

const DASHBOARD_OWNER_ENV = 'DASHBOARD_OWNER_DISCORD_ID';
const DISCORD_ID_PATTERN = /^\d{17,19}$/;

function configuredDashboardOwnerId(value = process.env[DASHBOARD_OWNER_ENV]) {
  const discordId = String(value || '').trim();
  return DISCORD_ID_PATTERN.test(discordId) ? discordId : null;
}

function isConfiguredDashboardOwner(discordId, configuredValue = process.env[DASHBOARD_OWNER_ENV]) {
  const configuredId = configuredDashboardOwnerId(configuredValue);
  return Boolean(configuredId && String(discordId || '').trim() === configuredId);
}

module.exports = {
  DASHBOARD_OWNER_ENV,
  DISCORD_ID_PATTERN,
  configuredDashboardOwnerId,
  isConfiguredDashboardOwner,
};
