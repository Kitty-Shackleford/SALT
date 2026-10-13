-- DEPRECATED: This migration is for Schema V1
-- Schema V2 uses 'guilds' table instead of 'discord_guilds'
-- Tokens are now stored in 'guild_tokens' table with proper separation
-- 
-- For new installations: Schema V2 is automatically created
-- Legacy V1 conversion is unsupported; use a separately validated import process.

-- Guild Token Migration
-- This migration adds a lastSyncAt column to track when guilds were last synced
-- The other columns (nitradoToken, botJoinedAt, tokenAddedBy, tokenAddedAt) already exist in schema.js

-- Add lastSyncAt column for tracking guild sync status
ALTER TABLE discord_guilds ADD COLUMN IF NOT EXISTS lastSyncAt TIMESTAMPTZ;

-- Index already exists in schema.js:
-- CREATE INDEX IF NOT EXISTS idx_guilds_token ON discord_guilds(guildId) WHERE nitradoToken IS NOT NULL;
