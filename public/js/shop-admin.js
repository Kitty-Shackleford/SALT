/*
 * DayZ Dashboard - Shop Admin
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 */

// ── State ──────────────────────────────────────────────────────────────────
let currentServerId = null;
let adminContextGeneration = 0;
const adminRequestSequence = Object.create(null);
function nextAdminRequestId(family) {
  adminRequestSequence[family] = (adminRequestSequence[family] || 0) + 1;
  return adminRequestSequence[family];
}
let allItems  = [];
let allOrders = [];
const orderEvidenceById = new Map();
let editingItemId = null;
let editingItemVersion = null;
let editingServerId = null;
let editingEditorToken = 0;

// Track which order rows are expanded (orderId → boolean)
const expandedOrders = new Set();

// ── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadServers();
  setupTabListeners();
  setupItemForm();
  setupFilterListeners();
  setupBulkActions();

  document.getElementById('serverSelect').addEventListener('change', onServerChange);
  document.getElementById('item-type').addEventListener('change', toggleRentalRestarts);
  document.getElementById('item-spawn-method').addEventListener('change', toggleEventConfig);
  document.getElementById('emote-capture-enabled').addEventListener('change', toggleEmoteCaptureFields);
  document.getElementById('preset-item-select').addEventListener('change', onPresetItemChange);
  document.getElementById('add-preset-btn').addEventListener('click', addPreset);

  // Hide rental restarts and event config panel by default
  toggleRentalRestarts();
  toggleEventConfig();
  toggleEmoteCaptureFields();
});

// ── Servers ─────────────────────────────────────────────────────────────────

/** Populate server selector from the owner's servers list. */
async function loadServers() {
  try {
    const res = await fetch('/api/owner/servers');
    if (!res.ok) throw new Error('Failed');
    const json = await res.json();
    const servers = json.servers || json;
    const sel = document.getElementById('serverSelect');
    sel.innerHTML = '<option value="">-- Select a server --</option>';
    servers.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.guildName ? s.guildName + (s.name ? ' — ' + s.name : '') : (s.name || s.id);
      sel.appendChild(opt);
    });
  } catch (err) {
    console.error('loadServers:', err);
  }
}

function onServerChange() {
  adminContextGeneration++;
  currentServerId = document.getElementById('serverSelect').value || null;
  allItems = [];
  allOrders = [];
  orderEvidenceById.clear();
  expandedOrders.clear();
  cancelEdit();
  populatePresetItemSelect([]);
  document.getElementById('items-tbody').innerHTML =
    '<tr><td colspan="9" class="text-center py-4 text-gray-400">Select a server to view items.</td></tr>';
  document.getElementById('presets-tbody').innerHTML =
    '<tr><td colspan="8" class="text-center py-4 text-gray-400">Select an item to view presets.</td></tr>';
  document.getElementById('radar-activation-summary').textContent =
    'Select a server to view trusted radar audit data.';
  document.getElementById('radar-audit-tbody').innerHTML =
    '<tr><td colspan="5" class="text-center py-4 text-gray-400">Select a server to view radar activity.</td></tr>';
  ['stat-revenue', 'stat-orders', 'stat-items', 'stat-rentals'].forEach(id => {
    document.getElementById(id).textContent = '—';
  });
  document.getElementById('order-breakdown').innerHTML =
    '<div class="text-gray-400">Select a server to view analytics.</div>';
  document.getElementById('top-items-list').innerHTML =
    '<div class="text-gray-400">Select a server to view analytics.</div>';
  document.getElementById('orders-tbody').innerHTML =
    '<tr><td colspan="7" class="text-center py-4 text-gray-400">Select a server to view orders.</td></tr>';
  document.getElementById('rentals-tbody').innerHTML =
    '<tr><td colspan="9" class="text-center py-4 text-gray-400">Select a server to view active rentals.</td></tr>';
  if (currentServerId) {
    loadItems();
    loadOrders();
    loadRentals();
    loadRadarAudit();
    loadAnalytics();
  }
}

// ── Tab switching ──────────────────────────────────────────────────────────

const ALL_TABS = ['items', 'presets', 'orders', 'rentals', 'radar', 'analytics'];

function setupTabListeners() {
  ALL_TABS.forEach(t => {
    document.getElementById('tab-btn-' + t).addEventListener('click', () => showTab(t));
  });
}

function showTab(name) {
  ALL_TABS.forEach(t => {
    document.getElementById('tab-' + t).style.display = t === name ? 'block' : 'none';
    const btn = document.getElementById('tab-btn-' + t);
    btn.classList.toggle('bg-blue-600', t === name);
    btn.classList.toggle('font-semibold', t === name);
    btn.classList.toggle('bg-gray-700', t !== name);
  });
}

// ── Items ────────────────────────────────────────────────────────────────────

function setupItemForm() {
  document.getElementById('save-item-btn').addEventListener('click', saveItem);
  document.getElementById('cancel-edit-btn').addEventListener('click', cancelEdit);
}

function toggleEmoteCaptureFields() {
  const enabled = document.getElementById('emote-capture-enabled').checked;
  document.getElementById('emote-capture-fields').style.display = enabled ? 'grid' : 'none';
}

function readEmoteCaptureConfig() {
  const enabled = document.getElementById('emote-capture-enabled').checked;
  return {
    enabled,
    emoteType: enabled ? document.getElementById('emote-capture-type').value : null,
    heldItem: enabled
      ? (document.getElementById('emote-capture-held-item').value.trim() || null)
      : null,
  };
}

function writeEmoteCaptureConfig(config) {
  const enabled = config?.enabled === true;
  document.getElementById('emote-capture-enabled').checked = enabled;
  document.getElementById('emote-capture-type').value = config?.emoteType || 'EmotePoint';
  document.getElementById('emote-capture-held-item').value = config?.heldItem || '';
  toggleEmoteCaptureFields();
}

function formatEmoteHotkey(config) {
  if (config?.enabled !== true) {
    return '<span class="text-xs text-gray-500">Not configured</span>';
  }
  const emote = String(config.emoteType || '').replace(/^Emote/, '') || 'Unknown';
  const heldItem = config.heldItem ? ' + ' + String(config.heldItem) : '';
  return '<span class="px-2 py-0.5 rounded text-xs bg-indigo-900 text-indigo-200">' +
    escapeHtml(emote + heldItem) + '</span>';
}

/** Wire up search/filter inputs so they re-render the items table client-side. */
function setupFilterListeners() {
  ['items-search', 'items-type-filter', 'items-status-filter'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderItems);
  });
  ['orders-status-filter', 'orders-search'].forEach(id => {
    document.getElementById(id).addEventListener('input', renderOrders);
  });
}

function toggleRentalRestarts() {
  const isRental = document.getElementById('item-type').value === 'event_rental';
  document.getElementById('rental-restarts-row').style.display = isRental ? 'block' : 'none';
}

function toggleEventConfig() {
  const method  = document.getElementById('item-spawn-method').value;
  const isEvent = method === 'event';
  const isObjectSpawner = method === 'custom_json';
  const isCapability = method === 'capability';

  document.getElementById('event-config-panel').style.display = isEvent ? 'block' : 'none';
  document.getElementById('object-spawner-config').style.display = isObjectSpawner ? 'block' : 'none';
  document.getElementById('item-capability-panel').style.display = isCapability ? 'block' : 'none';
  const forceVersionRow = document.getElementById('force-event-version-row');
  if (forceVersionRow) forceVersionRow.style.display = isEvent && editingItemId ? 'flex' : 'none';
  if (!isEvent) document.getElementById('force-event-version').checked = false;

  const typeRow    = document.getElementById('item-type-row');
  const typeLabel  = document.getElementById('item-type-label');
  const typeSelect = document.getElementById('item-type');
  const itemOpt    = typeSelect.querySelector('option[value="item"]');
  const rentalOpt  = typeSelect.querySelector('option[value="event_rental"]');

  if (isEvent || isCapability) {
    // Event and virtual capability products may be permanent or restart rentals.
    typeRow.style.display     = 'block';
    typeLabel.textContent     = isEvent ? '📌 Spawn Duration' : '📡 Capability Duration';
    itemOpt.textContent       = 'Permanent (never expires)';
    rentalOpt.textContent     = 'Rental (player chooses restarts at purchase)';
    rentalOpt.disabled        = false;
  } else {
    // JSON / coords spawns are always permanent items — hide the row and
    // lock the value so event_rental can't be accidentally submitted
    typeRow.style.display     = 'none';
    typeSelect.value          = 'item';
    typeLabel.textContent     = 'Item Type';
    itemOpt.textContent       = 'Item';
    rentalOpt.textContent     = 'Event Rental';
    rentalOpt.disabled        = true;
  }

  // Re-evaluate the restarts field visibility after the type may have changed
  toggleRentalRestarts();
}

function readObjectSpawnerConfig() {
  const scale = Number(document.getElementById('object-spawner-scale').value);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 100) {
    throw new Error('Object Spawner scale must be greater than 0 and no more than 100.');
  }
  return {
    file: document.getElementById('item-custom-json').value.trim(),
    scale,
    enableCEPersistency: document.getElementById('object-spawner-ce-persistency').checked,
    customString: document.getElementById('object-spawner-custom-string').value,
  };
}

function writeObjectSpawnerConfig(value) {
  const config = value || {};
  document.getElementById('item-custom-json').value = config.file || 'custom/dayz_dashboard_shop_objects.json';
  document.getElementById('object-spawner-scale').value = config.scale == null ? 1 : config.scale;
  document.getElementById('object-spawner-ce-persistency').checked = config.enableCEPersistency === true;
  document.getElementById('object-spawner-custom-string').value = config.customString || '';
}

/** Read event config fields from the form into a plain object. */
function readEventConfig() {
  const childrenText = document.getElementById('ec-children-json').value.trim();
  const eventGroupText = document.getElementById('ec-event-group-json').value.trim();
  const effectComponentsText = document.getElementById('ec-effect-components-json').value.trim();
  const objectComponentsText = document.getElementById('ec-object-components-json').value.trim();
  let children = null;
  let eventGroupChildren = null;
  let effectAreaComponents = null;
  let objectSpawnerComponents = null;
  if (childrenText) {
    children = JSON.parse(childrenText);
    if (!Array.isArray(children)) throw new Error('Composed event children must be a JSON array.');
  }
  if (eventGroupText) {
    eventGroupChildren = JSON.parse(eventGroupText);
    if (!Array.isArray(eventGroupChildren)) throw new Error('Event group children must be a JSON array.');
  }
  if (effectComponentsText) {
    effectAreaComponents = JSON.parse(effectComponentsText);
    if (!Array.isArray(effectAreaComponents)) throw new Error('Companion cfgEffectArea entries must be a JSON array.');
  }
  if (objectComponentsText) {
    objectSpawnerComponents = JSON.parse(objectComponentsText);
    if (!Array.isArray(objectSpawnerComponents)) throw new Error('Companion Object Spawner entries must be a JSON array.');
  }
  return {
    prefix:         document.getElementById('ec-prefix').value,
    nominal:        parseInt(document.getElementById('ec-nominal').value, 10)        || 99,
    min:            parseInt(document.getElementById('ec-min').value, 10)            || 0,
    max:            parseInt(document.getElementById('ec-max').value, 10)            || 0,
    lifetime:       parseInt(document.getElementById('ec-lifetime').value, 10)       || 0,
    restock:        parseInt(document.getElementById('ec-restock').value, 10)        || 0,
    saferadius:     parseInt(document.getElementById('ec-saferadius').value, 10)     || 0,
    distanceradius: parseInt(document.getElementById('ec-distanceradius').value, 10) || 0,
    cleanupradius:      parseInt(document.getElementById('ec-cleanupradius').value, 10)      || 0,
    placement_clearance: parseInt(document.getElementById('ec-placement-clearance').value, 10) || 0,
    secondary:      document.getElementById('ec-secondary').value.trim() || null,
    position:       document.getElementById('ec-position').value,
    limit:          document.getElementById('ec-limit').value,
    active:         document.getElementById('ec-active').checked ? 1 : 0,
    flags: {
      deletable:      document.getElementById('ec-deletable').checked      ? 1 : 0,
      init_random:    document.getElementById('ec-init-random').checked    ? 1 : 0,
      remove_damaged: document.getElementById('ec-remove-damaged').checked ? 1 : 0,
    },
    child: {
      max:     parseInt(document.getElementById('ec-child-max').value,     10) || 1,
      min:     parseInt(document.getElementById('ec-child-min').value,     10) || 1,
      lootmax: parseInt(document.getElementById('ec-child-lootmax').value, 10) || 0,
      lootmin: parseInt(document.getElementById('ec-child-lootmin').value, 10) || 0,
    },
    children: children,
    eventGroupChildren: eventGroupChildren,
    effectAreaComponents: effectAreaComponents,
    objectSpawnerComponents: objectSpawnerComponents,
  };
}

/** Populate event config fields from a stored event_config object. */
function writeEventConfig(cfg) {
  cfg = cfg || {};
  const flags = cfg.flags || {};
  document.getElementById('ec-prefix').value             = cfg.prefix          || 'Static';
  document.getElementById('ec-nominal').value            = cfg.nominal         ?? 99;
  document.getElementById('ec-min').value                = cfg.min             ?? 0;
  document.getElementById('ec-max').value                = cfg.max             ?? 0;
  document.getElementById('ec-lifetime').value           = cfg.lifetime        ?? 0;
  document.getElementById('ec-restock').value            = cfg.restock         ?? 0;
  document.getElementById('ec-saferadius').value         = cfg.saferadius      ?? 0;
  document.getElementById('ec-distanceradius').value     = cfg.distanceradius  ?? 0;
  document.getElementById('ec-cleanupradius').value       = cfg.cleanupradius       ?? 0;
  document.getElementById('ec-placement-clearance').value = cfg.placement_clearance ?? 0;
  document.getElementById('ec-secondary').value          = cfg.secondary       || '';
  document.getElementById('ec-position').value           = cfg.position        || 'fixed';
  document.getElementById('ec-limit').value              = cfg.limit           || 'child';
  document.getElementById('ec-active').checked           = (cfg.active ?? 1) === 1;
  document.getElementById('ec-deletable').checked        = (flags.deletable      ?? 1) === 1;
  document.getElementById('ec-init-random').checked      = (flags.init_random    ?? 0) === 1;
  document.getElementById('ec-remove-damaged').checked   = (flags.remove_damaged ?? 0) === 1;
  const child = cfg.child || {};
  document.getElementById('ec-child-max').value     = child.max     ?? 1;
  document.getElementById('ec-child-min').value     = child.min     ?? 1;
  document.getElementById('ec-child-lootmax').value = child.lootmax ?? 0;
  document.getElementById('ec-child-lootmin').value = child.lootmin ?? 0;
  document.getElementById('ec-children-json').value = Array.isArray(cfg.children)
    ? JSON.stringify(cfg.children, null, 2)
    : '';
  document.getElementById('ec-event-group-json').value = Array.isArray(cfg.eventGroupChildren)
    ? JSON.stringify(cfg.eventGroupChildren, null, 2)
    : '';
  document.getElementById('ec-effect-components-json').value = Array.isArray(cfg.effectAreaComponents)
    ? JSON.stringify(cfg.effectAreaComponents, null, 2)
    : '';
  document.getElementById('ec-object-components-json').value = Array.isArray(cfg.objectSpawnerComponents)
    ? JSON.stringify(cfg.objectSpawnerComponents, null, 2)
    : '';
}

function readCapabilityConfig() {
  const capability = document.getElementById('cap-type').value;
  const radiusValue = document.getElementById('cap-radius').value.trim();
  if (capability === 'radar') {
    return {
      capability,
      radarRevealMode: document.getElementById('cap-radar-mode').value,
      radiusMeters: radiusValue ? Number(radiusValue) : null,
    };
  }
  const jammerEffect = document.getElementById('cap-jammer-effect').value;
  const config = {
    capability,
    jammerScope: document.getElementById('cap-jammer-scope').value,
    jammerEffect,
    jammerTargets: document.getElementById('cap-jammer-targets').value,
    radiusMeters: radiusValue ? Number(radiusValue) : null,
  };
  if (jammerEffect !== 'suppress') {
    config.deceptionActions = [...document.querySelectorAll('input[name="cap-action"]:checked')]
      .map(input => input.value);
    config.deceptionPersistence = document.getElementById('cap-persistence').value;
  }
  return config;
}

function writeCapabilityConfig(config) {
  const cfg = config || { capability: 'radar', radarRevealMode: 'exact' };
  document.getElementById('cap-type').value = cfg.capability || 'radar';
  document.getElementById('cap-radar-mode').value = cfg.radarRevealMode || 'exact';
  document.getElementById('cap-jammer-scope').value = cfg.jammerScope || 'full_map';
  document.getElementById('cap-jammer-effect').value = cfg.jammerEffect || 'suppress';
  document.getElementById('cap-jammer-targets').value = cfg.jammerTargets || 'enemies';
  document.getElementById('cap-radius').value = cfg.radiusMeters ?? '';
  document.getElementById('cap-persistence').value = cfg.deceptionPersistence || 'transient';
  const actions = new Set(cfg.deceptionActions || []);
  document.querySelectorAll('input[name="cap-action"]').forEach(input => {
    input.checked = actions.has(input.value);
  });
}

/** Load all shop items for the current server. */
async function loadItems() {
  const requestId = nextAdminRequestId('items');
  const tbody = document.getElementById('items-tbody');
  const generation = adminContextGeneration;
  const serverId = currentServerId;
  tbody.innerHTML = '<tr><td colspan="9" class="text-center py-4 text-gray-400">Loading\u2026</td></tr>';

  try {
    const res = await fetch('/api/shop/admin/items/' + serverId);
    if (!res.ok) throw new Error('Failed to load items');
    const json = await res.json();
    if (requestId !== adminRequestSequence.items || generation !== adminContextGeneration ||
        serverId !== currentServerId) return;
    allItems = json.data || json;

    populatePresetItemSelect(allItems);
    renderItems();
  } catch (err) {
    if (requestId !== adminRequestSequence.items || generation !== adminContextGeneration ||
        serverId !== currentServerId) return;
    console.error('loadItems:', err);
    document.getElementById('items-tbody').innerHTML =
      '<tr><td colspan="9" class="text-center py-4 text-red-400">Failed to load items.</td></tr>';
  }
}

/**
 * Filter allItems by the current search/type/status inputs and repopulate the table.
 * Called on initial load and whenever a filter changes.
 */
function renderItems() {
  const tbody  = document.getElementById('items-tbody');
  const search = document.getElementById('items-search').value.toLowerCase();
  const type   = document.getElementById('items-type-filter').value;
  const status = document.getElementById('items-status-filter').value;

  const filtered = allItems.filter(item => {
    if (search && !item.name.toLowerCase().includes(search) &&
        !(item.item_class || '').toLowerCase().includes(search)) return false;
    if (type   && item.item_type !== type)                        return false;
    if (status === 'active'   && !item.is_active)                 return false;
    if (status === 'inactive' &&  item.is_active)                 return false;
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = allItems.length
      ? '<tr><td colspan="9" class="text-center py-4 text-gray-400">No items match the current filters.</td></tr>'
      : '<tr><td colspan="9" class="text-center py-4 text-gray-400">No items yet. Create one above.</td></tr>';
    updateBulkBar();
    return;
  }

  tbody.innerHTML = '';
  filtered.forEach(item => tbody.appendChild(buildItemRow(item)));
  updateBulkBar();
}

function buildItemRow(item) {
  const tr = document.createElement('tr');
  tr.className = 'border-b border-gray-700';
  tr.dataset.itemId = item.id;

  const activeBadge = item.is_active
    ? '<span class="px-2 py-0.5 rounded text-xs bg-green-800 text-green-200">Active</span>'
    : '<span class="px-2 py-0.5 rounded text-xs bg-gray-700 text-gray-400">Inactive</span>';

  tr.innerHTML =
    '<td class="py-2 px-3 w-8"><input type="checkbox" class="item-checkbox" data-id="' + item.id + '"></td>' +
    '<td class="py-2 px-3 font-medium">' + escapeHtml(item.name) + '</td>' +
    '<td class="py-2 px-3 text-gray-400">' + escapeHtml(item.item_class || '') + '</td>' +
    '<td class="py-2 px-3 text-green-400">\uD83D\uDCB0 ' + formatPrice(item.price) + '</td>' +
    '<td class="py-2 px-3"><span class="px-2 py-0.5 rounded text-xs ' +
      (item.item_type === 'event_rental' ? 'bg-purple-800' : 'bg-blue-900') + '">' +
      escapeHtml(item.item_type) + '</span></td>' +
    '<td class="py-2 px-3 text-gray-400">' + escapeHtml(item.spawn_method || '') + '</td>' +
    '<td class="py-2 px-3">' + formatEmoteHotkey(item.emote_capture_config) + '</td>' +
    '<td class="py-2 px-3">' + activeBadge + '</td>' +
    '<td class="py-2 px-3 flex gap-2">' +
      '<button class="bg-gray-600 hover:bg-gray-500 px-3 py-1 rounded text-xs toggle-btn">' +
        (item.is_active ? 'Deactivate' : 'Activate') +
      '</button>' +
      '<button class="bg-yellow-700 hover:bg-yellow-600 px-3 py-1 rounded text-xs edit-btn">Edit</button>' +
      '<button class="bg-red-700 hover:bg-red-600 px-3 py-1 rounded text-xs delete-btn">Delete</button>' +
    '</td>';

  tr.querySelector('.item-checkbox').addEventListener('change', updateBulkBar);
  tr.querySelector('.toggle-btn').addEventListener('click', () => toggleItemActive(item.id));
  tr.querySelector('.edit-btn').addEventListener('click', () => startEdit(item));
  tr.querySelector('.delete-btn').addEventListener('click', () => deleteItem(item.id));
  return tr;
}

// ── Bulk selection ────────────────────────────────────────────────────────────

function setupBulkActions() {
  document.getElementById('select-all-items').addEventListener('change', e => {
    document.querySelectorAll('.item-checkbox').forEach(cb => { cb.checked = e.target.checked; });
    updateBulkBar();
  });
  document.getElementById('bulk-activate-btn').addEventListener('click',   () => runBulkAction('activate'));
  document.getElementById('bulk-deactivate-btn').addEventListener('click', () => runBulkAction('deactivate'));
  document.getElementById('bulk-delete-btn').addEventListener('click',     () => runBulkAction('delete'));
  document.getElementById('bulk-clear-btn').addEventListener('click', () => {
    document.querySelectorAll('.item-checkbox').forEach(cb => { cb.checked = false; });
    document.getElementById('select-all-items').checked = false;
    updateBulkBar();
  });
}

/** Show or hide the bulk action bar based on how many checkboxes are selected. */
function updateBulkBar() {
  const selected = document.querySelectorAll('.item-checkbox:checked');
  const bar = document.getElementById('bulk-bar');
  if (selected.length > 0) {
    bar.style.display = 'flex';
    document.getElementById('bulk-count').textContent = selected.length + ' item(s) selected';
  } else {
    bar.style.display = 'none';
  }
}

async function runBulkAction(action) {
  const mutationGeneration = adminContextGeneration;
  const mutationServerId = currentServerId;
  const itemIds = Array.from(document.querySelectorAll('.item-checkbox:checked')).map(cb => Number(cb.dataset.id));
  if (!itemIds.length) return;

  const label = action === 'delete' ? 'delete' : action;
  const warning = action === 'delete'
    ? ' Deleted entries will disappear from the catalog. Order history will be preserved.'
    : '';
  if (!confirm('Are you sure you want to ' + label + ' ' + itemIds.length + ' item(s)?' + warning)) return;

  try {
    const res = await fetchWithCsrf('/api/shop/admin/items/bulk-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, itemIds }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed');
    }
    if (mutationGeneration !== adminContextGeneration || mutationServerId !== currentServerId) return;
    document.getElementById('select-all-items').checked = false;
    loadItems();
  } catch (err) {
    if (mutationGeneration !== adminContextGeneration || mutationServerId !== currentServerId) return;
    console.error('runBulkAction:', err);
    alert('Bulk action failed: ' + err.message);
  }
}

async function toggleItemActive(itemId) {
  const mutationGeneration = adminContextGeneration;
  const mutationServerId = currentServerId;
  try {
    const res = await fetchWithCsrf('/api/shop/admin/items/' + itemId + '/toggle', { method: 'PATCH' });
    if (mutationGeneration !== adminContextGeneration || mutationServerId !== currentServerId) return;
    if (!res.ok) throw new Error('Failed to toggle');
    loadItems();
  } catch (err) {
    if (mutationGeneration !== adminContextGeneration || mutationServerId !== currentServerId) return;
    console.error('toggleItemActive:', err);
    alert('Failed to toggle item status.');
  }
}

function startEdit(item) {
  editingEditorToken++;
  editingItemId = item.id;
  editingItemVersion = Number(item.provisioning_version) || 1;
  editingServerId = currentServerId;
  document.getElementById('item-form-title').textContent = '\u270F\uFE0F Edit Item: ' + item.name;
  document.getElementById('edit-item-id').value = item.id;
  document.getElementById('item-name').value = item.name || '';
  document.getElementById('item-class').value = item.item_class || '';
  document.getElementById('item-desc').value = item.description || '';
  document.getElementById('item-price').value = item.price || 0;
  document.getElementById('item-type').value = item.item_type || 'item';
  document.getElementById('item-rental-restarts').value = item.rental_restarts != null ? item.rental_restarts : '';
  document.getElementById('item-spawn-method').value = item.spawn_method || 'event';
  writeObjectSpawnerConfig({
    ...(item.object_spawner_config || {}),
    file: item.custom_json_file || item.object_spawner_config?.file,
  });
  // item-event-name lives inside the event config panel (base name hint)
  document.getElementById('item-event-name').value = '';
  document.getElementById('force-event-version').checked = false;
  writeEventConfig(item.event_config || {});
  writeCapabilityConfig(item.capability_config);
  writeEmoteCaptureConfig(item.emote_capture_config);
  // Show the already-generated event name so the owner knows what's in the XML files
  const genNameEl = document.getElementById('generated-event-name');
  const genNameVal = document.getElementById('generated-event-name-value');
  if (item.event_name && item.spawn_method === 'event') {
    genNameVal.textContent = item.event_name;
    genNameEl.style.display = 'block';
  } else {
    genNameEl.style.display = 'none';
  }
  document.getElementById('item-image-url').value = item.image_url || '';
  document.getElementById('cancel-edit-btn').style.display = 'inline-block';
  document.getElementById('save-item-btn').textContent = 'Update Item';
  toggleRentalRestarts();
  toggleEventConfig();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function cancelEdit() {
  editingEditorToken++;
  editingItemId = null;
  editingItemVersion = null;
  editingServerId = null;
  document.getElementById('item-form-title').textContent = '\u2795 Create New Item';
  document.getElementById('edit-item-id').value = '';
  ['item-name', 'item-class', 'item-desc', 'item-price', 'item-rental-restarts',
   'item-custom-json', 'item-event-name', 'item-image-url'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('generated-event-name').style.display = 'none';
  document.getElementById('generated-event-name-value').textContent = '';
  document.getElementById('force-event-version').checked = false;
  document.getElementById('item-type').value = 'item';
  document.getElementById('item-spawn-method').value = 'event';
  writeObjectSpawnerConfig({});
  writeEventConfig({});
  writeCapabilityConfig(null);
  writeEmoteCaptureConfig(null);
  document.getElementById('cancel-edit-btn').style.display = 'none';
  document.getElementById('save-item-btn').textContent = 'Save Item';
  toggleRentalRestarts();
  toggleEventConfig();
}

async function saveItem() {
  if (!currentServerId) { alert('Select a server first.'); return; }
  if (editingItemId && editingServerId !== currentServerId) {
    cancelEdit();
    alert('The selected server changed. Re-open the item before editing it.');
    return;
  }

  const saveGeneration = adminContextGeneration;
  const saveServerId = currentServerId;
  const saveItemId = editingItemId;
  const saveItemVersion = editingItemVersion;
  const saveEditorToken = editingEditorToken;
  const name  = document.getElementById('item-name').value.trim();
  const price = parseFloat(document.getElementById('item-price').value);
  if (!name)              { alert('Item name is required.'); return; }
  if (isNaN(price) || price < 0) { alert('Valid price required.'); return; }

  const spawnMethod = document.getElementById('item-spawn-method').value;
  let eventConfig = {};
  let objectSpawnerConfig = null;
  let capabilityConfig = null;
  try {
    if (spawnMethod === 'event') eventConfig = readEventConfig();
    if (spawnMethod === 'custom_json') objectSpawnerConfig = readObjectSpawnerConfig();
    if (spawnMethod === 'capability') capabilityConfig = readCapabilityConfig();
  } catch (error) {
    alert('Product configuration error: ' + error.message);
    return;
  }

  const payload = {
    serverId:         saveServerId,
    name,
    item_class:       document.getElementById('item-class').value.trim(),
    description:      document.getElementById('item-desc').value.trim(),
    price,
    item_type:        document.getElementById('item-type').value,
    rental_restarts:  document.getElementById('item-type').value === 'event_rental'
                        ? parseInt(document.getElementById('item-rental-restarts').value, 10) || 0
                        : null,
    spawn_method:     spawnMethod,
    custom_json_file: objectSpawnerConfig?.file || null,
    object_spawner_config: objectSpawnerConfig,
    event_name:       document.getElementById('item-event-name').value.trim(),
    event_config:     eventConfig,
    capability_config: capabilityConfig,
    emote_capture_config: readEmoteCaptureConfig(),
    image_url:        document.getElementById('item-image-url').value.trim(),
    force_provisioning_version: saveItemId
      ? document.getElementById('force-event-version').checked
      : false,
    expected_provisioning_version: saveItemId ? saveItemVersion : null,
  };

  try {
    let res;
    if (saveItemId) {
      res = await fetchWithCsrf('/api/shop/admin/items/' + saveItemId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      res = await fetchWithCsrf('/api/shop/admin/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to save item');
    }
    if (saveGeneration !== adminContextGeneration || saveServerId !== currentServerId ||
        saveItemId !== editingItemId || saveEditorToken !== editingEditorToken) return;
    cancelEdit();
    loadItems();
  } catch (err) {
    if (saveGeneration !== adminContextGeneration || saveServerId !== currentServerId ||
        saveItemId !== editingItemId || saveEditorToken !== editingEditorToken) return;
    console.error('saveItem:', err);
    alert('Error: ' + err.message);
  }
}

async function deleteItem(itemId) {
  const mutationGeneration = adminContextGeneration;
  const mutationServerId = currentServerId;
  if (!confirm('Delete this item from the catalog? Order history will be preserved.')) return;
  try {
    const res = await fetchWithCsrf('/api/shop/admin/items/' + itemId, { method: 'DELETE' });
    if (mutationGeneration !== adminContextGeneration || mutationServerId !== currentServerId) return;
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to delete');
    }
    loadItems();
  } catch (err) {
    if (mutationGeneration !== adminContextGeneration || mutationServerId !== currentServerId) return;
    console.error('deleteItem:', err);
    alert('Failed to delete item: ' + err.message);
  }
}

// ── Preset Locations ─────────────────────────────────────────────────────────

function populatePresetItemSelect(items) {
  const sel  = document.getElementById('preset-item-select');
  const prev = sel.value;
  sel.innerHTML = '<option value="">-- Select an item --</option>';
  items.forEach(item => {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.name;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
}

function onPresetItemChange() {
  const itemId = document.getElementById('preset-item-select').value;
  if (itemId) {
    loadPresets(itemId);
  } else {
    document.getElementById('presets-tbody').innerHTML =
      '<tr><td colspan="8" class="text-center py-4 text-gray-400">Select an item to view presets.</td></tr>';
  }
}

async function loadPresets(itemId) {
  const requestId = nextAdminRequestId('presets');
  const tbody = document.getElementById('presets-tbody');
  const generation = adminContextGeneration;
  const serverId = currentServerId;
  tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-gray-400">Loading\u2026</td></tr>';

  try {
    const res = await fetch('/api/shop/admin/items/' + itemId + '/presets');
    if (!res.ok) throw new Error('Failed');
    const json = await res.json();
    if (requestId !== adminRequestSequence.presets || generation !== adminContextGeneration ||
        serverId !== currentServerId ||
        String(itemId) !== document.getElementById('preset-item-select').value) return;
    const presets = json.data || json;

    if (!presets.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-gray-400">No presets defined yet.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    presets.forEach(p => {
      const tr = document.createElement('tr');
      tr.className = 'border-b border-gray-700';
      tr.innerHTML =
        '<td class="py-2 px-3">' + escapeHtml(p.label || '') + '</td>' +
        '<td class="py-2 px-3">' + (p.pos_x != null ? p.pos_x : '') + '</td>' +
        '<td class="py-2 px-3">' + (p.pos_y != null ? p.pos_y : '') + '</td>' +
        '<td class="py-2 px-3">' + (p.pos_z != null ? p.pos_z : '') + '</td>' +
        '<td class="py-2 px-3">' + (p.ypr_x != null ? p.ypr_x : '') + '</td>' +
        '<td class="py-2 px-3">' + (p.ypr_y != null ? p.ypr_y : '') + '</td>' +
        '<td class="py-2 px-3">' + (p.ypr_z != null ? p.ypr_z : '') + '</td>' +
        '<td class="py-2 px-3"><button class="bg-red-700 hover:bg-red-600 px-3 py-1 rounded text-xs del-btn">Delete</button></td>';
      tr.querySelector('.del-btn').addEventListener('click', () => deletePreset(p.id, itemId));
      tbody.appendChild(tr);
    });
  } catch (err) {
    if (requestId !== adminRequestSequence.presets || generation !== adminContextGeneration ||
        serverId !== currentServerId ||
        String(itemId) !== document.getElementById('preset-item-select').value) return;
    console.error('loadPresets:', err);
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-red-400">Failed to load presets.</td></tr>';
  }
}

async function addPreset() {
  const mutationGeneration = adminContextGeneration;
  const mutationServerId = currentServerId;
  const itemId = document.getElementById('preset-item-select').value;
  if (!itemId) { alert('Select an item first.'); return; }

  const payload = {
    label: document.getElementById('preset-label').value.trim(),
    pos_x: parseFloat(document.getElementById('preset-x').value) || 0,
    pos_y: parseFloat(document.getElementById('preset-y').value) || 0,
    pos_z: parseFloat(document.getElementById('preset-z').value) || 0,
    ypr_x: parseFloat(document.getElementById('preset-ypr-x').value) || 0,
    ypr_y: parseFloat(document.getElementById('preset-ypr-y').value) || 0,
    ypr_z: parseFloat(document.getElementById('preset-ypr-z').value) || 0,
  };

  try {
    const res = await fetchWithCsrf('/api/shop/admin/items/' + itemId + '/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (mutationGeneration !== adminContextGeneration || mutationServerId !== currentServerId ||
        itemId !== document.getElementById('preset-item-select').value) return;
    if (!res.ok) throw new Error('Failed to add preset');
    loadPresets(itemId);
    ['preset-label', 'preset-x', 'preset-y', 'preset-z',
     'preset-ypr-x', 'preset-ypr-y', 'preset-ypr-z'].forEach(id => {
      document.getElementById(id).value = '';
    });
  } catch (err) {
    if (mutationGeneration !== adminContextGeneration || mutationServerId !== currentServerId ||
        itemId !== document.getElementById('preset-item-select').value) return;
    console.error('addPreset:', err);
    alert('Failed to add preset: ' + err.message);
  }
}

async function deletePreset(presetId, itemId) {
  const mutationGeneration = adminContextGeneration;
  const mutationServerId = currentServerId;
  if (!confirm('Delete this preset?')) return;
  try {
    const res = await fetchWithCsrf('/api/shop/admin/presets/' + presetId, { method: 'DELETE' });
    if (mutationGeneration !== adminContextGeneration || mutationServerId !== currentServerId ||
        String(itemId) !== document.getElementById('preset-item-select').value) return;
    if (!res.ok) throw new Error('Failed');
    loadPresets(itemId);
  } catch (err) {
    if (mutationGeneration !== adminContextGeneration || mutationServerId !== currentServerId ||
        String(itemId) !== document.getElementById('preset-item-select').value) return;
    console.error('deletePreset:', err);
    alert('Failed to delete preset.');
  }
}

// ── Orders ──────────────────────────────────────────────────────────────────

async function loadOrders() {
  const requestId = nextAdminRequestId('orders');
  const tbody = document.getElementById('orders-tbody');
  const generation = adminContextGeneration;
  const serverId = currentServerId;
  tbody.innerHTML = '<tr><td colspan="7" class="text-center py-4 text-gray-400">Loading\u2026</td></tr>';

  try {
    const res = await fetch('/api/shop/admin/orders/' + serverId);
    if (!res.ok) throw new Error('Failed');
    const json = await res.json();
    if (requestId !== adminRequestSequence.orders || generation !== adminContextGeneration ||
        serverId !== currentServerId) return;
    allOrders = json.data || json;
    expandedOrders.clear();
    renderOrders();
  } catch (err) {
    if (requestId !== adminRequestSequence.orders || generation !== adminContextGeneration ||
        serverId !== currentServerId) return;
    console.error('loadOrders:', err);
    document.getElementById('orders-tbody').innerHTML =
      '<tr><td colspan="7" class="text-center py-4 text-red-400">Failed to load orders.</td></tr>';
  }
}

/**
 * Filter allOrders by the status and player-search inputs and repopulate the table.
 * Each row has an expand toggle that loads line items inline.
 */
function renderOrders() {
  const tbody        = document.getElementById('orders-tbody');
  const statusFilter = document.getElementById('orders-status-filter').value;
  const searchTerm   = document.getElementById('orders-search').value.toLowerCase();

  const filtered = allOrders.filter(o => {
    if (statusFilter && o.status !== statusFilter) return false;
    if (searchTerm && !(o.player_name || '').toLowerCase().includes(searchTerm)) return false;
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-4 text-gray-400">No orders match the current filters.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  filtered.forEach(order => {
    const tr = buildOrderRow(order);
    tbody.appendChild(tr);

    // Re-insert any previously expanded detail rows
    if (expandedOrders.has(order.id)) {
      const detailTr = buildOrderDetailPlaceholder(order.id);
      tbody.appendChild(detailTr);
      loadOrderItems(order.id, detailTr);
    }
  });
}

function buildOrderRow(order) {
  const tr = document.createElement('tr');
  tr.className = 'border-b border-gray-700';
  tr.dataset.orderId = order.id;

  const canRefund = order.status !== 'refunded';
  const isExpanded = expandedOrders.has(order.id);

  tr.innerHTML =
    '<td class="py-2 px-3 w-6 cursor-pointer expand-btn text-gray-400 select-none">' +
      (isExpanded ? '&#x25BC;' : '&#x25B6;') +
    '</td>' +
    '<td class="py-2 px-3">' + order.id + '</td>' +
    '<td class="py-2 px-3">' + escapeHtml(order.player_name || '') + '</td>' +
    '<td class="py-2 px-3"><span class="px-2 py-0.5 rounded text-xs ' + statusClass(order.status) + '">' +
      escapeHtml(order.status) + '</span></td>' +
    '<td class="py-2 px-3 text-green-400">\uD83D\uDCB0 ' + formatPrice(order.total_price) + '</td>' +
    '<td class="py-2 px-3 text-gray-400">' +
      (order.checked_out_at ? new Date(order.checked_out_at).toLocaleString() : 'Unknown') + '</td>' +
    '<td class="py-2 px-3">' +
      (canRefund ? '<button class="bg-orange-700 hover:bg-orange-600 px-3 py-1 rounded text-xs refund-btn">Refund</button>' : '') +
    '</td>';

  tr.querySelector('.expand-btn').addEventListener('click', () => toggleOrderExpand(order.id));
  if (canRefund) {
    tr.querySelector('.refund-btn').addEventListener('click', () => refundOrder(order.id));
  }
  return tr;
}

/** Create a placeholder detail row for an order (shows while loading items). */
function buildOrderDetailPlaceholder(orderId) {
  const tr = document.createElement('tr');
  tr.className = 'order-detail-row';
  tr.dataset.detailFor = orderId;
  tr.innerHTML = '<td colspan="7" class="py-2 px-6 text-gray-400 text-xs">Loading items\u2026</td>';
  return tr;
}

/** Toggle the inline expand row for an order. */
function toggleOrderExpand(orderId) {
  const tbody = document.getElementById('orders-tbody');
  const existing = tbody.querySelector('[data-detail-for="' + orderId + '"]');

  if (existing) {
    // Collapse
    existing.remove();
    expandedOrders.delete(orderId);
  } else {
    // Expand: insert detail row after the order row
    expandedOrders.add(orderId);
    const orderRow = tbody.querySelector('[data-order-id="' + orderId + '"]');
    const detailTr = buildOrderDetailPlaceholder(orderId);
    orderRow.after(detailTr);
    loadOrderItems(orderId, detailTr);
  }

  // Flip the arrow
  const orderRow = tbody.querySelector('[data-order-id="' + orderId + '"]');
  if (orderRow) {
    const btn = orderRow.querySelector('.expand-btn');
    btn.innerHTML = expandedOrders.has(orderId) ? '&#x25BC;' : '&#x25B6;';
  }
}

function adminFulfillmentBadge(fulfillment) {
  const state = fulfillment?.state || 'awaiting_spawn_evidence';
  const classes = state === 'spawn_confirmed'
    ? 'bg-green-800 text-green-200'
    : (state === 'spawn_failed' || state === 'spawn_refused'
      ? 'bg-red-800 text-red-200'
      : (state === 'evidence_unavailable' ? 'bg-gray-700 text-gray-300' : 'bg-yellow-900 text-yellow-200'));
  const labels = {
    spawn_confirmed: 'Spawn confirmed',
    spawn_failed: 'Spawn failed',
    spawn_refused: 'Spawn refused',
    spawn_attempted: 'Spawn attempted',
    activated: 'Activated',
    provisioned: 'Provisioned',
    inactive: 'Inactive',
    evidence_unavailable: 'Spawn evidence unavailable',
    awaiting_spawn_evidence: 'Awaiting spawn confirmation',
  };
  const label = fulfillment?.label || labels[state] || labels.awaiting_spawn_evidence;
  const icon = state === 'spawn_confirmed' ? '✅' : (state === 'spawn_failed' ? '⚠️' : '⏳');
  return '<span class="' + classes + ' text-xs px-2 py-0.5 rounded">' + icon + ' ' + escapeHtml(label) + '</span>';
}

/** Fetch and render line items for an order into its detail row. */
async function loadOrderItems(orderId, detailTr) {
  const generation = adminContextGeneration;
  const serverId = currentServerId;
  try {
    const res = await fetch('/api/shop/admin/orders/' + orderId + '/items');
    if (!res.ok) throw new Error('Failed');
    const json = await res.json();
    if (generation !== adminContextGeneration || serverId !== currentServerId) return;
    const items = json.data || json;
    orderEvidenceById.set(String(orderId), {
      items,
      payment_allocations: json.payment_allocations || [],
      consumption_events: json.consumption_events || [],
      refund_decisions: json.refund_decisions || [],
    });

    if (!items.length) {
      detailTr.innerHTML = '<td colspan="7" class="py-2 px-6 text-gray-400 text-xs">No line items found.</td>';
      return;
    }

    const rows = items.map(i => {
      const rentalUsage = i.item_type === 'event_rental'
        ? '<div class="mt-1 text-purple-300">Purchased ' + i.purchased_restarts +
          ' · Consumed ' + i.consumed_restarts + ' · Remaining ' + Number(i.restarts_remaining || 0) + '</div>' +
          (!i.evidence_history_available
            ? '<div class="text-amber-300">Legacy/incomplete event history — current counters are authoritative.</div>'
            : '<div class="text-gray-500">' + i.consumption_events.length + ' scheduled restart event(s) documented.</div>')
        : '';
      const evidenceTime = latestEvidenceTimestamp(
        i.fulfillment?.confirmedAt,
        i.fulfillment?.observedAt,
        (i.consumption_events || []).flatMap(event => [event.consumed_at, event.detected_at])
      );
      return '<tr class="text-xs text-gray-300 align-top">' +
        '<td class="py-1 px-3 text-gray-500">' + (i.image_url ? '<img src="' + escapeHtml(i.image_url) + '" class="h-6 w-6 inline rounded" alt="">' : '') + '</td>' +
        '<td class="py-1 px-3 font-medium" colspan="3">' + escapeHtml(i.item_name || '') +
          '<div class="text-gray-500">Line #' + i.id + ' · ' + escapeHtml(i.item_type || '') + '</div>' + rentalUsage + '</td>' +
        '<td class="py-1 px-3 text-gray-400">x' + (i.quantity || 1) + ' &times; ' + formatPrice(i.unit_price) +
          '<div class="text-green-300">Paid ' + formatPrice(multiplyMoneyText(i.unit_price, i.quantity || 1)) + '</div></td>' +
        '<td class="py-1 px-3 text-gray-500">(' + [i.pos_x, i.pos_y, i.pos_z].map(v => escapeHtml(v ?? '?')).join(', ') + ')</td>' +
        '<td class="py-1 px-3">' + adminFulfillmentBadge(i.fulfillment) +
          '<div class="text-gray-500 mt-1">Evidence: ' + (evidenceTime ? new Date(evidenceTime).toLocaleString() : 'Unknown') + '</div></td>' +
      '</tr>';
    }).join('');
    const allocations = (json.payment_allocations || []).length
      ? json.payment_allocations.map(a => escapeHtml(a.account_type) + ' ' + formatPrice(a.amount)).join(' · ')
      : 'Unavailable for legacy order';
    const refund = (json.refund_decisions || [])[0];
    const refundSummary = refund
      ? '<div class="mt-2 text-blue-200">Refund ' + formatPrice(refund.approved_amount) +
        ' (' + escapeHtml(refund.payment_status) + ') · calculated ' + formatPrice(refund.calculated_amount) +
        ' · ' + new Date(refund.payment_status_at || refund.decided_at).toLocaleString() + '</div>'
      : '';

    detailTr.innerHTML =
      '<td colspan="7" class="pb-2 px-3">' +
        '<div class="px-3 py-2 text-xs text-cyan-200">Payment allocation: ' + allocations + '</div>' +
        '<table class="w-full">' + rows + '</table>' + refundSummary +
      '</td>';
  } catch (err) {
    if (generation !== adminContextGeneration || serverId !== currentServerId) return;
    console.error('loadOrderItems:', err);
    detailTr.innerHTML = '<td colspan="7" class="py-2 px-6 text-red-400 text-xs">Failed to load items.</td>';
  }
}

async function refundOrder(orderId) {
  const mutationGeneration = adminContextGeneration;
  const mutationServerId = currentServerId;
  try {
    const evidenceRes = await fetch('/api/shop/admin/orders/' + orderId + '/items');
    if (!evidenceRes.ok) throw new Error('Failed to load refund evidence');
    const evidence = await evidenceRes.json();
    if (mutationGeneration !== adminContextGeneration || mutationServerId !== currentServerId) return;
    const items = evidence.data || [];
    const calculatedRefundCents = sumRefundAmounts(items.map(item => {
      const unitCents = refundAmountCents(item.unit_price);
      if (unitCents === null) return null;
      const units = item.item_type === 'event_rental'
        ? Number(item.restarts_remaining || 0)
        : (item.is_active ? Number(item.quantity || 1) : 0);
      return Number.isSafeInteger(units) && units >= 0 ? unitCents * BigInt(units) : null;
    }), true);
    if (calculatedRefundCents === null) {
      alert('Refund evidence contains an invalid monetary value.');
      return;
    }
    const calculatedRefund = moneyTextFromCents(calculatedRefundCents);
    const paymentAllocations = evidence.payment_allocations || [];
    const paidAmountCents = sumRefundAmounts(items.map(item => {
      const unitCents = refundAmountCents(item.unit_price);
      return unitCents === null ? null : unitCents * BigInt(Number(item.quantity || 1));
    }), true);
    const allocatedCents = sumRefundAmounts(paymentAllocations.map(allocation => allocation.amount));
    const paymentEvidenceComplete = paymentAllocations.length > 0 && paidAmountCents !== null &&
      allocatedCents === paidAmountCents;
    const evidenceOverrideRequired = !paymentEvidenceComplete ||
      items.some(item => item.item_type === 'event_rental' && !item.evidence_history_available);
    const reasonCode = prompt(
      'Refund reason code:\nprovider_failure, service_outage, accidental_purchase, duplicate_order, goodwill, other',
      'provider_failure'
    );
    if (reasonCode === null) return;
    const approvedAmountText = prompt(
      'Calculated refund for unused value: ' + formatPrice(calculatedRefund) +
      '\nEnter the approved refund amount. A different amount is a documented override.',
      calculatedRefund
    );
    if (approvedAmountText === null) return;
    const approvedAmount = normalizeRefundAmountText(approvedAmountText);
    if (approvedAmount === null) {
      alert('Enter a valid non-negative amount with at most two decimal places.');
      return;
    }
    const calculatedAmount = calculatedRefund;
    const amountOverride = approvedAmount !== calculatedAmount;
    const override = amountOverride || evidenceOverrideRequired;
    const adminNote = prompt(
      override
        ? (evidenceOverrideRequired
          ? 'Payment or restart evidence is incomplete. Document why this refund is still approved (at least 10 characters):'
          : 'Override reason (required, at least 10 characters):')
        : 'Administrator note (optional):',
      ''
    );
    if (adminNote === null) return;
    if (override && adminNote.trim().length < 10) {
      alert('A documented override note of at least 10 characters is required.');
      return;
    }
    const usage = items.filter(item => item.item_type === 'event_rental').map(item =>
      (item.item_name || ('Line #' + item.id)) + ': ' + item.consumed_restarts + ' consumed, ' +
      item.restarts_remaining + ' remaining'
    ).join('\n');
    if (!confirm(
      'Approve refund of ' + formatPrice(approvedAmount) + ' for order #' + orderId + '?\n' +
      'Calculated unused value: ' + formatPrice(calculatedRefund) + '\n' + usage +
      '\n\nThis removes active fulfillment and records an immutable decision.'
    )) return;

    const res = await fetchWithCsrf('/api/shop/admin/orders/' + orderId + '/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reason_code: reasonCode.trim(),
        admin_note: adminNote.trim(),
        approved_amount: approvedAmount,
        override,
      }),
    });
    if (mutationGeneration !== adminContextGeneration || mutationServerId !== currentServerId) return;
    const payload = await res.json().catch(() => ({}));
    if (mutationGeneration !== adminContextGeneration || mutationServerId !== currentServerId) return;
    if (!res.ok) throw new Error(payload.error || 'Failed to refund');
    alert(payload.data?.deferred
      ? 'Refund approved. Payment is pending because the destination wallet cannot currently accept the credit.'
      : 'Refund approved and credited to the player wallet.');
    orderEvidenceById.delete(String(orderId));
    loadOrders();
    loadRentals();
  } catch (err) {
    if (mutationGeneration !== adminContextGeneration || mutationServerId !== currentServerId) return;
    console.error('refundOrder:', err);
    alert('Refund failed: ' + err.message);
  }
}

// ── Active Rentals ─────────────────────────────────────────────────────────
async function loadRentals() {
  const requestId = nextAdminRequestId('rentals');
  const tbody = document.getElementById('rentals-tbody');
  const generation = adminContextGeneration;
  const serverId = currentServerId;
  tbody.innerHTML = '<tr><td colspan="9" class="text-center py-4 text-gray-400">Loading\u2026</td></tr>';

  try {
    const res = await fetch('/api/shop/admin/rentals/' + serverId);
    if (!res.ok) throw new Error('Failed');
    const json = await res.json();
    if (requestId !== adminRequestSequence.rentals || generation !== adminContextGeneration ||
        serverId !== currentServerId) return;
    const rentals = json.data || json;

    if (!rentals.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="text-center py-4 text-gray-400">No active rentals.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    rentals.forEach(r => {
      const tr = document.createElement('tr');
      tr.className = 'border-b border-gray-700 align-top';
      const evidenceTime = latestEvidenceTimestamp(r.fulfillment?.confirmedAt, r.fulfillment?.observedAt, r.last_consumed_at);
      const historyComplete = Number(r.documented_consumption_count || 0) === Number(r.consumed_restarts || 0);
      tr.innerHTML =
        '<td class="py-2 px-3">' + escapeHtml(r.player_name || r.identity_id) +
          '<div class="text-xs text-gray-500">Identity #' + r.identity_id + '</div></td>' +
        '<td class="py-2 px-3">' + escapeHtml(r.item_name || '') +
          '<div class="text-xs text-gray-500">Order #' + r.order_id + ' · Line #' + r.id + '</div></td>' +
        '<td class="py-2 px-3">' + adminFulfillmentBadge(r.fulfillment) +
          '<div class="text-xs text-gray-500">Evidence: ' + (evidenceTime ? new Date(evidenceTime).toLocaleString() : 'Unknown') + '</div>' +
          (!historyComplete ? '<div class="text-xs text-amber-300">Legacy/incomplete restart history</div>' : '') + '</td>' +
        '<td class="py-2 px-3">' + Number(r.purchased_restarts) + '</td>' +
        '<td class="py-2 px-3">' + Number(r.consumed_restarts) + '</td>' +
        '<td class="py-2 px-3">' + Number(r.restarts_remaining) + '</td>' +
        '<td class="py-2 px-3 text-green-300">' + formatPrice(r.paid_amount) + '</td>' +
        '<td class="py-2 px-3 text-cyan-300">' + formatPrice(r.calculated_refund) + '</td>' +
        '<td class="py-2 px-3 text-gray-400">' +
          (r.checked_out_at ? new Date(r.checked_out_at).toLocaleString() : 'Unknown') + '</td>';
      tbody.appendChild(tr);
    });
  } catch (err) {
    if (requestId !== adminRequestSequence.rentals || generation !== adminContextGeneration ||
        serverId !== currentServerId) return;
    console.error('loadRentals:', err);
    tbody.innerHTML = '<tr><td colspan="9" class="text-center py-4 text-red-400">Failed to load rentals.</td></tr>';
  }
}

// ── Trusted radar audit ─────────────────────────────────────────────────────

async function loadRadarAudit() {
  const requestId = nextAdminRequestId('radarAudit');
  if (!currentServerId) return;
  const generation = adminContextGeneration;
  const serverId = currentServerId;
  const tbody = document.getElementById('radar-audit-tbody');
  const summary = document.getElementById('radar-activation-summary');
  tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-gray-400">Loading\u2026</td></tr>';

  try {
    const res = await fetch('/api/radar/admin/' + serverId);
    if (!res.ok) throw new Error('Failed');
    const json = await res.json();
    if (requestId !== adminRequestSequence.radarAudit || generation !== adminContextGeneration ||
        serverId !== currentServerId) return;
    const data = json.data || {};
    const activations = data.activations || [];
    const events = data.syntheticEvents || [];
    const activeCount = activations.filter(row => row.status === 'active').length;
    summary.textContent = activeCount + ' active of ' + activations.length +
      ' retained capability activations; ' + events.length + ' jammer audit events shown.';

    if (!events.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-gray-400">No persisted jammer activity.</td></tr>';
      return;
    }
    tbody.innerHTML = events.map(event =>
      '<tr class="border-b border-gray-700">' +
        '<td class="py-2 px-3 text-amber-300">' + escapeHtml(event.source_type || 'jammer') + '</td>' +
        '<td class="py-2 px-3">' + escapeHtml(event.display_name || '') + '</td>' +
        '<td class="py-2 px-3">' + escapeHtml(event.action || '') + '</td>' +
        '<td class="py-2 px-3 text-gray-400">' + Number(event.pos_x).toFixed(1) + ', ' + Number(event.pos_y).toFixed(1) + '</td>' +
        '<td class="py-2 px-3 text-gray-400">' + new Date(event.bucket_start).toLocaleString() + '</td>' +
      '</tr>'
    ).join('');
  } catch (err) {
    if (requestId !== adminRequestSequence.radarAudit || generation !== adminContextGeneration ||
        serverId !== currentServerId) return;
    console.error('loadRadarAudit:', err);
    summary.textContent = 'Trusted radar audit unavailable.';
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-red-400">Failed to load radar audit.</td></tr>';
  }
}

// ── Analytics ──────────────────────────────────────────────────────────────
async function loadAnalytics() {
  const requestId = nextAdminRequestId('analytics');
  if (!currentServerId) return;
  const generation = adminContextGeneration;
  const serverId = currentServerId;

  // Reset stat cards to loading state
  ['stat-revenue', 'stat-orders', 'stat-items', 'stat-rentals'].forEach(id => {
    document.getElementById(id).textContent = '\u2026';
  });
  document.getElementById('order-breakdown').innerHTML = '<div class="text-gray-400">Loading\u2026</div>';
  document.getElementById('top-items-list').innerHTML  = '<div class="text-gray-400">Loading\u2026</div>';

  try {
    const res = await fetch('/api/shop/admin/stats/' + serverId);
    if (!res.ok) throw new Error('Failed');
    const json = await res.json();
    if (requestId !== adminRequestSequence.analytics || generation !== adminContextGeneration ||
        serverId !== currentServerId) return;
    const d = json.data || json;

    document.getElementById('stat-revenue').textContent = '\uD83D\uDCB0 ' + formatPrice(d.total_revenue);
    document.getElementById('stat-orders').textContent  = d.total_orders || 0;
    document.getElementById('stat-items').textContent   = (d.active_items || 0) + ' / ' + (d.total_items || 0);
    document.getElementById('stat-rentals').textContent = d.active_rentals || 0;

    // Order breakdown
    document.getElementById('order-breakdown').innerHTML =
      '<div class="flex justify-between py-1 border-b border-gray-700">' +
        '<span class="text-gray-400">Completed</span>' +
        '<span class="text-green-400">' + (d.completed_orders || 0) + '</span></div>' +
      '<div class="flex justify-between py-1 border-b border-gray-700">' +
        '<span class="text-gray-400">Refunded</span>' +
        '<span class="text-red-400">' + (d.refunded_orders || 0) + '</span></div>' +
      '<div class="flex justify-between py-1">' +
        '<span class="text-gray-400">Expired</span>' +
        '<span class="text-yellow-400">' + (d.expired_orders || 0) + '</span></div>';

    // Top items
    const topItems = d.top_items || [];
    if (!topItems.length) {
      document.getElementById('top-items-list').innerHTML = '<div class="text-gray-400">No sales data yet.</div>';
    } else {
      document.getElementById('top-items-list').innerHTML = topItems.map((item, i) =>
        '<div class="flex justify-between items-center py-1 border-b border-gray-700 last:border-0">' +
          '<span>' +
            '<span class="text-gray-500 mr-2">#' + (i + 1) + '</span>' +
            escapeHtml(item.name) +
            ' <span class="text-xs text-gray-500">(' + escapeHtml(item.item_type) + ')</span>' +
          '</span>' +
          '<span class="text-right">' +
            '<span class="text-blue-300">' + item.total_sold + ' sold</span>' +
            '<span class="text-green-400 ml-3">\uD83D\uDCB0 ' + formatPrice(item.total_revenue) + '</span>' +
          '</span>' +
        '</div>'
      ).join('');
    }
  } catch (err) {
    if (requestId !== adminRequestSequence.analytics || generation !== adminContextGeneration ||
        serverId !== currentServerId) return;
    console.error('loadAnalytics:', err);
    document.getElementById('order-breakdown').innerHTML = '<div class="text-red-400">Failed to load analytics.</div>';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function moneyTextFromCents(cents) {
  return String(cents / 100n) + '.' + String(cents % 100n).padStart(2, '0');
}

function formatPrice(val) {
  if (val == null) return '0';
  const cents = refundAmountCents(val);
  if (cents === null) return '0';
  const canonical = moneyTextFromCents(cents);
  const [integer, fraction] = canonical.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === '00' ? grouped : `${grouped}.${fraction.replace(/0$/, '')}`;
}

function refundAmountCents(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!match) return null;
  const cents = (BigInt(match[1]) * 100n) + BigInt((match[2] || '').padEnd(2, '0'));
  return cents <= 99999999999999999999n ? cents : null;
}

function multiplyMoneyText(value, quantity) {
  const cents = refundAmountCents(value);
  const units = Number(quantity);
  if (cents === null || !Number.isSafeInteger(units) || units < 0) return null;
  const total = cents * BigInt(units);
  return total <= 99999999999999999999n ? moneyTextFromCents(total) : null;
}

function normalizeRefundAmountText(value) {
  const cents = refundAmountCents(value);
  return cents === null ? null : moneyTextFromCents(cents);
}

function sumRefundAmounts(values, valuesAreCents = false) {
  let total = 0n;
  for (const value of values) {
    const cents = valuesAreCents ? value : refundAmountCents(value);
    if (typeof cents !== 'bigint') return null;
    total += cents;
    if (total > 99999999999999999999n) return null;
  }
  return total;
}

function latestEvidenceTimestamp(...values) {
  const timestamps = values.flat()
    .filter(Boolean)
    .map(value => new Date(value).getTime())
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)) : null;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusClass(status) {
  const map = {
    completed: 'bg-green-800 text-green-200',
    pending:   'bg-yellow-800 text-yellow-200',
    refunded:  'bg-red-800 text-red-200',
    expired:   'bg-gray-600 text-gray-300',
  };
  return map[status] || 'bg-gray-700 text-gray-300';
}
