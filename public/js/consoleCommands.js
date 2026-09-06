/*
 * public/js/consoleCommands.js
 *
 * Client-side module for the Console page (/dashboard/console).
 * Lets the user send commands to the Nitrado gameserver and see the response.
 *
 * API endpoint used:
 *   POST /api/console/:serverId/command  — body: { command }
 *
 * Note: Xbox servers may not support console commands via the Nitrado API.
 */

let currentServerId = null;
let csrfToken = '';

// Read CSRF token injected by the server into the page's <meta> tag
function initCsrf() {
  csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
}

function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

// Populate the server dropdown
async function loadServers() {
  const select = document.getElementById('serverSelect');
  try {
    const res = await fetch('/api/nitrado/registered-servers');
    const data = await res.json();
    if (!data.success || !data.servers?.length) {
      select.innerHTML = '<option value="">No servers found</option>';
      return;
    }
    select.innerHTML = '<option value="">— Pick a server —</option>' +
      data.servers.map(s => `<option value="${s.id}">${escHtml(s.server_name)} (${s.platform})</option>`).join('');
    select.addEventListener('change', onServerChange);
  } catch (err) {
    select.innerHTML = '<option value="">Error loading servers</option>';
    console.error('loadServers error:', err);
  }
}

function onServerChange() {
  currentServerId = document.getElementById('serverSelect').value || null;
  const wrap = document.getElementById('consoleWrap');
  if (currentServerId) {
    wrap.classList.remove('hidden');
    document.getElementById('commandInput').focus();
  } else {
    wrap.classList.add('hidden');
  }
}

// Append a line to the output log panel
function appendOutput(text, type = 'normal') {
  const log = document.getElementById('outputLog');

  // Remove the placeholder message if present
  const placeholder = log.querySelector('.text-gray-500');
  if (placeholder) placeholder.remove();

  const color = type === 'error' ? 'text-red-400' : type === 'success' ? 'text-green-400' : 'text-gray-300';
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const div = document.createElement('div');
  div.className = color;
  div.innerHTML = `<span class="text-gray-500 text-xs mr-2">[${time}]</span>${escHtml(text)}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function sendCommand() {
  const input = document.getElementById('commandInput');
  const btn   = document.getElementById('sendBtn');
  const cmd   = input.value.trim();

  if (!cmd || !currentServerId) return;

  input.disabled = true;
  btn.disabled   = true;
  btn.textContent = '…';

  appendOutput(`> ${cmd}`, 'normal');

  try {
    const res = await fetch(`/api/console/${currentServerId}/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CSRF-Token': csrfToken },
      body: JSON.stringify({ command: cmd }),
    });
    const data = await res.json();
    if (data.success) {
      appendOutput(data.message || 'Command sent.', 'success');
    } else {
      appendOutput(`Error: ${data.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    appendOutput(`Network error: ${err.message}`, 'error');
  } finally {
    input.disabled = false;
    btn.disabled   = false;
    btn.textContent = '▶ Send';
    input.value = '';
    input.focus();
  }
}

// Wire up send button and Enter key
document.getElementById('sendBtn').addEventListener('click', sendCommand);
document.getElementById('commandInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendCommand();
});

// Wire up quick-command buttons
document.querySelectorAll('.quick-cmd').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('commandInput').value = btn.dataset.cmd;
    document.getElementById('commandInput').focus();
  });
});

// Wire up clear button
document.getElementById('clearBtn').addEventListener('click', () => {
  document.getElementById('outputLog').innerHTML =
    '<p class="text-gray-500">— no output yet —</p>';
});

initCsrf();
loadServers();
