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

  loadDiscordTickets(serverId);
}

/**
 * Load Discord tickets for the selected server and render them.
 */
async function loadDiscordTickets(serverId) {
  const wrap = document.getElementById('ticketsWrap');
  wrap.innerHTML = '<div class="dzc-skeleton" style="height:1.25rem;width:220px"></div>';
  try {
    const res = await fetch(`/api/support/server/${serverId}/tickets`);
    const data = await res.json();
    renderTickets(data.data || [], wrap);
  } catch (err) {
    wrap.innerHTML = `<p class="text-red-400 text-sm">❌ Could not load tickets: ${escHtml(err.message)}</p>`;
  }
}

function renderTickets(tickets, wrap) {
  if (!tickets.length) {
    wrap.innerHTML = '<div class="dzc-empty"><div class="dzc-empty-title">No Discord tickets yet for this server.</div></div>';
    return;
  }
  const cards = tickets.slice(0, 30).map(t => {
    const open = !t.closed_at;
    const badge = open
      ? '<span class="bg-green-700 text-green-100 px-2 py-0.5 rounded text-xs font-semibold">🔴 Open</span>'
      : '<span class="bg-gray-600 text-gray-200 px-2 py-0.5 rounded text-xs font-semibold">✅ Closed</span>';
    const when = t.created_at ? new Date(t.created_at).toLocaleString() : '—';
    return `
      <div class="bg-gray-700 rounded-lg p-4 flex items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="font-semibold truncate">${escHtml(t.subject || t.opened_by_username || 'Ticket #' + t.id)}</p>
          <p class="text-gray-400 text-xs">${escHtml(t.opened_by_username || 'unknown')} · ${when} · ${t.message_count || 0} msgs</p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          ${badge}
          <button data-ticket="${t.id}" class="viewTicket bg-gray-600 hover:bg-gray-500 px-3 py-1 rounded text-xs">View</button>
        </div>
      </div>`;
  }).join('');
  wrap.innerHTML = `<div class="space-y-3">${cards}</div>`;
  wrap.querySelectorAll('.viewTicket').forEach(btn => {
    btn.addEventListener('click', () => showTranscript(btn.dataset.ticket));
  });
}

async function showTranscript(ticketId) {
  const serverId = document.getElementById('serverSelect').value;
  const wrap = document.getElementById('ticketsWrap');
  wrap.innerHTML = '<div class="dzc-skeleton" style="height:1.25rem;width:220px"></div>';
  try {
    const res = await fetch(`/api/support/server/${serverId}/tickets/${ticketId}`);
    const data = await res.json();
    renderTranscript(data, wrap);
  } catch (err) {
    wrap.innerHTML = `<p class="text-red-400 text-sm">❌ Could not load transcript: ${escHtml(err.message)}</p>`;
  }
}

function renderTranscript(data, wrap) {
  const t = data.ticket || {};
  const msgs = data.messages || [];
  const lines = msgs.map(m => {
    const when = m.created_at ? new Date(m.created_at).toLocaleString() : '';
    return `<div class="text-sm"><span class="text-yellow-400 font-semibold">${escHtml(m.author_name || m.author_id || 'unknown')}</span> <span class="text-gray-500 text-xs">${when}</span><div class="text-gray-300 whitespace-pre-wrap">${escHtml(m.content) || '<em class="text-gray-500">(empty)</em>'}</div></div>`;
  }).join('<hr class="border-gray-600 my-2">');
  wrap.innerHTML = `
    <div class="mb-3 flex items-center justify-between">
      <p class="font-semibold">${escHtml(t.subject || ('Ticket #' + (t.id || '')))}</p>
      <button onclick="backToTickets()" class="bg-gray-600 hover:bg-gray-500 px-3 py-1 rounded text-xs">← All tickets</button>
    </div>
    <div class="max-h-96 overflow-y-auto bg-gray-900 rounded p-4 border border-gray-600">
      ${lines || '<div class="dzc-empty"><div class="dzc-empty-title">No messages captured.</div></div>'}
    </div>`;
}

// eslint-disable-next-line no-unused-vars -- invoked from the inline onclick attribute in the ticket-view HTML template
function backToTickets() {
  const serverId = document.getElementById('serverSelect').value;
  if (serverId) loadDiscordTickets(serverId);
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
    : '<div class="dzc-empty"><div class="dzc-empty-title">No channel info available.</div></div>';

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
    ${contactRows || '<div class="dzc-empty"><div class="dzc-empty-title">No phone numbers listed.</div></div>'}
  `;
}

function formatChannelName(key) {
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
