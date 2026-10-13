let syncJobIntervals = {};
let serverRootPaths = {}; // Store root paths per server

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    })[character]);
}

// Fetch user data
fetch('/api/user')
    .then(r => {
        if (!r.ok) throw new Error('Not logged in');
        return r.json();
    })
    .then(user => {
        document.getElementById('username').textContent = user.username;
        
        // Show admin link if user is admin
        if (user.isAdmin) {
            document.getElementById('adminLink').classList.remove('hidden');
        }
        
        loadNitradoAccountManager();
        loadRegisteredServers();
        refreshSyncJobs().catch(err => console.error('Sync jobs load failed:', err));
    })
    .catch(() => window.location.href = '/');

// Edit Mission Files
function editMissionFiles(serverId) {
    // Check if files are synced first
    fetch('/api/user')
        .then(r => r.json())
        .then(user => {
            const userId = user.discordId || user.id;
            
            // Check if download directory exists
            fetch(`/api/mission-files/list/${serverId}`)
                .then(r => r.json())
                .then(data => {
                    if (data.success && data.files && Object.keys(data.files).length > 0) {
                        // Files exist, open editor
                        window.location.href = `/mission-editor?server=${serverId}`;
                    } else if (data.availableServers && data.availableServers.length > 0) {
                        // Server files exist
                        window.location.href = `/mission-editor?server=${serverId}`;
                    } else {
                        // No files synced yet
                        showToast('No files found for this server. Click "Sync All Server Files" first, then try again.', 'danger');
                    }
                })
                .catch(err => {
                    showToast('Please sync server files before editing.', 'danger');
                });
        });
}

// Detect and Sync
function detectAndSync(serverId) {
    console.log('🔘 [SYNC] Button clicked for server:', serverId);
    
    const statusEl = document.getElementById(`server-status-${serverId}`);
    statusEl.innerHTML = '<span class="text-blue-400 pulse">🔍 Detecting server structure...</span>';
    
    console.log('🔍 [SYNC] Starting detection for server:', serverId);
    
    fetch(`/api/detect-structure/${serverId}`)
        .then(r => {
            console.log('📡 [SYNC] Detection response status:', r.status, r.statusText);
            return r.json();
        })
        .then(data => {
            console.log('📦 [SYNC] Detection data received:', JSON.stringify(data, null, 2));
            
            if (!data.success) {
                console.error('❌ [SYNC] Detection failed:', data.error);
                let errorMsg = data.error || 'Unknown error';
                if (data.debug) {
                    console.log('🐛 [SYNC] Debug info:', data.debug);
                    errorMsg += ' (see console for details)';
                }
                statusEl.innerHTML = `<span class="text-red-400">❌ ${escapeHtml(errorMsg)}</span>`;
                return;
            }
            
            if (data.platform === 'unknown') {
                console.warn('⚠️ [SYNC] Unknown platform detected');
                statusEl.innerHTML = '<span class="text-yellow-400">⚠️ Unknown platform. Check server console logs.</span>';
                return;
            }
            
            // Store root path for browsing
            if (data.rootPath) {
                console.log('📁 [SYNC] Storing root path:', data.rootPath);
                serverRootPaths[serverId] = data.rootPath;
            }
            
            // Check if we actually got paths
            if (!data.pathsToSync || data.pathsToSync.length === 0) {
                console.error('❌ [SYNC] No paths to sync!', data);
                statusEl.innerHTML = '<span class="text-red-400">❌ No valid paths found to sync</span>';
                return;
            }
            
            console.log('✅ [SYNC] Detection successful:', {
                platform: data.platform,
                pathsToSync: data.pathsToSync,
                rootPath: data.rootPath
            });
            
            statusEl.innerHTML = `<span class="text-blue-400">📡 Found ${escapeHtml(data.platform)} server, starting sync...</span>`;
            
            console.log('🚀 [SYNC] Preparing sync request:', {
                serverId: serverId,
                paths: data.pathsToSync
            });
            
            fetchWithCsrf('/api/sync-server', {
                method: 'POST',
                body: JSON.stringify({ serverId })
            })
            .then(r => {
                console.log('📡 [SYNC] Sync response status:', r.status, r.statusText);
                if (!r.ok) {
                    console.error('❌ [SYNC] Sync request failed with status:', r.status);
                }
                return r.json();
            })
            .then(syncData => {
                console.log('📦 [SYNC] Sync response data:', JSON.stringify(syncData, null, 2));
                
                if (syncData.success) {
                    console.log('✅ [SYNC] Sync job started successfully! Job ID:', syncData.jobId);
                    statusEl.innerHTML = `<span class="text-green-400">✅ Sync job started! (Job #${escapeHtml(syncData.jobId)})</span>`;
                    monitorSyncJob(syncData.jobId, statusEl);
                    setTimeout(() => {
                        console.log('🔄 [SYNC] Reloading sync jobs list');
                        refreshSyncJobs().catch(err => console.error('Sync jobs reload failed:', err));
                    }, 1000);
                } else {
                    console.error('❌ [SYNC] Sync failed:', syncData.error || 'Unknown error');
                    statusEl.innerHTML = `<span class="text-red-400">❌ ${escapeHtml(syncData.error || 'Sync failed')}</span>`;
                }
            })
            .catch(err => {
                console.error('❌ [SYNC] Sync request error:', err);
                console.error('❌ [SYNC] Error stack:', err.stack);
                statusEl.innerHTML = '<span class="text-red-400">❌ Sync request failed (see console)</span>';
            });
        })
        .catch(err => {
            console.error('❌ [SYNC] Detection error:', err);
            console.error('❌ [SYNC] Error stack:', err.stack);
            statusEl.innerHTML = '<span class="text-red-400">❌ Network error (see console)</span>';
        });
}

// Browse server files
function browseServer(serverId) {
    // First detect to get root path, then browse
    const statusEl = document.getElementById(`server-status-${serverId}`);
    
    // If we already have the root path, use it
    if (serverRootPaths[serverId]) {
        browseFiles(serverId, serverRootPaths[serverId]);
        return;
    }
    
    // Otherwise detect first
    statusEl.innerHTML = '<span class="text-blue-400 pulse">🔍 Detecting structure...</span>';
    
    fetch(`/api/detect-structure/${serverId}`)
        .then(r => r.json())
        .then(data => {
            if (data.success && data.rootPath) {
                serverRootPaths[serverId] = data.rootPath;
                browseFiles(serverId, data.rootPath);
            } else {
                // Fall back to root
                browseFiles(serverId, '');
            }
        })
        .catch(() => {
            browseFiles(serverId, '');
        });
}

// Browse Files
function browseFiles(serverId, path) {
    const statusEl = document.getElementById(`server-status-${serverId}`);
    statusEl.innerHTML = '<span class="text-blue-400 pulse">⏳ Loading...</span>';
    
    fetchWithCsrf('/api/list-files', {
        method: 'POST',
        body: JSON.stringify({ serverId, directoryPath: path })
    })
    .then(r => r.json())
    .then(data => {
        if (data.success) {
            let html = '<div class="mt-2 text-xs max-h-60 overflow-y-auto bg-gray-800 p-3 rounded">';
            html += `<p class="font-bold mb-2 text-blue-400">📁 ${escapeHtml(data.currentPath)}</p>`;
            
            if (data.directories.length > 0) {
                html += '<div class="mb-2"><strong class="text-green-400">Directories:</strong></div>';
                data.directories.forEach(d => {
                    html += `
                        <div class="hover:bg-gray-700 p-1 rounded cursor-pointer browse-directory" 
                             data-server-id="${escapeHtml(serverId)}" data-path="${escapeHtml(d.path)}">
                            📁 ${escapeHtml(d.name)}
                        </div>
                    `;
                });
            }
            
            if (data.files.length > 0) {
                html += '<div class="mt-2 mb-2"><strong class="text-yellow-400">Files:</strong></div>';
                data.files.forEach(f => {
                    const size = f.size ? `(${(f.size/1024).toFixed(1)}KB)` : '';
                    html += `<div class="text-gray-300 p-1">📄 ${escapeHtml(f.name)} ${size}</div>`;
                });
            }
            
            if (data.directories.length === 0 && data.files.length === 0) {
                html += '<p class="text-gray-400">Empty directory</p>';
            }
            
            html += '</div>';
            statusEl.innerHTML = html;
            
            // Add event listeners to browse directory elements
            statusEl.querySelectorAll('.browse-directory').forEach(el => {
                el.addEventListener('click', function() {
                    const serverId = this.getAttribute('data-server-id');
                    const path = this.getAttribute('data-path');
                    browseFiles(serverId, path);
                });
            });
        } else {
            statusEl.innerHTML = `<span class="text-red-400">❌ ${escapeHtml(data.error || 'Failed to browse')}</span>`;
        }
    })
    .catch(err => {
        console.error('Browse error:', err);
        statusEl.innerHTML = '<span class="text-red-400">❌ Browse failed</span>';
    });
}

// Monitor sync job
function monitorSyncJob(jobId, statusEl) {
    console.log('👀 [MONITOR] Starting to monitor job:', jobId);
    
    if (syncJobIntervals[jobId]) {
        console.log('⚠️ [MONITOR] Already monitoring job:', jobId);
        return;
    }
    
    syncJobIntervals[jobId] = setInterval(() => {
        if (document.hidden) return; // visibility-aware: no background job polling (card 4/9)
        console.log('🔄 [MONITOR] Checking status for job:', jobId);
        
        fetch(`/api/sync-status/${jobId}`)
            .then(r => {
                console.log('📡 [MONITOR] Status response:', r.status);
                return r.json();
            })
            .then(data => {
                console.log('📦 [MONITOR] Job status:', data);
                
                if (data.success) {
                    const job = data.job;
                    
                    if (job.status === 'completed') {
                        const sizeMB = (job.totalSize / 1024 / 1024).toFixed(2);
                        console.log('✅ [MONITOR] Job completed!', { files: job.filesDownloaded, sizeMB });
                        statusEl.innerHTML = `<span class="text-green-400">✅ Downloaded ${escapeHtml(job.filesDownloaded)} files (${escapeHtml(sizeMB)} MB)</span>`;
                        clearInterval(syncJobIntervals[jobId]);
                        delete syncJobIntervals[jobId];
                        refreshSyncJobs().catch(err => console.error('Sync jobs reload failed:', err));
                    } else if (job.status === 'failed') {
                        console.error('❌ [MONITOR] Job failed!', job.errors);
                        statusEl.innerHTML = '<span class="text-red-400">❌ Sync failed</span>';
                        clearInterval(syncJobIntervals[jobId]);
                        delete syncJobIntervals[jobId];
                        refreshSyncJobs().catch(err => console.error('Sync jobs reload failed:', err));
                    } else {
                        console.log('⏳ [MONITOR] Job still running...', { filesDownloaded: job.filesDownloaded });
                        statusEl.innerHTML = `<span class="text-blue-400 pulse">⏳ Syncing... ${escapeHtml(job.filesDownloaded || 0)} files</span>`;
                    }
                } else {
                    console.error('❌ [MONITOR] Failed to get job status');
                }
            })
            .catch(err => {
                console.error('❌ [MONITOR] Error checking job status:', err);
            });
    }, 2000);
}

// Load Sync Jobs — returns the job list; rejects on API failure so the
// polling loop (card 4/9) can mark per-panel error/stale state.
async function loadSyncJobs() {
    const container = document.getElementById('sync-jobs-container');
    const data = await (await fetch('/api/sync-jobs')).json();
    if (!data.success) throw new Error(data.error || 'Failed to load sync jobs');

    if (!data.jobs || data.jobs.length === 0) {
        container.innerHTML = '<div class="dzc-empty"><div class="dzc-empty-title">No sync jobs yet</div></div>';
        return [];
    }
    
    let html = '<div class="space-y-3 max-h-96 overflow-y-auto">';
    data.jobs.forEach(job => {
        const statusColors = {
            'running': 'blue',
            'completed': 'green',
            'failed': 'red'
        };
        const color = statusColors[job.status] || 'gray';
        const started = new Date(job.startedAt).toLocaleString();
        const completed = job.completedAt ? new Date(job.completedAt).toLocaleString() : '-';
        const sizeMB = job.totalSize ? (job.totalSize / 1024 / 1024).toFixed(2) : '0';
        
        html += `
            <div class="bg-gray-700 p-4 rounded">
                <div class="flex justify-between items-start mb-2">
                    <div>
                        <span class="font-bold">Job #${escapeHtml(job.id)}</span>
                        <span class="text-gray-400 text-sm ml-2">Server ${escapeHtml(job.serverId)}</span>
                    </div>
                    <span class="px-3 py-1 rounded text-xs bg-${color}-600">${escapeHtml(job.status)}</span>
                </div>
                <div class="text-sm space-y-1">
                    <p><strong>Started:</strong> ${escapeHtml(started)}</p>
                    <p><strong>Completed:</strong> ${escapeHtml(completed)}</p>
                    <p><strong>Files:</strong> ${escapeHtml(job.filesDownloaded || 0)}</p>
                    <p><strong>Size:</strong> ${escapeHtml(sizeMB)} MB</p>
                </div>
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;
    return data.jobs;
}

// Load registered servers
function loadRegisteredServers() {
    const container = document.getElementById('servers-container');
    container.innerHTML = '<div class="grid grid-cols-1 lg:grid-cols-2 gap-4"><div class="dzc-skeleton h-28"></div><div class="dzc-skeleton h-28"></div></div>';
    
    fetch('/api/nitrado/registered-servers')
        .then(r => r.json())
        .then(data => {
            if (!data.success) {
                throw new Error(data.error || 'Failed to load servers');
            }
            // Cache for the ops alerts widget (AI 7c) — same active-only list.
            opsServers = data.servers || [];

            if (!data.servers || data.servers.length === 0) {
                container.innerHTML = '<div class="dzc-empty"><div class="dzc-empty-icon">🎖️</div><div class="dzc-empty-title">No servers yet</div><div>Connect Nitrado with <code>/register-token</code>, then use the toggles above.</div></div>';
                return;
            }

            let html = '<div class="grid grid-cols-1 lg:grid-cols-2 gap-4">';
            
            data.servers.forEach(server => {
                const serverName = escapeHtml(server.server_name || 'Unnamed Server');
                const nitradoServerId = escapeHtml(server.nitrado_server_id);
                const guildName = escapeHtml(server.guild_name || '');
                html += `
                    <div class="server-card bg-gray-700 p-5 rounded-lg">
                        <div class="flex justify-between items-start mb-3">
                            <div>
                                <h3 class="text-xl font-bold">${serverName}</h3>
                                <p class="text-sm text-gray-400">Nitrado ID: ${nitradoServerId}</p>
                                ${guildName ? `<p class="text-xs text-blue-400">🏰 ${guildName}</p>` : ''}
                            </div>
                        </div>
                        
                        <div class="space-y-2 mt-4">
                            <button class="detect-sync-btn w-full bg-green-600 hover:bg-green-700 px-4 py-3 rounded font-semibold" 
                                    data-nitrado-id="${nitradoServerId}">
                                🔄 Sync All Server Files
                            </button>
                            <button class="edit-mission-btn w-full bg-purple-600 hover:bg-purple-700 px-4 py-2 rounded text-sm" 
                                    data-nitrado-id="${nitradoServerId}">
                                📝 Edit Mission Files
                            </button>
                            <button class="browse-server-btn w-full bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded text-sm" 
                                    data-nitrado-id="${nitradoServerId}">
                                📁 Browse Files
                            </button>
                            <div id="server-status-${nitradoServerId}" class="text-sm text-center min-h-[20px]"></div>
                        </div>
                    </div>
                `;
            });
            
            html += '</div>';
            container.innerHTML = html;
            
            // Add event listeners to server action buttons using event delegation
            document.querySelectorAll('.detect-sync-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    detectAndSync(parseInt(this.getAttribute('data-nitrado-id')));
                });
            });
            
            document.querySelectorAll('.edit-mission-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    editMissionFiles(parseInt(this.getAttribute('data-nitrado-id')));
                });
            });
            
            document.querySelectorAll('.browse-server-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    browseServer(parseInt(this.getAttribute('data-nitrado-id')));
                });
            });
        })
        .catch(err => {
            container.textContent = '';
            container.appendChild(accountServerText('p', `❌ Error: ${err.message}`, 'text-red-400'));
        });
}

function setAccountServerStatus(message, isError) {
    const status = document.getElementById('nitrado-account-servers-status');
    if (!status) return;
    status.textContent = message || '';
    status.className = isError ? 'text-sm text-red-400 mb-3' : 'text-sm text-gray-400 mb-3';
}

function accountServerText(tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    return node;
}

function renderNitradoAccountServers(servers, guildId) {
    const container = document.getElementById('nitrado-account-servers-list');
    if (!container) return;
    container.textContent = '';
    if (!servers.length) {
        container.appendChild(accountServerText('p', 'No DayZ services were found on this Nitrado account.', 'text-gray-400'));
        return;
    }

    for (const server of servers) {
        const card = document.createElement('article');
        card.className = 'bg-gray-700 border border-gray-600 rounded-lg p-4';
        const header = document.createElement('div');
        header.className = 'flex justify-between gap-3 mb-3';
        const titleWrap = document.createElement('div');
        titleWrap.appendChild(accountServerText('h3', server.displayName, 'font-bold text-lg'));
        titleWrap.appendChild(accountServerText(
            'p',
            `${server.platformLabel} · Nitrado ID ${server.serviceId}`,
            'text-sm text-gray-400'
        ));
        header.appendChild(titleWrap);

        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'flex items-center gap-2 text-sm font-semibold';
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = Boolean(server.enabled);
        toggle.className = 'h-5 w-5';
        toggleLabel.appendChild(toggle);
        toggleLabel.appendChild(document.createTextNode(server.enabled ? 'Enabled' : 'Disabled'));
        header.appendChild(toggleLabel);
        card.appendChild(header);

        const nameLabel = accountServerText('label', 'Custom name (optional)', 'block text-sm text-gray-300 mb-1');
        const nameRow = document.createElement('div');
        nameRow.className = 'flex gap-2';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.maxLength = 200;
        nameInput.value = server.customName || '';
        nameInput.placeholder = server.providerName;
        nameInput.className = 'flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-2';
        const saveButton = accountServerText('button', 'Save name', 'bg-purple-600 hover:bg-purple-700 px-3 py-2 rounded');
        saveButton.type = 'button';
        saveButton.disabled = !server.registeredServerId;
        nameRow.appendChild(nameInput);
        nameRow.appendChild(saveButton);
        card.appendChild(nameLabel);
        card.appendChild(nameRow);

        const result = accountServerText('p', '', 'text-sm mt-2 min-h-5');
        card.appendChild(result);

        const updateServer = async nextEnabled => {
            toggle.disabled = true;
            saveButton.disabled = true;
            result.textContent = 'Saving…';
            result.className = 'text-sm mt-2 min-h-5 text-blue-300';
            try {
                const response = await fetchWithCsrf(`/api/nitrado/account-servers/${encodeURIComponent(server.serviceId)}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        guildId,
                        enabled: nextEnabled,
                        customName: nameInput.value,
                    }),
                });
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.error || 'Could not update server');
                result.textContent = 'Saved';
                result.className = 'text-sm mt-2 min-h-5 text-green-400';
                await loadNitradoAccountServers();
                loadRegisteredServers();
                loadDashboardStats().catch(err => console.error('Stats refresh failed:', err));
            } catch (error) {
                toggle.checked = Boolean(server.enabled);
                result.textContent = error.message;
                result.className = 'text-sm mt-2 min-h-5 text-red-400';
                toggle.disabled = false;
                saveButton.disabled = !server.registeredServerId;
            }
        };

        toggle.addEventListener('change', () => updateServer(toggle.checked));
        saveButton.addEventListener('click', () => updateServer(toggle.checked));
        container.appendChild(card);
    }
}

async function loadNitradoAccountServers() {
    const guildSelect = document.getElementById('nitrado-guild-select');
    const container = document.getElementById('nitrado-account-servers-list');
    if (!guildSelect || !container || !guildSelect.value) return;
    const guildId = guildSelect.value;
    container.textContent = '';
    container.appendChild(accountServerText('p', 'Loading Nitrado services…', 'text-gray-400 pulse'));
    setAccountServerStatus('Checking the currently bound Nitrado account…', false);
    try {
        const response = await fetch(`/api/nitrado/account-servers?guildId=${encodeURIComponent(guildId)}`);
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Could not load Nitrado services');
        setAccountServerStatus(`${data.servers.length} DayZ service(s) found.`, false);
        renderNitradoAccountServers(data.servers, guildId);
        // Attention strip (card 4/9): disabled account services need attention.
        attentionState.disabledServices = data.servers.filter(s => !s.enabled).length;
        renderAttention();
    } catch (error) {
        container.textContent = '';
        setAccountServerStatus(error.message, true);
    }
}

async function loadNitradoAccountManager() {
    const guildSelect = document.getElementById('nitrado-guild-select');
    if (!guildSelect) return;
    try {
        const response = await fetch('/api/user/guilds');
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || 'Could not load guilds');
        guildSelect.textContent = '';
        for (const guild of data.guilds || []) {
            const option = document.createElement('option');
            option.value = guild.id;
            option.textContent = guild.name;
            guildSelect.appendChild(option);
        }
        if (!guildSelect.options.length) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No owned approved guilds';
            guildSelect.appendChild(option);
            setAccountServerStatus('Only the Discord guild owner can change server selection.', false);
            return;
        }
        await loadNitradoAccountServers();
    } catch (error) {
        guildSelect.textContent = '';
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Guilds unavailable';
        guildSelect.appendChild(option);
        setAccountServerStatus(error.message, true);
    }
}

document.getElementById('nitrado-guild-select')?.addEventListener('change', loadNitradoAccountServers);
document.getElementById('refresh-nitrado-account-servers')?.addEventListener('click', loadNitradoAccountServers);

// ── Polling consolidation (card 4/9) ────────────────────────────────────────
// One visibility-aware loop (public/js/dashboard-poll.js) drives every ambient
// widget below. The old per-widget setInterval calls are gone; manual refresh
// buttons and user actions still call the same loaders directly.

const WIDGET_INTERVALS = { stats: 30000, activity: 30000, syncJobs: 5000, ops: 30000 };
const FRESHNESS_IDS = {
  stats: 'dzc-freshness-stats',
  activity: 'dzc-freshness-activity',
  syncJobs: 'dzc-freshness-syncjobs',
  ops: 'dzc-freshness-ops',
};

// Attention strip state — derived from data the page is already authorized
// to load; nothing here infers permissions.
const attentionState = { jobs: [], healthStatus: 'healthy', disabledServices: null, ops: [] };

function renderAttention() {
  const itemsEl = document.getElementById('attention-items');
  if (!itemsEl) return;
  const items = [];
  (attentionState.jobs || []).filter(j => j.status === 'failed').slice(0, 3).forEach(job => {
    items.push({ severity: 'danger', icon: '⛔', text: `Sync job #${job.id} failed` + (job.serverId ? ` (server ${job.serverId})` : '') });
  });
  const running = (attentionState.jobs || []).filter(j => j.status === 'running');
  if (running.length > 0) {
    items.push({ severity: 'info', icon: 'ℹ️', text: `${running.length} sync job${running.length > 1 ? 's' : ''} running` });
  }
  if (attentionState.healthStatus === 'critical') {
    items.push({ severity: 'danger', icon: '⛔', text: 'Health status: critical issues' });
  } else if (attentionState.healthStatus === 'degraded') {
    items.push({ severity: 'warning', icon: '⚠️', text: 'Health status: some issues detected' });
  }
  if (attentionState.disabledServices !== null && attentionState.disabledServices > 0) {
    items.push({ severity: 'warning', icon: '⚠️', text: `${attentionState.disabledServices} Nitrado service${attentionState.disabledServices > 1 ? 's' : ''} disabled` });
  }
  // Ops alerts (AI 7c) feed the strip too — capped at 4 by opsAttentionItems.
  (attentionState.ops || []).forEach(item => { items.push(item); });
  itemsEl.textContent = '';
  if (items.length === 0) {
    const allClear = document.createElement('span');
    allClear.className = 'dzc-attention-allclear';
    allClear.textContent = 'All clear — nothing needs attention.';
    itemsEl.appendChild(allClear);
    return;
  }
  for (const item of items) {
    const chip = document.createElement('span');
    chip.className = 'dzc-attention-item';
    chip.setAttribute('data-severity', item.severity);
    chip.textContent = `${item.icon} ${item.text}`;
    itemsEl.appendChild(chip);
  }
}

// Load Sync Jobs via the polling loop; keeps the attention strip in sync.
async function refreshSyncJobs() {
  const jobs = await loadSyncJobs();
  attentionState.jobs = jobs || [];
  renderAttention();
  return jobs;
}

// ── Operations alerts (AI 7c) ───────────────────────────────────────────────
// One widget in the shared polling loop (no second interval). Per-server
// fetch isolation lives in refreshOpsAlerts: a failed server renders its own
// error row, the rest of the panel stays. The lag-cause POST persists a
// reviewable suggestion group server-side, so it runs once per page load —
// never inside the poll.
let opsServers = [];
let opsState = {};
let opsRemediation = {};

async function refreshOpsAlerts() {
  if (!opsServers.length) {
    const res = await fetch('/api/nitrado/registered-servers');
    const data = await res.json();
    if (!data.success || !data.servers) throw new Error(data.error || 'Failed to load servers');
    opsServers = data.servers;
  }
  opsState = {};
  for (const server of opsServers) {
    const id = server.nitrado_server_id;
    const state = await window.dzcOps.fetchOpsForServer(id, fetch).catch(err => ({
      serverId: id,
      serverName: server.server_name || null,
      summary: null,
      warningsError: String((err && err.message) || err),
      rollback: null,
      rollbackError: null,
    }));
    if (state.serverName == null) state.serverName = server.server_name || null;
    opsState[id] = state;
  }
  renderOpsAlerts();
}

function renderOpsAlerts() {
  const body = document.getElementById('ops-alerts-body');
  if (!body) return;
  body.innerHTML = window.dzcOps.renderOpsPanel(opsState, opsRemediation);
  attentionState.ops = window.dzcOps.opsAttentionItems(opsState);
  renderAttention();
}

async function runOpsRemediationOnce() {
  // POST needs a CSRF token (csurf validates unsafe methods globally); the
  // house pattern is /api/csrf-token + X-CSRF-Token (see rotation.js).
  let csrfToken = '';
  try {
    const r = await fetch('/api/csrf-token');
    if (r.ok) {
      const d = await r.json();
      csrfToken = d.token || d.csrfToken || '';
    }
  } catch (err) { /* fall through: POST will 403 and the panel shows its error row */ }
  const fetchWithCsrf = (url, opts) => fetch(url, Object.assign({}, opts, {
    headers: Object.assign({}, opts && opts.headers, csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
  }));
  for (const server of opsServers) {
    const id = server.nitrado_server_id;
    if (opsRemediation[id] && !opsRemediation[id].error) continue;
    opsRemediation[id] = await window.dzcOps.runLagRemediation(id, fetchWithCsrf)
      .catch(err => ({ error: String((err && err.message) || err) }));
  }
  renderOpsAlerts();
}

// Freshness + stale state, rendered by the single loop's onTick callback.
function freshnessText(state, intervalMs) {
  const now = Date.now();
  if (state.lastOkAt === null && state.lastErrorAt === null) return '';
  if (state.lastOkAt === null) return 'unavailable';
  const secs = Math.max(0, Math.floor((now - state.lastOkAt) / 1000));
  const stale = state.lastErrorAt !== null && state.lastErrorAt > state.lastOkAt;
  return stale ? `stale — updated ${secs}s ago` : `updated ${secs}s ago`;
}

function updateFreshnessLabels(states) {
  for (const name of Object.keys(FRESHNESS_IDS)) {
    const el = document.getElementById(FRESHNESS_IDS[name]);
    const state = states[name];
    if (!el || !state) continue;
    const text = freshnessText(state, WIDGET_INTERVALS[name]);
    el.textContent = text;
    el.classList.toggle('is-stale', text === 'unavailable' || text.indexOf('stale') === 0);
  }
}

// Per-panel error row (inline; last good data stays on screen).
function showPanelError(name, message) {
  const containerId = name === 'activity' ? 'activity-feed' : name === 'ops' ? 'ops-alerts-body' : 'sync-jobs-container';
  const container = document.getElementById(containerId);
  if (!container) return;
  let row = document.getElementById(`dzc-error-${name}`);
  if (!row) {
    row = document.createElement('div');
    row.id = `dzc-error-${name}`;
    row.className = 'dzc-error-row';
    container.insertBefore(row, container.firstChild);
  }
  row.textContent = message;
}

function hidePanelError(name) {
  const row = document.getElementById(`dzc-error-${name}`);
  if (row) row.remove();
}

function handleWidgetState(name, state) {
  if (name === 'stats') return; // KPI row: freshness label carries the state
  if (state.lastErrorAt !== null && state.lastErrorAt > (state.lastOkAt || 0)) {
    showPanelError(name, state.lastOkAt === null
      ? 'Could not load — retrying automatically.'
      : 'Last refresh failed — showing cached data.');
  } else {
    hidePanelError(name);
  }
}

// Small local toast (card 4/9) — replaces this page's native dialog calls.
// Kept page-local: the global notification system is out of scope for this wave.
function showToast(message, severity) {
  const host = document.createElement('div');
  host.className = 'dzc-toast';
  host.setAttribute('role', 'status');
  if (severity) host.setAttribute('data-severity', severity === 'danger' ? 'danger' : 'info');
  host.textContent = message;
  document.body.appendChild(host);
  setTimeout(() => { host.remove(); }, 5000);
}

// ── KPI cards (card 4/9) ────────────────────────────────────────────────────
const kpiBaselines = {};
const KPI_IDS = {
  servers: { value: 'stat-total-servers', delta: 'kpi-servers-delta' },
  players: { value: 'stat-total-players', delta: 'kpi-players-delta' },
  guilds: { value: 'stat-active-guilds', delta: 'kpi-guilds-delta' },
};

function setCountKpi(key, value) {
  const valueEl = document.getElementById(KPI_IDS[key].value);
  if (!valueEl) return;
  valueEl.textContent = String(value);
  if (kpiBaselines[key] === undefined) kpiBaselines[key] = value;
  const delta = value - kpiBaselines[key];
  const deltaEl = document.getElementById(KPI_IDS[key].delta);
  if (!deltaEl) return;
  if (delta === 0) {
    deltaEl.textContent = 'stable since page load';
    deltaEl.className = 'dzc-kpi-delta';
  } else {
    deltaEl.textContent = `${delta > 0 ? '+' : ''}${delta} vs page load`;
    deltaEl.className = `dzc-kpi-delta ${delta > 0 ? 'up' : 'down'}`;
  }
}

function renderHealthKpi(status) {
  const healthEl = document.getElementById('stat-health-status');
  const healthTextEl = document.getElementById('stat-health-text');
  const card = document.getElementById('kpi-health');
  if (status === 'degraded') {
    healthEl.textContent = '⚠️';
    healthTextEl.textContent = 'Some issues detected';
    if (card) card.className = 'dzc-kpi dzc-kpi--warn';
  } else if (status === 'critical') {
    healthEl.textContent = '🔴';
    healthTextEl.textContent = 'Critical issues';
    if (card) card.className = 'dzc-kpi dzc-kpi--crit';
  } else {
    healthEl.textContent = '✅';
    healthTextEl.textContent = 'All systems operational';
    if (card) card.className = 'dzc-kpi';
  }
}

// Vanilla SVG sparkline (no chart lib) — 7-day daily-active KPI.
function renderSparkline(svgEl, values) {
  if (!svgEl || !values || values.length < 2) return;
  svgEl.textContent = '';
  const max = Math.max.apply(null, values.concat([1]));
  const min = Math.min.apply(null, values);
  const range = (max - min) || 1;
  const W = 100, H = 28, PAD = 2;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    const y = H - PAD - ((v - min) / range) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', points);
  polyline.setAttribute('fill', 'none');
  polyline.setAttribute('stroke', 'currentColor');
  polyline.setAttribute('stroke-width', '1.5');
  svgEl.appendChild(polyline);
}

function updateDailyActiveKpi(dailyActive) {
  const valueEl = document.getElementById('kpi-daily-value');
  const deltaEl = document.getElementById('kpi-daily-delta');
  const sparkEl = document.getElementById('kpi-daily-spark');
  if (!valueEl || !dailyActive || dailyActive.length === 0) return;
  const last7 = dailyActive.slice(-7);
  const prev7 = dailyActive.slice(-14, -7);
  const sum = arr => arr.reduce((acc, r) => acc + (r.count || 0), 0);
  const current = sum(last7);
  valueEl.textContent = String(current);
  if (prev7.length >= 7) {
    const delta = current - sum(prev7);
    if (delta === 0) {
      deltaEl.textContent = 'flat vs prior 7 days';
      deltaEl.className = 'dzc-kpi-delta';
    } else {
      deltaEl.textContent = `${delta > 0 ? '+' : ''}${delta} vs prior 7 days`;
      deltaEl.className = `dzc-kpi-delta ${delta > 0 ? 'up' : 'down'}`;
    }
  } else {
    deltaEl.textContent = 'partial history';
    deltaEl.className = 'dzc-kpi-delta';
  }
  if (sparkEl) {
    sparkEl.hidden = false;
    renderSparkline(sparkEl, last7.map(r => r.count || 0));
  }
}

// ────────────────────────────────────────────────────────────────────────────

// Add event listeners for static buttons
document.getElementById('loadRegisteredServersBtn').addEventListener('click', loadRegisteredServers);
document.getElementById('loadSyncJobsBtn').addEventListener('click', () => {
  refreshSyncJobs().catch(err => console.error('Sync jobs refresh failed:', err));
});

// Rollback restore link (AI 7c): confirm-gated navigation to the existing
// mission-file restore flow — the restore endpoint keeps its own gates.
document.getElementById('ops-alerts-body')?.addEventListener('click', ev => {
  const link = ev.target.closest('a.dzc-ops-restore-link');
  if (!link) return;
  ev.preventDefault();
  window.dzcOps.gatedRestore(link, {});
});

// Load dashboard stats — rejects on API failure so the polling loop can
// mark the KPI row stale; keeps last good values on screen otherwise.
async function loadDashboardStats() {
  const res = await fetch('/api/owner/dashboard/stats');
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Failed to load stats');

  setCountKpi('servers', data.stats.totalServers || 0);
  setCountKpi('players', data.stats.totalPlayers || 0);
  setCountKpi('guilds', data.stats.activeGuilds || 0);
  renderHealthKpi(data.stats.healthStatus || 'healthy');

  attentionState.healthStatus = data.stats.healthStatus || 'healthy';
  renderAttention();
}

// Load recent activity — rejects on API failure (see loadDashboardStats).
async function loadRecentActivity() {
  const res = await fetch('/api/owner/dashboard/activity');
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Failed to load activity');

  const feedEl = document.getElementById('activity-feed');

  if (!data.activities || data.activities.length === 0) {
    feedEl.innerHTML = '<div class="dzc-empty"><div class="dzc-empty-title">No recent activity</div></div>';
    return;
  }

  feedEl.innerHTML = data.activities.map(activity => {
    const icon = getActivityIcon(activity.type);
    const timeAgo = formatTimeAgo(activity.timestamp);

    return `
      <div class="flex items-center gap-3 p-3 bg-gray-750 rounded border border-gray-600 hover:border-gray-500 transition">
        <span class="text-2xl">${icon}</span>
        <div class="flex-1">
          <p class="text-sm font-medium">${escapeHtml(activity.description)}</p>
          <p class="text-xs text-gray-400">${timeAgo}</p>
        </div>
      </div>
    `;
  }).join('');
}

function getActivityIcon(type) {
  const icons = {
    'server_registered': '🖥️',
    'player_linked': '👤',
    'guild_created': '🏰',
    'economy_transaction': '💰',
    'feed_posted': '📢'
  };
  return icons[type] || '📋';
}

function formatTimeAgo(timestamp) {
  const now = new Date();
  const past = new Date(timestamp);
  const diff = Math.floor((now - past) / 1000);

  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Initialize stats and activity on page load, then hand ambient refresh to
// the single visibility-aware polling loop (card 4/9).
document.addEventListener('DOMContentLoaded', () => {
  const pollLoop = window.dzcPolling.createPollingLoop({
    tickMs: 1000,
    widgets: {
      stats: { intervalMs: WIDGET_INTERVALS.stats, run: loadDashboardStats },
      activity: { intervalMs: WIDGET_INTERVALS.activity, run: loadRecentActivity },
      syncJobs: { intervalMs: WIDGET_INTERVALS.syncJobs, run: refreshSyncJobs },
      ops: { intervalMs: WIDGET_INTERVALS.ops, run: refreshOpsAlerts },
    },
    onTick: updateFreshnessLabels,
    onState: handleWidgetState,
  });
  pollLoop.start();

  loadDashboardStats().catch(err => {
    // A pending/disabled guild is a legitimate state, not an error — keep it
    // out of the console error stream (poll loop retries silently).
    if (err && /pending approval|disabled/i.test(String(err.message))) console.warn('Dashboard stats:', err.message);
    else console.error('Error loading dashboard stats:', err);
    const label = document.getElementById('dzc-freshness-stats');
    if (label) { label.textContent = 'unavailable'; label.classList.add('is-stale'); }
  });
  loadRecentActivity().catch(err => {
    if (err && /pending approval|disabled/i.test(String(err.message))) console.warn('Dashboard activity:', err.message);
    else console.error('Error loading activity:', err);
    showPanelError('activity', 'Could not load — retrying automatically.');
  });
  // Ops alerts: ambient GETs via the poll loop; the one-shot lag-cause POST
  // runs after the first refresh so the panel renders findings on load.
  refreshOpsAlerts()
    .then(runOpsRemediationOnce)
    .catch(err => {
      console.error('Error loading ops alerts:', err);
      showPanelError('ops', 'Could not load — retrying automatically.');
    });

  document.getElementById('refresh-activity')?.addEventListener('click', () => {
    loadRecentActivity().catch(err => console.error('Activity refresh failed:', err));
  });

  initSessionAnalytics();
});

// Check URL for error=no_servers and show message if present
document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('error') === 'no_servers') {
    let publicConfig = {};
    try {
      const response = await fetch('/api/public-config');
      if (response.ok) publicConfig = await response.json();
    } catch (error) {
      console.warn('Unable to load public instance configuration:', error.message);
    }

    document.querySelector('.container').innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;text-align:center;padding:2rem;">
        <div style="background:#1f2937;border:1px solid #374151;border-radius:8px;padding:3rem;max-width:600px;">
          <svg style="width:80px;height:80px;margin-bottom:1.5rem;opacity:0.5;" fill="currentColor" viewBox="0 0 20 20">
            <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z"/>
          </svg>
          <h2 style="margin-bottom:1rem;font-size:1.75rem;font-weight:bold;">No Servers Registered</h2>
          <p style="margin-bottom:2rem;color:#9ca3af;font-size:1.1rem;">You don't have any DayZ servers registered yet.</p>
          <div style="display:flex;gap:1rem;justify-content:center;flex-wrap:wrap;">
            <a id="player-portal-link" href="/player-portal" style="padding:0.75rem 1.5rem;background:#5865F2;color:white;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">
              Visit Player Portal
            </a>
            <a id="discord-invite-link" href="#" style="padding:0.75rem 1.5rem;background:transparent;color:white;border:1px solid #374151;border-radius:6px;text-decoration:none;font-weight:600;display:none;">
              Sign Up Your Server
            </a>
          </div>
          <p style="margin-top:2rem;font-size:0.9rem;color:#9ca3af;">
            Server owners: Join our Discord to get started<br>
            Players: Use the player portal to link your game account
          </p>
        </div>
      </div>
    `;

    if (publicConfig.playerPortalUrl) {
      document.getElementById('player-portal-link').href = publicConfig.playerPortalUrl;
    }
    if (publicConfig.discordInviteUrl) {
      const inviteLink = document.getElementById('discord-invite-link');
      inviteLink.href = publicConfig.discordInviteUrl;
      inviteLink.style.display = 'inline-block';
    }
  }
});

// ─── Session Analytics ────────────────────────────────────────────────────────

/**
 * Initialise the Session Analytics section.
 * Populates the server selector from the registered-servers API, then loads
 * analytics when a server is chosen.
 */
function initSessionAnalytics() {
  const sel = document.getElementById('analytics-server-select');
  if (!sel) return;

  fetch('/api/nitrado/registered-servers')
    .then(r => r.json())
    .then(data => {
      if (!data.success || !data.servers || data.servers.length === 0) return;
      data.servers.forEach(srv => {
        const opt = document.createElement('option');
        // /api/player/session-analytics guards on the internal servers.id
        // (server_player_memberships.server_id), not the Nitrado platform id.
        opt.value       = srv.id;
        opt.textContent = srv.server_name || srv.nitrado_server_id;
        sel.appendChild(opt);
      });
      // Auto-load when only one server is registered
      if (data.servers.length === 1) {
        sel.value = data.servers[0].id;
        loadSessionAnalytics(data.servers[0].id);
      }
    })
    .catch(err => console.warn('Could not load servers for analytics:', err));

  sel.addEventListener('change', function() {
    if (this.value) loadSessionAnalytics(this.value);
  });
}

/**
 * Fetch /api/player/session-analytics and render summary cards +
 * two inline bar charts (daily active players and peak hours).
 *
 * @param {string|number} serverId - internal servers.id (see initSessionAnalytics)
 */
async function loadSessionAnalytics(serverId) {
  try {
    const params = new URLSearchParams({ serverId, days: 30 });
    const res    = await fetch('/api/player/session-analytics?' + params);
    const data   = await res.json();

    if (!data.ok) {
      console.warn('Session analytics error:', data.error);
      return;
    }

    // Summary cards
    const avg = data.avgSessionMinutes;
    const h   = Math.floor(avg / 60);
    const m   = Math.round(avg % 60);
    document.getElementById('analytics-avg-session').textContent =
      h > 0 ? `${h}h ${m}m` : `${m}m`;
    document.getElementById('analytics-total-sessions').textContent =
      data.totalSessions.toLocaleString();

    // Daily active bar chart
    renderAnalyticsBarChart(
      'analytics-daily-chart',
      data.dailyActive,
      r => r.date,
      r => r.count,
      '#3b82f6',
      '96px'
    );

    // 7-day daily-active KPI card (sparkline + delta) — card 4/9
    updateDailyActiveKpi(data.dailyActive);

    // Peak hours bar chart — fill all 24 hour slots
    const hourMap = {};
    data.peakHours.forEach(r => { hourMap[r.hour] = r.count; });
    const allHours = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: hourMap[i] || 0 }));
    renderAnalyticsBarChart(
      'analytics-peak-chart',
      allHours,
      r => r.hour + ':00',
      r => r.count,
      '#10b981',
      '64px'
    );
  } catch (err) {
    console.error('Session analytics fetch error:', err);
  }
}

/**
 * Render a simple pure-CSS bar chart into a container element.
 *
 * @param {string}   containerId - DOM id of the chart container
 * @param {Array}    data        - array of data points
 * @param {Function} labelFn     - maps a point to its tooltip label
 * @param {Function} valueFn     - maps a point to its numeric value
 * @param {string}   colour      - bar fill CSS colour
 * @param {string}   height      - container height (e.g. '96px')
 */
function renderAnalyticsBarChart(containerId, data, labelFn, valueFn, colour, height) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!data || data.length === 0) {
    el.innerHTML = '<span class="text-gray-500 text-sm self-end">No data</span>';
    return;
  }

  const maxVal = Math.max(...data.map(valueFn), 1);

  el.style.height     = height;
  el.style.display    = 'flex';
  el.style.alignItems = 'flex-end';
  el.style.gap        = '1px';

  el.innerHTML = data.map(d => {
    const val = valueFn(d);
    const pct = Math.round((val / maxVal) * 100);
    return `<div title="${escapeHtml(labelFn(d))}: ${escapeHtml(val)}"
                 style="flex:1; background:${colour}; height:${pct}%;
                        min-height:${val > 0 ? '2px' : '0'};
                        border-radius:2px 2px 0 0; opacity:0.85;"></div>`;
  }).join('');
}
