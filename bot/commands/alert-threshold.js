/*
 * bot/commands/alert-threshold.js
 *
 * /alert-threshold — ping a role or user when the server reaches a player count.
 *
 * Fires once when the count crosses the threshold from below.  Resets after
 * the server drops below the threshold again so it can fire on the next surge.
 *
 * Subcommands (all admin-only):
 *   /alert-threshold add <count> <mention> <channel>
 *     Create a new threshold alert.
 *
 *   /alert-threshold remove <id>
 *     Delete an alert by its ID (shown in /alert-threshold list).
 *
 *   /alert-threshold list
 *     Show all configured alerts for this server.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const pool = require('../db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('alert-threshold')
    .setDescription('Ping a role or user when the server reaches a player count (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('Create a new player count alert')
        .addIntegerOption(opt =>
          opt
            .setName('count')
            .setDescription('Player count that triggers the alert')
            .setMinValue(1)
            .setRequired(true)
        )
        .addMentionableOption(opt =>
          opt
            .setName('mention')
            .setDescription('Role or user to ping when the threshold is reached')
            .setRequired(true)
        )
        .addChannelOption(opt =>
          opt
            .setName('channel')
            .setDescription('Channel to post the alert in')
            .setRequired(true)
        )
        .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Remove an alert by ID')
        .addIntegerOption(opt =>
          opt
            .setName('id')
            .setDescription('Alert ID (from /alert-threshold list)')
            .setRequired(true)
        )
        .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
    )
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('Show all configured player count alerts')
        .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sub = interaction.options.getSubcommand();
    const serverId = interaction.authorizedServerId;
    if (!serverId) return interaction.editReply('❌ Select an active server you are authorized to manage.');
    if (sub === 'add')    return handleAdd(interaction, serverId);
    if (sub === 'remove') return handleRemove(interaction, serverId);
    if (sub === 'list')   return handleList(interaction, serverId);
  },
};

// ─── /alert-threshold add ─────────────────────────────────────────────────────

async function handleAdd(interaction, serverId) {
  const count     = interaction.options.getInteger('count');
  const mentionable = interaction.options.getMentionable('mention');
  const channel   = interaction.options.getChannel('channel');
  const guildId   = interaction.guild.id;

  if (channel.guildId !== guildId || (mentionable.guild && mentionable.guild.id !== guildId)) {
    return interaction.editReply('❌ The channel and mention target must belong to this Discord server.');
  }

  // Determine whether it's a Role or User mention.
  const mentionType   = mentionable.constructor.name === 'Role' ? 'role' : 'user';
  const mentionTarget = mentionable.id;

  try {
    const res = await pool.query(
      `INSERT INTO player_count_alerts
         (guild_id, server_id, threshold, channel_id, mention_target, mention_type, created_by_discord_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [guildId, serverId, count, channel.id, mentionTarget, mentionType, interaction.user.id]
    );

    const id = res.rows[0].id;
    return interaction.editReply(
      `✅ Alert **#${id}** created — I'll ping ${mentionable} in ${channel} when **${count}+ players** are online.`
    );
  } catch (err) {
    console.error('❌ /alert-threshold add error:', err);
    return interaction.editReply(`❌ Failed to create alert: ${err.message}`);
  }
}

// ─── /alert-threshold remove ──────────────────────────────────────────────────

async function handleRemove(interaction, serverId) {
  const id      = interaction.options.getInteger('id');
  const guildId = interaction.guild.id;

  try {
    const res = await pool.query(
      `DELETE FROM player_count_alerts
        WHERE id = $1 AND guild_id = $2 AND server_id = $3
       RETURNING id`,
      [id, guildId, serverId]
    );

    if (res.rows.length === 0) {
      return interaction.editReply(`⚠️ No alert with ID **#${id}** found for this server.`);
    }
    return interaction.editReply(`✅ Alert **#${id}** removed.`);
  } catch (err) {
    console.error('❌ /alert-threshold remove error:', err);
    return interaction.editReply(`❌ Failed to remove alert: ${err.message}`);
  }
}

// ─── /alert-threshold list ────────────────────────────────────────────────────

async function handleList(interaction, serverId) {
  const guildId = interaction.guild.id;

  let alerts;
  try {
    const res = await pool.query(
      `SELECT id, threshold, channel_id, mention_target, mention_type, enabled
         FROM player_count_alerts
        WHERE guild_id = $1 AND server_id = $2
        ORDER BY threshold ASC, id ASC`,
      [guildId, serverId]
    );
    alerts = res.rows;
  } catch (err) {
    return interaction.editReply(`❌ Database error: ${err.message}`);
  }

  const embed = new EmbedBuilder()
    .setTitle('🔔 Player Count Alerts')
    .setColor(0x5865f2)
    .setTimestamp();

  if (alerts.length === 0) {
    embed.setDescription('*No alerts configured.*\nUse `/alert-threshold add` to create one.');
    return interaction.editReply({ embeds: [embed] });
  }

  const lines = alerts.map(a => {
    const mention  = a.mention_type === 'role' ? `<@&${a.mention_target}>` : `<@${a.mention_target}>`;
    const status   = a.enabled ? '✅' : '⏸️';
    return `${status} **#${a.id}** — **${a.threshold}+ players** → ${mention} in <#${a.channel_id}>`;
  });

  embed.setDescription(lines.join('\n'));
  return interaction.editReply({ embeds: [embed] });
}
