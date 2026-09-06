'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('radar-audit')
    .setDescription('Show trusted radar and jammer provenance for a managed DayZ server')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(option => option
      .setName('server')
      .setDescription('Nitrado service ID when this guild has multiple servers')),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const serverId = interaction.authorizedServerId;
    if (!serverId) {
      return interaction.editReply('❌ Select an active server you are authorized to manage.');
    }

    const pool = require('../db');
    const serverResult = await pool.query(
      `SELECT s.id, s.name
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
       WHERE s.id = $1 AND g.discord_guild_id = $2 AND s.status = 'active'
       LIMIT 1`,
      [serverId, interaction.guildId]
    );
    const server = serverResult.rows[0];
    if (!server) return interaction.editReply('❌ The selected active server is unavailable.');

    const [activationResult, eventResult] = await Promise.all([
      pool.query(
        `SELECT status, COUNT(*)::int AS count
         FROM radar_activations
         WHERE server_id = $1
         GROUP BY status
         ORDER BY status`,
        [server.id]
      ),
      pool.query(
        `SELECT source_type, action, display_name, pos_x, pos_y, bucket_start
         FROM radar_synthetic_events
         WHERE server_id = $1
         ORDER BY bucket_start DESC, id DESC
         LIMIT 10`,
        [server.id]
      ),
    ]);

    const activationSummary = activationResult.rows.length
      ? activationResult.rows.map(row => `${row.status}: ${row.count}`).join(' • ')
      : 'No capability activations';
    const eventSummary = eventResult.rows.length
      ? eventResult.rows.map(row =>
        `**${row.source_type || 'jammer'} · ${row.action}** — ${row.display_name} ` +
        `(${Number(row.pos_x).toFixed(1)}, ${Number(row.pos_y).toFixed(1)}) · ` +
        `<t:${Math.floor(new Date(row.bucket_start).getTime() / 1000)}:R>`
      ).join('\n')
      : 'No persisted jammer-generated activity.';

    const embed = new EmbedBuilder()
      .setColor(0x22d3ee)
      .setTitle(`📡 Trusted Radar Audit — ${server.name}`)
      .setDescription('Jammer-generated records are explicitly identified here and remain separate from authoritative DayZ logs.')
      .addFields(
        { name: 'Capability provenance', value: activationSummary },
        { name: 'Recent synthetic activity', value: eventSummary }
      )
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};
