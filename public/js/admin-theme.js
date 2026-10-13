'use strict';

/* eslint-env browser */
/*
 * Theme settings (B1.2, upgraded by card 2/9) — public/admin/theme.html.
 *
 * Loads the approved guilds, fetches the selected guild's theme settings,
 * and renders the editor:
 *   - Guild default base theme (livonia | chernarus | sakhal | nasadra |
 *     high-contrast — the 5 approved base themes).
 *   - Per-pack holiday opt-ins (card 2/9: packs are opt-in per guild, NOT
 *     auto-active for everyone). Each pack applies automatically during its
 *     window; the built-in window is shown per pack.
 *   - Legacy single-select holiday pack (B1.2) + override window — kept so
 *     older settings keep working.
 *   - Per-guild accent override (presets + custom hex; B1.2 mechanism,
 *     works on top of everything).
 *   - Personal override: the logged-in admin's own theme (users.theme_preference),
 *     saved via PUT /api/theme.
 * A live preview applies the server-computed override CSS to a scoped
 * container so the admin sees the exact result before/after saving.
 */

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function metaToken() {
  const el = document.querySelector('meta[name="csrf-token"]');
  return el ? el.getAttribute('content') : '';
}

function apiFetch(url, options = {}) {
  options.headers = Object.assign({}, options.headers, { 'X-CSRF-Token': metaToken() });
  return fetch(url, options).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok && !data.success) {
        throw new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
      }
      return data;
    });
  });
}

const BASE_THEMES = [
  { value: 'livonia', label: 'Livonia — TTsKO Forest (default)' },
  { value: 'chernarus', label: 'Chernarus — U.S. Woodland' },
  { value: 'sakhal', label: 'Sakhal — Digital Winter (light)' },
  { value: 'nasadra', label: 'Nasadra — Desert MultiCam' },
  { value: 'high-contrast', label: 'High contrast (accessibility)' },
];
const ACCENT_PRESETS = ['#8a9a5b', '#b3a36a', '#e2762d', '#67c7e8', '#e86a92', '#a3e635'];
let currentGuildId = '';

let cachedPacks = null; // [{name, label, window}] from /api/theme/packs

function loadGuilds() {
  return apiFetch('/api/admin/guilds').then(function (data) {
    const guilds = (data && data.guilds) || [];
    const select = document.getElementById('guildSelect');
    if (!guilds.length) {
      select.innerHTML = '<option value="">No approved servers</option>';
      return;
    }
    select.innerHTML = guilds.map(function (g) {
      const id = String(g.guild_id || '');
      return `<option value="${esc(id)}">${esc(g.guildName || 'Unknown')} (${esc(id)})</option>`;
    }).join('');
    select.addEventListener('change', function () {
      currentGuildId = select.value;
      if (currentGuildId) loadSettings();
    });
    // Default to the first guild if present.
    currentGuildId = select.value;
    if (currentGuildId) loadSettings();
  });
}

function loadPersonalTheme() {
  return apiFetch('/api/theme').then(function (data) {
    personalThemeValue = data && data.theme ? String(data.theme) : '';
  }).catch(function () {
    /* anonymous / expired session — personal select stays at default */
  });
}

let personalThemeValue = '';

function savePersonalTheme() {
  const sel = document.getElementById('personalTheme');
  const status = document.getElementById('personalStatus');
  apiFetch('/api/theme', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: sel.value === '' ? null : sel.value }),
  }).then(function () {
    status.textContent = 'Saved ✓';
  }).catch(function (err) {
    status.textContent = 'Error: ' + err.message;
  });
}

function loadSettings() {
  const body = document.getElementById('themeBody');
  body.innerHTML = '<div class="dzc-skeleton" style="height:1.25rem;width:220px"></div>';
  apiFetch(`/api/guilds/${encodeURIComponent(currentGuildId)}/theme`).then(function (data) {
    return loadPersonalTheme().then(function () {
      renderSettings(data.settings, data.resolved, personalThemeValue);
      updatePreview(data.resolved);
    });
  }).catch(function (err) {
    body.innerHTML = `<p class="text-red-400">${esc(err.message)}</p>`;
  });
}

function fetchPacks() {
  if (cachedPacks) return Promise.resolve(cachedPacks);
  return apiFetch('/api/theme/packs').then(function (data) {
    cachedPacks = (data && data.packs) || [];
    return cachedPacks;
  });
}

function windowLabel(p) {
  const w = p && (p.window || (p.windows && p.windows[0]));
  if (!w) return '';
  const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const parts = (p.windows || [p.window]).filter(Boolean).map(function (ww) {
    return `${months[ww.month]} ${ww.startDay}–${ww.endDay}`;
  });
  return ` (${parts.join(', ')})`;
}

function renderSettings(s, resolved, personal) {
  const body = document.getElementById('themeBody');
  const accentPresets = ACCENT_PRESETS.map(function (hex) {
    const sel = (s.accentColor || '').toLowerCase() === hex ? ' selected' : '';
    return `<button type="button" class="preset${sel}" data-hex="${hex}" title="${hex}" style="background:${hex}"></button>`;
  }).join('');
  const themeOptions = BASE_THEMES.map(function (t) {
    return `<option value="${esc(t.value)}"${s.themeDefault === t.value ? ' selected' : ''}>${esc(t.label)}</option>`;
  }).join('');
  const personalOptions = `<option value="">Guild default</option>` + BASE_THEMES.map(function (t) {
    return `<option value="${esc(t.value)}"${personal === t.value ? ' selected' : ''}>${esc(t.label)}</option>`;
  }).join('');

  fetchPacks().then(function (packs) {
    const packToggles = packs.filter(function (p) { return p.name !== 'none'; }).map(function (p) {
      const enabled = s.holidayPacks && s.holidayPacks[p.name];
      return `
        <label class="pack-toggle">
          <input type="checkbox" class="pack-check" value="${esc(p.name)}"${enabled ? ' checked' : ''}>
          <span>${esc(p.label)}${windowLabel(p)}</span>
        </label>`;
    }).join('');

    body.innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1rem">
      <div class="field">
        <label>Guild default theme</label>
        <select id="themeDefault">${themeOptions}</select>
        <span class="muted">Applied when the visitor has no personal choice. No holiday pack changes the base theme — packs re-skin the tokens over it.</span>
      </div>
      <div class="field">
        <label>Your personal theme (this account)</label>
        <select id="personalTheme">${personalOptions}</select>
        <span class="muted">Overrides the guild default on every page you view.</span>
      </div>
      <div class="field">
        <label>Accent color (per-guild override)</label>
        <div class="presets" id="accentPresets">${accentPresets}</div>
        <div class="flex items-center" style="display:flex;align-items:center;gap:8px">
          <span id="accentSwatch" class="swatch" style="background:${s.accentColor || '#8a9a5b'}"></span>
          <input id="accentColor" type="text" value="${esc(s.accentColor || '')}" placeholder="#8a9a5b" style="width:140px">
          <button type="button" id="clearAccent" class="muted" style="cursor:pointer">Use default</button>
        </div>
      </div>
      <div class="field">
        <label>Holiday packs (opt-in per pack)</label>
        <div id="packToggles" style="display:flex;flex-direction:column;gap:6px;max-height:180px;overflow:auto;padding:4px 2px">${packToggles}</div>
        <span class="muted">Enabled packs auto-apply during their window; not auto-active for everyone.</span>
      </div>
      <div class="field">
        <label>Legacy single-select pack (B1.2)</label>
        <select id="holidayTheme">
          <option value="">None (off)</option>
          ${packs.map(function (p) {
            const sel = s.holidayTheme === p.name ? ' selected' : '';
            const label = p.name === 'none' ? 'None (off)' : p.label + windowLabel(p);
            return `<option value="${esc(p.name)}"${sel}>${esc(label)}</option>`;
          }).join('')}
        </select>
      </div>
      <div class="field">
        <label>Legacy override window</label>
        <div style="display:flex;gap:8px;align-items:flex-end">
          <div class="field" style="margin:0;flex:1"><label>From</label><input id="holidayStart" type="date" value="${esc(s.holidayStart || '')}"></div>
          <div class="field" style="margin:0;flex:1"><label>To</label><input id="holidayEnd" type="date" value="${esc(s.holidayEnd || '')}"></div>
        </div>
        <span class="muted">Optional override window for the legacy pack (YYYY-MM-DD). Leave blank to use the pack's built-in window.</span>
      </div>
    </div>
    <button type="button" id="saveTheme" class="save-btn">Save guild theme</button>
    <button type="button" id="savePersonal" class="save-btn" style="margin-left:8px">Save my theme</button>
    <span id="saveStatus" class="muted" style="margin-left:12px"></span>
    <span id="personalStatus" class="muted" style="margin-left:12px"></span>`;

    // Personal select: reflect the user's stored value (loaded separately).
    document.getElementById('personalTheme').addEventListener('change', savePersonalTheme);
    bindSettings();
  });
}

function bindSettings() {
  const status = document.getElementById('saveStatus');
  document.getElementById('saveTheme').addEventListener('click', function () { saveSettings(status); });
  document.querySelectorAll('#accentPresets .preset').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#accentPresets .preset').forEach(function (x) { x.classList.remove('selected'); });
      b.classList.add('selected');
      document.getElementById('accentColor').value = b.dataset.hex;
      document.getElementById('accentSwatch').style.background = b.dataset.hex;
    });
  });
  document.getElementById('accentColor').addEventListener('input', function (e) {
    document.getElementById('accentSwatch').style.background = e.target.value;
  });
  document.getElementById('clearAccent').addEventListener('click', function () {
    document.getElementById('accentColor').value = '';
    document.getElementById('accentSwatch').style.background = '#8a9a5b';
    document.querySelectorAll('#accentPresets .preset').forEach(function (x) { x.classList.remove('selected'); });
  });
}

function saveSettings(status) {
  const themeDefault = document.getElementById('themeDefault').value;
  const accentColor = document.getElementById('accentColor').value.trim();
  const holidayTheme = document.getElementById('holidayTheme').value;
  const holidayStart = document.getElementById('holidayStart').value;
  const holidayEnd = document.getElementById('holidayEnd').value;
  const packMap = {};
  document.querySelectorAll('.pack-check:checked').forEach(function (c) { packMap[c.value] = true; });
  const btn = document.getElementById('saveTheme');
  btn.disabled = true;
  status.textContent = 'Saving…';
  apiFetch(`/api/guilds/${encodeURIComponent(currentGuildId)}/theme`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      themeDefault,
      accentColor: accentColor || null,
      holidayTheme: holidayTheme || null,
      holidayStart: holidayStart || null,
      holidayEnd: holidayEnd || null,
      holidayPacks: packMap,
    }),
  }).then(() => {
    status.textContent = 'Saved ✓';
    // Re-fetch to reflect the server-computed preview.
    return apiFetch(`/api/guilds/${encodeURIComponent(currentGuildId)}/theme`).then(function (d) {
      renderSettings(d.settings, d.resolved, personalThemeValue);
      updatePreview(d.resolved);
    });
  }).catch(function (err) {
    status.textContent = 'Error: ' + err.message;
  }).finally(function () {
    btn.disabled = false;
  });
}

function updatePreview(resolved) {
  const preview = document.getElementById('themePreview');
  // Base theme on the preview root (theme.css defines per-theme [data-theme]
  // blocks, so the attribute selects the right token set).
  const base = resolved.baseTheme;
  const known = BASE_THEMES.some(function (t) { return t.value === base; });
  preview.setAttribute('data-theme', known ? base : 'livonia');
  // Apply the server-computed override, retargeted from :root:root to the
  // preview container (the ID selector still beats every theme block) so the
  // live page theme is untouched.
  const scoped = (resolved.overrideCss || '').replace(':root:root{', '#' + preview.id + '{');
  let style = document.getElementById('previewScopeStyle');
  if (!style) {
    style = document.createElement('style');
    style.id = 'previewScopeStyle';
    document.head.appendChild(style);
  }
  style.textContent = scoped;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () {
    loadGuilds();
    loadPersonalTheme();
  });
} else {
  loadGuilds();
  loadPersonalTheme();
}
