/* global document, fetchWithCsrf, alert, event */

// ===== GLOBAL STATE - MUST BE AT TOP =====
let currentPage = 1;
let totalPages = 1;
let currentLimit = 100;
let currentSortBy = 'lastSeenAt';
let currentSortOrder = 'DESC';
let serversLoaded = false;
let currentGuildId = null; // Store current guild ID

console.log('🌐 [LOGS-PAGE] Page loaded');
console.log('   Initial state:', { currentPage, totalPages, currentLimit, currentSortBy, currentSortOrder, serversLoaded });

// ===== PAGE INITIALIZATION =====
// Now safe to call - variables exist
loadPlayers();

// Called by the page's inline upload control.
// eslint-disable-next-line no-unused-vars
async function uploadLogs() {
  const serverIdInput = document.getElementById('serverId');
  const admFileInput = document.getElementById('admFile');
  const rptFileInput = document.getElementById('rptFile');
  const statusEl = document.getElementById('uploadStatus');

  const serverId = serverIdInput.value.trim();

  if (!serverId) {
    statusEl.innerHTML = '<span class="text-red-400">❌ Please enter a server ID</span>';
    return;
  }

  if (!admFileInput.files[0] && !rptFileInput.files[0]) {
    statusEl.innerHTML = '<span class="text-red-400">❌ Please select at least one log file</span>';
    return;
  }

  statusEl.innerHTML = '<span class="text-blue-400 pulse">⏳ Parsing logs...</span>';

  try {
    const admLog = admFileInput.files[0] ? await admFileInput.files[0].text() : null;
    const rptLog = rptFileInput.files[0] ? await rptFileInput.files[0].text() : null;

    const response = await fetchWithCsrf('/api/parse-logs', {
      method: 'POST',
      body: JSON.stringify({ serverId, admLog, rptLog })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }

    const data = await response.json();

    if (data.success) {
      statusEl.innerHTML = `<span class="text-green-400">✅ Successfully tracked ${escapeHtml(String(data.totalPlayers))} players!</span>`;

      // Show details of tracked players
      if (data.players.length > 0) {
        let details = '<div class="mt-3 text-sm bg-gray-700 p-3 rounded"><strong>Tracked:</strong><ul class="list-disc list-inside mt-2">';
        data.players.slice(0, 5).forEach(p => {
          const userId = p.platformUserId || p.bohemiaId || 'Unknown';
          details += `<li>${escapeHtml(p.playerName || 'Unknown')} (${escapeHtml(userId.substring(0, 16))}...)</li>`;
        });
        if (data.players.length > 5) {
          details += `<li class="text-gray-400">... and ${data.players.length - 5} more</li>`;
        }
        details += '</ul></div>';
        statusEl.innerHTML += details;
      }

      loadPlayers();
    } else {
      statusEl.innerHTML = `<span class="text-red-400">❌ ${escapeHtml(data.error || 'Log parsing failed')}</span>`;
    }
  } catch (err) {
    console.error(err);
    statusEl.innerHTML = `<span class="text-red-400">❌ Error: ${escapeHtml(err.message)}</span>`;
  }
}

async function detectAlts() {
  console.log('🔘 [DETECT-ALTS] Button clicked');

  const container = document.getElementById('altsContainer');
  container.innerHTML = '<p class="text-gray-400 pulse">⏳ Scanning for alts...</p>';

  try {
    const serverId = document.getElementById('serverSelect').value;
    if (!serverId) throw new Error('Select a server before detecting alternate accounts');
    const url = `/api/detect-alts?serverId=${encodeURIComponent(serverId)}`;
    console.log('📡 [DETECT-ALTS] Fetching', url);

    const response = await fetch(url);
    console.log('📡 [DETECT-ALTS] Response status:', response.status);

    const data = await response.json();
    console.log('📦 [DETECT-ALTS] Response data:', data);

    if (data.success && data.alts.length > 0) {
      console.log('✅ [DETECT-ALTS] Found', data.alts.length, 'potential alt group(s)');

      let html = '<div class="space-y-4">';

      data.alts.forEach((alt, index) => {
        console.log(`   Group ${index + 1}:`, alt);
        const lastSeen = new Date(alt.lastSeen).toLocaleString();

        html += `
          <div class="bg-red-900/30 border-2 border-red-700 p-4 rounded-lg">
            <div class="flex justify-between items-start mb-3">
              <div>
                <span class="text-red-400 font-bold text-lg">⚠️ ${escapeHtml(String(alt.accountCount))} Accounts on Same Device</span>
                <div class="text-xs text-gray-400 mt-1 font-mono">Device: ${escapeHtml(String(alt.deviceId || '').substring(0, 24))}...</div>
              </div>
              <span class="text-xs text-gray-400 bg-gray-800 px-2 py-1 rounded">${lastSeen}</span>
            </div>
            <div class="mt-3">
              <strong class="text-sm text-gray-300">Accounts:</strong>
              <div class="mt-2 grid gap-2">
        `;

        alt.accounts.forEach((name, idx) => {
          const userIds = alt.platformUserIds || alt.bohemiaIds || [];
          const userId = userIds[idx] || 'Unknown';
          html += `
            <div class="bg-gray-800 p-3 rounded flex justify-between items-center">
              <span class="font-semibold text-white">${escapeHtml(name)}</span>
              <span class="text-gray-400 font-mono text-xs">${escapeHtml(userId.substring(0, 16))}...</span>
            </div>
          `;
        });

        html += `
              </div>
            </div>
          </div>
        `;
      });

      html += '</div>';
      container.innerHTML = html;
    } else {
      console.log('ℹ️ [DETECT-ALTS] No alts detected');
      container.innerHTML = '<p class="text-green-400">✅ No alt accounts detected - all players use unique devices</p>';
    }
  } catch (err) {
    console.error('❌ [DETECT-ALTS] Error detecting alts:', err);
    console.error('   Message:', err.message);
    console.error('   Stack:', err.stack);
    container.innerHTML = `<span class="text-red-400">❌ Error: ${escapeHtml(err.message)}</span>`;
  }
}

// Load tracked players with pagination
async function loadPlayers(page = 1) {
  console.log(`🔍 [LOGS-PAGE] Loading players - Page ${page}`);
  console.log('   Current state:', { currentPage, currentLimit, currentSortBy, currentSortOrder });

  currentPage = page;
  const container = document.getElementById('playersContainer');
  const serverId = document.getElementById('serverSelect').value;

  if (!serverId) {
    console.warn('⚠️ [LOGS-PAGE] No server selected, skipping player load');
    container.innerHTML = '<p class="text-gray-400">Select a server and scan logs to start tracking players</p>';
    return;
  }

  console.log('   Server ID:', serverId);

  try {
    const url = `/api/tracked-players?serverId=${serverId}&page=${page}&limit=${currentLimit}&sortBy=${currentSortBy}&sortOrder=${currentSortOrder}`;
    console.log('📡 [LOGS-PAGE] Fetching:', url);

    const response = await fetch(url);
    console.log('📡 [LOGS-PAGE] Players response status:', response.status);

    if (!response.ok) {
      console.error('❌ [LOGS-PAGE] Response not OK:', response.status, response.statusText);
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    console.log('📦 [LOGS-PAGE] Players data received:', data);

    if (data.success) {
      totalPages = data.pagination ? data.pagination.totalPages : 1;

      console.log('✅ [LOGS-PAGE] Loaded', data.players?.length || 0, 'players');
      console.log('   Total players:', data.pagination?.totalPlayers);
      console.log('   Total pages:', totalPages);
      console.log('   Current page:', currentPage);

      // Update pagination info
      if (data.pagination) {
        const startIdx = (currentPage - 1) * currentLimit + 1;
        const endIdx = Math.min(currentPage * currentLimit, data.pagination.totalPlayers);
        const paginationInfo = document.getElementById('paginationInfo');
        if (paginationInfo) {
          paginationInfo.textContent = `Showing ${startIdx}-${endIdx} of ${data.pagination.totalPlayers} players`;
        }
      }

      // Display players
      if (data.players.length === 0) {
        console.log('ℹ️ [LOGS-PAGE] No players found');
        container.innerHTML = '<p class="text-gray-400">No players tracked yet</p>';
      } else {
        console.log('🎨 [LOGS-PAGE] Rendering', data.players.length, 'player(s)');

        const html = `
          <div class="overflow-x-auto">
            <table class="w-full">
              <thead>
                <tr class="border-b border-gray-700">
                  <th class="text-left p-2">Player Name</th>
                  <th class="text-left p-2">Platform</th>
                  <th class="text-left p-2">Platform User ID</th>
                  <th class="text-left p-2">Device ID</th>
                  <th class="text-left p-2">First Seen</th>
                  <th class="text-left p-2">Last Seen</th>
                </tr>
              </thead>
              <tbody>
                ${data.players.map(p => `
                  <tr class="border-b border-gray-700 hover:bg-gray-700">
                    <td class="p-2">${escapeHtml(p.currentName || 'Unknown')}</td>
                    <td class="p-2 text-sm">
                      <span class="px-2 py-1 bg-gray-700 rounded text-xs">${escapeHtml(p.platform || 'unknown')}</span>
                    </td>
                    <td class="p-2 font-mono text-xs">${escapeHtml((p.platformUserId || 'N/A').substring(0, 16))}${p.platformUserId?.length > 16 ? '...' : ''}</td>
                    <td class="p-2 font-mono text-xs">${p.deviceId ? escapeHtml(p.deviceId.substring(0, 16)) + '...' : '-'}</td>
                    <td class="p-2 text-sm">${formatDate(p.firstSeenAt)}</td>
                    <td class="p-2 text-sm">${formatDate(p.lastSeenAt)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `;
        container.innerHTML = html;
        console.log('✅ [LOGS-PAGE] Players rendered successfully');
      }

      // Update pagination controls
      updatePaginationControls();

    } else {
      console.error('❌ [LOGS-PAGE] API returned success: false', data.error);
      container.innerHTML = '<p class="text-red-400">Failed to load players</p>';
    }
  } catch (err) {
    console.error('❌ [LOGS-PAGE] Error loading players:', err);
    console.error('   Error message:', err.message);
    console.error('   Stack:', err.stack);
    container.innerHTML = `<p class="text-red-400">❌ Error: ${escapeHtml(err.message)}</p>`;
  }
}

function updatePaginationControls() {
  if (currentLimit === -1 || totalPages <= 1) {
    document.getElementById('paginationControls').style.display = 'none';
    return;
  }

  document.getElementById('paginationControls').style.display = 'flex';

  // Generate page numbers (show max 5 pages)
  const pageNumbersHtml = [];
  const startPage = Math.max(1, currentPage - 2);
  const endPage = Math.min(totalPages, currentPage + 2);

  for (let i = startPage; i <= endPage; i++) {
    const active = i === currentPage ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600';
    pageNumbersHtml.push(`
      <button data-page="${i}" class="${active} px-3 py-1 rounded text-sm">
        ${i}
      </button>
    `);
  }

  document.getElementById('pageNumbers').innerHTML = pageNumbersHtml.join('');
}

function goToPage(page) {
  console.log('📄 [PAGINATION] Navigate to page:', page);
  console.log('   Valid range: 1 to', totalPages);

  if (page < 1 || page > totalPages) {
    console.warn('⚠️ [PAGINATION] Page out of range, ignoring');
    return;
  }

  loadPlayers(page);
}

function changeLimit() {
  const newLimit = parseInt(document.getElementById('limitSelect').value);
  console.log('🔢 [LIMIT] Changing limit from', currentLimit, 'to', newLimit);

  currentLimit = newLimit;
  currentPage = 1;
  loadPlayers(1);
}

function changeSort() {
  const newSortBy = document.getElementById('sortBySelect').value;
  const newSortOrder = document.getElementById('sortOrderSelect').value;

  console.log('🔀 [SORT] Changing sort:');
  console.log('   From:', currentSortBy, currentSortOrder);
  console.log('   To:', newSortBy, newSortOrder);

  currentSortBy = newSortBy;
  currentSortOrder = newSortOrder;
  currentPage = 1;
  loadPlayers(1);
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Load user's servers on page load
async function loadServers() {
  console.log('🔍 [LOGS-PAGE] Loading servers...');

  try {
    // Step 1: Get user's guilds
    const guildsResponse = await fetch('/api/user/guilds');
    console.log('📡 [LOGS-PAGE] Guilds response status:', guildsResponse.status);

    const guildsData = await guildsResponse.json();
    console.log('📦 [LOGS-PAGE] Guilds data:', guildsData);

    if (!guildsData.success || !guildsData.guilds || guildsData.guilds.length === 0) {
      console.warn('⚠️ [LOGS-PAGE] No guilds available');
      document.getElementById('serverSelect').innerHTML = '<option value="">No guilds available</option>';
      serversLoaded = false;
      return;
    }

    // Step 2: Get servers for every authorized guild. Preserve the guild ID
    // on each option so subsequent exact-server requests keep their tenant context.
    const guilds = guildsData.guilds;
    const guildServerGroups = await Promise.all(guilds.map(async guild => {
      console.log('🔍 [LOGS-PAGE] Fetching servers for guild:', guild.name, '(ID:', guild.id, ')');
      const response = await fetch(`/api/guilds/${guild.id}/servers`);
      console.log('📡 [LOGS-PAGE] Servers response status:', response.status);
      if (!response.ok) return [];
      const data = await response.json();
      if (!data.success || !Array.isArray(data.servers)) return [];
      return data.servers.map(server => ({ server, guildId: guild.id }));
    }));
    const serverOptions = guildServerGroups.flat();
    const select = document.getElementById('serverSelect');

    if (serverOptions.length === 0) {
      console.warn('⚠️ [LOGS-PAGE] No servers found');
      select.innerHTML = '<option value="">No servers found</option>';
      serversLoaded = false;
      return;
    }

    console.log('✅ [LOGS-PAGE] Found', serverOptions.length, 'server(s)');

    select.innerHTML = '<option value="">Select a server...</option>';
    serverOptions.forEach(({ server, guildId }) => {
      const serverId = server.nitrado_server_id;
      console.log('  📌 [LOGS-PAGE] Adding server:', serverId, '-', server.server_name);

      const option = document.createElement('option');
      option.value = serverId;
      option.textContent = `${server.server_name} (${serverId})`;
      option.dataset.guildId = guildId;
      select.appendChild(option);
    });
    currentGuildId = serverOptions[0].guildId;

    serversLoaded = true;
    console.log('✅ [LOGS-PAGE] Servers loaded successfully');

  } catch (err) {
    console.error('❌ [LOGS-PAGE] Error loading servers:', err);
    console.error('   Stack:', err.stack);
    document.getElementById('serverSelect').innerHTML = '<option value="">Error loading servers</option>';
    serversLoaded = false;
  }
}

async function scanLocalLogs() {
  console.log('🔘 [SCAN-LOCAL] Button clicked');

  const serverSelect = document.getElementById('serverSelect');
  const serverId = serverSelect.value;
  const statusEl = document.getElementById('scanStatus');

  console.log('   Server ID:', serverId);
  console.log('   Servers loaded:', serversLoaded);

  if (!serversLoaded) {
    console.log('⏳ [SCAN-LOCAL] Servers not loaded, loading now...');
    statusEl.innerHTML = '<span class="text-yellow-400">⏳ Loading servers, please wait...</span>';
    await loadServers();
  }

  if (!serverId) {
    console.error('❌ [SCAN-LOCAL] No server selected!');
    statusEl.innerHTML = '<span class="text-red-400">❌ Please select a server</span>';
    return;
  }

  // Get guildId from selected option or use current
  const selectedOption = serverSelect.options[serverSelect.selectedIndex];
  const guildId = selectedOption.dataset.guildId || currentGuildId;

  console.log('🚀 [SCAN-LOCAL] Starting scan for server:', serverId, 'guild:', guildId);
  statusEl.innerHTML = '<span class="text-blue-400">⏳ Scanning local logs...</span>';

  try {
    console.log('📡 [SCAN-LOCAL] Sending POST to /api/scan-local-logs');

    const response = await fetchWithCsrf('/api/scan-local-logs', {
      method: 'POST',
      body: JSON.stringify({ serverId, guildId })
    });

    console.log('📡 [SCAN-LOCAL] Response status:', response.status);

    const data = await response.json();
    console.log('📦 [SCAN-LOCAL] Response data:', data);

    if (data.success) {
      console.log('✅ [SCAN-LOCAL] Scan successful!');
      console.log('   Total players:', data.totalPlayers);
      console.log('   Files scanned:', data.filesScanned);

      statusEl.innerHTML = `<span class="text-green-400">✅ Successfully tracked ${escapeHtml(String(data.totalPlayers))} players from local logs!</span>`;

      if (data.players && data.players.length > 0) {
        let details = '<div class="mt-3 text-sm bg-gray-700 p-3 rounded"><strong>Tracked:</strong><ul class="list-disc list-inside mt-2">';
        data.players.slice(0, 5).forEach(p => {
          const userId = p.platformUserId || p.bohemiaId || p.dpnid || 'Unknown';
          details += `<li>${escapeHtml(p.playerName || 'Unknown')} (${escapeHtml(userId.substring(0, 16))}...)</li>`;
        });
        if (data.players.length > 5) {
          details += `<li class="text-gray-400">... and ${data.players.length - 5} more</li>`;
        }
        details += '</ul></div>';
        statusEl.innerHTML += details;
      }

      loadPlayers();
    } else {
      console.error('❌ [SCAN-LOCAL] Scan failed:', data.error);
      statusEl.innerHTML = `<span class="text-red-400">❌ ${escapeHtml(data.error || 'Local log scan failed')}</span>`;
    }
  } catch (err) {
    console.error('❌ [SCAN-LOCAL] Error during scan:', err);
    console.error('   Message:', err.message);
    console.error('   Stack:', err.stack);
    statusEl.innerHTML = `<span class="text-red-400">❌ Error: ${escapeHtml(err.message)}</span>`;
  }
}

// Scan ALL downloaded logs
async function scanAllLogs() {
  console.log('🔘 [SCAN-ALL] Button clicked');

  const serverSelect = document.getElementById('serverSelect');
  const serverId = serverSelect.value;

  console.log('   Server ID:', serverId);

  if (!serverId) {
    console.error('❌ [SCAN-ALL] No server selected!');
    alert('Please select a server first');
    return;
  }

  // Get guildId from selected option or use current
  const selectedOption = serverSelect.options[serverSelect.selectedIndex];
  const guildId = selectedOption.dataset.guildId || currentGuildId;

  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '⏳ Scanning all logs...';

  console.log('🚀 [SCAN-ALL] Starting full scan for server:', serverId, 'guild:', guildId);

  try {
    console.log('📡 [SCAN-ALL] Sending POST to /api/scan-all-logs');

    const response = await fetchWithCsrf('/api/scan-all-logs', {
      method: 'POST',
      body: JSON.stringify({ serverId, guildId })
    });

    console.log('📡 [SCAN-ALL] Response status:', response.status);

    const data = await response.json();
    console.log('📦 [SCAN-ALL] Response data:', data);

    if (data.success) {
      console.log('✅ [SCAN-ALL] Scan successful!');
      console.log('   ADM files:', data.filesScanned?.admCount);
      console.log('   RPT files:', data.filesScanned?.rptCount);
      console.log('   Total players:', data.totalPlayers);

      alert(`✅ Successfully scanned ${data.filesScanned.admCount} ADM logs and ${data.filesScanned.rptCount} RPT logs!\n\nFound ${data.totalPlayers} unique players.`);
      loadPlayers();
    } else {
      console.error('❌ [SCAN-ALL] Scan failed:', data.error);
      alert('❌ ' + (data.error || 'Failed to scan logs'));
    }
  } catch (err) {
    console.error('❌ [SCAN-ALL] Error during scan:', err);
    console.error('   Message:', err.message);
    console.error('   Stack:', err.stack);
    alert('❌ Error scanning logs');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 Scan All Logs';
  }
}

// Load servers when page loads
loadServers();

// Add event listeners for static buttons
document.getElementById('scanLocalLogsBtn').addEventListener('click', scanLocalLogs);
document.getElementById('detectAltsBtn').addEventListener('click', detectAlts);
document.getElementById('scanLocalLogsBtn2').addEventListener('click', scanLocalLogs);
document.getElementById('scanAllLogsBtn').addEventListener('click', scanAllLogs);
document.getElementById('loadPlayersBtn').addEventListener('click', () => loadPlayers());

// Add event listeners for select elements
document.getElementById('limitSelect').addEventListener('change', changeLimit);
document.getElementById('sortBySelect').addEventListener('change', changeSort);
document.getElementById('sortOrderSelect').addEventListener('change', changeSort);

// Add event listeners for static pagination buttons
document.getElementById('firstPageBtn').addEventListener('click', () => goToPage(1));
document.getElementById('prevPageBtn').addEventListener('click', () => goToPage(currentPage - 1));
document.getElementById('nextPageBtn').addEventListener('click', () => goToPage(currentPage + 1));
document.getElementById('lastPageBtn').addEventListener('click', () => goToPage(totalPages));

// Event delegation for dynamically generated pagination buttons
document.getElementById('pageNumbers').addEventListener('click', (e) => {
  if (e.target.tagName === 'BUTTON' && e.target.dataset.page) {
    goToPage(parseInt(e.target.dataset.page));
  }
});

console.log('✅ [LOGS-PAGE] Event listeners attached');