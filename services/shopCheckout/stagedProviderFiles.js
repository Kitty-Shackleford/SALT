'use strict';

function providerPath(dirPath, fileName) {
  return `${String(dirPath).replace(/\/$/, '')}/${String(fileName).replace(/^\//, '')}`;
}

function createStagedProviderFiles(snapshots) {
  if (!(snapshots instanceof Map)) {
    throw new TypeError('Staged provider files require durable provider snapshots');
  }

  const original = new Map(snapshots);
  const current = new Map(snapshots);

  function assertPlanned(filePath) {
    if (!original.has(filePath)) {
      throw new Error('Provider file was not included in the durable provider plan: ' + filePath);
    }
  }

  const fileService = {
    async downloadFileFromServer(_serverId, filePath) {
      assertPlanned(filePath);
      return current.get(filePath);
    },

    async uploadFileToServer(_serverId, dirPath, fileName, content) {
      const filePath = providerPath(dirPath, fileName);
      assertPlanned(filePath);
      current.set(filePath, content);
    },

    async deleteFileFromServer(_serverId, filePath) {
      assertPlanned(filePath);
      current.set(filePath, null);
    },
  };

  async function flush(destination, platformServerId, token) {
    if (!destination || typeof destination.uploadFileToServer !== 'function') {
      throw new TypeError('Staged provider destination is required');
    }
    const changedPaths = [];
    for (const [filePath, content] of current) {
      if (content === original.get(filePath)) continue;
      const lastSlash = filePath.lastIndexOf('/');
      if (content === null || content === undefined) {
        if (typeof destination.deleteFileFromServer !== 'function') {
          throw new TypeError('Staged provider destination cannot delete files');
        }
        await destination.deleteFileFromServer(platformServerId, filePath, token);
      } else {
        await destination.uploadFileToServer(
          platformServerId,
          filePath.slice(0, lastSlash),
          filePath.slice(lastSlash + 1),
          content,
          token
        );
      }
      changedPaths.push(filePath);
    }
    return changedPaths;
  }

  return { fileService, flush };
}

module.exports = { createStagedProviderFiles };
