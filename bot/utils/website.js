'use strict';

const { appendPath, getPublicConfig } = require('../../utils/publicConfig');

function getWebsiteLink(pathname = '') {
  const config = getPublicConfig();
  if (!config.websiteEnabled) return null;
  const baseUrl = pathname.startsWith('/player')
    ? (config.playerPortalUrl || config.dashboardUrl)
    : config.dashboardUrl;
  return appendPath(baseUrl, pathname);
}

module.exports = { getWebsiteLink };
