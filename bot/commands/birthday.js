'use strict';

/**
 * bot/commands/birthday.js
 *
 * /birthday — IRL + in-character birthday tracker.
 *
 * Subcommands:
 *   /birthday set month <1-12> day <1-31> [irl-year] [char-year] [visibility]
 *     Sets the caller's own linked identity's birthday.
 *
 *   /birthday view [user]
 *     Shows a birthday. In-character age is always visible; the IRL date
 *     appears only when the owner set visibility to irl_date or full.
 *     Moderators (guild owner/admin, server admin/owner/moderator, or
 *     Discord Administrator) may see the IRL date regardless.
 *
 *   /birthday list [days]
 *     Moderator-only: upcoming guild birthdays (default 30 days), with IRL
 *     data filtered by each owner's visibility (mods always see IRL date).
 *
 * Authorization lives in bot/utils/commandAuthorization.js:
 *   birthday:set   -> 'player'   (any linked player, own identity)
 *   birthday:view  -> 'general'  (any guild member)
 *   birthday:list  -> 'mod'      (same gate class as 'teleport')
 */

const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const db = require('../utils/dashboardDbAdapter');
const birthdayService = require('../../services/birthdayService');
const { birthdayVisibility } = require('../utils/birthdayVisibility');

/**
 * Resolve a Discord user's linked, verified player identity.
 * @returns {Promise<{identityId: number|null, gamertag: string|null}>}
 */
async function resolveLinkedIdentity(discordUserId) {
  const row = await db.get(
    `SELECT DISTINCT ON (pi.id) pi.id, pi.platform, pg.gamertag
     FROM linked_accounts la
     JOIN users u ON u.id = la.user_id
     JOIN player_identities pi ON pi.id = la.identity_id
     LEFT JOIN server_player_memberships spm
       ON spm.source_link_id = la.id
      AND spm.user_id = la.user_id
      AND spm.identity_id = la.identity_id
      AND spm.status = 'active'
     LEFT JOIN player_gamertags pg
       ON pg.identity_id = pi.id AND pg.server_id = spm.server_id
      AND pg.is_current_gamertag = 1
     WHERE u.discord_id = ?
       AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
     ORDER BY pi.id, pg.last_seen DESC NULLS LAST`,
    [String(discordUserId)]
  );
  if (!row) return { identityId: null, gamertag: null };
  return { identityId: Number(row.id), gamertag: row.gamertag || row.platform || null };
}

/** True if the actor can see IRL birthday data for someone else. */
async function isBirthdayMod(discordGuildId, discordUserId) {
  if (!discordGuildId) return false;
  const row = await db.get(
    `SELECT gr.role AS guild_role,
            (SELECT sra.role
             FROM server_role_assignments sra
             JOIN servers s ON s.id = sra.server_id
             WHERE sra.user_id = gr.user_id
               AND s.guild_id = gr.guild_id
               AND sra.status = 'active'
               AND sra.role IN ('admin', 'owner', 'moderator')
             ORDER BY CASE sra.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END
             LIMIT 1) AS server_role
     FROM guild_roles gr
     JOIN users u ON u.id = gr.user_id
     WHERE u.discord_id = ?
       AND gr.guild_id = (SELECT id FROM guilds WHERE discord_guild_id = ? LIMIT 1)
     LIMIT 1`,
    [String(discordUserId), String(discordGuildId)]
  );
  if (['owner', 'admin'].includes(row?.guild_role)) return true;
  if (['owner', 'admin', 'moderator'].includes(row?.server_role)) return true;
  return false;
}

/**
 * Effective visibility role for `view`ing a birthday.
 * 'owner' / 'mod' / 'stranger'
 */
async function viewRole({ discordGuildId, actorDiscordId, isDiscordAdministrator, target }) {
  const self = await resolveLinkedIdentity(actorDiscordId);
  if (target.identityId == null) return 'stranger';
  if (self.identityId != null && self.identityId === target.identityId) return 'owner';
  if (isDiscordAdministrator === true || await isBirthdayMod(discordGuildId, actorDiscordId)) return 'mod';
  return 'stranger';
}

/** Render a birthday for the viewer per visibility rules. */
function renderBirthday(entry, viewerRole, businessDate) {
  const visible = birthdayVisibility(viewerRole, { visibility: entry.visibility, birthday: entry });
  const lines = [];
  if (entry.char_year != null) {
    const charAge = birthdayService.computeAges(entry, businessDate).charAge;
    lines.push(`**Character age:** ${charAge} years in Chernarus`);
  }
  let hasIrlLine = false;
  if (visible.showIrlDate) {
    lines.push(`**IRL birthday:** ${entry.month}/${entry.day}${entry.irl_year != null ? ` (${entry.irl_year})` : ''}`);
    hasIrlLine = true;
  }
  if (visible.showIrlAge && !hasIrlLine) {
    const irlAge = birthdayService.computeAges(entry, businessDate).irlAge;
    if (irlAge != null) lines.push(`**IRL age:** ${irlAge}`);
  }
  if (lines.length === 0) lines.push('*No age set — birthday month/day only.*');
  return { lines, visible };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('birthday')
    .setDescription('Set and view your IRL + in-character birthday')
    .addSubcommand(sub => sub
      .setName('set')
      .setDescription('Set your own birthday (linked account required)')
      .addIntegerOption(opt => opt.setName('month').setDescription('Birth month, 1-12').setMinValue(1).setMaxValue(12).setRequired(true))
      .addIntegerOption(opt => opt.setName('day').setDescription('Birth day, 1-31').setMinValue(1).setMaxValue(31).setRequired(true))
      .addIntegerOption(opt => opt.setName('irl-year').setDescription('Real-life birth year (optional)'))
      .addIntegerOption(opt => opt.setName('char-year').setDescription('Character birth year (optional)'))
      .addStringOption(opt => opt
        .setName('visibility')
        .setDescription('Who may see your IRL birthday (default: char_only)')
        .addChoices(
          { name: 'char_only — only character age', value: 'char_only' },
          { name: 'irl_date — month/day visible too', value: 'irl_date' },
          { name: 'full — IRL age visible too', value: 'full' }
        ))
    )
    .addSubcommand(sub => sub
      .setName('view')
      .setDescription('View a birthday. Moderators can see the IRL date.')
      .addUserOption(opt => opt.setName('user').setDescription('Whose birthday to view (default: you)'))
    )
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('Upcoming guild birthdays (moderators only)')
      .addIntegerOption(opt => opt.setName('days').setDescription('How many days ahead to look').setMinValue(0).setMaxValue(31))
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const businessDate = new Date().toISOString().slice(0, 10);
    const isDiscordAdministrator = Boolean(
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    );

    if (sub === 'set') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const self = await resolveLinkedIdentity(interaction.user.id);
      if (self.identityId == null) {
        return interaction.editReply('❌ You have no linked game account.\nUse `/link <gamertag>` first, then set your birthday.');
      }
      try {
        const entry = await birthdayService.setBirthday(db, {
          identityId: self.identityId,
          month: interaction.options.getInteger('month', true),
          day: interaction.options.getInteger('day', true),
          irlYear: interaction.options.getInteger('irl-year'),
          charYear: interaction.options.getInteger('char-year'),
          visibility: interaction.options.getString('visibility') || 'char_only',
        });
        const { lines } = renderBirthday(entry, 'owner', businessDate);
        return interaction.editReply(`🎂 Birthday saved for **${self.gamertag}**.\n${lines.join('\n')}`);
      } catch (error) {
        if (error.code === 'BIRTHDAY_INVALID') return interaction.editReply(`❌ ${error.message}`);
        console.error('/birthday set failed:', error);
        return interaction.editReply('❌ Could not save your birthday. Try again.');
      }
    }

    if (sub === 'view') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const targetUser = interaction.options.getUser('user') || interaction.user;
      const target = await resolveLinkedIdentity(targetUser.id);
      if (target.identityId == null) {
        return interaction.editReply(`❌ ${targetUser.id === interaction.user.id ? 'You have' : `${targetUser.username} has`} no linked game account with a verifiable identity.`);
      }
      const entry = await birthdayService.getBirthday(target.identityId);
      if (!entry) {
        const who = targetUser.id === interaction.user.id ? 'you' : targetUser.username;
        return interaction.editReply(`No birthday is set for ${who} yet${who === 'you' ? ' — use `/birthday set`' : ''}.`);
      }
      const role = await viewRole({
        discordGuildId: interaction.guildId,
        actorDiscordId: interaction.user.id,
        isDiscordAdministrator,
        target,
      });
      const { lines, visible } = renderBirthday(entry, role, businessDate);
      const embed = new EmbedBuilder()
        .setTitle(`🎂 ${target.gamertag || targetUser.username}'s birthday`)
        .setColor(0xf5c542)
        .setDescription(lines.join('\n'))
        .setTimestamp();
      if (role !== 'owner' && !visible.showIrlDate) {
        embed.setFooter({ text: 'IRL details hidden by this player\'s privacy setting (mods may view with authority).' });
      }
      return interaction.editReply({ embeds: [embed] });
    }

    // list — mod-only (authorized upstream by command class 'mod')
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildRow = await db.get('SELECT id FROM guilds WHERE discord_guild_id = ? LIMIT 1', [String(interaction.guildId)]);
    if (!guildRow) return interaction.editReply('❌ This guild is not configured.');
    const days = Math.min(Math.max(interaction.options.getInteger('days') ?? 30, 0), 31);
    const rows = await birthdayService.listUpcoming(db, { guildId: guildRow.id, days, today: businessDate });
    const isMod = isDiscordAdministrator || await isBirthdayMod(interaction.guildId, interaction.user.id);
    if (rows.length === 0) {
      return interaction.editReply(`No guild birthdays in the next ${days} day(s).`);
    }
    const lines = rows.map(row => {
      const label = row.name ? String(row.name).slice(0, 40) : `identity ${row.identity_id}`;
      const eta = row.days_until === 0 ? 'today' : `in ${row.days_until} day(s)`;
      let detail = '';
      if (row.char_year != null) {
        const { charAge } = birthdayService.computeAges(row, businessDate);
        detail += `char age ${charAge}`;
      }
      if (isMod && row.irl_year != null) {
        const { irlAge } = birthdayService.computeAges(row, businessDate);
        detail += `${detail ? ' · ' : ''}irl ${row.month}/${row.day} (${irlAge}y)`;
      } else if (row.visibility === 'full' && row.irl_year != null) {
        const { irlAge } = birthdayService.computeAges(row, businessDate);
        detail += `${detail ? ' · ' : ''}irl ${row.month}/${row.day} (${irlAge}y)`;
      }
      return `• **${label}** — ${row.month}/${row.day} ${eta}${detail ? ` — ${detail}` : ''}`;
    });
    const embed = new EmbedBuilder()
      .setTitle(`🎂 Upcoming birthdays — next ${days} day(s)`)
      .setColor(0xf5c542)
      .setDescription(lines.join('\n'))
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  },
};
