/*
 * bot/commands/ticket.js
 *
 * /ticket — button-based support tickets.
 *
 * Subcommands (admin for setup, moderator for close):
 *   /ticket setup channel <channel>   — post the ticket-panel message (with an
 *                                       Open Ticket button) in the channel.
 *   /ticket close [reason]            — close the ticket thread in THIS channel
 *                                       (archives the transcript to the DB).
 *   /ticket list                       — list recent tickets for this server.
 *
 * Opening a ticket is triggered by the Open Ticket button (handled in
 * bot/events/ticketButton.js), which calls ticketService.openTicket.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
} = require('discord.js');
const { closeTicket, listTicketsForGuild } = require('../services/ticketService');

const OPEN_BUTTON_ID = 'ticket_open';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Support tickets (button-based)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false)
    .addSubcommand(sub =>
      sub.setName('setup')
         .setDescription('Post the ticket panel in a channel (admin)')
         .addChannelOption(opt => opt.setName('channel').setDescription('Channel for the ticket panel').setRequired(true).addChannelTypes(0)))
    .addSubcommand(sub =>
      sub.setName('close')
         .setDescription('Close the ticket in this channel (archives transcript)')
         .addStringOption(opt => opt.setName('reason').setDescription('Reason for closing')))
    .addSubcommand(sub =>
      sub.setName('list').setDescription('List recent tickets for this server')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'setup') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: '❌ Only admins can post a ticket panel.', flags: MessageFlags.Ephemeral });
      }
      const channel = interaction.options.getChannel('channel');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(OPEN_BUTTON_ID)
          .setLabel('Open Ticket')
          .setEmoji('🎫')
          .setStyle(4) // Success
      );
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🎫 Support Tickets')
        .setDescription('Click **Open Ticket** below to create a private thread with staff.');
      await channel.send({ embeds: [embed], components: [row] });
      return interaction.reply({ content: `✅ Ticket panel posted to ${channel}.`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'close') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      // Only works inside a ticket thread.
      const isThread = interaction.channel?.isThread?.();
      if (!isThread) return interaction.editReply('❌ Run `/ticket close` inside a ticket thread.');
      const reason = interaction.options.getString('reason');
      const result = await closeTicket({ thread: interaction.channel, closedBy: interaction.user, reason });
      return interaction.editReply(`✅ Ticket closed. ${result.messageCount} messages archived.`);
    }

    // list
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const tickets = await listTicketsForGuild(interaction.guild.id);
    if (!tickets.length) return interaction.editReply('No tickets yet for this server.');
    const lines = tickets.slice(0, 15).map(t => {
      const when = new Date(t.created_at);
      const status = t.closed_at ? '✅' : '🔴';
      return `${status} **${t.subject || t.opened_by_username}** — ${when.toISOString().slice(0, 10)} · ${t.message_count} msg · ${t.opened_by_username}`;
    });
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🎫 Recent tickets')
      .setDescription(lines.join('\n'));
    return interaction.editReply({ embeds: [embed] });
  },
};
