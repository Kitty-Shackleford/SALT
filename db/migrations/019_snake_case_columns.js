'use strict';

async function up(db) {
  const renames = [
    // [table, oldCol, newCol]
    // guilds
    ['guilds', 'discordGuildId', 'discord_guild_id'],
    ['guilds', 'iconUrl', 'icon_url'],
    ['guilds', 'createdAt', 'created_at'],
    // users
    ['users', 'discordId', 'discord_id'],
    ['users', 'accessToken', 'access_token'],
    ['users', 'isAdmin', 'is_admin'],
    // guild_roles
    ['guild_roles', 'guildId', 'guild_id'],
    ['guild_roles', 'userId', 'user_id'],
    ['guild_roles', 'assignedBy', 'assigned_by'],
    // servers
    ['servers', 'guildId', 'guild_id'],
    ['servers', 'platformServerId', 'platform_server_id'],
    ['servers', 'nitradoServerId', 'nitrado_server_id'],
    ['servers', 'lastSyncAt', 'last_sync_at'],
    ['servers', 'playerCount', 'player_count'],
    // guild_tokens
    ['guild_tokens', 'guildId', 'guild_id'],
    ['guild_tokens', 'tokenHash', 'token_hash'],
    ['guild_tokens', 'tokenType', 'token_type'],
    ['guild_tokens', 'lastUsed', 'last_used'],
    ['guild_tokens', 'createdAt', 'created_at'],
    // player_identities
    ['player_identities', 'platformUserId', 'platform_user_id'],
    ['player_identities', 'guildId', 'guild_id'],
    ['player_identities', 'playerId', 'player_id'],
    ['player_identities', 'platformUsername', 'platform_username'],
    ['player_identities', 'deviceId', 'device_id'],
    ['player_identities', 'firstSeen', 'first_seen'],
    ['player_identities', 'lastSeen', 'last_seen'],
    // players
    ['players', 'primaryIdentityId', 'primary_identity_id'],
    // player_gamertags
    ['player_gamertags', 'identityId', 'identity_id'],
    ['player_gamertags', 'serverId', 'server_id'],
    ['player_gamertags', 'isCurrentGamertag', 'is_current_gamertag'],
    ['player_gamertags', 'firstSeen', 'first_seen'],
    ['player_gamertags', 'lastSeen', 'last_seen'],
    // linked_accounts
    ['linked_accounts', 'userId', 'user_id'],
    ['linked_accounts', 'identityId', 'identity_id'],
    ['linked_accounts', 'linkedAt', 'linked_at'],
    ['linked_accounts', 'verificationMethod', 'verification_method'],
    ['linked_accounts', 'primaryIdentityId', 'primary_identity_id'],
    ['linked_accounts', 'verifiedByGuildId', 'verified_by_guild_id'],
    // player_server_activity
    ['player_server_activity', 'identityId', 'identity_id'],
    ['player_server_activity', 'serverId', 'server_id'],
    ['player_server_activity', 'guildId', 'guild_id'],
    ['player_server_activity', 'totalSessions', 'total_sessions'],
    ['player_server_activity', 'totalPlaytime', 'total_playtime'],
    ['player_server_activity', 'totalKills', 'total_kills'],
    ['player_server_activity', 'totalDeaths', 'total_deaths'],
    ['player_server_activity', 'lastSeen', 'last_seen'],
    // player_sessions
    ['player_sessions', 'identityId', 'identity_id'],
    ['player_sessions', 'serverId', 'server_id'],
    ['player_sessions', 'guildId', 'guild_id'],
    ['player_sessions', 'loginAt', 'login_at'],
    ['player_sessions', 'logoutAt', 'logout_at'],
    ['player_sessions', 'sessionDuration', 'session_duration'],
    // player_stats
    ['player_stats', 'identityId', 'identity_id'],
    ['player_stats', 'serverId', 'server_id'],
    ['player_stats', 'guildId', 'guild_id'],
    ['player_stats', 'totalKills', 'total_kills'],
    ['player_stats', 'totalDeaths', 'total_deaths'],
    ['player_stats', 'totalPlaytime', 'total_playtime'],
    ['player_stats', 'lastSeen', 'last_seen'],
    ['player_stats', 'updatedAt', 'updated_at'],
    ['player_stats', 'longestKillDistance', 'longest_kill_distance'],
    ['player_stats', 'totalPlaytimeSeconds', 'total_playtime_seconds'],
    ['player_stats', 'longestSurvivalSeconds', 'longest_survival_seconds'],
    ['player_stats', 'currentSurvivalSeconds', 'current_survival_seconds'],
    // kill_events
    ['kill_events', 'killerIdentityId', 'killer_identity_id'],
    ['kill_events', 'victimIdentityId', 'victim_identity_id'],
    ['kill_events', 'serverId', 'server_id'],
    ['kill_events', 'guildId', 'guild_id'],
    ['kill_events', 'weaponClass', 'weapon_class'],
    ['kill_events', 'killedAt', 'killed_at'],
    ['kill_events', 'killerGamertag', 'killer_gamertag'],
    ['kill_events', 'killerPosition', 'killer_position'],
    ['kill_events', 'victimGamertag', 'victim_gamertag'],
    ['kill_events', 'victimPosition', 'victim_position'],
    // damage_events
    ['damage_events', 'attackerIdentityId', 'attacker_identity_id'],
    ['damage_events', 'victimIdentityId', 'victim_identity_id'],
    ['damage_events', 'serverId', 'server_id'],
    ['damage_events', 'guildId', 'guild_id'],
    ['damage_events', 'damageType', 'damage_type'],
    ['damage_events', 'hitZone', 'hit_zone'],
    ['damage_events', 'damagedAt', 'damaged_at'],
    ['damage_events', 'victimGamertag', 'victim_gamertag'],
    ['damage_events', 'victimPosition', 'victim_position'],
    // territory_events
    ['territory_events', 'identityId', 'identity_id'],
    ['territory_events', 'serverId', 'server_id'],
    ['territory_events', 'guildId', 'guild_id'],
    ['territory_events', 'eventType', 'event_type'],
    ['territory_events', 'loggedAt', 'logged_at'],
    ['territory_events', 'playerGamertag', 'player_gamertag'],
    ['territory_events', 'structureType', 'structure_type'],
    ['territory_events', 'logSource', 'log_source'],
    // player_health_status
    ['player_health_status', 'currentHP', 'current_hp'],
    ['player_health_status', 'maxHP', 'max_hp'],
    ['player_health_status', 'lastPosition', 'last_position'],
    ['player_health_status', 'lastUpdated', 'last_updated'],
    // economy_accounts
    ['economy_accounts', 'identityId', 'identity_id'],
    ['economy_accounts', 'serverId', 'server_id'],
    ['economy_accounts', 'guildId', 'guild_id'],
    ['economy_accounts', 'cashOnHand', 'cash_on_hand'],
    ['economy_accounts', 'bankBalance', 'bank_balance'],
    ['economy_accounts', 'lastUpdated', 'last_updated'],
    ['economy_accounts', 'lastTransaction', 'last_transaction'],
    ['economy_accounts', 'accountType', 'account_type'],
    // economy_transactions
    ['economy_transactions', 'identityId', 'identity_id'],
    ['economy_transactions', 'serverId', 'server_id'],
    ['economy_transactions', 'guildId', 'guild_id'],
    ['economy_transactions', 'transactionType', 'transaction_type'],
    ['economy_transactions', 'balanceAfter', 'balance_after'],
    ['economy_transactions', 'accountType', 'account_type'],
    ['economy_transactions', 'createdAt', 'created_at'],
    // guild_economy_config
    ['guild_economy_config', 'guildId', 'guild_id'],
    ['guild_economy_config', 'startingCash', 'starting_cash'],
    ['guild_economy_config', 'startingBank', 'starting_bank'],
    ['guild_economy_config', 'currencySymbol', 'currency_symbol'],
    ['guild_economy_config', 'bankEnabled', 'bank_enabled'],
    ['guild_economy_config', 'bankDailyFeeEnabled', 'bank_daily_fee_enabled'],
    ['guild_economy_config', 'bankDailyFeeType', 'bank_daily_fee_type'],
    ['guild_economy_config', 'bankDailyFeeAmount', 'bank_daily_fee_amount'],
    ['guild_economy_config', 'deathPenaltyEnabled', 'death_penalty_enabled'],
    ['guild_economy_config', 'deathPenaltyType', 'death_penalty_type'],
    ['guild_economy_config', 'deathPenaltyAmount', 'death_penalty_amount'],
    ['guild_economy_config', 'deathPenaltyMaxLoss', 'death_penalty_max_loss'],
    ['guild_economy_config', 'deathDropsMoneyOnGround', 'death_drops_money_on_ground'],
    ['guild_economy_config', 'fixedSupplyEnabled', 'fixed_supply_enabled'],
    ['guild_economy_config', 'maxMoneySupply', 'max_money_supply'],
    ['guild_economy_config', 'currentMoneySupply', 'current_money_supply'],
    ['guild_economy_config', 'lastSupplyUpdate', 'last_supply_update'],
    ['guild_economy_config', 'inactivityTaxEnabled', 'inactivity_tax_enabled'],
    ['guild_economy_config', 'inactivityTaxThresholdDays', 'inactivity_tax_threshold_days'],
    ['guild_economy_config', 'inactivityTaxPercentage', 'inactivity_tax_percentage'],
    ['guild_economy_config', 'territoryRewardsEnabled', 'territory_rewards_enabled'],
    ['guild_economy_config', 'territoryRewardPerHour', 'territory_reward_per_hour'],
    ['guild_economy_config', 'currencyName', 'currency_name'],
    ['guild_economy_config', 'monetarySystem', 'monetary_system'],
    ['guild_economy_config', 'totalMoneySupply', 'total_money_supply'],
    ['guild_economy_config', 'killRewardsEnabled', 'kill_rewards_enabled'],
    ['guild_economy_config', 'killReward', 'kill_reward'],
    ['guild_economy_config', 'playtimeRewardsEnabled', 'playtime_rewards_enabled'],
    ['guild_economy_config', 'playtimeRewardPerHour', 'playtime_reward_per_hour'],
    ['guild_economy_config', 'achievementRewardsEnabled', 'achievement_rewards_enabled'],
    ['guild_economy_config', 'achievementBonusMultiplier', 'achievement_bonus_multiplier'],
    ['guild_economy_config', 'transferEnabled', 'transfer_enabled'],
    ['guild_economy_config', 'transferFeePercentage', 'transfer_fee_percentage'],
    ['guild_economy_config', 'transferRequireBothOnline', 'transfer_require_both_online'],
    ['guild_economy_config', 'transferOfflineFeePercentage', 'transfer_offline_fee_percentage'],
    ['guild_economy_config', 'transferMinAmount', 'transfer_min_amount'],
    ['guild_economy_config', 'transferMaxAmount', 'transfer_max_amount'],
    ['guild_economy_config', 'maxBankBalance', 'max_bank_balance'],
    ['guild_economy_config', 'bankDepositFeePercentage', 'bank_deposit_fee_percentage'],
    ['guild_economy_config', 'bankWithdrawFeePercentage', 'bank_withdraw_fee_percentage'],
    ['guild_economy_config', 'inactivityThresholdDays', 'inactivity_threshold_days'],
    // economy_supply_log
    ['economy_supply_log', 'guildId', 'guild_id'],
    ['economy_supply_log', 'changeType', 'change_type'],
    ['economy_supply_log', 'supplyBefore', 'supply_before'],
    ['economy_supply_log', 'supplyAfter', 'supply_after'],
    ['economy_supply_log', 'identityId', 'identity_id'],
    ['economy_supply_log', 'serverId', 'server_id'],
    ['economy_supply_log', 'createdAt', 'created_at'],
    // discord_feeds
    ['discord_feeds', 'guildId', 'guild_id'],
    ['discord_feeds', 'discordGuildId', 'discord_guild_id'],
    ['discord_feeds', 'feedType', 'feed_type'],
    ['discord_feeds', 'channelId', 'channel_id'],
    ['discord_feeds', 'webhookUrl', 'webhook_url'],
    ['discord_feeds', 'updatedAt', 'updated_at'],
    // feed_templates
    ['feed_templates', 'guildId', 'guild_id'],
    ['feed_templates', 'feedType', 'feed_type'],
    ['feed_templates', 'eventType', 'event_type'],
    ['feed_templates', 'embedEnabled', 'embed_enabled'],
    ['feed_templates', 'embedColor', 'embed_color'],
    ['feed_templates', 'createdAt', 'created_at'],
    ['feed_templates', 'updatedAt', 'updated_at'],
    // feed_events
    ['feed_events', 'guildId', 'guild_id'],
    ['feed_events', 'serverId', 'server_id'],
    ['feed_events', 'feedType', 'feed_type'],
    ['feed_events', 'eventType', 'event_type'],
    ['feed_events', 'eventData', 'event_data'],
    ['feed_events', 'createdAt', 'created_at'],
    // automation_settings
    ['automation_settings', 'guildId', 'guild_id'],
    ['automation_settings', 'userId', 'user_id'],
    ['automation_settings', 'autoLogSync', 'auto_log_sync'],
    ['automation_settings', 'autoTracking', 'auto_tracking'],
    // sync_jobs
    ['sync_jobs', 'userId', 'user_id'],
    ['sync_jobs', 'serverId', 'server_id'],
    ['sync_jobs', 'filesDownloaded', 'files_downloaded'],
    ['sync_jobs', 'totalSize', 'total_size'],
    ['sync_jobs', 'completedAt', 'completed_at'],
    // auto_ban_rules (may not exist yet)
    ['auto_ban_rules', 'guildId', 'guild_id'],
    ['auto_ban_rules', 'serverId', 'server_id'],
    ['auto_ban_rules', 'createdBy', 'created_by'],
    ['auto_ban_rules', 'createdAt', 'created_at'],
    // auto_ban_log (may not exist yet)
    ['auto_ban_log', 'identityId', 'identity_id'],
    ['auto_ban_log', 'serverId', 'server_id'],
    ['auto_ban_log', 'guildId', 'guild_id'],
    ['auto_ban_log', 'ruleId', 'rule_id'],
    ['auto_ban_log', 'bannedAt', 'banned_at'],
  ];

  // helper: rename one column, ignoring 42703 (column does not exist) and 42P01 (table does not exist).
  // Uses SAVEPOINT so a caught error doesn't abort the outer transaction.
  // oldCol is unquoted so PostgreSQL matches it case-insensitively (PG stores unquoted
  // identifiers as lowercase, e.g. the original "discordId" column is stored as "discordid").
  async function safeRename(client, table, oldCol, newCol) {
    await client.query('SAVEPOINT sp_rename');
    try {
      await client.query(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
      await client.query('RELEASE SAVEPOINT sp_rename');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT sp_rename');
      if (err.code !== '42703' && err.code !== '42P01') throw err;
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const [table, oldCol, newCol] of renames) {
      await safeRename(client, table, oldCol, newCol);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function down(db) {
  const renames = [
    // [table, snake_case, camelCase]
    // guilds
    ['guilds', 'discord_guild_id', 'discordGuildId'],
    ['guilds', 'icon_url', 'iconUrl'],
    ['guilds', 'created_at', 'createdAt'],
    // users
    ['users', 'discord_id', 'discordId'],
    ['users', 'access_token', 'accessToken'],
    ['users', 'is_admin', 'isAdmin'],
    // guild_roles
    ['guild_roles', 'guild_id', 'guildId'],
    ['guild_roles', 'user_id', 'userId'],
    ['guild_roles', 'assigned_by', 'assignedBy'],
    // servers
    ['servers', 'guild_id', 'guildId'],
    ['servers', 'platform_server_id', 'platformServerId'],
    ['servers', 'nitrado_server_id', 'nitradoServerId'],
    ['servers', 'last_sync_at', 'lastSyncAt'],
    ['servers', 'player_count', 'playerCount'],
    // guild_tokens
    ['guild_tokens', 'guild_id', 'guildId'],
    ['guild_tokens', 'token_hash', 'tokenHash'],
    ['guild_tokens', 'token_type', 'tokenType'],
    ['guild_tokens', 'last_used', 'lastUsed'],
    ['guild_tokens', 'created_at', 'createdAt'],
    // player_identities
    ['player_identities', 'platform_user_id', 'platformUserId'],
    ['player_identities', 'guild_id', 'guildId'],
    ['player_identities', 'player_id', 'playerId'],
    ['player_identities', 'platform_username', 'platformUsername'],
    ['player_identities', 'device_id', 'deviceId'],
    ['player_identities', 'first_seen', 'firstSeen'],
    ['player_identities', 'last_seen', 'lastSeen'],
    // players
    ['players', 'primary_identity_id', 'primaryIdentityId'],
    // player_gamertags
    ['player_gamertags', 'identity_id', 'identityId'],
    ['player_gamertags', 'server_id', 'serverId'],
    ['player_gamertags', 'is_current_gamertag', 'isCurrentGamertag'],
    ['player_gamertags', 'first_seen', 'firstSeen'],
    ['player_gamertags', 'last_seen', 'lastSeen'],
    // linked_accounts
    ['linked_accounts', 'user_id', 'userId'],
    ['linked_accounts', 'identity_id', 'identityId'],
    ['linked_accounts', 'linked_at', 'linkedAt'],
    ['linked_accounts', 'verification_method', 'verificationMethod'],
    ['linked_accounts', 'primary_identity_id', 'primaryIdentityId'],
    ['linked_accounts', 'verified_by_guild_id', 'verifiedByGuildId'],
    // player_server_activity
    ['player_server_activity', 'identity_id', 'identityId'],
    ['player_server_activity', 'server_id', 'serverId'],
    ['player_server_activity', 'guild_id', 'guildId'],
    ['player_server_activity', 'total_sessions', 'totalSessions'],
    ['player_server_activity', 'total_playtime', 'totalPlaytime'],
    ['player_server_activity', 'total_kills', 'totalKills'],
    ['player_server_activity', 'total_deaths', 'totalDeaths'],
    ['player_server_activity', 'last_seen', 'lastSeen'],
    // player_sessions
    ['player_sessions', 'identity_id', 'identityId'],
    ['player_sessions', 'server_id', 'serverId'],
    ['player_sessions', 'guild_id', 'guildId'],
    ['player_sessions', 'login_at', 'loginAt'],
    ['player_sessions', 'logout_at', 'logoutAt'],
    ['player_sessions', 'session_duration', 'sessionDuration'],
    // player_stats
    ['player_stats', 'identity_id', 'identityId'],
    ['player_stats', 'server_id', 'serverId'],
    ['player_stats', 'guild_id', 'guildId'],
    ['player_stats', 'total_kills', 'totalKills'],
    ['player_stats', 'total_deaths', 'totalDeaths'],
    ['player_stats', 'total_playtime', 'totalPlaytime'],
    ['player_stats', 'last_seen', 'lastSeen'],
    ['player_stats', 'updated_at', 'updatedAt'],
    ['player_stats', 'longest_kill_distance', 'longestKillDistance'],
    ['player_stats', 'total_playtime_seconds', 'totalPlaytimeSeconds'],
    ['player_stats', 'longest_survival_seconds', 'longestSurvivalSeconds'],
    ['player_stats', 'current_survival_seconds', 'currentSurvivalSeconds'],
    // kill_events
    ['kill_events', 'killer_identity_id', 'killerIdentityId'],
    ['kill_events', 'victim_identity_id', 'victimIdentityId'],
    ['kill_events', 'server_id', 'serverId'],
    ['kill_events', 'guild_id', 'guildId'],
    ['kill_events', 'weapon_class', 'weaponClass'],
    ['kill_events', 'killed_at', 'killedAt'],
    ['kill_events', 'killer_gamertag', 'killerGamertag'],
    ['kill_events', 'killer_position', 'killerPosition'],
    ['kill_events', 'victim_gamertag', 'victimGamertag'],
    ['kill_events', 'victim_position', 'victimPosition'],
    // damage_events
    ['damage_events', 'attacker_identity_id', 'attackerIdentityId'],
    ['damage_events', 'victim_identity_id', 'victimIdentityId'],
    ['damage_events', 'server_id', 'serverId'],
    ['damage_events', 'guild_id', 'guildId'],
    ['damage_events', 'damage_type', 'damageType'],
    ['damage_events', 'hit_zone', 'hitZone'],
    ['damage_events', 'damaged_at', 'damagedAt'],
    ['damage_events', 'victim_gamertag', 'victimGamertag'],
    ['damage_events', 'victim_position', 'victimPosition'],
    // territory_events
    ['territory_events', 'identity_id', 'identityId'],
    ['territory_events', 'server_id', 'serverId'],
    ['territory_events', 'guild_id', 'guildId'],
    ['territory_events', 'event_type', 'eventType'],
    ['territory_events', 'logged_at', 'loggedAt'],
    ['territory_events', 'player_gamertag', 'playerGamertag'],
    ['territory_events', 'structure_type', 'structureType'],
    ['territory_events', 'log_source', 'logSource'],
    // player_health_status
    ['player_health_status', 'current_hp', 'currentHP'],
    ['player_health_status', 'max_hp', 'maxHP'],
    ['player_health_status', 'last_position', 'lastPosition'],
    ['player_health_status', 'last_updated', 'lastUpdated'],
    // economy_accounts
    ['economy_accounts', 'identity_id', 'identityId'],
    ['economy_accounts', 'server_id', 'serverId'],
    ['economy_accounts', 'guild_id', 'guildId'],
    ['economy_accounts', 'cash_on_hand', 'cashOnHand'],
    ['economy_accounts', 'bank_balance', 'bankBalance'],
    ['economy_accounts', 'last_updated', 'lastUpdated'],
    ['economy_accounts', 'last_transaction', 'lastTransaction'],
    ['economy_accounts', 'account_type', 'accountType'],
    // economy_transactions
    ['economy_transactions', 'identity_id', 'identityId'],
    ['economy_transactions', 'server_id', 'serverId'],
    ['economy_transactions', 'guild_id', 'guildId'],
    ['economy_transactions', 'transaction_type', 'transactionType'],
    ['economy_transactions', 'balance_after', 'balanceAfter'],
    ['economy_transactions', 'account_type', 'accountType'],
    ['economy_transactions', 'created_at', 'createdAt'],
    // guild_economy_config
    ['guild_economy_config', 'guild_id', 'guildId'],
    ['guild_economy_config', 'starting_cash', 'startingCash'],
    ['guild_economy_config', 'starting_bank', 'startingBank'],
    ['guild_economy_config', 'currency_symbol', 'currencySymbol'],
    ['guild_economy_config', 'bank_enabled', 'bankEnabled'],
    ['guild_economy_config', 'bank_daily_fee_enabled', 'bankDailyFeeEnabled'],
    ['guild_economy_config', 'bank_daily_fee_type', 'bankDailyFeeType'],
    ['guild_economy_config', 'bank_daily_fee_amount', 'bankDailyFeeAmount'],
    ['guild_economy_config', 'death_penalty_enabled', 'deathPenaltyEnabled'],
    ['guild_economy_config', 'death_penalty_type', 'deathPenaltyType'],
    ['guild_economy_config', 'death_penalty_amount', 'deathPenaltyAmount'],
    ['guild_economy_config', 'death_penalty_max_loss', 'deathPenaltyMaxLoss'],
    ['guild_economy_config', 'death_drops_money_on_ground', 'deathDropsMoneyOnGround'],
    ['guild_economy_config', 'fixed_supply_enabled', 'fixedSupplyEnabled'],
    ['guild_economy_config', 'max_money_supply', 'maxMoneySupply'],
    ['guild_economy_config', 'current_money_supply', 'currentMoneySupply'],
    ['guild_economy_config', 'last_supply_update', 'lastSupplyUpdate'],
    ['guild_economy_config', 'inactivity_tax_enabled', 'inactivityTaxEnabled'],
    ['guild_economy_config', 'inactivity_tax_threshold_days', 'inactivityTaxThresholdDays'],
    ['guild_economy_config', 'inactivity_tax_percentage', 'inactivityTaxPercentage'],
    ['guild_economy_config', 'territory_rewards_enabled', 'territoryRewardsEnabled'],
    ['guild_economy_config', 'territory_reward_per_hour', 'territoryRewardPerHour'],
    ['guild_economy_config', 'currency_name', 'currencyName'],
    ['guild_economy_config', 'monetary_system', 'monetarySystem'],
    ['guild_economy_config', 'total_money_supply', 'totalMoneySupply'],
    ['guild_economy_config', 'kill_rewards_enabled', 'killRewardsEnabled'],
    ['guild_economy_config', 'kill_reward', 'killReward'],
    ['guild_economy_config', 'playtime_rewards_enabled', 'playtimeRewardsEnabled'],
    ['guild_economy_config', 'playtime_reward_per_hour', 'playtimeRewardPerHour'],
    ['guild_economy_config', 'achievement_rewards_enabled', 'achievementRewardsEnabled'],
    ['guild_economy_config', 'achievement_bonus_multiplier', 'achievementBonusMultiplier'],
    ['guild_economy_config', 'transfer_enabled', 'transferEnabled'],
    ['guild_economy_config', 'transfer_fee_percentage', 'transferFeePercentage'],
    ['guild_economy_config', 'transfer_require_both_online', 'transferRequireBothOnline'],
    ['guild_economy_config', 'transfer_offline_fee_percentage', 'transferOfflineFeePercentage'],
    ['guild_economy_config', 'transfer_min_amount', 'transferMinAmount'],
    ['guild_economy_config', 'transfer_max_amount', 'transferMaxAmount'],
    ['guild_economy_config', 'max_bank_balance', 'maxBankBalance'],
    ['guild_economy_config', 'bank_deposit_fee_percentage', 'bankDepositFeePercentage'],
    ['guild_economy_config', 'bank_withdraw_fee_percentage', 'bankWithdrawFeePercentage'],
    ['guild_economy_config', 'inactivity_threshold_days', 'inactivityThresholdDays'],
    // economy_supply_log
    ['economy_supply_log', 'guild_id', 'guildId'],
    ['economy_supply_log', 'change_type', 'changeType'],
    ['economy_supply_log', 'supply_before', 'supplyBefore'],
    ['economy_supply_log', 'supply_after', 'supplyAfter'],
    ['economy_supply_log', 'identity_id', 'identityId'],
    ['economy_supply_log', 'server_id', 'serverId'],
    ['economy_supply_log', 'created_at', 'createdAt'],
    // discord_feeds
    ['discord_feeds', 'guild_id', 'guildId'],
    ['discord_feeds', 'discord_guild_id', 'discordGuildId'],
    ['discord_feeds', 'feed_type', 'feedType'],
    ['discord_feeds', 'channel_id', 'channelId'],
    ['discord_feeds', 'webhook_url', 'webhookUrl'],
    ['discord_feeds', 'updated_at', 'updatedAt'],
    // feed_templates
    ['feed_templates', 'guild_id', 'guildId'],
    ['feed_templates', 'feed_type', 'feedType'],
    ['feed_templates', 'event_type', 'eventType'],
    ['feed_templates', 'embed_enabled', 'embedEnabled'],
    ['feed_templates', 'embed_color', 'embedColor'],
    ['feed_templates', 'created_at', 'createdAt'],
    ['feed_templates', 'updated_at', 'updatedAt'],
    // feed_events
    ['feed_events', 'guild_id', 'guildId'],
    ['feed_events', 'server_id', 'serverId'],
    ['feed_events', 'feed_type', 'feedType'],
    ['feed_events', 'event_type', 'eventType'],
    ['feed_events', 'event_data', 'eventData'],
    ['feed_events', 'created_at', 'createdAt'],
    // automation_settings
    ['automation_settings', 'guild_id', 'guildId'],
    ['automation_settings', 'user_id', 'userId'],
    ['automation_settings', 'auto_log_sync', 'autoLogSync'],
    ['automation_settings', 'auto_tracking', 'autoTracking'],
    // sync_jobs
    ['sync_jobs', 'user_id', 'userId'],
    ['sync_jobs', 'server_id', 'serverId'],
    ['sync_jobs', 'files_downloaded', 'filesDownloaded'],
    ['sync_jobs', 'total_size', 'totalSize'],
    ['sync_jobs', 'completed_at', 'completedAt'],
    // auto_ban_rules (may not exist yet)
    ['auto_ban_rules', 'guild_id', 'guildId'],
    ['auto_ban_rules', 'server_id', 'serverId'],
    ['auto_ban_rules', 'created_by', 'createdBy'],
    ['auto_ban_rules', 'created_at', 'createdAt'],
    // auto_ban_log (may not exist yet)
    ['auto_ban_log', 'identity_id', 'identityId'],
    ['auto_ban_log', 'server_id', 'serverId'],
    ['auto_ban_log', 'guild_id', 'guildId'],
    ['auto_ban_log', 'rule_id', 'ruleId'],
    ['auto_ban_log', 'banned_at', 'bannedAt'],
  ];

  async function safeRename(client, table, oldCol, newCol) {
    await client.query('SAVEPOINT sp_rename');
    try {
      await client.query(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
      await client.query('RELEASE SAVEPOINT sp_rename');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT sp_rename');
      if (err.code !== '42703' && err.code !== '42P01') throw err;
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const [table, oldCol, newCol] of renames) {
      await safeRename(client, table, oldCol, newCol);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { up, down };
