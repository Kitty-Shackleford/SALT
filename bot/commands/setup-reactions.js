/*
 * bot/commands/setup-reactions.js
 *
 * /setup-reactions — configure reaction roles.
 *
 * Subcommands:
 *   /setup-reactions add channel <channel> emoji <emoji> role <role> [message]
 *     Post a message in the channel (or target an existing message id) and bind
 *     the emoji to the role. Reacting with the emoji assigns the role.
 *   /setup-reactions list
 *     List current bindings for this server.
 *   /setup-reactions remove emoji <emoji> role <role>
 *     Remove a specific binding.
 *   /setup-reactions picker channel <channel>
 *     Post a single-panel picker message with one button per binding.
 *     Clicking a button toggles the bound role. Re-run to refresh the panel
 *     after bindings change.
 *
 * Emoji: a standard emoji (e.g. 🎮) or a custom emoji reference (<a:name:123>).
 * Stored in the `reaction_roles` table.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
} = require('discord.js');
const pool = require('../db');
const { buildPickerMessages } = require('../services/pickerButtonService');

/**
 * Normalize an emoji string to the form the reaction handler will compare
 * against (reaction.emoji.name): custom "<a:Name:123>" -> "Name"; standard
 * emoji stay as the unicode char.
 */
function normalizeEmoji(input) {
  const raw = String(input || '');
  const m = raw.match(/^<a?:([a-z0-9_]+):\d+>$/i);
  return m ? m[1] : raw;
}

/**
 * Convert a stored/typed emoji into the form ButtonBuilder.setEmoji accepts:
 * custom "<a:Name:123>" stays as-is; a bare custom name (without id) is
 * looked up in the guild cache; standard unicode passes through.
 * Returns the raw input when it cannot be resolved (button is then posted
 * without an emoji rather than the command failing).
 */
function resolveButtonEmoji(guild, rawEmoji) {
  const raw = String(rawEmoji || '');
  if (/^<a?:[a-z0-9_]+:\d+>$/i.test(raw)) return raw;
  const m = raw.match(/^([a-z0-9_]+)$/i);
  if (m && guild?.emojis?.cache?.has(m[1])) {
    return guild.emojis.cache.get(m[1]).toString();
  }
  return raw;
}

async function getGuildDbId(discordGuildId) {
  const r = await pool.query('SELECT id FROM guilds WHERE discord_guild_id = $1 LIMIT 1', [String(discordGuildId)]);
  return r.rows[0]?.id || null;
}

async function fetchBindings(discordGuildId) {
  const guildDbId = await getGuildDbId(discordGuildId);
  if (!guildDbId) return [];
  const r = await pool.query(
    `SELECT channel_id, message_id, emoji, role_id
     FROM reaction_roles WHERE guild_id = $1 ORDER BY emoji`,
    [guildDbId]
  );
  return r.rows;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-reactions')
    .setDescription('Configure reaction roles (react to assign a role)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Bind an emoji to a role (posts a message in the channel)')
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Channel to post the reaction-role message in')
             .setRequired(true).addChannelTypes(0))
        .addStringOption(opt =>
          opt.setName('emoji').setDescription('Emoji (e.g. 🎮 or <a:name:123>)').setRequired(true))
        .addRoleOption(opt =>
          opt.setName('role').setDescription('Role to assign on reaction').setRequired(true))
        .addStringOption(opt =>
          opt.setName('message').setDescription('Message text to post (default template)')
             .setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('list').setDescription('List current reaction-role bindings'))
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Remove a reaction-role binding')
        .addStringOption(opt => opt.setName('emoji').setDescription('Emoji to unbind').setRequired(true))
        .addRoleOption(opt => opt.setName('role').setDescription('Role to unbind').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('picker')
        .setDescription('Post a button picker panel with one button per binding')
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Channel to post the picker in')
             .setRequired(true).addChannelTypes(0))
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (sub === 'list') {
      const bindings = await fetchBindings(interaction.guildId);
      if (!bindings.length) {
        return interaction.editReply('No reaction roles are configured for this server.');
      }
      const lines = bindings.map(b => {
        const role = interaction.guild.roles.cache.get(b.role_id);
        return `• \`${b.emoji}\` → ${role ? `<@&${b.role_id}>` : `<missing role ${b.role_id}>`}`;
      });
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setTitle('Reaction roles')
          .setDescription(lines.join('\n'))
          .setColor(0x5865f2)],
      });
    }

    if (sub === 'remove') {
      const emoji = normalizeEmoji(interaction.options.getString('emoji'));
      const roleId = interaction.options.getRole('role')?.id;
      if (!roleId) return interaction.editReply('❌ You must pick a role to unbind.');
      const guildDbId = await getGuildDbId(interaction.guildId);
      if (guildDbId) {
        await pool.query(
          `DELETE FROM reaction_roles WHERE guild_id = $1 AND emoji = $2 AND role_id = $3`,
          [guildDbId, emoji, roleId]
        );
      }
      return interaction.editReply(`✅ Removed binding \`${emoji}\` → <@&${roleId}>.`);
    }

    // sub === 'picker'
    if (sub === 'picker') {
      const channel = interaction.options.getChannel('channel');
      const bindings = await fetchBindings(interaction.guildId);
      if (!bindings.length) {
        return interaction.editReply('❌ No reaction roles are configured for this server yet. Use `add` first, then post the picker.');
      }
      const rows = bindings.map(b => {
        const normalized = normalizeEmoji(b.emoji); // colon-free: used in customId
        return {
          emoji: normalized,
          displayEmoji: resolveButtonEmoji(interaction.guild, b.emoji),
          roleId: b.role_id,
          roleName: interaction.guild.roles.cache.get(b.role_id)?.name || `role ${b.role_id}`,
        };
      });
      const panels = buildPickerMessages(rows);
      for (const panel of panels) {
        await channel.send(panel);
      }
      return interaction.editReply(
        `✅ Picker panel posted in ${channel} (${rows.length} button${rows.length === 1 ? '' : 's'}). ` +
        'Re-run `picker` to refresh it after bindings change.'
      );
    }

    // sub === 'add'
    const channel = interaction.options.getChannel('channel');
    const emoji = normalizeEmoji(interaction.options.getString('emoji'));
    const rawEmoji = interaction.options.getString('emoji');
    const role = interaction.options.getRole('role');
    const messageText = interaction.options.getString('message')
      || `React with **${rawEmoji}** to receive **${role.name}**.`;

    if (!role) return interaction.editReply('❌ You must pick a role to assign.');
    const guildDbId = await getGuildDbId(interaction.guildId);
    if (!guildDbId) return interaction.editReply('❌ This server is not registered in the dashboard.');

    // Post the carrier message (or reuse if a message id was given).
    const posted = await channel.send({ content: messageText, embeds: [new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('Reaction Roles')
      .setDescription(`React with **${rawEmoji}** to toggle **${role.name}**.`)
    ]});

    await pool.query(
      `INSERT INTO reaction_roles (guild_id, channel_id, message_id, emoji, role_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (guild_id, message_id, emoji, role_id) DO NOTHING`,
      [guildDbId, channel.id, posted.id, emoji, role.id, interaction.user.id]
    );

    return interaction.editReply(
      `✅ Reaction role added: \`${rawEmoji}\` → **${role.name}** in ${channel}.`
    );
  },
};
