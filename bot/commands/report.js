/*
 * bot/commands/report.js
 *
 * /report — submit a player report or configure where reports are posted.
 *
 * Subcommands:
 *   /report player <gamertag> [reason] [evidence]
 *     Any server member can file a report. The report is saved to the DB and
 *     an embed is posted to the configured mod channel (if one is set up).
 *
 *   /report setup <channel>  (admin only)
 *     Set the Discord channel where new player reports will be posted.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const pool = require('../db');

// Colour used for report embeds in the mod channel.
const REPORT_COLOUR = 0xffa500;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('report')
    .setDescription('Report a player or configure report settings')
    .addSubcommand(sub =>
      sub
        .setName('player')
        .setDescription('Report a player to the server moderators')
        .addStringOption(opt =>
          opt
            .setName('gamertag')
            .setDescription('Gamertag of the player you are reporting')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('reason')
            .setDescription('Reason for the report (cheating, harassment, etc.)')
            .setRequired(false)
        )
        .addStringOption(opt =>
          opt
            .setName('evidence')
            .setDescription('Evidence URL (clip, screenshot, etc.) or short description')
            .setRequired(false)
        )
        .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
    )
    .addSubcommand(sub =>
      sub
        .setName('setup')
        .setDescription('Set the channel where player reports are posted (admin only)')
        .addChannelOption(opt =>
          opt
            .setName('channel')
            .setDescription('The mod/admin channel to receive report notifications')
            .setRequired(true)
        )
        .addStringOption(opt => opt.setName('server').setDescription('Nitrado service ID'))
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (!interaction.authorizedServerId) {
      return interaction.reply({ content: '❌ Select an active server.', flags: MessageFlags.Ephemeral });
    }

    if (sub === 'setup') return handleSetup(interaction, interaction.authorizedServerId);
    if (sub === 'player') return handleReport(interaction, interaction.authorizedServerId);
  },
};

// ─── /report setup ────────────────────────────────────────────────────────────

async function handleSetup(interaction, serverId) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return interaction.reply({
      content: '❌ You need Administrator permission to run this command.',
      flags: MessageFlags.Ephemeral,
    });
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = interaction.options.getChannel('channel');
  const guildId = interaction.guild.id;
  if (channel.guildId !== guildId) {
    return interaction.editReply('❌ The report channel must belong to this Discord server.');
  }

  try {
    // Upsert into discord_feeds using feed_type = 'mod_reports'.
    await pool.query(
      `INSERT INTO discord_feeds (guild_id, server_id, feed_type, enabled, channel_id)
       VALUES ($1, $2, 'mod_reports', 1, $3)
       ON CONFLICT (server_id, feed_type)
       DO UPDATE SET guild_id   = EXCLUDED.guild_id,
                     channel_id = EXCLUDED.channel_id,
                     enabled    = 1,
                     updated_at = NOW()`,
      [guildId, serverId, channel.id]
    );

    return interaction.editReply(
      `✅ Player reports will now be posted to ${channel}.`
    );
  } catch (err) {
    console.error('❌ /report setup error:', err);
    return interaction.editReply(`❌ Failed to save settings: ${err.message}`);
  }
}

// ─── /report player ───────────────────────────────────────────────────────────

async function handleReport(interaction, serverId) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const gamertag = interaction.options.getString('gamertag').trim();
  const reason   = interaction.options.getString('reason')?.trim() || null;
  const evidence = interaction.options.getString('evidence')?.trim() || null;
  const guildId  = interaction.guild.id;

  const reporterDiscordId   = interaction.user.id;
  const reporterDiscordName = interaction.user.username;

  // Prevent self-reports — look up whether the reporter's linked gamertag
  // matches the reported one.
  try {
    const selfCheck = await pool.query(
      `SELECT pg.gamertag
         FROM linked_accounts la
         JOIN users u               ON la.user_id = u.id
         JOIN player_identities pi  ON la.identity_id = pi.id
         JOIN server_player_memberships spm
           ON spm.identity_id = pi.id
          AND spm.server_id = $2
          AND spm.status = 'active'
         JOIN player_gamertags pg   ON pg.identity_id = pi.id
                                   AND pg.is_current_gamertag = 1
        WHERE u.discord_id = $1
        LIMIT 1`,
      [reporterDiscordId, serverId]
    );

    if (selfCheck.rows.length > 0) {
      const ownTag = selfCheck.rows[0].gamertag;
      if (ownTag.toLowerCase() === gamertag.toLowerCase()) {
        return interaction.editReply('❌ You cannot report yourself.');
      }
    }
  } catch {
    // Linked account lookup is best-effort; continue even on failure.
  }

  // Save the report to the database.
  let reportId;
  try {
    const insertRes = await pool.query(
      `INSERT INTO player_reports
         (guild_id, server_id, reporter_discord_id, reporter_discord_name, reported_gamertag, reason, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [guildId, serverId, reporterDiscordId, reporterDiscordName, gamertag, reason, evidence]
    );
    reportId = insertRes.rows[0].id;
  } catch (err) {
    console.error('❌ /report player DB insert error:', err);
    return interaction.editReply(`❌ Failed to save report: ${err.message}`);
  }

  // Post the report embed to the mod channel (if configured).
  try {
    const feedRes = await pool.query(
      `SELECT channel_id FROM discord_feeds
        WHERE guild_id = $1 AND server_id = $2 AND feed_type = 'mod_reports' AND enabled = 1`,
      [guildId, serverId]
    );

    if (feedRes.rows.length > 0 && feedRes.rows[0].channel_id) {
      const modChannel = await interaction.guild.channels.fetch(feedRes.rows[0].channel_id).catch(() => null);

      if (modChannel?.isTextBased()) {
        const embed = new EmbedBuilder()
          .setTitle('🚨 Player Report')
          .setColor(REPORT_COLOUR)
          .addFields(
            { name: '🎮 Reported Gamertag', value: gamertag,                         inline: true },
            { name: '👤 Reported By',       value: `<@${reporterDiscordId}>`,         inline: true },
            { name: '🆔 Report ID',         value: `#${reportId}`,                    inline: true },
            { name: '📋 Reason',            value: reason   || '*No reason provided*', inline: false },
            { name: '🔗 Evidence',          value: evidence || '*No evidence provided*', inline: false }
          )
          .setFooter({ text: 'Use /mod-log to review reports' })
          .setTimestamp();

        await modChannel.send({ embeds: [embed] });
      }
    }
  } catch (err) {
    // Posting to mod channel is best-effort; the report was already saved.
    console.error('❌ /report player mod-channel post error:', err);
  }

  return interaction.editReply(
    `✅ Your report against **${gamertag}** has been submitted (Report #${reportId}). Thank you.`
  );
}
