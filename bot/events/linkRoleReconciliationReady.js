'use strict';

const pool = require('../db');
const { drainRoleReconciliationJobs } = require('../../utils/linkRoleReconciler');

const POLL_INTERVAL_MS = 30 * 1000;

module.exports = {
  name: 'clientReady',
  once: true,
  async execute() {
    let running = false;
    const drain = async () => {
      if (running) return;
      running = true;
      try {
        await drainRoleReconciliationJobs({ db: pool });
      } catch (error) {
        console.error(`❌ Discord role reconciliation worker failed: ${error.message}`);
      } finally {
        running = false;
      }
    };

    await drain();
    const timer = setInterval(drain, POLL_INTERVAL_MS);
    timer.unref?.();
  },
};
