const economyHelper = require('./economyHelper');
const { startCasinoExpiryWorker } = require('../workers/casinoExpiryProcessor');

/**
 * Run daily scheduled economy tasks (bank fees and inactivity tax)
 */
async function runDailyTasks(db, businessDate = null) {
  console.log('=== Running daily economy tasks ===');
  const startTime = Date.now();

  try {
    if (!businessDate) {
      const clock = await db.get('SELECT CURRENT_DATE::text AS business_date');
      businessDate = clock?.business_date;
    }
    if (typeof businessDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      throw new Error('Could not resolve the PostgreSQL business date for daily economy tasks');
    }
    const bankFeeStats = await economyHelper.processDailyBankFees(db, businessDate);
    console.log('Bank fees:', bankFeeStats);

    const inactivityStats = await economyHelper.processInactivityTax(db, businessDate);
    console.log('Inactivity tax:', inactivityStats);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`=== Daily tasks completed in ${duration}s ===`);

    return { bankFeeStats, inactivityStats };

  } catch (error) {
    console.error('Error running daily tasks:', error);
    throw error;
  }
}

/**
 * Start economy-related scheduled tasks
 *
 * @param {object} db - Database instance
 */
function startEconomyScheduler(db) {
  console.log('Starting economy scheduler...');
  startCasinoExpiryWorker(db);

  const scheduleTime = new Date();
  scheduleTime.setUTCHours(0, 0, 0, 0);
  scheduleTime.setDate(scheduleTime.getDate() + 1);

  const msUntilMidnight = scheduleTime - Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  const runScheduledDailyTasks = () => {
    runDailyTasks(db).catch(error => {
      console.error('Scheduled daily economy tasks failed:', error);
    });
  };

  setTimeout(() => {
    runScheduledDailyTasks();

    setInterval(runScheduledDailyTasks, DAY_MS);
  }, msUntilMidnight);

  console.log(`Economy scheduler started. First run in ${(msUntilMidnight / 1000 / 60).toFixed(0)} minutes`);
}

/**
 * Manually trigger daily tasks (for testing or admin)
 *
 * @param {object} db - Database instance
 * @returns {Promise<object>} - Results from daily tasks
 */
async function triggerDailyTasks(db) {
  return runDailyTasks(db);
}

module.exports = {
  startEconomyScheduler,
  triggerDailyTasks
};
