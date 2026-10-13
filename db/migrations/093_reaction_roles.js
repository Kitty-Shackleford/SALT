/*
 * Migration 093: reaction_roles
 *
 * Maps a (guild, channel, message, emoji) tuple to a Discord role id.
 * Used by the Phase 1 reaction-roles feature: when a user reacts to one of
 * the bot's setup messages with the bound emoji they are assigned the role;
 * removing the reaction removes the role.
 */
'use strict';

module.exports = {
  async up(pool) {
    console.log('🔄 Migration 093: Add reaction_roles table');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS reaction_roles (
        id          INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        guild_id    INTEGER NOT NULL,
        channel_id  TEXT NOT NULL,
        message_id  TEXT NOT NULL,
        emoji       TEXT NOT NULL,
        role_id     TEXT NOT NULL,
        created_by  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (guild_id, message_id, emoji, role_id),
        FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
      )
    `);

    console.log('✅ Migration 093: reaction_roles table created');
  },

  async down(pool) {
    await pool.query('DROP TABLE IF EXISTS reaction_roles');
  },
};
