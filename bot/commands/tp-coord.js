'use strict';

/**
 * tp-coord
 *
 * /tp-coord add name:<name> x:<x> y:<y> z:<z> map:<map> [server]
 *
 * Creates a coordinate teleport destination from raw map coordinates. Mod-only
 * (server_moderate). Coordinates are validated against the map bounds by
 * utils/teleportPolicy (via the destination service) so an out-of-bounds point
 * is rejected before it ever reaches the database.
 */

const { SlashCommandBuilder } = require('discord.js');
const db = require('../utils/dashboardDbAdapter');
const { createCoordinateDestination } = require('../../services/teleportDestinationService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('tp-coord')
    .setDescription('Create a coordinate teleport destination')
    .addSubcommand(sub => sub
      .setName('add')
      .setDescription('Add a destination defined by raw map coordinates')
      .addStringOption(option => option
        .setName('name')
        .setDescription('Destination name (1–100 chars, unique per server)')
        .setRequired(true))
      .addStringOption(option => option
        .setName('x')
        .setDescription('East coordinate')
        .setRequired(true))
      .addStringOption(option => option
        .setName('y')
        .setDescription('Elevation coordinate')
        .setRequired(true))
      .addStringOption(option => option
        .setName('z')
        .setDescription('North coordinate')
        .setRequired(true))
      .addStringOption(option => option
        .setName('map')
        .setDescription('Map the coordinates are for (e.g. chernarusplus)')
        .setRequired(true))
      .addStringOption(option => option
        .setName('server')
        .setDescription('Nitrado service ID when this Discord has multiple servers'))),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const serverId = Number(interaction.authorizedServerId);
    const name = interaction.options.getString('name', true).trim();
    const mapName = interaction.options.getString('map', true).trim().toLowerCase();
    const x = Number(interaction.options.getString('x', true));
    const y = Number(interaction.options.getString('y', true));
    const z = Number(interaction.options.getString('z', true));

    try {
      const created = await db.transaction(async transactionDb => {
        const actor = await transactionDb.get(
          'SELECT id FROM users WHERE discord_id = ?',
          [String(interaction.user.id)]
        );
        if (!actor) {
          const error = new Error('Your dashboard identity is not registered');
          error.code = 'TP_COORD_FORBIDDEN';
          throw error;
        }
        return createCoordinateDestination(transactionDb, {
          serverId,
          actorUserId: actor.id,
          name,
          mapName,
          destinationType: 'coords',
          position: [x, y, z],
          isPrivate: false,
        });
      });

      await interaction.editReply(
        `✅ Created coordinate destination **${created.name}** ` +
        `(#${created.id}) on \`${created.map_name}\` at ` +
        `${created.pos_x}, ${created.pos_y}, ${created.pos_z}.`
      );
    } catch (error) {
      const expected = typeof error.code === 'string'
        && (error.code.startsWith('TP_COORD_') || error.code.startsWith('TELEPORT_'));
      if (!expected) console.error('tp-coord command failed:', error);
      await interaction.editReply(expected ? error.message : 'Unable to create the coordinate destination.');
    }
  },
};
