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
  await loadSuggestionGroups();
  await loadRepoLink();
  await loadRepos();
  await loadGitHubOperations();
  await populateFileSelect();
}

/* Shared mission-file fetch: nested synced paths (e.g.
 * dayzOffline.enoch/db/types.xml) must be encoded per segment so the
 * `:fileName(*)` route keeps the slashes. Returns the fetch Response. */
function fetchMissionFile(serverId, filename) {
  const encoded = String(filename || '').split('/').map(encodeURIComponent).join('/');
  return fetch(`/api/mission-files/${encodeURIComponent(serverId)}/${encoded}`);
}

/* Cache of working-copy contents loaded by the Config Intelligence tab so
 * multi-file requests don't re-fetch the same file. Keyed by filename. */
const configFileContents = new Map();

async function loadConfigFileContent(filename) {
  if (configFileContents.has(filename)) return configFileContents.get(filename);
  const res = await fetchMissionFile(currentServerId, filename);
  const data = await res.json();
  if (!res.ok || !data.content) throw new Error(data.error || `could not load ${filename}`);
  configFileContents.set(filename, data.content);
  return data.content;
}

/* Populate the file dropdown from the actual synced working copy (same
 * discovery endpoint the mission editor uses), instead of a hardcoded
 * list of bare filenames that only matches flat server layouts. Fills both
 * the Chat and Analyze selects. */
async function populateFileSelect() {
  configFileContents.clear();
  const sel = document.getElementById('fileNameSelect');
  if (!sel || !currentServerId) return;
  const analyzeSel = document.getElementById('analyzeFileSelect');
  const statusEl = document.getElementById('fileStatus');
  for (const s of [sel, analyzeSel]) if (s) s.innerHTML = '<option value="">Loading files…</option>';
  try {
    const res = await fetch(`/api/mission-files/list/${encodeURIComponent(currentServerId)}`);
    const data = await res.json();
    const files = (data && data.success) ? Object.keys(data.files || {}) : [];
    if (!files.length) {
      for (const s of [sel, analyzeSel]) if (s) s.innerHTML = '<option value="">No files synced yet</option>';
      if (statusEl) statusEl.textContent = 'No working-copy files found for this server. Run "Sync All Server Files" on the dashboard first.';
      return;
    }
    if (statusEl) statusEl.textContent = `✅ ${files.length} synced files available${data.truncated ? ' (discovery truncated)' : ''}`;
    // When the same filename exists in multiple mission folders, group by
    // base name and let the user pick which copy.
    const byName = {};
    for (const fp of files) {
      const base = fp.split('/').pop();
      (byName[base] = byName[base] || []).push(fp);
    }
    const options = [];
    const baseNames = Object.keys(byName).sort((a, b) => a.localeCompare(b));
    for (const base of baseNames) {
      const paths = byName[base].sort();
      for (const fp of paths) {
        options.push({ value: fp, text: paths.length > 1 ? `${base} — ${fp}` : fp });
      }
    }
    for (const s of [sel, analyzeSel]) {
      if (!s) continue;
      s.innerHTML = '<option value="">— Select a file —</option>';
      for (const o of options) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.text;
        s.appendChild(opt);
      }
    }
    populateConfigFilePickers(options);
  } catch (err) {
    for (const s of [sel, analyzeSel]) if (s) s.innerHTML = '<option value="">Failed to list files</option>';
    if (statusEl) statusEl.textContent = '❌ ' + (err.message || 'Could not list synced files');
  }
}

/* ── Tabs ───────────────────────────────────────────────────────────── */
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
  document.getElementById(`tab-${name}`).classList.add('active');
  document.getElementById(`pane-${name}`).classList.remove('hidden');
}

/* ── Log Intelligence (RPT / ADM / crash) ─────────────────────────────
 * The deterministic summary is computed server-side from the ingested files,
 * so the main view needs no AI provider. The "Explain" and "Why at X" buttons
 * optionally layer a grounded AI answer on top (through the provider resolver;
 * the shared router counts against the per-user daily budget). */

function logEl(id) { return document.getElementById(id); }
function logShow(id, visible) { const el = logEl(id); if (el) el.classList[visible ? 'remove' : 'add']('hidden'); }

async function runLogSummary() {
  if (!currentServerId) return;
  logEl('logSummaryBtn').disabled = true;
  logShow('logSummaryPanel', false);
  logEl('logSummaryEmpty').textContent = 'Analyzing ingested RPT/ADM files…';
  try {
    const res = await fetch(`/api/ai/log-summary/${encodeURIComponent(currentServerId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderLogSummary(data.summary || {});
  } catch (err) {
    logShow('logSummaryPanel', false);
    logEl('logSummaryEmpty').innerHTML = `⚠️ ${escHtml(err.message)}`;
  } finally {
    logEl('logSummaryBtn').disabled = false;
  }
}

function renderLogSummary(summary) {
  const empty = logEl('logSummaryEmpty');
  empty.classList.add('hidden');
  logShow('logSummaryPanel', true);

  // CE Loop tick stats
  const ce = summary.ceLoop;
  if (ce) {
    logShow('logCeLoopCard', true);
    logEl('logCeLoopBody').innerHTML =
      `${ce.samples} tick samples · avg ${ce.avgSeconds}s · max ${ce.maxSeconds}s · <span class="${ce.slowSamples > 0 ? 'text-yellow-400' : 'text-gray-400'}">${ce.slowSamples} slow (≥2s)</span>`;
    logEl('logCeLoopSlowest').innerHTML = (ce.slowest || []).map(s =>
      `${escHtml(s.at ? new Date(s.at).toLocaleString() : '?')} — ${s.durationSeconds}s (players=${s.players ?? '?'}, loot=${s.loot ?? '?'}, infected=${s.infected ?? '?'})`).join('<br>');
  } else {
    logShow('logCeLoopCard', false);
  }

  // Crash / restart windows
  const windows = summary.crashWindows || [];
  logShow('logCrashCard', windows.length > 0);
  logEl('logCrashBody').innerHTML = windows.length ? windows.map(w => `
    <div class="bg-gray-900 rounded p-3 text-sm">
      <div class="font-semibold ${w.kind === 'fatal' ? 'text-red-400' : 'text-gray-300'}">${w.kind === 'fatal' ? '💥 Crash' : '🔁 Restart'} — ${escHtml(w.endsAt ? new Date(w.endsAt).toLocaleString() : '?')}</div>
      <div class="text-gray-400 mt-1">${w.rootCauseCandidates && w.rootCauseCandidates.length ? w.rootCauseCandidates.map(c =>
        `<span class="inline-block mr-2">[${escHtml(c.severity)}] ${escHtml(c.title)}</span>`).join('') : '<span class="text-gray-500">No root-cause candidates in window.</span>'}</div>
    </div>`).join('') : '';

  // Repeated warning offenders
  const offenders = summary.repeatedOffenders || [];
  logShow('logOffendersCard', offenders.length > 0);
  logEl('logOffendersBody').innerHTML = offenders.length ? offenders.map(o => `
    <div class="bg-gray-900 rounded p-3 text-sm flex items-start justify-between gap-2">
      <div>
        <span class="${o.actionable ? 'text-yellow-300' : 'text-gray-300'}">${o.actionable ? '⚠️' : '·'} ${escHtml(o.title)}</span>
        <span class="text-gray-500 ml-2 text-xs">[${escHtml(o.severity)}]</span>
        ${o.firstAt ? `<div class="text-gray-500 text-xs mt-1">first seen ${escHtml(new Date(o.firstAt).toLocaleString())}</div>` : ''}
      </div>
      <span class="text-gray-400 font-mono text-xs shrink-0">${o.count}×</span>
    </div>`).join('') : '';
}

async function runLogExplain() {
  if (!currentServerId) return;
  const btn = logEl('logExplainBtn');
  btn.disabled = true;
  logEl('logExplainStatus').textContent = 'Building grounded explanation…';
  logEl('logExplainAnswer').classList.add('hidden');
  try {
    const res = await fetch(`/api/ai/log-summary/${encodeURIComponent(currentServerId)}/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: logEl('logQuestionInput').value || undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.summary) renderLogSummary(data.summary);
    if (data.aiExplanation) {
      logEl('logExplainAnswer').textContent = data.aiExplanation;
      logEl('logExplainAnswer').classList.remove('hidden');
      logEl('logExplainStatus').textContent = data.source ? `AI (${data.source})` : 'AI';
    } else if (data.summary && data.summary.aiError) {
      logEl('logExplainStatus').innerHTML = `⚠️ AI unavailable: ${escHtml(data.summary.aiError)}`;
    } else {
      logEl('logExplainStatus').textContent = 'No AI provider connected — the deterministic summary above is the full analysis.';
    }
  } catch (err) {
    logEl('logExplainStatus').innerHTML = `⚠️ ${escHtml(err.message)}`;
  } finally {
    btn.disabled = false;
  }
}

async function runLogWhy() {
  if (!currentServerId) return;
  const atValue = logEl('logWhyAtInput').value;
  if (!atValue) {
    logEl('logWhyStatus').textContent = 'Pick a moment (date/time) first.';
    return;
  }
  const atMs = new Date(`${atValue}:00`).getTime();
  if (!Number.isFinite(atMs)) {
    logEl('logWhyStatus').textContent = 'Could not parse the moment.';
    return;
  }
  const btn = logEl('logWhyBtn');
  btn.disabled = true;
  logEl('logWhyStatus').textContent = 'Correlating RPT + ADM evidence around that moment…';
  logEl('logWhyAnswer').classList.add('hidden');
  try {
    const res = await fetch(`/api/ai/log-why/${encodeURIComponent(currentServerId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ atMs }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderLogWhy(data.analysis || {}, data.source);
  } catch (err) {
    logEl('logWhyStatus').innerHTML = `⚠️ ${escHtml(err.message)}`;
  } finally {
    btn.disabled = false;
  }
}

function renderLogWhy(a, source) {
  const parts = [];
  const tick = a.tickWindow || [];
  if (a.tickSamples > 0) {
    parts.push(`<p class="mb-2"><strong>${a.tickSamples}</strong> tick samples in window · ${a.warningsInWindow} warnings.</p>`);
    if (tick.length) {
      parts.push('<ul class="list-disc list-inside text-xs text-gray-400 mb-2">' + tick.map(t =>
        `<li>${escHtml(t.at ? new Date(t.at).toLocaleString() : '?')} — ${t.durationSeconds}s (players=${t.players ?? '?'}, loot=${t.loot ?? '?'}, infected=${t.infected ?? '?'})</li>`).join('') + '</ul>');
    }
  }
  const causes = a.rootCauseCandidates || [];
  if (causes.length) {
    parts.push('<p class="font-semibold mb-1">Root-cause candidates:</p><ul class="list-disc list-inside text-xs text-gray-300">' +
      causes.map(c => `<li>[${escHtml(c.severity)}] ${escHtml(c.title)}${c.evidence ? ` — ${escHtml(c.evidence)}` : ''}</li>`).join('') + '</ul>');
  }
  const dbEv = a.dbEvidence;
  if (dbEv && dbEv.ceLoopRows && dbEv.ceLoopRows.length) {
    parts.push(`<p class="text-xs text-gray-500 mt-2">ADM DB: ${dbEv.ceLoopRows.length} CE-Loop events${dbEv.killsInWindow != null ? ` · ${dbEv.killsInWindow} kills` : ''}${dbEv.deathsInWindow != null ? ` · ${dbEv.deathsInWindow} deaths` : ''} in window.</p>`);
  }
  if (a.aiExplanation) {
    parts.push('<div class="mt-3 text-xs text-purple-200 bg-gray-950 rounded p-2 whitespace-pre-wrap">' + escHtml(a.aiExplanation) + '</div>');
  } else if (a.aiError) {
    parts.push(`<p class="text-xs text-gray-500 mt-2">⚠️ AI prose unavailable: ${escHtml(a.aiError)}</p>`);
  } else if (!causes.length && !tick.length) {
    parts.push('<p class="text-xs text-gray-500 mt-2">No correlated evidence found near this moment — try a different time or ingest more logs.</p>');
  }
  logEl('logWhyAnswer').innerHTML = parts.join('') || '<p class="text-gray-500">No evidence found.</p>';
  logEl('logWhyAnswer').classList.remove('hidden');
  logEl('logWhyStatus').textContent = source ? `AI (${source})` : 'Deterministic correlation';
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
    // Use the mission files API to download the file content.
    const res  = await fetchMissionFile(currentServerId, filename);
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
            ${s.diff_explanation ? `<p class="text-xs text-teal-400 mt-1">📝 ${escHtml(s.diff_explanation)}</p>` : ''}
            ${s.group_id ? `<p class="text-xs text-gray-600 mt-1">part of multi-file edit group #${s.group_id}</p>` : ''}
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
    const fileRes  = await fetchMissionFile(currentServerId, filename);
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
  renderDiffExplanationPanel(data.diff_explanation);
  document.getElementById('diffModal').classList.remove('hidden');
}

function renderDiffExplanationPanel(text) {
  const panel = document.getElementById('diffExplanationPanel');
  if (!panel) return;
  if (text) {
    document.getElementById('diffExplanationText').textContent = text;
    panel.classList.remove('hidden');
  } else {
    panel.classList.add('hidden');
  }
}

async function refreshDiffExplain() {
  if (!activeSuggestion || !activeSuggestion.id) return;
  const btn = document.getElementById('refreshDiffExplainBtn');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const res = await fetch(`/api/ai/suggestions/${activeSuggestion.id}/diff-explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'diff-explain failed');
    activeSuggestion.diff_explanation = data.diffExplanation;
    renderDiffExplanationPanel(data.diffExplanation);
  } catch (err) {
    alert(err.message || 'Could not generate a plain-language delta.');
  } finally {
    if (btn) { btn.textContent = 'Refresh'; btn.disabled = false; }
  }
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

/* ── Config Intelligence (multi-file edits, balance pass, validation) ──
 * The provider returns small per-file patches which the backend validates
 * against the real working copy before storing anything. Files are loaded
 * here and sent whole with each request (same convention as /chat). */

const CONFIG_BASENAMES = new Set([
  'types.xml', 'events.xml', 'globals.xml', 'economy.xml',
  'randompresets.xml', 'cfgspawnabletypes.xml', 'cfgevents.xml',
]);

/** Curate the synced file list down to the files a config-intelligence
 * request plausibly targets (known DayZ config basenames + any JSON). */
function configCandidateFiles(optionTexts) {
  return optionTexts.filter(o => {
    const base = o.value.split('/').pop().toLowerCase();
    return base.endsWith('.json') || CONFIG_BASENAMES.has(base);
  });
}

function buildFilePicker(containerId, optionTexts, { max } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  const all = optionTexts.map(o => o.value);
  if (!all.length) {
    const span = document.createElement('span');
    span.className = 'text-xs text-gray-500';
    span.textContent = 'No config files synced yet (look for types.xml / events.xml / randompresets.xml / *.json).';
    container.appendChild(span);
    return;
  }
  all.forEach((value, index) => {
    const wrapper = document.createElement('label');
    wrapper.className = 'flex items-center gap-1 bg-gray-700 border border-gray-600 rounded px-2 py-1 text-xs text-gray-300 cursor-pointer';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = value;
    checkbox.dataset.fileIndex = String(index);
    wrapper.appendChild(checkbox);
    const span = document.createElement('span');
    span.textContent = value;
    wrapper.appendChild(span);
    container.appendChild(wrapper);
  });
  if (max && max < all.length) {
    const note = document.createElement('span');
    note.className = 'text-xs text-gray-500 self-center';
    note.textContent = `pick at most ${max}`;
    container.appendChild(note);
  }
}

function selectedConfigFiles(containerId, { max = 5 } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return [];
  return [...container.querySelectorAll('input[type="checkbox"]:checked')]
    .slice(0, max)
    .map(box => box.value)
    .filter(Boolean);
}

function renderSuggestionCards(targetId, statusId, suggestions, errorText) {
  const status = document.getElementById(statusId);
  const target = document.getElementById(targetId);
  if (status) status.textContent = errorText || '';
  if (!target) return;
  if (!suggestions || !suggestions.length) {
    target.classList.add('hidden');
    target.innerHTML = '';
    return;
  }
  target.classList.remove('hidden');
  target.innerHTML = suggestions.map(s => `
    <div class="bg-gray-900 border border-gray-700 rounded p-3">
      <div class="flex items-center gap-2 mb-1">
        <span class="font-mono text-xs text-blue-300">${escHtml(s.filename)}</span>
        <span class="text-xs text-gray-500">${escHtml(s.diff_summary || '')}</span>
      </div>
      <p class="text-sm text-gray-300">${escHtml(s.explanation || '')}</p>
      ${s.diff_explanation ? `<p class="text-xs text-gray-500 mt-1">${escHtml(s.diff_explanation)}</p>` : ''}
      <p class="text-xs text-gray-500 mt-1">Saved as suggestion #${s.id} — apply it from the 💡 Suggestions tab.</p>
    </div>`).join('');
}

async function collectConfigFiles(containerId, btn, btnLabel, max = 5) {
  const filenames = selectedConfigFiles(containerId, { max });
  if (!currentServerId) throw new Error('Select a server first');
  if (!filenames.length) throw new Error('Pick at least one file to include');
  btn.disabled = true;
  try {
    const files = [];
    for (const filename of filenames) {
      const fileContent = await loadConfigFileContent(filename);
      files.push({ filename, fileContent });
    }
    return files;
  } finally {
    btn.disabled = false;
  }
}

async function runConfigEdit() {
  const btn = document.getElementById('configEditBtn');
  const instruction = (document.getElementById('configEditInstruction').value || '').trim();
  if (!instruction) return alert('Describe the edit you want made across the selected files.');
  let files;
  try {
    btn.textContent = 'Loading files…';
    files = await collectConfigFiles('configFilePicker', btn, 'Run edit', 5);
  } catch (err) {
    return renderSuggestionCards('configEditResult', 'configEditStatus', [], err.message || 'Could not load files');
  }
  try {
    btn.textContent = 'Thinking…';
    const res = await fetch('/api/ai/config-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ platformServerId: currentServerId, instruction, files }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Multi-file edit failed');
    renderSuggestionCards('configEditResult', 'configEditStatus', data.suggestions,
      `✅ ${data.suggestions.length} validated patch suggestion(s) saved (group #${data.groupId}).`);
    await loadSuggestions();
  } catch (err) {
    renderSuggestionCards('configEditResult', 'configEditStatus', [],
      `❌ ${err.message}${err.fileErrors ? ` — ${err.fileErrors.map(f => `${f.file}: ${f.message}`).join('; ')}` : ''}`);
  } finally {
    btn.textContent = 'Run edit';
  }
}

async function runBalancePass() {
  const btn = document.getElementById('balanceBtn');
  const goal = (document.getElementById('balanceGoal').value || '').trim();
  if (!goal) return alert('Give a balance goal, e.g. "make early game harder".');
  let files;
  try {
    btn.textContent = 'Loading files…';
    files = await collectConfigFiles('balanceFilePicker', btn, 'Run pass', 4);
  } catch (err) {
    return renderSuggestionCards('balanceResult', 'balanceStatus', [], err.message || 'Could not load files');
  }
  try {
    btn.textContent = 'Planning…';
    const res = await fetch('/api/ai/balance-pass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ platformServerId: currentServerId, goal, files }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Balance pass failed');
    renderSuggestionCards('balanceResult', 'balanceStatus', data.suggestions,
      `✅ ${data.suggestions.length} coordinated patch suggestion(s) saved (group #${data.groupId}).`);
    await loadSuggestions();
  } catch (err) {
    renderSuggestionCards('balanceResult', 'balanceStatus', [],
      `❌ ${err.message}${err.fileErrors ? ` — ${err.fileErrors.map(f => `${f.file}: ${f.message}`).join('; ')}` : ''}`);
  } finally {
    btn.textContent = 'Run pass';
  }
}

async function runConfigValidate() {
  const btn = document.getElementById('validateBtn');
  const statusEl = document.getElementById('validateStatus');
  const resultEl = document.getElementById('validateResult');
  const filenames = selectedConfigFiles('validateFilePicker', { max: 1 });
  if (!currentServerId) return alert('Select a server first');
  if (!filenames.length) return alert('Pick the file to validate.');
  const filename = filenames[0];
  try {
    btn.textContent = 'Loading file…';
    const fileContent = await loadConfigFileContent(filename);
    btn.textContent = 'Validating…';
    const res = await fetch('/api/ai/config-validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({
        platformServerId: currentServerId,
        filename,
        fileContent,
        question: document.getElementById('validateQuestion').value || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Validation failed');
    statusEl.textContent = data.valid
      ? `✅ ${filename} is valid (${(data.findings || []).length} note(s))`
      : `⚠️ ${filename} has ${data.findings.filter(f => f.severity === 'error').length} error finding(s)`;
    resultEl.classList.remove('hidden');
    resultEl.innerHTML =
      (data.findings || []).map(f => {
        const color = f.severity === 'error' ? 'text-red-400' : f.severity === 'warning' ? 'text-yellow-400' : 'text-gray-400';
        return `<p class="text-sm ${color}"><span class="font-mono">${escHtml(f.code)}</span> — ${escHtml(f.message)}</p>`;
      }).join('')
      + (data.aiExplanation ? `<div class="bg-gray-900 rounded p-3 text-sm text-gray-200 mt-2 whitespace-pre-wrap"><strong>AI:</strong> ${escHtml(data.aiExplanation)}</div>`
        : '<p class="text-xs text-gray-500 mt-2">No AI explanation — no provider configured, or the provider call failed.</p>');
  } catch (err) {
    statusEl.textContent = `❌ ${err.message}`;
    resultEl.classList.add('hidden');
  } finally {
    btn.textContent = 'Validate';
  }
}

async function loadSuggestionGroups() {
  if (!currentServerId) return;
  const list = document.getElementById('configGroupsList');
  try {
    const res = await fetch(`/api/ai/suggestion-groups/${encodeURIComponent(currentServerId)}?limit=10`);
    const data = await res.json();
    const groups = data.groups || [];
    if (!groups.length) {
      list.innerHTML = '<p class="text-gray-500 text-center py-4">No multi-file edit groups yet.</p>';
      return;
    }
    list.innerHTML = groups.map(g => `
      <div class="bg-gray-900 border border-gray-700 rounded p-3">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-xs text-gray-400">#${g.id}</span>
          <span class="text-xs ${g.kind === 'balance' ? 'text-teal-400' : 'text-blue-400'}">${escHtml(g.kind)}</span>
          <span class="text-xs text-gray-500">${new Date(g.created_at).toLocaleString()}</span>
          ${g.goal ? `<span class="text-xs text-gray-400 truncate">— ${escHtml(g.goal)}</span>` : ''}
        </div>
        ${g.suggestions.map(s => `
          <div class="flex items-center gap-2 text-xs">
            <span class="font-mono text-blue-300">${escHtml(s.filename)}</span>
            <span class="text-gray-500">${s.status}</span>
            <span class="text-gray-400 truncate flex-1">${escHtml(s.explanation || '')}</span>
            ${s.diff_explanation ? `<span class="text-gray-600 truncate max-w-[300px]" title="${escHtml(s.diff_explanation)}">${escHtml(s.diff_explanation)}</span>` : ''}
          </div>`).join('')}
      </div>`).join('');
  } catch (_err) {
    list.innerHTML = '<p class="text-red-400 text-center py-4 text-sm">Could not load groups.</p>';
  }
}

function populateConfigFilePickers(options) {
  const candidates = configCandidateFiles(options);
  buildFilePicker('configFilePicker', candidates, { max: 5 });
  buildFilePicker('balanceFilePicker', candidates, { max: 4 });
  buildFilePicker('validateFilePicker', candidates, {});
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
  else if (action === 'refresh-diff-explain') refreshDiffExplain();
  else if (action === 'dismiss-suggestion') dismissSuggestion(trigger.dataset.suggestionId);
  else if (action === 'run-log-summary') runLogSummary();
  else if (action === 'run-log-explain') runLogExplain();
  else if (action === 'run-log-why') runLogWhy();
  else if (action === 'run-config-edit') runConfigEdit();
  else if (action === 'run-balance-pass') runBalancePass();
  else if (action === 'run-config-validate') runConfigValidate();
  else if (action === 'reload-suggestion-groups') loadSuggestionGroups();
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