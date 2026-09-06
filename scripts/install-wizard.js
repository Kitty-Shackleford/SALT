#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

async function main() {
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) {
    console.log('.env already exists — leaving it alone and using its values.');
    return;
  }

  console.log('Interactive install wizard — create a .env file for DayZ Dashboard');
  const cfg = {};

  cfg.NODE_ENV = 'production';
  cfg.RATE_LIMIT_ENABLED = 'true';
  cfg.SESSION_SECURE_COOKIE = 'true';
  cfg.DEPLOYMENT_MODE = (await prompt('DEPLOYMENT_MODE [full|bot] [full]: ') || 'full').toLowerCase();
  if (!['full', 'bot'].includes(cfg.DEPLOYMENT_MODE)) {
    throw new Error('DEPLOYMENT_MODE must be full or bot');
  }

  cfg.DISCORD_CLIENT_ID = await prompt('DISCORD_CLIENT_ID: ');
  cfg.DISCORD_BOT_TOKEN = await prompt('DISCORD_BOT_TOKEN: ');
  cfg.DISCORD_GUILD_ID = await prompt('DISCORD_GUILD_ID (optional): ');
  cfg.ENCRYPTION_KEY = await prompt('ENCRYPTION_KEY (64 hex chars) [leave blank to auto-generate]: ');
  if (!cfg.ENCRYPTION_KEY) cfg.ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');

  if (cfg.DEPLOYMENT_MODE === 'full') {
    cfg.DISCORD_CLIENT_SECRET = await prompt('DISCORD_CLIENT_SECRET: ');
    cfg.SESSION_SECRET = await prompt('SESSION_SECRET (32+ chars) [leave blank to auto-generate]: ');
    if (!cfg.SESSION_SECRET) cfg.SESSION_SECRET = require('crypto').randomBytes(32).toString('hex');
    cfg.APP_NAME = await prompt('APP_NAME [DayZ Dashboard]: ') || 'DayZ Dashboard';
    cfg.DASHBOARD_URL = await prompt('DASHBOARD_URL (e.g. https://dashboard.example.com): ');
    cfg.PLAYER_PORTAL_URL = await prompt('PLAYER_PORTAL_URL [same as dashboard]: ') || cfg.DASHBOARD_URL;
    cfg.DISCORD_INVITE_URL = await prompt('DISCORD_INVITE_URL (optional): ');
  }

  cfg.POSTGRES_HOST = await prompt('POSTGRES_HOST [localhost]: ') || 'localhost';
  cfg.POSTGRES_PORT = await prompt('POSTGRES_PORT [5432]: ') || '5432';
  cfg.POSTGRES_DB = await prompt('POSTGRES_DB [dayz-dashboard]: ') || 'dayz-dashboard';
  cfg.POSTGRES_USER = await prompt('POSTGRES_USER [dayz-dashboard]: ') || 'dayz-dashboard';
  cfg.POSTGRES_PASSWORD = await prompt('POSTGRES_PASSWORD [leave blank to auto-generate]: ');
  if (!cfg.POSTGRES_PASSWORD) cfg.POSTGRES_PASSWORD = require('crypto').randomBytes(24).toString('hex');
  cfg.POSTGRES_SSL = await prompt('POSTGRES_SSL [false]: ') || 'false';
  cfg.PORT = await prompt('PORT [3000]: ') || '3000';

  const parts = Object.entries(cfg).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(envPath, parts.join('\n') + '\n', { mode: 0o600 });
  console.log(`.env written to ${envPath} (permissions 600).`);
}

main().catch(err => { console.error(err); process.exit(1); });
