'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function main() {
  const commandsDir = path.join(__dirname, '..', 'bot', 'commands');
  const commandFiles = fs.readdirSync(commandsDir).filter(name => name.endsWith('.js'));
  const commandNames = commandFiles
    .map(name => require(path.join(commandsDir, name)).data.name)
    .sort();
  const {
    COMMAND_CLASSES,
    authorizeGuildCommand,
    commandAuthorizationKey,
  } = require('../bot/utils/commandAuthorization');

  assert.strictEqual(commandAuthorizationKey('wipe-info', 'show', null), 'wipe-info:show');
  assert.strictEqual(commandAuthorizationKey('wipe-info', 'last', 'set'), 'wipe-info:set');
  assert.strictEqual(commandAuthorizationKey('wipe-info', 'clear', null), 'wipe-info:clear');

  for (const name of commandNames) {
    const classified = Object.keys(COMMAND_CLASSES).some(key => key === name || key.startsWith(`${name}:`));
    assert.ok(classified, `loaded command ${name} must have an explicit authorization classification`);
  }

  const db = {
    async query() {
      return {
        rows: [{
          server_id: 42,
          platform_server_id: '9001',
          server_role: null,
          server_role_status: null,
          player_membership_id: null,
        }],
      };
    },
  };

  assert.deepStrictEqual(
    await authorizeGuildCommand(db, 'guild', 'unknown', { discordUserId: 'user' }),
    { allowed: false }
  );
  assert.strictEqual((await authorizeGuildCommand(db, 'guild', 'register-token', {
    discordUserId: 'user',
    isDiscordAdministrator: false,
  })).allowed, false, 'registration must require Discord administrator authority');
  assert.strictEqual((await authorizeGuildCommand(db, 'guild', 'register-token', {
    discordUserId: 'user',
    isDiscordAdministrator: true,
  })).allowed, true);
  assert.strictEqual((await authorizeGuildCommand(db, 'guild', 'economy', {
    discordUserId: 'user', requestedServerId: '9001',
  })).allowed, false, 'player commands must require active exact-server membership');
  assert.strictEqual((await authorizeGuildCommand(db, 'guild', 'link', {
    discordUserId: 'user', requestedServerId: '9001',
  })).allowed, true, 'link must remain available before a membership exists');
  assert.strictEqual((await authorizeGuildCommand(db, 'guild', 'wipe-info:show', {
    discordUserId: 'user', requestedServerId: '9001',
  })).allowed, true, 'wipe-info show must remain public for an approved server');
  assert.strictEqual((await authorizeGuildCommand(db, 'guild', 'wipe-info:set', {
    discordUserId: 'user', requestedServerId: '9001', isDiscordAdministrator: false,
  })).allowed, false, 'wipe-info set must require server-management authority');
  assert.strictEqual((await authorizeGuildCommand(db, 'guild', 'wipe-info:clear', {
    discordUserId: 'user', requestedServerId: '9001', isDiscordAdministrator: false,
  })).allowed, false, 'wipe-info clear must require server-management authority');

  const roleDb = role => ({
    async query() {
      return { rows: [{
        server_id: 42,
        platform_server_id: '9001',
        guild_role: role.guildRole || null,
        server_role: role.serverRole || null,
        server_role_status: role.serverRole ? 'active' : null,
        player_membership_id: role.player ? 7 : null,
      }] };
    },
  });
  assert.strictEqual((await authorizeGuildCommand(roleDb({ guildRole: 'admin' }), 'guild', 'link-admin', {
    discordUserId: 'guild-admin', requestedServerId: '9001',
  })).allowed, true, 'guild admin must be able to force exact-server player links');
  assert.strictEqual((await authorizeGuildCommand(roleDb({ serverRole: 'moderator' }), 'guild', 'link-admin', {
    discordUserId: 'moderator', requestedServerId: '9001',
  })).allowed, true, 'exact-server moderator must be able to force player links');
  assert.strictEqual((await authorizeGuildCommand(roleDb({ player: true }), 'guild', 'link-admin', {
    discordUserId: 'player', requestedServerId: '9001',
  })).allowed, false, 'player must not be able to force player links');

  assert.strictEqual((await authorizeGuildCommand({
    async query() {
      return { rows: [{ server_id: 7, platform_server_id: '999', player_membership_id: 2 }] };
    },
  }, 'guild', 'economy', {
    discordUserId: 'player', requestedServerId: '7',
  })).allowed, false, 'Discord server option must not accept internal DB IDs');

  for (const file of commandFiles) {
    const commandSource = fs.readFileSync(path.join(commandsDir, file), 'utf8');
    for (const call of commandSource.match(/getServerCreds\([^)]*\)/g) || []) {
      assert.match(call, /interaction\.authorizedServerId/, `${file} does not bind credential lookup to authorized server`);
    }
  }

  console.log('✅ Discord command authorization classification tests passed');
}

main().catch(error => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
