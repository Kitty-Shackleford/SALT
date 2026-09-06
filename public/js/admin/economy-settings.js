/**
 * Admin Economy Settings Page
 * Handles loading, editing, and saving guild economy configuration.
 */

let currentServerId = null;
let loadedServerId = null;
let configurationGeneration = 0;
let statsRequestGeneration = 0;
let bountySettingsVersion = null;
let economySettingsVersion = null;

// ── Default configuration ──────────────────────────────────────────────────
function getDefaultConfig() {
  return {
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
    achievementBonusMultiplier: 1.0,
    territoryRewardsEnabled: false,
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
    maxMoneySupply: null
  };
}

// ── Load guilds into dropdown ──────────────────────────────────────────────
async function loadGuilds() {
  try {
    const res = await fetch('/api/user/guilds', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Failed to load guilds');
    const data = await res.json();
    const select = document.getElementById('guildSelect');
    select.innerHTML = '<option value="">-- Select a server --</option>';
    for (const guild of (data.guilds || data)) {
      const serversRes = await fetch(`/api/guilds/${guild.id}/servers`, { credentials: 'same-origin' });
      const serversData = await serversRes.json();
      for (const server of (serversData.servers || [])) {
        const opt = document.createElement('option');
        opt.value = server.id;
        opt.textContent = `${guild.name || 'Guild'} — ${server.name || `Server ${server.id}`}`;
        select.appendChild(opt);
      }
    }
  } catch (err) {
    console.error('Error loading servers:', err);
    document.getElementById('guildSelect').innerHTML = '<option value="">-- Error loading servers --</option>';
  }
}

// ── Load configuration for a guild ────────────────────────────────────────
async function loadConfiguration(guildId, generation) {
  document.getElementById('noGuildState').classList.add('hidden');
  document.getElementById('settingsContainer').classList.add('hidden');
  document.getElementById('loadingState').classList.remove('hidden');
  document.getElementById('saveBtn').disabled = true;

  try {
    const res = await fetch(`/api/economy/admin/${guildId}/config`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Failed to load configuration');
    const data = await res.json();
    if (generation !== configurationGeneration || guildId !== currentServerId) return;
    const bountyRes = await fetch(`/api/bounties/admin/${guildId}/settings`, {
      credentials: 'same-origin'
    });
    if (!bountyRes.ok) throw new Error('Failed to load bounty safety settings');
    const bountyData = await bountyRes.json();
    if (generation !== configurationGeneration || guildId !== currentServerId) return;

    const config = data.config || getDefaultConfig();
    economySettingsVersion = Number(config.version);
    if (!Number.isSafeInteger(economySettingsVersion) || economySettingsVersion <= 0) {
      throw new Error('Invalid economy settings version');
    }
    populateForm(config);
    setCheckbox('bountyRequireTargetOnline', bountyData.settings?.requireTargetOnline !== false);
    document.getElementById('bountyFactionKillsRequired').value = Number(bountyData.settings?.factionKillsRequired || 3);
    bountySettingsVersion = Number(bountyData.settings?.version);
    if (!Number.isSafeInteger(bountySettingsVersion) || bountySettingsVersion <= 0) {
      throw new Error('Invalid bounty safety settings version');
    }
    loadedServerId = guildId;
    document.getElementById('saveBtn').disabled = false;

    document.getElementById('loadingState').classList.add('hidden');
    document.getElementById('settingsContainer').classList.remove('hidden');

    if (config.enabled) {
      await loadStats(guildId);
    }
    return true;
  } catch (err) {
    if (generation !== configurationGeneration || guildId !== currentServerId) return;
    console.error('Error loading configuration:', err);
    document.getElementById('loadingState').classList.add('hidden');
    showAlert('error', 'Failed to load configuration: ' + err.message);
    return false;
  }
}

// ── Load economy stats ─────────────────────────────────────────────────────
async function loadStats(serverId, generation = configurationGeneration) {
  const requestedServerId = serverId;
  const requestId = ++statsRequestGeneration;
  const isCurrent = () => generation === configurationGeneration
    && requestedServerId === currentServerId
    && requestId === statsRequestGeneration;
  const statsSection = document.getElementById('statsSection');
  if (isCurrent()) statsSection.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch(`/api/economy/admin/${requestedServerId}/stats`, { credentials: 'same-origin' });
    if (!isCurrent()) return;
    if (!res.ok) return;
    const data = await res.json();
    if (!isCurrent()) return;

    if (data.enabled === false) return;

    const stats = data.stats || {};
    const symbol = document.getElementById('currencySymbol').value || '$';

    document.getElementById('statTotalMoney').textContent =
      symbol + formatNumber(stats.totalMoney || 0);
    document.getElementById('statPlayers').textContent =
      formatNumber(stats.playerCount || 0);
    document.getElementById('statAvgWealth').textContent =
      symbol + formatNumber(
        parseFloat(stats.avgCashPerPlayer || 0) + parseFloat(stats.avgBankPerPlayer || 0)
      );
    document.getElementById('statTx24h').textContent =
      formatNumber(stats.recentTransactionCount24h || 0);

    statsSection.classList.remove('hidden');
  } catch (err) {
    if (!isCurrent()) return;
    console.error('Error loading stats:', err);
  } finally {
    if (isCurrent()) statsSection.setAttribute('aria-busy', 'false');
  }
}

// ── Populate form fields from config object ────────────────────────────────
function populateForm(config) {
  setCheckbox('economyEnabled', config.enabled);
  setInput('currencyName', config.currencyName);
  setInput('currencySymbol', config.currencySymbol);
  setInput('startingCash', config.startingCash);
  setInput('startingBank', config.startingBank);
  setSelect('monetarySystem', config.monetarySystem);
  setInput('totalMoneySupply', config.totalMoneySupply);

  setCheckbox('killRewardsEnabled', config.killRewardsEnabled);
  setInput('killReward', config.killReward);
  setCheckbox('playtimeRewardsEnabled', config.playtimeRewardsEnabled);
  setInput('playtimeRewardPerHour', config.playtimeRewardPerHour);
  setCheckbox('achievementRewardsEnabled', config.achievementRewardsEnabled);
  setInput('achievementBonusMultiplier', config.achievementBonusMultiplier);
  setCheckbox('territoryRewardsEnabled', config.territoryRewardsEnabled);
  setInput('territoryRewardPerHour', config.territoryRewardPerHour);

  setCheckbox('deathPenaltyEnabled', config.deathPenaltyEnabled);
  setSelect('deathPenaltyType', config.deathPenaltyType);
  setInput('deathPenaltyAmount', config.deathPenaltyAmount);
  setInput('deathPenaltyMaxLoss', config.deathPenaltyMaxLoss);
  setCheckbox('deathDropsMoneyOnGround', config.deathDropsMoneyOnGround);

  setCheckbox('transferEnabled', config.transferEnabled);
  setInput('transferFeePercentage', config.transferFeePercentage);
  setCheckbox('transferRequireBothOnline', config.transferRequireBothOnline);
  setInput('transferOfflineFeePercentage', config.transferOfflineFeePercentage);
  setInput('transferMinAmount', config.transferMinAmount);
  setInput('transferMaxAmount', config.transferMaxAmount);

  setCheckbox('bankEnabled', config.bankEnabled);
  setInput('maxBankBalance', config.maxBankBalance);
  setInput('bankDepositFeePercentage', config.bankDepositFeePercentage);
  setInput('bankWithdrawFeePercentage', config.bankWithdrawFeePercentage);
  setCheckbox('bankDailyFeeEnabled', config.bankDailyFeeEnabled);
  setSelect('bankDailyFeeType', config.bankDailyFeeType);
  setInput('bankDailyFeeAmount', config.bankDailyFeeAmount);

  setCheckbox('inactivityTaxEnabled', config.inactivityTaxEnabled);
  setInput('inactivityThresholdDays', config.inactivityThresholdDays);
  setInput('inactivityTaxPercentage', config.inactivityTaxPercentage);

  setCheckbox('fixedSupplyEnabled', config.fixedSupplyEnabled);
  setInput('maxMoneySupply', config.maxMoneySupply);

  // Show current supply info if available
  const sym = config.currencySymbol || '$';
  const supplyDisplay = document.getElementById('currentSupplyDisplay');
  const utilizationDisplay = document.getElementById('supplyUtilizationDisplay');
  if (supplyDisplay) {
    supplyDisplay.textContent = config.currentMoneySupply != null
      ? sym + formatNumber(config.currentMoneySupply) : '-';
  }
  if (utilizationDisplay) {
    if (config.fixedSupplyEnabled && config.maxMoneySupply && config.currentMoneySupply != null) {
      const pct = ((config.currentMoneySupply / config.maxMoneySupply) * 100).toFixed(1);
      utilizationDisplay.textContent = pct + '%';
    } else {
      utilizationDisplay.textContent = '-';
    }
  }

  // Apply conditional visibility
  handleEconomyToggle();
  handleMonetarySystemChange();
  toggleSection('deathPenaltySettings', 'deathPenaltyEnabled');
  toggleSection('transferSettings', 'transferEnabled');
  toggleSection('bankSettings', 'bankEnabled');
  toggleSection('bankDailyFeeSettings', 'bankDailyFeeEnabled');
  toggleSection('inactivityTaxSettings', 'inactivityTaxEnabled');
  toggleSection('fixedSupplySettings', 'fixedSupplyEnabled');
}

// ── Collect form data ──────────────────────────────────────────────────────
function getFormData() {
  return {
    enabled: getCheckbox('economyEnabled'),
    currencyName: getInput('currencyName'),
    currencySymbol: getInput('currencySymbol'),
    startingCash: getNumber('startingCash'),
    startingBank: getNumber('startingBank'),
    monetarySystem: getSelect('monetarySystem'),
    totalMoneySupply: getNullableNumber('totalMoneySupply'),
    killRewardsEnabled: getCheckbox('killRewardsEnabled'),
    killReward: getNumber('killReward'),
    playtimeRewardsEnabled: getCheckbox('playtimeRewardsEnabled'),
    playtimeRewardPerHour: getNumber('playtimeRewardPerHour'),
    achievementRewardsEnabled: getCheckbox('achievementRewardsEnabled'),
    achievementBonusMultiplier: getNumber('achievementBonusMultiplier'),
    territoryRewardsEnabled: getCheckbox('territoryRewardsEnabled'),
    territoryRewardPerHour: getNumber('territoryRewardPerHour'),
    deathPenaltyEnabled: getCheckbox('deathPenaltyEnabled'),
    deathPenaltyType: getSelect('deathPenaltyType'),
    deathPenaltyAmount: getNumber('deathPenaltyAmount'),
    deathPenaltyMaxLoss: getNullableNumber('deathPenaltyMaxLoss'),
    deathDropsMoneyOnGround: getCheckbox('deathDropsMoneyOnGround'),
    transferEnabled: getCheckbox('transferEnabled'),
    transferFeePercentage: getNumber('transferFeePercentage'),
    transferRequireBothOnline: getCheckbox('transferRequireBothOnline'),
    transferOfflineFeePercentage: getNumber('transferOfflineFeePercentage'),
    transferMinAmount: getNumber('transferMinAmount'),
    transferMaxAmount: getNullableNumber('transferMaxAmount'),
    bankEnabled: getCheckbox('bankEnabled'),
    maxBankBalance: getNullableNumber('maxBankBalance'),
    bankDepositFeePercentage: getNumber('bankDepositFeePercentage'),
    bankWithdrawFeePercentage: getNumber('bankWithdrawFeePercentage'),
    bankDailyFeeEnabled: getCheckbox('bankDailyFeeEnabled'),
    bankDailyFeeType: getSelect('bankDailyFeeType'),
    bankDailyFeeAmount: getNumber('bankDailyFeeAmount'),
    inactivityTaxEnabled: getCheckbox('inactivityTaxEnabled'),
    inactivityThresholdDays: getNumber('inactivityThresholdDays'),
    inactivityTaxPercentage: getNumber('inactivityTaxPercentage'),
    fixedSupplyEnabled: getCheckbox('fixedSupplyEnabled'),
    maxMoneySupply: getNullableNumber('maxMoneySupply'),
    requireTargetOnline: getCheckbox('bountyRequireTargetOnline'),
    factionKillsRequired: getNumber('bountyFactionKillsRequired')
  };
}

// ── Save configuration ─────────────────────────────────────────────────────
async function saveConfiguration() {
  if (!currentServerId || loadedServerId !== currentServerId) return;

  const serverId = currentServerId;
  const generation = configurationGeneration;
  let reloadSucceeded = true;

  const saveBtn = document.getElementById('saveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = '⏳ Saving...';
  hideAlerts();

  try {
    const config = getFormData();
    const res = await fetchWithCsrf(`/api/economy/admin/${serverId}/config`, {
      method: 'POST',
      body: JSON.stringify({
        expectedVersion: economySettingsVersion,
        economy: {
          enabled: config.enabled,
          currency_name: config.currencyName,
          currency_symbol: config.currencySymbol,
          starting_cash: config.startingCash,
          starting_bank: config.startingBank,
          monetary_system: config.monetarySystem,
          total_money_supply: config.totalMoneySupply,
          kill_rewards_enabled: config.killRewardsEnabled,
          kill_reward: config.killReward,
          playtime_rewards_enabled: config.playtimeRewardsEnabled,
          playtime_reward_per_hour: config.playtimeRewardPerHour,
          achievement_rewards_enabled: config.achievementRewardsEnabled,
          achievement_bonus_multiplier: config.achievementBonusMultiplier,
          death_penalty_enabled: config.deathPenaltyEnabled,
          death_penalty_type: config.deathPenaltyType,
          death_penalty_amount: config.deathPenaltyAmount,
          death_penalty_max_loss: config.deathPenaltyMaxLoss,
          death_drops_money_on_ground: config.deathDropsMoneyOnGround,
          transfer_enabled: config.transferEnabled,
          transfer_fee_percentage: config.transferFeePercentage,
          transfer_require_both_online: config.transferRequireBothOnline,
          transfer_offline_fee_percentage: config.transferOfflineFeePercentage,
          transfer_min_amount: config.transferMinAmount,
          transfer_max_amount: config.transferMaxAmount,
          bank_enabled: config.bankEnabled,
          max_bank_balance: config.maxBankBalance,
          bank_deposit_fee_percentage: config.bankDepositFeePercentage,
          bank_withdraw_fee_percentage: config.bankWithdrawFeePercentage,
          bank_daily_fee_enabled: config.bankDailyFeeEnabled,
          bank_daily_fee_type: config.bankDailyFeeType,
          bank_daily_fee_amount: config.bankDailyFeeAmount,
          inactivity_tax_enabled: config.inactivityTaxEnabled,
          inactivity_threshold_days: config.inactivityThresholdDays,
          inactivity_tax_percentage: config.inactivityTaxPercentage,
          fixed_supply_enabled: config.fixedSupplyEnabled,
          max_money_supply: config.maxMoneySupply
        },
        bountySettings: {
          requireTargetOnline: config.requireTargetOnline,
          factionKillsRequired: config.factionKillsRequired,
          expectedVersion: bountySettingsVersion
        }
      })
    });

    const data = await res.json();

    if (!res.ok) {
      if (res.status === 409 && generation === configurationGeneration && serverId === currentServerId) {
        loadedServerId = null;
        economySettingsVersion = null;
        bountySettingsVersion = null;
        reloadSucceeded = await loadConfiguration(serverId, generation) === true;
      }
      throw new Error(data.error || 'Save failed');
    }

    if (generation !== configurationGeneration || serverId !== currentServerId) return;
    bountySettingsVersion = Number(data.bountySettings?.version);
    economySettingsVersion = Number(data.version);
    if (!Number.isSafeInteger(bountySettingsVersion) || bountySettingsVersion <= 0) {
      throw new Error('Invalid bounty safety settings version');
    }
    showAlert('success', '✅ Configuration saved successfully!');

    // Refresh stats if economy is enabled
    if (config.enabled) {
      await loadStats(serverId);
    } else {
      document.getElementById('statsSection').classList.add('hidden');
    }
  } catch (err) {
    if (generation === configurationGeneration && serverId === currentServerId) {
      showAlert('error', '❌ Error: ' + err.message);
    }
  } finally {
    if (generation === configurationGeneration && serverId === currentServerId) {
      saveBtn.disabled = !reloadSucceeded;
      saveBtn.textContent = '💾 Save Configuration';
    }
  }
}

// ── Reset form to defaults ─────────────────────────────────────────────────
function resetToDefaults() {
  if (!confirm('Reset all settings to defaults? Unsaved changes will be lost.')) return;
  hideAlerts();
  populateForm(getDefaultConfig());
}

// ── Toggle handlers ────────────────────────────────────────────────────────
function handleEconomyToggle() {
  const enabled = document.getElementById('economyEnabled').checked;
  document.getElementById('mainSettings').classList.toggle('section-disabled', !enabled);
  if (!enabled) {
    document.getElementById('statsSection').classList.add('hidden');
  }
}

function handleMonetarySystemChange() {
  const system = document.getElementById('monetarySystem').value;
  const row = document.getElementById('totalSupplyRow');
  row.classList.toggle('hidden', system !== 'fixed');
}

function toggleSection(sectionId, checkboxId) {
  const enabled = document.getElementById(checkboxId).checked;
  document.getElementById(sectionId).classList.toggle('section-disabled', !enabled);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function setInput(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = (value === null || value === undefined) ? '' : value;
}

function setCheckbox(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.checked = !!value;
}

function setSelect(id, value) {
  const el = document.getElementById(id);
  if (!el || value === null || value === undefined) return;
  el.value = value;
}

function getInput(id) {
  return document.getElementById(id)?.value.trim() || '';
}

function getCheckbox(id) {
  return document.getElementById(id)?.checked || false;
}

function getSelect(id) {
  return document.getElementById(id)?.value || '';
}

function getNumber(id) {
  const val = parseFloat(document.getElementById(id)?.value);
  return isNaN(val) ? 0 : val;
}

function getNullableNumber(id) {
  const raw = document.getElementById(id)?.value.trim();
  if (!raw) return null;
  const val = parseFloat(raw);
  return isNaN(val) ? null : val;
}

function formatNumber(n) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function showAlert(type, message) {
  hideAlerts();
  const el = document.getElementById(type === 'success' ? 'alertSuccess' : 'alertError');
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function hideAlerts() {
  ['alertSuccess', 'alertError'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

// ── Event Listeners ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadGuilds();

  document.getElementById('guildSelect').addEventListener('change', async (e) => {
    currentServerId = e.target.value || null;
    loadedServerId = null;
    bountySettingsVersion = null;
    const generation = ++configurationGeneration;
    ++statsRequestGeneration;
    document.getElementById('statsSection').setAttribute('aria-busy', 'false');
    document.getElementById('saveBtn').disabled = true;
    document.getElementById('saveBtn').textContent = '💾 Save Configuration';
    hideAlerts();
    if (currentServerId) {
      await loadConfiguration(currentServerId, generation);
    } else {
      document.getElementById('settingsContainer').classList.add('hidden');
      document.getElementById('noGuildState').classList.remove('hidden');
    }
  });

  document.getElementById('economyEnabled').addEventListener('change', handleEconomyToggle);
  document.getElementById('monetarySystem').addEventListener('change', handleMonetarySystemChange);

  document.getElementById('deathPenaltyEnabled').addEventListener('change', () =>
    toggleSection('deathPenaltySettings', 'deathPenaltyEnabled'));
  document.getElementById('transferEnabled').addEventListener('change', () =>
    toggleSection('transferSettings', 'transferEnabled'));
  document.getElementById('bankEnabled').addEventListener('change', () =>
    toggleSection('bankSettings', 'bankEnabled'));
  document.getElementById('bankDailyFeeEnabled').addEventListener('change', () =>
    toggleSection('bankDailyFeeSettings', 'bankDailyFeeEnabled'));
  document.getElementById('inactivityTaxEnabled').addEventListener('change', () =>
    toggleSection('inactivityTaxSettings', 'inactivityTaxEnabled'));

  document.getElementById('fixedSupplyEnabled').addEventListener('change', () =>
    toggleSection('fixedSupplySettings', 'fixedSupplyEnabled'));

  document.getElementById('recalculateSupplyBtn')?.addEventListener('click', async () => {
    if (!currentServerId) return;
    const btn = document.getElementById('recalculateSupplyBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Recalculating...';
    try {
      const res = await fetchWithCsrf(`/api/economy/admin/${currentServerId}/recalculate-supply`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        const sym = document.getElementById('currencySymbol').value || '$';
        const supplyDisplay = document.getElementById('currentSupplyDisplay');
        if (supplyDisplay) supplyDisplay.textContent = sym + formatNumber(data.currentMoneySupply);
        const maxSupply = getNullableNumber('maxMoneySupply');
        const utilizationDisplay = document.getElementById('supplyUtilizationDisplay');
        if (utilizationDisplay && maxSupply) {
          const pct = ((data.currentMoneySupply / maxSupply) * 100).toFixed(1);
          utilizationDisplay.textContent = pct + '%';
        }
        btn.textContent = '✅ Recalculated';
      } else {
        btn.textContent = '❌ Failed';
      }
    } catch (e) {
      btn.textContent = '❌ Error';
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = '🔄 Recalculate'; }, 2000);
    }
  });

  document.getElementById('saveBtn').addEventListener('click', saveConfiguration);
  document.getElementById('resetBtn').addEventListener('click', resetToDefaults);
});

// Detect if loaded in iframe and hide redundant navigation
document.addEventListener('DOMContentLoaded', () => {
  if (window.self !== window.top) {
    const header = document.querySelector('.flex.justify-between.items-center.mb-6');
    const nav = document.querySelector('nav.bg-gray-800');
    if (header) header.style.display = 'none';
    if (nav) nav.style.display = 'none';
  }
});
