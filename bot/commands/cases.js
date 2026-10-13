/*
 * bot/commands/cases.js
 *
 * /cases — review moderation cases from `mod_actions`. Because actions are
 * identity-linked, a player's warnings show here across all their Discord
 * accounts (this is the anti-alt surface).
 *
 * Subcommands (moderator+):
 *   /cases view <gamertag|member>
 *   /cases resolve <case_id>     — mark a warn-level action resolved
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} = require('discord.js');
const pool = require('../db');

async function serverId(interaction) {
  if (interaction.authorizedServerId) return interaction.authorizedServerId;
  const r = await pool.query(
    `SELECT s.id FROM servers s JOIN guilds g ON s.guild_id = g.id
     WHERE g.discord_guild_id = $1 AND s.status = 'active' ORDER BY s.id LIMIT 1`,
    [interaction.guild.id]
  );
  return r.rows[0]?.id ?? null;
}

async function identityFor(playerOpt, memberId, serverId) {
  if (memberId) {
    const r = await pool.query(
      `SELECT spm.identity_id FROM linked_accounts la
       JOIN users u ON u.id = la.user_id
       JOIN server_player_memberships spm
         ON spm.source_link_id = la.id AND spm.user_id = la.user_id
         AND spm.server_id = $2 AND spm.status = 'active'
       WHERE u.discord_id = $1 LIMIT 1`,
      [memberId, serverId]
    );
    if (r.rows[0]) return { identityId: r.rows[0].identity_id, label: memberId };
  }
  if (playerOpt) {
    const r = await pool.query(
      `SELECT pi.id, pg.gamertag FROM player_gamertags pg
       JOIN player_identities pi ON pi.id = pg.identity_id
       WHERE pg.server_id = $1 AND pg.gamertag = $2
       ORDER BY pg.is_current_gamertag DESC, pg.last_seen DESC NULLS LAST LIMIT 1`,
      [serverId, playerOpt]
    );
    if (r.rows[0]) return { identityId: r.rows[0].id, label: r.rows[0].gamertag };
  }
  return null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cases')
    .setDescription('Review moderation cases (identity-linked — shows alts)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false)
    .addSubcommand(sub =>
      sub.setName('view').setDescription('Show a player\'s moderation history')
        .addStringOption(opt => opt.setName('player').setDescription('Gamertag').setRequired(false))
        .addUserOption(opt => opt.setName('member').setDescription('Or a Discord member').setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('resolve').setDescription('Resolve a warn case')
        .addIntegerOption(opt => opt.setName('case_id').setDescription('Case ID (from /cases view)').setRequired(true))),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();

    if (sub === 'resolve') {
      const caseId = interaction.options.getInteger('case_id');
      const r = await pool.query(
        `UPDATE mod_actions SET resolved_at = NOW()
         WHERE id = $1 AND action = 'warn' AND resolved_at IS NULL
         RETURNING id, identity_id`,
        [caseId]
      );
      if (!r.rows[0]) return interaction.editReply('❌ Case not found or not an open warn.');
      return interaction.editReply(`✅ Case **#${caseId}** resolved.`);
    }

    // view
    const sId = await serverId(interaction);
    if (!sId) return interaction.editReply('❌ No active server for this guild.');
    const playerOpt = interaction.options.getString('player');
    const memberOpt = interaction.options.getUser('member');
    if (!playerOpt && !memberOpt) {
      return interaction.editReply('❌ Provide a gamertag or a member.');
    }
    const found = await identityFor(playerOpt, memberOpt?.id, sId);
    if (!found) return interaction.editReply('❌ No in-game identity found for that player on this server.');

    const r = await pool.query(
      `SELECT ma.id, ma.action, ma.reason, ma.created_at, ma.resolved_at, ma.target_discord_id
       FROM mod_actions ma
       WHERE ma.identity_id = $1
       ORDER BY ma.created_at DESC LIMIT 50`,
      [found.identityId]
    );
    if (!r.rows.length) {
      return interaction.editReply(`No moderation cases for **${found.label}**.`);
    }
    const lines = r.rows.map(row => {
      const when = new Date(row.created_at);
      const status = row.resolved_at ? '✅' : '🔴';
      return `${status} **${row.action.toUpperCase()}** #${row.id} — ${when.toISOString().slice(0, 10)}\n   ${row.reason ? `“${row.reason.slice(0, 80)}”\n` : ''}   _via Discord ${row.target_discord_id}_`;
    });
    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle(`📋 Cases — ${found.label}`)
      .setDescription(lines.join('\n\n').slice(0, 4000))
      .setFooter({ text: `${r.rows.length} case(s) — warnings follow this player across all their Discord accounts` });
    return interaction.editReply({ embeds: [embed] });
  },
};
