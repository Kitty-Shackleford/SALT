'use strict';

const assert = require('assert');
const { provisionPraTeleport, cleanupPraTeleport } = require('../services/teleportPraService');

(async () => {
  const files = new Map([
    ['/mission/cfggameplay.json', JSON.stringify({
      version: 123,
      WorldsData: { playerRestrictedAreaFiles: ['pra/warheadstorage.json'] },
    })],
  ]);
  const uploads = [];
  const fileService = {
    async downloadFileFromServer(_server, filePath) {
      return files.has(filePath) ? files.get(filePath) : null;
    },
    async uploadFileToServer(_server, dir, name, content) {
      const filePath = `${dir}/${name}`;
      uploads.push(filePath);
      files.set(filePath, content);
    },
    async deleteFileFromServer(_server, filePath) {
      files.delete(filePath);
    },
  };
  const result = await provisionPraTeleport({
    platformServerId: '123',
    token: 'secret',
    missionDir: '/mission',
    requestId: 42,
    sourcePosition: [100, 20, 200],
    destinationPosition: [300, 10, 400],
    fileService,
  });
  assert.deepStrictEqual(result, {
    praFilePath: 'pra/dayz-dashboard-teleport-42.json',
    remotePraPath: '/mission/pra/dayz-dashboard-teleport-42.json',
    gameplayPath: '/mission/cfggameplay.json',
  });
  assert.deepStrictEqual(uploads, [
    '/mission/pra/dayz-dashboard-teleport-42.json',
    '/mission/cfggameplay.json',
  ]);
  const gameplay = JSON.parse(files.get('/mission/cfggameplay.json'));
  assert.deepStrictEqual(gameplay.WorldsData.playerRestrictedAreaFiles, [
    'pra/warheadstorage.json',
    'pra/dayz-dashboard-teleport-42.json',
  ]);
  assert.deepStrictEqual(JSON.parse(files.get(result.remotePraPath)).safePositions3D, [[300, 10, 400]]);

  const cleanup = await cleanupPraTeleport({
    platformServerId: '123', token: 'secret', missionDir: '/mission', requestId: 42, fileService,
  });
  assert.deepStrictEqual(cleanup, {
    praFilePath: 'pra/dayz-dashboard-teleport-42.json',
    remotePraPath: '/mission/pra/dayz-dashboard-teleport-42.json',
    gameplayPath: '/mission/cfggameplay.json',
  });
  assert.strictEqual(files.has(result.remotePraPath), false);
  assert.deepStrictEqual(
    JSON.parse(files.get('/mission/cfggameplay.json')).WorldsData.playerRestrictedAreaFiles,
    ['pra/warheadstorage.json']
  );

  console.log('✅ Teleport PRA provisioning tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
