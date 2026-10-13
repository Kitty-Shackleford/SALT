-- DEPRECATED: This migration is for Schema V1
-- Schema V2 uses 'guilds' table instead of 'discord_guilds'
-- Tokens are now stored in 'guild_tokens' table, not in discord_guilds.nitradoToken
-- 
-- For new installations: Schema V2 is automatically created
-- Legacy V1 conversion is unsupported; use a separately validated import process.

-- Add bot-related columns to discord_guilds
ALTER TABLE discord_guilds ADD COLUMN nitradoToken TEXT;
ALTER TABLE discord_guilds ADD COLUMN botJoinedAt DATETIME;
ALTER TABLE discord_guilds ADD COLUMN tokenAddedBy TEXT;
ALTER TABLE discord_guilds ADD COLUMN tokenAddedAt DATETIME;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_guilds_token ON discord_guilds(guildId) WHERE nitradoToken IS NOT NULL;
