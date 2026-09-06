/*
 * public/js/serverStats.js
 *
 * Client-side module for the Server Stats page (/dashboard/server-stats).
 * Fetches downsampled timeseries from the backend and renders two Chart.js charts:
 *   1. Player count over time
 *   2. CPU % and Memory % over time
 */

let currentServerId = null;
let selectedHours = 24;
let playerChart = null;
let resourceChart = null;

// Escape HTML to prevent XSS when building dynamic content
function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function showBanner(msg, type = 'error') {
  const el = document.getElementById('statusBanner');
  el.className = `mb-4 p-4 rounded-lg text-sm ${type === 'error' ? 'bg-red-900 text-red-200 border border-red-700' : 'bg-blue-900 text-blue-200 border border-blue-700'}`;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideBanner() {
  document.getElementById('statusBanner').classList.add('hidden');
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
  currentServerId = document.getElementById('serverSelect').value || null;
  if (!currentServerId) {
    document.getElementById('chartsWrap').classList.add('hidden');
    document.getElementById('emptyState').classList.remove('hidden');
    return;
  }
  await loadStats();
}

// Highlight the active range button
function setActiveRange(hours) {
  selectedHours = hours;
  document.querySelectorAll('.range-btn').forEach(btn => {
    const active = parseInt(btn.dataset.hours) === hours;
    btn.className = `range-btn px-3 py-2 rounded text-sm ${active ? 'bg-blue-600 font-semibold' : 'bg-gray-700 hover:bg-gray-600'}`;
  });
}

// Destroy old chart instances before re-creating to avoid canvas reuse warnings
function destroyCharts() {
  if (playerChart)   { playerChart.destroy();   playerChart = null; }
  if (resourceChart) { resourceChart.destroy(); resourceChart = null; }
}

async function loadStats() {
  if (!currentServerId) return;
  hideBanner();

  document.getElementById('chartsWrap').classList.add('hidden');
  document.getElementById('emptyState').textContent = '⏳ Loading statistics…';
  document.getElementById('emptyState').classList.remove('hidden');

  try {
    const res = await fetch(`/api/stats/${currentServerId}?hours=${selectedHours}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    renderCharts(data);
  } catch (err) {
    showBanner(`Failed to load stats: ${err.message}`);
    document.getElementById('emptyState').textContent = 'Could not load statistics for this server.';
  }
}

// Shared Chart.js default styles
const GRID_COLOR  = 'rgba(255,255,255,0.07)';
const TICK_COLOR  = '#9ca3af';
const BASE_OPTS = {
  responsive: true,
  plugins: { legend: { labels: { color: '#e5e7eb' } } },
  scales: {
    x: {
      ticks: { color: TICK_COLOR, maxTicksLimit: 10, maxRotation: 0 },
      grid:  { color: GRID_COLOR },
    },
  },
};

function renderCharts(data) {
  destroyCharts();
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('chartsWrap').classList.remove('hidden');

  const labels = data.labels || [];

  // --- Player count chart ---
  playerChart = new Chart(document.getElementById('playerChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Players',
          data: data.players,
          borderColor: '#34d399',
          backgroundColor: 'rgba(52,211,153,0.15)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
        },
        {
          label: 'Max Slots',
          data: data.maxPlayers,
          borderColor: '#6b7280',
          borderDash: [5, 5],
          fill: false,
          tension: 0,
          pointRadius: 0,
        },
      ],
    },
    options: {
      ...BASE_OPTS,
      scales: {
        ...BASE_OPTS.scales,
        y: {
          min: 0,
          ticks: { color: TICK_COLOR, precision: 0 },
          grid:  { color: GRID_COLOR },
          title: { display: true, text: 'Players', color: TICK_COLOR },
        },
      },
    },
  });

  // --- CPU + Memory chart ---
  resourceChart = new Chart(document.getElementById('resourceChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'CPU %',
          data: data.cpu,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,0.1)',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
        },
        {
          label: 'Memory %',
          data: data.memory,
          borderColor: '#818cf8',
          backgroundColor: 'rgba(129,140,248,0.1)',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
        },
      ],
    },
    options: {
      ...BASE_OPTS,
      scales: {
        ...BASE_OPTS.scales,
        y: {
          min: 0,
          max: 100,
          ticks: { color: TICK_COLOR, callback: v => v + '%' },
          grid:  { color: GRID_COLOR },
          title: { display: true, text: 'Usage %', color: TICK_COLOR },
        },
      },
    },
  });
}

// Wire up time-range buttons
document.querySelectorAll('.range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    setActiveRange(parseInt(btn.dataset.hours));
    if (currentServerId) loadStats();
  });
});

loadServers();
