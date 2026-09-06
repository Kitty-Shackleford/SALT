/**
 * Database Schema V2 - Complete Redesign
 * PostgreSQL-only architecture
 *
 * This schema fixes all current issues and establishes a scalable foundation:
 * - Proper ID relationships (database IDs, not Nitrado IDs)
 * - Multi-platform support (Xbox, PlayStation, Steam)
 * - Player identity tracking (gamertags, platforms, history)
 * - Role-based access control
 * - Per-server stats
 * - Feature flags system
 *
 * Table creation order is significant for PostgreSQL: referenced tables must
 * be created before the tables that hold the foreign keys.
 */

const SCHEMA_VERSION = 2;

/**
 * Creates all tables for schema v2
 * @param {Object} db - Database adapter instance
 */
async function createSchemaV2(db) {
  console.log('✨ Creating Schema V2...');

  // ============================================
  // 0. DISCORD USERS  (must come first – guilds/roles reference this table)
  // ============================================

  // Discord users (OAuth) – created before guilds because guilds.approvedBy/disabledBy
  // reference users(id).  PostgreSQL enforces FK targets at CREATE TABLE time.
  await db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    discord_id TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    discriminator TEXT,
    avatar TEXT,
    email TEXT,
    is_admin INTEGER DEFAULT 0,
    is_banned INTEGER DEFAULT 0,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMPTZ
  )`);
  console.log('  ✓ users');

  // ============================================
  // 1. PLATFORM & MULTI-TENANT
  // ============================================

  // Discord communities (renamed from discord_guilds)
  await db.run(`CREATE TABLE IF NOT EXISTS guilds (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    discord_guild_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    icon_url TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    approved_at TIMESTAMPTZ,
    approved_by INTEGER,
    disabled_at TIMESTAMPTZ,
    disabled_by INTEGER,
    disabled_reason TEXT,
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (disabled_by) REFERENCES users(id) ON DELETE SET NULL
  )`);
  console.log('  ✓ guilds');

  // API tokens (separated from guilds table)
  await db.run(`CREATE TABLE IF NOT EXISTS guild_tokens (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    guild_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    token_type TEXT DEFAULT 'nitrado',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_used TIMESTAMPTZ,
    UNIQUE(guild_id, token_type),
    FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ guild_tokens');

  // Role-based access control
  await db.run(`CREATE TABLE IF NOT EXISTS guild_roles (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    guild_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    assigned_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    assigned_by INTEGER,
    UNIQUE(guild_id, user_id),
    FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (assigned_by) REFERENCES users(id) ON DELETE SET NULL
  )`);
  console.log('  ✓ guild_roles');

  // Feature toggles per guild
  await db.run(`CREATE TABLE IF NOT EXISTS guild_features (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    guild_id INTEGER NOT NULL,
    feature_name TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    config TEXT,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(guild_id, feature_name),
    FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ guild_features');

  // ============================================
  // 2. SERVER LAYER
  // ============================================

  // DayZ servers (improved)
  await db.run(`CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    guild_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    platform_server_id TEXT NOT NULL,
    ip TEXT,
    port INTEGER,
    region TEXT,
    status TEXT DEFAULT 'active',
    last_sync_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(platform_server_id, platform),
    FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ servers');

  // Feature toggles per server
  await db.run(`CREATE TABLE IF NOT EXISTS server_features (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    server_id INTEGER NOT NULL,
    feature_name TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    config TEXT,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(server_id, feature_name),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ server_features');

  // ============================================
  // 3. PLAYER IDENTITY LAYER
  // ============================================

  // Real humans (one per actual person).
  // primary_identity_id is a back-reference to player_identities which does not
  // exist yet, creating a circular dependency.  To satisfy PostgreSQL's strict
  // FK resolution at CREATE TABLE time we omit the FK here and add it with
  // ALTER TABLE after player_identities has been created.
  await db.run(`CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    primary_identity_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);
  console.log('  ✓ players');

  // Platform accounts (Xbox, PS, Steam)
  await db.run(`CREATE TABLE IF NOT EXISTS player_identities (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    player_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    platform_user_id TEXT NOT NULL,
    platform_username TEXT,
    device_id TEXT,
    first_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMPTZ,
    UNIQUE(platform, platform_user_id),
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ player_identities');

  // Now that player_identities exists, add the back-reference FK on players.
  // We use a DO $$ block so the statement is idempotent (the constraint is
  // only added when it does not already exist).
  await db.run(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_players_primary_identity'
        ) THEN
          ALTER TABLE players
            ADD CONSTRAINT fk_players_primary_identity
            FOREIGN KEY (primary_identity_id) REFERENCES player_identities(id);
        END IF;
      END
      $$
    `).catch((err) => {
    // Non-fatal: log and continue.  The column still exists and stores valid
    // integer references; FK enforcement can be added in a later migration.
    console.warn('  ⚠️  Could not add fk_players_primary_identity:', err.message);
  });
  console.log('  ✓ players.primary_identity_id FK (deferred)');

  // Gamertags per server (tracks name changes)
  await db.run(`CREATE TABLE IF NOT EXISTS player_gamertags (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    identity_id INTEGER NOT NULL,
    server_id INTEGER NOT NULL,
    gamertag TEXT NOT NULL,
    is_current_gamertag INTEGER DEFAULT 1,
    first_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMPTZ,
    FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE CASCADE,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ player_gamertags');

  // ============================================
  // 4. ACTIVITY & STATS
  // ============================================

  // Player presence per server (FIXED VERSION!)
  await db.run(`CREATE TABLE IF NOT EXISTS player_server_activity (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    identity_id INTEGER NOT NULL,
    server_id INTEGER NOT NULL,
    first_seen TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMPTZ,
    total_sessions INTEGER DEFAULT 0,
    UNIQUE(identity_id, server_id),
    FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE CASCADE,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ player_server_activity');

  // Login/logout tracking
  await db.run(`CREATE TABLE IF NOT EXISTS player_sessions (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    identity_id INTEGER NOT NULL,
    server_id INTEGER NOT NULL,
    login_at TIMESTAMPTZ NOT NULL,
    logout_at TIMESTAMPTZ,
    duration INTEGER,
    ip_address TEXT,
    log_source TEXT,
    UNIQUE(identity_id, server_id, login_at),
    FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE CASCADE,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ player_sessions');

  // Stats per server
  await db.run(`CREATE TABLE IF NOT EXISTS player_stats (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    identity_id INTEGER NOT NULL,
    server_id INTEGER NOT NULL,
    kills INTEGER DEFAULT 0,
    deaths INTEGER DEFAULT 0,
    suicides INTEGER DEFAULT 0,
    longest_kill_distance REAL DEFAULT 0,
    total_playtime_seconds INTEGER DEFAULT 0,
    longest_survival_seconds INTEGER DEFAULT 0,
    current_survival_seconds INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(identity_id, server_id),
    FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE CASCADE,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ player_stats');

  // Player health status per server (last known state)
  await db.run(`CREATE TABLE IF NOT EXISTS player_health_status (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    identity_id INTEGER NOT NULL,
    server_id INTEGER NOT NULL,
    current_hp REAL DEFAULT 100.0,
    max_hp REAL DEFAULT 100.0,
    status TEXT DEFAULT 'alive',
    last_position TEXT,
    pos_x REAL,
    pos_y REAL,
    pos_z REAL,
    last_updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(identity_id, server_id),
    FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE CASCADE,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ player_health_status');

  // Kill events log
  await db.run(`CREATE TABLE IF NOT EXISTS kill_events (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    server_id INTEGER NOT NULL,
    killer_identity_id INTEGER,
    killer_gamertag TEXT,
    killer_position TEXT,
    victim_identity_id INTEGER NOT NULL,
    victim_gamertag TEXT NOT NULL,
    victim_position TEXT,
    weapon TEXT,
    distance REAL,
    timestamp TIMESTAMPTZ NOT NULL,
    log_source TEXT,
    UNIQUE(server_id, victim_identity_id, killer_identity_id, timestamp, weapon),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (killer_identity_id) REFERENCES player_identities(id),
    FOREIGN KEY (victim_identity_id) REFERENCES player_identities(id)
  )`);
  console.log('  ✓ kill_events');

  // Damage events log
  await db.run(`CREATE TABLE IF NOT EXISTS damage_events (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    server_id INTEGER NOT NULL,
    victim_identity_id INTEGER NOT NULL,
    victim_gamertag TEXT NOT NULL,
    victim_position TEXT,
    victim_pos_x REAL,
    victim_pos_y REAL,
    victim_pos_z REAL,
    attacker_identity_id INTEGER,
    attacker_gamertag TEXT,
    attacker_type TEXT NOT NULL,
    weapon TEXT,
    body_part TEXT,
    body_part_id INTEGER,
    damage REAL,
    hp_before REAL,
    hp_after REAL,
    timestamp TIMESTAMPTZ NOT NULL,
    log_source TEXT DEFAULT 'adm_log',
    source_file TEXT,
    source_line INTEGER,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (victim_identity_id) REFERENCES player_identities(id),
    FOREIGN KEY (attacker_identity_id) REFERENCES player_identities(id)
  )`);
  console.log('  ✓ damage_events');

  // Territory and base building events log
  await db.run(`CREATE TABLE IF NOT EXISTS territory_events (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    server_id INTEGER NOT NULL,
    identity_id INTEGER,
    player_gamertag TEXT,
    event_type TEXT NOT NULL,
    structure_type TEXT NOT NULL,
    position TEXT,
    pos_x REAL,
    pos_y REAL,
    pos_z REAL,
    structure_part TEXT,
    tool_used TEXT,
    timestamp TIMESTAMPTZ NOT NULL,
    log_source TEXT DEFAULT 'adm_log',
    source_file TEXT,
    source_line INTEGER,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (identity_id) REFERENCES player_identities(id)
  )`);
  console.log('  ✓ territory_events');

  // Player death events
  await db.run(`CREATE TABLE IF NOT EXISTS player_death_events (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    server_id INTEGER NOT NULL,
    identity_id INTEGER,
    player_gamertag TEXT,
    death_type TEXT NOT NULL,
    killed_by TEXT,
    water_level REAL,
    energy_level REAL,
    bleed_sources INTEGER,
    pos_x REAL,
    pos_y REAL,
    pos_z REAL,
    timestamp TIMESTAMPTZ NOT NULL,
    log_source TEXT DEFAULT 'adm_log',
    UNIQUE(server_id, identity_id, timestamp, death_type),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (identity_id) REFERENCES player_identities(id)
  )`);
  console.log('  ✓ player_death_events');

  // Player unconscious events
  await db.run(`CREATE TABLE IF NOT EXISTS player_unconscious_events (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    server_id INTEGER NOT NULL,
    identity_id INTEGER,
    player_gamertag TEXT,
    event_type TEXT NOT NULL,
    pos_x REAL,
    pos_y REAL,
    pos_z REAL,
    timestamp TIMESTAMPTZ NOT NULL,
    log_source TEXT DEFAULT 'adm_log',
    UNIQUE(server_id, identity_id, timestamp, event_type),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (identity_id) REFERENCES player_identities(id)
  )`);
  console.log('  ✓ player_unconscious_events');

  // Player respawn events
  await db.run(`CREATE TABLE IF NOT EXISTS player_respawn_events (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    server_id INTEGER NOT NULL,
    identity_id INTEGER,
    player_gamertag TEXT,
    pos_x REAL,
    pos_y REAL,
    pos_z REAL,
    timestamp TIMESTAMPTZ NOT NULL,
    log_source TEXT DEFAULT 'adm_log',
    UNIQUE(server_id, identity_id, timestamp),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (identity_id) REFERENCES player_identities(id)
  )`);
  console.log('  ✓ player_respawn_events');

  // Player position snapshots
  await db.run(`CREATE TABLE IF NOT EXISTS player_position_snapshots (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    server_id INTEGER NOT NULL,
    identity_id INTEGER,
    player_gamertag TEXT NOT NULL,
    pos_x REAL NOT NULL,
    pos_y REAL NOT NULL,
    pos_z REAL NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    log_source TEXT DEFAULT 'adm_log',
    UNIQUE(server_id, identity_id, timestamp),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (identity_id) REFERENCES player_identities(id)
  )`);
  console.log('  ✓ player_position_snapshots');

  // Player emote events
  await db.run(`CREATE TABLE IF NOT EXISTS player_emote_events (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    server_id INTEGER NOT NULL,
    identity_id INTEGER,
    player_gamertag TEXT,
    emote_type TEXT NOT NULL,
    item_name TEXT,
    pos_x REAL,
    pos_y REAL,
    pos_z REAL,
    timestamp TIMESTAMPTZ NOT NULL,
    log_source TEXT DEFAULT 'adm_log',
    source_file TEXT,
    source_line INTEGER,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (identity_id) REFERENCES player_identities(id)
  )`);
  console.log('  ✓ player_emote_events');

  // ============================================
  // PLAYER ACHIEVEMENTS & PROGRESSION
  // ============================================

  // Player achievements
  await db.run(`CREATE TABLE IF NOT EXISTS player_achievements (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    identity_id INTEGER NOT NULL,
    achievement_type TEXT NOT NULL,
    achievement_name TEXT NOT NULL,
    achieved_at TIMESTAMPTZ NOT NULL,
    metadata TEXT,
    UNIQUE(identity_id, achievement_type, achievement_name),
    FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ player_achievements');

  // Create index for faster lookups
  await db.run(`CREATE INDEX IF NOT EXISTS idx_player_achievements_identity
    ON player_achievements(identity_id)`);
  console.log('  ✓ player_achievements indexes');

  // ============================================
  // ECONOMY SYSTEM
  // ============================================

  // Player wallets (cash on hand)
  await db.run(`CREATE TABLE IF NOT EXISTS player_wallets (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    identity_id INTEGER NOT NULL UNIQUE,
    cash_on_hand REAL NOT NULL DEFAULT 0,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ player_wallets');

  await db.run(`CREATE INDEX IF NOT EXISTS idx_player_wallets_identity
    ON player_wallets(identity_id)`);

  // Player bank accounts
  await db.run(`CREATE TABLE IF NOT EXISTS player_bank_accounts (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    identity_id INTEGER NOT NULL UNIQUE,
    balance REAL NOT NULL DEFAULT 0,
    last_transaction TIMESTAMPTZ,
    FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ player_bank_accounts');

  await db.run(`CREATE INDEX IF NOT EXISTS idx_player_bank_accounts_identity
    ON player_bank_accounts(identity_id)`);

  // Economy transactions (audit trail)
  await db.run(`CREATE TABLE IF NOT EXISTS economy_transactions (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    identity_id INTEGER NOT NULL,
    transaction_type TEXT NOT NULL,
    amount REAL NOT NULL,
    balance_after REAL NOT NULL,
    account_type TEXT NOT NULL,
    source TEXT,
    source_identity_id INTEGER,
    description TEXT,
    server_id INTEGER,
    metadata TEXT,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE CASCADE,
    FOREIGN KEY (source_identity_id) REFERENCES player_identities(id) ON DELETE SET NULL,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL
  )`);
  console.log('  ✓ economy_transactions');

  await db.run(`CREATE INDEX IF NOT EXISTS idx_economy_transactions_identity
    ON economy_transactions(identity_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_economy_transactions_timestamp
    ON economy_transactions(timestamp DESC)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_economy_transactions_type
    ON economy_transactions(transaction_type)`);

  // Guild economy configuration
  await db.run(`CREATE TABLE IF NOT EXISTS guild_economy_config (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    guild_id INTEGER NOT NULL UNIQUE,
    enabled BOOLEAN NOT NULL DEFAULT false,
    currency_name TEXT DEFAULT 'Dollar',
    currency_symbol TEXT DEFAULT '$',
    starting_cash REAL DEFAULT 1000,
    starting_bank REAL DEFAULT 0,
    monetary_system TEXT DEFAULT 'fiat',
    total_money_supply REAL DEFAULT NULL,
    kill_rewards_enabled BOOLEAN DEFAULT true,
    playtime_rewards_enabled BOOLEAN DEFAULT true,
    achievement_rewards_enabled BOOLEAN DEFAULT false,
    territory_rewards_enabled BOOLEAN DEFAULT false,
    kill_reward REAL DEFAULT 100,
    playtime_reward_per_hour REAL DEFAULT 10,
    achievement_bonus_multiplier REAL DEFAULT 1.0,
    territory_reward_per_hour REAL DEFAULT 5,
    death_penalty_enabled BOOLEAN DEFAULT false,
    death_penalty_type TEXT DEFAULT 'percentage',
    death_penalty_amount REAL DEFAULT 10,
    death_penalty_max_loss REAL DEFAULT NULL,
    death_drops_money_on_ground BOOLEAN DEFAULT false,
    transfer_enabled BOOLEAN DEFAULT true,
    transfer_fee_percentage REAL DEFAULT 0,
    transfer_require_both_online BOOLEAN DEFAULT false,
    transfer_offline_fee_percentage REAL DEFAULT 5,
    transfer_min_amount REAL DEFAULT 1,
    transfer_max_amount REAL DEFAULT NULL,
    bank_enabled BOOLEAN DEFAULT true,
    max_bank_balance REAL DEFAULT NULL,
    bank_deposit_fee_percentage REAL DEFAULT 0,
    bank_withdraw_fee_percentage REAL DEFAULT 0,
    bank_daily_fee_enabled BOOLEAN DEFAULT false,
    bank_daily_fee_type TEXT DEFAULT 'percentage',
    bank_daily_fee_amount REAL DEFAULT 0.1,
    inactivity_tax_enabled BOOLEAN DEFAULT false,
    inactivity_threshold_days INTEGER DEFAULT 30,
    inactivity_tax_percentage REAL DEFAULT 5,
    fixed_supply_enabled BOOLEAN DEFAULT false,
    max_money_supply REAL DEFAULT NULL,
    current_money_supply REAL DEFAULT 0,
    last_supply_update TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ guild_economy_config');

  await db.run(`CREATE INDEX IF NOT EXISTS idx_guild_economy_config_guild
    ON guild_economy_config(guild_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_guild_economy_config_enabled
    ON guild_economy_config(enabled)`);

  // Supply audit log. It is intentionally created in the legacy nullable form;
  // migration 052 performs the fail-closed data preflight before making
  // server_id mandatory.
  await db.run(`CREATE TABLE IF NOT EXISTS economy_supply_log (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    guild_id INTEGER NOT NULL,
    change_type TEXT NOT NULL,
    source TEXT NOT NULL,
    amount REAL NOT NULL,
    supply_before REAL NOT NULL,
    supply_after REAL NOT NULL,
    identity_id INTEGER,
    server_id INTEGER,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata TEXT,
    FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
    FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE SET NULL,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL
  )`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_supply_log_guild ON economy_supply_log(guild_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_supply_log_timestamp ON economy_supply_log(timestamp)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_supply_log_type ON economy_supply_log(change_type)`);

  console.log('  ✓ Economy system indexes');

  // ============================================
  // 5. DISCORD INTEGRATION
  // ============================================

  // users table was already created in section 0 so it exists before guilds.

  // Link Discord to game accounts
  await db.run(`CREATE TABLE IF NOT EXISTS linked_accounts (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    user_id INTEGER NOT NULL,
    identity_id INTEGER NOT NULL,
    verified_by_guild_id INTEGER,
    verification_method TEXT,
    linked_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, identity_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE CASCADE,
    FOREIGN KEY (verified_by_guild_id) REFERENCES guilds(id)
  )`);
  console.log('  ✓ linked_accounts');

  await db.run(`CREATE TABLE IF NOT EXISTS discord_link_role_policy_history (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL,
    first_managed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_managed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_id, role_id)
  )`);

  await db.run(`CREATE TABLE IF NOT EXISTS discord_role_reconciliation_jobs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    discord_guild_id TEXT NOT NULL,
    discord_user_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'processing', 'completed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_at TIMESTAMPTZ,
    last_error TEXT,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (discord_guild_id, discord_user_id, user_id)
  )`);
  await db.run(`CREATE INDEX IF NOT EXISTS discord_role_reconciliation_jobs_due_idx
    ON discord_role_reconciliation_jobs(status, next_attempt_at)
    WHERE status IN ('pending', 'processing')`);
  console.log('  ✓ Discord role reconciliation outbox');

  // ============================================
  // 6. SYSTEM TABLES
  // ============================================

  // Web sessions
  await db.run(`CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expire BIGINT NOT NULL
  )`);
  console.log('  ✓ sessions');

  /**
   * Automation Settings
   * Stores per-user automation preferences for:
   * - Auto log sync (background download of server logs)
   * - Auto player tracking (scheduled stats updates)
   *
   * JSON fields allow flexible settings without schema changes
   */
  await db.run(`CREATE TABLE IF NOT EXISTS automation_settings (
    user_id INTEGER PRIMARY KEY,
    auto_log_sync TEXT,
    auto_tracking TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ automation_settings');

  /**
   * Sync Jobs
   * Tracks background file sync operations from Nitrado servers
   * Used by /api/sync-server and /api/sync-jobs endpoints
   *
   * NOTE: server_id stores the Nitrado platform ID (NOT a database ID!)
   * This is intentional - sync operations target external platform servers
   * and the platform ID is what the Nitrado API uses.
   * Unlike player tracking tables, there is NO foreign key constraint here.
   */
  await db.run(`CREATE TABLE IF NOT EXISTS sync_jobs (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    user_id INTEGER NOT NULL,
    server_id INTEGER NOT NULL,
    remote_path TEXT,
    status TEXT DEFAULT 'running',
    files_downloaded INTEGER DEFAULT 0,
    total_size INTEGER DEFAULT 0,
    errors TEXT,
    started_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ sync_jobs');

  /**
   * Downloads
   * Tracks individual file downloads from sync jobs
   * Allows users to see what files they've downloaded
   *
   * NOTE: server_id stores the Nitrado platform ID (NOT a database ID!)
   * This is intentional - download operations are tied to external platform servers
   * and the platform ID is what the Nitrado API uses.
   * Unlike player tracking tables, there is NO foreign key constraint here.
   */
  await db.run(`CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    user_id INTEGER NOT NULL,
    server_id INTEGER NOT NULL,
    sync_job_id INTEGER,
    file_path TEXT NOT NULL,
    local_path TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    downloaded_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (sync_job_id) REFERENCES sync_jobs(id) ON DELETE SET NULL
  )`);
  console.log('  ✓ downloads');

  // Background jobs
  await db.run(`CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    type TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    server_id INTEGER,
    guild_id INTEGER,
    payload TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    result TEXT,
    error TEXT,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ jobs');

  // File download tracking
  await db.run(`CREATE TABLE IF NOT EXISTS file_downloads (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    server_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_date DATE NOT NULL,
    file_size INTEGER,
    status TEXT DEFAULT 'pending',
    downloaded_at TIMESTAMPTZ,
    parsed_at TIMESTAMPTZ,
    players_found INTEGER DEFAULT 0,
    events_found INTEGER DEFAULT 0,
    UNIQUE(server_id, filename),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ file_downloads');

  // Audit log
  await db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    user_id INTEGER,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    details TEXT,
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  )`);
  console.log('  ✓ audit_log');

  // Discord Feeds System
  await db.run(`CREATE TABLE IF NOT EXISTS discord_feeds (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    guild_id TEXT NOT NULL,
    feed_type TEXT NOT NULL,
    enabled INTEGER DEFAULT 0,
    channel_id TEXT,
    webhook_url TEXT,
    settings TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(guild_id, feed_type)
  )`);
  console.log('  ✓ discord_feeds');

  await db.run(`CREATE TABLE IF NOT EXISTS feed_templates (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    guild_id TEXT NOT NULL,
    feed_type TEXT NOT NULL,
    event_type TEXT NOT NULL,
    template TEXT NOT NULL,
    embed_enabled INTEGER DEFAULT 0,
    embed_color TEXT DEFAULT '#FF0000',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(guild_id, feed_type, event_type)
  )`);
  console.log('  ✓ feed_templates');

  await db.run(`CREATE TABLE IF NOT EXISTS feed_events (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    guild_id TEXT NOT NULL,
    server_id INTEGER NOT NULL,
    feed_type TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_data TEXT NOT NULL,
    processed INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP
  )`);
  console.log('  ✓ feed_events');

  // ============================================
  // AUTO-BAN SYSTEM
  // ============================================

  // Per-server configuration toggles
  await db.run(`CREATE TABLE IF NOT EXISTS server_settings (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    server_id INTEGER NOT NULL UNIQUE,
    auto_ban_alts INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ server_settings');

  // Gamertags protected from auto-ban (manually unbanned players)
  await db.run(`CREATE TABLE IF NOT EXISTS alt_ban_exemptions (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    server_id INTEGER NOT NULL,
    gamertag TEXT NOT NULL,
    exempted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    exempted_by INTEGER,
    UNIQUE(server_id, gamertag),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (exempted_by) REFERENCES users(id) ON DELETE SET NULL
  )`);
  console.log('  ✓ alt_ban_exemptions');

  // Tracks which players are currently online per server, as detected by the
  // most recent ADM log scan. Wiped and rewritten on every scan — never accumulates
  // stale rows the way player_sessions (logout_at IS NULL) does.
  await db.run(`CREATE TABLE IF NOT EXISTS server_online_cache (
    server_id   INTEGER NOT NULL,
    identity_id INTEGER NOT NULL,
    gamertag    TEXT,
    login_at    TIMESTAMPTZ,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (server_id, identity_id),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE CASCADE
  )`);
  console.log('  ✓ server_online_cache');

  // Private, one-time state for multi-step casino games. Only the opaque
  // session_id is exposed to browsers; state remains server-side.
  await db.run(`CREATE TABLE IF NOT EXISTS casino_sessions (
    session_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    identity_id INTEGER NOT NULL,
    server_id INTEGER NOT NULL,
    guild_id INTEGER NOT NULL,
    game_type TEXT NOT NULL,
    state JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    reserved_wager NUMERIC NOT NULL DEFAULT 0 CHECK (reserved_wager >= 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled', 'expired')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    settled_at TIMESTAMPTZ,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE CASCADE,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
  )`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_casino_sessions_binding
    ON casino_sessions(user_id, identity_id, server_id, guild_id, status)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_casino_sessions_expiry
    ON casino_sessions(expires_at) WHERE status = 'active'`);
  console.log('  ✓ casino_sessions');

  // ============================================
  // 7. INDEXES
  // ============================================

  console.log('  Creating indexes...');

  // Guild indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_guilds_discord ON guilds(discord_guild_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_guilds_status ON guilds(status)');

  // Server indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_servers_guild ON servers(guild_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_servers_platform ON servers(platform, platform_server_id)');
  await db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_unique ON servers(guild_id, platform_server_id)');

  // Player identity indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_player_identities_player ON player_identities(player_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_player_identities_platform ON player_identities(platform, platform_user_id)');

  // Gamertag indexes (for search)
  await db.run('CREATE INDEX IF NOT EXISTS idx_gamertags_search ON player_gamertags(LOWER(gamertag), server_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_gamertags_current ON player_gamertags(server_id, is_current_gamertag)');

  // Activity indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_player_server_activity_identity ON player_server_activity(identity_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_player_server_activity_server ON player_server_activity(server_id)');

  // Session indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_player_sessions_identity ON player_sessions(identity_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_player_sessions_server ON player_sessions(server_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_player_sessions_login ON player_sessions(login_at DESC)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_online_cache_server ON server_online_cache(server_id)');

  // Stats indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_player_stats_identity ON player_stats(identity_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_player_stats_server ON player_stats(server_id)');

  // Kill events indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_kill_events_server ON kill_events(server_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_kill_events_killer ON kill_events(killer_identity_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_kill_events_victim ON kill_events(victim_identity_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_kill_events_timestamp ON kill_events(timestamp)');

  // Damage events indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_damage_events_server ON damage_events(server_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_damage_events_victim ON damage_events(victim_identity_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_damage_events_timestamp ON damage_events(timestamp DESC)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_damage_events_attacker_type ON damage_events(attacker_type)');

  // Territory events indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_territory_events_server ON territory_events(server_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_territory_events_identity ON territory_events(identity_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_territory_events_timestamp ON territory_events(timestamp DESC)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_territory_events_type ON territory_events(event_type)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_territory_events_structure ON territory_events(structure_type)');

  // Death events indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_death_events_server ON player_death_events(server_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_death_events_identity ON player_death_events(identity_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_death_events_timestamp ON player_death_events(timestamp DESC)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_death_events_type ON player_death_events(death_type)');
  // Unconscious events indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_unconscious_events_server ON player_unconscious_events(server_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_unconscious_events_identity ON player_unconscious_events(identity_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_unconscious_events_timestamp ON player_unconscious_events(timestamp DESC)');
  // Respawn events indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_respawn_events_server ON player_respawn_events(server_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_respawn_events_identity ON player_respawn_events(identity_id)');
  // Position snapshots indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_position_snapshots_server ON player_position_snapshots(server_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_position_snapshots_identity ON player_position_snapshots(identity_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_position_snapshots_timestamp ON player_position_snapshots(timestamp DESC)');
  // Emote events indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_emote_events_server ON player_emote_events(server_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_emote_events_identity ON player_emote_events(identity_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_emote_events_type ON player_emote_events(emote_type)');

  // Health status indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_health_identity ON player_health_status(identity_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_health_server ON player_health_status(server_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_health_status ON player_health_status(status)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_health_updated ON player_health_status(last_updated DESC)');

  // User indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_users_discord ON users(discord_id)');

  // Linked accounts indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_linked_accounts_user ON linked_accounts(user_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_linked_accounts_identity ON linked_accounts(identity_id)');

  // Audit log indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)');

  // Automation settings indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_automation_userid ON automation_settings(user_id)');

  // Sync jobs indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_sync_jobs_user ON sync_jobs(user_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_sync_jobs_status ON sync_jobs(status)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_sync_jobs_started ON sync_jobs(started_at DESC)');

  // Downloads indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_downloads_user ON downloads(user_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_downloads_server ON downloads(server_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_downloads_job ON downloads(sync_job_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_downloads_date ON downloads(downloaded_at DESC)');

  // Discord feeds indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_discord_feeds_guild ON discord_feeds(guild_id)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_discord_feeds_enabled ON discord_feeds(enabled)');

  // Feed templates indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_feed_templates_guild ON feed_templates(guild_id)');

  // Feed events indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_feed_events_pending ON feed_events(processed, created_at)');
  await db.run('CREATE INDEX IF NOT EXISTS idx_feed_events_guild ON feed_events(guild_id)');

  // Server settings indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_server_settings_server ON server_settings(server_id)');

  // Alt ban exemptions indexes
  await db.run('CREATE INDEX IF NOT EXISTS idx_alt_ban_exemptions_server ON alt_ban_exemptions(server_id)');

  console.log('  ✓ All indexes created');

  // Set schema version
  await db.setSchemaVersion(SCHEMA_VERSION);

  console.log('✅ Schema V2 created successfully!\n');
}

module.exports = {
  createSchemaV2,
  SCHEMA_VERSION
};
