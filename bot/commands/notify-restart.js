/*
 * bot/commands/notify-restart.js
 *
 * /notify-restart — opt in or out of DM notifications before server restarts.
 *
 * Subcommands:
 *   /notify-restart on [minutes]
 *     Subscribe to a DM alert X minutes before each restart (default: 15).
 *
 *   /notify-restart off
 *     Unsubscribe from restart DM alerts.
 *
 *   /notify-restart status
 *     Check your current notification preference.
 */

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const pool = require('../db');

// The minimum and maximum threshold values allowed.
const MIN_MINUTES = 5;
const MAX_MINUTES = 60;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('notify-restart')
    .setDescription('Manage DM notifications before server restarts')
    .addSubcommand(sub =>
      sub
        .setName('on')
        .setDescription('Get a DM before each server restart')
        .addIntegerOption(opt =>
          opt
            .setName('minutes')
            .setDescription(`How many minutes before the restart to notify you (${MIN_MINUTES}–${MAX_MINUTES}, default 15)`)
            .setMinValue(MIN_MINUTES)
            .setMaxValue(MAX_MINUTES)
            .setRequired(false)
        )
        .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
    )
    .addSubcommand(sub =>
      sub
        .setName('off')
        .setDescription('Stop receiving restart DM notifications')
        .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
    )
    .addSubcommand(sub =>
      sub
        .setName('status')
        .setDescription('Check your current restart notification setting')
        .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sub            = interaction.options.getSubcommand();
    const guildId        = interaction.guild.id;
    const discordUserId  = interaction.user.id;
    const serverId       = interaction.authorizedServerId;
    if (!serverId) return interaction.editReply('❌ Select an active server.');

    if (sub === 'on')     return handleOn(interaction, guildId, serverId, discordUserId);
    if (sub === 'off')    return handleOff(interaction, guildId, serverId, discordUserId);
    if (sub === 'status') return handleStatus(interaction, guildId, serverId, discordUserId);
  },
};

// ─── /notify-restart on ───────────────────────────────────────────────────────

async function handleOn(interaction, guildId, serverId, discordUserId) {
  const minutes = interaction.options.getInteger('minutes') ?? 15;

  try {
    await pool.query(
      `INSERT INTO restart_notify_prefs
         (guild_id, server_id, discord_user_id, minutes_before, enabled)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (server_id, discord_user_id) DO UPDATE SET
         guild_id       = EXCLUDED.guild_id,
         minutes_before = EXCLUDED.minutes_before,
         enabled        = TRUE,
         updated_at     = NOW()`,
      [guildId, serverId, discordUserId, minutes]
    );
  } catch (err) {
    console.error('❌ /notify-restart on error:', err);
    return interaction.editReply(`❌ Failed to save preference: ${err.message}`);
  }

  return interaction.editReply(
    `✅ You'll receive a DM **${minutes} minute${minutes === 1 ? '' : 's'}** before each server restart.\n` +
    `Make sure your Discord privacy settings allow DMs from server members.\n` +
    `Run \`/notify-restart off\` to stop at any time.`
  );
}

// ─── /notify-restart off ──────────────────────────────────────────────────────

async function handleOff(interaction, guildId, serverId, discordUserId) {
  try {
    await pool.query(
      `UPDATE restart_notify_prefs
          SET enabled = FALSE, updated_at = NOW()
        WHERE guild_id = $1 AND server_id = $2 AND discord_user_id = $3`,
      [guildId, serverId, discordUserId]
    );
  } catch (err) {
    console.error('❌ /notify-restart off error:', err);
    return interaction.editReply(`❌ Failed to update preference: ${err.message}`);
  }

  return interaction.editReply('✅ You will no longer receive restart DM notifications for this server.');
}

// ─── /notify-restart status ───────────────────────────────────────────────────

async function handleStatus(interaction, guildId, serverId, discordUserId) {
  let pref;
  try {
    const res = await pool.query(
      `SELECT minutes_before, enabled, updated_at
         FROM restart_notify_prefs
        WHERE guild_id = $1 AND server_id = $2 AND discord_user_id = $3`,
      [guildId, serverId, discordUserId]
    );
    pref = res.rows[0] || null;
  } catch (err) {
    return interaction.editReply(`❌ Database error: ${err.message}`);
  }

  const embed = new EmbedBuilder()
    .setTitle('🔔 Restart Notification Preference')
    .setTimestamp();

  if (!pref || !pref.enabled) {
    embed
      .setColor(0x99aab5)
      .setDescription('You are **not** subscribed to restart notifications.\nRun `/notify-restart on` to opt in.');
  } else {
    const ts = Math.floor(new Date(pref.updated_at).getTime() / 1000);
    embed
      .setColor(0x57f287)
      .setDescription(
        `You will receive a DM **${pref.minutes_before} minute${pref.minutes_before === 1 ? '' : 's'}** before each restart.\n` +
        `*Last updated: <t:${ts}:R>*`
      );
  }

  return interaction.editReply({ embeds: [embed] });
}
