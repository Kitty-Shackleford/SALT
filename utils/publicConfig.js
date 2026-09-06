'use strict';

const VALID_DEPLOYMENT_MODES = new Set(['full', 'bot', 'local']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function getDeploymentMode(env = process.env) {
  const deploymentMode = String(env.DEPLOYMENT_MODE || 'full').trim().toLowerCase();
  if (!VALID_DEPLOYMENT_MODES.has(deploymentMode)) {
    throw new Error('DEPLOYMENT_MODE must be full, bot, or local');
  }
  return deploymentMode;
}

function getListenHost(env = process.env) {
  const defaultHost = getDeploymentMode(env) === 'local' ? '127.0.0.1' : '0.0.0.0';
  return String(env.LISTEN_HOST || defaultHost).trim().toLowerCase();
}

function normalizePublicUrl(value, name) {
  if (!value) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${name} must be an absolute http(s) URL without credentials`);
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function normalizePublicOrigin(value, name) {
  const normalized = normalizePublicUrl(value, name);
  if (!normalized) return null;

  if (new URL(normalized).pathname !== '/') {
    throw new Error(`${name} must be an origin without a path`);
  }
  return normalized;
}

function requireLocalOrigin(value, name) {
  if (!value) throw new Error(`${name} is required when DEPLOYMENT_MODE=local`);
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`${name} must use HTTP on localhost, 127.0.0.1, or [::1] when DEPLOYMENT_MODE=local`);
  }
}

function getPublicConfig(env = process.env) {
  const deploymentMode = getDeploymentMode(env);

  const developmentUrl = env.NODE_ENV === 'production' ? null : `http://localhost:${env.PORT || '3000'}`;
  const dashboardUrl = normalizePublicOrigin(env.DASHBOARD_URL || env.BASE_URL || developmentUrl, 'DASHBOARD_URL');
  const playerPortalUrl = normalizePublicOrigin(env.PLAYER_PORTAL_URL || dashboardUrl, 'PLAYER_PORTAL_URL');
  const discordInviteUrl = normalizePublicUrl(env.DISCORD_INVITE_URL, 'DISCORD_INVITE_URL');
  if (deploymentMode === 'local') {
    requireLocalOrigin(dashboardUrl, 'DASHBOARD_URL');
    requireLocalOrigin(playerPortalUrl, 'PLAYER_PORTAL_URL');
  }

  return {
    deploymentMode,
    websiteEnabled: deploymentMode !== 'bot',
    appName: (env.APP_NAME || 'DayZ Dashboard').trim() || 'DayZ Dashboard',
    dashboardUrl,
    playerPortalUrl,
    discordInviteUrl
  };
}

function selectRequestBaseUrl(host, config) {
  const normalizedHost = String(host || '').trim().toLowerCase();
  const candidates = [config.playerPortalUrl, config.dashboardUrl].filter(Boolean);
  const matched = candidates.find(value => new URL(value).host.toLowerCase() === normalizedHost);
  return matched || config.dashboardUrl || config.playerPortalUrl || null;
}

function hasDedicatedPlayerPortal(config) {
  return Boolean(
    config.playerPortalUrl &&
    (!config.dashboardUrl || config.playerPortalUrl !== config.dashboardUrl)
  );
}

function isPlayerPortalHost(host, config) {
  if (!hasDedicatedPlayerPortal(config)) return false;
  return new URL(config.playerPortalUrl).host.toLowerCase() === String(host || '').trim().toLowerCase();
}

function isPlayerPortalBaseUrl(baseUrl, config) {
  if (!hasDedicatedPlayerPortal(config) || !baseUrl) return false;
  return normalizePublicOrigin(baseUrl, 'authBaseUrl') === config.playerPortalUrl;
}

function appendPath(baseUrl, pathname) {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/$/, '')}/${String(pathname || '').replace(/^\//, '')}`;
}

module.exports = {
  VALID_DEPLOYMENT_MODES,
  getDeploymentMode,
  getListenHost,
  normalizePublicUrl,
  normalizePublicOrigin,
  requireLocalOrigin,
  getPublicConfig,
  selectRequestBaseUrl,
  hasDedicatedPlayerPortal,
  isPlayerPortalHost,
  isPlayerPortalBaseUrl,
  appendPath
};
