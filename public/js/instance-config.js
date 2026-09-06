'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const response = await fetch('/api/public-config');
    if (!response.ok) return;

    const config = await response.json();
    window.dayzDashboardConfig = Object.freeze(config);

    if (config.appName) {
      document.title = document.title.replace(/DayZ Dashboard/g, config.appName);
      document.querySelectorAll('[data-app-name]').forEach(element => {
        element.textContent = config.appName;
      });
    }
  } catch (error) {
    console.warn('Unable to load public instance configuration:', error.message);
  }
});
