'use strict';

const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();

const assert = require('assert');
const {
  handleDestinationAutocomplete,
  destinationChoices,
  MAX_AUTOCOMPLETE_CHOICES,
} = require('../bot/utils/destinationAutocomplete');

(async () => {
  // --- Choices: cap at 25, name (map) — type format, search filter ---
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    name: `Spot ${i + 1}`,
    map_name: 'sakhal',
    destination_type: i % 2 === 0 ? 'named' : 'coords',
  }));
  const choices = destinationChoices(many, '');
  assert.strictEqual(choices.length, MAX_AUTOCOMPLETE_CHOICES,
    'autocomplete must be capped at Discord\'s 25-choice limit');
  assert.deepStrictEqual(choices[0], { name: 'Spot 1 (sakhal) — named', value: '1' },
    'choice names must be "name (map) — type" and values the destination ID');
  const filtered = destinationChoices(many, 'coords');
  assert(filtered.every(c => c.name.includes('coords')),
    'typing "coords" must filter to coordinate destinations');

  // --- IDOR guard: only the actor's authorized server+guild destinations ---
  const seenListParams = [];
  const db = {
    async query(sql, params) {
      // listAuthorizedCommandServers' query.
      return { rows: [{
        server_id: 41, guild_id: 7, platform_server_id: '15580969',
        server_role: 'moderator', server_role_status: 'active',
      }] };
    },
    async all(sql, params) {
      // listTeleportDestinations.
      seenListParams.push(params);
      assert.match(sql, /WHERE server_id = \? AND guild_id = \? AND is_active = TRUE/,
        'must list only active destinations scoped to the authorized server+guild');
      assert.deepStrictEqual(params, [41, 7],
        'destinations must be scoped to the actor\'s own authorized server+guild (IDOR guard)');
      // Include a destination from ANOTHER guild — it must not leak out because
      // the service query is already guild-scoped; assert the helper only sees
      // rows it was given.
      return [
        { id: 101, name: 'Base Camp', map_name: 'sakhal', destination_type: 'coords' },
        { id: 102, name: 'Old Spot', map_name: 'sakhal', destination_type: 'named' },
      ];
    },
  };
  let response;
  const interaction = {
    commandName: 'teleport',
    guildId: 'guild-7',
    user: { id: 'mod-user' },
    memberPermissions: { has: () => false },
    options: {
      getFocused: () => ({ name: 'destination', value: 'base' }),
      getString: () => null,
    },
    async respond(choices) { response = choices; },
  };
  const handled = await handleDestinationAutocomplete(interaction, db);
  assert.strictEqual(handled, true, 'destination focus must be handled here');
  assert.deepStrictEqual(response, [
    { name: 'Base Camp (sakhal) — coords', value: '101' },
  ], 'searching "base" must filter to only matching destinations');
  assert.deepStrictEqual(seenListParams, [[41, 7]],
    'the destination list must be fetched exactly once for the authorized scope');

  // An empty focus must return all (up to 25) destinations.
  response = null;
  interaction.options.getFocused = () => ({ name: 'destination', value: '' });
  await handleDestinationAutocomplete(interaction, db);
  assert.deepStrictEqual(response, [
    { name: 'Base Camp (sakhal) — coords', value: '101' },
    { name: 'Old Spot (sakhal) — named', value: '102' },
  ], 'empty focus must list all authorized destinations');

  // Non-destination focus must be ignored (defer to server autocomplete).
  response = null;
  interaction.options.getFocused = () => ({ name: 'server', value: 'x' });
  const ignored = await handleDestinationAutocomplete(interaction, db);
  assert.strictEqual(ignored, false, 'a non-destination focus must not be handled here');
  assert.strictEqual(response, null, 'must not respond to a server-focus autocomplete');

  console.log('✅ destination autocomplete (IDOR + cap) tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
