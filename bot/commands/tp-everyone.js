'use strict';

/**
 * tp-everyone
 *
 * /tp-everyone dest:<id> [server] [ttl-min]
 *
 * Mass-teleport every online player on the authorized server whose latest
 * position snapshot is fresh within ttl-min (default 10), to the given
 * destination. Players under an active PRA restriction are skipped (and
 * reported). Capped at 25 — the overflow is reported but not queued.
 *
 * Mod-only (server_moderate, matching 'teleport').
 */

const { SlashCommandBuilder } = require('discord.js');
const db = require('../utils/dashboardDbAdapter');
const {
  previewMassTeleport,
  executeMassTeleport,
} = require('../../services/teleportService');

const MASS_CAP = 25;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('tp-everyone')
    .setDescription('Teleport every fresh online player to a destination (max 25)')
    .addIntegerOption(option => option
      .setName('dest')
      .setDescription('Teleport destination ID')
      .setMinValue(1)
      .setRequired(true))
    .addStringOption(option => option
      .setName('server')
      .setDescription('Nitrado service ID when this Discord has multiple servers'))
    .addIntegerOption(option => option
      .setName('ttl-min')
      .setDescription('Only teleport players with a snapshot this fresh (minutes, default 10)')
      .setMinValue(1)
      .setMaxValue(1440)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const serverId = Number(interaction.authorizedServerId);
    const destinationId = interaction.options.getInteger('dest', true);
    const ttlMin = interaction.options.getInteger('ttl-min') ?? 10;

    try {
      const result = await db.transaction(async transactionDb => {
        const actor = await transactionDb.get(
          'SELECT id FROM users WHERE discord_id = ?',
          [String(interaction.user.id)]
        );
        if (!actor) {
          const error = new Error('Your dashboard identity is not registered');
          error.code = 'TP_ALL_FORBIDDEN';
          throw error;
        }
        const preview = await previewMassTeleport(transactionDb, {
          serverId,
          destinationId,
          actorUserId: actor.id,
          ttlMinutes: ttlMin,
          cap: MASS_CAP,
        });
        const executed = await executeMassTeleport(transactionDb, {
          serverId,
          actorUserId: actor.id,
          destinationId,
          identities: preview.preview,
          reason: 'mass teleport',
        });
        return { preview, executed };
      });

      const { preview, executed } = result;
      const lines = [
        `**Mass teleport to destination #${preview.destinationId}** (TTL ${preview.ttlMinutes} min, cap ${preview.cap})`,
        `• Fresh online players: ${preview.totalEligible}`,
        `• Skipped (active PRA restriction): ${preview.skippedPraCount}`,
        `• Queued: ${executed.queued}`,
        `• Failed: ${executed.failed}`,
      ];
      if (preview.overflowCount > 0) {
        lines.push(`• Overflow beyond cap (not queued): ${preview.overflowCount}`);
      }
      await interaction.editReply(lines.join('\n'));
    } catch (error) {
      const expected = typeof error.code === 'string'
        && (error.code.startsWith('TP_ALL_') || error.code.startsWith('TELEPORT_'));
      if (!expected) console.error('tp-everyone command failed:', error);
      await interaction.editReply(expected ? error.message : 'Unable to run the mass teleport.');
    }
  },
};
