'use strict';

async function upsertDiscordOAuthUser(db, identity) {
  return db.get(
    `INSERT INTO users (discord_id, username, avatar, access_token)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (discord_id) DO UPDATE SET
       access_token = EXCLUDED.access_token
     RETURNING *`,
    [identity.discordId, identity.username, identity.avatar || null, identity.accessToken || null]
  );
}

module.exports = { upsertDiscordOAuthUser };
