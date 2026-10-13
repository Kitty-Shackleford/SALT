/*
 * bot/commands/setup-antispam.js
 *
 * /setup-antispam — per-guild anti-spam rate limiter (message burst guard).
 *
 * Subcommands:
 *   /setup-antispam enable [limit] [window-seconds] [gap-seconds]
 *     Turn anti-spam on. Defaults: 5 messages per 10s burst, 3s gap between
 *     messages before the burst restarts.
 *   /setup-antispam set limit <n> window-seconds <s> gap-seconds <s>
 *     Update thresholds (all optional; omitted values keep the current).
 *   /setup-antispam disable
 *   /setup-antispam show
 *
 * Behavior when enabled: a member who sends `limit` messages within
 * `window-seconds` (with at most `gap-seconds` between consecutive
 * messages) has the offending message deleted and gets a short moderator
 * notice. See services/antiSpamService.js for the algorithm.
 *
 * Stored in guild_features (feature_name 'antispam') — off by default, so
 * enabling is an explicit per-guild opt-in.
 */

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const pool = require('../db');
const { setFeatureConfig: writeFeatureConfig } = require('../utils/guildFeatureSettings');
const { normalizeConfig } = require('../services/antiSpamService');

async function fetchRawConfig(discordGuildId) {
  const r = await pool.query(
    `SELECT gf.enabled, gf.config
     FROM guilds g
     JOIN guild_features gf ON gf.guild_id = g.id
     WHERE g.discord_guild_id = $1 AND gf.feature_name = 'antispam'
     LIMIT 1`,
    [String(discordGuildId)]
  );
  const row = r.rows[0];
  if (!row) return { enabled: false, config: null };
  let config = null;
  if (row.config) {
    try {
      config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
    } catch (err) {
      console.warn(`⚠️ [antispam] bad stored config: ${err.message}`);
      config = null;
    }
  }
  return { enabled: Boolean(row.enabled), config };
}

function describeConfig(config, enabled) {
  const cfg = normalizeConfig(config || {});
  if (!enabled) return 'Anti-spam is **off** (messages are not checked).';
  return [
    `Anti-spam is **on** for this server:`,
    `• Limit: ${cfg.limit} messages`,
    `• Window: ${cfg.windowMs / 1000}s from the first message of a burst`,
    `• Gap: ${cfg.gapMs / 1000}s — a longer pause restarts the burst`,
    `On trip: message deleted + moderator notice in the channel.`,
  ].join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-antispam')
    .setDescription('Configure the per-server anti-spam message rate limiter')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand(sub =>
      sub.setName('enable')
        .setDescription('Turn anti-spam on (defaults: 5 msgs / 10s window / 3s gap)')
        .addIntegerOption(opt =>
          opt.setName('limit').setDescription('Messages per burst (3-15)')
             .setMinValue(3).setMaxValue(15).setRequired(false))
        .addIntegerOption(opt =>
          opt.setName('window-seconds').setDescription('Burst window in seconds (5-120)')
             .setMinValue(5).setMaxValue(120).setRequired(false))
        .addIntegerOption(opt =>
          opt.setName('gap-seconds').setDescription('Max gap between messages in seconds (1-10)')
             .setMinValue(1).setMaxValue(10).setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('set')
        .setDescription('Update anti-spam thresholds (omitted values keep the current)')
        .addIntegerOption(opt =>
          opt.setName('limit').setDescription('Messages per burst (3-15)')
             .setMinValue(3).setMaxValue(15).setRequired(false))
        .addIntegerOption(opt =>
          opt.setName('window-seconds').setDescription('Burst window in seconds (5-120)')
             .setMinValue(5).setMaxValue(120).setRequired(false))
        .addIntegerOption(opt =>
          opt.setName('gap-seconds').setDescription('Max gap between messages in seconds (1-10)')
             .setMinValue(1).setMaxValue(10).setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('disable').setDescription('Turn anti-spam off for this server'))
    .addSubcommand(sub =>
      sub.setName('show').setDescription('Show current anti-spam settings')),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (sub === 'disable') {
      await writeFeatureConfig(interaction.guildId, 'antispam', {}, false, interaction.user.id);
      return interaction.editReply('✅ Anti-spam disabled for this server.');
    }

    if (sub === 'show') {
      const raw = await fetchRawConfig(interaction.guildId);
      return interaction.editReply(describeConfig(raw.config, raw.enabled));
    }

    // 'enable' and 'set' both read current, merge requested values, persist.
    const raw = await fetchRawConfig(interaction.guildId);
    const base = raw.config || {};
    const limit = interaction.options.getInteger('limit');
    const windowSec = interaction.options.getInteger('window-seconds');
    const gapSec = interaction.options.getInteger('gap-seconds');

    const config = {
      ...base,
      ...(limit !== null ? { limit } : {}),
      ...(windowSec !== null ? { windowMs: windowSec * 1000 } : {}),
      ...(gapSec !== null ? { gapMs: gapSec * 1000 } : {}),
    };
    const enabled = sub === 'enable';
    if (!enabled && !(limit !== null || windowSec !== null || gapSec !== null)) {
      return interaction.editReply('❌ Provide at least one value to update: `limit`, `window-seconds`, or `gap-seconds`.');
    }
    await writeFeatureConfig(interaction.guildId, 'antispam', config, enabled, interaction.user.id);

    return interaction.editReply(describeConfig(config, enabled)
      + (enabled && !raw.enabled ? '\n(anti-spam was just enabled for this server)' : ''));
  },
};
