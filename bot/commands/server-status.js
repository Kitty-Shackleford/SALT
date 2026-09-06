const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const pool = require('../db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('server-status')
    .setDescription('Check the status of your registered Nitrado servers')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guild.id;

    try {
      // Get guild database ID first
      const guildRes = await pool.query(
        'SELECT id FROM guilds WHERE discord_guild_id = $1',
        [guildId]
      );
      const guild = guildRes.rows[0];

      if (!guild) {
        return interaction.editReply({
          content: '❌ This Discord server has not been registered yet.\n\n' +
                   'Use `/register-token` to register your Nitrado API token.'
        });
      }

      // Get guild's servers
      const serversRes = await pool.query(`
        SELECT
          s.name as server_name,
          s.platform_server_id as nitrado_server_id,
          s.created_at,
          COUNT(DISTINCT la.id) as player_count
        FROM servers s
        LEFT JOIN player_server_activity psa ON psa.server_id = s.id
        LEFT JOIN player_identities pi ON pi.id = psa.identity_id
        LEFT JOIN linked_accounts la ON la.identity_id = pi.id
        WHERE s.guild_id = $1
        GROUP BY s.id, s.name, s.platform_server_id, s.created_at
      `, [guild.id]);
      const servers = serversRes.rows;

      if (servers.length === 0) {
        return interaction.editReply({
          content: '❌ No servers registered for this Discord server.\n\n' +
                   'Use `/register-token` to register your Nitrado API token.'
        });
      }

      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle('🖥️ Server Status')
        .setDescription(`**${servers.length}** registered server(s)`)
        .setTimestamp();

      servers.forEach((server, index) => {
        embed.addFields({
          name: `${index + 1}. ${server.server_name}`,
          value: `**Nitrado ID:** ${server.nitrado_server_id}\n` +
                 `**Linked Players:** ${server.player_count}\n` +
                 `**Registered:** ${new Date(server.created_at).toLocaleDateString()}`,
          inline: false
        });
      });

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('❌ Error fetching server status:', error);
      await interaction.editReply({
        content: `❌ **Error:** ${error.message}`
      });
    }
  }
};
