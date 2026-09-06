const { decryptToken } = require('./encryption');

/**
 * Get decrypted Nitrado token for a guild by Discord guild ID.
 * @param {object} db - Database adapter instance
 * @param {string} discordGuildId - Discord guild ID
 * @returns {Promise<string|null>} Decrypted token or null
 */
async function getGuildToken(db, discordGuildId) {
  const row = await db.get(`
    SELECT gt.token_hash
    FROM guilds g
    JOIN guild_tokens gt ON g.id = gt.guild_id
    WHERE g.discord_guild_id = ?
      AND g.status = 'approved'
      AND gt.token_type = 'nitrado'
      AND gt.nitrado_user_id IS NOT NULL
    ORDER BY gt.created_at DESC
    LIMIT 1
  `, [discordGuildId]);
  if (!row || !row.token_hash) return null;
  return decryptToken(row.token_hash);
}

/**
 * Get decrypted Nitrado token for the guild that owns a given server.
 * @param {object} db - Database adapter instance
 * @param {string|number} platformServerId - Nitrado platform server ID
 * @returns {Promise<string|null>} Decrypted token or null
 */
async function getGuildTokenForServer(db, platformServerId) {
  console.log('🔍 [TOKEN-LOOKUP] Looking up token for server:', platformServerId);

  const row = await db.get(`
    SELECT gt.token_hash, g.name as guild_name, g.id as guild_id
    FROM servers s
    JOIN guilds g ON s.guild_id = g.id
    JOIN guild_tokens gt ON g.id = gt.guild_id
    WHERE s.platform_server_id = ?
      AND g.status = 'approved'
      AND gt.token_type = 'nitrado'
      AND gt.nitrado_user_id IS NOT NULL
    LIMIT 1
  `, [platformServerId]);

  if (!row || !row.token_hash) {
    console.error('❌ [TOKEN-LOOKUP] No token found for server:', platformServerId);
    console.error('   This means either:');
    console.error('   1. Server not registered in database');
    console.error('   2. Server not linked to a guild');
    console.error('   3. Guild has no Nitrado token');
    return null;
  }

  console.log('✅ [TOKEN-LOOKUP] Token found for guild:', row.guild_name, '(ID:', row.guild_id, ')');
  const decrypted = decryptToken(row.token_hash);
  console.log('✅ [TOKEN-LOOKUP] Token decrypted successfully');
  return decrypted;
}

module.exports = { getGuildToken, getGuildTokenForServer };
