'use strict';

const DEFAULT_SNAPSHOT_CONCURRENCY = 3;
const MAX_SNAPSHOT_CONCURRENCY = 8;
const MAX_SNAPSHOT_FILES = 32;

function normalizeConcurrency(value) {
  const parsed = Number(value ?? process.env.SHOP_CHECKOUT_SNAPSHOT_CONCURRENCY ?? DEFAULT_SNAPSHOT_CONCURRENCY);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_SNAPSHOT_CONCURRENCY) {
    throw new TypeError(`Shop snapshot concurrency must be between 1 and ${MAX_SNAPSHOT_CONCURRENCY}`);
  }
  return parsed;
}

async function captureProviderSnapshots({
  platformServerId,
  token,
  filePaths,
  fileService,
  concurrency,
}) {
  if (!Array.isArray(filePaths) || filePaths.length > MAX_SNAPSHOT_FILES) {
    throw new RangeError(`Shop checkout may snapshot at most ${MAX_SNAPSHOT_FILES} files`);
  }
  if (new Set(filePaths).size !== filePaths.length) {
    throw new TypeError('Shop checkout snapshot paths must be unique');
  }
  if (!fileService || typeof fileService.downloadFileFromServer !== 'function') {
    throw new TypeError('Shop checkout snapshot file service is required');
  }

  const workerCount = Math.min(normalizeConcurrency(concurrency), filePaths.length);
  const values = new Array(filePaths.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < filePaths.length) {
      const index = nextIndex++;
      values[index] = await fileService.downloadFileFromServer(
        platformServerId, filePaths[index], token
      );
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return new Map(filePaths.map((filePath, index) => [filePath, values[index]]));
}

module.exports = {
  DEFAULT_SNAPSHOT_CONCURRENCY,
  MAX_SNAPSHOT_FILES,
  captureProviderSnapshots,
  normalizeConcurrency,
};
