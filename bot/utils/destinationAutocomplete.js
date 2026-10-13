'use strict';

/**
 * destinationAutocomplete.js
 *
 * Autocomplete for the /teleport `destination` option. The option is a string
 * so Discord can show searchable suggestions; the value is the destination
 * ID. This helper lists the active destinations for the actor's authorized
 * server only (IDOR guard: a destination from another guild/server never
 * appears) and caps the response at Discord's 25-choice limit.
 */

const { PermissionFlagsBits } = require('discord.js');
const {
  commandAuthorizationKey,
  listAuthorizedCommandServers,
  selectAuthorizedServer,
} = require('./commandAuthorization');
const { listTeleportDestinations } = require('../../services/teleportDestinationService');

const MAX_AUTOCOMPLETE_CHOICES = 25;
const MAX_CHOICE_NAME_LENGTH = 100;

function truncateChoiceName(value) {
  return [...value].slice(0, MAX_CHOICE_NAME_LENGTH).join('');
}

function destinationChoices(destinations, focusedValue = '') {
  const search = String(focusedValue || '').trim().toLocaleLowerCase();
  const choices = [];
  for (const destination of destinations) {
    const value = String(destination.id);
    const name = `${destination.name} (${destination.map_name}) — ${destination.destination_type}`;
    if (search && !name.toLocaleLowerCase().includes(search) && !value.includes(search)) continue;
    choices.push({ name: truncateChoiceName(name), value });
    if (choices.length >= MAX_AUTOCOMPLETE_CHOICES) break;
  }
  return choices;
}

async function handleDestinationAutocomplete(interaction, db) {
  const focused = interaction.options.getFocused(true);
  if (focused?.name !== 'destination') {
    return false; // Not a destination autocomplete — let the caller handle it.
  }
  let requestedServerId = null;
  try {
    requestedServerId = interaction.options.getString('server');
  } catch {
    // No server selector on this command.
  }
  const servers = await listAuthorizedCommandServers(
    db,
    interaction.guildId,
    commandAuthorizationKey('teleport'),
    {
      discordUserId: interaction.user.id,
      isDiscordAdministrator: Boolean(
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
      ),
    }
  );
  const server = selectAuthorizedServer(servers, requestedServerId);
  if (!server) {
    await interaction.respond([]);
    return true;
  }
  const destinations = await listTeleportDestinations(db, {
    serverId: server.server_id,
    guildId: server.guild_id,
    activeOnly: true,
  });
  await interaction.respond(destinationChoices(destinations, focused.value));
  return true;
}

module.exports = {
  MAX_AUTOCOMPLETE_CHOICES,
  destinationChoices,
  handleDestinationAutocomplete,
};
