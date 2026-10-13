/*
 * bot/commands/setup-ai.js
 *
 * /setup-ai — per-guild configuration for the player-facing AI features
 * (admin only). All features default OFF; every subcommand here is an
 * explicit opt-in.
 *
 *   /setup-ai ask on|off [daily-limit <1-200>] [rules-channel <channel>]
 *       — "ask the server" toggle + per-user daily limit + rules channel
 *         (the channel whose latest message is treated as the rules doc).
 *   /setup-ai digest on|off channel <channel> interval daily|weekly
 *       — daily/weekly AI digest into the configured channel.
 *       /setup-ai digest test — post a digest immediately (no due-check).
 *   /setup-ai onboarding on|off channel <channel>
 *       — new-player welcome (uses ask's rules channel for the rules
 *         pointer when set).
 *   /setup-ai alerts on|off channel <channel>
 *       — ops alerts: post high/critical ops warnings to a channel (at most
 *         once per warning per 24h).
 *   /setup-ai disable — turn everything off.
 *
 * Stored in guild_ai_settings (migration 105).
 */

const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const pool = require('../db');

async function upsertSettings(guildDbId, patch, updatedByDiscordId) {
  await pool.query(
    `INSERT INTO guild_ai_settings (guild_id, updated_by_user_id, updated_at)
     VALUES ($1, NULL, NOW())
     ON CONFLICT (guild_id) DO NOTHING`,
    [guildDbId]
  );
  const sets = [];
  const params = [guildDbId];
  for (const [column, value] of Object.entries(patch)) {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (updatedByDiscordId) {
    params.push(updatedByDiscordId);
    sets.push(`updated_by_user_id = (SELECT id FROM users WHERE discord_id = $${params.length})`);
  }
  await pool.query(
    `UPDATE guild_ai_settings SET ${sets.join(', ')}, updated_at = NOW() WHERE guild_id = $1`,
    params
  );
}

async function resolveGuildDbId(discordGuildId) {
  const res = await pool.query('SELECT id FROM guilds WHERE discord_guild_id = $1 LIMIT 1', [String(discordGuildId)]);
  return res.rows[0]?.id ?? null;
}

function describeState(guildDbId) {
  return pool
    .query(
      `SELECT ask_enabled, ask_daily_limit, ask_rules_channel_id,
              digest_enabled, digest_channel_id, digest_interval,
              onboarding_enabled, onboarding_channel_id,
              ops_alert_enabled, ops_alert_channel_id
       FROM guild_ai_settings WHERE guild_id = $1`,
      [guildDbId]
    )
    .then(res => res.rows[0] || null);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-ai')
    .setDescription('Configure the player-facing AI (ask, digests, onboarding)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand(sub =>
      sub.setName('ask')
        .setDescription('"Ask the server": enable/disable + limit + rules channel')
        .addStringOption(opt =>
          opt.setName('state').setDescription('on or off').setRequired(true)
             .setChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
        .addIntegerOption(opt =>
          opt.setName('daily-limit').setDescription('Per-user daily question limit (1-200, default 20)').setMinValue(1).setMaxValue(200))
        .addChannelOption(opt =>
          opt.setName('rules-channel').setDescription('Channel whose latest message is the rules doc')
             .addChannelTypes(0))
    )
    .addSubcommand(sub =>
      sub.setName('digest')
        .setDescription('Daily/weekly AI digest into a channel')
        .addStringOption(opt =>
          opt.setName('state').setDescription('on or off (or "test" to post one now)')
             .setRequired(true)
             .setChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }, { name: 'test', value: 'test' }))
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Channel to post digests in').addChannelTypes(0))
        .addStringOption(opt =>
          opt.setName('interval').setDescription('daily or weekly (default daily)')
             .setChoices({ name: 'daily', value: 'daily' }, { name: 'weekly', value: 'weekly' }))
    )
    .addSubcommand(sub =>
      sub.setName('onboarding')
        .setDescription('New-player welcome on join')
        .addStringOption(opt =>
          opt.setName('state').setDescription('on or off').setRequired(true)
             .setChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Channel to post the welcome in').setRequired(false).addChannelTypes(0))
    )
    .addSubcommand(sub =>
      sub.setName('alerts')
        .setDescription('Ops alerts: post high/critical ops warnings to a channel (max once per 24h)')
        .addStringOption(opt =>
          opt.setName('state').setDescription('on or off').setRequired(true)
             .setChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Channel to post ops alerts in').setRequired(false).addChannelTypes(0))
    )
    .addSubcommand(sub =>
      sub.setName('disable').setDescription('Disable all player-facing AI features for this server')
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const guildDbId = await resolveGuildDbId(interaction.guildId);
    if (!guildDbId) {
      return interaction.editReply('❌ This Discord server is not registered yet. Use `/register-token` first.');
    }

    if (sub === 'disable') {
      await upsertSettings(guildDbId, {
        ask_enabled: false,
        digest_enabled: false,
        onboarding_enabled: false,
        ops_alert_enabled: false,
      }, interaction.user.id);
      return interaction.editReply('✅ All player-facing AI features disabled for this server.');
    }

    if (sub === 'ask') {
      const state = interaction.options.getString('state');
      const patch = { ask_enabled: state === 'on' };
      const limit = interaction.options.getInteger('daily-limit');
      if (limit) patch.ask_daily_limit = limit;
      const rulesChannel = interaction.options.getChannel('rules-channel');
      if (rulesChannel) patch.ask_rules_channel_id = rulesChannel.id;
      await upsertSettings(guildDbId, patch, interaction.user.id);
      const s = await describeState(guildDbId);
      return interaction.editReply(
        `✅ Ask-the-server is now **${s.ask_enabled ? 'ON' : 'OFF'}**.` +
        `\nDaily limit per player: ${s.ask_daily_limit}` +
        `\nRules channel: ${s.ask_rules_channel_id ? `\`${s.ask_rules_channel_id}\`` : 'not set'}` +
        (s.ask_enabled ? '\nPlayers can use `/ask` now.' : '')
      );
    }

    if (sub === 'digest') {
      const state = interaction.options.getString('state');
      if (state === 'test') {
        const { runDigestPass } = require('../services/digestService');
        // Force-due: temporarily clear the last-posted marker so the pass
        // posts one digest immediately regardless of the normal cadence.
        await pool.query(
          'UPDATE guild_ai_settings SET digest_state = \'{}\'::jsonb WHERE guild_id = $1',
          [guildDbId]
        );
        const posted = await runDigestPass(interaction.client, pool);
        return interaction.editReply(
          posted > 0
            ? '✅ Test digest posted (check the configured digest channel).'
            : '❌ No digest was posted — make sure digest is enabled with a channel first (`/setup-ai digest on`).'
        );
      }
      const channel = interaction.options.getChannel('channel');
      if (state === 'on' && !channel) {
        return interaction.editReply('❌ A channel is required to enable digests. `/setup-ai digest on channel <#channel>`');
      }
      const patch = { digest_enabled: state === 'on' };
      if (channel) patch.digest_channel_id = channel.id;
      const interval = interaction.options.getString('interval');
      if (interval) patch.digest_interval = interval;
      await upsertSettings(guildDbId, patch, interaction.user.id);
      const s = await describeState(guildDbId);
      return interaction.editReply(
        `✅ Digests are now **${s.digest_enabled ? 'ON' : 'OFF'}**.` +
        `\nInterval: ${s.digest_interval}\nChannel: ${s.digest_channel_id ? `\`${s.digest_channel_id}\`` : 'not set'}`
      );
    }

    if (sub === 'onboarding') {
      const state = interaction.options.getString('state');
      const channel = interaction.options.getChannel('channel');
      if (state === 'on' && !channel) {
        return interaction.editReply('❌ A channel is required to enable onboarding. `/setup-ai onboarding on channel <#channel>`');
      }
      const patch = { onboarding_enabled: state === 'on' };
      if (channel) patch.onboarding_channel_id = channel.id;
      await upsertSettings(guildDbId, patch, interaction.user.id);
      const s = await describeState(guildDbId);
      return interaction.editReply(
        `✅ New-player onboarding is now **${s.onboarding_enabled ? 'ON' : 'OFF'}**.` +
        `\nChannel: ${s.onboarding_channel_id ? `\`${s.onboarding_channel_id}\`` : 'not set'}` +
        (s.onboarding_enabled && !s.ask_rules_channel_id
          ? '\nTip: set a rules channel with `/setup-ai ask on rules-channel <#rules>` so the welcome points new players there.'
          : '')
      );
    }

    if (sub === 'alerts') {
      const state = interaction.options.getString('state');
      const channel = interaction.options.getChannel('channel');
      if (state === 'on' && !channel) {
        return interaction.editReply('❌ A channel is required to enable ops alerts. `/setup-ai alerts on channel <#channel>`');
      }
      const patch = { ops_alert_enabled: state === 'on' };
      if (channel) patch.ops_alert_channel_id = channel.id;
      await upsertSettings(guildDbId, patch, interaction.user.id);
      const s = await describeState(guildDbId);
      return interaction.editReply(
        `✅ Ops alerts are now **${s.ops_alert_enabled ? 'ON' : 'OFF'}**.` +
        `\nHigh/critical ops warnings post here at most once per warning per 24h.` +
        `\nChannel: ${s.ops_alert_channel_id ? `\`${s.ops_alert_channel_id}\`` : 'not set'}`
      );
    }

    return interaction.editReply('❌ Unknown subcommand.');
  }
};
