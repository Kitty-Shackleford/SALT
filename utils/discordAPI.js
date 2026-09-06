const axios = require('axios');
const crypto = require('crypto');

// Simple in-memory cache for guild membership checks
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Encryption settings for token decryption
const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

/**
 * Decrypt an encrypted token
 */
function decrypt(encryptedText) {
  if (!encryptedText) return null;
  try {
    const [ivHex, encrypted] = encryptedText.split(':');
    if (!ivHex || !encrypted) return null;
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Decryption failed:', err.message);
    return null;
  }
}

/**
 * Hash a token for safe use as cache key
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Get a cached value if it exists and is not expired
 */
function getCached(key) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return cached.value;
  }
  cache.delete(key);
  return null;
}

/**
 * Set a value in the cache
 */
function setCache(key, value) {
  cache.set(key, {
    value,
    timestamp: Date.now()
  });
}

/**
 * Fetch all guilds the user is a member of from Discord API
 * @param {string} encryptedToken - Encrypted Discord OAuth access token
 * @returns {Promise<Array>} Array of guild objects
 */
async function getUserGuilds(encryptedToken) {
  if (!encryptedToken) {
    throw new Error('Access token is required');
  }

  // Decrypt token only when needed
  const accessToken = decrypt(encryptedToken);

  if (!accessToken) {
    throw new Error('Failed to decrypt access token');
  }

  const cacheKey = `guilds:${hashToken(accessToken)}`;
  const cached = getCached(cacheKey);
  if (cached) {
    console.log('✅ Returning cached guild list');
    return cached;
  }

  try {
    console.log('🔍 Fetching user guilds from Discord API...');
    const response = await axios.get('https://discord.com/api/users/@me/guilds', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      timeout: 10000
    });

    const guilds = response.data || [];
    console.log(`✅ Fetched ${guilds.length} guilds from Discord`);

    setCache(cacheKey, guilds);
    return guilds;
  } catch (error) {
    console.error('❌ Error fetching user guilds:', error.message);

    if (error.response) {
      const status = error.response.status;

      if (status === 401) {
        throw new Error('Discord access token expired. Please log out and log back in.');
      } else if (status === 429) {
        throw new Error('Discord API rate limit reached. Please try again in a few minutes.');
      } else {
        throw new Error(`Discord API error: ${error.response.statusText}`);
      }
    }

    throw new Error('Unable to verify Discord membership. Please try again later.');
  }
}

/**
 * Check if user is a member of a specific guild
 * @param {string} encryptedToken - Encrypted Discord OAuth access token
 * @param {string} guildId - Discord guild ID to check
 * @returns {Promise<boolean>} True if user is a member
 */
async function verifyGuildMembership(encryptedToken, guildId) {
  if (!encryptedToken) {
    throw new Error('Access token is required');
  }

  if (!guildId) {
    throw new Error('Guild ID is required');
  }

  // Decrypt token only when needed
  const accessToken = decrypt(encryptedToken);

  if (!accessToken) {
    throw new Error('Failed to decrypt access token');
  }

  const cacheKey = `membership:${hashToken(accessToken)}:${guildId}`;
  const cached = getCached(cacheKey);
  if (cached !== null) {
    console.log(`✅ Returning cached membership status for guild ${guildId}`);
    return cached;
  }

  try {
    const guilds = await getUserGuilds(encryptedToken);
    const isMember = guilds.some(guild => guild.id === guildId);

    console.log(`${isMember ? '✅' : '❌'} User ${isMember ? 'is' : 'is not'} a member of guild ${guildId}`);

    setCache(cacheKey, isMember);
    return isMember;
  } catch (error) {
    console.error('❌ Error verifying guild membership:', error.message);
    throw error;
  }
}

/**
 * Get guild icon URL
 * @param {string} guildId - Discord guild ID
 * @param {string} iconHash - Guild icon hash
 * @returns {string|null} Icon URL or null
 */
function getGuildIconUrl(guildId, iconHash) {
  if (!iconHash) return null;
  return `https://cdn.discordapp.com/icons/${guildId}/${iconHash}.png`;
}

/**
 * Clear the entire cache (useful for testing or manual refresh)
 */
function clearCache() {
  cache.clear();
  console.log('🧹 Discord API cache cleared');
}

module.exports = {
  getUserGuilds,
  verifyGuildMembership,
  getGuildIconUrl,
  clearCache
};
