/*
 * bot/commands/wipe-info.js
 *
 * /wipe-info — display or update server wipe dates.
 *
 * Subcommands:
 *   /wipe-info show
 *     Anyone — shows the last wipe date, next scheduled wipe, and notes.
 *
 *   /wipe-info set last <date> [notes]     (admin only)
 *     Record when the most recent wipe happened.
 *
 *   /wipe-info set next <date> [notes]     (admin only)
 *     Announce when the next wipe is scheduled.
 *
 *   /wipe-info clear next                  (admin only)
 *     Remove the next-wipe date once a wipe has occurred.
 *
 * Date input format: YYYY-MM-DD  (e.g. 2025-06-01)
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const pool = require('../db');
const { getServerCreds } = require('../utils/nitrado');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('wipe-info')
    .setDescription('Show or update server wipe dates')
    .addSubcommand(sub =>
      sub
        .setName('show')
        .setDescription('Show the last and next wipe dates')
        .addStringOption(opt =>
          opt.setName('server').setDescription('Server ID').setRequired(false)
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName('set')
        .setDescription('Set wipe dates (admin only)')
        .addSubcommand(sub =>
          sub
            .setName('last')
            .setDescription('Record when the most recent wipe happened')
            .addStringOption(opt =>
              opt
                .setName('date')
                .setDescription('Wipe date in YYYY-MM-DD format (e.g. 2025-06-01)')
                .setRequired(true)
            )
            .addStringOption(opt =>
              opt
                .setName('notes')
                .setDescription('Optional notes, e.g. "Full wipe" or "Map wipe only"')
                .setRequired(false)
            )
            .addStringOption(opt =>
              opt.setName('server').setDescription('Server ID').setRequired(false)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('next')
            .setDescription('Set the next scheduled wipe date')
            .addStringOption(opt =>
              opt
                .setName('date')
                .setDescription('Wipe date in YYYY-MM-DD format (e.g. 2025-07-01)')
                .setRequired(true)
            )
            .addStringOption(opt =>
              opt
                .setName('notes')
                .setDescription('Optional notes about the upcoming wipe')
                .setRequired(false)
            )
            .addStringOption(opt =>
              opt.setName('server').setDescription('Server ID').setRequired(false)
            )
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('clear')
        .setDescription('Clear the next wipe date after a wipe occurs (admin only)')
        .addStringOption(opt =>
          opt.setName('server').setDescription('Server ID').setRequired(false)
        )
    ),

  async execute(interaction) {
    const sub   = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup(false);
    const requestedServer = interaction.options.getString('server');

    // Admin-only subcommands.
    if (group === 'set' || sub === 'clear') {
      if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
          content: '❌ You need Administrator permission to update wipe dates.',
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Resolve the guild's active server.
    let serverDbId, serverName;
    try {
      const creds = await getServerCreds(interaction.guild.id, requestedServer, interaction.authorizedServerId);
      if (!creds) {
        return interaction.editReply('❌ No active server found. Run `/register-token` first.');
      }
      serverDbId = creds.serverId;
      serverName = creds.serverName;
    } catch (err) {
      return interaction.editReply(`❌ Database error: ${err.message}`);
    }

    if (sub === 'show')  return handleShow(interaction, serverDbId, serverName);
    if (sub === 'clear') return handleClear(interaction, serverDbId);
    if (group === 'set') return handleSet(interaction, sub, serverDbId);
  },
};

// ─── /wipe-info show ──────────────────────────────────────────────────────────

async function handleShow(interaction, serverDbId, serverName) {
  const res = await pool.query(
    `SELECT last_wipe_at, next_wipe_at, notes, updated_at, updated_by_discord_name
       FROM server_wipe_info
      WHERE server_id = $1`,
    [serverDbId]
  );

  const info = res.rows[0];

  const embed = new EmbedBuilder()
    .setTitle(`🗓️ Wipe Info — ${serverName}`)
    .setColor(0x5865f2)
    .setTimestamp();

  if (!info || (!info.last_wipe_at && !info.next_wipe_at)) {
    embed.setDescription('*No wipe dates have been set yet.*\nAdmins can use `/wipe-info set last` and `/wipe-info set next` to add them.');
    return interaction.editReply({ embeds: [embed] });
  }

  if (info.last_wipe_at) {
    const ts = Math.floor(new Date(info.last_wipe_at).getTime() / 1000);
    embed.addFields({
      name:   '🔁 Last Wipe',
      value:  `<t:${ts}:D>  (<t:${ts}:R>)`,
      inline: false,
    });
  }

  if (info.next_wipe_at) {
    const ts  = Math.floor(new Date(info.next_wipe_at).getTime() / 1000);
    const now = Date.now();
    const future = new Date(info.next_wipe_at).getTime() > now;
    embed.addFields({
      name:   future ? '⏳ Next Wipe' : '🔁 Wipe Occurred',
      value:  `<t:${ts}:D>  (<t:${ts}:R>)`,
      inline: false,
    });
  }

  if (info.notes) {
    embed.addFields({ name: '📋 Notes', value: info.notes, inline: false });
  }

  if (info.updated_by_discord_name) {
    embed.setFooter({ text: `Last updated by ${info.updated_by_discord_name}` });
  }

  return interaction.editReply({ embeds: [embed] });
}

// ─── /wipe-info set last | next ───────────────────────────────────────────────

async function handleSet(interaction, field, serverDbId) {
  const dateStr = interaction.options.getString('date').trim();
  const notes   = interaction.options.getString('notes')?.trim() || null;

  // Validate date format.
  const parsed = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return interaction.editReply('❌ Invalid date format. Use **YYYY-MM-DD** (e.g. `2025-06-01`).');
  }

  const column = field === 'last' ? 'last_wipe_at' : 'next_wipe_at';

  try {
    await pool.query(
      `INSERT INTO server_wipe_info
         (server_id, ${column}, notes, updated_at, updated_by_discord_id, updated_by_discord_name)
       VALUES ($1, $2, $3, NOW(), $4, $5)
       ON CONFLICT (server_id) DO UPDATE SET
         ${column}                 = EXCLUDED.${column},
         notes                     = COALESCE($3, server_wipe_info.notes),
         updated_at                = NOW(),
         updated_by_discord_id     = EXCLUDED.updated_by_discord_id,
         updated_by_discord_name   = EXCLUDED.updated_by_discord_name`,
      [serverDbId, parsed, notes, interaction.user.id, interaction.user.username]
    );
  } catch (err) {
    console.error('❌ /wipe-info set error:', err);
    return interaction.editReply(`❌ Failed to save: ${err.message}`);
  }

  const label = field === 'last' ? 'Last wipe' : 'Next wipe';
  const ts    = Math.floor(parsed.getTime() / 1000);
  return interaction.editReply(
    `✅ ${label} set to <t:${ts}:D>${notes ? `\n📋 Notes: ${notes}` : ''}`
  );
}

// ─── /wipe-info clear ─────────────────────────────────────────────────────────

async function handleClear(interaction, serverDbId) {
  try {
    await pool.query(
      `UPDATE server_wipe_info
          SET next_wipe_at              = NULL,
              updated_at                = NOW(),
              updated_by_discord_id     = $2,
              updated_by_discord_name   = $3
        WHERE server_id = $1`,
      [serverDbId, interaction.user.id, interaction.user.username]
    );
  } catch (err) {
    console.error('❌ /wipe-info clear error:', err);
    return interaction.editReply(`❌ Failed to clear: ${err.message}`);
  }

  return interaction.editReply('✅ Next wipe date cleared.');
}
