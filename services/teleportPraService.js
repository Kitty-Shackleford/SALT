'use strict';

const missionFileService = require('./missionFileService');
const { buildPraFile, praFilePath, registerPraPath, unregisterPraPath } = require('../utils/teleportPolicy');

async function readGameplay(fileService, platformServerId, missionDir, token) {
  for (const name of ['cfggameplay.json', 'cfgGameplay.json']) {
    const filePath = `${missionDir}/${name}`;
    const raw = await fileService.downloadFileFromServer(platformServerId, filePath, token);
    if (raw !== null && raw !== undefined) return { filePath, name, raw };
  }
  throw new Error('cfggameplay.json not found in the active mission');
}

async function provisionPraTeleport({
  platformServerId,
  token,
  missionDir,
  requestId,
  sourcePosition,
  destinationPosition,
  triggerSize,
  fileService = missionFileService,
}) {
  if (!platformServerId || !token || !missionDir) {
    throw new Error('Teleport PRA provisioning context is incomplete');
  }
  const relativePath = praFilePath(requestId);
  const remotePraPath = `${missionDir}/${relativePath}`;
  const praContent = JSON.stringify(buildPraFile({
    requestId, sourcePosition, destinationPosition, triggerSize,
  }), null, 2);
  const existingPra = await fileService.downloadFileFromServer(platformServerId, remotePraPath, token);
  if (existingPra !== null && existingPra !== undefined && existingPra !== praContent) {
    throw new Error('Teleport PRA file already exists with different content');
  }

  const gameplay = await readGameplay(fileService, platformServerId, missionDir, token);
  let root;
  try {
    root = JSON.parse(gameplay.raw);
  } catch (error) {
    throw new Error(`Cannot update malformed cfggameplay.json: ${error.message}`);
  }
  const gameplayContent = JSON.stringify(registerPraPath(root, relativePath), null, 2);
  const gameplayDir = gameplay.filePath.slice(0, gameplay.filePath.lastIndexOf('/'));
  let praCreated = false;
  let gameplayChanged = false;
  try {
    if (existingPra === null || existingPra === undefined) {
      await fileService.uploadFileToServer(
        platformServerId, `${missionDir}/pra`, relativePath.slice(4), praContent, token
      );
      praCreated = true;
    }
    const verifiedPra = await fileService.downloadFileFromServer(platformServerId, remotePraPath, token);
    if (verifiedPra !== praContent) throw new Error('Teleport PRA file verification failed');

    if (gameplayContent !== gameplay.raw) {
      await fileService.uploadFileToServer(
        platformServerId, gameplayDir, gameplay.name, gameplayContent, token
      );
      gameplayChanged = true;
    }
    const verifiedGameplay = await fileService.downloadFileFromServer(
      platformServerId, gameplay.filePath, token
    );
    if (verifiedGameplay !== gameplayContent) {
      throw new Error('Teleport cfggameplay.json verification failed');
    }
  } catch (error) {
    if (gameplayChanged) {
      await fileService.uploadFileToServer(
        platformServerId, gameplayDir, gameplay.name, gameplay.raw, token
      ).catch(() => {});
    }
    if (praCreated) {
      await fileService.deleteFileFromServer(platformServerId, remotePraPath, token).catch(() => {});
    }
    throw error;
  }

  return { praFilePath: relativePath, remotePraPath, gameplayPath: gameplay.filePath };
}

async function cleanupPraTeleport({
  platformServerId,
  token,
  missionDir,
  requestId,
  fileService = missionFileService,
}) {
  if (!platformServerId || !token || !missionDir) {
    throw new Error('Teleport PRA cleanup context is incomplete');
  }
  const relativePath = praFilePath(requestId);
  const remotePraPath = `${missionDir}/${relativePath}`;
  const gameplay = await readGameplay(fileService, platformServerId, missionDir, token);
  let root;
  try {
    root = JSON.parse(gameplay.raw);
  } catch (error) {
    throw new Error(`Cannot update malformed cfggameplay.json: ${error.message}`);
  }
  const gameplayContent = JSON.stringify(unregisterPraPath(root, relativePath), null, 2);
  const gameplayDir = gameplay.filePath.slice(0, gameplay.filePath.lastIndexOf('/'));
  const existingPra = await fileService.downloadFileFromServer(
    platformServerId, remotePraPath, token
  );
  let gameplayChanged = false;
  let praDeleted = false;
  try {
    if (gameplayContent !== gameplay.raw) {
      await fileService.uploadFileToServer(
        platformServerId, gameplayDir, gameplay.name, gameplayContent, token
      );
      gameplayChanged = true;
    }
    const verifiedGameplay = await fileService.downloadFileFromServer(
      platformServerId, gameplay.filePath, token
    );
    if (verifiedGameplay !== gameplayContent) {
      throw new Error('Teleport cfggameplay.json cleanup verification failed');
    }
    if (existingPra !== null && existingPra !== undefined) {
      await fileService.deleteFileFromServer(platformServerId, remotePraPath, token);
      praDeleted = true;
    }
    const verifiedPra = await fileService.downloadFileFromServer(
      platformServerId, remotePraPath, token
    );
    if (verifiedPra !== null && verifiedPra !== undefined) {
      throw new Error('Teleport PRA file cleanup verification failed');
    }
  } catch (error) {
    if (praDeleted) {
      await fileService.uploadFileToServer(
        platformServerId, `${missionDir}/pra`, relativePath.slice(4), existingPra, token
      ).catch(() => {});
    }
    if (gameplayChanged) {
      await fileService.uploadFileToServer(
        platformServerId, gameplayDir, gameplay.name, gameplay.raw, token
      ).catch(() => {});
    }
    throw error;
  }
  return { praFilePath: relativePath, remotePraPath, gameplayPath: gameplay.filePath };
}

module.exports = { provisionPraTeleport, cleanupPraTeleport };
