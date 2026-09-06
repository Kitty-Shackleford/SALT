/* eslint-env browser */
'use strict';

/* ── State ─────────────────────────────────────────────────────────── */
let currentServerId  = null;   // platform_server_id
let currentFilename  = null;
let currentFileContent = null;
let activeSuggestion = null;   // for the diff modal
let csrfToken        = null;
const pendingChatEdits = new Map();
let nextChatEditId = 1;

/* ── Bootstrap ─────────────────────────────────────────────────────── */
async function init() {
  const tokenRes = await fetch('/api/csrf-token');
  const tokenData = await tokenRes.json();
  csrfToken = tokenData.csrfToken;

  await loadServers();
  await checkAiProviderStatus();
  await checkGitHubStatus();
  if (window.location.hash === '#repo') switchTab('repo');
}

async function checkAiProviderStatus() {
  const res = await fetch('/api/ai/provider/status');
  const data = await res.json();
  const configured = res.ok && Boolean(data.configured);
  document.getElementById('aiProviderBanner').classList.toggle('hidden', configured);
  document.getElementById('aiProviderConnectedBar').classList.toggle('hidden', !configured);
  const label = data.type === 'copilot' ? 'GitHub Copilot' : 'OpenAI-compatible';
  const details = configured ? `${label} · ${data.model}${data.source === 'operator' ? ' · operator supplied' : ''}` : '';
  document.getElementById('aiProviderDisplay').textContent = details;
  document.getElementById('aiModelDisplay').textContent = configured ? `AI: ${data.model}` : '';
  document.getElementById('aiProviderDisconnectBtn').classList.toggle('hidden', data.source === 'operator');
}

function updateAiProviderFields() {
  const copilot = document.getElementById('aiProviderType').value === 'copilot';
  if (copilot) document.getElementById('aiProviderToken').value = '';
  document.getElementById('openAiProviderFields').classList.toggle('hidden', copilot);
  document.getElementById('copilotProviderFields').classList.toggle('hidden', !copilot);
}

function showAiProviderModal() {
  document.getElementById('aiProviderModal').classList.remove('hidden');
  document.getElementById('aiProviderError').classList.add('hidden');
  document.getElementById('aiProviderToken').value = '';
  updateAiProviderFields();
}

function closeAiProviderModal() {
  document.getElementById('aiProviderModal').classList.add('hidden');
  document.getElementById('aiProviderToken').value = '';
}

async function connectAiProvider() {
  const type = document.getElementById('aiProviderType').value;
  const button = document.getElementById('aiProviderConnectBtn');
  const error = document.getElementById('aiProviderError');
  const payload = type === 'copilot'
    ? { type, model: 'auto' }
    : {
        type,
        baseURL: document.getElementById('aiProviderBaseUrl').value.trim(),
        model: document.getElementById('aiProviderModel').value.trim(),
        token: document.getElementById('aiProviderToken').value.trim(),
      };
  error.classList.add('hidden');
  button.disabled = true;
  button.textContent = 'Verifying...';
  try {
    const res = await fetch('/api/ai/provider/connection', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      error.textContent = data.error || 'Could not connect this AI provider.';
      error.classList.remove('hidden');
      return;
    }
    closeAiProviderModal();
    await checkAiProviderStatus();
  } catch (_) {
    error.textContent = 'Network error while connecting AI provider.';
    error.classList.remove('hidden');
  } finally {
    button.disabled = false;
    button.textContent = 'Verify & Connect';
  }
}

async function disconnectAiProvider() {
  if (!confirm('Disconnect your personal AI provider?')) return;
  const res = await fetch('/api/ai/provider/connection', {
    method: 'DELETE',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  if (res.ok) await checkAiProviderStatus();
}

async function loadServers() {
  const res  = await fetch('/api/ai/servers');
  const data = await res.json();
  const sel  = document.getElementById('serverSelect');
  (data.servers || data || []).forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.platformServerId;
    opt.dataset.internalServerId = s.id;
    opt.textContent = `${s.name || s.platformServerId} (${s.platform || 'unknown'})`;
    sel.appendChild(opt);
  });
}

async function checkGitHubStatus() {
  const res  = await fetch('/api/ai/github/status');
  const data = await res.json();

  if (!data.connected) {
    document.getElementById('ghBanner').classList.remove('hidden');
    document.getElementById('ghConnectedBar').classList.add('hidden');
  } else {
    document.getElementById('ghBanner').classList.add('hidden');
    document.getElementById('ghConnectedBar').classList.remove('hidden');
    document.getElementById('ghUsernameDisplay').textContent = `@${data.username}`;
    document.getElementById('autoCommitToggle').checked = data.autoCommit;
  }
}

/* ── Server change ──────────────────────────────────────────────────── */
async function onServerChange() {
  const serverSelect = document.getElementById('serverSelect');
  currentServerId = serverSelect.value;
  if (!currentServerId) return;

  await loadSuggestions();
  await loadRepoLink();
  await loadRepos();
  await loadGitHubOperations();
}

/* ── Tabs ───────────────────────────────────────────────────────────── */
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
  document.getElementById(`tab-${name}`).classList.add('active');
  document.getElementById(`pane-${name}`).classList.remove('hidden');
}

/* ── GitHub Connect Modal ───────────────────────────────────────────── */
function showConnectModal() {
  document.getElementById('connectModal').classList.remove('hidden');
  document.getElementById('connectError').classList.add('hidden');
  document.getElementById('patInput').value = '';
}
function closeConnectModal() {
  document.getElementById('patInput').value = '';
  document.getElementById('connectModal').classList.add('hidden');
}

async function connectPAT() {
  const token = document.getElementById('patInput').value.trim();
  if (!token) return;

  const btn = document.getElementById('connectBtn');
  btn.textContent = 'Connecting...';
  btn.disabled = true;

  const res  = await fetch('/api/ai/github/connect-pat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ token }),
  });
  const data = await res.json();

  btn.textContent = 'Connect';
  btn.disabled = false;

  if (!res.ok) {
    document.getElementById('connectError').textContent = data.error;
    document.getElementById('connectError').classList.remove('hidden');
    return;
  }

  closeConnectModal();
  await checkGitHubStatus();
  await loadRepos();
  await loadRepoLink();
  await loadGitHubOperations();
}

async function disconnectGitHub() {
  if (!confirm('Disconnect GitHub? Repository links and pull-request creation will be unavailable.')) return;
  const res = await fetch('/api/ai/github/disconnect', {
    method: 'DELETE',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Failed to disconnect GitHub');
    return;
  }
  await checkGitHubStatus();
  await loadRepoLink();
  await loadGitHubOperations();
}

async function saveSettings() {
  const autoCommit = document.getElementById('autoCommitToggle').checked;
  await fetch('/api/ai/github/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ autoCommit }),
  });
}

/* ── Chat ───────────────────────────────────────────────────────────── */
async function loadFile() {
  if (!currentServerId) return alert('Select a server first');
  const filename = document.getElementById('fileNameSelect').value;
  const btn      = document.getElementById('loadFileBtn');
  const status   = document.getElementById('fileStatus');

  btn.textContent = 'Loading...';
  btn.disabled = true;
  status.textContent = '';

  try {
    // Use the mission files API to download the file content
    const res  = await fetch(`/api/mission-files/${encodeURIComponent(currentServerId)}/${encodeURIComponent(filename)}`);
    const data = await res.json();

    if (!res.ok || !data.content) {
      status.textContent = '❌ ' + (data.error || 'File not found');
      return;
    }

    currentFilename    = filename;
    currentFileContent = data.content;

    document.getElementById('chatTitle').textContent = `Chat — ${filename}`;
    status.textContent = `✅ Loaded ${Math.round(data.content.length / 1024)}KB`;

    // Show server context
    await loadContextSummary();

    // Reset chat with file pre-loaded
    const chatMessages = document.getElementById('chatMessages');
    chatMessages.innerHTML = `
      <div class="bg-gray-700 rounded p-3 text-sm">
        <span class="text-green-400 font-semibold" data-loaded-file-name></span>
        <p class="text-gray-300 mt-1">File is ready. What would you like to do? Try asking:</p>
        <ul class="text-gray-400 mt-2 space-y-1 list-disc list-inside text-xs">
          <li>Increase the nominal of all assault rifles by 20%</li>
          <li>What items have the lowest spawn rates?</li>
          <li>Add more food items near the coast</li>
        </ul>
      </div>
    `;
    const loadedFileName = chatMessages.querySelector('[data-loaded-file-name]');
    loadedFileName.textContent = `${filename} loaded`;
  } finally {
    btn.textContent = 'Load File from Server';
    btn.disabled = false;
  }
}

async function loadContextSummary() {
  if (!currentServerId) return;
  try {
    const res  = await fetch(`/api/ai/context/${currentServerId}`);
    const data = await res.json();
    if (data.context) {
      document.getElementById('contextText').textContent = data.context;
      document.getElementById('contextSummary').classList.remove('hidden');
    }
  } catch (_) { /* context is cosmetic, ignore errors */ }
}

async function sendMessage() {
  const input = document.getElementById('chatInput');
  const msg   = input.value.trim();
  if (!msg) return;
  if (!currentServerId) return alert('Select a server first');

  const sendBtn = document.getElementById('sendBtn');
  sendBtn.textContent = '...';
  sendBtn.disabled = true;
  input.value = '';

  // Append user message to chat
  appendMessage('user', msg);

  try {
    const res  = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({
        platformServerId: currentServerId,
        filename:    currentFilename || 'general',
        fileContent: currentFileContent,
        message: msg,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      appendMessage('error', data.error || 'Request failed');
      return;
    }

    appendMessage('assistant', data.reply, data.editedContent, data.suggestionId);
  } finally {
    sendBtn.textContent = 'Send';
    sendBtn.disabled = false;
    input.focus();
  }
}

function appendMessage(role, content, editedContent, editedSuggestionId) {
  const container = document.getElementById('chatMessages');
  const div       = document.createElement('div');

  if (role === 'user') {
    div.className = 'flex justify-end';
    div.innerHTML = `<div class="bg-blue-700 rounded-lg px-4 py-2 max-w-lg text-sm">${escHtml(content)}</div>`;
  } else if (role === 'assistant') {
    // Render markdown-ish: fenced blocks as preformatted
    const rendered = renderAIResponse(content);
    let applyBtn = '';
    if (editedContent) {
      const editKey = String(nextChatEditId++);
      pendingChatEdits.set(editKey, {
        content: editedContent,
        filename: currentFilename || '',
        suggestionId: editedSuggestionId,
      });
      applyBtn = `<button type="button" data-action="preview-apply" data-edit-key="${editKey}"
        class="mt-2 bg-green-700 hover:bg-green-600 px-3 py-1 rounded text-xs font-semibold">
        ✅ Review these changes
      </button>`;
    }
    div.className = 'flex justify-start';
    div.innerHTML = `<div class="bg-gray-700 rounded-lg px-4 py-3 max-w-2xl text-sm">${rendered}${applyBtn}</div>`;
  } else {
    div.className = 'text-red-400 text-sm text-center';
    div.textContent = '❌ ' + content;
  }

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function renderAIResponse(text) {
  // Render fenced code blocks and basic line breaks
  let html = escHtml(text);
  html = html.replace(/```(?:xml|json)?\n([\s\S]*?)```/g, (_, code) =>
    `<pre class="bg-gray-900 rounded p-2 text-xs text-green-300 overflow-x-auto whitespace-pre-wrap mt-2 mb-2">${code}</pre>`
  );
  html = html.replace(/\n/g, '<br>');
  return html;
}

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeGitHubUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : null;
  } catch (_) {
    return null;
  }
}

async function clearHistory() {
  if (!currentServerId || !currentFilename) return;
  await fetch('/api/ai/chat/history', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ platformServerId: currentServerId, filename: currentFilename }),
  });
  document.getElementById('chatMessages').innerHTML = '<div class="text-gray-500 text-center text-sm mt-4">History cleared.</div>';
}

/* ── Suggestions ────────────────────────────────────────────────────── */
async function loadSuggestions() {
  if (!currentServerId) return;
  const res  = await fetch(`/api/ai/suggestions/${currentServerId}`);
  const data = await res.json();
  renderSuggestions(data.suggestions || []);
}

function renderSuggestions(suggestions) {
  const el = document.getElementById('suggestionsList');
  if (!suggestions.length) {
    el.innerHTML = '<p class="text-gray-500 text-center py-8">No suggestions yet — click Analyze Now.</p>';
    return;
  }

  el.innerHTML = suggestions.map(s => {
    const statusColor = {
      pending: 'text-yellow-400', accepted: 'text-green-400',
      rejected: 'text-red-400',  applied: 'text-blue-400',
    }[s.status] || 'text-gray-400';

    const prUrl = safeGitHubUrl(s.github_pr_url);
    return `
      <div class="bg-gray-800 rounded-lg p-4 border border-gray-700">
        <div class="flex items-start justify-between gap-4">
          <div class="flex-1">
            <div class="flex items-center gap-2 mb-2">
              <span class="font-mono text-sm text-blue-300">${escHtml(s.filename)}</span>
              <span class="text-xs ${statusColor} capitalize">${s.status}</span>
              <span class="text-xs text-gray-500">${new Date(s.created_at).toLocaleDateString()}</span>
            </div>
            <p class="text-sm text-gray-300">${escHtml(s.explanation)}</p>
            ${s.diff_summary ? `<p class="text-xs text-gray-500 mt-1 italic">${escHtml(s.diff_summary)}</p>` : ''}
            ${prUrl ? `<a href="${escHtml(prUrl)}" target="_blank" rel="noopener noreferrer" class="text-xs text-blue-400 hover:underline mt-1 block">🔗 View PR on GitHub</a>` : ''}
          </div>
          ${s.status === 'pending' || s.status === 'accepted' ? `
            <div class="flex gap-2 shrink-0">
              <button type="button" data-action="open-suggestion" data-suggestion-id="${s.id}" class="bg-green-700 hover:bg-green-600 px-3 py-1 rounded text-xs">View & Apply</button>
              <button type="button" data-action="dismiss-suggestion" data-suggestion-id="${s.id}" class="bg-gray-700 hover:bg-gray-600 px-3 py-1 rounded text-xs">Dismiss</button>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

async function runAnalysis() {
  if (!currentServerId) return alert('Select a server first');
  const filename = document.getElementById('analyzeFileSelect').value;
  const btn      = document.getElementById('analyzeBtn');

  // We need file content — try to load it first
  btn.textContent = 'Loading file...';
  btn.disabled = true;

  try {
    const fileRes  = await fetch(`/api/mission-files/${encodeURIComponent(currentServerId)}/${encodeURIComponent(filename)}`);
    const fileData = await fileRes.json();

    if (!fileRes.ok || !fileData.content) {
      alert('Could not load file: ' + (fileData.error || 'not found'));
      return;
    }

    btn.textContent = 'Analyzing...';

    const res  = await fetch('/api/ai/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({
        platformServerId: currentServerId,
        filename,
        fileContent: fileData.content,
      }),
    });
    const data = await res.json();

    if (!res.ok) {
      alert(data.error || 'Analysis failed');
      return;
    }

    renderSuggestions(data.suggestions || []);
    switchTab('suggestions');
  } finally {
    btn.textContent = '🔍 Analyze Now';
    btn.disabled = false;
  }
}

async function openDiffModal(suggestionId) {
  const res  = await fetch(`/api/ai/suggestions/detail/${suggestionId}`);
  const data = await res.json();
  if (!res.ok) return alert('Could not load suggestion');

  activeSuggestion = data;
  document.getElementById('diffTitle').textContent       = `Apply to ${data.filename}`;
  document.getElementById('diffExplanation').textContent = data.explanation;
  document.getElementById('diffContent').textContent     = data.suggested_content || '';
  document.getElementById('diffModal').classList.remove('hidden');
}

function closeDiffModal() {
  document.getElementById('diffModal').classList.add('hidden');
  activeSuggestion = null;
}

async function applySuggestion() {
  if (!activeSuggestion) return;
  const btn = document.getElementById('applyBtn');
  btn.textContent = 'Applying...';
  btn.disabled = true;

  const res  = await fetch(`/api/ai/suggestions/${activeSuggestion.id}/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({}),
  });
  const data = await res.json();

  btn.textContent = '✅ Finalize / Create PR';
  btn.disabled = false;

  if (!res.ok) { alert(data.error); return; }

  closeDiffModal();
  if (data.prUrl) alert(`✅ PR created: ${data.prUrl}`);
  else alert('✅ Suggestion finalized. Use the mission file editor to review and upload it to Nitrado.');
  await loadSuggestions();
}

async function dismissSuggestion(id) {
  await fetch(`/api/ai/suggestions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ status: 'rejected' }),
  });
  await loadSuggestions();
}

/* Quick apply from chat */
function previewApply(content, filename, suggestionId) {
  activeSuggestion = {
    id: suggestionId,
    filename,
    explanation: 'Applied from AI chat',
    suggested_content: content,
  };
  document.getElementById('diffTitle').textContent       = `Apply to ${filename}`;
  document.getElementById('diffExplanation').textContent = 'Review the AI-edited file below, then click Apply.';
  document.getElementById('diffContent').textContent     = content;
  document.getElementById('diffModal').classList.remove('hidden');
}

/* ── GitHub Repo tab ────────────────────────────────────────────────── */
async function loadRepos() {
  const res  = await fetch('/api/ai/repos');
  const data = await res.json();
  if (!res.ok) return;

  const sel = document.getElementById('repoSelect');
  sel.innerHTML = '<option value="">-- Select a repo --</option>';
  (data.repos || []).forEach(r => {
    const opt = document.createElement('option');
    opt.value       = JSON.stringify({ owner: r.owner, name: r.name, default: r.defaultBranch });
    opt.textContent = r.fullName + (r.private ? ' 🔒' : '');
    sel.appendChild(opt);
  });
}

async function loadBranches() {
  const val = document.getElementById('repoSelect').value;
  if (!val) return;
  const { owner, name, default: defaultBranch } = JSON.parse(val);

  const res  = await fetch(`/api/ai/repos/${owner}/${name}/branches`);
  const data = await res.json();
  if (!res.ok) return;

  const sel = document.getElementById('branchSelect');
  sel.innerHTML = '';
  (data.branches || []).forEach(b => {
    const opt = document.createElement('option');
    opt.value       = b;
    opt.textContent = b;
    if (b === defaultBranch) opt.selected = true;
    sel.appendChild(opt);
  });
}

async function loadRepoLink() {
  if (!currentServerId) return;
  const res  = await fetch(`/api/ai/server/${currentServerId}/repo`);
  const data = await res.json();

  if (res.ok && data) {
    document.getElementById('currentRepoDisplay').classList.remove('hidden');
    document.getElementById('noRepoMsg').classList.add('hidden');
    document.getElementById('repoFullName').textContent = `${data.repo_owner}/${data.repo_name}`;
    document.getElementById('repoBranch').textContent   = data.branch;
    document.getElementById('repoBasePath').textContent = data.base_path;
  } else {
    document.getElementById('currentRepoDisplay').classList.add('hidden');
    document.getElementById('noRepoMsg').classList.remove('hidden');
  }
}

async function loadGitHubOperations() {
  const status = document.getElementById('githubOpsStatus');
  const integrationStatus = document.getElementById('githubIntegrationStatus');
  const actionsList = document.getElementById('githubActionsList');
  if (!currentServerId) return;
  status.textContent = 'Loading repository status…';
  integrationStatus.textContent = 'Checking…';
  actionsList.replaceChildren();
  const serverPath = encodeURIComponent(currentServerId);
  try {
    const response = await fetch(`/api/ai/server/${serverPath}/github/integration`);
    const integrationData = await response.json();
    if (!response.ok) {
      integrationStatus.textContent = integrationData.status === 'invalid' ? 'Invalid manifest' : 'Unavailable';
      actionsList.textContent = integrationData.error || integrationData.code || 'GitHub Actions status is currently unavailable.';
      status.textContent = 'Canonical integration status could not be loaded.';
      return;
    }
    const repo = integrationData.repository;
    status.textContent = repo
      ? `${repo.fullName} · ${repo.private ? 'private' : 'public'} · ${integrationData.branch}`
      : 'No canonical GitHub Actions repository is linked to this server.';
    if (!integrationData.installed) {
      integrationStatus.textContent = 'Not installed';
      actionsList.textContent = repo
        ? 'Add dayz-integration.json and the kit workflows to this repository.'
        : 'A server administrator can select the canonical repository below.';
      return;
    }
    integrationStatus.textContent = integrationData.status.replace('_', ' ');
    integrationStatus.className = integrationData.status === 'healthy' ? 'text-green-400' : 'text-yellow-400';
    const rows = (integrationData.actions || []).map(action => {
      const row = document.createElement('div');
      row.className = 'flex justify-between gap-3';
      const name = document.createElement('span');
      name.textContent = action.name;
      const state = document.createElement('span');
      state.textContent = action.status.replace('_', ' ');
      state.className = action.status === 'healthy' ? 'text-green-400' : 'text-yellow-400';
      row.append(name, state);
      return row;
    });
    actionsList.replaceChildren(...rows);
  } catch (_) {
    status.textContent = 'GitHub could not be reached. Check network connectivity and try again.';
    integrationStatus.textContent = 'Unavailable';
  }
}

async function saveRepoLink() {
  if (!currentServerId) return alert('Select a server first');
  const repoVal = document.getElementById('repoSelect').value;
  if (!repoVal) return alert('Select a repo');

  const { owner, name } = JSON.parse(repoVal);
  const branch   = document.getElementById('branchSelect').value;
  const basePath = document.getElementById('basePathInput').value || '/';

  const res = await fetch(`/api/ai/server/${currentServerId}/repo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
    body: JSON.stringify({ repoOwner: owner, repoName: name, branch, basePath }),
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error); return; }

  await loadRepoLink();
  await loadGitHubOperations();
  alert('✅ Repo linked!');
}

async function removeRepoLink() {
  if (!currentServerId) return;
  if (!confirm('Unlink this repo from the server?')) return;
  const res = await fetch(`/api/ai/server/${currentServerId}/repo`, {
    method: 'DELETE',
    headers: { 'X-CSRF-Token': csrfToken },
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || 'Failed to unlink repository');
    return;
  }
  await loadRepoLink();
  await loadGitHubOperations();
}

document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const action = trigger.dataset.action;
  if (action === 'show-connect') showConnectModal();
  else if (action === 'show-ai-provider') showAiProviderModal();
  else if (action === 'connect-ai-provider') connectAiProvider();
  else if (action === 'close-ai-provider') closeAiProviderModal();
  else if (action === 'disconnect-ai-provider') disconnectAiProvider();
  else if (action === 'disconnect-github') disconnectGitHub();
  else if (action === 'switch-tab') switchTab(trigger.dataset.tab);
  else if (action === 'load-file') loadFile();
  else if (action === 'clear-history') clearHistory();
  else if (action === 'send-message') sendMessage();
  else if (action === 'run-analysis') runAnalysis();
  else if (action === 'save-repo-link') saveRepoLink();
  else if (action === 'remove-repo-link') removeRepoLink();
  else if (action === 'connect-pat') connectPAT();
  else if (action === 'close-connect') closeConnectModal();
  else if (action === 'apply-suggestion') applySuggestion();
  else if (action === 'close-diff') closeDiffModal();
  else if (action === 'open-suggestion') openDiffModal(trigger.dataset.suggestionId);
  else if (action === 'dismiss-suggestion') dismissSuggestion(trigger.dataset.suggestionId);
  else if (action === 'preview-apply') {
    const edit = pendingChatEdits.get(trigger.dataset.editKey);
    if (edit?.suggestionId) previewApply(edit.content, edit.filename, edit.suggestionId);
  }
});
document.getElementById('autoCommitToggle').addEventListener('change', saveSettings);
document.getElementById('aiProviderType').addEventListener('change', updateAiProviderFields);
document.getElementById('serverSelect').addEventListener('change', onServerChange);
document.getElementById('repoSelect').addEventListener('change', loadBranches);
document.getElementById('chatInput').addEventListener('keydown', event => {
  if (event.ctrlKey && event.key === 'Enter') sendMessage();
});
init().catch(() => document.getElementById('ghBanner').classList.remove('hidden'));