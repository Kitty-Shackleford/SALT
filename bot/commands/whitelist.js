/*
 * bot/commands/whitelist.js
 *
 * Admin-only command to manage the server whitelist (whitelist.txt).
 * Supports adding, removing, and listing whitelisted players.
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
    .setName('whitelist')
    .setDescription('Manage the DayZ server whitelist')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Add a player to the whitelist')
        .addStringOption(opt =>
          opt.setName('gamertag').setDescription('Xbox gamertag to whitelist').setRequired(true)
        )
        .addStringOption(opt => opt
          .setName('server')
          .setDescription('Nitrado service ID (required when this guild has multiple servers)'))
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a player from the whitelist')
        .addStringOption(opt =>
          opt.setName('gamertag').setDescription('Xbox gamertag to remove').setRequired(true)
        )
        .addStringOption(opt => opt
          .setName('server')
          .setDescription('Nitrado service ID (required when this guild has multiple servers)'))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Show all whitelisted players')
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
    const filePath = `${ftpBase}whitelist.txt`;

    try {
      if (sub === 'list') {
        const whitelist = await readNitradoList(creds.token, creds.platformServerId, filePath);
        const embed = new EmbedBuilder()
          .setTitle(`✅ Whitelist — ${creds.serverName}`)
          .setColor(0x57f287)
          .setDescription(whitelist.length > 0
            ? whitelist.map((g, i) => `${i + 1}. ${g}`).join('\n')
            : '*Whitelist is empty — all players can join (if whitelist is enabled).*'
          )
          .setFooter({ text: `${whitelist.length} whitelisted player(s)` })
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }

      const result = await mutateNitradoList({
        serverId: creds.serverId,
        platformServerId: creds.platformServerId,
        token: creds.token,
        dir: ftpBase,
        filename: 'whitelist.txt',
        listType: 'whitelist',
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
        mutate: whitelist => {
          if (sub === 'add') {
            if (whitelist.map(g => g.toLowerCase()).includes(gamertag.toLowerCase())) {
              return { lines: whitelist, result: { status: 'exists', entries: whitelist } };
            }
            const updated = [...whitelist, gamertag];
            return { lines: updated, result: { status: 'added', entries: updated } };
          }
          const lower = gamertag.toLowerCase();
          const updated = whitelist.filter(g => g.toLowerCase() !== lower);
          if (updated.length === whitelist.length) {
            return { lines: whitelist, result: { status: 'missing', entries: whitelist } };
          }
          return { lines: updated, result: { status: 'removed', entries: updated } };
        },
      });

      if (result.status === 'exists') {
        return interaction.editReply(`⚠️ **${gamertag}** is already on the whitelist.`);
      }
      if (result.status === 'added') {
        return interaction.editReply(`✅ **${gamertag}** added to the whitelist. (${result.entries.length} total)`);
      }
      if (result.status === 'missing') {
        return interaction.editReply(`⚠️ **${gamertag}** was not found on the whitelist.`);
      }
      return interaction.editReply(`✅ **${gamertag}** removed from the whitelist. (${result.entries.length} remaining)`);

    } catch (err) {
      console.error('❌ /whitelist error:', err);
      return interaction.editReply(`❌ Failed to update whitelist: ${err.message}`);
    }
  }
};
