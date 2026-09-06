'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  classifyNitradoHostname,
  nitradoHostnameValue,
  normalizeNitradoHostname,
} = require('../utils/serverNames');
const { isConsolePlatform } = require('../utils/dayzPlatform');

function run() {
  const invisible = '\u0001'.repeat(80);

  assert.strictEqual(normalizeNitradoHostname('  Chernarus PvP  '), 'Chernarus PvP');
  assert.throws(() => normalizeNitradoHostname('bad\u0001name'), /printable/i);
  assert.throws(() => normalizeNitradoHostname('x'.repeat(81)), /80 characters or fewer/i);
  assert.strictEqual(nitradoHostnameValue('visible', 'Chernarus PvP'), 'Chernarus PvP');
  assert.strictEqual(nitradoHostnameValue('invisible'), invisible);
  assert.throws(() => nitradoHostnameValue('other', 'Name'), /mode/i);
  for (const platform of ['xbox', 'playstation', 'switch2']) {
    assert.strictEqual(isConsolePlatform(platform), true, `${platform} must support console hostname mode`);
  }
  assert.strictEqual(isConsolePlatform('pc'), false, 'PC must not be treated as a console platform');
  assert.deepStrictEqual(classifyNitradoHostname(invisible), {
    mode: 'invisible',
    hostname: null,
  });
  assert.deepStrictEqual(classifyNitradoHostname('Chernarus PvP'), {
    mode: 'visible',
    hostname: 'Chernarus PvP',
  });
  assert.deepStrictEqual(classifyNitradoHostname('\u0002hidden'), {
    mode: 'unsupported',
    hostname: null,
  });

  const root = path.join(__dirname, '..');
  const route = fs.readFileSync(path.join(root, 'routes/nitrado.js'), 'utf8');
  const settingsRoute = fs.readFileSync(path.join(root, 'routes/nitradoSettings.js'), 'utf8');
  const page = fs.readFileSync(path.join(root, 'public/dashboard/settings.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'public/js/nitrado-settings.js'), 'utf8');
  assert(route.includes("router.get('/account-servers/:serviceId/naming', ensurePlatformServerOwner"));
  assert(route.includes("router.put('/account-servers/:serviceId/display-name', ensurePlatformServerOwner"));
  assert(route.includes("router.put('/account-servers/:serviceId/hostname', ensurePlatformServerOwner"));
  assert(route.includes("gr.role IN ('owner', 'admin')"));
  assert(route.includes("sra.role = 'admin'"));
  const settingMutationService = fs.readFileSync(
    path.join(root, 'services/providerSettingMutationService.js'), 'utf8'
  );
  assert(route.includes('mutateProviderSettings({'));
  assert(route.includes("allowedPlatforms: ['xbox', 'playstation', 'switch2']"));
  assert(settingMutationService.includes('provider.updateSetting(token, platformServerId, category, key, value)'));
  assert(settingMutationService.includes('Provider setting verification failed'));
  assert(settingsRoute.includes("category === 'config' && key === 'hostname'"));
  assert(page.includes('id="serverDisplayName"'));
  assert(page.includes('id="nitradoHostname"'));
  assert(page.includes('id="invisibleHostname"'));
  assert(page.includes('All console platforms'));
  assert(page.includes('dashboard, shop, and Discord bot'));
  assert(client.includes('/display-name'));
  assert(client.includes('/hostname'));
  assert(client.includes('supportsInvisibleHostname'));

  const guildsRoute = fs.readFileSync(path.join(root, 'routes/guilds.js'), 'utf8');
  const controlRoute = fs.readFileSync(path.join(root, 'routes/serverControl.js'), 'utf8');
  const nitradoService = fs.readFileSync(path.join(root, 'services/nitradoService.js'), 'utf8');
  assert(guildsRoute.includes('server_name: display'), 'guild server response must not retain a raw name');
  assert(controlRoute.includes('normalizeProviderServerName(details.name, platformServerId)'));
  assert(route.includes('name: normalizeProviderServerName(service.name, service.id)'));
  assert(nitradoService.includes('name: normalizeProviderServerName('),
    'shared Nitrado response normalization must remove control-character names');

  const botNitrado = fs.readFileSync(path.join(root, 'bot/utils/nitrado.js'), 'utf8');
  assert(botNitrado.includes('serverName: name'), 'bot must use the persisted dashboard display name');

  console.log('Server naming settings tests passed');
}

run();
