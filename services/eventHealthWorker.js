'use strict';

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { parentPort, workerData } = require('worker_threads');
const { parseEventHealthLines } = require('./eventHealthService');

function* readVerifiedRptLines(filePath, expectedStat, expectedRoot, maxBytes, maxLineBytes) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(filePath, flags);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== expectedStat.dev || stat.ino !== expectedStat.ino ||
        stat.size !== expectedStat.size) {
      throw new Error('RPT file changed before parsing');
    }
    const descriptorPath = fs.realpathSync(`/proc/self/fd/${fd}`);
    if (descriptorPath !== expectedRoot && !descriptorPath.startsWith(expectedRoot + path.sep)) {
      throw new Error('RPT file resolved outside the server download directory');
    }
    if (stat.size > maxBytes) throw new Error(`RPT exceeds the ${maxBytes} byte event-health limit`);

    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, expectedStat.size)));
    let position = 0;
    let remainder = '';
    while (position < expectedStat.size) {
      const bytesRead = fs.readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, expectedStat.size - position),
        position
      );
      if (bytesRead === 0) throw new Error('RPT file changed before parsing');
      position += bytesRead;
      remainder += decoder.write(buffer.subarray(0, bytesRead));
      let newlineIndex = remainder.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = remainder.slice(0, newlineIndex).replace(/\r$/, '');
        if (Buffer.byteLength(line) > maxLineBytes) {
          throw new Error(`RPT line exceeds the ${maxLineBytes} byte event-health limit`);
        }
        yield line;
        remainder = remainder.slice(newlineIndex + 1);
        newlineIndex = remainder.indexOf('\n');
      }
      if (Buffer.byteLength(remainder) > maxLineBytes) {
        throw new Error(`RPT line exceeds the ${maxLineBytes} byte event-health limit`);
      }
    }
    remainder += decoder.end();
    if (Buffer.byteLength(remainder) > maxLineBytes) {
      throw new Error(`RPT line exceeds the ${maxLineBytes} byte event-health limit`);
    }
    yield remainder.replace(/\r$/, '');
  } finally {
    fs.closeSync(fd);
  }
}

try {
  const lines = readVerifiedRptLines(
    workerData.filePath,
    workerData.expectedStat,
    workerData.expectedRoot,
    workerData.maxBytes,
    workerData.maxLineBytes
  );
  const result = parseEventHealthLines(lines, {
    fileName: workerData.fileName,
    configuredEvents: workerData.configuredEvents,
    sessionStartedAtMs: workerData.sessionStartedAtMs,
  });
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: error.message || 'Failed to parse RPT' });
}
