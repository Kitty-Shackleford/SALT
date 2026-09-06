'use strict';

const { PermissionFlagsBits } = require('discord.js');
const {
  commandAuthorizationKey,
  listAuthorizedCommandServers,
} = require('./commandAuthorization');
const {
  normalizeProviderServerName,
  resolveServerDisplayName,
} = require('../../utils/serverNames');

const SERVER_OPTION_DESCRIPTION = 'Choose a server by name';
const MAX_AUTOCOMPLETE_CHOICES = 25;
const MAX_CHOICE_NAME_LENGTH = 100;

function parseCustomName(config) {
  if (!config) return null;
  try {
    const parsed = typeof config === 'string' ? JSON.parse(config) : config;
    return typeof parsed?.value === 'string' ? parsed.value : null;
  } catch (_) {
    return null;
  }
}

function platformLabel(platform) {
  const value = String(platform || 'DayZ').trim().toLowerCase();
  if (value === 'pc') return 'PC';
  if (value === 'ps' || value === 'playstation') return 'PlayStation';
  if (value === 'xbox') return 'Xbox';
  return value ? value[0].toUpperCase() + value.slice(1) : 'DayZ';
}

function truncateChoiceName(value) {
  return [...value].slice(0, MAX_CHOICE_NAME_LENGTH).join('');
}

function displayNameForServer(server) {
  const serviceId = String(server.platform_server_id);
  const customName = parseCustomName(server.custom_name_config);
  let displayName;
  try {
    displayName = resolveServerDisplayName(server.server_name, customName, serviceId);
  } catch (_) {
    displayName = normalizeProviderServerName(server.server_name, serviceId);
  }
  if (displayName === serviceId) displayName = `${platformLabel(server.platform)} server`;
  return displayName;
}

function serverChoices(servers, focusedValue = '') {
  const search = String(focusedValue || '').trim().toLocaleLowerCase();
  const seen = new Set();
  const choices = [];
  for (const server of servers) {
    const value = String(server.platform_server_id || '');
    if (!value || seen.has(value)) continue;
    const displayName = displayNameForServer(server);
    const name = truncateChoiceName(`${displayName} • ${platformLabel(server.platform)}`);
    if (search && !name.toLocaleLowerCase().includes(search) && !value.includes(search)) continue;
    seen.add(value);
    choices.push({ name, value });
    if (choices.length === MAX_AUTOCOMPLETE_CHOICES) break;
  }
  return choices;
}

function autocompleteCommandKey(interaction) {
  let subcommand = null;
  let subcommandGroup = null;
  try {
    subcommand = interaction.options.getSubcommand(false);
    subcommandGroup = interaction.options.getSubcommandGroup(false);
  } catch (_) {
    // Commands without subcommands use their top-level authorization class.
  }
  return commandAuthorizationKey(interaction.commandName, subcommand, subcommandGroup);
}

async function handleServerAutocomplete(interaction, db) {
  const focused = interaction.options.getFocused(true);
  if (focused?.name !== 'server') {
    await interaction.respond([]);
    return;
  }

  const servers = await listAuthorizedCommandServers(
    db,
    interaction.guildId,
    autocompleteCommandKey(interaction),
    {
      discordUserId: interaction.user.id,
      isDiscordAdministrator: Boolean(
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
      ),
    }
  );
  await interaction.respond(serverChoices(servers, focused.value));
}

module.exports = {
  SERVER_OPTION_DESCRIPTION,
  handleServerAutocomplete,
  serverChoices,
};
