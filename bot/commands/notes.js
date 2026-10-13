/*
 * bot/commands/notes.js
 *
 * /notes — staff notes scoped to a player's in-game identity (wraps
 * player_staff_notes). Because notes are identity-scoped, they follow the
 * player across every linked Discord account / alt.
 *
 * Subcommands (moderator+):
 *   /notes add <gamertag|member> <note>
 *   /notes view <gamertag|member>
 *   /notes clear <gamertag|member>
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} = require('discord.js');
const pool = require('../db');

async function resolveServerId(interaction) {
  if (interaction.authorizedServerId) return interaction.authorizedServerId;
  const r = await pool.query(
    `SELECT s.id FROM servers s JOIN guilds g ON s.guild_id = g.id
     WHERE g.discord_guild_id = $1 AND s.status = 'active' ORDER BY s.id LIMIT 1`,
    [interaction.guild.id]
  );
  return r.rows[0]?.id ?? null;
}

async function identityForGamertag(gamertag, serverId) {
  const r = await pool.query(
    `SELECT pi.id FROM player_gamertags pg
     JOIN player_identities pi ON pi.id = pg.identity_id
     WHERE pg.server_id = $1 AND pg.gamertag = $2
     ORDER BY (pg.is_current_gamertag DESC), pg.last_seen DESC NULLS LAST
     LIMIT 1`,
    [serverId, gamertag]
  );
  return r.rows[0]?.id ?? null;
}

async function identityForMember(memberId, serverId) {
  const r = await pool.query(
    `SELECT spm.identity_id FROM linked_accounts la
     JOIN users u ON u.id = la.user_id
     JOIN server_player_memberships spm
       ON spm.source_link_id = la.id AND spm.user_id = la.user_id
       AND spm.server_id = $2 AND spm.status = 'active'
     WHERE u.discord_id = $1
     ORDER BY spm.id LIMIT 1`,
    [memberId, serverId]
  );
  return r.rows[0]?.identity_id ?? null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('notes')
    .setDescription('Staff notes for a player (identity-scoped, follows alts)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false)
    .addSubcommand(sub =>
      sub.setName('add').setDescription('Add or update a staff note')
        .addStringOption(opt => opt.setName('player').setDescription('Gamertag or Discord user').setRequired(true))
        .addStringOption(opt => opt.setName('note').setDescription('The note').setRequired(true).setMaxLength(1000))
        .addUserOption(opt => opt.setName('member').setDescription('Or a Discord member')))
    .addSubcommand(sub =>
      sub.setName('view').setDescription('View a player\'s staff note')
        .addStringOption(opt => opt.setName('player').setDescription('Gamertag or Discord user').setRequired(true))
        .addUserOption(opt => opt.setName('member').setDescription('Or a Discord member')))
    .addSubcommand(sub =>
      sub.setName('clear').setDescription('Clear a player\'s staff note')
        .addStringOption(opt => opt.setName('player').setDescription('Gamertag or Discord user').setRequired(true))
        .addUserOption(opt => opt.setName('member').setDescription('Or a Discord member'))),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const serverId = await resolveServerId(interaction);
    if (!serverId) return interaction.editReply('❌ No active server found for this guild.');

    const memberOpt = interaction.options.getUser('member');
    const playerOpt = interaction.options.getString('player');
    let identityId = null;
    let label = '';

    if (memberOpt) {
      identityId = await identityForMember(memberOpt.id, serverId);
      label = memberOpt.displayName;
    } else if (playerOpt) {
      // Could be a gamertag or a mention.
      const isMention = /^\d{16,22}$/.test(playerOpt.replace(/<@!?/g, '').replace(/>/g, ''));
      const raw = playerOpt.replace(/<@!?/g, '').replace(/>/g, '').trim();
      if (isMention) {
        identityId = await identityForMember(raw, serverId);
        label = raw;
      } else {
        identityId = await identityForGamertag(raw, serverId);
        label = raw;
      }
    }

    if (!identityId) {
      return interaction.editReply('❌ No in-game identity found for that player on this server. Use `/link` first.');
    }

    if (sub === 'add') {
      const note = interaction.options.getString('note');
      await pool.query(
        `INSERT INTO player_staff_notes (server_id, identity_id, note)
         VALUES ($1,$2,$3)
         ON CONFLICT (server_id, identity_id)
         DO UPDATE SET note = EXCLUDED.note, version = player_staff_notes.version + 1, updated_at = NOW()`,
        [serverId, identityId, note]
      );
      return interaction.editReply(`✅ Note updated for **${label}**.`);
    }

    if (sub === 'view') {
      const r = await pool.query(
        'SELECT note, updated_at FROM player_staff_notes WHERE server_id = $1 AND identity_id = $2',
        [serverId, identityId]
      );
      const row = r.rows[0];
      if (!row) return interaction.editReply(`No staff note for **${label}**.`);
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle(`📝 Staff note — ${label}`)
        .setDescription(row.note || '*(empty)*')
        .setFooter({ text: `Updated ${row.updated_at ? new Date(row.updated_at).toLocaleString() : '—'}` })
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    // clear
    await pool.query(
      'DELETE FROM player_staff_notes WHERE server_id = $1 AND identity_id = $2',
      [serverId, identityId]
    );
    return interaction.editReply(`✅ Note cleared for **${label}**.`);
  },
};
