'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const commandPath = path.join(root, 'bot', 'commands', 'link-admin.js');
assert.ok(fs.existsSync(commandPath), 'moderator link-management command is missing');
const source = fs.readFileSync(commandPath, 'utf8');
const authorization = fs.readFileSync(path.join(root, 'bot', 'utils', 'commandAuthorization.js'), 'utf8');
const currentMember = fs.readFileSync(path.join(root, 'bot', 'utils', 'currentDiscordMember.js'), 'utf8');

assert.match(source, /setName\('link-admin'\)/);
assert.match(source, /setName\('force-link'\)/);
assert.match(source, /setName\('force-unlink'\)/);
assert.match(source, /interaction\.authorizedServerId/);
assert.match(source, /fetchCurrentGuildMember\(interaction\.guild, target\.id\)/,
  'force-link must verify the target is still a member of the exact Discord guild');
assert.match(currentMember, /members\.fetch\(\{ user: String\(discordUserId\), force: true \}\)/,
  'force-link membership verification must bypass stale Discord member cache');
assert.match(source, /s\.id = \$\d/);
assert.match(source, /g\.discord_guild_id = \$\d/);
assert.match(source, /s\.status = 'active'/);
assert.match(source, /g\.status = 'approved'/);
assert.match(source, /FOR UPDATE OF s, g/,
  'force mutations must re-lock the exact active server and approved guild inside the transaction');
assert.match(source, /verification_method[^\n]*admin_approved|admin_approved[^\n]*verification_method/);
assert.match(source, /security_audit_events/);
assert.match(source, /player_link\.force_link/);
assert.match(source, /player_link\.force_unlink/);
assert.match(source, /enqueueRoleReconciliationJob/);
assert.doesNotMatch(source, /DELETE FROM linked_accounts/,
  'exact-server force-unlink must retain global ownership proof');
assert.match(authorization, /'link-admin': 'server_moderate'/);
assert.match(authorization, /guild_role/,
  'guild owner/admin authority must count as above moderator for bot commands');

console.log('✅ Moderator force-link and force-unlink command contracts passed');
