const crypto = require('crypto');

const algorithm = 'aes-256-cbc';

// Ensure encryption key is properly configured
if (!process.env.ENCRYPTION_KEY) {
  throw new Error('ENCRYPTION_KEY environment variable is not set');
}

// Convert hex string to 32-byte buffer
const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

if (key.length !== 32) {
  throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
}

/**
 * Encrypt a token using AES-256-CBC
 * @param {string} token - The token to encrypt
 * @returns {string} - The encrypted token in format: iv:encrypted
 */
function encryptToken(token) {
  if (!token) return null;

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt a token using AES-256-CBC
 * @param {string} encryptedToken - The encrypted token in format: iv:encrypted
 * @returns {string} - The decrypted token
 */
function decryptToken(encryptedToken) {
  if (!encryptedToken) return null;

  try {
    const parts = encryptedToken.split(':');
    if (parts.length !== 2) {
      throw new Error('Invalid encrypted token format');
    }

    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Decryption failed:', err.message);
    throw err;
  }
}

module.exports = {
  encryptToken,
  decryptToken
};
