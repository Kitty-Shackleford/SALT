async function up(pool) {
  await pool.query(`
    ALTER TABLE faction_members
      ADD COLUMN IF NOT EXISTS guild_id INTEGER;
  `);

  await pool.query(`
    UPDATE faction_members fm
    SET guild_id = f.guild_id
    FROM factions f
    WHERE f.id = fm.faction_id
      AND fm.guild_id IS NULL;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM faction_members WHERE guild_id IS NULL) THEN
        RAISE EXCEPTION 'Cannot bind every faction member to a guild';
      END IF;

      IF EXISTS (
        SELECT guild_id, identity_id
        FROM faction_members
        GROUP BY guild_id, identity_id
        HAVING COUNT(*) > 1
      ) THEN
        RAISE EXCEPTION 'Duplicate faction memberships exist within a guild';
      END IF;
    END
    $$;
  `);

  await pool.query(`
    ALTER TABLE faction_members
      ALTER COLUMN guild_id SET NOT NULL;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'factions_id_guild_id_unique'
          AND conrelid = 'factions'::regclass
      ) THEN
        ALTER TABLE factions
          ADD CONSTRAINT factions_id_guild_id_unique UNIQUE (id, guild_id);
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'faction_members_guild_identity_unique'
          AND conrelid = 'faction_members'::regclass
      ) THEN
        ALTER TABLE faction_members
          ADD CONSTRAINT faction_members_guild_identity_unique UNIQUE (guild_id, identity_id);
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'faction_members_faction_guild_fk'
          AND conrelid = 'faction_members'::regclass
      ) THEN
        ALTER TABLE faction_members
          ADD CONSTRAINT faction_members_faction_guild_fk
          FOREIGN KEY (faction_id, guild_id)
          REFERENCES factions(id, guild_id)
          ON DELETE CASCADE;
      END IF;
    END
    $$;
  `);
}

module.exports = { up };
