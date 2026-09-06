const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const pool = require('../db');
const { getLinkSettings, mutateBotLinkSettings } = require('../utils/linkSettings');
const { fetchCurrentGuildMember } = require('../utils/currentDiscordMember');

const ROLE_ACTIONS = {
  assign_on_join: 'assignOnJoin',
  assign_on_link: 'assignOnLink',
  remove_on_link: 'removeOnLink',
  remove_on_leave: 'removeOnLeave',
};

function addRoleActionOption(subcommand) {
  return subcommand.addStringOption(option => option
    .setName('action')
    .setDescription('Lifecycle action')
    .setRequired(true)
    .addChoices(
      { name: 'Assign when member joins Discord', value: 'assign_on_join' },
      { name: 'Assign when player links', value: 'assign_on_link' },
      { name: 'Remove when player links', value: 'remove_on_link' },
      { name: 'Remove when player unlinks/leaves linked state', value: 'remove_on_leave' }
    ));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('link-settings')
    .setDescription('Configure player linking for an exact DayZ server')
    .addSubcommand(subcommand => subcommand
      .setName('verification')
      .setDescription('Choose how new gamertag links are verified')
      .addStringOption(option => option
        .setName('mode')
        .setDescription('Verification required for new links')
        .setRequired(true)
        .addChoices(
          { name: 'Admin/mod approval (highest)', value: 'admin_approval' },
          { name: 'In-game emote verification', value: 'emote' },
          { name: 'Open self-link (one Discord owner per identity)', value: 'open' }
        ))
      .addStringOption(option => option
        .setName('server')
        .setDescription('Nitrado service ID (required when this guild has multiple servers)')))
    .addSubcommand(subcommand => addRoleActionOption(subcommand
      .setName('role-add')
      .setDescription('Add a Discord role lifecycle rule')
      .addRoleOption(option => option
        .setName('role')
        .setDescription('Role managed by this rule')
        .setRequired(true)))
      .addStringOption(option => option
        .setName('server')
        .setDescription('Nitrado service ID (required when this guild has multiple servers)')))
    .addSubcommand(subcommand => addRoleActionOption(subcommand
      .setName('role-remove')
      .setDescription('Remove a Discord role lifecycle rule')
      .addRoleOption(option => option
        .setName('role')
        .setDescription('Role removed from this rule')
        .setRequired(true)))
      .addStringOption(option => option
        .setName('server')
        .setDescription('Nitrado service ID (required when this guild has multiple servers)')))
    .addSubcommand(subcommand => subcommand
      .setName('status')
      .setDescription('Show player-link settings for an exact server')
      .addStringOption(option => option
        .setName('server')
        .setDescription('Nitrado service ID (required when this guild has multiple servers)'))),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const serverId = interaction.authorizedServerId;
    if (!serverId) {
      return interaction.editReply('❌ Select an active server you are authorized to manage.');
    }

    try {
      const subcommand = interaction.options.getSubcommand();
      const mutationContext = change => mutateBotLinkSettings(pool, {
        serverId,
        discordGuildId: interaction.guild.id,
        actor: {
          discordId: interaction.user.id,
          username: interaction.user.username,
          avatar: interaction.user.avatar,
        },
        resolveNativePermissions: async () => {
          const currentMember = await fetchCurrentGuildMember(interaction.guild, interaction.user.id);
          return {
            administrator: currentMember.permissions.has(PermissionFlagsBits.Administrator),
            manageRoles: currentMember.permissions.has(PermissionFlagsBits.ManageRoles),
          };
        },
        change,
      });
      if (subcommand === 'verification') {
        const mode = interaction.options.getString('mode', true);
        await mutationContext({ type: 'verification', mode });
        return interaction.editReply(
          `✅ New gamertag verification mode is now **${mode.replaceAll('_', ' ')}** for the selected server.`
        );
      }

      if (subcommand === 'role-add' || subcommand === 'role-remove') {
        const role = interaction.options.getRole('role', true);
        if (role.id === interaction.guild.id || role.managed || role.editable === false) {
          return interaction.editReply('❌ That role cannot be managed by this bot.');
        }
        const action = interaction.options.getString('action', true);
        const roleKey = ROLE_ACTIONS[action];
        if (!roleKey) return interaction.editReply('❌ Unsupported role lifecycle action.');

        await mutationContext({
          type: 'role',
          operation: subcommand === 'role-add' ? 'add' : 'remove',
          roleKey,
          roleId: role.id,
        });
        return interaction.editReply(
          `✅ ${subcommand === 'role-add' ? 'Added' : 'Removed'} ${role} ` +
          `for **${action.replaceAll('_', ' ')}** on the selected server.`
        );
      }

      const settings = await getLinkSettings(pool, serverId);
      const roleSummary = Object.entries(ROLE_ACTIONS)
        .map(([label, key]) => {
          const mentions = settings.roles[key].map(id => `<@&${id}>`).join(', ') || 'none';
          return `• ${label.replaceAll('_', ' ')}: ${mentions}`;
        })
        .join('\n');
      return interaction.editReply(
        `Player-link settings for the selected server:\n` +
        `• Verification mode: **${settings.verificationMode.replaceAll('_', ' ')}**\n` +
        roleSummary
      );
    } catch (error) {
      console.error('❌ /link-settings error:', error);
      if (['AUTHORITY_REVOKED', 'DISCORD_PERMISSION_REVOKED', 'MEMBER_LEFT'].includes(error.code)) {
        return interaction.editReply('❌ Your current permissions no longer allow this settings change.');
      }
      return interaction.editReply('❌ Unable to update player-link settings right now.');
    }
  },
};
