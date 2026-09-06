'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const pool = require('../db');
const githubService = require('../../services/githubService');
const { inspectGitHubActionsIntegration } = require('../../services/githubActionsIntegrationService');
const { decryptToken } = require('../../utils/encryption');

const STATUS_ICON = {
  healthy: '✅', partial: '🟡', running: '🔵', stale: '⚠️', failing: '❌',
  disabled: '⏸️', unknown: '❔', not_installed: '➖',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('github')
    .setDescription('Show the user-owned GitHub Actions integration for a DayZ server')
    .addStringOption(option => option
      .setName('server')
      .setDescription('Nitrado service ID (required when this guild has multiple servers)')),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await pool.query(
      `SELECT s.platform_server_id, gai.repo_owner, gai.repo_name, gai.branch,
              gc.token_hash
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
       JOIN github_action_integrations gai ON gai.server_id = s.id
       JOIN github_connections gc ON gc.user_id = gai.connection_user_id
       LEFT JOIN guild_roles gr
         ON gr.guild_id = g.id
        AND gr.user_id = gai.connection_user_id
       LEFT JOIN server_role_assignments sra
         ON sra.server_id = s.id
        AND sra.guild_id = g.id
        AND sra.user_id = gai.connection_user_id
       WHERE s.id = $1
         AND g.discord_guild_id = $2
         AND s.status = 'active'
         AND g.status = 'approved'
         AND (
           gr.role IN ('owner', 'admin')
           OR (sra.role = 'admin' AND sra.status = 'active')
         )
       LIMIT 1`,
      [interaction.authorizedServerId, interaction.guildId]
    );
    const link = result.rows[0];
    if (!link) return interaction.editReply('No GitHub repository is linked to this server.');

    let integration;
    try {
      integration = await inspectGitHubActionsIntegration({
        github: githubService,
        token: decryptToken(link.token_hash),
        owner: link.repo_owner,
        repo: link.repo_name,
        branch: link.branch,
        expectedServerId: link.platform_server_id,
      });
    } catch (error) {
      console.error('GitHub Actions integration status failed:', error.code || error.name);
      return interaction.editReply('GitHub integration status is currently unavailable.');
    }

    const repositoryLabel = integration.repository?.private
      ? 'Private repository'
      : integration.repository?.fullName || `${link.repo_owner}/${link.repo_name}`;
    const status = integration.status || 'unknown';
    const embed = new EmbedBuilder()
      .setColor(status === 'healthy' ? 0x57f287 : status === 'failing' ? 0xed4245 : 0xfee75c)
      .setTitle('GitHub Actions Integration')
      .addFields(
        { name: 'Repository', value: repositoryLabel, inline: true },
        { name: 'Status', value: `${STATUS_ICON[status] || '❔'} ${status.replace('_', ' ')}`, inline: true }
      )
      .setTimestamp();

    if (!integration.installed) {
      embed.setDescription('The repository is connected, but the DayZ Actions manifest is not installed.');
    } else {
      const actionLines = integration.actions.map(action =>
        `${STATUS_ICON[action.status] || '❔'} **${action.name}** — ${action.status.replace('_', ' ')}`
      );
      embed.addFields(
        { name: 'Installed Actions', value: actionLines.join('\n').slice(0, 1024) || 'None declared' },
        { name: 'Capabilities', value: integration.capabilities.join(', ').slice(0, 1024) || 'None declared' }
      );
    }
    return interaction.editReply({ embeds: [embed] });
  },
};
