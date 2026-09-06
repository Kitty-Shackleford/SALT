/*
 * DayZ Dashboard - Player Shop
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 */

// ── State ──────────────────────────────────────────────────────────────────
let currentServerId   = null;
let currentIdentityId = null;
let shopContextGeneration = 0;
const shopRequestSequence = Object.create(null);
function nextShopRequestId(family) {
  shopRequestSequence[family] = (shopRequestSequence[family] || 0) + 1;
  return shopRequestSequence[family];
}
let cartItems = [];      // current cart line items
let currentCheckoutCommand = null; // server-issued identity for the rendered cart
let atcItem   = null;    // item being added via the modal
let atcModalToken = 0;   // distinct identity for each modal lifecycle
let displayedCatalogServerId = null;
let emoteCapturePollTimer = null;

const {
  CHECKOUT_STATES,
  createCheckoutAttemptRegistry,
  createCheckoutStateMachine,
  resolveCheckoutOutcome,
} = window.CheckoutState;
const checkoutAttempts = createCheckoutAttemptRegistry();
const checkoutOutcomes = new Map();
let checkoutMachine;

function checkoutContextKey(serverId = currentServerId, identityId = currentIdentityId) {
  return serverId && identityId ? `${serverId}:${identityId}` : null;
}

function renderCheckoutState(state, _detail, view) {
  const button = document.getElementById('checkoutBtn');
  const spinner = document.getElementById('checkout-spinner');
  const label = document.getElementById('checkout-label');
  const status = document.getElementById('checkout-status');
  if (!button || !spinner || !label || !status) return;

  button.disabled = view.disabled;
  button.setAttribute('aria-busy', String(view.busy));
  button.dataset.checkoutState = state;
  spinner.classList.toggle('hidden', !view.busy);
  label.textContent = view.buttonLabel;
  status.textContent = view.message;
  status.classList.toggle('hidden', !view.message);
  status.classList.remove('text-gray-300', 'text-green-300', 'text-red-300', 'text-yellow-300');
  const statusClass = state === CHECKOUT_STATES.SUCCESS
    ? 'text-green-300'
    : (state === CHECKOUT_STATES.FAILED ? 'text-red-300'
      : ([CHECKOUT_STATES.RECOVERY, CHECKOUT_STATES.UNKNOWN].includes(state)
        ? 'text-yellow-300' : 'text-gray-300'));
  status.classList.add(statusClass);
}

function setCheckoutState(state, detail = {}) {
  checkoutMachine.reset();
  if (state === CHECKOUT_STATES.IDLE) return;
  checkoutMachine.transition(CHECKOUT_STATES.CHECKING);
  if (state === CHECKOUT_STATES.CHECKING) {
    checkoutMachine.update(detail);
  } else {
    checkoutMachine.transition(state, detail);
  }
}

function syncCheckoutStateToContext() {
  const contextKey = checkoutContextKey();
  if (contextKey && checkoutAttempts.has(contextKey)) {
    setCheckoutState(CHECKOUT_STATES.PROCESSING, {
      message: 'This checkout is still processing. Please wait before trying again.',
    });
    return;
  }
  const previousOutcome = contextKey && checkoutOutcomes.get(contextKey);
  setCheckoutState(previousOutcome?.state || CHECKOUT_STATES.IDLE, previousOutcome?.detail);
}

function resetCheckoutForCartMutation(contextKey) {
  checkoutOutcomes.delete(contextKey);
  if (contextKey === checkoutContextKey() && !checkoutAttempts.has(contextKey)) {
    setCheckoutState(CHECKOUT_STATES.IDLE);
  }
}

// ── Initialise on DOM ready ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkoutMachine = createCheckoutStateMachine(renderCheckoutState);
  loadServers();
  loadIdentities();
  setupTabListeners();
  setupAtcModal();

  document.getElementById('serverSelect').addEventListener('change', onSelectorsChange);
  document.getElementById('identitySelect').addEventListener('change', onSelectorsChange);
  document.getElementById('checkoutBtn')?.addEventListener('click', checkout);
});

// ── Server / Identity selectors ─────────────────────────────────────────────

/** Populate server selector with servers that have active shop items. */
async function loadServers() {
  try {
    const res  = await fetch('/api/shop/servers');
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load servers');

    const sel = document.getElementById('serverSelect');
    sel.innerHTML = '<option value="">-- Select a server --</option>';
    (json.data || []).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.guild_name ? `${s.guild_name} › ${s.name}` : s.name;
      sel.appendChild(opt);
    });
  } catch (err) {
    console.error('loadServers:', err);
  }
}

/** Populate identity selector from the player's linked accounts. */
async function loadIdentities() {
  try {
    const res  = await fetch('/api/accounts/my-accounts');
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to load identities');

    const sel = document.getElementById('identitySelect');
    sel.innerHTML = '<option value="">-- Select identity --</option>';
    (json.accounts || []).forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.gamertag || a.dayz_name || a.steam_name || a.steam_id || `#${a.id}`;
      sel.appendChild(opt);
    });
  } catch (err) {
    console.error('loadIdentities:', err);
  }
}

/**
 * Called whenever the server or identity selector changes.
 * Refreshes items, balance, and cart badge.
 */
function onSelectorsChange() {
  shopContextGeneration++;
  clearTimeout(emoteCapturePollTimer);
  emoteCapturePollTimer = null;
  currentServerId   = document.getElementById('serverSelect').value   || null;
  currentIdentityId = document.getElementById('identitySelect').value || null;
  cartItems = [];
  currentCheckoutCommand = null;
  closeAtcModal();
  closeMapPicker();
  updateCartBadge(0);
  document.getElementById('balance-box').classList.add('hidden');
  document.getElementById('cart-empty').textContent =
    'Select a server and identity to view your cart.';
  document.getElementById('cart-empty').classList.remove('hidden');
  document.getElementById('cart-contents').classList.add('hidden');
  syncCheckoutStateToContext();

  document.getElementById('rentals-list').innerHTML =
    '<p class="text-gray-400 col-span-full text-center py-12">Select a server and identity to view active rentals.</p>';
  document.getElementById('orders-tbody').innerHTML =
    '<tr><td colspan="5" class="text-center py-4 text-gray-400">Select a server and identity to view orders.</td></tr>';
  if (currentServerId && currentIdentityId) {
    if (document.getElementById('tab-rentals').style.display === 'block') loadActiveRentals();
    if (document.getElementById('tab-orders').style.display === 'block') loadOrders();
  }

  if (currentServerId) {
    if (displayedCatalogServerId !== currentServerId) loadItems(currentServerId);
  } else {
    displayedCatalogServerId = null;
    document.getElementById('items-grid').innerHTML =
      '<p class="text-gray-400 col-span-full text-center py-12">Select a server to browse items.</p>';
  }

  if (currentServerId && currentIdentityId) {
    loadBalance();
    refreshCartBadge();
  } else {
    document.getElementById('balance-box').classList.add('hidden');
  }
}

// ── Balance display ─────────────────────────────────────────────────────────

async function loadBalance() {
  const requestId = nextShopRequestId('balance');
  const generation = shopContextGeneration;
  const identityId = currentIdentityId;
  const serverId = currentServerId;
  try {
    const res  = await fetch(`/api/shop/balance/${identityId}/${serverId}`);
    const json = await res.json();
    if (requestId !== shopRequestSequence.balance || generation !== shopContextGeneration ||
        identityId !== currentIdentityId || serverId !== currentServerId) return;
    if (!json.success) return;

    document.getElementById('bal-wallet').textContent = formatPrice(json.data.wallet);
    document.getElementById('bal-bank').textContent   = formatPrice(json.data.bank);
    document.getElementById('balance-box').classList.remove('hidden');
  } catch (err) {
    if (requestId !== shopRequestSequence.balance || generation !== shopContextGeneration ||
        identityId !== currentIdentityId || serverId !== currentServerId) return;
    console.error('loadBalance:', err);
  }
}

// ── Tab switching ──────────────────────────────────────────────────────────

function setupTabListeners() {
  document.getElementById('tab-btn-shop').addEventListener('click', () => showTab('shop'));
  document.getElementById('tab-btn-cart').addEventListener('click', () => {
    showTab('cart');
    loadCart();
  });
  document.getElementById('tab-btn-rentals').addEventListener('click', () => {
    showTab('rentals');
    loadActiveRentals();
  });
  document.getElementById('tab-btn-orders').addEventListener('click', () => {
    showTab('orders');
    loadOrders();
  });
}

function showTab(name) {
  ['shop', 'cart', 'rentals', 'orders'].forEach(t => {
    document.getElementById(`tab-${t}`).style.display = t === name ? 'block' : 'none';
    const btn = document.getElementById(`tab-btn-${t}`);
    btn.classList.toggle('bg-blue-600', t === name);
    btn.classList.toggle('font-semibold', t === name);
    btn.classList.toggle('bg-gray-700', t !== name);
    btn.classList.remove('hover:bg-gray-600');
    if (t !== name) btn.classList.add('hover:bg-gray-600');
  });
}

// ── Shop items ─────────────────────────────────────────────────────────────

/** Load and render shop items for the selected server. */
async function loadItems(serverId) {
  const requestId = nextShopRequestId('items');
  const grid = document.getElementById('items-grid');
  displayedCatalogServerId = null;
  grid.innerHTML = '<p class="text-gray-400 col-span-full text-center py-8">Loading items…</p>';

  try {
    const res  = await fetch(`/api/shop/items/${serverId}`);
    const json = await res.json();
    if (requestId !== shopRequestSequence.items || serverId !== currentServerId) return;
    if (!json.success) throw new Error(json.error || 'Failed to load items');
    const items = json.data || [];
    displayedCatalogServerId = serverId;

    if (!items.length) {
      grid.innerHTML = '<p class="text-gray-400 col-span-full text-center py-8">No items available.</p>';
      return;
    }

    grid.innerHTML = '';
    items.forEach(item => grid.appendChild(buildItemCard(item)));
  } catch (err) {
    if (requestId !== shopRequestSequence.items || serverId !== currentServerId) return;
    displayedCatalogServerId = null;
    console.error('loadItems:', err);
    grid.innerHTML = '<p class="text-red-400 col-span-full text-center py-8">Failed to load items.</p>';
  }
}

/** Build a single item card element. */
function buildItemCard(item) {
  const card = document.createElement('div');
  card.className = 'bg-gray-800 rounded-lg p-4 flex flex-col gap-2 border border-gray-700';

  const typeBadge = item.item_type === 'event_rental'
    ? `<span class="bg-purple-700 text-xs px-2 py-0.5 rounded">🔄 Rental${item.rental_restarts > 0 ? ` · max ${item.rental_restarts} restarts` : ''}</span>`
    : `<span class="bg-blue-800 text-xs px-2 py-0.5 rounded">📌 Permanent</span>`;

  const spawnBadge = item.spawn_method === 'event'
    ? `<span class="bg-yellow-800 text-xs px-2 py-0.5 rounded">⚡ Event Spawn</span>`
    : `<span class="bg-gray-700 text-xs px-2 py-0.5 rounded">${escapeHtml(item.spawn_method)}</span>`;

  const imageHtml = item.image_url
    ? `<img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.name)}"
           class="w-full h-32 object-contain mb-2 rounded">`
    : `<div class="w-full h-32 bg-gray-700 rounded flex items-center justify-center mb-2 text-4xl">📦</div>`;

  // "Spawns after restart" note for event items
  const spawnNote = item.spawn_method === 'event'
    ? '<p class="text-yellow-400 text-xs">⏳ Spawns after next server restart</p>'
    : '';

  card.innerHTML = `
    ${imageHtml}
    <div class="flex flex-wrap items-center gap-1.5">
      ${typeBadge}
      ${spawnBadge}
    </div>
    <h3 class="font-semibold text-lg leading-tight">${escapeHtml(item.name)}</h3>
    <p class="text-gray-400 text-sm flex-1">${escapeHtml(item.description || '')}</p>
    ${spawnNote}
    <p class="text-green-400 font-bold text-xl">💰 ${formatPrice(item.price)}</p>
    <button class="bg-green-600 hover:bg-green-700 px-4 py-2 rounded font-semibold add-btn mt-auto">
      Add to Cart
    </button>
  `;

  card.querySelector('.add-btn').addEventListener('click', () => openAtcModal(item));
  return card;
}

// ── Add-to-Cart modal ──────────────────────────────────────────────────────

function setupAtcModal() {
  document.getElementById('atc-cancel').addEventListener('click', closeAtcModal);
  document.getElementById('atc-confirm').addEventListener('click', confirmAddToCart);
  document.getElementById('atc-pick-map-btn').addEventListener('click', openMapPicker);

  // Close modal on backdrop click
  document.getElementById('atc-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('atc-modal')) closeAtcModal();
  });

  // When a preset is selected, fill coordinate inputs
  document.getElementById('atc-preset').addEventListener('change', () => {
    const sel  = document.getElementById('atc-preset');
    const opt  = sel.selectedOptions[0];
    if (!opt || !opt.dataset.x) return;
    document.getElementById('atc-pos-x').value = opt.dataset.x;
    document.getElementById('atc-pos-y').value = opt.dataset.y;
    document.getElementById('atc-pos-z').value = opt.dataset.z;
  });
}

/** Open the Add-to-Cart modal for a specific item. */
function openAtcModal(item) {
  if (!currentIdentityId) {
    alert('Please select an identity before adding items to the cart.');
    return;
  }
  if (!currentServerId) {
    alert('Please select a server first.');
    return;
  }

  atcModalToken++;
  atcItem = item;

  // Populate modal fields
  const imgEl = document.getElementById('atc-img');
  if (item.image_url) {
    imgEl.innerHTML = `<img src="${escapeHtml(item.image_url)}" class="w-full h-full object-contain rounded">`;
  } else {
    imgEl.textContent = '📦';
  }
  document.getElementById('atc-name').textContent  = item.name;
  document.getElementById('atc-qty').value          = '1';
  document.getElementById('atc-error').classList.add('hidden');

  // Configure quantity vs restarts field based on item type
  const isRental       = item.item_type === 'event_rental';
  const qtyLabel       = document.getElementById('atc-qty-label');
  const rentalPriceEl  = document.getElementById('atc-rental-price');
  const qtyHintEl      = document.getElementById('atc-qty-hint');
  const qtyInput       = document.getElementById('atc-qty');

  if (isRental) {
    qtyLabel.textContent  = 'Restarts (how long the rental lasts)';
    qtyInput.min          = '1';
    qtyInput.max          = item.rental_restarts > 0 ? item.rental_restarts : '';
    rentalPriceEl.textContent = `💰 ${formatPrice(item.price)} per restart`;
    rentalPriceEl.classList.remove('hidden');
    const cap = item.rental_restarts > 0 ? ` (max ${item.rental_restarts})` : '';
    qtyHintEl.textContent = `Total = ${formatPrice(item.price)} × restarts${cap}`;
    qtyHintEl.classList.remove('hidden');
    document.getElementById('atc-price').textContent = `💰 ${formatPrice(item.price)} per restart`;
  } else {
    qtyLabel.textContent  = 'Quantity';
    qtyInput.min          = '1';
    qtyInput.max          = '';
    rentalPriceEl.classList.add('hidden');
    qtyHintEl.classList.add('hidden');
    document.getElementById('atc-price').textContent = `💰 ${formatPrice(item.price)}`;
  }

  // Type badge
  const typeBadge = document.getElementById('atc-type-badge');
  if (isRental) {
    const cap = item.rental_restarts > 0 ? ` · max ${item.rental_restarts} restarts` : '';
    typeBadge.innerHTML = `<span class="bg-purple-800 text-purple-200 text-xs px-2 py-0.5 rounded">🔄 Rental${cap}</span>`;
  } else {
    typeBadge.innerHTML = `<span class="bg-blue-900 text-blue-200 text-xs px-2 py-0.5 rounded">📌 Permanent</span>`;
  }

  // Preset locations
  const presets      = item.preset_locations || [];
  const presetRow    = document.getElementById('atc-preset-row');
  const presetSel    = document.getElementById('atc-preset');
  const posX         = document.getElementById('atc-pos-x');
  const posY         = document.getElementById('atc-pos-y');
  const posZ         = document.getElementById('atc-pos-z');
  const hint         = document.getElementById('atc-location-hint');

  posX.value = '';
  posY.value = '';
  posZ.value = '';

  if (presets.length) {
    presetRow.classList.remove('hidden');
    presetSel.innerHTML = '<option value="">-- Pick a preset location --</option>';
    presets.forEach(p => {
      const opt = document.createElement('option');
      opt.value       = p.id;
      opt.textContent = p.label;
      opt.dataset.x   = p.pos_x;
      opt.dataset.y   = p.pos_y;
      opt.dataset.z   = p.pos_z;
      presetSel.appendChild(opt);
    });
    hint.textContent = 'Pick a preset or enter custom coordinates.';
  } else {
    presetRow.classList.add('hidden');
    presetSel.innerHTML = '';
    hint.textContent = item.spawn_method === 'event'
      ? 'Enter the in-game coordinates where this item should spawn.'
      : 'Enter spawn coordinates.';
  }

  document.getElementById('atc-modal').classList.add('open');
}

function closeAtcModal() {
  atcModalToken++;
  document.getElementById('atc-modal').classList.remove('open');
  atcItem = null;
}

/** Confirm "Add to Cart" from the modal. */
async function confirmAddToCart() {
  const errEl = document.getElementById('atc-error');
  const generation = shopContextGeneration;
  const identityId = currentIdentityId;
  const serverId = currentServerId;
  const contextKey = checkoutContextKey(serverId, identityId);
  const item = atcItem;
  const modalToken = atcModalToken;
  errEl.classList.add('hidden');

  const qty  = parseInt(document.getElementById('atc-qty').value, 10) || 1;
  const posX = parseFloat(document.getElementById('atc-pos-x').value) || 0;
  const posY = parseFloat(document.getElementById('atc-pos-y').value) || 0;
  const posZ = parseFloat(document.getElementById('atc-pos-z').value) || 0;

  // Validate rental restarts
  const isRental = item?.item_type === 'event_rental';
  if (isRental) {
    if (qty < 1) {
      errEl.textContent = 'Please enter at least 1 restart.';
      errEl.classList.remove('hidden');
      return;
    }
    const maxRestarts = item.rental_restarts || 0;
    if (maxRestarts > 0 && qty > maxRestarts) {
      errEl.textContent = `Maximum ${maxRestarts} restarts allowed for this item.`;
      errEl.classList.remove('hidden');
      return;
    }
  }

  // For event items with presets, require a location
  const presets = item?.preset_locations || [];
  const presetSel = document.getElementById('atc-preset');
  if (item?.spawn_method === 'event' && presets.length && !presetSel.value) {
    if (!posX && !posY && !posZ) {
      errEl.textContent = 'Please select a preset location or enter coordinates.';
      errEl.classList.remove('hidden');
      return;
    }
  }

  try {
    const res = await fetchWithCsrf('/api/shop/cart/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identityId,
        serverId,
        shopItemId: item.id,
        quantity:   qty,
        pos_x: posX,
        pos_y: posY,
        pos_z: posZ,
      }),
    });
    const json = await res.json();
    if (generation !== shopContextGeneration || identityId !== currentIdentityId ||
        serverId !== currentServerId || item !== atcItem || modalToken !== atcModalToken) return;
    if (!res.ok) throw new Error(json.error || 'Failed to add to cart');

    closeAtcModal();
    resetCheckoutForCartMutation(contextKey);
    showToast('Item added to cart! 🛒');
    refreshCartBadge();
  } catch (err) {
    if (generation !== shopContextGeneration || identityId !== currentIdentityId ||
        serverId !== currentServerId || item !== atcItem || modalToken !== atcModalToken) return;
    console.error('confirmAddToCart:', err);
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

// ── Cart ────────────────────────────────────────────────────────────────────

/** Load and render the cart for the current identity + server. */
async function loadCart() {
  const requestId = nextShopRequestId('cart');
  clearTimeout(emoteCapturePollTimer);
  emoteCapturePollTimer = null;
  const emptyEl    = document.getElementById('cart-empty');
  const contentsEl = document.getElementById('cart-contents');
  const tbody      = document.getElementById('cart-tbody');
  const totalEl    = document.getElementById('cart-total');
  const generation = shopContextGeneration;
  const identityId = currentIdentityId;
  const serverId = currentServerId;
  currentCheckoutCommand = null;

  if (!identityId || !serverId) {
    emptyEl.textContent = 'Select a server and identity to view your cart.';
    emptyEl.classList.remove('hidden');
    contentsEl.classList.add('hidden');
    return;
  }

  emptyEl.textContent = 'Loading…';
  emptyEl.classList.remove('hidden');
  contentsEl.classList.add('hidden');

  try {
    const res  = await fetch(`/api/shop/cart/${identityId}/${serverId}`);
    const json = await res.json();
    if (requestId !== shopRequestSequence.cart || generation !== shopContextGeneration ||
        identityId !== currentIdentityId || serverId !== currentServerId) return;
    if (!json.success) throw new Error(json.error || 'Failed to load cart');

    const cart = json.data;
    if (!cart || !(cart.items || []).length) {
      emptyEl.textContent = 'Your cart is empty.';
      cartItems = [];
      updateCartBadge(0);
      return;
    }
    const cartId = Number(cart.id);
    if (!Number.isSafeInteger(cartId) || cartId < 1 ||
        !/^[a-f0-9]{64}$/.test(cart.checkoutFingerprint || '')) {
      throw new Error('Cart checkout identity is invalid');
    }

    currentCheckoutCommand = {
      identityId,
      serverId,
      cartId,
      cartFingerprint: cart.checkoutFingerprint,
    };
    cartItems = cart.items;
    updateCartBadge(cartItems.length);

    tbody.innerHTML = '';
    let totalCents = 0n;
    cartItems.forEach(ci => {
      const lineCents = moneyProductCents(ci.unit_price, ci.quantity || 1);
      if (lineCents === null || totalCents + lineCents > 99999999999999999999n) {
        throw new Error('Cart contains an invalid monetary value');
      }
      totalCents += lineCents;
      tbody.appendChild(buildCartRow(ci));
    });
    totalEl.textContent = formatPrice(moneyTextFromCents(totalCents));

    emptyEl.classList.add('hidden');
    contentsEl.classList.remove('hidden');
    if (cartItems.some(item => item.emote_capture?.status === 'pending')) {
      const pollGeneration = shopContextGeneration;
      const pollIdentityId = currentIdentityId;
      const pollServerId = currentServerId;
      emoteCapturePollTimer = setTimeout(() => {
        if (pollGeneration === shopContextGeneration && pollIdentityId === currentIdentityId
            && pollServerId === currentServerId
            && document.getElementById('tab-cart').style.display === 'block') {
          loadCart();
        }
      }, 5000);
    }
  } catch (err) {
    if (requestId !== shopRequestSequence.cart || generation !== shopContextGeneration ||
        identityId !== currentIdentityId || serverId !== currentServerId) return;
    console.error('loadCart:', err);
    emptyEl.textContent = 'Failed to load cart.';
    emptyEl.classList.remove('hidden');
    contentsEl.classList.add('hidden');
  }
}

function buildCartRow(ci) {
  const tr = document.createElement('tr');
  const rowGeneration = shopContextGeneration;
  const rowIdentityId = currentIdentityId;
  const rowServerId = currentServerId;
  tr.className = 'border-b border-gray-700';

  const typeBadge = ci.item_type === 'event_rental'
    ? `<span class="bg-purple-800 text-xs px-1.5 py-0.5 rounded">Rental</span>`
    : `<span class="bg-blue-900 text-xs px-1.5 py-0.5 rounded">Perm</span>`;

  // Display spawn location: show preformatted coordinates
  const locDisplay = (ci.pos_x || ci.pos_y || ci.pos_z)
    ? `<span class="text-gray-300 text-xs">(${Number(ci.pos_x).toFixed(1)}, ${Number(ci.pos_y).toFixed(1)}, ${Number(ci.pos_z).toFixed(1)})</span>`
    : `<span class="text-gray-500 text-xs">Not set</span>`;
  const captureConfig = ci.emote_capture_config_snapshot || {};
  const capture = ci.emote_capture;
  const emoteLabel = String(captureConfig.emoteType || '').replace(/^Emote/, '') || 'configured emote';
  const heldItemLabel = captureConfig.heldItem ? ` while holding ${escapeHtml(captureConfig.heldItem)}` : '';
  const captureStatus = capture?.status === 'pending'
    ? `<div class="mt-1 text-xs text-yellow-300">Waiting for ${escapeHtml(emoteLabel)}${heldItemLabel}…</div>`
    : (capture?.status === 'applied'
      ? '<div class="mt-1 text-xs text-green-300">In-game location captured ✓</div>'
      : (capture?.status === 'expired'
        ? '<div class="mt-1 text-xs text-gray-400">Capture expired — arm it again when ready.</div>'
        : (capture?.status === 'cancelled'
          ? '<div class="mt-1 text-xs text-gray-400">Capture cancelled.</div>'
          : '')));
  const captureButton = captureConfig.enabled === true
    ? `<button type="button" class="capture-emote-btn mt-1 rounded px-2 py-1 text-xs ${capture?.status === 'pending' ? 'bg-gray-700 hover:bg-gray-600' : 'bg-indigo-700 hover:bg-indigo-600'}">
         ${capture?.status === 'pending' ? 'Cancel capture' : 'Use in-game emote'}</button>`
    : '';

  tr.innerHTML = `
    <td class="py-2 px-3">
      <span class="font-medium">${escapeHtml(ci.item_name || '')}</span>
    </td>
    <td class="py-2 px-3">${typeBadge}</td>
    <td class="py-2 px-3">
      <input type="number" min="1" value="${ci.quantity}"
             class="bg-gray-700 border border-gray-600 rounded px-2 py-1 w-16 text-center qty-input">
    </td>
    <td class="py-2 px-3"><div>${locDisplay}</div>${captureStatus}${captureButton}</td>
    <td class="py-2 px-3 text-green-400 whitespace-nowrap">
      💰 ${formatPrice(moneyProductText(ci.unit_price, ci.quantity || 1))}
    </td>
    <td class="py-2 px-3">
      <button class="bg-red-700 hover:bg-red-600 px-3 py-1 rounded text-sm remove-btn">✕</button>
    </td>
  `;

  const qtyInput = tr.querySelector('.qty-input');
  let updateTimer;
  qtyInput.addEventListener('input', () => {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      if (rowGeneration !== shopContextGeneration || rowIdentityId !== currentIdentityId ||
          rowServerId !== currentServerId) return;
      updateCartItemQty(ci.id, parseInt(qtyInput.value, 10) || 1);
    }, 500);
  });

  tr.querySelector('.remove-btn').addEventListener('click', () => removeCartItem(ci.id, tr));
  tr.querySelector('.capture-emote-btn')?.addEventListener('click', event => {
    if (capture?.status === 'pending') {
      cancelEmoteCapture(ci.id, event.currentTarget);
    } else {
      armEmoteCapture(ci.id, captureConfig, event.currentTarget);
    }
  });
  return tr;
}

async function armEmoteCapture(cartItemId, captureConfig, button) {
  const generation = shopContextGeneration;
  const identityId = currentIdentityId;
  const serverId = currentServerId;
  const emoteLabel = String(captureConfig.emoteType || '').replace(/^Emote/, '');
  const heldItem = captureConfig.heldItem ? ` while holding ${captureConfig.heldItem}` : '';
  if (!confirm(`Arm this cart line?\n\nPerform ${emoteLabel}${heldItem} in game within 30 minutes. The captured location will be shown here for review before checkout.`)) {
    return;
  }
  button.disabled = true;
  button.textContent = 'Arming…';
  try {
    const res = await fetchWithCsrf(`/api/shop/cart/item/${cartItemId}/emote-capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityId, serverId }),
    });
    const json = await res.json().catch(() => ({}));
    if (generation !== shopContextGeneration || identityId !== currentIdentityId || serverId !== currentServerId) return;
    if (!res.ok) throw new Error(json.error || 'Failed to arm emote capture');
    showToast(`Waiting for ${emoteLabel}${heldItem}…`);
    loadCart();
  } catch (error) {
    if (generation !== shopContextGeneration || identityId !== currentIdentityId || serverId !== currentServerId) return;
    console.error('armEmoteCapture:', error);
    alert(error.message || 'Failed to arm emote capture.');
    button.disabled = false;
    button.textContent = 'Use in-game emote';
  }
}

async function cancelEmoteCapture(cartItemId, button) {
  const generation = shopContextGeneration;
  const identityId = currentIdentityId;
  const serverId = currentServerId;
  button.disabled = true;
  button.textContent = 'Cancelling…';
  try {
    const res = await fetchWithCsrf(`/api/shop/cart/item/${cartItemId}/emote-capture`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityId, serverId }),
    });
    const json = await res.json().catch(() => ({}));
    if (generation !== shopContextGeneration || identityId !== currentIdentityId || serverId !== currentServerId) return;
    if (!res.ok) throw new Error(json.error || 'Failed to cancel emote capture');
    showToast('Emote capture cancelled.');
    loadCart();
  } catch (error) {
    if (generation !== shopContextGeneration || identityId !== currentIdentityId || serverId !== currentServerId) return;
    console.error('cancelEmoteCapture:', error);
    alert(error.message || 'Failed to cancel emote capture.');
    loadCart();
  }
}

async function updateCartItemQty(cartItemId, quantity) {
  const generation = shopContextGeneration;
  const identityId = currentIdentityId;
  const serverId = currentServerId;
  const contextKey = checkoutContextKey(serverId, identityId);
  try {
    const res = await fetchWithCsrf(`/api/shop/cart/item/${cartItemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity }),
    });
    if (generation !== shopContextGeneration || identityId !== currentIdentityId || serverId !== currentServerId) return;
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to update cart quantity');
    }
    resetCheckoutForCartMutation(contextKey);
    // Refresh total after update
    loadCart();
  } catch (err) {
    if (generation !== shopContextGeneration || identityId !== currentIdentityId || serverId !== currentServerId) return;
    console.error('updateCartItemQty:', err);
    alert(err.message || 'Failed to update cart quantity.');
    loadCart();
  }
}

async function removeCartItem(cartItemId, rowEl) {
  const generation = shopContextGeneration;
  const identityId = currentIdentityId;
  const serverId = currentServerId;
  const contextKey = checkoutContextKey(serverId, identityId);
  try {
    const res = await fetchWithCsrf(`/api/shop/cart/item/${cartItemId}`, { method: 'DELETE' });
    if (generation !== shopContextGeneration || identityId !== currentIdentityId || serverId !== currentServerId) return;
    if (!res.ok) throw new Error('Failed to remove');
    resetCheckoutForCartMutation(contextKey);
    rowEl.remove();
    cartItems = cartItems.filter(ci => ci.id !== cartItemId);
    updateCartBadge(cartItems.length);
    if (!cartItems.length) loadCart(); // show empty state
  } catch (err) {
    if (generation !== shopContextGeneration || identityId !== currentIdentityId || serverId !== currentServerId) return;
    console.error('removeCartItem:', err);
    alert('Failed to remove item.');
  }
}

/** Checkout: process the current cart. */
async function checkout() {
  const generation = shopContextGeneration;
  const identityId = currentIdentityId;
  const serverId = currentServerId;
  const contextKey = checkoutContextKey(serverId, identityId);
  if (!identityId || !serverId) {
    alert('Select a server and identity before checking out.');
    return;
  }
  const previousOutcome = checkoutOutcomes.get(contextKey);
  const requestBody = previousOutcome?.requestBody || currentCheckoutCommand;
  if (!previousOutcome && !cartItems.length) {
    alert('Your cart is empty.');
    return;
  }
  if (!requestBody) {
    alert('Reload your cart before checking out.');
    return;
  }
  if (checkoutAttempts.has(contextKey)) {
    syncCheckoutStateToContext();
    return;
  }

  if (!confirm(`Confirm checkout?\n\nTotal: 💰 ${document.getElementById('cart-total').textContent}`)) return;

  const attempt = checkoutAttempts.begin(contextKey);
  if (!attempt) return;
  const idempotencyKey = previousOutcome?.idempotencyKey
    || globalThis.crypto?.randomUUID?.()
    || `shop-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  checkoutOutcomes.delete(contextKey);
  setCheckoutState(CHECKOUT_STATES.CHECKING);

  let slowTimer;
  try {
    checkoutMachine.transition(CHECKOUT_STATES.PROCESSING);
    slowTimer = setTimeout(() => {
      if (checkoutAttempts.has(contextKey) && contextKey === checkoutContextKey()) {
        checkoutMachine.update({ slow: true });
      }
    }, 4000);

    const res = await fetchWithCsrf('/api/shop/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(requestBody),
    });
    const responseText = await res.text();
    let json = {};
    let invalidResponse = false;
    try {
      json = JSON.parse(responseText);
      invalidResponse = !json || typeof json !== 'object' || Array.isArray(json);
      if (invalidResponse) json = {};
    } catch (_error) {
      invalidResponse = true;
    }
    const outcome = resolveCheckoutOutcome({
      responseOk: res.ok,
      responseStatus: res.status,
      checkoutState: json.checkoutState,
      invalidResponse,
    });
    const detail = {
      message: json.error || (outcome === CHECKOUT_STATES.UNKNOWN
        ? 'We could not confirm the final order status. Retry to check the same request safely.'
        : undefined),
    };
    if (outcome === CHECKOUT_STATES.RECOVERY || outcome === CHECKOUT_STATES.UNKNOWN) {
      checkoutOutcomes.set(contextKey, { state: outcome, detail, idempotencyKey, requestBody });
    }

    const contextChanged = generation !== shopContextGeneration;
    if (contextChanged && contextKey !== checkoutContextKey()) return;
    setCheckoutState(outcome, detail);
    if (outcome !== CHECKOUT_STATES.SUCCESS) {
      if (outcome === CHECKOUT_STATES.FAILED) console.error('checkout:', json.error || 'Checkout failed');
      return;
    }

    showToast('Order placed successfully! 🎉 Delivery timing and fulfillment evidence are shown in your order details.');
    cartItems = [];
    updateCartBadge(0);
    loadBalance();
    // Switch to orders tab to show the new order
    showTab('orders');
    loadOrders();
  } catch (err) {
    const detail = {
      message: 'We could not confirm the final order status. Retry to check the same request safely.',
    };
    checkoutOutcomes.set(contextKey, {
      state: CHECKOUT_STATES.UNKNOWN, detail, idempotencyKey, requestBody,
    });
    const contextChanged = generation !== shopContextGeneration;
    if (contextChanged && contextKey !== checkoutContextKey()) return;
    console.error('checkout:', err);
    setCheckoutState(resolveCheckoutOutcome({ networkError: true }), detail);
  } finally {
    clearTimeout(slowTimer);
    checkoutAttempts.finish(attempt);
  }
}

// ── Active Rentals ─────────────────────────────────────────────────────────

/** Load and display active event rentals. */
async function loadActiveRentals() {
  const requestId = nextShopRequestId('rentals');
  const listEl = document.getElementById('rentals-list');
  const generation = shopContextGeneration;
  const identityId = currentIdentityId;
  const serverId = currentServerId;

  if (!identityId || !serverId) {
    listEl.innerHTML = '<p class="text-gray-400 col-span-full text-center py-12">Select a server and identity to view active rentals.</p>';
    return;
  }

  listEl.innerHTML = '<p class="text-gray-400 col-span-full text-center py-8">Loading…</p>';

  try {
    const res  = await fetch(`/api/shop/active-rentals/${identityId}/${serverId}`);
    const json = await res.json();
    if (requestId !== shopRequestSequence.rentals || generation !== shopContextGeneration ||
        identityId !== currentIdentityId || serverId !== currentServerId) return;
    if (!json.success) throw new Error(json.error || 'Failed to load rentals');
    const rentals = json.data || [];

    if (!rentals.length) {
      listEl.innerHTML = '<p class="text-gray-400 col-span-full text-center py-12">No active rentals.</p>';
      return;
    }

    listEl.innerHTML = '';
    rentals.forEach(r => listEl.appendChild(buildRentalCard(r)));
  } catch (err) {
    if (requestId !== shopRequestSequence.rentals || generation !== shopContextGeneration ||
        identityId !== currentIdentityId || serverId !== currentServerId) return;
    console.error('loadActiveRentals:', err);
    listEl.innerHTML = '<p class="text-red-400 col-span-full text-center py-8">Failed to load rentals.</p>';
  }
}

function fulfillmentBadge(fulfillment) {
  const state = fulfillment?.state || 'awaiting_spawn_evidence';
  const styles = {
    spawn_confirmed: 'bg-green-800 text-green-200',
    spawn_failed: 'bg-red-800 text-red-200',
    spawn_refused: 'bg-orange-900 text-orange-200',
    spawn_attempted: 'bg-yellow-800 text-yellow-200',
    activated: 'bg-green-800 text-green-200',
    provisioned: 'bg-blue-900 text-blue-200',
    inactive: 'bg-gray-700 text-gray-300',
    evidence_unavailable: 'bg-gray-700 text-gray-300',
    awaiting_spawn_evidence: 'bg-yellow-900 text-yellow-200',
  };
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
  return `<span class="${styles[state] || styles.awaiting_spawn_evidence} text-xs px-2 py-0.5 rounded">${icon} ${escapeHtml(label)}</span>`;
}

function buildRentalCard(r) {
  const card = document.createElement('div');
  card.className = 'bg-gray-800 rounded-lg p-4 border border-purple-700 flex flex-col gap-2';

  const imgHtml = r.image_url
    ? `<img src="${escapeHtml(r.image_url)}" class="w-full h-24 object-contain rounded mb-1">`
    : `<div class="w-full h-24 bg-gray-700 rounded flex items-center justify-center text-4xl mb-1">📦</div>`;

  const loc = (r.pos_x || r.pos_y || r.pos_z)
    ? `📍 (${Number(r.pos_x).toFixed(1)}, ${Number(r.pos_y).toFixed(1)}, ${Number(r.pos_z).toFixed(1)})`
    : '';

  const historyComplete = Number(r.documented_consumption_count || 0) === Number(r.consumed_restarts || 0);
  const evidenceTime = latestEvidenceTimestamp(r.fulfillment?.confirmedAt, r.fulfillment?.observedAt, r.last_consumed_at);
  card.innerHTML = `
    ${imgHtml}
    <h3 class="font-semibold">${escapeHtml(r.item_name)}</h3>
    <p class="text-gray-500 text-xs">Order #${r.order_id} · Rental line #${r.id}</p>
    <div class="flex items-center gap-2 flex-wrap">
      <span class="bg-purple-800 text-xs px-2 py-0.5 rounded">🔄 Active Rental</span>
      ${fulfillmentBadge(r.fulfillment)}
    </div>
    <div class="grid grid-cols-3 gap-2 text-center text-xs bg-gray-900 rounded p-2">
      <div><span class="block text-gray-500">Purchased</span>${r.purchased_restarts}</div>
      <div><span class="block text-gray-500">Consumed</span>${r.consumed_restarts}</div>
      <div><span class="block text-gray-500">Scheduled restarts remaining</span>${r.restarts_remaining}</div>
    </div>
    <div class="text-xs text-gray-300">Paid: 💰 ${formatPrice(r.paid_amount)} · Current prorated value: 💰 ${formatPrice(r.calculated_refund)}</div>
    ${loc ? `<p class="text-gray-400 text-xs">${escapeHtml(loc)}</p>` : ''}
    <p class="text-gray-500 text-xs">Checkout: ${r.checked_out_at ? new Date(r.checked_out_at).toLocaleString() : 'Unknown'}</p>
    <p class="text-gray-500 text-xs">Latest evidence: ${evidenceTime ? new Date(evidenceTime).toLocaleString() : 'Unknown'}</p>
    ${historyComplete ? '' : '<p class="text-amber-300 text-xs">Older restart details are unavailable; the displayed counters remain authoritative.</p>'}
  `;
  return card;
}

// ── Orders ──────────────────────────────────────────────────────────────────

/** Load and display the player's order history. */
async function loadOrders() {
  const requestId = nextShopRequestId('orders');
  const tbody = document.getElementById('orders-tbody');
  const generation = shopContextGeneration;
  const identityId = currentIdentityId;
  const serverId = currentServerId;

  if (!identityId || !serverId) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-gray-400">Select a server and identity to view orders.</td></tr>';
    return;
  }

  tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-gray-400">Loading…</td></tr>';

  try {
    const res  = await fetch(`/api/shop/orders/${identityId}?serverId=${encodeURIComponent(serverId)}`);
    const json = await res.json();
    if (requestId !== shopRequestSequence.orders || generation !== shopContextGeneration ||
        identityId !== currentIdentityId || serverId !== currentServerId) return;
    if (!json.success) throw new Error(json.error || 'Failed to load orders');
    const orders = json.data || [];

    if (!orders.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-gray-400">No orders yet.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    orders.forEach(order => {
      // Main order row
      const tr = document.createElement('tr');
      tr.className = 'border-b border-gray-700 cursor-pointer hover:bg-gray-700/40';
      const itemCount = (order.items || []).length;
      tr.innerHTML = `
        <td class="py-2 px-3 font-mono text-gray-400">#${order.id}</td>
        <td class="py-2 px-3">
          <span class="px-2 py-0.5 rounded text-xs ${statusClass(order.status)}">${escapeHtml(order.status)}</span>
        </td>
        <td class="py-2 px-3 text-green-400">💰 ${formatPrice(order.total_price)}</td>
        <td class="py-2 px-3 text-gray-400 text-xs">${new Date(order.checked_out_at || order.created_at).toLocaleString()}</td>
        <td class="py-2 px-3 text-gray-400 text-xs">${itemCount} item${itemCount !== 1 ? 's' : ''} ▾</td>
      `;
      tbody.appendChild(tr);

      // Collapsible detail row
      const detailTr = document.createElement('tr');
      detailTr.className = 'hidden';
      const paymentBreakdown = (order.payment_allocations || []).length
        ? order.payment_allocations.map(a => `${escapeHtml(a.account_type)} ${formatPrice(a.amount)}`).join(' · ')
        : 'Unavailable for legacy order';
      const refundSummary = order.refund_status
        ? `<div class="mt-2 rounded bg-blue-950 p-2 text-xs text-blue-200">Refund ${formatPrice(order.refunded_amount)} · ${escapeHtml(order.refund_status)} · ${order.refunded_at ? new Date(order.refunded_at).toLocaleString() : 'time unknown'}</div>`
        : '<div class="mt-2 text-xs text-gray-500">No refund recorded.</div>';
      detailTr.innerHTML = `
        <td colspan="5" class="bg-gray-900 px-6 py-3">
          <div class="mb-2 text-xs text-cyan-200">Checkout: ${order.checked_out_at ? new Date(order.checked_out_at).toLocaleString() : 'Unknown'} · Payment: ${paymentBreakdown}</div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            ${(order.items || []).map(i => {
              const evidenceTime = latestEvidenceTimestamp(
                i.fulfillment?.confirmedAt,
                i.fulfillment?.observedAt,
                (i.consumption_events || []).flatMap(event => [event.consumed_at, event.detected_at])
              );
              return `
              <div class="bg-gray-800 rounded p-3">
                <div class="flex items-center gap-2">
                  <span>${escapeHtml(i.item_name)}</span>
                  <span class="text-gray-500 text-xs ml-auto">×${i.quantity} at ${formatPrice(i.unit_price)}</span>
                </div>
                <div class="mt-1">${fulfillmentBadge(i.fulfillment)}</div>
                <div class="text-xs text-gray-500 mt-1">Line #${i.id} · Evidence: ${evidenceTime ? new Date(evidenceTime).toLocaleString() : 'Unknown'}</div>
                ${i.item_type === 'event_rental'
                  ? `<div class="mt-2 grid grid-cols-3 gap-1 text-center text-xs text-purple-200">
                      <span>Purchased ${i.purchased_restarts}</span>
                      <span>Consumed ${i.consumed_restarts}</span>
                      <span>Remaining ${i.restarts_remaining}</span>
                    </div>
                    ${i.evidence_history_available
                      ? '<div class="mt-1 text-xs text-gray-500">Scheduled restart history is complete.</div>'
                      : '<div class="mt-1 text-xs text-amber-300">Legacy/incomplete restart history — counters may not have event-level evidence.</div>'}`
                  : ''}
              </div>`;
            }).join('')}
          </div>
          ${refundSummary}
        </td>
      `;
      tbody.appendChild(detailTr);

      // Toggle detail on row click
      tr.addEventListener('click', () => {
        detailTr.classList.toggle('hidden');
      });
    });
  } catch (err) {
    if (requestId !== shopRequestSequence.orders || generation !== shopContextGeneration ||
        identityId !== currentIdentityId || serverId !== currentServerId) return;
    console.error('loadOrders:', err);
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-red-400">Failed to load orders.</td></tr>';
  }
}

// ── Cart badge helpers ──────────────────────────────────────────────────────

async function refreshCartBadge() {
  const requestId = nextShopRequestId('cartBadge');
  const generation = shopContextGeneration;
  const identityId = currentIdentityId;
  const serverId = currentServerId;
  if (!identityId || !serverId) { updateCartBadge(0); return; }
  try {
    const res  = await fetch(`/api/shop/cart/${identityId}/${serverId}`);
    const json = await res.json();
    if (requestId !== shopRequestSequence.cartBadge || generation !== shopContextGeneration ||
        identityId !== currentIdentityId || serverId !== currentServerId) return;
    const count = (json.data?.items || []).length;
    updateCartBadge(count);
  } catch (_) {
    if (requestId !== shopRequestSequence.cartBadge || generation !== shopContextGeneration ||
        identityId !== currentIdentityId || serverId !== currentServerId) return;
  }
}

function updateCartBadge(count) {
  const badge = document.getElementById('cart-badge');
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function moneyAmountCents(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!match) return null;
  const cents = (BigInt(match[1]) * 100n) + BigInt((match[2] || '').padEnd(2, '0'));
  return cents <= 99999999999999999999n ? cents : null;
}

function moneyTextFromCents(cents) {
  return String(cents / 100n) + '.' + String(cents % 100n).padStart(2, '0');
}

function moneyProductCents(value, quantity) {
  const cents = moneyAmountCents(value);
  const units = Number(quantity);
  if (cents === null || !Number.isSafeInteger(units) || units < 0) return null;
  const total = cents * BigInt(units);
  return total <= 99999999999999999999n ? total : null;
}

function moneyProductText(value, quantity) {
  const cents = moneyProductCents(value, quantity);
  return cents === null ? null : moneyTextFromCents(cents);
}

function formatPrice(val) {
  if (val == null) return '0';
  const cents = moneyAmountCents(val);
  if (cents === null) return '0';
  const canonical = moneyTextFromCents(cents);
  const [integer, fraction] = canonical.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === '00' ? grouped : `${grouped}.${fraction.replace(/0$/, '')}`;
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
  switch (status) {
    case 'completed': return 'bg-green-800 text-green-200';
    case 'pending':   return 'bg-yellow-800 text-yellow-200';
    case 'refunded':  return 'bg-red-800 text-red-200';
    case 'expired':   return 'bg-gray-600 text-gray-300';
    default:          return 'bg-gray-700 text-gray-300';
  }
}

/** Brief toast notification shown in the bottom-right corner. */
function showToast(msg) {
  const toast = document.createElement('div');
  toast.textContent = msg;
  toast.className = 'fixed bottom-6 right-6 bg-green-700 text-white px-5 py-3 rounded-lg shadow-lg z-50 transition-opacity max-w-sm text-sm';
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.5s';
    setTimeout(() => toast.remove(), 500);
  }, 4000);
}

// ── Map Picker ──────────────────────────────────────────────────────────────
//
// Embeds a Leaflet map in a full-screen overlay so the player can click to
// select spawn coordinates.  X and Z are read from the Leaflet click event
// and converted from tile-space back to DayZ game world metres.  Y (elevation)
// defaults to 0 — the CE engine resolves terrain height at runtime.

/** Canonical measured map geometry and world transforms. */
const SHOP_MAP_CONFIGS = DayzMapCoordinates.MAP_DEFINITIONS;

// Leaflet map instance — created once, reused across opens.
let shopLeafletMap   = null;
let shopTileGroup    = null;  // L.LayerGroup holding imageOverlays
let shopPinMarker    = null;  // draggable pin placed on click
let shopPickedCoords = null;  // { x, z } game world coords after a pin is placed
let shopCurrentMapName = 'chernarusplus';

/**
 * Convert DayZ game coords (metres) to a Leaflet [lat, lng] point.
 * Leaflet lat = north axis = DayZ Z, lng = east axis = DayZ X.
 */
function shopGameToLeaflet(gameX, gameZ, mapName) {
  return DayzMapCoordinates.worldToLeaflet({ east: gameX, north: gameZ }, mapName);
}

/**
 * Convert a Leaflet LatLng back to DayZ game world metres.
 * Returns { x, z } rounded to 3 decimal places.
 */
function shopLeafletToGame(latlng, mapName) {
  const world = DayzMapCoordinates.leafletToWorld(latlng, mapName);
  return {
    x: Math.round(world.east * 1000) / 1000,
    z: Math.round(world.north * 1000) / 1000,
  };
}

/** Load (or reload) map image-overlay tiles for the given map name. */
function loadShopMapTiles(mapName) {
  if (!shopLeafletMap || !shopTileGroup) return;
  shopTileGroup.clearLayers();

  const cfg = SHOP_MAP_CONFIGS[mapName] || SHOP_MAP_CONFIGS.chernarusplus;
  const { gridSize, tileSize: advancement, physicalSize } = cfg;

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const flippedRow = (gridSize - 1) - row;
      const bounds     = [
        [row * advancement,               col * advancement],
        [row * advancement + physicalSize, col * advancement + physicalSize],
      ];
      L.imageOverlay(`/maps/${mapName}/tiles/${col}/${flippedRow}.png`, bounds, {
        opacity: 1, interactive: false,
      }).addTo(shopTileGroup);
    }
  }
}

/** Switch the picker to another terrain without retaining stale tiles or pin state. */
function switchShopMap(mapName) {
  shopCurrentMapName = SHOP_MAP_CONFIGS[mapName] ? mapName : 'chernarusplus';
  const selector = document.getElementById('mp-map-select');
  if (selector) selector.value = shopCurrentMapName;
  if (!shopLeafletMap) return;

  if (shopPinMarker) {
    shopLeafletMap.removeLayer(shopPinMarker);
    shopPinMarker = null;
  }
  shopPickedCoords = null;
  document.getElementById('mp-confirm-btn').disabled = true;
  document.getElementById('mp-coord-display').textContent = 'Click the map to place a pin';

  loadShopMapTiles(shopCurrentMapName);
  const cfg = SHOP_MAP_CONFIGS[shopCurrentMapName] || SHOP_MAP_CONFIGS.chernarusplus;
  const bounds = L.latLngBounds([[0, 0], [cfg.size, cfg.size]]);
  shopLeafletMap.setMaxBounds(bounds.pad(0.5));
  shopLeafletMap.setView([cfg.size / 2, cfg.size / 2], -1);
}

/** Initialise the Leaflet map the first time the picker opens. */
function initShopLeafletMap(mapName) {
  const cfg  = SHOP_MAP_CONFIGS[mapName] || SHOP_MAP_CONFIGS.chernarusplus;
  const size = cfg.size;

  shopLeafletMap = L.map('shop-map', {
    crs:              L.CRS.Simple,
    minZoom:          -3,
    maxZoom:          3,
    center:           [size / 2, size / 2],
    zoom:             -1,
    attributionControl: false,
    zoomControl:      true,
  });

  shopTileGroup = L.layerGroup().addTo(shopLeafletMap);
  loadShopMapTiles(mapName);

  // Click → place / move pin and update the coord display
  shopLeafletMap.on('click', e => {
    placeShopPin(e.latlng);
  });

  // Hover → show live coordinates in the toolbar
  shopLeafletMap.on('mousemove', e => {
    const coords = shopLeafletToGame(e.latlng, shopCurrentMapName);
    document.getElementById('mp-coord-display').textContent =
      `x: ${coords.x.toFixed(1)}  z: ${coords.z.toFixed(1)}`;
  });
}

/** Place (or move) the draggable pin marker at the given LatLng. */
function placeShopPin(latlng) {
  if (!shopLeafletMap) return;

  if (shopPinMarker) {
    shopPinMarker.setLatLng(latlng);
  } else {
    shopPinMarker = L.marker(latlng, { draggable: true })
      .addTo(shopLeafletMap)
      .on('dragend', e => {
        placeShopPin(e.target.getLatLng());
      });
  }

  const coords = shopLeafletToGame(latlng, shopCurrentMapName);
  shopPickedCoords = coords;

  shopPinMarker
    .bindPopup(`<b>Spawn here</b><br>x: ${coords.x.toFixed(1)}, z: ${coords.z.toFixed(1)}`, { closeButton: false })
    .openPopup();

  document.getElementById('mp-coord-display').textContent =
    `📍 x: ${coords.x.toFixed(1)}  z: ${coords.z.toFixed(1)}`;
  document.getElementById('mp-confirm-btn').disabled = false;
}

/** Open the map picker. Fetches available maps for the current server. */
async function openMapPicker() {
  const requestId = nextShopRequestId('mapPicker');
  const generation = shopContextGeneration;
  const serverId = currentServerId;
  const item = atcItem;
  const modal = document.getElementById('map-picker-modal');
  modal.classList.add('open');

  // Fetch available maps for this server and restrict selector
  try {
    const res  = await fetch(`/api/shop/maps/${serverId}`);
    const json = await res.json();
    if (requestId !== shopRequestSequence.mapPicker || generation !== shopContextGeneration ||
        serverId !== currentServerId || item !== atcItem || !modal.classList.contains('open')) return;
    if (json.success && Array.isArray(json.maps) && json.maps.length) {
      const sel = document.getElementById('mp-map-select');
      sel.innerHTML = '';
      json.maps.forEach(m => {
        const cfg = SHOP_MAP_CONFIGS[m];
        const opt = document.createElement('option');
        opt.value       = m;
        opt.textContent = cfg ? cfg.name : m;
        sel.appendChild(opt);
      });
      // Switch to first detected map
      const firstMap = json.maps[0];
      if (firstMap !== shopCurrentMapName) {
        switchShopMap(firstMap);
      } else {
        sel.value = firstMap;
      }
    }
  } catch (_) {
    // Non-fatal — map selector keeps its defaults
  }

  // Initialise or re-center the Leaflet map
  if (!shopLeafletMap) {
    // Slight delay so the container has rendered dimensions before L.map()
    setTimeout(() => {
      if (requestId !== shopRequestSequence.mapPicker || generation !== shopContextGeneration ||
          serverId !== currentServerId || item !== atcItem || !modal.classList.contains('open')) return;
      initShopLeafletMap(shopCurrentMapName);
    }, 50);
  } else {
    shopLeafletMap.invalidateSize();
  }
}

/** Close the map picker without applying coordinates. */
function closeMapPicker() {
  document.getElementById('map-picker-modal').classList.remove('open');
}

/** Apply the picked coordinates to the ATC modal coord inputs. */
function confirmMapLocation() {
  if (!shopPickedCoords) return;

  document.getElementById('atc-pos-x').value = shopPickedCoords.x;
  document.getElementById('atc-pos-z').value = shopPickedCoords.z;

  const yVal = parseFloat(document.getElementById('mp-y-input').value) || 0;
  document.getElementById('atc-pos-y').value = yVal;

  closeMapPicker();
}

// Wire up map picker buttons after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('mp-confirm-btn').addEventListener('click', confirmMapLocation);
  document.getElementById('mp-cancel-btn').addEventListener('click', closeMapPicker);

  // Swap tiles when map selector changes
  document.getElementById('mp-map-select').addEventListener('change', e => {
    switchShopMap(e.target.value);
  });
});
