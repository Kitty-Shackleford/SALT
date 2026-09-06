const pool = require('../db');
const { bootstrapConfiguredDashboardOwner } = require('../services/dashboardOwnerBootstrapService');

module.exports = {
  name: 'guildCreate',
  once: false,
  async execute(guild) {
    console.log(`✅ Bot joined guild: ${guild.name} (${guild.id})`);

    try {
      await pool.query(
        `WITH inserted AS (
           INSERT INTO guilds (discord_guild_id, name, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT(discord_guild_id) DO NOTHING
           RETURNING id
         )
         INSERT INTO guild_setup_state (guild_id, current_step, status, completed_steps)
         SELECT id, 'discord_connected', 'in_progress', '["discord_connected"]'::jsonb
           FROM inserted
         ON CONFLICT (guild_id) DO NOTHING`,
        [guild.id, guild.name]
      );
      console.log(`✅ Guild ${guild.name} auto-registered in database`);
      const ownerBootstrap = await bootstrapConfiguredDashboardOwner(guild);
      if (ownerBootstrap.status === 'assigned') {
        console.log('✅ Configured Dashboard Owner authorized from Discord guild membership');
      } else if (ownerBootstrap.status === 'owner_conflict') {
        console.error('❌ Configured Dashboard Owner conflicts with the existing Dashboard Owner');
      }
    } catch (err) {
      console.error('❌ Error auto-registering guild:', err);
    }
  }
};
