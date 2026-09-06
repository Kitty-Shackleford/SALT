'use strict';

const assert = require('assert');
const { loadCommands } = require('../bot/deploy-commands');
const { handleServerAutocomplete } = require('../bot/utils/serverAutocomplete');

function collectServerOptions(options, output = []) {
  for (const option of options || []) {
    if (option.name === 'server') output.push(option);
    collectServerOptions(option.options, output);
  }
  return output;
}

async function main() {
  const serverOptions = loadCommands().flatMap(command => collectServerOptions(command.options));
  assert(serverOptions.length > 0, 'expected deployed commands to expose server selectors');
  assert(serverOptions.every(option => option.autocomplete === true),
    'every server selector must use Discord autocomplete');
  assert(serverOptions.every(option => option.description === 'Choose a server by name'),
    'server selectors must explain the friendly-name workflow');

  const rows = [
    {
      server_id: 41,
      platform_server_id: '15580969',
      server_name: 'Provider Alpha',
      platform: 'xbox',
      custom_name_config: JSON.stringify({ value: 'Salt Creek' }),
      player_membership_id: 7,
    },
    {
      server_id: 52,
      platform_server_id: '28800123',
      server_name: 'Livonia PVE',
      platform: 'pc',
      custom_name_config: null,
      player_membership_id: null,
    },
  ];
  const db = {
    async query(sql, params) {
      assert(sql.includes("sf.feature_name = 'custom_name'"), 'autocomplete must load safe custom names');
      assert(sql.includes("g.status = 'approved'"), 'autocomplete must require an approved Discord guild');
      assert(sql.includes("s.status = 'active'"), 'autocomplete must return only active servers');
      assert.deepStrictEqual(params, ['guild-a', 'player-a']);
      return { rows };
    },
  };
  let response;
  const interaction = {
    commandName: 'economy',
    guildId: 'guild-a',
    user: { id: 'player-a' },
    memberPermissions: { has: () => false },
    options: {
      getFocused: () => ({ name: 'server', value: 'salt' }),
      getSubcommand: () => 'search',
      getSubcommandGroup: () => null,
    },
    async respond(choices) {
      response = choices;
    },
  };

  await handleServerAutocomplete(interaction, db);
  assert.deepStrictEqual(response, [{ name: 'Salt Creek • Xbox', value: '15580969' }],
    'players should see friendly names only for exact servers they can use');
  assert(!response[0].name.includes('15580969'), 'friendly labels must not expose provider IDs');

  response = null;
  interaction.options.getFocused = () => ({ name: 'player', value: 'salt' });
  await handleServerAutocomplete(interaction, db);
  assert.deepStrictEqual(response, [], 'autocomplete must ignore non-server options');

  console.log('✅ Bot friendly server autocomplete tests passed');
}

main().catch(error => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
