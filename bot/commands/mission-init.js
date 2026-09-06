'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const db = require('../utils/dashboardDbAdapter');
const { createMissionInitStatusService } = require('../../services/missionInitStatusService');

let statusService;

function getStatusService() {
  if (!statusService) statusService = createMissionInitStatusService();
  return statusService;
}

const MAX_EMBED_FIELD_VALUE_LENGTH = 512;

function display(value, maxLength = MAX_EMBED_FIELD_VALUE_LENGTH) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return (text || 'Not recorded').slice(0, maxLength);
}

function operationSummary(operation) {
  if (!operation) return 'No durable mission-init operation recorded.';
  return display(`#${operation.id} • ${operation.action} • ${operation.status}`);
}

function buildStatusEmbed(result) {
  const capability = result.capability;
  const operation = result.latestOperation;
  const recovery = result.providerRecovery
    ? display(`Required: #${result.providerRecovery.operationId} • ${result.providerRecovery.workflow} • ${result.providerRecovery.status}`)
    : 'No unresolved provider operation';
  const observedAt = capability.observedAt ? new Date(capability.observedAt) : new Date();
  const timestamp = Number.isNaN(observedAt.getTime()) ? new Date() : observedAt;

  return new EmbedBuilder()
    .setColor(result.providerState === 'drifted' || result.providerState === 'recovery_required'
      ? 0xed4245
      : capability.status === 'supported' ? 0x57f287 : 0xfee75c)
    .setTitle('Mission Init Control Plane')
    .setDescription('Read-only evidence view. Discord upload, restore, restart, and arbitrary script execution are unavailable.')
    .addFields(
      { name: 'Capability', value: display(`${capability.status} • ${capability.platform}`) },
      { name: 'Provider state', value: display(result.providerState), inline: true },
      { name: 'Runtime evidence', value: display(result.runtimeEvidence), inline: true },
      { name: 'Live source SHA-256', value: display(result.liveSourceHash) },
      { name: 'Latest durable operation', value: operationSummary(operation) },
      { name: 'Candidate SHA-256', value: display(operation?.candidateHash) },
      { name: 'Configuration SHA-256', value: display(operation?.configurationHash) },
      { name: 'Recovery fence', value: recovery },
      {
        name: 'Desired state / approval',
        value: display(`${result.controlPlane.desiredState} / ${result.controlPlane.approval}`),
      }
    )
    .setTimestamp(timestamp);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mission-init')
    .setDescription('Review managed mission init status for an exact DayZ server')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(subcommand => subcommand
      .setName('status')
      .setDescription('Show live hash and durable mission-init evidence')
      .addStringOption(option => option
        .setName('server')
        .setDescription('Choose a server by name')
        .setRequired(true))),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.authorizedServerId) {
      return interaction.editReply('❌ Select an active server you are authorized to manage.');
    }

    let result;
    try {
      result = await getStatusService().getStatus({
        db,
        internalServerId: interaction.authorizedServerId,
        discordGuildId: interaction.guildId,
      });
    } catch (error) {
      console.error('Mission init status failed:', error.code || error.name);
      return interaction.editReply('Mission init status is currently unavailable.');
    }

    const embed = buildStatusEmbed(result);

    return interaction.editReply({ embeds: [embed] });
  },
  buildStatusEmbed,
};
