'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const routePath = path.join(root, 'routes', 'linkSettings.js');
const authorizationPath = path.join(root, 'services', 'linkSettingsAuthorization.js');
const frontendPath = path.join(root, 'public', 'js', 'nitrado-settings.js');
const htmlPath = path.join(root, 'public', 'dashboard', 'settings.html');

assert.ok(fs.existsSync(routePath), 'dashboard link-settings API route is missing');
const route = fs.readFileSync(routePath, 'utf8');
const authorization = fs.readFileSync(authorizationPath, 'utf8');
const frontend = fs.readFileSync(frontendPath, 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');

assert.match(route, /requireServerCapability\(CAPABILITIES\.SERVER_MANAGE\)/,
  'every link-policy request must require exact-server management authority');
assert.match(route, /router\.get\('\/:serverId'/);
assert.match(route, /router\.put\('\/:serverId'/);
assert.match(route, /parseLinkSettings/);
assert.match(route, /security_audit_events/,
  'link-policy changes must be audited');
assert.match(route, /\['admin_approval', 'emote', 'open'\]/,
  'API must allow only the three defined modes');
assert.doesNotMatch(route, /req\.body\.guildId/,
  'link-policy authorization must not trust a client guild ID');
assert.match(route, /lockAndVerifyLinkSettingsManager/);
const dashboardActorLock = authorization.indexOf('lockUserRoleMutations');
const dashboardScopeLock = authorization.indexOf('FOR UPDATE OF s, g');
assert.ok(dashboardActorLock >= 0 && dashboardActorLock < dashboardScopeLock,
  'dashboard policy mutation must lock the actor before scope and authority rows');

assert.match(html, /id="linkVerificationMode"/);
assert.match(html, /Admin\/moderator approval/);
assert.match(html, /Emote verification/);
assert.match(html, /Open self-link/);
assert.match(frontend, /\/api\/link-settings\/\$\{internalServerId\}/);
assert.match(frontend, /fetchWithCsrf/);
assert.match(frontend, /dataset\.internalServerId/);
assert.match(frontend, /response\.status === 403/,
  'dashboard must hide policy controls from users who cannot manage the server');

console.log('✅ Dashboard player-link policy contract tests passed');
