let activityLogs = [];

// Load automation settings on page load
loadAutomationSettings();
loadServers();

function addActivityLog(message, type = 'info') {
  const timestamp = new Date().toLocaleString();
  const colors = {
    info: 'text-blue-400',
    success: 'text-green-400',
    error: 'text-red-400',
    warning: 'text-yellow-400'
  };

  activityLogs.unshift({
    message,
    timestamp,
    type
  });

  // Keep only last 50 logs
  if (activityLogs.length > 50) {
    activityLogs = activityLogs.slice(0, 50);
  }

  const logHtml = activityLogs.map(log => `
    <div class="text-sm mb-2 pb-2 border-b border-gray-600">
      <span class="text-gray-500">[${log.timestamp}]</span>
      <span class="${colors[log.type]}">${log.message}</span>
    </div>
  `).join('');

  document.getElementById('activityLog').innerHTML = logHtml;
}

async function loadAutomationSettings() {
  try {
    const response = await fetch('/api/automation/settings');
    const data = await response.json();

    if (data.autoLogSync) {
      document.getElementById('autoLogSyncToggle').checked = data.autoLogSync.enabled;
      document.getElementById('syncInterval').value = data.autoLogSync.interval || 15;
      document.getElementById('autoScanAfterSync').checked = data.autoLogSync.autoScan !== false;

      if (data.autoLogSync.enabled) {
        document.getElementById('autoLogSyncSettings').style.display = 'block';
      }

      if (data.autoLogSync.lastRun) {
        document.getElementById('lastSync').textContent = new Date(data.autoLogSync.lastRun).toLocaleString();
      }
    }

    if (data.autoTracking) {
      document.getElementById('autoTrackingToggle').checked = data.autoTracking.enabled;
      document.getElementById('trackingInterval').value = data.autoTracking.interval || 60;

      if (data.autoTracking.enabled) {
        document.getElementById('autoTrackingSettings').style.display = 'block';
      }

      if (data.autoTracking.lastRun) {
        document.getElementById('lastTracking').textContent = new Date(data.autoTracking.lastRun).toLocaleString();
      }
    }

  } catch (err) {
    console.error('Failed to load automation settings:', err);
  }
}

async function loadServers() {
  try {
    console.log('🔍 [AUTOMATION] Loading servers...');

    // Step 1: Get user's guilds
    const guildsResponse = await fetch('/api/user/guilds');
    console.log('📡 [AUTOMATION] Guilds response status:', guildsResponse.status);

    const guildsData = await guildsResponse.json();
    console.log('📦 [AUTOMATION] Guilds data:', guildsData);

    if (!guildsData.success || !guildsData.guilds || guildsData.guilds.length === 0) {
      console.warn('⚠️ [AUTOMATION] No guilds available');
      document.getElementById('serverCheckboxes').innerHTML = '<p class="text-gray-400">No guilds available</p>';
      return;
    }

    // Step 2: Get servers for each guild
    const allServers = [];

    for (const guild of guildsData.guilds) {
      console.log('🔍 [AUTOMATION] Fetching servers for guild:', guild.name, guild.id);

      const serversResponse = await fetch(`/api/guilds/${guild.id}/servers`);
      console.log('📡 [AUTOMATION] Servers response status:', serversResponse.status);

      const serversData = await serversResponse.json();
      console.log('📦 [AUTOMATION] Servers data for', guild.name, ':', serversData);

      if (serversData.success && serversData.servers) {
        // Add guild context to each server
        serversData.servers.forEach(server => {
          server.guildId = guild.id;
          server.guildName = guild.name;
        });
        allServers.push(...serversData.servers);
      }
    }

    console.log('✅ [AUTOMATION] Total servers loaded:', allServers.length);

    // Create a response-like object for compatibility
    const data = { servers: allServers, success: true };

    if (data.servers && data.servers.length > 0) {
      const settingsResponse = await fetch('/api/automation/settings');
      const settings = await settingsResponse.json();
      const monitoredServers = settings.autoLogSync?.servers || [];

      const container = document.getElementById('serverCheckboxes');
      container.textContent = '';
      data.servers.forEach(server => {
        const label = document.createElement('label');
        label.className = 'flex items-center gap-2 p-2 hover:bg-gray-600 rounded cursor-pointer';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'w-4 h-4 server-checkbox';
        checkbox.value = server.nitrado_server_id;
        checkbox.checked = monitoredServers.includes(server.nitrado_server_id);

        const name = document.createElement('span');
        name.textContent = `${server.server_name} (${server.nitrado_server_id})`;
        label.append(checkbox, name);
        container.appendChild(label);
      });
    }
  } catch (err) {
    console.error('Failed to load servers:', err);
    document.getElementById('serverCheckboxes').innerHTML = '<p class="text-red-400">Error loading servers</p>';
  }
}

async function toggleAutoLogSync() {
  const enabled = document.getElementById('autoLogSyncToggle').checked;
  document.getElementById('autoLogSyncSettings').style.display = enabled ? 'block' : 'none';

  if (enabled) {
    addActivityLog('Auto log sync enabled', 'success');
  } else {
    addActivityLog('Auto log sync disabled', 'warning');
  }

  await updateAutoLogSync();
}

async function toggleAutoTracking() {
  const enabled = document.getElementById('autoTrackingToggle').checked;
  document.getElementById('autoTrackingSettings').style.display = enabled ? 'block' : 'none';

  if (enabled) {
    addActivityLog('Auto player tracking enabled', 'success');
  } else {
    addActivityLog('Auto player tracking disabled', 'warning');
  }

  await updateAutoTracking();
}

async function updateAutoLogSync() {
  const enabled = document.getElementById('autoLogSyncToggle').checked;
  const interval = parseFloat(document.getElementById('syncInterval').value);
  const autoScan = document.getElementById('autoScanAfterSync').checked;

  const selectedServers = Array.from(document.querySelectorAll('.server-checkbox:checked'))
    .map(cb => cb.value);

  try {
    const response = await fetchWithCsrf('/api/automation/log-sync', {
      method: 'POST',
      body: JSON.stringify({
        enabled,
        interval,
        autoScan,
        servers: selectedServers
      })
    });

    const data = await response.json();
    if (data.success) {
      console.log('Auto log sync settings updated');
    }
  } catch (err) {
    console.error('Failed to update settings:', err);
    addActivityLog('Failed to update auto log sync settings', 'error');
  }
}

async function updateAutoTracking() {
  const enabled = document.getElementById('autoTrackingToggle').checked;
  const interval = parseFloat(document.getElementById('trackingInterval').value);

  try {
    const response = await fetchWithCsrf('/api/automation/player-tracking', {
      method: 'POST',
      body: JSON.stringify({
        enabled,
        interval
      })
    });

    const data = await response.json();
    if (data.success) {
      console.log('Auto tracking settings updated');
    }
  } catch (err) {
    console.error('Failed to update settings:', err);
    addActivityLog('Failed to update auto tracking settings', 'error');
  }
}

async function runSyncNow() {
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '⏳ Syncing...';
  document.getElementById('syncStatus').textContent = 'Running...';
  document.getElementById('syncStatus').className = 'text-sm text-blue-400';

  addActivityLog('Manual sync started', 'info');

  try {
    const response = await fetchWithCsrf('/api/automation/sync-now', {
      method: 'POST'
    });

    const data = await response.json();

    if (data.success) {
      addActivityLog(`Sync completed: ${data.filesDownloaded || 0} files downloaded`, 'success');
      addActivityLog('💡 Tip: Refresh the Players page to see updated stats', 'info');
      document.getElementById('syncStatus').textContent = 'Completed';
      document.getElementById('syncStatus').className = 'text-sm text-green-400';
      document.getElementById('lastSync').textContent = new Date().toLocaleString();
    } else {
      addActivityLog('Sync failed: ' + (data.error || 'Unknown error'), 'error');
      document.getElementById('syncStatus').textContent = 'Failed';
      document.getElementById('syncStatus').className = 'text-sm text-red-400';
    }
  } catch (err) {
    console.error(err);
    addActivityLog('Sync error: ' + err.message, 'error');
    document.getElementById('syncStatus').textContent = 'Error';
    document.getElementById('syncStatus').className = 'text-sm text-red-400';
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 Run Sync Now';
  }
}

/**
 * Force a full rescan of all locally-downloaded log files for each checked server.
 * Calls POST /api/log-parser/scan-all-logs which reads every ADM/RPT file on disk
 * and re-inserts events (UNIQUE constraints prevent duplication).
 * Use this after a container rebuild that truncated event tables.
 */
async function forceFullRescan() {
  const btn = document.getElementById('forceRescanBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Rescanning all logs...';

  addActivityLog('Force full rescan started — this may take a while', 'info');

  // Gather selected servers (same checkboxes used by sync-now)
  const selectedServers = Array.from(document.querySelectorAll('.server-checkbox:checked'));

  if (selectedServers.length === 0) {
    addActivityLog('No servers selected — please check at least one server', 'warning');
    btn.disabled = false;
    btn.textContent = '🔁 Force Full Rescan (All Logs)';
    return;
  }

  // Load guilds to map server id → guild id
  let guildMap = {};
  try {
    const guildsRes = await fetch('/api/user/guilds');
    const guildsData = await guildsRes.json();
    for (const guild of (guildsData.guilds || [])) {
      const serversRes = await fetch(`/api/guilds/${guild.id}/servers`);
      const serversData = await serversRes.json();
      for (const server of (serversData.servers || [])) {
        guildMap[server.nitrado_server_id] = guild.id;
      }
    }
  } catch (err) {
    addActivityLog('Failed to load guild/server mapping: ' + err.message, 'error');
  }

  let successCount = 0;
  let failCount = 0;

  for (const cb of selectedServers) {
    const serverId = cb.value;
    const guildId = guildMap[serverId];

    if (!guildId) {
      addActivityLog(`⚠️ No guild found for server ${serverId} — skipping`, 'warning');
      failCount++;
      continue;
    }

    try {
      addActivityLog(`Rescanning server ${serverId}...`, 'info');
      const response = await fetchWithCsrf('/api/scan-all-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId, guildId })
      });

      const data = await response.json();

      if (data.success) {
        addActivityLog(`✅ Server ${serverId}: ${data.message || 'Rescan complete'}`, 'success');
        successCount++;
      } else {
        addActivityLog(`❌ Server ${serverId}: ${data.error || 'Unknown error'}`, 'error');
        failCount++;
      }
    } catch (err) {
      addActivityLog(`❌ Server ${serverId}: ${err.message}`, 'error');
      failCount++;
    }
  }

  addActivityLog(`Full rescan done — ${successCount} succeeded, ${failCount} failed`, successCount > 0 ? 'success' : 'error');
  btn.disabled = false;
  btn.textContent = '🔁 Force Full Rescan (All Logs)';
}

// Event listeners
document.getElementById('autoLogSyncToggle').addEventListener('change', toggleAutoLogSync);
document.getElementById('syncInterval').addEventListener('change', updateAutoLogSync);
document.getElementById('autoScanAfterSync').addEventListener('change', updateAutoLogSync);
document.getElementById('runSyncNowBtn').addEventListener('click', runSyncNow);
document.getElementById('forceRescanBtn').addEventListener('click', forceFullRescan);
document.getElementById('autoTrackingToggle').addEventListener('change', toggleAutoTracking);
document.getElementById('trackingInterval').addEventListener('change', updateAutoTracking);

// Delegated event listener for dynamically created server checkboxes
document.getElementById('serverCheckboxes').addEventListener('change', function(e) {
  if (e.target.classList.contains('server-checkbox')) {
    updateAutoLogSync();
  }
});
