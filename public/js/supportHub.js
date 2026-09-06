/* eslint-env browser */
/*
 * DayZ Dashboard — Support Hub Client Module
 * Copyright (C) 2026
 *
 * Loads Nitrado support channel availability and resolves
 * the server's Nitrado service ID for pre-filled support links.
 */

document.addEventListener('DOMContentLoaded', () => {
  loadServers();
  loadSupportChannels();
  document.getElementById('serverSelect').addEventListener('change', onServerChange);
});

async function loadServers() {
  try {
    const res = await fetch('/api/nitrado/registered-servers');
    const data = await res.json();
    const select = document.getElementById('serverSelect');
    select.innerHTML = '<option value="">Select a server…</option>';
    (data.servers || []).forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.server_name;
      select.appendChild(opt);
    });
  } catch {
    // Non-critical — page still works without a server selected
  }
}

async function onServerChange() {
  const serverId = document.getElementById('serverSelect').value;
  const display = document.getElementById('serviceIdDisplay');
  const link = document.getElementById('linkOpenTicket');

  if (!serverId) {
    display.textContent = '—';
    link.href = 'https://server.nitrado.net/en/gameserver/support';
    return;
  }

  try {
    const res = await fetch(`/api/support/service-id/${serverId}`);
    const data = await res.json();
    const sid = data.platform_server_id || '—';
    display.textContent = sid;
    // Pre-fill Nitrado's ticket URL with the service ID when possible
    link.href = `https://server.nitrado.net/en/gameserver/support?service_id=${sid}`;
  } catch {
    display.textContent = '—';
  }
}

async function loadSupportChannels() {
  const channelsWrap = document.getElementById('channelsWrap');
  const phoneWrap = document.getElementById('phoneWrap');

  try {
    const res = await fetch('/api/support/channels');
    const data = await res.json();
    if (data.status !== 'success') throw new Error(data.message || 'API error');
    renderChannels(data.data.support_channels, channelsWrap, phoneWrap);
  } catch (err) {
    channelsWrap.innerHTML = `<p class="text-red-400 text-sm">❌ Could not load channel info: ${escHtml(err.message)}</p>`;
    phoneWrap.innerHTML = '';
  }
}

/**
 * Renders support channel status badges and phone contact details.
 * @param {Object} channels - support_channels object from Nitrado API
 * @param {HTMLElement} channelsWrap - container for status cards
 * @param {HTMLElement} phoneWrap - container for phone details
 */
function renderChannels(channels, channelsWrap, phoneWrap) {
  const channelCards = [];

  // Show top-level channels (chat, support_wizard, etc.)
  for (const [name, info] of Object.entries(channels)) {
    if (name === 'phone') continue; // shown separately below

    const enabled = info.status === 'enabled';
    const label = formatChannelName(name);
    const badge = enabled
      ? '<span class="bg-green-700 text-green-100 px-2 py-0.5 rounded text-xs font-semibold">🟢 Online</span>'
      : '<span class="bg-red-800 text-red-100 px-2 py-0.5 rounded text-xs font-semibold">🔴 Offline</span>';

    channelCards.push(`
      <div class="bg-gray-700 rounded-lg p-4 flex justify-between items-center">
        <span class="font-semibold">${escHtml(label)}</span>
        ${badge}
      </div>
    `);
  }

  channelsWrap.innerHTML = channelCards.length
    ? `<div class="grid grid-cols-1 md:grid-cols-3 gap-3">${channelCards.join('')}</div>`
    : '<p class="text-gray-400 text-sm">No channel info available.</p>';

  // Phone contacts
  const phone = channels.phone;
  if (!phone) {
    phoneWrap.innerHTML = '<p class="text-gray-400 text-sm">Phone support info unavailable.</p>';
    return;
  }

  const phoneEnabled = phone.status === 'enabled';
  const statusBadge = phoneEnabled
    ? '<span class="bg-green-700 text-green-100 px-2 py-0.5 rounded text-xs font-semibold ml-2">🟢 Available</span>'
    : '<span class="bg-red-800 text-red-100 px-2 py-0.5 rounded text-xs font-semibold ml-2">🔴 Unavailable</span>';

  const contactRows = (phone.contacts || []).map(c => {
    const hours = (c.slots || []).map(slot => {
      const langs = slot.languages.join(', ').toUpperCase();
      const duration = Math.round(slot.duration / 3600);
      return `<li class="text-sm text-gray-300">${escHtml(langs)}: ${duration}h/day (${escHtml(slot.timezone)})</li>`;
    }).join('');

    return `
      <div class="bg-gray-700 rounded-lg p-4 mb-3">
        <p class="font-mono text-yellow-400 text-lg mb-2">${escHtml(c.contact)}</p>
        <ul class="list-disc list-inside space-y-1">${hours}</ul>
      </div>
    `;
  }).join('');

  phoneWrap.innerHTML = `
    <p class="text-sm text-gray-400 mb-3">Status: <strong>Phone Support</strong>${statusBadge}</p>
    ${contactRows || '<p class="text-gray-400 text-sm">No phone numbers listed.</p>'}
  `;
}

function formatChannelName(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
