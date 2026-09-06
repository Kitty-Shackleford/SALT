'use strict';

const bountyService = require('./bountyService');
const moneySupplyManager = require('../utils/moneySupplyManager');
const { centsToDecimal } = require('../utils/money');

const ECONOMY_ENUM_FIELDS = Object.freeze({
  monetary_system: new Set(['fiat', 'fixed']),
  death_penalty_type: new Set(['percentage', 'fixed']),
  bank_daily_fee_type: new Set(['percentage', 'fixed']),
});

const DEFAULT_EDITABLE_CONFIG = Object.freeze({
  enabled: false,
  currencyName: 'Dollar',
  currencySymbol: '$',
  startingCash: 1000,
  startingBank: 0,
  monetarySystem: 'fiat',
  totalMoneySupply: null,
  killRewardsEnabled: true,
  killReward: 100,
  playtimeRewardsEnabled: true,
  playtimeRewardPerHour: 10,
  achievementRewardsEnabled: false,
  achievementBonusMultiplier: 1,
  territoryRewardsEnabled: false,
  territoryRewardsSupported: false,
  territoryRewardPerHour: 5,
  deathPenaltyEnabled: false,
  deathPenaltyType: 'percentage',
  deathPenaltyAmount: 10,
  deathPenaltyMaxLoss: null,
  deathDropsMoneyOnGround: false,
  transferEnabled: true,
  transferFeePercentage: 0,
  transferRequireBothOnline: false,
  transferOfflineFeePercentage: 5,
  transferMinAmount: 1,
  transferMaxAmount: null,
  bankEnabled: true,
  maxBankBalance: null,
  bankDepositFeePercentage: 0,
  bankWithdrawFeePercentage: 0,
  bankDailyFeeEnabled: false,
  bankDailyFeeType: 'percentage',
  bankDailyFeeAmount: 0.1,
  inactivityTaxEnabled: false,
  inactivityThresholdDays: 30,
  inactivityTaxPercentage: 5,
  fixedSupplyEnabled: false,
  maxMoneySupply: null,
  currentMoneySupply: 0,
  version: 1,
  prospective: true,
});

const EDITABLE_COLUMNS = Object.freeze({
  currency_name: 'currencyName', currency_symbol: 'currencySymbol',
  starting_cash: 'startingCash', starting_bank: 'startingBank',
  monetary_system: 'monetarySystem', total_money_supply: 'totalMoneySupply',
  kill_rewards_enabled: 'killRewardsEnabled', kill_reward: 'killReward',
  playtime_rewards_enabled: 'playtimeRewardsEnabled', playtime_reward_per_hour: 'playtimeRewardPerHour',
  achievement_rewards_enabled: 'achievementRewardsEnabled', achievement_bonus_multiplier: 'achievementBonusMultiplier',
  territory_rewards_enabled: 'territoryRewardsEnabled', territory_reward_per_hour: 'territoryRewardPerHour',
  death_penalty_enabled: 'deathPenaltyEnabled', death_penalty_type: 'deathPenaltyType',
  death_penalty_amount: 'deathPenaltyAmount', death_penalty_max_loss: 'deathPenaltyMaxLoss',
  death_drops_money_on_ground: 'deathDropsMoneyOnGround', transfer_enabled: 'transferEnabled',
  transfer_fee_percentage: 'transferFeePercentage', transfer_require_both_online: 'transferRequireBothOnline',
  transfer_offline_fee_percentage: 'transferOfflineFeePercentage', transfer_min_amount: 'transferMinAmount',
  transfer_max_amount: 'transferMaxAmount', bank_enabled: 'bankEnabled', max_bank_balance: 'maxBankBalance',
  bank_deposit_fee_percentage: 'bankDepositFeePercentage', bank_withdraw_fee_percentage: 'bankWithdrawFeePercentage',
  bank_daily_fee_enabled: 'bankDailyFeeEnabled', bank_daily_fee_type: 'bankDailyFeeType',
  bank_daily_fee_amount: 'bankDailyFeeAmount', inactivity_tax_enabled: 'inactivityTaxEnabled',
  inactivity_threshold_days: 'inactivityThresholdDays', inactivity_tax_percentage: 'inactivityTaxPercentage',
  fixed_supply_enabled: 'fixedSupplyEnabled', max_money_supply: 'maxMoneySupply',
  current_money_supply: 'currentMoneySupply',
});

function suppressUnsupportedTerritoryRewardConfig(config) {
  const safeConfig = { ...config };
  delete safeConfig.territory_rewards_enabled;
  delete safeConfig.territory_reward_per_hour;
  safeConfig.territoryRewardsEnabled = false;
  safeConfig.territoryRewardsSupported = false;
  safeConfig.territoryRewardPerHour = DEFAULT_EDITABLE_CONFIG.territoryRewardPerHour;
  return safeConfig;
}

function serializeEditableEconomyConfig(row) {
  if (!row) return { ...DEFAULT_EDITABLE_CONFIG };
  const config = { ...row, prospective: false, version: Number(row.version) };
  for (const [column, property] of Object.entries(EDITABLE_COLUMNS)) {
    if (Object.prototype.hasOwnProperty.call(row, column)) config[property] = row[column];
  }
  if (config.bankDailyFeeType === 'flat') config.bankDailyFeeType = 'fixed';
  return suppressUnsupportedTerritoryRewardConfig(config);
}

async function getEditableEconomyConfig(db, serverId) {
  const row = await db.get('SELECT * FROM guild_economy_config WHERE server_id = ?', [serverId]);
  return serializeEditableEconomyConfig(row);
}

function versionConflict() {
  const error = new Error('Economy settings changed; reload before saving');
  error.status = 409;
  return error;
}

async function saveEconomyConfigInTransaction(db, context, input, entries, expectedVersion, options = {}) {
  const existing = Object.prototype.hasOwnProperty.call(options, 'existing')
    ? options.existing
    : await db.get('SELECT * FROM guild_economy_config WHERE server_id = ? FOR UPDATE', [context.serverId]);
  const currentMoneySupply = options.currentMoneySupply ?? existing?.current_money_supply ?? 0;
  if (!existing) {
    if (expectedVersion !== 1) throw versionConflict();
    const inserted = await db.run(
      `INSERT INTO guild_economy_config
       (guild_id, server_id, ${entries.join(', ')}, current_money_supply, version)
       VALUES (?, ?, ${entries.map(() => '?').join(', ')}, ?, 2)
       ON CONFLICT (server_id) DO NOTHING`,
      [context.guildId, context.serverId, ...entries.map(key => input[key]),
        centsToDecimal(currentMoneySupply)]
    );
    if (inserted.changes !== 1) throw versionConflict();
    return { version: 2 };
  }
  if (Number(existing.version) !== expectedVersion) throw versionConflict();
  const updated = await db.run(
    `UPDATE guild_economy_config SET ${entries.map(key => key + ' = ?').join(', ')},
       current_money_supply = ?, version = version + 1, updated_at = NOW()
     WHERE server_id = ? AND version = ?`,
    [...entries.map(key => input[key]), centsToDecimal(currentMoneySupply),
      context.serverId, expectedVersion]
  );
  if (updated.changes !== 1) throw versionConflict();
  return { version: expectedVersion + 1 };
}

async function recalculateSupplyForAdmin(db, context) {
  return db.transaction(async transactionDb => {
    await bountyService.lockBountyAdminAuthority(transactionDb, context);
    return moneySupplyManager.recalculateSupplyInTransaction(transactionDb, context.serverId);
  });
}

module.exports = {
  ECONOMY_ENUM_FIELDS,
  getEditableEconomyConfig,
  recalculateSupplyForAdmin,
  saveEconomyConfigInTransaction,
  serializeEditableEconomyConfig,
  suppressUnsupportedTerritoryRewardConfig,
};