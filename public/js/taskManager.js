/*
 * public/js/taskManager.js
 *
 * Client-side module for the Scheduled Task Manager page (/dashboard/tasks).
 * Handles: loading servers, listing tasks, creating/editing/deleting tasks.
 *
 * API endpoints used:
 *   GET  /api/tasks/:serverId/list  — available task types
 *   GET  /api/tasks/:serverId       — current tasks
 *   POST /api/tasks/:serverId       — create task
 *   PUT  /api/tasks/:serverId/:id   — update task
 *   DELETE /api/tasks/:serverId/:id — delete task
 */

let currentServerId = null;
let csrfToken = null;
const renderedTasks = new Map();

// Read the CSRF token injected by the server into the page's <meta> tag
async function initCsrf() {
  const response = await fetch('/api/csrf-token');
  const data = await response.json();
  csrfToken = data.csrfToken;
  if (!response.ok || !csrfToken) throw new Error('Could not initialize request protection');
}

// Populate the server dropdown using the registered-servers endpoint
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

async function onServerChange() {
  const select = document.getElementById('serverSelect');
  currentServerId = select.value || null;
  if (!currentServerId) {
    document.getElementById('tasksTableWrap').innerHTML = '<p class="text-gray-400">Select a server to view tasks.</p>';
    document.getElementById('taskType').innerHTML = '<option value="">Select a server first…</option>';
    return;
  }
  await Promise.all([loadTasks(), loadTaskTypes()]);
}

// Load available task types for the dropdown
async function loadTaskTypes() {
  if (!currentServerId) return;
  const select = document.getElementById('taskType');
  select.innerHTML = '<option value="">Loading…</option>';
  try {
    const res = await fetch(`/api/tasks/${currentServerId}/list`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    const types = data.tasks;
    if (!types.length) {
      select.innerHTML = '<option value="">No task types available</option>';
      return;
    }
    select.innerHTML = types.map(t =>
      `<option value="${escHtml(t.action_method || t)}">${escHtml(t.action_method || t)}</option>`
    ).join('');
    // Default to the first restart-like type if present
    const restartType = types.find(t => (t.action_method || t).toLowerCase().includes('restart'));
    if (restartType) select.value = restartType.action_method || restartType;
  } catch (err) {
    select.innerHTML = '<option value="">Could not load task types</option>';
    showBanner('Could not load task types: ' + err.message, 'error');
  }
}

// Load and render the current task list
async function loadTasks() {
  if (!currentServerId) return;
  const wrap = document.getElementById('tasksTableWrap');
  wrap.innerHTML = '<p class="text-gray-400 animate-pulse">Loading tasks…</p>';
  try {
    const res = await fetch(`/api/tasks/${currentServerId}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    renderTasksTable(data.tasks);
  } catch (err) {
    wrap.innerHTML = `<p class="text-red-400">Error: ${escHtml(err.message)}</p>`;
  }
}

function renderTasksTable(tasks) {
  const wrap = document.getElementById('tasksTableWrap');
  renderedTasks.clear();
  if (!tasks.length) {
    wrap.innerHTML = '<p class="text-gray-400">No scheduled tasks. Add one below.</p>';
    return;
  }

  const rows = tasks.map(t => {
    renderedTasks.set(String(t.id), t);
    const schedule = `${t.minute} ${t.hour} ${t.day} ${t.month} ${t.weekday}`;
    const statusBadge = t.status === 'error'
      ? '<span class="bg-red-600 text-white text-xs px-2 py-0.5 rounded ml-2" title="Task errored — delete and re-create to fix">⚠ error</span>'
      : '<span class="bg-green-700 text-white text-xs px-2 py-0.5 rounded ml-2">active</span>';
    const nextRun = t.next_run ? new Date(t.next_run * 1000).toLocaleString() : '—';
    const lastRun = t.last_run ? new Date(t.last_run * 1000).toLocaleString() : '—';

    return `
      <tr class="border-b border-gray-700">
        <td class="py-3 px-4 font-mono text-sm">${escHtml(schedule)}</td>
        <td class="py-3 px-4 text-sm">${escHtml(t.action_method || '—')} ${statusBadge}</td>
        <td class="py-3 px-4 text-sm text-gray-300">${escHtml(nextRun)}</td>
        <td class="py-3 px-4 text-sm text-gray-300">${escHtml(lastRun)}</td>
        <td class="py-3 px-4 flex gap-2">
          <button data-task-action="edit" data-task-id="${escHtml(t.id)}"
            class="bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded text-xs">Edit</button>
          <button data-task-action="delete" data-task-id="${escHtml(t.id)}"
            class="bg-red-600 hover:bg-red-700 px-3 py-1 rounded text-xs">Delete</button>
        </td>
      </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="overflow-x-auto">
      <table class="w-full text-left">
        <thead>
          <tr class="text-gray-400 text-sm border-b border-gray-700">
            <th class="pb-2 px-4">Cron Schedule</th>
            <th class="pb-2 px-4">Type</th>
            <th class="pb-2 px-4">Next Run</th>
            <th class="pb-2 px-4">Last Run</th>
            <th class="pb-2 px-4">Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// Save — handles both create and update
async function saveTask() {
  if (!currentServerId) return showBanner('Please select a server first.', 'error');

  const taskId = document.getElementById('editTaskId').value.trim();
  const minute   = document.getElementById('taskMinute').value.trim() || '0';
  const hour     = document.getElementById('taskHour').value.trim() || '*';
  const day      = document.getElementById('taskDay').value.trim() || '*';
  const month    = document.getElementById('taskMonth').value.trim() || '*';
  const weekday  = document.getElementById('taskWeekday').value.trim() || '*';
  const action_method = document.getElementById('taskType').value;

  if (!action_method) return showBanner('Please select a task type.', 'error');

  const url = taskId
    ? `/api/tasks/${currentServerId}/${taskId}`
    : `/api/tasks/${currentServerId}`;
  const method = taskId ? 'PUT' : 'POST';

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'CSRF-Token': csrfToken },
      body: JSON.stringify({ minute, hour, day, month, weekday, action_method })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    showBanner(data.message || (taskId ? 'Task updated.' : 'Task created.'), 'success');
    cancelEdit();
    loadTasks();
  } catch (err) {
    showBanner('Error: ' + err.message, 'error');
  }
}

async function deleteTask(taskId) {
  if (!currentServerId) return;
  if (!confirm('Delete this task?')) return;
  try {
    const res = await fetch(`/api/tasks/${currentServerId}/${taskId}`, {
      method: 'DELETE',
      headers: { 'CSRF-Token': csrfToken }
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    showBanner(data.message || 'Task deleted.', 'success');
    loadTasks();
  } catch (err) {
    showBanner('Error: ' + err.message, 'error');
  }
}

// Populate the form fields for editing an existing task
function startEdit(task) {
  document.getElementById('editTaskId').value = task.id;
  document.getElementById('taskMinute').value  = task.minute  ?? '0';
  document.getElementById('taskHour').value    = task.hour    ?? '*';
  document.getElementById('taskDay').value     = task.day     ?? '*';
  document.getElementById('taskMonth').value   = task.month   ?? '*';
  document.getElementById('taskWeekday').value = task.weekday ?? '*';
  document.getElementById('taskType').value    = task.action_method || '';
  document.getElementById('formTitle').textContent = '✏️ Edit Task';
  document.getElementById('cancelEditBtn').classList.remove('hidden');
  document.getElementById('saveBtn').textContent = 'Update Task';
  document.getElementById('saveBtn').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function cancelEdit() {
  document.getElementById('editTaskId').value = '';
  document.getElementById('taskMinute').value  = '0';
  document.getElementById('taskHour').value    = '*';
  document.getElementById('taskDay').value     = '*';
  document.getElementById('taskMonth').value   = '*';
  document.getElementById('taskWeekday').value = '*';
  document.getElementById('formTitle').textContent = '➕ Add Task';
  document.getElementById('cancelEditBtn').classList.add('hidden');
  document.getElementById('saveBtn').textContent = 'Save Task';
}

// Apply a quick preset to the hour/minute fields
function applyPreset(hour, minute) {
  document.getElementById('taskHour').value   = hour;
  document.getElementById('taskMinute').value = minute;
  document.getElementById('taskDay').value    = '*';
  document.getElementById('taskMonth').value  = '*';
  document.getElementById('taskWeekday').value = '*';
}

function showBanner(msg, type) {
  const el = document.getElementById('statusBanner');
  el.textContent = msg;
  el.className = type === 'success'
    ? 'mb-4 p-4 rounded-lg text-sm bg-green-800 text-green-100'
    : 'mb-4 p-4 rounded-lg text-sm bg-red-800 text-red-100';
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

// Escape HTML to prevent XSS when inserting task data into the DOM
function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Init
(async () => {
  document.getElementById('refreshBtn').addEventListener('click', loadTasks);
  document.getElementById('saveBtn').addEventListener('click', saveTask);
  document.getElementById('cancelEditBtn').addEventListener('click', cancelEdit);
  document.addEventListener('click', event => {
    const preset = event.target.closest('button[data-preset-hour]');
    if (preset) applyPreset(preset.dataset.presetHour, preset.dataset.presetMinute);
  });
  document.getElementById('tasksTableWrap').addEventListener('click', event => {
    const button = event.target.closest('button[data-task-action]');
    if (!button) return;
    const task = renderedTasks.get(button.dataset.taskId);
    if (!task) return;
    if (button.dataset.taskAction === 'edit') startEdit(task);
    else deleteTask(task.id);
  });
  await Promise.all([initCsrf(), loadServers()]);
})();
