const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const pool = require('../db');
const {
  enqueueRoleReconciliationJob,
  runRoleReconciliationJob,
} = require('../../utils/linkRoleReconciler');
const { lockPgUserRoleMutations } = require('../../utils/roleMutationLocks');

async function lockActiveLinkTenant(client, serverId, discordGuildId) {
  const tenant = await client.query(
    `SELECT s.id
       FROM guilds g
       JOIN servers s ON s.guild_id = g.id
      WHERE s.id = $1 AND g.discord_guild_id = $2
        AND s.status = 'active' AND g.status = 'approved'
      FOR UPDATE OF g, s`,
    [serverId, String(discordGuildId)]
  );
  if (tenant.rows.length !== 1) throw new Error('Player-link scope changed');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Unlink your in-game account from Discord')
    .addStringOption(option =>
      option.setName('gamertag')
        .setDescription('Your in-game gamertag to unlink')
        .setRequired(true))
    .addStringOption(option => option
      .setName('server')
      .setDescription('Nitrado service ID (required when this guild has multiple servers)')),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const gamertag = interaction.options.getString('gamertag');
    const discordId = interaction.user.id;
    const serverId = interaction.authorizedServerId;

    try {
      // Get user ID
      const userRes = await pool.query(
        'SELECT id FROM users WHERE discord_id = $1',
        [discordId]
      );
      const user = userRes.rows[0];

      if (!user) {
        return interaction.editReply({
          content: '❌ You have no linked accounts.'
        });
      }

      // Revoke only the exact server membership. Keep the verified account link
      // because the same platform identity may be authorized on another server.
      const client = await pool.connect();
      let deleteRes;
      let roleJob;
      try {
        await client.query('BEGIN');
        await lockPgUserRoleMutations(client, [user.id]);
        await lockActiveLinkTenant(client, serverId, interaction.guild.id);
        deleteRes = await client.query(`
          UPDATE server_player_memberships spm
           SET status = 'revoked', updated_at = NOW()
         WHERE spm.server_id = $3
           AND spm.user_id = $1
           AND spm.status = 'active'
           AND spm.identity_id IN (
             SELECT la.identity_id
             FROM linked_accounts la
             JOIN player_gamertags pg
               ON pg.identity_id = la.identity_id
              AND pg.server_id = $3
              AND pg.is_current_gamertag = 1
             WHERE la.user_id = $1
               AND LOWER(pg.gamertag) = LOWER($2)
           )
        RETURNING spm.id
        `, [user.id, gamertag, serverId]);
        if (deleteRes.rowCount > 0) {
          roleJob = await enqueueRoleReconciliationJob(client, {
            discordGuildId: interaction.guild.id,
            discordUserId: discordId,
            userId: user.id,
          });
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      const deletedCount = deleteRes.rowCount;

      if (deletedCount === 0) {
        return interaction.editReply({
          content: `❌ No linked accounts found with gamertag **${gamertag}**.`
        });
      }

      try {
        await runRoleReconciliationJob({
          db: pool,
          job: roleJob,
          member: interaction.member,
        });
      } catch (roleError) {
        console.warn(`⚠️ Account unlinked, but Discord role automation failed: ${roleError.message}`);
      }

      await interaction.editReply({
        content: `✅ Unlinked **${deletedCount}** account(s) with gamertag **${gamertag}**.`
      });

    } catch (error) {
      console.error('❌ Error unlinking account:', error);
      await interaction.editReply({
        content: `❌ **Error:** ${error.message}`
      });
    }
  }
};
