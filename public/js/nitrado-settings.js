/* global document, alert, confirm, fetchWithCsrf */

let currentSettings = null;
let originalSettings = null;
let changedSettings = {};
let currentNaming = null;
let settingsLoadGeneration = 0;

document.addEventListener('DOMContentLoaded', function() {
  // Event listeners
  document.getElementById('serverSelect').addEventListener('change', loadSettings);
  document.getElementById('resetBtn').addEventListener('click', resetChanges);
  document.getElementById('saveBtn').addEventListener('click', saveAllSettings);
  document.getElementById('saveDisplayNameBtn').addEventListener('click', saveDisplayName);
  document.getElementById('saveHostnameBtn').addEventListener('click', saveHostname);
  document.getElementById('invisibleHostname').addEventListener('change', syncHostnameMode);
  document.getElementById('saveLinkVerificationBtn')?.addEventListener('click', saveLinkVerification);
  document.getElementById('savePlayerMapSettingsBtn')?.addEventListener('click', savePlayerMapSettings);
  document.getElementById('linkVerificationMode')?.addEventListener('change', renderLinkVerificationHelp);

  // Event delegation for dynamically generated setting inputs
  document.addEventListener('change', function(event) {
    if (event.target.classList.contains('setting-input')) {
      const category = event.target.dataset.category;
      const key = event.target.dataset.key;
      const value = event.target.value;
      markChanged(category, key, value);
    }
  });

  // Load servers on page load
  loadServers();
});

async function loadServers() {
  try {
    console.log('🔍 [NITRADO-SETTINGS] Loading servers...');

    // Step 1: Get user's guilds
    const guildsResponse = await fetch('/api/user/guilds');
    console.log('📡 [NITRADO-SETTINGS] Guilds response status:', guildsResponse.status);

    const guildsData = await guildsResponse.json();
    console.log('📦 [NITRADO-SETTINGS] Guilds data:', guildsData);

    if (!guildsData.success || !guildsData.guilds || guildsData.guilds.length === 0) {
      console.warn('⚠️ [NITRADO-SETTINGS] No guilds available');
      alert('No guilds available. Contact an admin to approve your Discord server.');
      return;
    }

    // Step 2: Get servers for each guild
    const allServers = [];

    for (const guild of guildsData.guilds) {
      console.log('🔍 [NITRADO-SETTINGS] Fetching servers for guild:', guild.name, guild.id);

      const serversResponse = await fetch(`/api/guilds/${guild.id}/servers`);
      console.log('📡 [NITRADO-SETTINGS] Servers response status:', serversResponse.status);

      const serversData = await serversResponse.json();
      console.log('📦 [NITRADO-SETTINGS] Servers data for', guild.name, ':', serversData);

      if (serversData.success && serversData.servers) {
        serversData.servers.forEach(server => {
          server.guildId = guild.id;
          server.guildName = guild.name;
        });
        allServers.push(...serversData.servers);
      }
    }

    console.log('✅ [NITRADO-SETTINGS] Total servers loaded:', allServers.length);

    const data = { servers: allServers, success: true };

    if (data.success && data.servers) {
      const select = document.getElementById('serverSelect');
      data.servers.forEach(server => {
        const option = document.createElement('option');
        option.value = server.nitrado_server_id;
        option.dataset.guildId = server.guildId;
        option.dataset.internalServerId = server.id;
        option.textContent = `${server.displayName || server.server_name} (${server.nitrado_server_id})`;
        select.appendChild(option);
      });
    }
  } catch (err) {
    console.error('Failed to load servers:', err);
    alert('Failed to load servers');
  }
}

async function loadSettings() {
  const loadGeneration = ++settingsLoadGeneration;
  const select = document.getElementById('serverSelect');
  const serverId = select.value;
  currentSettings = null;
  originalSettings = null;
  changedSettings = {};
  currentNaming = null;
  document.getElementById('linkSettingsCard')?.classList.add('hidden');
  document.getElementById('playerMapSettingsCard')?.classList.add('hidden');

  if (!serverId) {
    document.getElementById('settingsContainer').classList.add('hidden');
    document.getElementById('noServerMessage').classList.remove('hidden');
    return;
  }

  const selectedOption = select.options[select.selectedIndex];
  const guildId = selectedOption.dataset.guildId;

  if (!guildId) {
    console.error('❌ [NITRADO-SETTINGS] Guild ID not found for server:', serverId);
    alert('Guild ID not found for this server. Please try reloading the page.');
    return;
  }

  console.log('🔍 [NITRADO-SETTINGS] Loading settings for server:', serverId, 'guild:', guildId);

  document.getElementById('loadingIndicator').classList.remove('hidden');
  document.getElementById('noServerMessage').classList.add('hidden');
  document.getElementById('settingsContainer').classList.add('hidden');

  try {
    const response = await fetch(`/api/nitrado/settings/${serverId}?guildId=${guildId}`);
    const data = await response.json();
    if (loadGeneration !== settingsLoadGeneration) return;

    if (data.success) {
      currentSettings = data.settings;
      originalSettings = JSON.parse(JSON.stringify(data.settings));
      changedSettings = {};

      renderSettings();
      await loadServerNaming(serverId, guildId, loadGeneration);
      if (loadGeneration !== settingsLoadGeneration) return;
      if (document.getElementById('linkSettingsCard')) {
        await loadLinkVerification(selectedOption.dataset.internalServerId, loadGeneration);
        if (loadGeneration !== settingsLoadGeneration) return;
      }
      if (document.getElementById('playerMapSettingsCard')) {
        await loadPlayerMapSettings(selectedOption.dataset.internalServerId, loadGeneration);
        if (loadGeneration !== settingsLoadGeneration) return;
      }

      document.getElementById('settingsContainer').classList.remove('hidden');
    } else {
      alert('Failed to load settings: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    if (loadGeneration !== settingsLoadGeneration) return;
    console.error('Error loading settings:', err);
    alert('Failed to load settings');
  } finally {
    if (loadGeneration === settingsLoadGeneration) {
      document.getElementById('loadingIndicator').classList.add('hidden');
    }
  }
}

function renderSettings() {
  renderCategory('general', 'generalSettings');
  renderCategory('config', 'configSettings');
  renderCategory('savegame', 'savegameSettings');
}

function renderCategory(category, containerId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  const settings = currentSettings[category] || {};

  if (Object.keys(settings).length === 0) {
    container.innerHTML = '<p class="text-gray-500">No settings available in this category</p>';
    return;
  }

  Object.entries(settings).forEach(([key, value]) => {
    const settingDiv = document.createElement('div');
    settingDiv.className = 'bg-gray-700 p-4 rounded-lg';

    const isBoolean = value === 'true' || value === 'false' || value === '0' || value === '1';
    const isMultiline = typeof value === 'string' && (value.includes('\r\n') || value.includes('\n') || value.length > 100);

    const label = document.createElement('label');
    label.className = 'block mb-2 font-semibold text-gray-300';
    label.textContent = key;
    let input;
    if (isBoolean) {
      input = document.createElement('select');
      for (const [optionValue, text] of [['true', 'Enabled (true)'], ['false', 'Disabled (false)']]) {
        const option = document.createElement('option');
        option.value = optionValue;
        option.textContent = text;
        input.appendChild(option);
      }
      input.value = value === 'true' || value === '1' ? 'true' : 'false';
    } else if (isMultiline) {
      input = document.createElement('textarea');
      input.rows = 5;
      input.className = 'bg-gray-600 p-2 rounded w-full font-mono text-sm setting-input';
      input.value = String(value);
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.value = String(value);
    }
    input.classList.add('bg-gray-600', 'p-2', 'rounded', 'w-full', 'setting-input');
    input.dataset.category = category;
    input.dataset.key = key;
    const original = document.createElement('span');
    original.className = 'text-xs text-gray-500 mt-1 block';
    original.textContent = `Original: ${String(value)}`;
    settingDiv.append(label, input, original);
    container.appendChild(settingDiv);
  });
}

function markChanged(category, key, newValue) {
  if (!changedSettings[category]) {
    changedSettings[category] = {};
  }

  const originalValue = originalSettings[category]?.[key];

  if (newValue !== originalValue) {
    changedSettings[category][key] = newValue;
  } else {
    delete changedSettings[category][key];
    if (Object.keys(changedSettings[category]).length === 0) {
      delete changedSettings[category];
    }
  }

  console.log('Changed settings:', changedSettings);
}

function resetChanges() {
  if (confirm('Reset all changes and reload original settings?')) {
    changedSettings = {};
    currentSettings = JSON.parse(JSON.stringify(originalSettings));
    renderSettings();
  }
}

async function saveAllSettings() {
  const select = document.getElementById('serverSelect');
  const serverId = select.value;

  if (Object.keys(changedSettings).length === 0) {
    alert('No changes to save');
    return;
  }

  const selectedOption = select.options[select.selectedIndex];
  const guildId = selectedOption.dataset.guildId;

  if (!guildId) {
    console.error('❌ [NITRADO-SETTINGS] Guild ID not found for server:', serverId);
    alert('Guild ID not found for this server. Please try reloading the page.');
    return;
  }

  console.log('💾 [NITRADO-SETTINGS] Saving settings for server:', serverId, 'guild:', guildId);

  if (!confirm(`Save ${countChanges()} setting(s)?`)) {
    return;
  }

  const saveBtn = document.getElementById('saveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = '⏳ Saving...';

  try {
    const response = await fetchWithCsrf(`/api/nitrado/settings/${serverId}`, {
      method: 'POST',
      body: JSON.stringify({ settings: changedSettings, guildId })
    });

    const data = await response.json();

    if (data.success) {
      alert(`✅ Successfully saved ${data.updated} setting(s)!`);
      changedSettings = {};
      await loadSettings(); // Reload to get current state
    } else {
      alert('❌ Failed to save settings: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('Error saving settings:', err);
    alert('❌ Failed to save settings');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '💾 Save All Changes';
  }
}

function selectedServerContext() {
  const select = document.getElementById('serverSelect');
  const option = select.options[select.selectedIndex];
  return {
    select,
    option,
    serviceId: select.value,
    guildId: option?.dataset.guildId,
  };
}

async function loadServerNaming(serviceId, guildId, loadGeneration) {
  const response = await fetch(
    `/api/nitrado/account-servers/${encodeURIComponent(serviceId)}/naming?guildId=${encodeURIComponent(guildId)}`
  );
  const data = await response.json();
  if (loadGeneration !== settingsLoadGeneration) return;
  if (!response.ok || !data.success) throw new Error(data.error || 'Failed to load server naming settings');
  currentNaming = data.naming;
  const displayInput = document.getElementById('serverDisplayName');
  displayInput.value = currentNaming.customName || '';
  displayInput.placeholder = currentNaming.displayName;
  const invisible = document.getElementById('invisibleHostname');
  invisible.checked = currentNaming.mode === 'invisible';
  document.getElementById('hostnameControls').classList.toggle(
    'hidden',
    !currentNaming.supportsInvisibleHostname
  );
  document.getElementById('nitradoHostname').value = currentNaming.hostname || '';
  const status = document.getElementById('hostnameStatus');
  status.textContent = currentNaming.mode === 'unsupported'
    ? 'The provider currently uses an unsupported hostname. Enter a safe visible name or select invisible mode.'
    : currentNaming.mode === 'invisible'
      ? 'The actual Nitrado hostname is currently invisible.'
      : 'The actual Nitrado hostname is currently visible.';
  syncHostnameMode();
}

function syncHostnameMode() {
  const invisible = document.getElementById('invisibleHostname').checked;
  const hostname = document.getElementById('nitradoHostname');
  hostname.disabled = invisible;
  hostname.classList.toggle('opacity-50', invisible);
}

async function saveDisplayName() {
  const { option, serviceId, guildId } = selectedServerContext();
  if (!serviceId || !guildId) return alert('Select a server first.');
  const button = document.getElementById('saveDisplayNameBtn');
  button.disabled = true;
  try {
    const response = await fetchWithCsrf(
      `/api/nitrado/account-servers/${encodeURIComponent(serviceId)}/display-name`,
      {
        method: 'PUT',
        body: JSON.stringify({
          guildId,
          displayName: document.getElementById('serverDisplayName').value,
        }),
      }
    );
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Failed to save display name');
    currentNaming = { ...currentNaming, ...data.naming };
    document.getElementById('serverDisplayName').value = currentNaming.customName || '';
    document.getElementById('serverDisplayName').placeholder = currentNaming.displayName;
    option.textContent = `${currentNaming.displayName} (${serviceId})`;
    alert('✅ Dashboard, shop, and Discord bot display name updated.');
  } catch (error) {
    console.error('Failed to save display name:', error);
    alert(`❌ ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function saveHostname() {
  const { serviceId, guildId } = selectedServerContext();
  if (!serviceId || !guildId) return alert('Select a server first.');
  const invisible = document.getElementById('invisibleHostname').checked;
  const mode = invisible ? 'invisible' : 'visible';
  const message = invisible
    ? 'Use blank server name?'
    : 'Change the actual Nitrado hostname to the visible name entered above?';
  if (!confirm(message)) return;

  const button = document.getElementById('saveHostnameBtn');
  button.disabled = true;
  try {
    const response = await fetchWithCsrf(
      `/api/nitrado/account-servers/${encodeURIComponent(serviceId)}/hostname`,
      {
        method: 'PUT',
        body: JSON.stringify({
          guildId,
          mode,
          hostname: document.getElementById('nitradoHostname').value,
        }),
      }
    );
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Failed to save Nitrado hostname');
    currentNaming = { ...currentNaming, ...data.naming };
    document.getElementById('hostnameStatus').textContent = data.naming.mode === 'invisible'
      ? 'The actual Nitrado hostname is now invisible.'
      : 'The actual Nitrado hostname was updated and verified.';
    alert('✅ Nitrado hostname updated and verified.');
  } catch (error) {
    console.error('Failed to save Nitrado hostname:', error);
    alert(`❌ ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

const linkVerificationHelp = {
  admin_approval: 'Only a moderator or administrator can create a new link using /link-admin force-link.',
  emote: 'Players must complete the in-game emote challenge before the link is activated.',
  open: 'Players may claim an unowned identity directly. The database still permits only one Discord owner per game identity.',
};

function renderLinkVerificationHelp() {
  const modeSelect = document.getElementById('linkVerificationMode');
  const help = document.getElementById('linkVerificationHelp');
  if (!modeSelect || !help) return;
  help.textContent = linkVerificationHelp[modeSelect.value] || '';
}

async function loadLinkVerification(internalServerId, loadGeneration) {
  if (!internalServerId) throw new Error('Internal server ID is missing');
  const response = await fetch(`/api/link-settings/${internalServerId}`);
  if (loadGeneration !== settingsLoadGeneration) return;
  const card = document.getElementById('linkSettingsCard');
  if (response.status === 403) {
    card.classList.add('hidden');
    return;
  }
  const data = await response.json();
  if (loadGeneration !== settingsLoadGeneration) return;
  if (!response.ok || !data.success) throw new Error(data.error || 'Failed to load link settings');
  document.getElementById('linkVerificationMode').value = data.settings.verificationMode;
  card.classList.remove('hidden');
  renderLinkVerificationHelp();
}

async function saveLinkVerification() {
  const select = document.getElementById('serverSelect');
  const internalServerId = select.options[select.selectedIndex]?.dataset.internalServerId;
  if (!internalServerId) return alert('Select a server first.');
  const verificationMode = document.getElementById('linkVerificationMode').value;
  if (!confirm('Change the gamertag-link verification level for this server?')) return;
  const button = document.getElementById('saveLinkVerificationBtn');
  button.disabled = true;
  try {
    const response = await fetchWithCsrf(`/api/link-settings/${internalServerId}`, {
      method: 'PUT',
      body: JSON.stringify({ verificationMode }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Failed to save link verification');
    alert('✅ Gamertag-link verification updated.');
  } catch (error) {
    console.error('Failed to save link verification:', error);
    alert(`❌ ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

async function loadPlayerMapSettings(internalServerId, loadGeneration) {
  if (!internalServerId) throw new Error('Internal server ID is missing');
  const card = document.getElementById('playerMapSettingsCard');
  card.classList.add('hidden');
  const response = await fetch(`/api/player-map-settings/${internalServerId}`);
  if (loadGeneration !== settingsLoadGeneration) return;
  if (response.status === 403) return;
  const data = await response.json();
  if (loadGeneration !== settingsLoadGeneration) return;
  if (!response.ok || !data.success) throw new Error(data.error || 'Failed to load player-map settings');
  const enabled = new Set(data.settings.enabledFeatures || []);
  document.querySelectorAll('#playerMapFeatureOptions input[type="checkbox"]').forEach(input => {
    input.checked = enabled.has(input.value);
  });
  card.classList.remove('hidden');
}

async function savePlayerMapSettings() {
  const select = document.getElementById('serverSelect');
  const internalServerId = select.options[select.selectedIndex]?.dataset.internalServerId;
  if (!internalServerId) return alert('Select a server first.');
  const enabledFeatures = [...document.querySelectorAll(
    '#playerMapFeatureOptions input[type="checkbox"]:checked'
  )].map(input => input.value);
  const button = document.getElementById('savePlayerMapSettingsBtn');
  button.disabled = true;
  try {
    const response = await fetchWithCsrf(`/api/player-map-settings/${internalServerId}`, {
      method: 'PUT',
      body: JSON.stringify({ enabledFeatures }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Failed to save player-map settings');
    alert('✅ Player-map features updated.');
  } catch (error) {
    console.error('Failed to save player-map settings:', error);
    alert(`❌ ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function countChanges() {
  let count = 0;
  Object.values(changedSettings).forEach(category => {
    count += Object.keys(category).length;
  });
  return count;
}
