/* global fetchWithCsrf */

let currentServerId = null;
let activeTab = 'whitelist';

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function loadServers() {
  try {
    const res = await fetch('/api/owner/servers');
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      document.getElementById('serverSelect').innerHTML =
        `<option value="">Error: ${escHtml(err.error || 'Could not load servers (status ' + res.status + ')')}</option>`;
      return;
    }
    const data = await res.json();
    const select = document.getElementById('serverSelect');
    if (data.success && data.servers && data.servers.length > 0) {
      select.innerHTML = '<option value="">— Select a server —</option>' +
        data.servers.map(s => `<option value="${s.id}">${escHtml(s.name)} (${escHtml(s.guildName || '')})</option>`).join('');
    } else {
      select.innerHTML = '<option value="">No servers found — contact your admin</option>';
    }
  } catch (err) {
    console.error('Failed to load servers:', err);
    document.getElementById('serverSelect').innerHTML = '<option value="">Failed to load servers</option>';
  }
}

async function loadList(listType) {
  const container = document.getElementById(`list-${listType}`);
  container.innerHTML = '<p class="text-gray-400">Loading...</p>';
  try {
    const res = await fetch(`/api/owner/servers/${currentServerId}/list/${listType}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    renderList(listType, data.entries);
  } catch (err) {
    container.innerHTML = `<p class="text-red-400">❌ Error: ${escHtml(err.message)}</p>`;
  }
}

function renderList(listType, entries) {
  const container = document.getElementById(`list-${listType}`);
  if (!entries.length) {
    container.innerHTML = '<p class="text-gray-400 italic">List is empty.</p>';
    return;
  }
  container.innerHTML = entries.map(gt => `
    <div class="flex items-center justify-between bg-gray-700 px-4 py-2 rounded border border-gray-600">
      <span class="font-mono">${escHtml(gt)}</span>
      <button data-list-type="${escHtml(listType)}" data-gamertag="${escHtml(gt)}" class="bg-red-600 hover:bg-red-700 px-3 py-1 rounded text-sm">Remove</button>
    </div>
  `).join('');
}

async function addEntry(listType) {
  const input = document.getElementById(`add-${listType}`);
  const gamertag = input.value.trim();
  if (!gamertag) return showToast('❌ Please enter a gamertag', 'red');
  try {
    const res = await fetchWithCsrf(`/api/owner/servers/${currentServerId}/list/${listType}/add`, {
      method: 'POST',
      body: JSON.stringify({ gamertag })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✅ ${data.message}`, 'green');
      input.value = '';
      await loadList(listType);
    } else {
      showToast(`❌ ${data.error}`, 'red');
    }
  } catch (err) {
    showToast(`❌ Error: ${err.message}`, 'red');
  }
}

async function removeEntry(listType, gamertag) {
  try {
    const res = await fetchWithCsrf(`/api/owner/servers/${currentServerId}/list/${listType}/remove`, {
      method: 'POST',
      body: JSON.stringify({ gamertag })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✅ ${data.message}`, 'green');
      await loadList(listType);
    } else {
      showToast(`❌ ${data.error}`, 'red');
    }
  } catch (err) {
    showToast(`❌ Error: ${err.message}`, 'red');
  }
}

function switchTab(listType) {
  ['whitelist', 'blacklist', 'prioritylist'].forEach(t => {
    document.getElementById(`panel-${t}`).classList.add('hidden');
    const btn = document.getElementById(`tab-${t}`);
    btn.className = 'px-4 py-2 rounded font-semibold bg-gray-700 hover:bg-gray-600';
  });
  document.getElementById(`panel-${listType}`).classList.remove('hidden');
  const activeBtn = document.getElementById(`tab-${listType}`);
  const activeClasses = {
    whitelist: 'px-4 py-2 rounded font-semibold bg-green-600 hover:bg-green-700',
    blacklist: 'px-4 py-2 rounded font-semibold bg-red-600 hover:bg-red-700',
    prioritylist: 'px-4 py-2 rounded font-semibold bg-yellow-600 hover:bg-yellow-700'
  };
  activeBtn.className = activeClasses[listType];
  activeTab = listType;
  if (currentServerId) loadList(listType);
}

function showToast(msg, color) {
  const area = document.getElementById('toastArea');
  const toast = document.createElement('span');
  const colorClasses = {
    green: 'border-green-500 text-green-400',
    red: 'border-red-500 text-red-400',
    yellow: 'border-yellow-500 text-yellow-400'
  };
  toast.className = `inline-block bg-gray-700 border ${colorClasses[color] || colorClasses.red} px-4 py-2 rounded mr-2 mb-2 text-sm`;
  toast.textContent = msg;
  area.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

document.addEventListener('DOMContentLoaded', () => {
  // Tab buttons
  document.getElementById('tab-whitelist').addEventListener('click', () => switchTab('whitelist'));
  document.getElementById('tab-blacklist').addEventListener('click', () => switchTab('blacklist'));
  document.getElementById('tab-prioritylist').addEventListener('click', () => switchTab('prioritylist'));

  // Add buttons
  document.querySelector('#panel-whitelist button.bg-green-600').addEventListener('click', () => addEntry('whitelist'));
  document.querySelector('#panel-blacklist button.bg-red-600').addEventListener('click', () => addEntry('blacklist'));
  document.querySelector('#panel-prioritylist button.bg-yellow-600').addEventListener('click', () => addEntry('prioritylist'));

  // Event delegation for remove buttons in dynamically rendered lists
  ['whitelist', 'blacklist', 'prioritylist'].forEach(t => {
    document.getElementById(`list-${t}`).addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-list-type]');
      if (!btn) return;
      removeEntry(btn.dataset.listType, btn.dataset.gamertag);
    });
  });

  // Server selector
  document.getElementById('serverSelect').addEventListener('change', async (e) => {
    currentServerId = e.target.value;
    const section = document.getElementById('listSection');
    if (!currentServerId) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    await loadList(activeTab);
  });

  // Allow pressing Enter to add an entry
  ['whitelist', 'blacklist', 'prioritylist'].forEach(t => {
    document.getElementById(`add-${t}`).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addEntry(t);
    });
  });

  loadServers();
});
