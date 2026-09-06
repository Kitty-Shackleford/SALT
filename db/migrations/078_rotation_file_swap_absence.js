'use strict';

const ROTATION_FILE_SWAP_ABSENCE_SQL = `
  ALTER TABLE rotation_file_backups
    ADD COLUMN IF NOT EXISTS original_exists BOOLEAN;

  UPDATE rotation_file_backups
  SET original_exists = TRUE
  WHERE original_exists IS NULL;

  ALTER TABLE rotation_file_backups
    ALTER COLUMN original_exists SET NOT NULL,
    ALTER COLUMN content DROP NOT NULL;

  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'rotation_file_backups_original_content_chk'
        AND conrelid = 'rotation_file_backups'::regclass
    ) THEN
      ALTER TABLE rotation_file_backups
        ADD CONSTRAINT rotation_file_backups_original_content_chk
        CHECK (
          (original_exists AND content IS NOT NULL)
          OR
          (NOT original_exists AND content IS NULL)
        );
    END IF;
  END
  $$;
`;

async function up(pool) {
  await pool.query(ROTATION_FILE_SWAP_ABSENCE_SQL);
}

async function down() {
  throw new Error('Migration 078 is irreversible; absence-aware file-swap backups may contain null content');
}

module.exports = { up, down, ROTATION_FILE_SWAP_ABSENCE_SQL };
