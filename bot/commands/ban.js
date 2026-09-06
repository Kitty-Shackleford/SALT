/*
 * bot/commands/ban.js
 *
 * Admin-only command to ban or unban a player by gamertag.
 * Manages ban.txt on the Nitrado file server directly.
 */

const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const {
  getServerCreds,
  getFilePaths,
  readNitradoList,
  mutateNitradoList,
} = require('../utils/nitrado');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban or unban a player on the DayZ server')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add a player to the ban list')
        .addStringOption(opt =>
          opt.setName('gamertag').setDescription('Xbox gamertag to ban').setRequired(true)
        )
        .addStringOption(opt => opt
          .setName('server')
          .setDescription('Nitrado service ID (required when this guild has multiple servers)'))
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a player from the ban list (unban)')
        .addStringOption(opt =>
          opt.setName('gamertag').setDescription('Xbox gamertag to unban').setRequired(true)
        )
        .addStringOption(opt => opt
          .setName('server')
          .setDescription('Nitrado service ID (required when this guild has multiple servers)'))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all banned players')
        .addStringOption(opt => opt
          .setName('server')
          .setDescription('Nitrado service ID (required when this guild has multiple servers)'))
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sub = interaction.options.getSubcommand();
    const gamertag = interaction.options.getString('gamertag')?.trim();
    const requestedServer = interaction.options.getString('server');

    let creds;
    try {
      creds = await getServerCreds(interaction.guild.id, requestedServer, interaction.authorizedServerId);
    } catch (err) {
      return interaction.editReply(`❌ Database error: ${err.message}`);
    }
    if (!creds) return interaction.editReply('❌ No active server found. Run `/register-token` first.');

    let ftpBase;
    try {
      ({ ftpBase } = getFilePaths(creds.gameserver));
    } catch (_) {
      return interaction.editReply('❌ Could not reach Nitrado to determine server file paths.');
    }
    const filePath = `${ftpBase}ban.txt`;

    try {
      if (sub === 'list') {
        const banned = await readNitradoList(creds.token, creds.platformServerId, filePath);
        const embed = new EmbedBuilder()
          .setTitle(`🔨 Ban List — ${creds.serverName}`)
          .setColor(0xed4245)
          .setDescription(banned.length > 0 ? banned.map((g, i) => `${i + 1}. ${g}`).join('\n') : '*No players banned.*')
          .setFooter({ text: `${banned.length} banned player(s)` })
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }

      const result = await mutateNitradoList({
        serverId: creds.serverId,
        platformServerId: creds.platformServerId,
        token: creds.token,
        dir: ftpBase,
        filename: 'ban.txt',
        listType: 'blacklist',
        action: sub,
        triggeredBy: `discord:${interaction.user.id}`,
        guildDiscordId: interaction.guild.id,
        authorizeActor: async () => {
          const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
          if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
            const error = new Error('Administrator permission was revoked before execution');
            error.code = 'SERVER_AUTHORIZATION_MISMATCH';
            throw error;
          }
        },
        mutate: banned => {
          if (sub === 'add') {
            if (banned.map(g => g.toLowerCase()).includes(gamertag.toLowerCase())) {
              return { lines: banned, result: { status: 'exists', entries: banned } };
            }
            const updated = [...banned, gamertag];
            return { lines: updated, result: { status: 'added', entries: updated } };
          }

          const lower = gamertag.toLowerCase();
          const updated = banned.filter(g => g.toLowerCase() !== lower);
          if (updated.length === banned.length) {
            return { lines: banned, result: { status: 'missing', entries: banned } };
          }
          return { lines: updated, result: { status: 'removed', entries: updated } };
        },
      });

      if (result.status === 'exists') {
        return interaction.editReply(`⚠️ **${gamertag}** is already on the ban list.`);
      }
      if (result.status === 'added') {
        return interaction.editReply(`✅ **${gamertag}** has been added to the ban list. (${result.entries.length} total)`);
      }
      if (result.status === 'missing') {
        return interaction.editReply(`⚠️ **${gamertag}** was not found on the ban list.`);
      }
      return interaction.editReply(`✅ **${gamertag}** has been removed from the ban list. (${result.entries.length} remaining)`);

    } catch (err) {
      console.error('❌ /ban error:', err);
      return interaction.editReply(`❌ Failed to update ban list: ${err.message}`);
    }
  }
};
