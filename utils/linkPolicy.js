'use strict';

const VERIFICATION_MODES = Object.freeze(['admin_approval', 'emote', 'open']);
const DEFAULT_LINK_SETTINGS = Object.freeze({
  verificationMode: 'admin_approval',
  roles: Object.freeze({
    assignOnJoin: [],
    assignOnLink: [],
    removeOnLink: [],
    removeOnLeave: [],
  }),
});

function parseLinkSettings(config) {
  let parsed = config;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  const configuredRoles = parsed.roles && typeof parsed.roles === 'object'
    ? parsed.roles
    : {};
  const normalizeRoles = value => Array.isArray(value)
    ? [...new Set(value.map(String).filter(Boolean))]
    : [];
  const requestedMode = String(parsed.verificationMode || '');
  const verificationMode = VERIFICATION_MODES.includes(requestedMode)
    ? requestedMode
    : (parsed.emoteVerificationEnabled === true ? 'emote' : 'admin_approval');

  return {
    verificationMode,
    roles: {
      assignOnJoin: normalizeRoles(configuredRoles.assignOnJoin),
      assignOnLink: normalizeRoles(configuredRoles.assignOnLink),
      removeOnLink: normalizeRoles(configuredRoles.removeOnLink),
      removeOnLeave: normalizeRoles(configuredRoles.removeOnLeave),
    },
  };
}

module.exports = { DEFAULT_LINK_SETTINGS, VERIFICATION_MODES, parseLinkSettings };
