const { Events } = require('discord.js');
const pool = require('../db');
const { parseLinkSettings } = require('../utils/linkSettings');
const { applyLinkRoleAutomation } = require('../utils/linkRoleAutomation');
const {
  enqueueRoleReconciliationJob,
  runRoleReconciliationJob,
} = require('../../utils/linkRoleReconciler');

async function applyGuildJoinRoles(member, db = pool) {
  const result = await db.query(
    `SELECT sf.config
     FROM server_features sf
     JOIN servers s ON s.id = sf.server_id
     JOIN guilds g ON g.id = s.guild_id
     WHERE g.discord_guild_id = $1
       AND g.status = 'approved'
       AND s.status = 'active'
       AND sf.feature_name = 'player_linking'
       AND sf.enabled = 1`,
    [member.guild.id]
  );

  const roleIds = new Set();
  for (const row of result.rows) {
    const settings = parseLinkSettings(row.config);
    for (const roleId of settings.roles.assignOnJoin) roleIds.add(roleId);
  }
  if (roleIds.size) {
    await applyLinkRoleAutomation(member, {
      roles: { assignOnJoin: [...roleIds] },
    }, 'join');
  }
}

module.exports = {
  name: Events.GuildMemberAdd,
  async execute(member, db = pool) {
    try {
      const userResult = await db.query(
        'SELECT id FROM users WHERE discord_id = $1 LIMIT 1',
        [member.id]
      );
      const userId = userResult.rows[0]?.id;
      if (userId) {
        try {
          const roleJob = await enqueueRoleReconciliationJob(db, {
            discordGuildId: member.guild.id,
            discordUserId: member.id,
            userId,
          });
          await runRoleReconciliationJob({
            db,
            job: roleJob,
            member,
          });
        } catch (error) {
          console.warn(`⚠️ Linked-role reconciliation remains queued for ${member.id}:`, error.message);
        }
      }
      await applyGuildJoinRoles(member, db);
    } catch (error) {
      console.error(`❌ Failed to apply join roles in guild ${member.guild.id}:`, error.message);
    }
  },
  applyGuildJoinRoles,
};
