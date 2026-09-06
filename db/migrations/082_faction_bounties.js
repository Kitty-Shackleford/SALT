'use strict';

const FACTION_BOUNTY_SQL = `
  DROP TRIGGER IF EXISTS protect_bounty_escrow_update ON bounties;

  ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_status_check;
  ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_target_type_check;
  ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_creator_type_check;
  ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_target_shape_check;
  ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_creator_shape_check;
  ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_server_guild_fk;
  ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_target_faction_fk;
  ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_creator_faction_fk;
  ALTER TABLE bounties DROP CONSTRAINT IF EXISTS bounties_objective_claimant_fk;
  ALTER TABLE bounties ALTER COLUMN target_identity_id DROP NOT NULL;
  ALTER TABLE bounties
    ADD COLUMN IF NOT EXISTS guild_id INTEGER,
    ADD COLUMN IF NOT EXISTS target_type TEXT NOT NULL DEFAULT 'player',
    ADD COLUMN IF NOT EXISTS target_faction_id INTEGER,
    ADD COLUMN IF NOT EXISTS target_faction_id_snapshot INTEGER,
    ADD COLUMN IF NOT EXISTS target_faction_name_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS target_faction_tag_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS creator_type TEXT NOT NULL DEFAULT 'player',
    ADD COLUMN IF NOT EXISTS creator_faction_id INTEGER,
    ADD COLUMN IF NOT EXISTS creator_faction_id_snapshot INTEGER,
    ADD COLUMN IF NOT EXISTS creator_faction_name_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS creator_faction_tag_snapshot TEXT,
    ADD COLUMN IF NOT EXISTS objective_type TEXT,
    ADD COLUMN IF NOT EXISTS required_kills INTEGER,
    ADD COLUMN IF NOT EXISTS objective_claimant_identity_id INTEGER,
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

  UPDATE bounties b SET guild_id = s.guild_id
  FROM servers s WHERE s.id = b.server_id AND b.guild_id IS NULL;
  UPDATE bounties
  SET target_faction_id_snapshot = COALESCE(target_faction_id_snapshot, target_faction_id),
      creator_faction_id_snapshot = COALESCE(creator_faction_id_snapshot, creator_faction_id)
  WHERE target_type = 'faction' OR creator_type = 'faction';
  ALTER TABLE bounties ALTER COLUMN guild_id SET NOT NULL;

  UPDATE bounties b
  SET status = 'settled', claimed_at = COALESCE(b.claimed_at, b.settled_at)
  WHERE b.status = 'claimed'
    AND NOT EXISTS (
      SELECT 1 FROM financial_refund_claims frc
      WHERE frc.server_id = b.server_id
        AND frc.source_type = 'bounty_award'
        AND frc.source_key = b.id::text
        AND frc.status = 'pending'
    );
  UPDATE bounties SET claimed_at = COALESCE(claimed_at, settled_at)
  WHERE status = 'claimed';
  UPDATE bounties b SET settled_at = NULL
  WHERE b.status = 'claimed'
    AND EXISTS (
      SELECT 1 FROM financial_refund_claims frc
      WHERE frc.server_id = b.server_id
        AND frc.source_type = 'bounty_award'
        AND frc.source_key = b.id::text
        AND frc.status = 'pending'
    );

  ALTER TABLE bounties
    ADD CONSTRAINT bounties_status_check
      CHECK (status IN ('proposed', 'active', 'claimed', 'settled', 'cancelled', 'expired', 'invalidated', 'suspended')),
    ADD CONSTRAINT bounties_target_type_check
      CHECK (target_type IN ('player', 'faction')),
    ADD CONSTRAINT bounties_creator_type_check
      CHECK (creator_type IN ('player', 'faction')),
    ADD CONSTRAINT bounties_target_shape_check CHECK (
      (target_type = 'player'
        AND target_identity_id IS NOT NULL
        AND target_faction_id IS NULL
        AND target_faction_id_snapshot IS NULL
        AND target_faction_name_snapshot IS NULL
        AND target_faction_tag_snapshot IS NULL
        AND objective_type IS NULL
        AND required_kills IS NULL)
      OR
      (target_type = 'faction'
        AND target_identity_id IS NULL
        AND target_faction_id_snapshot IS NOT NULL
        AND (target_faction_id IS NULL OR target_faction_id_snapshot = target_faction_id)
        AND target_faction_name_snapshot IS NOT NULL
        AND target_faction_tag_snapshot IS NOT NULL
        AND objective_type = 'target_member_kill_count'
        AND required_kills IS NOT NULL AND required_kills > 0
        AND (target_faction_id IS NOT NULL OR status IN ('settled', 'cancelled', 'expired', 'invalidated')))
    ),
    ADD CONSTRAINT bounties_creator_shape_check CHECK (
      (creator_type = 'player'
        AND creator_faction_id IS NULL
        AND creator_faction_id_snapshot IS NULL
        AND creator_faction_name_snapshot IS NULL
        AND creator_faction_tag_snapshot IS NULL)
      OR
      (creator_type = 'faction'
        AND creator_faction_id_snapshot IS NOT NULL
        AND (creator_faction_id IS NULL OR creator_faction_id_snapshot = creator_faction_id)
        AND creator_faction_name_snapshot IS NOT NULL
        AND creator_faction_tag_snapshot IS NOT NULL
        AND (creator_faction_id IS NOT NULL OR status IN ('settled', 'cancelled', 'expired', 'invalidated')))
    ),
    ADD CONSTRAINT bounties_server_guild_fk
      FOREIGN KEY (server_id, guild_id) REFERENCES servers (id, guild_id) ON DELETE CASCADE,
    ADD CONSTRAINT bounties_target_faction_fk
      FOREIGN KEY (target_faction_id, guild_id) REFERENCES factions (id, guild_id)
      ON DELETE SET NULL (target_faction_id),
    ADD CONSTRAINT bounties_creator_faction_fk
      FOREIGN KEY (creator_faction_id, guild_id) REFERENCES factions (id, guild_id)
      ON DELETE SET NULL (creator_faction_id),
    ADD CONSTRAINT bounties_objective_claimant_fk
      FOREIGN KEY (server_id, objective_claimant_identity_id)
      REFERENCES server_player_memberships (server_id, identity_id);

  ALTER TABLE bounty_settings
    ADD COLUMN IF NOT EXISTS faction_kills_required INTEGER NOT NULL DEFAULT 3
      CHECK (faction_kills_required BETWEEN 1 AND 100);

  CREATE TABLE IF NOT EXISTS bounty_faction_members (
    bounty_id INTEGER NOT NULL,
    server_id INTEGER NOT NULL,
    member_role TEXT NOT NULL CHECK (member_role IN ('target', 'sponsor')),
    identity_id INTEGER NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bounty_id, member_role, identity_id),
    UNIQUE (bounty_id, member_role, identity_id),
    FOREIGN KEY (bounty_id, server_id) REFERENCES bounties (id, server_id) ON DELETE RESTRICT,
    FOREIGN KEY (server_id, identity_id)
      REFERENCES server_player_memberships (server_id, identity_id) ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS bounty_faction_members_lookup_idx
    ON bounty_faction_members (server_id, identity_id, member_role, bounty_id);

  CREATE TABLE IF NOT EXISTS bounty_objective_events (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    bounty_id INTEGER NOT NULL,
    server_id INTEGER NOT NULL,
    kill_event_id INTEGER NOT NULL,
    claimant_identity_id INTEGER NOT NULL,
    victim_identity_id INTEGER NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (bounty_id, kill_event_id),
    UNIQUE (bounty_id, victim_identity_id),
    FOREIGN KEY (bounty_id, server_id) REFERENCES bounties (id, server_id) ON DELETE RESTRICT,
    FOREIGN KEY (kill_event_id, server_id) REFERENCES kill_events (id, server_id) ON DELETE RESTRICT,
    FOREIGN KEY (server_id, claimant_identity_id)
      REFERENCES server_player_memberships (server_id, identity_id) ON DELETE RESTRICT,
    FOREIGN KEY (server_id, victim_identity_id)
      REFERENCES server_player_memberships (server_id, identity_id) ON DELETE RESTRICT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS bounty_objective_one_victim_idx
    ON bounty_objective_events(bounty_id, victim_identity_id);
  CREATE INDEX IF NOT EXISTS bounty_objective_events_claimant_idx
    ON bounty_objective_events (bounty_id, claimant_identity_id, id);

  CREATE OR REPLACE FUNCTION validate_bounty_objective_event()
  RETURNS TRIGGER AS $$
  DECLARE
    bounty_row bounties%ROWTYPE;
    kill_row kill_events%ROWTYPE;
  BEGIN
    SELECT * INTO bounty_row FROM bounties
    WHERE id = NEW.bounty_id AND server_id = NEW.server_id;
    IF NOT FOUND OR bounty_row.target_type <> 'faction'
       OR bounty_row.status <> 'active' THEN
      RAISE EXCEPTION 'Objective event requires an active faction bounty';
    END IF;

    SELECT * INTO kill_row FROM kill_events
    WHERE id = NEW.kill_event_id AND server_id = NEW.server_id;
    IF NOT FOUND
       OR kill_row.killer_identity_id IS DISTINCT FROM NEW.claimant_identity_id
       OR kill_row.victim_identity_id IS DISTINCT FROM NEW.victim_identity_id THEN
      RAISE EXCEPTION 'Objective event identities do not match the authoritative kill';
    END IF;
    IF bounty_row.objective_claimant_identity_id IS DISTINCT FROM NEW.claimant_identity_id THEN
      RAISE EXCEPTION 'Objective event claimant does not own this objective';
    END IF;
    IF kill_row.timestamp < bounty_row.created_at OR kill_row.timestamp > bounty_row.expires_at
       OR (bounty_row.cancellation_requested_at IS NOT NULL
           AND kill_row.timestamp > bounty_row.cancellation_requested_at) THEN
      RAISE EXCEPTION 'Objective event kill is outside the bounty eligibility window';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM bounty_faction_members member
      WHERE member.bounty_id = NEW.bounty_id
        AND member.server_id = NEW.server_id
        AND member.member_role = 'target'
        AND member.identity_id = NEW.victim_identity_id
    ) THEN
      RAISE EXCEPTION 'Objective victim is not in the captured target roster';
    END IF;
    IF EXISTS (
      SELECT 1 FROM bounty_faction_members member
      WHERE member.bounty_id = NEW.bounty_id
        AND member.server_id = NEW.server_id
        AND member.member_role IN ('target', 'sponsor')
        AND member.identity_id = NEW.claimant_identity_id
    ) THEN
      RAISE EXCEPTION 'Captured faction members cannot claim this objective';
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;

  DROP TRIGGER IF EXISTS validate_bounty_objective_event_insert ON bounty_objective_events;
  DROP TRIGGER IF EXISTS validate_bounty_objective_event_trigger ON bounty_objective_events;
  CREATE TRIGGER validate_bounty_objective_event_trigger
  BEFORE INSERT OR UPDATE ON bounty_objective_events
  FOR EACH ROW EXECUTE FUNCTION validate_bounty_objective_event();

  CREATE OR REPLACE FUNCTION protect_faction_bounty_claimant_membership()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    -- Serialize a membership change with every active contract attributed to
    -- this faction. Settlement locks the bounty first, so the later operation
    -- observes either the committed membership or the committed claimant.
    PERFORM b.id
    FROM bounties b
    WHERE b.target_type = 'faction' AND b.status = 'active'
      AND (
        COALESCE(b.target_faction_id_snapshot, b.target_faction_id) = NEW.faction_id
        OR COALESCE(b.creator_faction_id_snapshot, b.creator_faction_id) = NEW.faction_id
      )
    ORDER BY b.id
    FOR UPDATE;

    IF EXISTS (
      SELECT 1 FROM bounties b
      WHERE b.target_type = 'faction' AND b.status = 'active'
        AND b.objective_claimant_identity_id = NEW.identity_id
        AND (
          COALESCE(b.target_faction_id_snapshot, b.target_faction_id) = NEW.faction_id
          OR COALESCE(b.creator_faction_id_snapshot, b.creator_faction_id) = NEW.faction_id
        )
    ) THEN
      RAISE EXCEPTION 'Cannot join a faction excluded by an active bounty objective'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END;
  $$;

  DROP TRIGGER IF EXISTS protect_faction_bounty_claimant_membership_trigger ON faction_members;
  CREATE TRIGGER protect_faction_bounty_claimant_membership_trigger
  BEFORE INSERT OR UPDATE OF faction_id, guild_id, identity_id ON faction_members
  FOR EACH ROW EXECUTE FUNCTION protect_faction_bounty_claimant_membership();

  CREATE TABLE IF NOT EXISTS bounty_events (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    bounty_id INTEGER NOT NULL,
    server_id INTEGER NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
      'created', 'funded', 'cancellation_requested', 'objective_progress',
      'claimed', 'settled', 'cancelled', 'expired', 'invalidated', 'suspended', 'refunded'
    )),
    actor_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
    actor_identity_id INTEGER,
    kill_event_id INTEGER,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (bounty_id, server_id) REFERENCES bounties (id, server_id) ON DELETE RESTRICT,
    FOREIGN KEY (server_id, actor_identity_id)
      REFERENCES server_player_memberships (server_id, identity_id) ON DELETE RESTRICT,
    FOREIGN KEY (kill_event_id, server_id) REFERENCES kill_events (id, server_id) ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS bounty_events_history_idx
    ON bounty_events (server_id, bounty_id, id);

  CREATE INDEX IF NOT EXISTS bounties_active_faction_idx
    ON bounties (server_id, target_faction_id, expires_at, id)
    WHERE target_type = 'faction' AND status = 'active';

  CREATE OR REPLACE FUNCTION protect_active_bounty_update()
  RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE old_row JSONB := to_jsonb(OLD); new_row JSONB := to_jsonb(NEW);
  BEGIN
    IF OLD.status = 'active' THEN
      IF NEW.status = 'active'
         AND OLD.cancellation_requested_at IS NULL
         AND NEW.cancellation_requested_at IS NOT NULL
         AND (new_row - ARRAY['cancellation_requested_at', 'cancel_reason'])
             = (old_row - ARRAY['cancellation_requested_at', 'cancel_reason']) THEN
        RETURN NEW;
      END IF;
      IF NEW.status = 'active'
         AND OLD.objective_claimant_identity_id IS NULL
         AND NEW.objective_claimant_identity_id IS NOT NULL
         AND (new_row - 'objective_claimant_identity_id')
             = (old_row - 'objective_claimant_identity_id') THEN
        RETURN NEW;
      END IF;
      IF NEW.status IN ('claimed', 'settled')
         AND NEW.claimed_at IS NOT NULL
         AND NEW.claimed_by_identity_id IS NOT NULL
         AND NEW.claim_kill_event_id IS NOT NULL
         AND (NEW.status <> 'settled' OR NEW.settled_at IS NOT NULL)
         AND (new_row - ARRAY['status', 'claimed_at', 'settled_at', 'claimed_by_identity_id', 'claim_kill_event_id'])
             = (old_row - ARRAY['status', 'claimed_at', 'settled_at', 'claimed_by_identity_id', 'claim_kill_event_id']) THEN
        RETURN NEW;
      END IF;
      IF NEW.status IN ('cancelled', 'expired', 'invalidated')
         AND NEW.settled_at IS NOT NULL
         AND (new_row - ARRAY['status', 'settled_at', 'cancel_reason'])
             = (old_row - ARRAY['status', 'settled_at', 'cancel_reason']) THEN
        RETURN NEW;
      END IF;
      IF NEW.status = 'suspended'
         AND (new_row - ARRAY['status', 'cancel_reason'])
             = (old_row - ARRAY['status', 'cancel_reason']) THEN
        RETURN NEW;
      END IF;
    END IF;
    IF OLD.status = 'suspended' AND NEW.status = 'active'
       AND (new_row - ARRAY['status', 'cancel_reason'])
           = (old_row - ARRAY['status', 'cancel_reason']) THEN
      RETURN NEW;
    END IF;
    IF OLD.status = 'claimed' AND NEW.status = 'settled'
       AND OLD.settled_at IS NULL AND NEW.settled_at IS NOT NULL
       AND (new_row - ARRAY['status', 'settled_at'])
           = (old_row - ARRAY['status', 'settled_at']) THEN
      RETURN NEW;
    END IF;
    IF OLD.status IN ('settled', 'cancelled', 'expired', 'invalidated')
       AND (NEW.target_faction_id = OLD.target_faction_id OR NEW.target_faction_id IS NULL)
       AND (NEW.creator_faction_id = OLD.creator_faction_id OR NEW.creator_faction_id IS NULL)
       AND (NEW.target_faction_id IS DISTINCT FROM OLD.target_faction_id
            OR NEW.creator_faction_id IS DISTINCT FROM OLD.creator_faction_id)
       AND (new_row - ARRAY['target_faction_id', 'creator_faction_id'])
           = (old_row - ARRAY['target_faction_id', 'creator_faction_id']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Cannot mutate bounty escrow outside an allowed lifecycle transition';
  END;
  $$;

  CREATE TRIGGER protect_bounty_escrow_update
    BEFORE UPDATE ON bounties
    FOR EACH ROW EXECUTE FUNCTION protect_active_bounty_update();

  CREATE OR REPLACE FUNCTION protect_active_bounty()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF OLD.status IN ('active', 'suspended') THEN
      RAISE EXCEPTION 'Cannot delete unsettled bounty escrow %', OLD.id;
    END IF;
    RETURN OLD;
  END;
  $$;

  CREATE OR REPLACE FUNCTION protect_active_bounty_truncate()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM bounties WHERE status IN ('active', 'suspended')) THEN
      RAISE EXCEPTION 'Cannot truncate unsettled bounty escrow';
    END IF;
    RETURN NULL;
  END;
  $$;

  CREATE OR REPLACE FUNCTION protect_parent_with_unsettled_faction_bounty()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_TABLE_NAME = 'servers' AND EXISTS (
      SELECT 1 FROM bounties
      WHERE server_id = OLD.id AND status IN ('active', 'suspended')
    ) THEN
      RAISE EXCEPTION 'Cannot disable or delete server with unsettled bounty escrow';
    END IF;
    IF TG_TABLE_NAME = 'guilds' AND EXISTS (
      SELECT 1 FROM bounties
      WHERE guild_id = OLD.id AND status IN ('active', 'suspended')
    ) THEN
      RAISE EXCEPTION 'Cannot disable or delete guild with unsettled bounty escrow';
    END IF;
    IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
    RETURN OLD;
  END;
  $$;

  DROP TRIGGER IF EXISTS protect_server_unsettled_faction_bounties ON servers;
  CREATE TRIGGER protect_server_unsettled_faction_bounties
    BEFORE DELETE OR UPDATE OF status ON servers
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_unsettled_faction_bounty();
  DROP TRIGGER IF EXISTS protect_guild_unsettled_faction_bounties ON guilds;
  CREATE TRIGGER protect_guild_unsettled_faction_bounties
    BEFORE DELETE OR UPDATE OF status ON guilds
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_unsettled_faction_bounty();

  CREATE OR REPLACE FUNCTION protect_faction_with_active_bounty()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM bounties
      WHERE status IN ('active', 'claimed', 'suspended')
        AND (target_faction_id = OLD.id OR creator_faction_id = OLD.id)
    ) THEN
      RAISE EXCEPTION 'Cannot disband faction with unsettled bounty escrow';
    END IF;
    RETURN OLD;
  END;
  $$;

  DROP TRIGGER IF EXISTS protect_faction_active_bounties ON factions;
  CREATE TRIGGER protect_faction_active_bounties
    BEFORE DELETE ON factions
    FOR EACH ROW EXECUTE FUNCTION protect_faction_with_active_bounty();

  CREATE OR REPLACE FUNCTION protect_bounty_history_rows()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'Cannot update immutable bounty history';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cannot delete immutable bounty history';
    END IF;
    RAISE EXCEPTION 'Cannot truncate immutable bounty history';
  END;
  $$;

  DO $$
  DECLARE target_table TEXT;
  BEGIN
    FOREACH target_table IN ARRAY ARRAY[
      'bounty_faction_members', 'bounty_objective_events', 'bounty_events'
    ] LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS protect_%s_update ON %I', target_table, target_table);
      EXECUTE format('CREATE TRIGGER protect_%s_update BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION protect_bounty_history_rows()', target_table, target_table);
      EXECUTE format('DROP TRIGGER IF EXISTS protect_%s_delete ON %I', target_table, target_table);
      EXECUTE format('CREATE TRIGGER protect_%s_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION protect_bounty_history_rows()', target_table, target_table);
      EXECUTE format('DROP TRIGGER IF EXISTS protect_%s_truncate ON %I', target_table, target_table);
      EXECUTE format('CREATE TRIGGER protect_%s_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION protect_bounty_history_rows()', target_table, target_table);
    END LOOP;
  END;
  $$;
`;

async function up(pool) {
  await pool.query(FACTION_BOUNTY_SQL);
}

async function down() {
  throw new Error('Migration 082 is irreversible; restore a verified database backup instead');
}

module.exports = { up, down, FACTION_BOUNTY_SQL };
