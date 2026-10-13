/*
 * bot/commands/warn.js
 *
 * /warn <member> <action> [reason] [duration] — tiered moderation,
 * identity-linked so it follows the player across alts.
 *
 * Actions: warn (log only) | timeout (timed silence) | mute | kick
 * Requires Discord Moderator/Administrator.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} = require('discord.js');
const { moderateMember } = require('../services/warnService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Moderate a member (warn / timeout / mute / kick) — identity-linked')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false)
    .addUserOption(opt => opt.setName('member').setDescription('Member to moderate').setRequired(true))
    .addStringOption(opt =>
      opt.setName('action')
         .setDescription('Moderation action')
         .setRequired(true)
         .addChoices(
           { name: 'Warn', value: 'warn' },
           { name: 'Timeout', value: 'timeout' },
           { name: 'Mute', value: 'mute' },
           { name: 'Kick', value: 'kick' },
         ))
    .addStringOption(opt => opt.setName('reason').setDescription('Reason (stored on the case)'))
    .addIntegerOption(opt =>
      opt.setName('duration')
         .setDescription('Timeout/mute duration in minutes (default 10)')
         .setMinValue(1).setMaxValue(10080)),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = await interaction.options.getUser('member', true);
    const action = interaction.options.getString('action');
    const reason = interaction.options.getString('reason') || '';
    const duration = interaction.options.getInteger('duration');

    if (member.id === interaction.client.user.id) {
      return interaction.editReply('❌ You cannot moderate the bot.');
    }
    if (member.id === interaction.user.id) {
      return interaction.editReply('❌ You cannot moderate yourself.');
    }
    // Don't let a mod act on someone with equal-or-higher mod power.
    try {
      const full = await interaction.guild.members.fetch(member.id);
      if (full.permissions.has(PermissionFlagsBits.ModerateMembers) &&
          !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.editReply('❌ You cannot moderate a member with equal or higher moderation power.');
      }
    } catch { /* member not cached; proceed */ }

    const result = await moderateMember({
      member: await interaction.guild.members.fetch(member.id),
      action,
      reason,
      durationMinutes: duration,
      actorDiscordId: interaction.user.id,
      serverId: interaction.authorizedServerId ?? null,
    });

    const idLine = result.identities.length
      ? result.identities.map(i => `**${i.gamertag}** (${i.platform})`).join(', ')
      : '*no linked in-game account — warning stored to Discord ID only*';

    const embed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle(`⚠️ ${action.toUpperCase()} — ${member.displayName}`)
      .addFields(
        { name: 'In-game identity', value: idLine, inline: false },
        { name: 'Action taken', value: result.detail, inline: true },
        { name: 'Open warnings (player)', value: String(result.openWarnings), inline: true },
        { name: 'Reason', value: reason || '—', inline: false },
      )
      .setFooter({ text: `Recorded by ${interaction.user.tag} • case #${result.recorded?.id}` })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};
