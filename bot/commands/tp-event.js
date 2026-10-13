'use strict';

/**
 * tp-event
 *
 * /tp-event create name:<name> dest:<id> duration-min:<min> [cap] [server]
 * /tp-event close [name] [server]
 *
 * Creates a sign-up event teleport: an embed with Join/Leave buttons is posted
 * in the current channel; players with a verified link to a player on the
 * server can join (capped) and leave. When the event closes (early by a mod,
 * or by the expiry monitor) every still-joined identity is queued for
 * teleport to the destination.
 *
 * Mod-only (server_moderate, matching 'teleport').
 */

const { SlashCommandBuilder } = require('discord.js');
const db = require('../utils/dashboardDbAdapter');
const {
  createSignUpEvent,
  fetchEventForUpdate,
  closeEventAndQueueTeleports,
  listActiveEvents,
} = require('../../services/teleportEventService');
const { buildSignUpCard } = require('../utils/interactionButtons');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('tp-event')
    .setDescription('Sign-up event teleports (join by button, all teleported on close)')
    .addSubcommand(sub => sub
      .setName('create')
      .setDescription('Create a sign-up event and post it in this channel')
      .addStringOption(option => option
        .setName('name')
        .setDescription('Event name (1–100 chars)')
        .setRequired(true))
      .addIntegerOption(option => option
        .setName('dest')
        .setDescription('Teleport destination ID')
        .setMinValue(1)
        .setRequired(true))
      .addIntegerOption(option => option
        .setName('duration-min')
        .setDescription('Minutes until the event auto-closes and teleports')
        .setMinValue(1)
        .setRequired(true))
      .addIntegerOption(option => option
        .setName('cap')
        .setDescription('Maximum players (default 25, max 500)')
        .setMinValue(1)
        .setMaxValue(500))
      .addStringOption(option => option
        .setName('server')
        .setDescription('Nitrado service ID when this Discord has multiple servers')))
    .addSubcommand(sub => sub
      .setName('close')
      .setDescription('Close an active event now and queue its teleports')
      .addStringOption(option => option
        .setName('name')
        .setDescription('Event name (defaults to the most recent active event on the server)'))
      .addStringOption(option => option
        .setName('server')
        .setDescription('Nitrado service ID when this Discord has multiple servers'))),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'create') return executeCreate(interaction);
    if (subcommand === 'close') return executeClose(interaction);
    await interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
  },
};

async function actorFromDb(transactionDb, interaction) {
  const actor = await transactionDb.get(
    'SELECT id FROM users WHERE discord_id = ?',
    [String(interaction.user.id)]
  );
  if (!actor) {
    const error = new Error('Your dashboard identity is not registered');
    error.code = 'TP_EVENT_FORBIDDEN';
    throw error;
  }
  return actor.id;
}

async function executeCreate(interaction) {
  await interaction.deferReply({ ephemeral: false });
  const serverId = Number(interaction.authorizedServerId);
  const eventName = interaction.options.getString('name', true).trim();
  const destinationId = interaction.options.getInteger('dest', true);
  const durationMin = interaction.options.getInteger('duration-min', true);
  const cap = interaction.options.getInteger('cap') ?? 25;

  try {
    const event = await db.transaction(async transactionDb => {
      const actorUserId = await actorFromDb(transactionDb, interaction);
      const guildRow = await transactionDb.get(
        'SELECT guild_id FROM servers WHERE id = ?',
        [serverId]
      );
      if (!guildRow) {
        const error = new Error('Server is unavailable');
        error.code = 'TP_EVENT_SERVER_UNAVAILABLE';
        throw error;
      }
      return createSignUpEvent(transactionDb, {
        guildId: guildRow.guild_id,
        serverId,
        destinationId,
        durationMinutes: durationMin,
        cap,
        eventName,
        channelId: interaction.channel.id,
        actorUserId,
      });
    });

    await interaction.editReply(buildSignUpCard(event, 0));
  } catch (error) {
    const expected = typeof error.code === 'string'
      && (error.code.startsWith('TP_EVENT_') || error.code.startsWith('TELEPORT_'));
    if (!expected) console.error('tp-event create failed:', error);
    await interaction.editReply(expected ? error.message : 'Unable to create the event.');
  }
}

async function executeClose(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const serverId = Number(interaction.authorizedServerId);
  const name = interaction.options.getString('name');

  try {
    const summary = await db.transaction(async transactionDb => {
      const actorUserId = await actorFromDb(transactionDb, interaction);
      const guildRow = await transactionDb.get(
        'SELECT guild_id FROM servers WHERE id = ?',
        [serverId]
      );
      if (!guildRow) {
        const error = new Error('Server is unavailable');
        error.code = 'TP_EVENT_SERVER_UNAVAILABLE';
        throw error;
      }
      const guildId = guildRow.guild_id;
      let eventId = null;
      if (name) {
        const rows = await transactionDb.query(
          `SELECT id FROM event_teleport_signups
           WHERE server_id = ? AND guild_id = ? AND status = 'active'
             AND lower(event_name) = lower(?)
           ORDER BY id DESC LIMIT 1`,
          [serverId, guildId, name.trim()]
        );
        if (rows.length) eventId = rows[0].id;
      } else {
        const active = await listActiveEvents(transactionDb, { serverId, guildId });
        if (active.length) eventId = active[active.length - 1].id;
      }
      if (!eventId) {
        const error = new Error(name
          ? `No active event named "${name}" on this server`
          : 'No active sign-up event on this server');
        error.code = 'TP_EVENT_NOT_FOUND';
        throw error;
      }
      const locked = await fetchEventForUpdate(transactionDb, {
        serverId, guildId, eventId,
      });
      if (!locked) {
        const error = new Error('Teleport event is unavailable');
        error.code = 'TP_EVENT_NOT_FOUND';
        throw error;
      }
      return closeEventAndQueueTeleports(transactionDb, {
        serverId,
        guildId,
        eventId: locked.id,
        actorUserId,
        finalStatus: 'closed',
      });
    });

    const lines = [
      `✅ Closed **${summary.event.event_name}**.`,
      `• Queued: ${summary.queued.length}`,
      `• Skipped/failed: ${summary.failed.length}`,
    ];
    if (summary.failed.length) {
      lines.push(`   (${summary.failed.map(f => `id ${f.identityId}: ${f.reason}`).join('; ')})`);
    }
    await interaction.editReply(lines.join('\n'));
  } catch (error) {
    const expected = typeof error.code === 'string'
      && (error.code.startsWith('TP_EVENT_') || error.code.startsWith('TELEPORT_'));
    if (!expected) console.error('tp-event close failed:', error);
    await interaction.editReply(expected ? error.message : 'Unable to close the event.');
  }
}
