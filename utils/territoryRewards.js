// economyHelper currently unused here — keep the import for future features
// const economyHelper = require('./economyHelper');

const HOUR_IN_MS = 60 * 60 * 1000;

/**
 * Process territory rewards (run hourly via cron)
 *
 * NOTE: Territory rewards require a territory/base ownership system to be
 * implemented first. This is a placeholder for future integration.
 *
 * @param {object} db - Database instance
 */
async function processTerritoryRewards(db) {
  console.log('Processing territory rewards...');

  try {
    // Get all guilds with territory rewards enabled
    const guilds = await db.query(
      `SELECT guild_id, territory_reward_per_hour, currency_symbol
       FROM guild_economy_config
       WHERE enabled = TRUE AND territory_rewards_enabled = TRUE AND territory_reward_per_hour > 0`
    );

    for (const guild of guilds) {
      // TODO: Get territory flag ownership data
      // This would integrate with a territory/base ownership system
      // For now, this is a placeholder

      // Example logic:
      // const territories = await getTerritoryOwnersForGuild(db, guild.guildId);
      // for (const territory of territories) {
      //   const reward = guild.territoryRewardPerHour;
      //   await economyHelper.awardMoney(
      //     db,
      //     territory.ownerIdentityId,
      //     reward,
      //     'territory',
      //     `Territory control reward (${territory.flagCount} flags)`,
      //     null,
      //     { flagCount: territory.flagCount }
      //   );
      // }

      console.log(`Territory rewards processed for guild ${guild.guild_id}`);
    }

    console.log('Territory rewards processing complete');
  } catch (error) {
    console.error('Error processing territory rewards:', error);
  }
}

/**
 * Schedule territory rewards to run every hour
 *
 * @param {object} db - Database instance
 */
function startTerritoryRewardScheduler(db) {
  setInterval(() => {
    processTerritoryRewards(db);
  }, HOUR_IN_MS);

  // Run once on startup
  processTerritoryRewards(db);
}

module.exports = {
  processTerritoryRewards,
  startTerritoryRewardScheduler
};
