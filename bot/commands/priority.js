/*
 * bot/commands/priority.js
 *
 * Admin-only command to manage the server priority queue (priority.txt).
 * Priority players get queue priority when the server is full.
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
    .setName('priority')
    .setDescription('Manage the DayZ server priority queue')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Give a player priority queue access')
        .addStringOption(opt =>
          opt.setName('gamertag').setDescription('Xbox gamertag to add').setRequired(true)
        )
        .addStringOption(opt => opt
          .setName('server')
          .setDescription('Nitrado service ID (required when this guild has multiple servers)'))
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a player from the priority queue')
        .addStringOption(opt =>
          opt.setName('gamertag').setDescription('Xbox gamertag to remove').setRequired(true)
        )
        .addStringOption(opt => opt
          .setName('server')
          .setDescription('Nitrado service ID (required when this guild has multiple servers)'))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all players with queue priority')
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

    // Priority list lives in ftproot (not noftp)
    let ftpRootBase;
    try {
      ({ ftpRootBase } = getFilePaths(creds.gameserver));
    } catch (_) {
      return interaction.editReply('❌ Could not reach Nitrado to determine server file paths.');
    }
    const filePath = `${ftpRootBase}priority.txt`;

    try {
      if (sub === 'list') {
        const priority = await readNitradoList(creds.token, creds.platformServerId, filePath);
        const embed = new EmbedBuilder()
          .setTitle(`⭐ Priority Queue — ${creds.serverName}`)
          .setColor(0xfaa61a)
          .setDescription(priority.length > 0
            ? priority.map((g, i) => `${i + 1}. ${g}`).join('\n')
            : '*No players have queue priority.*'
          )
          .setFooter({ text: `${priority.length} priority player(s)` })
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }

      const result = await mutateNitradoList({
        serverId: creds.serverId,
        platformServerId: creds.platformServerId,
        token: creds.token,
        dir: ftpRootBase,
        filename: 'priority.txt',
        listType: 'priority',
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
        mutate: priority => {
          if (sub === 'add') {
            if (priority.map(g => g.toLowerCase()).includes(gamertag.toLowerCase())) {
              return { lines: priority, result: { status: 'exists', entries: priority } };
            }
            const updated = [...priority, gamertag];
            return { lines: updated, result: { status: 'added', entries: updated } };
          }
          const lower = gamertag.toLowerCase();
          const updated = priority.filter(g => g.toLowerCase() !== lower);
          if (updated.length === priority.length) {
            return { lines: priority, result: { status: 'missing', entries: priority } };
          }
          return { lines: updated, result: { status: 'removed', entries: updated } };
        },
      });

      if (result.status === 'exists') {
        return interaction.editReply(`⚠️ **${gamertag}** already has priority access.`);
      }
      if (result.status === 'added') {
        return interaction.editReply(`✅ **${gamertag}** added to the priority queue. (${result.entries.length} total)`);
      }
      if (result.status === 'missing') {
        return interaction.editReply(`⚠️ **${gamertag}** was not found in the priority queue.`);
      }
      return interaction.editReply(`✅ **${gamertag}** removed from the priority queue. (${result.entries.length} remaining)`);

    } catch (err) {
      console.error('❌ /priority error:', err);
      return interaction.editReply(`❌ Failed to update priority list: ${err.message}`);
    }
  }
};
