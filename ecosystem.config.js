require('dotenv').config();
const { getDeploymentMode } = require('./utils/publicConfig');

const deploymentMode = getDeploymentMode(process.env);
if (!['full', 'bot'].includes(deploymentMode)) {
  throw new Error('PM2 supports DEPLOYMENT_MODE=full or bot; use npm run local:up for local mode');
}

const backend = {
  name: 'dayz-dashboard-backend',
  cwd: './',
  script: 'npm',
  args: 'start',
  env: { NODE_ENV: 'production' },
  instances: 1,
  autorestart: true,
  max_memory_restart: '512M',
  watch: false,
  error_file: './logs/backend-err.log',
  out_file: './logs/backend-out.log',
  log_date_format: 'YYYY-MM-DD HH:mm Z'
};

const bot = {
  name: 'dayz-dashboard-bot',
  cwd: './bot',
  script: 'node',
  args: 'index.js',
  env: { NODE_ENV: 'production' },
  instances: 1,
  autorestart: true,
  max_memory_restart: '256M',
  watch: false,
  error_file: './logs/bot-err.log',
  out_file: './logs/bot-out.log',
  log_date_format: 'YYYY-MM-DD HH:mm Z'
};

module.exports = {
  apps: deploymentMode === 'bot' ? [bot] : [backend, bot]
};
