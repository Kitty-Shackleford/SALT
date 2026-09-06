const { getPublicConfig, getListenHost } = require('./publicConfig');
const {
  configuredDashboardOwnerId,
  DASHBOARD_OWNER_ENV,
} = require('./configuredDashboardOwner');

const REQUIRED_BY_MODE = {
  web: [
    'DISCORD_CLIENT_ID',
    'DISCORD_CLIENT_SECRET',
    'SESSION_SECRET',
    'ENCRYPTION_KEY',
    'PORT',
    'POSTGRES_PASSWORD'
  ],
  bot: [
    'DISCORD_CLIENT_ID',
    'DISCORD_BOT_TOKEN',
    'ENCRYPTION_KEY',
    'POSTGRES_PASSWORD'
  ],
  database: ['POSTGRES_PASSWORD']
};

function validateEnv(mode = 'web') {
  console.log('🔍 Validating environment variables...');

  const requiredEnvVars = REQUIRED_BY_MODE[mode];
  if (!requiredEnvVars) {
    throw new Error(`Unknown environment validation mode: ${mode}`);
  }

  const missing = requiredEnvVars.filter(v => !process.env[v]);

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(v => console.error(`   - ${v}`));
    process.exit(1);
  }

  if (mode !== 'database') {
    if (!/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_KEY)) {
      console.error('❌ ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes)');
      console.error('   Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
      process.exit(1);
    }

    if (!/^\d{17,19}$/.test(process.env.DISCORD_CLIENT_ID)) {
      console.error('❌ DISCORD_CLIENT_ID format is invalid (should be 17-19 digits)');
      process.exit(1);
    }

    if (process.env[DASHBOARD_OWNER_ENV] && !configuredDashboardOwnerId()) {
      console.error(`❌ ${DASHBOARD_OWNER_ENV} format is invalid (should be 17-19 digits)`);
      process.exit(1);
    }
  }

  if (mode === 'web') {
    if (process.env.SESSION_SECRET.length < 32) {
      console.error('❌ SESSION_SECRET must be at least 32 characters long');
      process.exit(1);
    }

    let publicConfig;
    try {
      publicConfig = getPublicConfig();
    } catch (error) {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    }

    if (publicConfig.deploymentMode === 'bot') {
      console.error('❌ The website cannot start when DEPLOYMENT_MODE=bot');
      process.exit(1);
    }
    if (publicConfig.deploymentMode === 'local') {
      if (process.env.NODE_ENV === 'production') {
        console.error('❌ DEPLOYMENT_MODE=local cannot run with NODE_ENV=production');
        process.exit(1);
      }
      if (process.env.SESSION_SECURE_COOKIE === 'true') {
        console.error('❌ DEPLOYMENT_MODE=local requires SESSION_SECURE_COOKIE=false for local HTTP');
        process.exit(1);
      }
      const listenHost = getListenHost(process.env);
      const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);
      if (!loopbackHosts.has(listenHost) && process.env.LOCAL_CONTAINER_RUNTIME !== 'true') {
        console.error('❌ Direct local mode must bind LISTEN_HOST to a loopback address');
        process.exit(1);
      }
    }
    if (process.env.NODE_ENV === 'production') {
      if (!publicConfig.dashboardUrl) {
        console.error('❌ DASHBOARD_URL is required for the production website');
        process.exit(1);
      }
      if (process.env.SESSION_SECURE_COOKIE !== 'true') {
        console.error('❌ SESSION_SECURE_COOKIE=true is required for the production website');
        process.exit(1);
      }
      if (process.env.RATE_LIMIT_ENABLED !== 'true') {
        console.error('❌ RATE_LIMIT_ENABLED=true is required for the production website');
        process.exit(1);
      }
    }
  }

  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'development';
    console.log('ℹ️  NODE_ENV not set, defaulting to: development');
  }

  if (process.env.DB_TYPE && !['postgres', 'postgresql'].includes(process.env.DB_TYPE)) {
    console.error('❌ PostgreSQL is the only supported database. Remove DB_TYPE or set it to postgres.');
    process.exit(1);
  }

  if (!process.env.POSTGRES_HOST) {
    process.env.POSTGRES_HOST = 'localhost';
    console.log('ℹ️  POSTGRES_HOST not set, defaulting to: localhost');
  }
  if (!process.env.POSTGRES_PORT) {
    process.env.POSTGRES_PORT = '5432';
    console.log('ℹ️  POSTGRES_PORT not set, defaulting to: 5432');
  }
  if (!process.env.POSTGRES_DB) {
    process.env.POSTGRES_DB = 'dayz-dashboard';
    console.log('ℹ️  POSTGRES_DB not set, defaulting to: dayz-dashboard');
  }
  if (!process.env.POSTGRES_USER) {
    process.env.POSTGRES_USER = 'dayz-dashboard';
    console.log('ℹ️  POSTGRES_USER not set, defaulting to: dayz-dashboard');
  }
  if (!process.env.POSTGRES_SSL) {
    process.env.POSTGRES_SSL = 'false';
  }

  if (!/^\d+$/.test(process.env.POSTGRES_PORT)) {
    console.error('❌ POSTGRES_PORT must be a numeric value');
    process.exit(1);
  }

  console.log('✅ All required environment variables present and valid');
  console.log(`   Validation mode: ${mode}`);
  console.log(`   Environment: ${process.env.NODE_ENV}`);
  console.log('   Database type: postgres');
  console.log(`   PostgreSQL target: ${process.env.POSTGRES_USER}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT}/${process.env.POSTGRES_DB}`);
}

module.exports = { REQUIRED_BY_MODE, validateEnv };
