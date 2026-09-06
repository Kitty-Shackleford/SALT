'use strict';

const NITRADO_TOKEN_IDENTITY_URL = 'https://api.nitrado.net/user';
const { nitradoFetch } = require('./nitradoHttp');

function extractNitradoUserId(payload) {
  const userId = payload?.data?.user?.user_id;
  if (userId === undefined || userId === null || String(userId).trim() === '') {
    return null;
  }
  return String(userId);
}

async function fetchNitradoUserId(token, fetchImpl = nitradoFetch) {
  const response = await fetchImpl(NITRADO_TOKEN_IDENTITY_URL, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Nitrado identity request failed (${response.status})`);
  }
  const userId = extractNitradoUserId(await response.json());
  if (!userId) {
    throw new Error('Nitrado token identity did not include a user ID');
  }
  return userId;
}

module.exports = {
  NITRADO_TOKEN_IDENTITY_URL,
  extractNitradoUserId,
  fetchNitradoUserId,
};
