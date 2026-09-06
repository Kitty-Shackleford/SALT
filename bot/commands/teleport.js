'use strict';

const { SlashCommandBuilder } = require('discord.js');
const db = require('../utils/dashboardDbAdapter');
const { requestModeratorTeleport } = require('../../services/teleportService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('teleport')
    .setDescription('Queue a player teleport for their next login or restart')
    .addStringOption(option => option
      .setName('player')
      .setDescription('Exact linked gamertag')
      .setRequired(true))
    .addIntegerOption(option => option
      .setName('destination')
      .setDescription('Teleport destination ID')
      .setMinValue(1)
      .setRequired(true))
    .addBooleanOption(option => option
      .setName('override-pra')
      .setDescription('Explicitly override an active PRA restriction'))
    .addStringOption(option => option
      .setName('server')
      .setDescription('Nitrado service ID when this Discord has multiple servers')),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const serverId = Number(interaction.authorizedServerId);
    const playerName = interaction.options.getString('player', true).trim();
    const destinationId = interaction.options.getInteger('destination', true);
    const overridePra = interaction.options.getBoolean('override-pra') === true;

    try {
      const request = await db.transaction(async transactionDb => {
        const actor = await transactionDb.get(
          'SELECT id FROM users WHERE discord_id = ?',
          [String(interaction.user.id)]
        );
        if (!actor) {
          const error = new Error('Your dashboard identity is not registered');
          error.code = 'TELEPORT_FORBIDDEN';
          throw error;
        }

        const targets = await transactionDb.query(
          `SELECT DISTINCT pi.id AS identity_id
           FROM player_identities pi
           JOIN server_player_memberships spm
             ON spm.identity_id = pi.id
            AND spm.server_id = ?
            AND spm.status = 'active'
           JOIN player_gamertags pg
             ON pg.identity_id = pi.id
            AND pg.server_id = spm.server_id
            AND pg.is_current_gamertag = 1
           WHERE LOWER(pg.gamertag) = LOWER(?)
           ORDER BY pi.id`,
          [serverId, playerName]
        );
        if (targets.length !== 1) {
          const ambiguous = targets.length > 1;
          const error = new Error(ambiguous
            ? 'More than one active linked player has that gamertag on this server'
            : 'No active linked player with that exact gamertag exists on this server');
          error.code = ambiguous ? 'TELEPORT_PLAYER_AMBIGUOUS' : 'TELEPORT_PLAYER_NOT_FOUND';
          throw error;
        }
        const target = targets[0];

        return requestModeratorTeleport(transactionDb, {
          serverId,
          identityId: target.identity_id,
          destinationId,
          actorUserId: actor.id,
          source: 'admin',
          overridePra,
        });
      });

      await interaction.editReply(
        `Teleport request #${request.id} queued. It will run after a qualifying disconnect and login/restart.`
      );
    } catch (error) {
      const expected = typeof error.code === 'string' && error.code.startsWith('TELEPORT_');
      if (!expected) console.error('Teleport command failed:', error);
      await interaction.editReply(expected ? error.message : 'Unable to queue the teleport request.');
    }
  },
};
