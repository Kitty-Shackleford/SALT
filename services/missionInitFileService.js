'use strict';

const net = require('net');
const FormData = require('form-data');
const defaultHttp = require('../utils/nitradoHttp');
const {
  getNitradoBinaryBody,
  getNitradoTransferToken,
} = require('../utils/nitradoHttp');
const { createPublicAddressLookup, isPublicAddress } = require('../utils/publicAddressLookup');

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_METADATA_BYTES = 64 * 1024;

function invalidTransfer() {
  const error = new Error('Nitrado returned an invalid public file transfer URL');
  error.code = 'NITRADO_INVALID_RESPONSE';
  return error;
}

function hasControlCharacter(value) {
  return Array.from(value).some(character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function splitProviderFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length > 2048 ||
      !filePath.startsWith('/') || filePath.includes('\\') ||
      filePath.includes('?') || filePath.includes('#') || hasControlCharacter(filePath)) {
    throw new Error('Authorized mission init provider path is invalid');
  }
  const segments = filePath.slice(1).split('/');
  if (segments.length < 2 || segments.some(segment => !segment || segment === '.' || segment === '..') ||
      segments[segments.length - 1] !== 'init.c') {
    throw new Error('Authorized mission init provider path is invalid');
  }
  return {
    directory: `/${segments.slice(0, -1).join('/')}`,
    fileName: 'init.c',
  };
}

function createMissionInitFileService(options = {}) {
  const http = options.http || defaultHttp;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const metadataBytes = options.metadataBytes ?? DEFAULT_METADATA_BYTES;
  const publicAddressLookup = options.publicAddressLookup || createPublicAddressLookup();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      !Number.isSafeInteger(metadataBytes) || metadataBytes < 1) {
    throw new TypeError('Mission init transfer limits must be positive safe integers');
  }

  function validateContext(serverId, token) {
    if (!/^[1-9]\d*$/.test(String(serverId || '')) || typeof token !== 'string' || !token) {
      throw new TypeError('Mission init provider transfer context is invalid');
    }
  }

  function transferOptions(transferUrl, headers = {}) {
    let parsed;
    try {
      parsed = new URL(transferUrl);
    } catch (_) {
      throw invalidTransfer();
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        (net.isIP(hostname) && !isPublicAddress(hostname))) {
      throw invalidTransfer();
    }
    return {
      headers,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      maxRedirects: 0,
      proxy: false,
      lookup: publicAddressLookup,
    };
  }

  async function downloadFileFromServer(serverId, filePath, token) {
    validateContext(serverId, token);
    splitProviderFilePath(filePath);
    try {
      const metadata = await http.get(
        `https://api.nitrado.net/services/${serverId}/gameservers/file_server/download`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: { file: filePath },
          maxContentLength: metadataBytes,
          maxBodyLength: metadataBytes,
        }
      );
      const transfer = getNitradoTransferToken(metadata);
      const response = await http.get(transfer.url, {
        ...transferOptions(transfer.url),
        responseType: 'arraybuffer',
      });
      const bytes = Buffer.from(getNitradoBinaryBody(response));
      if (bytes.length > maxBytes) throw invalidTransfer();
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (_) {
        throw invalidTransfer();
      }
    } catch (error) {
      if (error?.response?.status === 404) return null;
      throw error;
    }
  }

  async function uploadFileToServer(serverId, directory, fileName, content, token) {
    validateContext(serverId, token);
    const filePath = `${directory}/${fileName}`;
    const validated = splitProviderFilePath(filePath);
    if (validated.directory !== directory || validated.fileName !== fileName ||
        typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > maxBytes) {
      throw new TypeError('Mission init upload payload is invalid');
    }
    const form = new FormData();
    form.append('path', directory);
    form.append('file', fileName);
    const metadata = await http.post(
      `https://api.nitrado.net/services/${serverId}/gameservers/file_server/upload`,
      form,
      {
        headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
        maxContentLength: metadataBytes,
        maxBodyLength: metadataBytes,
      }
    );
    const transfer = getNitradoTransferToken(metadata, { requireToken: true });
    await http.post(
      transfer.url,
      content,
      transferOptions(transfer.url, {
        token: transfer.token,
        'Content-Type': 'application/octet-stream',
      })
    );
  }

  async function deleteFileFromServer() {
    throw new Error('Mission init deployment does not support deleting init.c');
  }

  return { deleteFileFromServer, downloadFileFromServer, uploadFileToServer };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  createMissionInitFileService,
  splitProviderFilePath,
};
