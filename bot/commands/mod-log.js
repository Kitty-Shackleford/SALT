/*
 * bot/commands/mod-log.js
 *
 * /mod-log — Admin tool for reviewing and actioning player reports.
 *
 * Reports are created by players via /report.  This command lets moderators
 * list, inspect, close, and reopen those reports without leaving Discord.
 *
 * All subcommands require Administrator permission.
 *
 * Subcommands:
 *   /mod-log list [status] [page]
 *     Paginated list of reports.  Filter by status: open (default) | closed | all.
 *
 *   /mod-log view <id>
 *     Full detail view of a single report including resolution info.
 *
 *   /mod-log close <id> [note]
 *     Mark a report as closed.  Optional note explains the action taken.
 *
 *   /mod-log reopen <id>
 *     Reopen a previously closed report.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const pool = require('../db');

const PAGE_SIZE = 10;

// Status badge displayed in list view.
const STATUS_BADGE = { open: '🔴 Open', closed: '✅ Closed' };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mod-log')
    .setDescription('Review and action player reports (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('List player reports')
        .addStringOption(opt =>
          opt
            .setName('status')
            .setDescription('Filter by report status (default: open)')
            .addChoices(
              { name: 'Open',   value: 'open'   },
              { name: 'Closed', value: 'closed' },
              { name: 'All',    value: 'all'    },
            )
        )
        .addIntegerOption(opt =>
          opt
            .setName('page')
            .setDescription(`Page number (${PAGE_SIZE} per page, default: 1)`)
            .setMinValue(1)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('view')
        .setDescription('View full details of a specific report')
        .addIntegerOption(opt =>
          opt
            .setName('id')
            .setDescription('Report ID (from /mod-log list)')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('close')
        .setDescription('Close/resolve a report')
        .addIntegerOption(opt =>
          opt
            .setName('id')
            .setDescription('Report ID to close')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('note')
            .setDescription('Action taken or reason for closing (optional)')
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('reopen')
        .setDescription('Reopen a previously closed report')
        .addIntegerOption(opt =>
          opt
            .setName('id')
            .setDescription('Report ID to reopen')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!interaction.authorizedServerId) {
      return interaction.editReply('❌ Select an active server you are authorized to manage.');
    }

    const sub = interaction.options.getSubcommand();
    if (sub === 'list')   return handleList(interaction);
    if (sub === 'view')   return handleView(interaction);
    if (sub === 'close')  return handleClose(interaction);
    if (sub === 'reopen') return handleReopen(interaction);
  },
};

// ─── /mod-log list ────────────────────────────────────────────────────────────

async function handleList(interaction) {
  const guildId    = interaction.guild.id;
  const serverId   = interaction.authorizedServerId;
  const statusFilter = interaction.options.getString('status') ?? 'open';
  const page       = interaction.options.getInteger('page') ?? 1;

  // Build WHERE clause.
  const conditions = ['guild_id = $1', 'server_id = $2'];
  const params     = [guildId, serverId];
  if (statusFilter !== 'all') {
    conditions.push(`status = $${params.length + 1}`);
    params.push(statusFilter);
  }
  const where = conditions.join(' AND ');

  let reports, total;
  try {
    const countRes = await pool.query(
      `SELECT COUNT(*) AS cnt FROM player_reports WHERE ${where}`,
      params
    );
    total = parseInt(countRes.rows[0].cnt, 10);

    const offset = (page - 1) * PAGE_SIZE;
    const listParams = [...params, PAGE_SIZE, offset];
    const listRes = await pool.query(
      `SELECT id, reported_gamertag, reporter_discord_id, reason, status, created_at
         FROM player_reports
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );
    reports = listRes.rows;
  } catch (err) {
    return interaction.editReply(`❌ Database error: ${err.message}`);
  }

  const maxPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, maxPages);

  const filterLabel = statusFilter === 'all' ? 'All' : statusFilter === 'open' ? 'Open' : 'Closed';

  const embed = new EmbedBuilder()
    .setTitle(`📋 Mod Log — ${filterLabel} Reports`)
    .setColor(statusFilter === 'closed' ? 0x57f287 : 0xffa500)
    .setFooter({ text: `${total} report${total !== 1 ? 's' : ''} · Page ${safePage}/${maxPages}` })
    .setTimestamp();

  if (total === 0) {
    embed.setDescription(`*No ${statusFilter === 'all' ? '' : statusFilter + ' '}reports found.*`);
    return interaction.editReply({ embeds: [embed] });
  }

  const lines = reports.map(r => {
    const badge = STATUS_BADGE[r.status] ?? r.status;
    const ts    = Math.floor(new Date(r.created_at).getTime() / 1000);
    const reason = r.reason ? ` — ${r.reason.slice(0, 50)}${r.reason.length > 50 ? '…' : ''}` : '';
    return `**#${r.id}** ${badge} · **${r.reported_gamertag}** · <@${r.reporter_discord_id}> · <t:${ts}:R>${reason}`;
  });

  embed.setDescription(lines.join('\n'));

  if (safePage < maxPages) {
    embed.addFields({
      name: '\u200b',
      value: `*Use \`/mod-log list page:${safePage + 1}\` for next page.*`,
    });
  }

  return interaction.editReply({ embeds: [embed] });
}

// ─── /mod-log view ────────────────────────────────────────────────────────────

async function handleView(interaction) {
  const id       = interaction.options.getInteger('id');
  const guildId  = interaction.guild.id;
  const serverId = interaction.authorizedServerId;

  let report;
  try {
    const res = await pool.query(
      `SELECT * FROM player_reports WHERE id = $1 AND guild_id = $2 AND server_id = $3`,
      [id, guildId, serverId]
    );
    report = res.rows[0];
  } catch (err) {
    return interaction.editReply(`❌ Database error: ${err.message}`);
  }

  if (!report) {
    return interaction.editReply(`⚠️ Report **#${id}** not found.`);
  }

  const badge  = STATUS_BADGE[report.status] ?? report.status;
  const ts     = Math.floor(new Date(report.created_at).getTime() / 1000);

  const embed = new EmbedBuilder()
    .setTitle(`📋 Report #${report.id} — ${report.reported_gamertag}`)
    .setColor(report.status === 'closed' ? 0x57f287 : 0xffa500)
    .addFields(
      { name: '🎮 Reported Gamertag', value: report.reported_gamertag,                 inline: true  },
      { name: '📊 Status',            value: badge,                                     inline: true  },
      { name: '👤 Reported By',       value: `<@${report.reporter_discord_id}> (${report.reporter_discord_name})`, inline: false },
      { name: '📋 Reason',            value: report.reason   || '*Not provided*',       inline: false },
      { name: '🔗 Evidence',          value: report.evidence || '*Not provided*',       inline: false },
      { name: '🕐 Submitted',         value: `<t:${ts}:F>`,                             inline: true  },
    )
    .setTimestamp();

  // Show resolution details if the report has been closed.
  if (report.status === 'closed' && report.resolved_at) {
    const resTimes = Math.floor(new Date(report.resolved_at).getTime() / 1000);
    embed.addFields(
      { name: '✅ Closed By',   value: `<@${report.resolved_by_discord_id}> (${report.resolved_by_discord_name})`, inline: true  },
      { name: '🕐 Closed At',   value: `<t:${resTimes}:F>`,                                                        inline: true  },
      { name: '📝 Resolution',  value: report.resolution_note || '*No note left*',                                  inline: false },
    );
  }

  return interaction.editReply({ embeds: [embed] });
}

// ─── /mod-log close ───────────────────────────────────────────────────────────

async function handleClose(interaction) {
  const id       = interaction.options.getInteger('id');
  const note     = interaction.options.getString('note')?.trim() || null;
  const guildId  = interaction.guild.id;
  const serverId = interaction.authorizedServerId;

  let res;
  try {
    res = await pool.query(
      `UPDATE player_reports
          SET status                   = 'closed',
              resolved_by_discord_id   = $1,
              resolved_by_discord_name = $2,
              resolution_note          = $3,
              resolved_at              = NOW()
        WHERE id = $4 AND guild_id = $5 AND server_id = $6
       RETURNING id, status`,
      [interaction.user.id, interaction.user.username, note, id, guildId, serverId]
    );
  } catch (err) {
    return interaction.editReply(`❌ Database error: ${err.message}`);
  }

  if (res.rows.length === 0) {
    return interaction.editReply(`⚠️ Report **#${id}** not found.`);
  }

  return interaction.editReply(
    `✅ Report **#${id}** has been closed.${note ? `\n📝 Note: *${note}*` : ''}`
  );
}

// ─── /mod-log reopen ──────────────────────────────────────────────────────────

async function handleReopen(interaction) {
  const id       = interaction.options.getInteger('id');
  const guildId  = interaction.guild.id;
  const serverId = interaction.authorizedServerId;

  let res;
  try {
    res = await pool.query(
      `UPDATE player_reports
          SET status                   = 'open',
              resolved_by_discord_id   = NULL,
              resolved_by_discord_name = NULL,
              resolution_note          = NULL,
              resolved_at              = NULL
        WHERE id = $1 AND guild_id = $2 AND server_id = $3
       RETURNING id`,
      [id, guildId, serverId]
    );
  } catch (err) {
    return interaction.editReply(`❌ Database error: ${err.message}`);
  }

  if (res.rows.length === 0) {
    return interaction.editReply(`⚠️ Report **#${id}** not found.`);
  }

  return interaction.editReply(`✅ Report **#${id}** has been reopened.`);
}
