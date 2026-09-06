'use strict';

function assertProviderListVerified(expectedLines, actualLines) {
  if (!Array.isArray(expectedLines) || !Array.isArray(actualLines) ||
      expectedLines.length !== actualLines.length ||
      expectedLines.some((line, index) => line !== actualLines[index])) {
    throw new Error('Provider list write verification failed');
  }
}

module.exports = { assertProviderListVerified };
