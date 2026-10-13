let currentUser = null;
let currentGuildId = null;
let currentServerId = null;
let selectedAccount = null;
let selectedServer = null;
let currentIdentityId = null;
let currentEconomyServerId = null;
// Stats sub-sections reachable from the shell nav (card 7/9). Keyed by nav
// section name -> element id of the sub-section inside #my-stats.
const STAT_SUBSECTIONS = {
  sessions: 'session-section',
  health: 'health-section',
  damage: 'damage-section',
  weapons: 'weapon-analytics-section',
  territory: 'territory-section',
  kills: 'recent-kills-section',
  deaths: 'recent-deaths-section',
  achievements: 'achievements-section',
  performance: 'performance-section',
};
// Identity whose stats payload was last rendered (null = not loaded).
let statsLoadedForIdentity = null;
let communityAverages = null; // { kills, deaths, playtime } for the current guild

/** Escape a string for safe insertion into HTML */
function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape a string for safe insertion into a double-quoted HTML attribute. */
function escAttr(str) {
  return escHtml(str)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Return only HTTPS image URLs suitable for guild-card icon rendering. */
function safeImageUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

/** Return the Discord CDN avatar URL only when both parts are well-formed. */
function safeAvatarUrl(userId, avatar) {
  if (!userId || avatar === undefined || avatar === null || avatar === '') return '';
  if (!/^[a-z0-9]+$/i.test(String(avatar))) return '';
  return 'https://cdn.discordapp.com/avatars/' + encodeURIComponent(String(userId)) + '/' + avatar + '.png';
}

/**
 * Render a compact "vs community average" delta chip.
 * HigherIsBetter flips the good/bad coloring (e.g. deaths).
 * Returns '' when there is no baseline or no difference to show.
 */
function deltaChip(value, baseline, higherIsBetter) {
  if (baseline === null || baseline === undefined || baseline === 0 || value === null || value === undefined) return '';
  const pct = Math.round(((value - baseline) / baseline) * 100);
  if (pct === 0) return '<span class="dzc-delta is-flat">≈ server avg</span>';
  const good = higherIsBetter ? pct > 0 : pct < 0;
  const cls = good ? 'is-up' : 'is-down';
  const sign = pct > 0 ? '+' : '';
  return `<span class="dzc-delta ${cls}">${sign}${pct}% vs avg</span>`;
}

/**
 * Inline SVG sparkline for recent session durations (seconds).
 * Returns '' with fewer than 2 data points.
 */
function sessionSparkline(durations) {
  const values = (durations || []).filter(d => typeof d === 'number' && d > 0);
  if (values.length < 2) return '';
  const W = 300, H = 56, PAD = 4;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = (W - PAD * 2) / (values.length - 1);
  const points = values.map((v, i) => {
    const x = PAD + i * step;
    const y = H - PAD - ((v - min) / span) * (H - PAD * 2);
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  });
  const line = points.map(p => p.join(',')).join(' ');
  const area = `${PAD},${H - PAD} ${line} ${W - PAD},${H - PAD}`;
  return `<svg class="dzc-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Recent session durations">
    <polygon class="dzc-spark-fill" points="${area}"></polygon>
    <polyline class="dzc-spark-line" points="${line}"></polyline>
  </svg>`;
}

/** Scroll a portal sub-section into view, respecting reduced motion. */
function scrollSectionIntoView(el) {
  if (!el) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

function playerApiUrl(path, params = {}) {
  if (!currentServerId) throw new Error('Select a server before loading player data');
  const url = new URL(path, window.location.origin);
  url.searchParams.set('serverId', String(currentServerId));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}

// Check authentication
api.get('/api/user')
  .then(res => res.json())
  .then(data => {
    currentUser = data;
    if (data.hasToken) {
      document.getElementById('dashboardLink').style.display = 'block';
    }
    loadGuilds();
  })
  .catch(() => {
    window.location.href = '/';
  });

function loadGuilds() {
  fetch('/api/player/guilds')
    .then(res => res.json())
    .then(data => {
      if (data.success && data.guilds.length > 0) {
        displayGuilds(data.guilds);
      } else {
        document.getElementById('guilds-container').innerHTML = 
          '<p class="text-gray-400 text-center py-8">You are not a member of any communities with DayZ servers.</p>';
      }
    })
    .catch(err => {
      console.error('Error loading guilds:', err);
      document.getElementById('guilds-container').innerHTML = 
        '<p class="text-red-400 text-center py-4">Failed to load communities</p>';
    });
}

function displayGuilds(guilds) {
  const html = `
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      ${guilds.flatMap(guild => (guild.servers || []).map(server => `
        <div class="guild-card bg-gray-700 p-6 rounded-lg" role="button" tabindex="0" aria-label="Open ${escAttr(guild.guild_name)} — ${escAttr(server.name)}" data-guild-id="${escAttr(guild.guild_id)}" data-guild-name="${escAttr(guild.guild_name)}" data-server-id="${escAttr(server.id)}" data-server-name="${escAttr(server.name)}">
          <div class="flex items-center gap-3 mb-4">
            ${safeImageUrl(guild.icon_url) ?
              `<img src="${escAttr(safeImageUrl(guild.icon_url))}" class="w-16 h-16 rounded" />` :
              '<div class="w-16 h-16 rounded bg-gray-600 flex items-center justify-center text-2xl">🛡️</div>'
            }
            <div>
              <h3 class="text-xl font-bold">${escHtml(guild.guild_name)}</h3>
              <p class="text-sm text-gray-400">${escHtml(server.name)}</p>
            </div>
          </div>
          <div class="flex justify-between text-sm text-gray-400">
            <span>👥 ${guild.player_count || 0} player${guild.player_count !== 1 ? 's' : ''}</span>
          </div>
        </div>
      `)).join('')}
    </div>
  `;
  document.getElementById('guilds-container').innerHTML = html;
}

function selectGuild(guildId, guildName, serverId, serverName) {
  if (typeof resetBountiesContext === 'function') resetBountiesContext();
  currentGuildId = guildId;
  currentServerId = Number(serverId);
  currentIdentityId = null;
  currentEconomyServerId = currentServerId;
  window.currentEconomyServerId = currentServerId;
  document.getElementById('selectedGuildName').textContent = `${guildName} — ${serverName}`;
  
  // Show navigation (shell: the sidebar is always visible; only the tab
  // buttons are hidden until a guild is selected)
  const playerNavEl = document.getElementById('playerNav');
  if (playerNavEl) playerNavEl.style.display = 'block';
  // Reveal the client-driven tabs: the shell renders them with the `hidden`
  // attribute until a guild is selected — remove it (inline display:none-fights
  // would leave the a11y state inconsistent with the visual state).
  ['discovery', 'stats', 'leaderboard', 'economy', 'casino', 'factions',
    'bounties', 'map', 'shop', 'emotes', ...Object.keys(STAT_SUBSECTIONS)].forEach(section => {
    const el = document.getElementById('nav-' + section);
    if (el) el.hidden = false;
  });
  statsLoadedForIdentity = null;
  communityAverages = null;

  // Pre-resolve the player's identity in the background so Economy and Casino
  // tabs are ready immediately without needing the Stats tab to be visited first.
  resolveLinkedIdentity();

  // Load account discovery
  showSection('discovery');
  loadDiscovery();
}

/**
 * Fetch the player's first linked account and store its identity_id in
 * `currentIdentityId` so that Economy and Casino tabs can load without
 * requiring the Stats tab to be visited first.
 *
 * Safe to call multiple times — skips the fetch if identity is already known.
 * Returns a Promise that resolves to the identity_id (or null if none found).
 */
function resolveLinkedIdentity() {
  if (currentIdentityId) return Promise.resolve(currentIdentityId);

  return fetch('/api/accounts/linked')
    .then(res => res.json())
    .then(data => {
      const account = data.accounts?.find(candidate =>
        String(candidate.guild_id) === String(currentGuildId) &&
        Number(candidate.server_id) === Number(currentServerId));
      if (data.success && account) {
        currentIdentityId = account.identity_id;
        currentEconomyServerId = account.server_id;
        window.currentEconomyServerId = currentEconomyServerId;
      }
      return currentIdentityId;
    })
    .catch(err => {
      console.error('Could not resolve linked identity:', err);
      return null;
    });
}


function showSection(section) {
  // Hide all sections
  document.getElementById('community-selector').style.display = 'none';
  document.getElementById('account-discovery').style.display = 'none';
  document.getElementById('my-stats').style.display = 'none';
  document.getElementById('leaderboard').style.display = 'none';
  const economyTabEl = document.getElementById('economy-tab');
  if (economyTabEl) economyTabEl.style.display = 'none';
  const casinoTabEl = document.getElementById('casino-tab');
  if (casinoTabEl) casinoTabEl.style.display = 'none';
  const mapSectionEl = document.getElementById('map-section');
  if (mapSectionEl) mapSectionEl.style.display = 'none';
  const factionsTabEl = document.getElementById('factions-tab');
  if (factionsTabEl) factionsTabEl.style.display = 'none';
  const bountiesTabEl = document.getElementById('bounties-tab');
  if (bountiesTabEl) bountiesTabEl.style.display = 'none';
  const emotesTabEl = document.getElementById('emotes-tab');
  if (emotesTabEl) emotesTabEl.style.display = 'none';
  
  // Update nav buttons (shell-aware: toggle the active state, never
  // overwrite the base dzc-shell-nav-item classes)
  document.querySelectorAll('nav button.is-active').forEach(btn => btn.classList.remove('is-active'));
  
  // Show selected section
  if (section === 'guilds') {
    document.getElementById('community-selector').style.display = 'block';
    document.getElementById('nav-guilds').classList.add('is-active');;
  } else if (section === 'discovery') {
    document.getElementById('account-discovery').style.display = 'block';
    document.getElementById('nav-discovery').classList.add('is-active');;
    loadDiscovery();
  } else if (section === 'stats') {
    document.getElementById('my-stats').style.display = 'block';
    document.getElementById('nav-stats').classList.add('is-active');;
    loadStats();
  } else if (STAT_SUBSECTIONS[section]) {
    // Stats sub-section (sessions/health/...): show the stats page and scroll
    // to the sub-section; load stats first if they are not loaded yet.
    document.getElementById('my-stats').style.display = 'block';
    const navBtn = document.getElementById('nav-' + section);
    if (navBtn) navBtn.classList.add('is-active');
    const target = document.getElementById(STAT_SUBSECTIONS[section]);
    if (statsLoadedForIdentity) {
      scrollSectionIntoView(target);
    } else {
      loadStats().then(() => scrollSectionIntoView(target));
    }
  } else if (section === 'leaderboard') {
    document.getElementById('leaderboard').style.display = 'block';
    document.getElementById('nav-leaderboard').classList.add('is-active');;
    loadLeaderboard();
  } else if (section === 'economy') {
    if (economyTabEl) economyTabEl.style.display = 'block';
    document.getElementById('nav-economy').classList.add('is-active');;
    resolveLinkedIdentity().then(id => {
      if (id) loadPlayerEconomyDashboard(id);
    });
  } else if (section === 'casino') {
    if (casinoTabEl) casinoTabEl.style.display = 'block';
    document.getElementById('nav-casino').classList.add('is-active');;
    if (typeof CasinoSlots !== 'undefined') {
      resolveLinkedIdentity().then(id => {
        if (id) {
          CasinoSlots.init(id);
          if (typeof CasinoBlackjack !== 'undefined') CasinoBlackjack.init(id);
          if (typeof CasinoHorseRacing !== 'undefined') CasinoHorseRacing.init(id);
          if (typeof CasinoCoursing !== 'undefined') CasinoCoursing.init(id);
          if (typeof CasinoRoulette !== 'undefined') CasinoRoulette.init(id);
          if (typeof CasinoHoldem !== 'undefined') CasinoHoldem.init(id);
          if (typeof CasinoCraps !== 'undefined') CasinoCraps.init(id);
          if (typeof CasinoBaccarat !== 'undefined') CasinoBaccarat.init(id);
        }
      });
    }
  } else if (section === 'map') {
    if (mapSectionEl) mapSectionEl.style.display = 'block';
    document.getElementById('nav-map').classList.add('is-active');;
    // Resolve identity first (same pattern as Casino/Factions) so the map
    // can open even if the Stats tab hasn't been visited yet.
    resolveLinkedIdentity().then(() => openPlayerMap());
  } else if (section === 'factions') {
    if (factionsTabEl) factionsTabEl.style.display = 'block';
    document.getElementById('nav-factions').classList.add('is-active');;
    if (typeof initFactions === 'function') {
      resolveLinkedIdentity().then(id => initFactions(currentGuildId, id));
    }
  } else if (section === 'bounties') {
    if (bountiesTabEl) bountiesTabEl.style.display = 'block';
    document.getElementById('nav-bounties').classList.add('is-active');;
    if (typeof initBounties === 'function') {
      resolveLinkedIdentity().then(id => { if (id) initBounties(currentServerId, currentGuildId, id); });
    }
  } else if (section === 'emotes') {
    if (emotesTabEl) emotesTabEl.style.display = 'block';
    document.getElementById('nav-emotes').classList.add('is-active');;
    resolveLinkedIdentity().then(id => { if (id) loadEmoteStats(id); });
  }
}

function loadDiscovery() {
  if (!currentGuildId) return;

  const container = document.getElementById('discovered-accounts');
  container.innerHTML = `
    <div class="text-center py-8">
      <div class="spinner border-4 border-green-600 border-t-transparent rounded-full w-12 h-12 mx-auto mb-4"></div>
      <div class="dzc-skeleton" style="height:1.25rem;width:220px"></div>
    </div>`;

  fetch(`/api/player/discover/${currentGuildId}`)
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        displayMyAccounts(data.linked, data.alts);
      } else {
        container.innerHTML = `<p class="text-red-400 text-center py-4">❌ ${escHtml(data.error || 'Failed to load accounts')}</p>`;
      }
    })
    .catch(err => {
      console.error('Error loading accounts:', err);
      container.innerHTML = '<p class="text-red-400 text-center py-4">Failed to load accounts. Please try again.</p>';
    });
}

/**
 * Renders the player's linked accounts and any detected alts into the
 * #discovered-accounts container.
 */
function displayMyAccounts(linked, alts) {
  const container = document.getElementById('discovered-accounts');
  let html = '';

  // ── Linked accounts ────────────────────────────────────────────────────────
  if (linked.length > 0) {
    html += `
      <div class="mb-6">
        <h3 class="text-base font-semibold text-green-400 mb-3">✅ Your Linked Accounts</h3>
        <div class="space-y-2">
          ${linked.map(a => `
            <div class="dzc-acct-row bg-gray-700 p-4 rounded-lg flex items-center gap-3">
              <div class="flex-1 min-w-0">
                <div class="flex flex-wrap items-center gap-2 mb-1">
                  <span class="font-bold">${escHtml(a.gamertag)}</span>
                  <span class="bg-blue-700 px-2 py-0.5 rounded text-xs">${escHtml(a.platform)}</span>
                  <span class="bg-green-700 px-2 py-0.5 rounded text-xs">LINKED</span>
                </div>
                <p class="text-sm text-gray-400">Last seen: ${a.lastSeen ? new Date(a.lastSeen).toLocaleString() : 'Unknown'}</p>
                ${a.serverNames.length ? `<p class="text-xs text-gray-500 mt-0.5">${escHtml(a.serverNames.join(', '))}</p>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>`;
  } else {
    html += `
      <div class="mb-6 p-4 bg-gray-700 rounded-lg text-center">
        <p class="text-gray-400">You haven't linked any accounts yet.</p>
        <p class="text-sm text-gray-500 mt-1">Use the search below to find and link your game account.</p>
      </div>`;
  }

  // ── Detected alts ─────────────────────────────────────────────────────────
  if (alts.length > 0) {
    html += `
      <div class="mb-4">
        <h3 class="text-base font-semibold text-yellow-400 mb-1">⚠️ Detected Alt Accounts</h3>
        <p class="text-sm text-gray-400 mb-3">These accounts share a device with your linked account. You can link them to your profile too.</p>
        <div class="space-y-2">
          ${alts.map(a => `
            <div class="dzc-acct-row bg-gray-700 p-4 rounded-lg flex items-center gap-3">
              <div class="flex-1 min-w-0">
                <div class="flex flex-wrap items-center gap-2 mb-1">
                  <span class="font-bold">${escHtml(a.gamertag)}</span>
                  <span class="bg-blue-700 px-2 py-0.5 rounded text-xs">${escHtml(a.platform)}</span>
                  <span class="bg-yellow-700 px-2 py-0.5 rounded text-xs">ALT</span>
                </div>
                <p class="text-sm text-gray-400">Last seen: ${a.lastSeen ? new Date(a.lastSeen).toLocaleString() : 'Unknown'}</p>
                ${a.serverNames.length ? `<p class="text-xs text-gray-500 mt-0.5">${escHtml(a.serverNames.join(', '))}</p>` : ''}
              </div>
              <button data-account-id="${escAttr(a.id)}" data-gamertag="${escAttr(a.gamertag)}" data-platform="${escAttr(a.platform)}"
                      class="link-account-btn bg-green-600 hover:bg-green-700 px-4 py-2 rounded font-semibold text-sm whitespace-nowrap shrink-0">
                Link This Account
              </button>
            </div>
          `).join('')}
        </div>
      </div>`;
  }

  container.innerHTML = html || '<p class="text-gray-400 text-center py-8">No accounts found. Use the search below to link your first account.</p>';

  // Wire up link buttons
  container.querySelectorAll('.link-account-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      showLinkModal(this.dataset.accountId, this.dataset.gamertag, this.dataset.platform, this.dataset.serverId);
    });
  });
}

/** Renders search results (from /api/player/search) into #discovered-accounts */
function displayDiscoveredAccounts(accounts) {
  const container = document.getElementById('discovered-accounts');

  if (accounts.length === 0) {
    container.innerHTML = '<div class="dzc-empty"><div class="dzc-empty-title">No accounts found matching that gamertag.</div></div>';
    return;
  }

  const html = accounts.map(account => {
    const isLinked     = account.isAlreadyLinked;
    const linkedToOther = account.linkedToOther;

    return `
      <div class="dzc-acct-row bg-gray-700 p-4 rounded-lg flex items-center gap-3">
        <div class="flex-1 min-w-0">
          <div class="flex flex-wrap items-center gap-2 mb-1">
            <span class="font-bold">${escHtml(account.gamertag)}</span>
            <span class="bg-blue-700 px-2 py-0.5 rounded text-xs">${escHtml(account.platform)}</span>
            ${isLinked     ? '<span class="bg-green-700 px-2 py-0.5 rounded text-xs">LINKED</span>' : ''}
            ${linkedToOther ? `<span class="bg-red-700 px-2 py-0.5 rounded text-xs">Linked to ${escHtml(account.linkedUsername)}</span>` : ''}
          </div>
          <p class="text-sm text-gray-400">Last seen: ${account.lastSeen ? new Date(account.lastSeen).toLocaleString() : 'Unknown'}</p>
          ${account.serverName ? `<p class="text-xs text-gray-500 mt-0.5">${escHtml(account.serverName)}</p>` : ''}
        </div>
        ${!isLinked && !linkedToOther ? `
          <button data-account-id="${escAttr(account.id)}" data-server-id="${escAttr(account.serverId)}" data-gamertag="${escAttr(account.gamertag)}" data-platform="${escAttr(account.platform)}"
                  class="link-account-btn bg-green-600 hover:bg-green-700 px-4 py-2 rounded font-semibold text-sm whitespace-nowrap shrink-0">
            Link This Account
          </button>
        ` : ''}
      </div>
    `;
  }).join('');

  container.innerHTML = html;

  container.querySelectorAll('.link-account-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      showLinkModal(this.dataset.accountId, this.dataset.gamertag, this.dataset.platform, this.dataset.serverId);
    });
  });
}

function searchGamertag() {
  const gamertag = document.getElementById('searchGamertag').value.trim();
  if (!gamertag || !currentGuildId) return;
  
  fetch(playerApiUrl('/api/player/search', { guildId: currentGuildId, gamertag }))
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        displayDiscoveredAccounts(data.accounts);
      } else {
        document.getElementById('discovered-accounts').innerHTML =
          `<p class="text-red-400 text-center py-4">❌ ${escHtml(data.error || 'Failed to search accounts. Please try again.')}</p>`;
      }
    })
    .catch(err => {
      console.error('Error searching:', err);
      document.getElementById('discovered-accounts').innerHTML =
        '<p class="text-red-400 text-center py-4">Failed to search accounts. Please check your connection and try again.</p>';
    });
}

function showLinkModal(accountId, gamertag, platform, serverId) {
  selectedAccount = accountId;
  selectedServer = serverId;
  const safeGamertag = document.createElement('div');
  safeGamertag.textContent = gamertag;
  const safePlatform = document.createElement('div');
  safePlatform.textContent = platform;
  
  document.getElementById('linkAccountDetails').innerHTML = `
    <p class="font-semibold">${safeGamertag.innerHTML}</p>
    <p class="text-sm text-gray-400">Platform: ${safePlatform.innerHTML}</p>
  `;
  document.getElementById('linkModal').classList.remove('hidden');
}

function closeLinkModal() {
  selectedAccount = null;
  selectedServer = null;
  document.getElementById('linkModal').classList.add('hidden');
}

function confirmLink() {
  if (!selectedAccount || !selectedServer || !currentGuildId) return;
  
  fetchWithCsrf('/api/accounts/link', {
    method: 'POST',
    body: JSON.stringify({
      gameAccountId: selectedAccount,
      guildId: currentGuildId,
      serverId: selectedServer
    })
  })
  .then(res => res.json())
  .then(data => {
    if (data.challengeRequired) {
      const steps = (data.sequence || [])
        .map(step => `${step.position}. ${step.label}`)
        .join('\n');
      alert(
        `Ownership check required on ${data.serverName}:\n\n` +
        `Perform these emotes, in order, while playing on that server as this gamertag:\n${steps}\n\n` +
        'How it works:\n' +
        `1. Join ${data.serverName} in-game.\n` +
        '2. Perform the emotes above, one after the other.\n' +
        '3. We detect your emotes from the server log, which is downloaded automatically — allow up to about 15 minutes.\n' +
        '4. Come back here and press "Confirm" again; your link completes automatically.\n\n' +
        'The challenge expires in 30 minutes.'
      );
    } else if (data.success) {
      closeLinkModal();
      document.getElementById('nav-economy').style.display = 'block';
      document.getElementById('nav-casino').style.display = 'block';
      document.getElementById('nav-emotes').style.display = 'block';
      // Resolve the newly linked identity so Economy and Casino are ready immediately
      currentIdentityId = null; // reset so resolveLinkedIdentity re-fetches
      resolveLinkedIdentity();
      loadDiscovery();
      alert(
        (data.message || 'Account linked successfully!') +
        (data.roleWarning ? '\n\n' + data.roleWarning : '')
      );
    } else {
      alert('Failed to link account: ' + (data.error || 'Unknown error'));
    }
  })
  .catch(err => {
    alert('Error linking account: ' + err.message);
  });
}

function loadStats() {
  if (!currentGuildId) return Promise.resolve();
  
  // Community baseline for the comparison deltas: same endpoint the
  // Leaderboard tab uses (top-50 average is the baseline — no new data).
  const averages = fetch(playerApiUrl(`/api/player/leaderboard/${currentGuildId}`, { sortBy: 'playtime' }))
    .then(res => res.json())
    .then(data => {
      if (data.success && Array.isArray(data.leaderboard) && data.leaderboard.length > 0) {
        const n = data.leaderboard.length;
        communityAverages = {
          kills: data.leaderboard.reduce((sum, p) => sum + (p.total_kills || 0), 0) / n,
          deaths: data.leaderboard.reduce((sum, p) => sum + (p.total_deaths || 0), 0) / n,
          playtime: data.leaderboard.reduce((sum, p) => sum + (p.total_playtime || 0), 0) / n,
        };
      }
    })
    .catch(() => { /* baseline is optional — stats render without it */ });

  return fetch(playerApiUrl('/api/player/stats', { guildId: currentGuildId }))
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        // Render after the baseline resolves so the delta chips are present
        // on first paint.
        return averages.then(() => displayStats(data.accounts));
      }
      document.getElementById('stats-container').innerHTML =
        `<p class="text-red-400 text-center py-4">${escHtml(data.error || 'Failed to load stats')}</p>`;
    })
    .catch(err => {
      console.error('Error loading stats:', err);
      document.getElementById('stats-container').innerHTML = 
        '<p class="text-red-400 text-center py-4">Failed to load stats</p>';
    });
}

function displayStats(accounts) {
  if (accounts.length === 0) {
    document.getElementById('stats-container').innerHTML = 
      '<div class="dzc-empty"><div class="dzc-empty-title">No linked accounts found. Link an account first.</div></div>';
    document.getElementById('session-section').style.display = 'none';
    statsLoadedForIdentity = null;
    return;
  }

  const html = accounts.map(account => {
    const kills = account.total_kills || 0;
    const deaths = account.total_deaths || 0;
    const kd = deaths > 0 ? (kills / deaths) : kills;
    const kdClass = kd >= 2 ? 'is-good' : kd >= 1 ? 'is-ok' : 'is-bad';
    const avg = communityAverages || {};
    const serverName = account.server_names ? account.server_names.split(',')[0] : '';
    return `
    <div class="dzc-stat-card">
      <div class="dzc-stat-card-head">
        <div>
          <h3 class="dzc-stat-card-tag">${escHtml(account.gamertag)}</h3>
          <p class="dzc-stat-card-sub">${escHtml(account.platform)} • ${escHtml(serverName)}</p>
        </div>
        <span class="dzc-stat-card-guild">${escHtml(account.guild_name || '')}</span>
      </div>
      <dl class="dzc-stat-grid">
        <div class="dzc-stat">
          <p class="dzc-stat-num is-kills">${kills}</p>
          <p class="dzc-stat-label">Kills</p>
          ${deltaChip(kills, avg.kills, true)}
        </div>
        <div class="dzc-stat">
          <p class="dzc-stat-num is-deaths">${deaths}</p>
          <p class="dzc-stat-label">Deaths</p>
          ${deltaChip(deaths, avg.deaths, false)}
        </div>
        <div class="dzc-stat">
          <p class="dzc-stat-num is-playtime">${formatPlaytime(account.total_playtime)}</p>
          <p class="dzc-stat-label">Playtime</p>
          ${deltaChip(account.total_playtime || 0, avg.playtime, true)}
        </div>
        <div class="dzc-stat">
          <p class="dzc-stat-num is-kd ${kdClass}">${kd.toFixed(2)}</p>
          <p class="dzc-stat-label">K/D Ratio</p>
          ${deltaChip(kd, avg.kills && avg.deaths ? (avg.kills / Math.max(1, avg.deaths)) : null, true)}
        </div>
      </dl>
      ${account.lastSeenAt ? `<p class="dzc-stat-lastseen">Last seen: ${new Date(account.lastSeenAt).toLocaleString()}</p>` : ''}
    </div>
  `;
  }).join('');

  document.getElementById('stats-container').innerHTML = html;

  // Load session data for first linked account
  if (accounts[0] && accounts[0].identity_id) {
    currentIdentityId = accounts[0].identity_id;
    statsLoadedForIdentity = accounts[0].identity_id;
    currentEconomyServerId = currentServerId;
    window.currentEconomyServerId = currentEconomyServerId;
    lastUpdateTime = Date.now();
    updateLastUpdatedDisplay();
    document.getElementById('session-section').style.display = 'block';
    loadSessionStats(accounts[0].identity_id);
    loadSessionHistory(accounts[0].identity_id);
    document.getElementById('health-section').style.display = 'block';
    loadCharacterHealth(accounts[0].identity_id);
    document.getElementById('damage-section').style.display = 'block';
    loadDamageEvents(accounts[0].identity_id);
    document.getElementById('weapon-analytics-section').style.display = 'block';
    loadTopThreats(accounts[0].identity_id);
    loadWeaponCategories(accounts[0].identity_id);
    loadWeaponBreakdown(accounts[0].identity_id);
    document.getElementById('bodypart-section').style.display = 'block';
    loadBodyPartStats(accounts[0].identity_id);
    document.getElementById('territory-section').style.display = 'block';
    loadTerritoryStats(accounts[0].identity_id);
    loadTerritoryEvents(accounts[0].identity_id);
    document.getElementById('favorite-weapons-section').style.display = 'block';
    loadFavoriteWeapons(accounts[0].identity_id);
    document.getElementById('recent-kills-section').style.display = 'block';
    loadRecentKills(accounts[0].identity_id);
    document.getElementById('recent-deaths-section').style.display = 'block';
    loadRecentDeaths(accounts[0].identity_id);
    document.getElementById('playtime-breakdown-section').style.display = 'block';
    loadPlaytimeBreakdown(accounts[0].identity_id);
    document.getElementById('death-stats-section').style.display = 'block';
    loadDeathStats(accounts[0].identity_id);
    document.getElementById('achievements-section').style.display = 'block';
    loadAchievements(accounts[0].identity_id);
    document.getElementById('performance-section').style.display = 'block';
    loadPerformanceTimeline(accounts[0].identity_id);
    loadEconomy(accounts[0].identity_id);
  }
}

function loadLeaderboard() {
  if (!currentGuildId) return;
  
  const sortBy = document.getElementById('sortBy').value;
  
  fetch(playerApiUrl(`/api/player/leaderboard/${currentGuildId}`, { sortBy }))
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        displayLeaderboard(data.leaderboard);
      } else {
        document.getElementById('leaderboard-container').innerHTML =
          `<p class="text-red-400 text-center py-4">${data.error || 'Failed to load leaderboard'}</p>`;
      }
    })
    .catch(err => {
      console.error('Error loading leaderboard:', err);
      document.getElementById('leaderboard-container').innerHTML = 
        '<p class="text-red-400 text-center py-4">Failed to load leaderboard</p>';
    });
}

function displayLeaderboard(leaderboard) {
  if (leaderboard.length === 0) {
    document.getElementById('leaderboard-container').innerHTML = 
      '<div class="dzc-empty"><div class="dzc-empty-title">No leaderboard data available.</div></div>';
    return;
  }

  // Reference table contract (card 5) — sticky header, right-aligned tabular
  // numerics, hover state, stacked card rows at <=640px via td[data-label].
  const html = `
    <div class="dzc-table-wrap">
      <table class="dzc-table">
        <thead>
          <tr>
            <th scope="col" data-label="Rank">Rank</th>
            <th scope="col" data-label="Player">Player</th>
            <th scope="col" data-label="Gamertag">Gamertag</th>
            <th scope="col" class="dzc-num" data-label="Kills">Kills</th>
            <th scope="col" class="dzc-num" data-label="Deaths">Deaths</th>
            <th scope="col" class="dzc-num" data-label="Playtime">Playtime</th>
          </tr>
        </thead>
        <tbody>
          ${leaderboard.map((player, index) => {
            const isMe = currentIdentityId && Number(player.identity_id) === Number(currentIdentityId);
            const avatarUrl = safeAvatarUrl(player.userId, player.avatar);
            const rank = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '#' + (index + 1);
            return `
            <tr class="dzc-row${isMe ? ' is-selected' : ''}">
              <td data-label="Rank">${rank}${isMe ? ' <span class="dzc-badge">YOU</span>' : ''}</td>
              <td data-label="Player">
                ${player.discordUsername ? `
                  <span class="flex items-center gap-2">
                    ${avatarUrl ? `<img src="${avatarUrl}" class="w-8 h-8 rounded-full" alt="" />` : ''}
                    <span>${escHtml(player.discordUsername)}${isMe ? ' (you)' : ''}</span>
                  </span>
                ` : '—'}
              </td>
              <td data-label="Gamertag">${escHtml(player.gamertag)}</td>
              <td class="dzc-num" data-label="Kills">${player.total_kills || 0}</td>
              <td class="dzc-num" data-label="Deaths">${player.total_deaths || 0}</td>
              <td class="dzc-num" data-label="Playtime">${formatPlaytime(player.total_playtime)}</td>
            </tr>
          `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  document.getElementById('leaderboard-container').innerHTML = html;
}

function formatPlaytime(minutes) {
  if (!minutes) return '0h';
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

/**
 * Load session statistics for a player identity
 */
async function loadSessionStats(identityId) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/sessions/${identityId}/stats`));
    const data = await response.json();

    if (!data.success || data.stats.length === 0) {
      document.getElementById('session-stats-container').innerHTML =
        '<div class="dzc-empty"><div class="dzc-empty-title">No session data available yet. Play on a server and scan logs.</div></div>';
      return;
    }

    // Overall average session length across servers (delta baseline).
    const totalLen = data.stats.reduce((sum, s) => sum + (s.avg_session_length || 0), 0);
    const overallAvg = data.stats.length > 0 ? totalLen / data.stats.length : 0;

    const html = data.stats.map(stat => {
      const totalHours = Math.floor((stat.total_playtime || 0) / 3600);
      const avgMinutes = Math.floor((stat.avg_session_length || 0) / 60);
      const timeSince = stat.last_played ? getTimeSince(new Date(stat.last_played)) : 'Never';
      return `
        <div class="dzc-session-card">
          <h5>${escHtml(stat.server_name)}</h5>
          <div class="grid grid-cols-2 gap-2 text-sm">
            <div><span class="dzc-muted">Sessions:</span> <span class="font-semibold tabular-nums">${stat.total_sessions}</span></div>
            <div><span class="dzc-muted">Playtime:</span> <span class="font-semibold tabular-nums">${totalHours}h</span></div>
            <div><span class="dzc-muted">Avg Session:</span> <span class="font-semibold tabular-nums">${avgMinutes} min</span>${deltaChip(stat.avg_session_length || 0, overallAvg, true)}</div>
            <div><span class="dzc-muted">Last Played:</span> <span class="font-semibold">${timeSince}</span></div>
          </div>
        </div>
      `;
    }).join('');

    document.getElementById('session-stats-container').innerHTML =
      `<div class="grid grid-cols-1 md:grid-cols-2 gap-4">${html}</div>`;
  } catch (error) {
    console.error('Error loading session stats:', error);
  }
}

/**
 * Load session history for a player identity
 */
async function loadSessionHistory(identityId, limit = 10) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/sessions/${identityId}`, { limit }));
    const data = await response.json();

    if (!data.success || data.sessions.length === 0) {
      document.getElementById('session-history-container').innerHTML =
        '<div class="dzc-empty"><div class="dzc-empty-title">No sessions found.</div></div>';
      return;
    }

    const spark = sessionSparkline(data.sessions.map(s => s.duration));

    let html = `
      <h5 class="font-bold mb-2">Session History</h5>
      ${spark}
      <p class="dzc-spark-label">Duration of the last ${data.sessions.length} sessions (oldest → newest)</p>
      <div class="dzc-table-wrap">
        <table class="dzc-table">
          <thead>
            <tr>
              <th scope="col" data-label="Server">Server</th>
              <th scope="col" data-label="Login">Login</th>
              <th scope="col" data-label="Logout">Logout</th>
              <th scope="col" class="dzc-num" data-label="Duration">Duration</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const session of data.sessions) {
      // API returns snake_case columns (login_at/logout_at); the camelCase
      // fallback keeps older payload shapes working.
      const loginRaw = session.login_at !== undefined ? session.login_at : session.loginAt;
      const logoutRaw = session.logout_at !== undefined ? session.logout_at : session.logoutAt;
      const loginTime = loginRaw ? new Date(loginRaw).toLocaleString() : '-';
      const logoutTime = logoutRaw ? new Date(logoutRaw).toLocaleString() : 'In progress';
      const duration = session.duration ? formatDuration(session.duration) : '-';

      html += `
        <tr class="dzc-row">
          <td data-label="Server">${escHtml(session.server_name)}</td>
          <td data-label="Login">${loginTime}</td>
          <td data-label="Logout">${logoutTime}</td>
          <td class="dzc-num" data-label="Duration">${duration}</td>
        </tr>
      `;
    }

    html += '</tbody></table></div>';
    document.getElementById('session-history-container').innerHTML = html;
  } catch (error) {
    console.error('Error loading session history:', error);
  }
}

/**
 * Load character health status for a player identity
 */
async function loadCharacterHealth(identityId) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/health/${identityId}`));
    const data = await response.json();

    if (!data.success || data.healthStatus.length === 0) {
      document.getElementById('health-status-container').innerHTML = `
        <div class="text-gray-400">
          <p class="mb-1">No health data available yet.</p>
          <p class="text-sm">Play on a server and scan logs to see your character status.</p>
        </div>
      `;
      return;
    }

    let html = '<div class="grid grid-cols-1 md:grid-cols-2 gap-4">';

    for (const health of data.healthStatus) {
      const statusIcon = getStatusIcon(health.status);
      const statusText = escHtml(health.status.charAt(0).toUpperCase() + health.status.slice(1));
      const hpPercent = Math.min(100, (health.currentHP / health.maxHP) * 100);
      const hpColor = getHPColor(hpPercent);
      const timeSince = health.lastUpdated ? getTimeSince(new Date(health.lastUpdated)) : 'Unknown';

      html += `
        <div class="bg-gray-600 p-4 rounded-lg">
          <h5 class="font-bold mb-2">${escHtml(health.serverName)}</h5>
          <div class="mb-2">
            <span class="text-lg">${statusIcon}</span>
            <strong class="ml-1">${statusText}</strong>
          </div>
          <div class="mb-3">
            <div class="flex items-baseline gap-1 mb-1">
              <span class="text-2xl font-bold ${hpColor.text}">${health.currentHP.toFixed(1)}</span>
              <span class="text-gray-400">/ ${health.maxHP} HP</span>
            </div>
            <div class="w-full bg-gray-700 rounded-full h-4">
              <div class="h-4 rounded-full ${hpColor.bar}" style="width: ${hpPercent.toFixed(0)}%"></div>
            </div>
          </div>
          <div class="text-sm text-gray-400 space-y-1">
            <div>📍 <span class="font-mono">${health.posX !== null ? `${health.posX.toFixed(1)}, ${health.posY.toFixed(1)}, ${health.posZ.toFixed(1)}` : 'N/A'}</span></div>
            <div>🕐 ${timeSince}</div>
          </div>
        </div>
      `;
    }

    html += '</div>';
    document.getElementById('health-status-container').innerHTML = html;
  } catch (error) {
    console.error('Error loading character health:', error);
    document.getElementById('health-status-container').innerHTML =
      '<p class="text-red-400">Failed to load health status.</p>';
  }
}

/**
 * Load recent damage events for a player identity
 */
async function loadDamageEvents(identityId, limit = 20) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/damage/${identityId}`, { limit }));
    const data = await response.json();

    if (!data.success || data.damageEvents.length === 0) {
      document.getElementById('damage-events-container').innerHTML = `
        <div class="text-gray-400">
          <p class="mb-1">No damage events found.</p>
          <p class="text-sm">Play on a server and scan logs to see your damage history.</p>
        </div>
      `;
      return;
    }

    const totalHits = data.damageEvents.length;
    const totalDamage = data.damageEvents.reduce((sum, e) => sum + e.damage, 0);

    let html = `
      <div class="flex gap-3 mb-4">
        <span class="bg-red-700 text-white text-sm font-semibold px-3 py-1 rounded">${totalHits} hits</span>
        <span class="bg-yellow-700 text-white text-sm font-semibold px-3 py-1 rounded">${totalDamage.toFixed(1)} total damage</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-600">
            <tr>
              <th class="p-2 text-left">Time</th>
              <th class="p-2 text-left">Attacker</th>
              <th class="p-2 text-left">Weapon</th>
              <th class="p-2 text-left">Body Part</th>
              <th class="p-2 text-left">Damage</th>
              <th class="p-2 text-left">HP After</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const event of data.damageEvents) {
      const timestamp = new Date(event.timestamp).toLocaleString();
      const attacker = event.attackerGamertag || capitalizeFirst(event.attackerType);
      const hpAfter = typeof event.hpAfter === 'number' ? event.hpAfter : null;
      const hpColor = hpAfter === null ? 'text-gray-400' : hpAfter > 75 ? 'text-green-400' : hpAfter > 25 ? 'text-yellow-400' : 'text-red-400';
      const hpDisplay = hpAfter !== null ? `${hpAfter.toFixed(1)} HP` : 'N/A';

      html += `
        <tr class="border-b border-gray-600">
          <td class="p-2"><small>${timestamp}</small></td>
          <td class="p-2">${attacker}</td>
          <td class="p-2"><span class="font-mono text-xs">${event.weapon || 'Unknown'}</span></td>
          <td class="p-2">${event.bodyPart || 'Unknown'}</td>
          <td class="p-2"><span class="text-red-400 font-semibold">${event.damage !== null ? event.damage.toFixed(1) : 'N/A'}</span></td>
          <td class="p-2"><span class="${hpColor} font-semibold">${hpDisplay}</span></td>
        </tr>
      `;
    }

    html += '</tbody></table></div>';
    document.getElementById('damage-events-container').innerHTML = html;

  } catch (error) {
    console.error('Error loading damage events:', error);
    document.getElementById('damage-events-container').innerHTML =
      '<p class="text-red-400">Failed to load damage events.</p>';
  }
}

/**
 * Get icon for attacker type
 */
function getAttackerIcon(attackerType) {
  switch (attackerType) {
    case 'player': return '👤';
    case 'infected': return '🧟';
    case 'animal': return '🐺';
    case 'environment': return '🌳';
    case 'vehicle': return '🚗';
    case 'explosion': return '💣';
    default: return '❓';
  }
}

/**
 * Load top threats (most dangerous weapons) for a player identity
 */
async function loadTopThreats(identityId, limit = 5) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/damage/${identityId}/top-threats`, { limit }));
    const data = await response.json();

    if (!data.success || data.topThreats.length === 0) {
      document.getElementById('top-threats-container').innerHTML =
        '<div class="dzc-empty"><div class="dzc-empty-title">No threat data available yet.</div></div>';
      return;
    }

    let html = '<h4 class="text-xl font-bold mb-3">🎯 Top Threats</h4><div class="space-y-2">';

    for (let i = 0; i < data.topThreats.length; i++) {
      const threat = data.topThreats[i];
      const rank = i + 1;
      const icon = getAttackerIcon(threat.attackerType);
      const percent = i === 0 || data.topThreats[0].hitCount === 0 ? 100 : Math.round((threat.hitCount / data.topThreats[0].hitCount) * 100);

      html += `
        <div class="bg-gray-600 p-3 rounded-lg flex items-center gap-3">
          <span class="text-xl font-bold text-blue-400 w-8 text-center">#${rank}</span>
          <div class="flex-1">
            <div class="font-semibold">${icon} <strong>${threat.weapon || 'Unknown'}</strong>
              <span class="text-sm text-gray-400 ml-1">(${capitalizeFirst(threat.attackerType)})</span>
            </div>
            <div class="flex gap-2 mt-1 text-sm">
              <span class="bg-red-700 text-white px-2 py-0.5 rounded">${threat.hitCount} hits</span>
              <span class="bg-yellow-700 text-white px-2 py-0.5 rounded">${threat.totalDamage.toFixed(1)} dmg</span>
              <span class="text-gray-400">Avg: ${threat.avgDamage.toFixed(1)}</span>
            </div>
            <div class="w-full bg-gray-700 rounded-full h-1 mt-2">
              <div class="h-1 rounded-full bg-gradient-to-r from-red-500 to-yellow-500" style="width: ${percent}%"></div>
            </div>
          </div>
        </div>
      `;
    }

    html += '</div>';
    document.getElementById('top-threats-container').innerHTML = html;
  } catch (error) {
    console.error('Error loading top threats:', error);
  }
}

/**
 * Get icon for weapon type
 */
function getWeaponIcon(weapon) {
  const lower = (weapon || '').toLowerCase();
  if (lower.includes('bullet') || lower.includes('projectile')) return '🔫';
  if (lower.includes('melee')) return '🧟';
  if (lower.includes('explosion') || lower.includes('grenade')) return '💣';
  if (lower.includes('fire') || lower.includes('flame')) return '🔥';
  if (lower.includes('fall')) return '⬇️';
  if (lower.includes('vehicle')) return '🚗';
  return '⚔️';
}

/**
 * Get threat badge HTML for a threat level
 */
function getThreatBadge(threatLevel) {
  const badges = {
    'critical': '<span class="bg-red-700 text-white px-2 py-0.5 rounded text-xs">🔴 Critical</span>',
    'high': '<span class="bg-yellow-700 text-white px-2 py-0.5 rounded text-xs">🟡 High</span>',
    'medium': '<span class="bg-blue-700 text-white px-2 py-0.5 rounded text-xs">🔵 Medium</span>',
    'low': '<span class="bg-gray-500 text-white px-2 py-0.5 rounded text-xs">⚪ Low</span>'
  };
  return badges[threatLevel] || badges['low'];
}

/**
 * Get rank icon for top threats
 */
function getRankIcon(rank) {
  switch (rank) {
    case 1: return '🥇';
    case 2: return '🥈';
    case 3: return '🥉';
    default: return '📍';
  }
}

/**
 * Get color class for attacker type category
 */
function getCategoryColor(attackerType) {
  switch (attackerType) {
    case 'player': return 'bg-red-600';
    case 'infected': return 'bg-yellow-600';
    case 'animal': return 'bg-blue-600';
    case 'environment': return 'bg-gray-500';
    case 'explosion': return 'bg-red-700';
    default: return 'bg-gray-500';
  }
}

/**
 * Load weapon category breakdown (by attacker type) for a player identity
 */
async function loadWeaponCategories(identityId) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/damage/${identityId}/weapons/category`));
    const data = await response.json();

    if (!data.success || data.categories.length === 0) {
      document.getElementById('weapon-category-container').innerHTML =
        '<div class="dzc-empty"><div class="dzc-empty-title">No weapon category data available.</div></div>';
      return;
    }

    let html = `
      <h4 class="text-xl font-bold mb-3">🎖️ Threat Categories</h4>
      <p class="text-sm text-gray-400 mb-3">Total Hits: <strong class="text-white">${data.totalHits}</strong></p>
      <div class="space-y-3">
    `;

    for (const category of data.categories) {
      const icon = getAttackerIcon(category.attackerType);
      const barColor = getCategoryColor(category.attackerType);

      html += `
        <div class="bg-gray-600 p-3 rounded-lg">
          <div class="flex justify-between items-center mb-2">
            <span class="font-semibold">${icon} ${capitalizeFirst(category.attackerType)}</span>
            <span class="text-sm text-gray-300">${category.hitCount} hits (${category.percentage}%)</span>
          </div>
          <div class="w-full bg-gray-700 rounded-full h-4 mb-2">
            <div class="${barColor} h-4 rounded-full flex items-center justify-center text-xs font-bold transition-all"
                 style="width: ${category.percentage}%; min-width: ${category.percentage > 0 ? '2rem' : '0'}">
              ${/* Show label only when bar is wide enough (>5%) to avoid overflow */ category.percentage > 5 ? category.percentage + '%' : ''}
            </div>
          </div>
          <div class="flex gap-2 text-xs text-gray-400">
            <span>Total: <span class="text-white">${category.totalDamage.toFixed(1)}</span></span>
            <span>•</span>
            <span>Avg: <span class="text-white">${category.avgDamage.toFixed(1)}</span></span>
          </div>
        </div>
      `;
    }

    html += '</div>';
    document.getElementById('weapon-category-container').innerHTML = html;
  } catch (error) {
    console.error('Error loading weapon categories:', error);
    document.getElementById('weapon-category-container').innerHTML =
      '<p class="text-red-400">Failed to load weapon categories.</p>';
  }
}


async function loadWeaponBreakdown(identityId, limit = 20) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/damage/${identityId}/weapons`, { limit }));
    const data = await response.json();

    if (!data.success || data.weapons.length === 0) {
      document.getElementById('weapon-breakdown-container').innerHTML =
        '<div class="dzc-empty"><div class="dzc-empty-title">No weapon data available.</div></div>';
      return;
    }

    let html = `
      <h4 class="text-xl font-bold mb-3">📊 Weapon Breakdown</h4>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-600">
            <tr>
              <th class="p-2 text-left">Weapon</th>
              <th class="p-2 text-left">Type</th>
              <th class="p-2 text-left">Hits</th>
              <th class="p-2 text-left">%</th>
              <th class="p-2 text-left">Avg Dmg</th>
              <th class="p-2 text-left">Max Dmg</th>
              <th class="p-2 text-left">Threat</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const weapon of data.weapons) {
      const icon = getWeaponIcon(weapon.weapon);
      html += `
        <tr class="border-b border-gray-600">
          <td class="p-2">${icon} <span class="font-mono text-xs">${weapon.weapon || 'Unknown'}</span></td>
          <td class="p-2 text-gray-400 text-xs">${capitalizeFirst(weapon.attackerType)}</td>
          <td class="p-2"><span class="bg-gray-500 text-white px-2 py-0.5 rounded text-xs">${weapon.hitCount}</span></td>
          <td class="p-2 text-gray-300 text-xs">${weapon.percentage}%</td>
          <td class="p-2">${weapon.avgDamage.toFixed(1)}</td>
          <td class="p-2"><span class="text-red-400 font-semibold">${weapon.maxDamage.toFixed(1)}</span></td>
          <td class="p-2">${getThreatBadge(weapon.threatLevel)}</td>
        </tr>
      `;
    }

    html += `</tbody></table></div>`;

    // Top threats summary
    const topWeapons = data.weapons.slice(0, 5);
    if (topWeapons.length > 0) {
      html += `<div class="mt-4"><h5 class="text-lg font-bold mb-3">⚠️ Top Threats</h5><div class="space-y-2">`;
      topWeapons.forEach((weapon, index) => {
        const icon = getWeaponIcon(weapon.weapon);
        const rankIcon = getRankIcon(index + 1);
        html += `
          <div class="bg-gray-600 p-3 rounded-lg flex items-center gap-3">
            <span class="text-xl w-8 text-center">${rankIcon}</span>
            <div class="flex-1">
              <div class="font-semibold">${icon} <strong>${weapon.weapon || 'Unknown'}</strong></div>
              <div class="flex gap-2 mt-1 text-sm text-gray-400">
                <span>${weapon.hitCount} hits</span>
                <span>•</span>
                <span>${weapon.avgDamage.toFixed(1)} avg dmg</span>
                <span>•</span>
                <span class="text-red-400">${weapon.maxDamage.toFixed(1)} max</span>
              </div>
            </div>
            <div>${getThreatBadge(weapon.threatLevel)}</div>
          </div>
        `;
      });
      html += `</div></div>`;
    }

    document.getElementById('weapon-breakdown-container').innerHTML = html;
  } catch (error) {
    console.error('Error loading weapon breakdown:', error);
    document.getElementById('weapon-breakdown-container').innerHTML =
      '<p class="text-red-400">Failed to load weapon breakdown.</p>';
  }
}

/**
 * Load body part hit statistics for a player identity
 */
async function loadBodyPartStats(identityId) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/damage/${identityId}/bodyparts`));
    const data = await response.json();

    if (!data.success || data.bodyParts.length === 0) {
      document.getElementById('bodypart-stats-container').innerHTML =
        '<div class="dzc-empty"><div class="dzc-empty-title">No body part data available yet.</div></div>';
      return;
    }

    const headHits = data.bodyParts.find(p => p.bodyPart === 'Head');
    const headPercentage = headHits ? headHits.percentage : 0;
    const headPct = parseFloat(headPercentage);

    let html = `
      <div class="flex gap-3 mb-4">
        <span class="bg-gray-600 text-white text-sm font-semibold px-3 py-1 rounded">Total Hits: ${data.totalHits}</span>
      </div>
      <div class="${headPct > 20 ? 'bg-red-900 border border-red-600' : 'bg-blue-900 border border-blue-600'} text-white text-sm px-3 py-2 rounded mb-4">
        <strong>Critical Hit Rate:</strong> ${headPercentage}% headshots
        ${headPct > 20 ? ' ⚠️ High headshot rate - watch out for snipers!' : ''}
      </div>
      <div class="space-y-3 mb-4">
    `;

    for (const part of data.bodyParts) {
      const icon = getBodyPartIcon(part.bodyPart);
      const barColor = getBodyPartColor(part.bodyPart);

      html += `
        <div class="bg-gray-600 p-4 rounded-lg">
          <div class="flex justify-between items-center mb-2">
            <span class="text-lg font-semibold">${icon} ${part.bodyPart}</span>
            <span class="text-gray-400 text-sm">${part.hitCount} hits (${part.percentage}%)</span>
          </div>
          <div class="w-full bg-gray-700 rounded-full h-6 mb-2">
            <div class="h-6 rounded-full ${barColor} flex items-center justify-center text-xs font-semibold"
                 style="width: ${part.percentage}%; min-width: ${part.percentage > 0 ? '2rem' : '0'}">
              ${parseFloat(part.percentage) >= 5 ? part.percentage + '%' : ''}
            </div>
          </div>
          <div class="flex gap-2 flex-wrap text-xs">
            <span class="bg-gray-500 text-white px-2 py-0.5 rounded">Total: ${part.totalDamage.toFixed(1)}</span>
            <span class="bg-blue-700 text-white px-2 py-0.5 rounded">Avg: ${part.avgDamage.toFixed(1)}</span>
            <span class="bg-yellow-700 text-white px-2 py-0.5 rounded">Max: ${part.maxDamage.toFixed(1)}</span>
          </div>
        </div>
      `;
    }

    html += '</div>';
    html += generateBodyDiagram(data.bodyParts, data.totalHits);

    document.getElementById('bodypart-stats-container').innerHTML = html;
  } catch (error) {
    console.error('Error loading body part stats:', error);
    document.getElementById('bodypart-stats-container').innerHTML =
      '<p class="text-red-400">Failed to load body part stats.</p>';
  }
}

/**
 * Get icon for body part
 */
function getBodyPartIcon(bodyPart) {
  const icons = {
    'Head': '🧠',
    'Torso': '🫁',
    'LeftArm': '💪',
    'RightArm': '💪',
    'LeftLeg': '🦵',
    'RightLeg': '🦵',
    'LeftHand': '✋',
    'RightHand': '✋',
    'LeftFoot': '👟',
    'RightFoot': '👟'
  };
  return icons[bodyPart] || '📍';
}

/**
 * Get Tailwind CSS classes for body part bar based on criticality
 */
function getBodyPartColor(bodyPart) {
  if (bodyPart === 'Head') return 'bg-red-600';
  if (bodyPart === 'Torso') return 'bg-yellow-600';
  return 'bg-blue-600';
}

/**
 * Generate simple body diagram showing hit distribution
 */
function generateBodyDiagram(bodyParts, totalHits) {
  const HIGH_THRESHOLD = 30;
  const MEDIUM_THRESHOLD = 15;
  const LOW_THRESHOLD = 5;

  const hitMap = {};
  bodyParts.forEach(part => {
    hitMap[part.bodyPart] = part.percentage;
  });

  const getHitIntensity = (bodyPart) => {
    const percentage = parseFloat(hitMap[bodyPart] || 0);
    if (percentage > HIGH_THRESHOLD) return 'high';
    if (percentage > MEDIUM_THRESHOLD) return 'medium';
    if (percentage > LOW_THRESHOLD) return 'low';
    return 'none';
  };

  return `
    <div class="body-diagram mt-4">
      <h6 class="font-semibold mb-2">Hit Distribution Map</h6>
      <div class="diagram-container">
        <div class="body-part-visual head ${getHitIntensity('Head')}">
          <span class="part-label">Head</span>
          <span class="part-percentage">${hitMap['Head'] || '0'}%</span>
        </div>
        <div class="body-row">
          <div class="body-part-visual arm ${getHitIntensity('LeftArm')}">
            <span class="part-label">L Arm</span>
            <span class="part-percentage">${hitMap['LeftArm'] || '0'}%</span>
          </div>
          <div class="body-part-visual torso ${getHitIntensity('Torso')}">
            <span class="part-label">Torso</span>
            <span class="part-percentage">${hitMap['Torso'] || '0'}%</span>
          </div>
          <div class="body-part-visual arm ${getHitIntensity('RightArm')}">
            <span class="part-label">R Arm</span>
            <span class="part-percentage">${hitMap['RightArm'] || '0'}%</span>
          </div>
        </div>
        <div class="body-row">
          <div class="body-part-visual leg ${getHitIntensity('LeftLeg')}">
            <span class="part-label">L Leg</span>
            <span class="part-percentage">${hitMap['LeftLeg'] || '0'}%</span>
          </div>
          <div class="body-part-visual spacer"></div>
          <div class="body-part-visual leg ${getHitIntensity('RightLeg')}">
            <span class="part-label">R Leg</span>
            <span class="part-percentage">${hitMap['RightLeg'] || '0'}%</span>
          </div>
        </div>
      </div>
      <div class="diagram-legend mt-3 text-sm">
        <span class="legend-item"><span class="legend-color high"></span> &gt;${HIGH_THRESHOLD}% hits</span>
        <span class="legend-item"><span class="legend-color medium"></span> ${MEDIUM_THRESHOLD}-${HIGH_THRESHOLD}% hits</span>
        <span class="legend-item"><span class="legend-color low"></span> ${LOW_THRESHOLD}-${MEDIUM_THRESHOLD}% hits</span>
        <span class="legend-item"><span class="legend-color none"></span> &lt;${LOW_THRESHOLD}% hits</span>
      </div>
    </div>
  `;
}

/**
 * Capitalize the first letter of a string
 */
function capitalizeFirst(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Get status icon based on health status
 */
function getStatusIcon(status) {
  switch (status) {
    case 'alive': return '🟢';
    case 'dead': return '🔴';
    case 'unconscious': return '🟡';
    default: return '⚪';
  }
}

/**
 * Get HP bar color classes based on percentage
 */
function getHPColor(hpPercent) {
  if (hpPercent > 75) return { bar: 'bg-green-500', text: 'text-green-400' };
  if (hpPercent > 50) return { bar: 'bg-blue-500', text: 'text-blue-400' };
  if (hpPercent > 25) return { bar: 'bg-yellow-500', text: 'text-yellow-400' };
  return { bar: 'bg-red-500', text: 'text-red-400' };
}

/**
 * Format duration in seconds to readable string
 */
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes} min`;
}

/**
 * Get time since a date as a human-readable string
 */
function getTimeSince(date) {
  const now = new Date();
  const diff = now - date;
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) {
    return 'Just now';
  } else if (hours < 24) {
    return `${hours}h ago`;
  } else {
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }
}

function backToGuilds() {
  currentGuildId = null;
  currentServerId = null;
  currentIdentityId = null;
  currentEconomyServerId = null;
  window.currentEconomyServerId = null;
  const playerNavEl = document.getElementById('playerNav');
  if (playerNavEl) playerNavEl.style.display = 'none';
  showSection('guilds');
  loadGuilds();
}

// Event Listeners
/**
 * Get icon for structure type
 */
function getStructureIcon(structureType) {
  if (!structureType) return '🏗️';
  const s = structureType.toLowerCase();
  if (s.includes('flag') || s.includes('territory')) return '🚩';
  if (s.includes('watchtower') || s.includes('tower')) return '🗼';
  if (s.includes('gate')) return '🚪';
  if (s.includes('fence') || s.includes('fencekit')) return '🚧';
  if (s.includes('wall')) return '🧱';
  if (s.includes('tent') || s.includes('party')) return '⛺';
  if (s.includes('barrel')) return '🛢️';
  if (s.includes('crate') || s.includes('woodencrate')) return '📦';
  if (s.includes('chest') || s.includes('seachest')) return '🗃️';
  if (s.includes('fireplace') || s.includes('fire')) return '🔥';
  if (s.includes('generator') || s.includes('power')) return '⚡';
  if (s.includes('light') || s.includes('spotlight')) return '💡';
  if (s.includes('mine') || s.includes('claymore') || s.includes('explosive') || s.includes('plastic')) return '💣';
  if (s.includes('barbedwire')) return '🔗';
  if (s.includes('cable')) return '🔌';
  if (s.includes('plot') || s.includes('garden')) return '🌱';
  if (s.includes('watchtower')) return '🗼';
  return '🏗️';
}

/**
 * Convert a raw class name to a human-readable label.
 * Falls back to the class name with underscores replaced by spaces.
 */
function getFriendlyStructureName(structureType) {
  if (!structureType) return 'Unknown';
  const names = {
    'FenceKit': 'Fence Kit',
    'Fence': 'Fence',
    'Gate': 'Gate',
    'Watchtower': 'Watchtower',
    'WatchtowerKit': 'Watchtower Kit',
    'TerritoryFlag': 'Territory Flag',
    'TerritoryFlagKit': 'Flag Pole Kit',
    'WoodenCrate': 'Wooden Crate',
    'SeaChest': 'Sea Chest',
    'Barrel_Green': 'Green Barrel',
    'Barrel_Blue': 'Blue Barrel',
    'Barrel_Red': 'Red Barrel',
    'Barrel_Yellow': 'Yellow Barrel',
    'BarrelHoles_Green': 'Fire Barrel',
    'Fireplace': 'Fireplace',
    'MediumTent': 'Medium Tent',
    'MediumTent_Orange': 'Orange Tent',
    'MediumTent_Green': 'Green Tent',
    'PartyTent': 'Canopy Tent',
    'PartyTent_Lunapark': 'Canopy Tent',
    'PowerGenerator': 'Power Generator',
    'Spotlight': 'Construction Light',
    'CableReel': 'Cable Reel',
    'HescoBox': 'Wire Mesh Barrier',
    'GardenPlot': 'Garden Plot',
    'BarbedWire': 'Barbed Wire',
    'ClaymoreMine': 'Claymore',
    'LandMineTrap': 'Land Mine',
    'ImprovisedExplosive': 'IED',
    'Plastic_Explosive': 'Plastic Explosive',
    'FireworksLauncher': 'Fireworks Launcher',
  };
  return names[structureType] || structureType.replace(/_/g, ' ');
}

/**
 * Get icon for event type
 */
function getEventIcon(eventType) {
  const icons = {
    'placed': '✅',
    'built': '🔨',
    'mounted': '🔗',
    'raised': '🚩',
    'dismantled': '🔧',
    'folded': '📥',
    'unmounted': '❌',
    'destroyed': '💥',
    'removed': '❌'
  };
  return icons[eventType] || '📍';
}

/**
 * Load territory statistics for a player identity
 */
async function loadTerritoryStats(identityId) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/territory/${identityId}/stats`));
    const data = await response.json();

    if (!data.success || data.stats.length === 0) {
      document.getElementById('territory-stats-container').innerHTML =
        '<div class="dzc-empty"><div class="dzc-empty-title">No territory events found. Build something!</div></div>';
      return;
    }

    const byType = {};
    data.stats.forEach(stat => {
      if (!byType[stat.eventType]) byType[stat.eventType] = [];
      byType[stat.eventType].push(stat);
    });

    const totalBuilt = (byType['built'] || []).reduce((sum, s) => sum + s.count, 0);
    const totalPlaced = (byType['placed'] || []).reduce((sum, s) => sum + s.count, 0);
    const totalMounted = (byType['mounted'] || []).reduce((sum, s) => sum + s.count, 0);
    const totalDismantled = (byType['dismantled'] || []).reduce((sum, s) => sum + s.count, 0) +
                            (byType['folded'] || []).reduce((sum, s) => sum + s.count, 0);

    // Group placed items by structure type for breakdown
    const placedByItem = {};
    (byType['placed'] || []).forEach(stat => {
      const label = getFriendlyStructureName(stat.structureType);
      if (!placedByItem[label]) placedByItem[label] = { count: 0, structureType: stat.structureType };
      placedByItem[label].count += stat.count;
    });

    // Group built structures by type
    const builtByType = {};
    (byType['built'] || []).forEach(stat => {
      const label = getFriendlyStructureName(stat.structureType);
      if (!builtByType[label]) builtByType[label] = { count: 0, structureType: stat.structureType };
      builtByType[label].count += stat.count;
    });

    let html = `
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <div class="bg-gray-600 p-3 rounded-lg text-center">
          <div class="text-2xl font-bold text-green-400">${totalBuilt}</div>
          <div class="text-xs text-gray-400">Structures Built</div>
        </div>
        <div class="bg-gray-600 p-3 rounded-lg text-center">
          <div class="text-2xl font-bold text-blue-400">${totalPlaced}</div>
          <div class="text-xs text-gray-400">Items Placed</div>
        </div>
        <div class="bg-gray-600 p-3 rounded-lg text-center">
          <div class="text-2xl font-bold text-yellow-400">${totalMounted}</div>
          <div class="text-xs text-gray-400">Barbed Wire Mounted</div>
        </div>
        <div class="bg-gray-600 p-3 rounded-lg text-center">
          <div class="text-2xl font-bold text-red-400">${totalDismantled}</div>
          <div class="text-xs text-gray-400">Dismantled/Folded</div>
        </div>
      </div>
    `;

    // Built breakdown
    if (Object.keys(builtByType).length > 0) {
      html += `<p class="text-sm text-gray-400 mb-2 font-semibold">🔨 Built</p><div class="flex flex-wrap gap-2 mb-4">`;
      for (const [label, data] of Object.entries(builtByType)) {
        const icon = getStructureIcon(data.structureType);
        html += `
          <div class="bg-gray-600 p-2 rounded-lg text-center min-w-16">
            <div class="text-xl">${icon}</div>
            <div class="text-xs font-semibold">${label}</div>
            <div class="text-xs text-green-400">×${data.count}</div>
          </div>`;
      }
      html += `</div>`;
    }

    // Placed breakdown
    if (Object.keys(placedByItem).length > 0) {
      html += `<p class="text-sm text-gray-400 mb-2 font-semibold">✅ Placed</p><div class="flex flex-wrap gap-2">`;
      for (const [label, d] of Object.entries(placedByItem)) {
        const icon = getStructureIcon(d.structureType);
        html += `
          <div class="bg-gray-600 p-2 rounded-lg text-center min-w-16">
            <div class="text-xl">${icon}</div>
            <div class="text-xs font-semibold">${label}</div>
            <div class="text-xs text-blue-400">×${d.count}</div>
          </div>`;
      }
      html += `</div>`;
    }

    html += '</div>';
    document.getElementById('territory-stats-container').innerHTML = html;

  } catch (error) {
    console.error('Error loading territory stats:', error);
    document.getElementById('territory-stats-container').innerHTML =
      '<p class="text-red-400">Failed to load territory stats.</p>';
  }
}

/**
 * Load recent territory events for a player identity
 */
async function loadTerritoryEvents(identityId, limit = 20) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/territory/${identityId}`, { limit }));
    const data = await response.json();

    if (!data.success || data.territoryEvents.length === 0) {
      document.getElementById('territory-events-container').innerHTML =
        '<div class="dzc-empty"><div class="dzc-empty-title">No recent territory events.</div></div>';
      return;
    }

    let html = `
      <h4 class="text-xl font-bold mb-3">Recent Events</h4>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-600">
            <tr>
              <th class="p-2 text-left">Time</th>
              <th class="p-2 text-left">Event</th>
              <th class="p-2 text-left">Structure</th>
              <th class="p-2 text-left">Position</th>
              <th class="p-2 text-left">Server</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const event of data.territoryEvents) {
      const timestamp = new Date(event.timestamp).toLocaleString();
      const icon = getStructureIcon(event.structureType);
      const eventIcon = getEventIcon(event.eventType);
      const isDestructive = ['destroyed', 'removed', 'folded', 'unmounted', 'dismantled'].includes(event.eventType);
      const eventClass = isDestructive ? 'text-red-400' : 'text-green-400';
      const friendlyName = getFriendlyStructureName(event.structureType);
      const serverName = event.serverName || event.server_name || 'Unknown';

      html += `
        <tr class="border-b border-gray-600">
          <td class="p-2"><small>${timestamp}</small></td>
          <td class="p-2 ${eventClass}">${eventIcon} ${capitalizeFirst(event.eventType)}</td>
          <td class="p-2">${icon} ${friendlyName}</td>
          <td class="p-2"><span class="font-mono text-xs">${event.position || 'N/A'}</span></td>
          <td class="p-2"><small>${serverName}</small></td>
        </tr>
      `;
    }

    html += '</tbody></table></div>';
    document.getElementById('territory-events-container').innerHTML = html;

} catch (error) {
    console.error('Error loading territory events:', error);
    document.getElementById('territory-events-container').innerHTML =
      '<p class="text-red-400">Failed to load territory events.</p>';
  }
}

/**
 * Load favorite weapons (by kill count) for a player identity
 */
async function loadFavoriteWeapons(identityId, limit = 5) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/favorite-weapons/${identityId}`, { limit }));
    const data = await response.json();

    if (!data.success || data.weapons.length === 0) {
      document.getElementById('favorite-weapons-container').innerHTML =
        '<div class="dzc-empty"><div class="dzc-empty-title">No kills tracked yet.</div></div>';
      return;
    }

    let html = '<div class="space-y-2">';
    data.weapons.forEach((weapon, index) => {
      const icon = index === 0 ? '👑' : '🔫';
      html += `
        <div class="bg-gray-600 p-3 rounded-lg flex justify-between items-center">
          <span>${icon} <strong>${weapon.weapon}</strong></span>
          <div class="text-sm text-gray-300">
            <span class="bg-green-700 px-2 py-1 rounded mr-2">${weapon.killCount} kills</span>
            ${weapon.avgDistance ? `<span>${weapon.avgDistance.toFixed(0)}m avg</span>` : ''}
          </div>
        </div>
      `;
    });
    html += '</div>';

    document.getElementById('favorite-weapons-container').innerHTML = html;
  } catch (error) {
    console.error('Error loading favorite weapons:', error);
    document.getElementById('favorite-weapons-container').innerHTML =
      '<p class="text-red-400">Failed to load favorite weapons.</p>';
  }
}

/**
 * Load recent kills for a player identity
 */
async function loadRecentKills(identityId, limit = 10) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/recent-kills/${identityId}`, { limit }));
    const data = await response.json();

    if (!data.success || data.kills.length === 0) {
      document.getElementById('recent-kills-container').innerHTML =
        '<div class="dzc-empty"><div class="dzc-empty-title">No kills tracked yet.</div></div>';
      return;
    }

    let html = `
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-600">
            <tr>
              <th class="p-2 text-left">Time</th>
              <th class="p-2 text-left">Victim</th>
              <th class="p-2 text-left">Weapon</th>
              <th class="p-2 text-left">Distance</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const kill of data.kills) {
      const timestamp = new Date(kill.timestamp).toLocaleString();
      html += `
        <tr class="border-b border-gray-600">
          <td class="p-2"><small>${timestamp}</small></td>
          <td class="p-2 font-semibold">${kill.victimGamertag || 'Unknown'}</td>
          <td class="p-2"><span class="font-mono text-xs">${kill.weapon || 'Unknown'}</span></td>
          <td class="p-2">${kill.distance ? kill.distance.toFixed(0) + 'm' : 'N/A'}</td>
        </tr>
      `;
    }

    html += '</tbody></table></div>';
    document.getElementById('recent-kills-container').innerHTML = html;
  } catch (error) {
    console.error('Error loading recent kills:', error);
    document.getElementById('recent-kills-container').innerHTML =
      '<p class="text-red-400">Failed to load recent kills.</p>';
  }
}

/**
 * Load recent deaths for a player identity
 */
async function loadRecentDeaths(identityId, limit = 10) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/recent-deaths/${identityId}`, { limit }));
    const data = await response.json();

    if (!data.success || data.deaths.length === 0) {
      document.getElementById('recent-deaths-container').innerHTML =
        '<div class="dzc-empty"><div class="dzc-empty-title">No deaths tracked yet.</div></div>';
      return;
    }

    let html = `
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-600">
            <tr>
              <th class="p-2 text-left">Time</th>
              <th class="p-2 text-left">Killer</th>
              <th class="p-2 text-left">Weapon</th>
              <th class="p-2 text-left">Distance</th>
            </tr>
          </thead>
          <tbody>
    `;

    for (const death of data.deaths) {
      const timestamp = new Date(death.timestamp).toLocaleString();
      html += `
        <tr class="border-b border-gray-600">
          <td class="p-2"><small>${timestamp}</small></td>
          <td class="p-2 font-semibold">${death.killerGamertag || 'Unknown'}</td>
          <td class="p-2"><span class="font-mono text-xs">${death.weapon || 'Unknown'}</span></td>
          <td class="p-2">${death.distance ? death.distance.toFixed(0) + 'm' : 'N/A'}</td>
        </tr>
      `;
    }

    html += '</tbody></table></div>';
    document.getElementById('recent-deaths-container').innerHTML = html;
  } catch (error) {
    console.error('Error loading recent deaths:', error);
    document.getElementById('recent-deaths-container').innerHTML =
      '<p class="text-red-400">Failed to load recent deaths.</p>';
  }
}

/**
 * Load playtime breakdown by hour of day for a player identity
 */
async function loadPlaytimeBreakdown(identityId) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/playtime-breakdown/${identityId}`));
    const data = await response.json();

    if (!data.success || data.breakdown.length === 0) {
      document.getElementById('playtime-breakdown-container').innerHTML =
        '<div class="dzc-empty"><div class="dzc-empty-title">No session data available yet.</div></div>';
      return;
    }

    const maxMinutes = Math.max(...data.breakdown.map(b => b.minutes), 1);

    let html = '<div class="space-y-2">';
    for (const entry of data.breakdown) {
      const hourLabel = `${String(entry.hour).padStart(2, '0')}:00`;
      const pct = Math.round((entry.minutes / maxMinutes) * 100);
      html += `
        <div class="flex items-center gap-3">
          <span class="text-gray-400 text-sm w-14 text-right">${hourLabel}</span>
          <div class="flex-1 bg-gray-700 rounded-full h-5">
            <div class="bg-blue-600 h-5 rounded-full flex items-center justify-end pr-2 text-xs font-semibold"
                 style="width: ${pct}%; min-width: ${pct > 0 ? '2rem' : '0'}">
              ${pct > 10 ? entry.minutes + 'm' : ''}
            </div>
          </div>
          <span class="text-gray-400 text-xs w-12">${entry.sessions} sess.</span>
        </div>
      `;
    }
    html += '</div>';

    document.getElementById('playtime-breakdown-container').innerHTML = html;
  } catch (error) {
    console.error('Error loading playtime breakdown:', error);
    document.getElementById('playtime-breakdown-container').innerHTML =
      '<p class="text-red-400">Failed to load playtime breakdown.</p>';
  }
}

/**
 * Load death cause breakdown and survival (unconscious) stats for a player.
 * Data comes from player_death_events and player_unconscious_events tables,
 * which are populated from ADM log death/unconscious patterns.
 */
async function loadDeathStats(identityId) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/death-stats/${identityId}`));
    const data = await response.json();

    if (!data.success) {
      document.getElementById('death-stats-container').innerHTML =
        '<div class="dzc-empty"><div class="dzc-empty-title">No survival data available yet.</div></div>';
      return;
    }

    const { deathBreakdown, npcKillers, unconscious } = data;
    const totalTrackedDeaths = deathBreakdown.reduce((sum, d) => sum + d.count, 0);

    const deathTypeLabels = {
      died:           { label: 'Natural Death (hunger/thirst)', icon: '💧' },
      bled_out:       { label: 'Bled Out',                      icon: '🩸' },
      suicide:        { label: 'Suicide (respawn)',              icon: '💊' },
      killed_by_npc:  { label: 'Killed by NPC',                 icon: '🧟' },
      drowned:        { label: 'Drowned',                        icon: '🌊' }
    };

    let html = '<div class="grid grid-cols-1 md:grid-cols-2 gap-6">';

    // Death cause breakdown
    html += `
      <div>
        <h4 class="text-lg font-bold mb-3">☠️ Cause of Death</h4>`;
    if (totalTrackedDeaths === 0) {
      html += '<div class="dzc-empty"><div class="dzc-empty-title">No deaths recorded yet.</div></div>';
    } else {
      for (const row of deathBreakdown) {
        const meta = deathTypeLabels[row.deathType] || { label: row.deathType, icon: '❓' };
        const pct = Math.round((row.count / totalTrackedDeaths) * 100);
        html += `
          <div class="mb-3">
            <div class="flex justify-between text-sm mb-1">
              <span>${meta.icon} ${meta.label}</span>
              <span class="font-semibold">${row.count} (${pct}%)</span>
            </div>
            <div class="w-full bg-gray-600 rounded-full h-2">
              <div class="bg-red-500 h-2 rounded-full" style="width: ${pct}%"></div>
            </div>
          </div>`;
      }
    }

    // NPC killers
    if (npcKillers.length > 0) {
      html += '<div class="mt-4"><h4 class="text-sm font-bold text-gray-400 mb-2">Top NPC Killers</h4>';
      for (const npc of npcKillers) {
        const name = npc.killedBy.replace(/^Zmb[MF]_/, '').replace(/_/g, ' ');
        html += `<div class="flex justify-between text-sm py-1 border-b border-gray-600">
          <span class="text-gray-300">🧟 ${name}</span>
          <span class="font-semibold">${npc.count}x</span>
        </div>`;
      }
      html += '</div>';
    }

    html += '</div>';

    // Unconscious stats
    html += `
      <div>
        <h4 class="text-lg font-bold mb-3">😵 Knocked Out History</h4>
        <div class="space-y-3">
          <div class="bg-gray-600 p-4 rounded-lg flex items-center gap-4">
            <span class="text-3xl">🤕</span>
            <div>
              <div class="text-2xl font-bold text-yellow-400">${unconscious.timesKnockedOut}</div>
              <div class="text-sm text-gray-400">Times Knocked Out</div>
            </div>
          </div>
          <div class="bg-gray-600 p-4 rounded-lg flex items-center gap-4">
            <span class="text-3xl">💪</span>
            <div>
              <div class="text-2xl font-bold text-green-400">${unconscious.timesRevived}</div>
              <div class="text-sm text-gray-400">Times Regained Consciousness</div>
            </div>
          </div>
          <div class="bg-gray-600 p-4 rounded-lg flex items-center gap-4">
            <span class="text-3xl">🚪</span>
            <div>
              <div class="text-2xl font-bold text-gray-400">${unconscious.timesDisconnectedWhileKO}</div>
              <div class="text-sm text-gray-400">Disconnected While KO</div>
            </div>
          </div>
        </div>
      </div>`;

    html += '</div>';
    document.getElementById('death-stats-container').innerHTML = html;
  } catch (error) {
    console.error('Error loading death stats:', error);
    document.getElementById('death-stats-container').innerHTML =
      '<p class="text-red-400">Failed to load survival stats.</p>';
  }
}

/**
 * Get achievement icon based on achievement name
 */
function getAchievementIcon(achievementName) {
  const icons = {
    'First Steps': '🥾',
    'Regular': '📅',
    'Dedicated Survivor': '⏱️',
    'Marathon Survivor': '🏕️',
    'Iron Will': '💪',
    'First Blood': '🩸',
    'Skirmisher': '⚔️',
    'Veteran': '🎖️',
    'Centurion': '💯',
    'Close and Personal': '🔪',
    'Long Shot': '🏹',
    'Lobotomy': '🧠',
    'Arsenal': '🔫',
    'Damage Dealer': '💥',
    'Builder': '🏗️',
    'Architect': '🧱',
    'Doomsday Prepper': '🛢️',
    'Friendly Face': '👋',
    'Social Butterfly': '🦋'
  };
  return icons[achievementName] || '🏆';
}

// ─── Emote Stats ─────────────────────────────────────────────────────────────

/**
 * Load and render emote statistics for the given identity.
 * Populates the #emotes-top-container bar chart and #emotes-recent-body table.
 */
async function loadEmoteStats(identityId) {
  try {
    const res  = await fetch(playerApiUrl(`/api/player/emotes/${identityId}`));
    const data = await res.json();

    if (!data.ok) {
      document.getElementById('emotes-top-container').innerHTML =
        `<p class="text-red-400">❌ ${data.error || 'Failed to load emote stats'}</p>`;
      return;
    }

    // Top emotes bar chart
    const topEl = document.getElementById('emotes-top-container');
    if (!data.topEmotes || data.topEmotes.length === 0) {
      topEl.innerHTML = '<div class="dzc-empty"><div class="dzc-empty-title">No emotes recorded yet.</div></div>';
    } else {
      const maxCnt = data.topEmotes[0].count || 1;
      topEl.innerHTML = `<p class="text-sm text-gray-400 mb-3">Total emotes: <strong>${data.total.toLocaleString()}</strong></p>` +
        data.topEmotes.map(e => {
          const pct = Math.round((e.count / maxCnt) * 100);
          return `<div class="mb-3">
            <div class="flex justify-between text-sm mb-1">
              <span class="text-gray-200">${escHtml(e.emote_type)}</span>
              <span class="text-indigo-300 font-bold">${e.count}</span>
            </div>
            <div class="h-2 bg-gray-700 rounded">
              <div class="h-2 bg-indigo-500 rounded" style="width:${pct}%"></div>
            </div>
          </div>`;
        }).join('');
    }

    // Recent emotes table
    const tbody = document.getElementById('emotes-recent-body');
    if (!data.recent || data.recent.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-gray-400">No recent emotes</td></tr>';
    } else {
      tbody.innerHTML = data.recent.map(r => {
        const ts = r.timestamp ? new Date(r.timestamp).toLocaleString() : '—';
        const pos = (r.pos_x != null && r.pos_z != null)
          ? `${Math.round(r.pos_x)}, ${Math.round(r.pos_z)}`
          : '—';
        return `<tr class="border-t border-gray-700 text-sm">
          <td class="py-2 pr-4">${escHtml(r.emote_type)}</td>
          <td class="py-2 pr-4 text-gray-300">${escHtml(r.item_name || '—')}</td>
          <td class="py-2 pr-4 text-gray-400">${pos}</td>
          <td class="py-2 text-gray-400 text-xs">${ts}</td>
        </tr>`;
      }).join('');
    }
  } catch (err) {
    console.error('Error loading emote stats:', err);
    document.getElementById('emotes-top-container').innerHTML =
      '<p class="text-red-400">❌ Failed to load emote stats</p>';
  }
}

/**
 * Load achievements for a player identity
 */
async function loadAchievements(identityId) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/achievement-progress/${identityId}`));
    const progressData = await response.json();
    if (!progressData.success || !Array.isArray(progressData.achievements) || !progressData.progression) {
      document.getElementById('achievements-container').innerHTML =
        '<p class="text-gray-400">Failed to load achievements.</p>';
      return;
    }

    const achievements = progressData.achievements;
    const progression = progressData.progression;
    const unlockedCount = achievements.filter(item => item.unlocked).length;
    const countEl = document.getElementById('achievement-count');
    if (countEl) countEl.textContent = `${unlockedCount}/${achievements.length} unlocked · Level ${progression.level}`;

    let html = `<div class="space-y-6">
      <div class="bg-gradient-to-r from-indigo-900 to-purple-900 border border-indigo-500 rounded-lg p-5">
        <div class="flex flex-wrap items-end justify-between gap-3 mb-3">
          <div>
            <div class="text-sm uppercase tracking-wide text-indigo-300">Server progression</div>
            <div class="text-3xl font-bold">Level ${progression.level}</div>
          </div>
          <div class="text-right">
            <div class="text-xl font-bold text-yellow-300">${Number(progression.totalXp).toLocaleString()} XP</div>
            <div class="text-xs text-indigo-200">${Number(progression.currentLevelXp).toLocaleString()} / ${Number(progression.nextLevelXp).toLocaleString()} XP to progress</div>
          </div>
        </div>
        <div class="w-full bg-gray-900 rounded-full h-3">
          <div class="bg-gradient-to-r from-blue-500 to-purple-500 h-3 rounded-full" style="width: ${Math.max(0, Math.min(100, progression.progressPercent))}%"></div>
        </div>
        <div class="text-xs text-indigo-200 mt-2">XP is calculated from this server's tracked playtime, combat, building, recoveries, and unlocked achievements.</div>
      </div>`;

    const tiers = new Map();
    for (const achievement of achievements) {
      if (!tiers.has(achievement.tierLabel)) tiers.set(achievement.tierLabel, []);
      tiers.get(achievement.tierLabel).push(achievement);
    }

    for (const [label, tierAchievements] of tiers) {
      html += `<div>
        <h4 class="text-xl font-bold mb-3">${escHtml(label)}</h4>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">`;

      for (const achievement of tierAchievements) {
        const percentage = Math.min(100, Math.round((achievement.current / achievement.required) * 100));
        const icon = achievement.icon || getAchievementIcon(achievement.name);
        html += `
          <div class="bg-gray-600 p-4 rounded-lg ${achievement.unlocked ? 'border-2 border-yellow-500' : 'opacity-70'}">
            <div class="flex items-start gap-3">
              <span class="text-3xl">${icon}</span>
              <div class="flex-1 min-w-0">
                <div class="flex justify-between gap-2">
                  <div class="font-bold">${escHtml(achievement.name)}</div>
                  ${achievement.unlocked ? '<div class="text-xs text-yellow-300 whitespace-nowrap">+250 XP</div>' : ''}
                </div>
                <div class="text-xs text-gray-300 mt-1">${escHtml(achievement.description)}</div>
                <div class="text-xs ${achievement.unlocked ? 'text-green-400' : 'text-gray-400'} mt-2">
                  ${achievement.unlocked ? '✓ Unlocked' : escHtml(achievement.progressLabel)}
                </div>
                <div class="w-full bg-gray-700 rounded-full h-2 mt-1">
                  <div class="${achievement.unlocked ? 'bg-yellow-500' : 'bg-blue-600'} h-2 rounded-full" style="width: ${percentage}%"></div>
                </div>
              </div>
            </div>
          </div>`;
      }

      html += '</div></div>';
    }

    html += '</div>';
    document.getElementById('achievements-container').innerHTML = html;
  } catch (error) {
    console.error('Error loading achievements:', error);
    document.getElementById('achievements-container').innerHTML =
      '<p class="text-red-400">Failed to load achievements.</p>';
  }
}

/**
 * Load performance timeline (kills per day) for a player identity
 */
async function loadPerformanceTimeline(identityId, days = 30) {
  try {
    const response = await fetch(playerApiUrl(`/api/player/performance-timeline/${identityId}`, { days }));
    const data = await response.json();

    if (!data.success || data.timeline.length === 0) {
      document.getElementById('performance-container').innerHTML =
        '<div class="dzc-empty"><div class="dzc-empty-title">No kill data available for the selected period.</div></div>';
      return;
    }

    const maxKills = Math.max(...data.timeline.map(d => d.kills), 1);

    let html = `<p class="text-sm text-gray-400 mb-3">Last ${data.days} days</p><div class="space-y-1">`;
    for (const entry of data.timeline) {
      const pct = Math.round((entry.kills / maxKills) * 100);
      html += `
        <div class="flex items-center gap-3">
          <span class="text-gray-400 text-xs w-24 text-right">${entry.date}</span>
          <div class="flex-1 bg-gray-700 rounded h-5">
            <div class="bg-green-600 h-5 rounded flex items-center justify-end pr-2 text-xs font-semibold"
                 style="width: ${pct}%; min-width: ${pct > 0 ? '2rem' : '0'}">
              ${pct > 10 ? entry.kills : ''}
            </div>
          </div>
          <span class="text-gray-300 text-xs w-12">${entry.kills} kill${entry.kills !== 1 ? 's' : ''}</span>
        </div>
      `;
    }
    html += '</div>';

    document.getElementById('performance-container').innerHTML = html;
  } catch (error) {
    console.error('Error loading performance timeline:', error);
    document.getElementById('performance-container').innerHTML =
      '<p class="text-red-400">Failed to load performance timeline.</p>';
  }
}

// ============================================
// ECONOMY SYSTEM
// ============================================

let currentEconomyData = null;

/**
 * Load economy data for a player
 */
async function loadEconomy(identityId) {
  try {
    const response = await fetch(`/api/economy/player/${identityId}?serverId=${encodeURIComponent(currentEconomyServerId)}`);
    const data = await response.json();

    // The API only returns `enabled: false` when economy is disabled for the guild.
    // When economy is enabled the field is absent, so we must check for false explicitly.
    if (!data.success || data.enabled === false) {
      document.getElementById('economy-section').style.display = 'none';
      return;
    }

    currentEconomyData = data;
    document.getElementById('economy-section').style.display = 'block';

    const navEconomy = document.getElementById('nav-economy');
    if (navEconomy) navEconomy.style.display = 'block';

    const symbol = data.currency?.symbol || '$';
    const walletBalance = data.wallet?.cashOnHand ?? 0;
    const bankBalance = data.bank?.balance ?? 0;
    const bankEnabled = data.guildConfig?.bankEnabled;

    document.getElementById('economy-balances').innerHTML = `
      <div class="bg-gray-600 p-4 rounded-lg text-center">
        <p class="text-gray-400 text-sm mb-1">💵 Wallet</p>
        <p class="text-3xl font-bold text-green-400">${symbol}${walletBalance.toFixed(2)}</p>
      </div>
      <div class="bg-gray-600 p-4 rounded-lg text-center">
        <p class="text-gray-400 text-sm mb-1">🏦 Bank</p>
        <p class="text-3xl font-bold text-blue-400">${symbol}${bankBalance.toFixed(2)}</p>
      </div>
    `;

    // Also update economy tab balance elements if present
    const playerWalletEl = document.getElementById('playerWalletBalance');
    const playerBankEl = document.getElementById('playerBankBalance');
    const playerTotalEl = document.getElementById('playerTotalWealth');
    if (playerWalletEl) playerWalletEl.textContent = `${symbol}${walletBalance.toFixed(2)}`;
    if (playerBankEl) playerBankEl.textContent = `${symbol}${bankBalance.toFixed(2)}`;
    if (playerTotalEl) playerTotalEl.textContent = `${symbol}${(walletBalance + bankBalance).toFixed(2)}`;

    // Enable/disable buttons based on bank config
    const depositBtn = document.getElementById('depositBtn');
    const withdrawBtn = document.getElementById('withdrawBtn');
    const transferBtn = document.getElementById('transferBtn');
    if (depositBtn) depositBtn.disabled = !bankEnabled;
    if (withdrawBtn) withdrawBtn.disabled = !bankEnabled;
    if (depositBtn) depositBtn.classList.toggle('opacity-50', !bankEnabled);
    if (withdrawBtn) withdrawBtn.classList.toggle('opacity-50', !bankEnabled);

    const transferEnabled = data.guildConfig?.transferEnabled;
    if (transferBtn) transferBtn.disabled = !transferEnabled;
    if (transferBtn) transferBtn.classList.toggle('opacity-50', !transferEnabled);

    await loadRecentTransactions(identityId);
  } catch (error) {
    console.error('Error loading economy:', error);
  }
}

/**
 * Load recent transactions for a player
 */
async function loadRecentTransactions(identityId, limit = 10) {
  try {
    const response = await fetch(`/api/economy/player/${identityId}/transactions?serverId=${encodeURIComponent(currentEconomyServerId)}&limit=${limit}`);
    const data = await response.json();

    const container = document.getElementById('economy-transactions');
    if (!data.success || data.transactions.length === 0) {
      container.innerHTML = '<div class="dzc-empty"><div class="dzc-empty-title">No recent transactions.</div></div>';
      return;
    }

    const symbol = currentEconomyData?.currency?.symbol || '$';
    let html = '<div class="overflow-x-auto"><table class="w-full text-sm"><thead class="bg-gray-600"><tr>' +
      '<th class="p-2 text-left">Type</th><th class="p-2 text-left">Account</th>' +
      '<th class="p-2 text-right">Amount</th><th class="p-2 text-right">Balance After</th>' +
      '<th class="p-2 text-left">Description</th><th class="p-2 text-left">Time</th>' +
      '</tr></thead><tbody>';

    for (const tx of data.transactions) {
      const isPositive = tx.amount >= 0;
      const amountColor = isPositive ? 'text-green-400' : 'text-red-400';
      const amountStr = `${isPositive ? '+' : ''}${symbol}${tx.amount.toFixed(2)}`;
      const timeStr = tx.timestamp ? new Date(tx.timestamp).toLocaleString() : '-';
      html += `
        <tr class="border-b border-gray-600">
          <td class="p-2 capitalize">${tx.transactionType}</td>
          <td class="p-2 capitalize">${tx.accountType}</td>
          <td class="p-2 text-right font-semibold ${amountColor}">${amountStr}</td>
          <td class="p-2 text-right">${symbol}${(tx.balanceAfter || 0).toFixed(2)}</td>
          <td class="p-2 text-gray-400">${tx.description || '-'}</td>
          <td class="p-2 text-gray-400">${timeStr}</td>
        </tr>`;
    }

    html += '</tbody></table></div>';
    container.innerHTML = html;
  } catch (error) {
    console.error('Error loading transactions:', error);
  }
}

/**
 * Update deposit fee preview
 */
function updateDepositFeePreview(amount) {
  const feePercentage = currentEconomyData?.guildConfig?.bankDepositFeePercentage ?? 0;
  const symbol = currentEconomyData?.currency?.symbol || '$';
  const feeInfo = document.getElementById('depositFeeInfo');
  const feeAmountEl = document.getElementById('depositFeeAmount');
  const netAmountEl = document.getElementById('depositNetAmount');

  if (!feeInfo) return;

  const parsed = parseFloat(amount);
  if (!amount || isNaN(parsed) || parsed <= 0 || feePercentage === 0) {
    feeInfo.classList.add('hidden');
    return;
  }

  const fee = parsed * (feePercentage / 100);
  const net = parsed - fee;
  feeAmountEl.textContent = `${symbol}${fee.toFixed(2)} (${feePercentage}%)`;
  netAmountEl.textContent = `${symbol}${net.toFixed(2)}`;
  feeInfo.classList.remove('hidden');
}

/**
 * Update withdraw fee preview
 */
function updateWithdrawFeePreview(amount) {
  const feePercentage = currentEconomyData?.guildConfig?.bankWithdrawFeePercentage ?? 0;
  const symbol = currentEconomyData?.currency?.symbol || '$';
  const feeInfo = document.getElementById('withdrawFeeInfo');
  const feeAmountEl = document.getElementById('withdrawFeeAmount');
  const netAmountEl = document.getElementById('withdrawNetAmount');

  if (!feeInfo) return;

  const parsed = parseFloat(amount);
  if (!amount || isNaN(parsed) || parsed <= 0 || feePercentage === 0) {
    feeInfo.classList.add('hidden');
    return;
  }

  const fee = parsed * (feePercentage / 100);
  const net = parsed - fee;
  feeAmountEl.textContent = `${symbol}${fee.toFixed(2)} (${feePercentage}%)`;
  netAmountEl.textContent = `${symbol}${net.toFixed(2)}`;
  feeInfo.classList.remove('hidden');
}

/**
 * Perform deposit transaction
 */
async function performDeposit(identityId, amount) {
  const response = await fetchWithCsrf('/api/economy/deposit', {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ identityId, serverId: currentEconomyServerId, amount: parseFloat(amount) })
  });
  return response.json();
}

/**
 * Perform withdraw transaction
 */
async function performWithdraw(identityId, amount) {
  const response = await fetchWithCsrf('/api/economy/withdraw', {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ identityId, serverId: currentEconomyServerId, amount: parseFloat(amount) })
  });
  return response.json();
}

/**
 * Setup economy modal handlers
 */
function setupEconomyModals() {
  const depositBtn = document.getElementById('depositBtn');
  const withdrawBtn = document.getElementById('withdrawBtn');
  const depositModal = document.getElementById('depositModal');
  const withdrawModal = document.getElementById('withdrawModal');

  if (!depositBtn || !withdrawBtn) return;

  depositBtn.addEventListener('click', function() {
    if (this.disabled) return;
    const symbol = currentEconomyData?.currency?.symbol || '$';
    const walletBalance = currentEconomyData?.wallet?.cashOnHand ?? 0;
    document.getElementById('depositWalletBalance').textContent = `${symbol}${walletBalance.toFixed(2)}`;
    document.getElementById('depositAmount').value = '';
    document.getElementById('depositFeeInfo').classList.add('hidden');
    depositModal.classList.remove('hidden');
  });

  withdrawBtn.addEventListener('click', function() {
    if (this.disabled) return;
    const symbol = currentEconomyData?.currency?.symbol || '$';
    const bankBalance = currentEconomyData?.bank?.balance ?? 0;
    document.getElementById('withdrawBankBalance').textContent = `${symbol}${bankBalance.toFixed(2)}`;
    document.getElementById('withdrawAmount').value = '';
    document.getElementById('withdrawFeeInfo').classList.add('hidden');
    withdrawModal.classList.remove('hidden');
  });

  document.getElementById('cancelDepositBtn').addEventListener('click', () => {
    depositModal.classList.add('hidden');
  });

  document.getElementById('cancelWithdrawBtn').addEventListener('click', () => {
    withdrawModal.classList.add('hidden');
  });

  document.getElementById('depositAmount').addEventListener('input', function() {
    updateDepositFeePreview(this.value);
  });

  document.getElementById('withdrawAmount').addEventListener('input', function() {
    updateWithdrawFeePreview(this.value);
  });

  document.getElementById('confirmDepositBtn').addEventListener('click', async function() {
    const amount = document.getElementById('depositAmount').value;
    if (!amount || parseFloat(amount) <= 0) {
      alert('Please enter a valid amount');
      return;
    }
    this.disabled = true;
    this.textContent = 'Processing...';
    try {
      const data = await performDeposit(currentIdentityId, amount);
      if (data.success) {
        depositModal.classList.add('hidden');
        await loadEconomy(currentIdentityId);
        const economyTabEl = document.getElementById('economy-tab');
        if (economyTabEl && economyTabEl.style.display !== 'none') {
          loadPlayerTransactions(currentIdentityId, currentTransactionFilter, TRANSACTION_PAGE_SIZE, 0);
        }
        alert('Deposit successful!');
      } else {
        alert('Deposit failed: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Error processing deposit: ' + err.message);
    } finally {
      this.disabled = false;
      this.textContent = 'Confirm Deposit';
    }
  });

  document.getElementById('confirmWithdrawBtn').addEventListener('click', async function() {
    const amount = document.getElementById('withdrawAmount').value;
    if (!amount || parseFloat(amount) <= 0) {
      alert('Please enter a valid amount');
      return;
    }
    this.disabled = true;
    this.textContent = 'Processing...';
    try {
      const data = await performWithdraw(currentIdentityId, amount);
      if (data.success) {
        withdrawModal.classList.add('hidden');
        await loadEconomy(currentIdentityId);
        const economyTabEl = document.getElementById('economy-tab');
        if (economyTabEl && economyTabEl.style.display !== 'none') {
          loadPlayerTransactions(currentIdentityId, currentTransactionFilter, TRANSACTION_PAGE_SIZE, 0);
        }
        alert('Withdrawal successful!');
      } else {
        alert('Withdrawal failed: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Error processing withdrawal: ' + err.message);
    } finally {
      this.disabled = false;
      this.textContent = 'Confirm Withdrawal';
    }
  });
}

// ============================================
// TRANSFER SYSTEM
// ============================================

let selectedTransferRecipient = null;
let searchTimeout = null;

/**
 * Search for players to transfer money to
 */
async function searchPlayers(query, guildId) {
  try {
    const response = await fetch(`/api/economy/search-players?query=${encodeURIComponent(query)}&serverId=${encodeURIComponent(currentEconomyServerId)}&limit=10`);
    const data = await response.json();
    return data.success ? data.players : [];
  } catch (e) {
    console.error('Error searching players:', e);
    return [];
  }
}

/**
 * Display search results in the recipient results dropdown
 */
function displaySearchResults(players) {
  const resultsEl = document.getElementById('recipientResults');
  if (!resultsEl) return;

  if (!players || players.length === 0) {
    resultsEl.innerHTML = '<div class="dzc-empty"><div class="dzc-empty-title">No players found.</div></div>';
    resultsEl.classList.remove('hidden');
    return;
  }

  const symbol = currentEconomyData?.currency?.symbol || '$';
  let html = '';
  for (const player of players) {
    const onlineIndicator = player.isOnline
      ? '<span class="text-green-400 text-xs">● Online</span>'
      : '<span class="text-gray-500 text-xs">● Offline</span>';
    html += `
      <div class="p-3 hover:bg-gray-600 cursor-pointer border-b border-gray-600 last:border-b-0 flex justify-between items-center"
           data-identity-id="${player.identityId}"
           data-gamertag="${player.gamertag}"
           data-platform="${player.platform || ''}"
           data-online="${player.isOnline ? '1' : '0'}">
        <span class="font-semibold">${player.gamertag}</span>
        <span class="text-gray-400 text-xs ml-2">${player.platform || ''}</span>
        ${onlineIndicator}
      </div>`;
  }
  resultsEl.innerHTML = html;
  resultsEl.classList.remove('hidden');

  resultsEl.querySelectorAll('[data-identity-id]').forEach(el => {
    el.addEventListener('click', function() {
      selectRecipient({
        identityId: parseInt(this.dataset.identityId),
        gamertag: this.dataset.gamertag,
        platform: this.dataset.platform,
        isOnline: this.dataset.online === '1'
      });
    });
  });
}

/**
 * Select a recipient for the transfer
 */
function selectRecipient(player) {
  selectedTransferRecipient = player;

  document.getElementById('recipientSearch').value = '';
  document.getElementById('recipientResults').classList.add('hidden');
  document.getElementById('recipientResults').innerHTML = '';

  const selectedEl = document.getElementById('selectedRecipient');
  const nameEl = document.getElementById('selectedRecipientName');
  const platformEl = document.getElementById('selectedRecipientPlatform');

  if (nameEl) nameEl.textContent = player.gamertag;
  if (platformEl) {
    const onlineText = player.isOnline ? '● Online' : '● Offline';
    platformEl.textContent = `${player.platform || ''}  ${onlineText}`;
    platformEl.className = `text-sm mt-1 ${player.isOnline ? 'text-green-400' : 'text-gray-400'}`;
  }
  if (selectedEl) selectedEl.classList.remove('hidden');

  updateTransferFeePreview();
  updateTransferButtonState();
}

/**
 * Calculate transfer fees
 */
function calculateTransferFees(amount, recipientOnline) {
  const config = currentEconomyData?.guildConfig;
  if (!config) return { baseFee: 0, offlineFee: 0, totalFee: 0, netAmount: amount };

  const baseFee = amount * ((config.transferFeePercentage || 0) / 100);
  const offlineFee = !recipientOnline ? amount * ((config.transferOfflineFeePercentage || 0) / 100) : 0;
  const totalFee = baseFee + offlineFee;
  const netAmount = amount - totalFee;

  return { baseFee, offlineFee, totalFee, netAmount };
}

/**
 * Update transfer fee preview
 */
function updateTransferFeePreview() {
  const amountEl = document.getElementById('transferAmount');
  const feeInfoEl = document.getElementById('transferFeeInfo');
  const baseFeeEl = document.getElementById('transferBaseFee');
  const offlineFeeEl = document.getElementById('transferOfflineFee');
  const offlineFeeRowEl = document.getElementById('transferOfflineFeeRow');
  const netAmountEl = document.getElementById('transferNetAmount');

  if (!amountEl || !feeInfoEl) return;

  const amount = parseFloat(amountEl.value);
  if (!amount || amount <= 0 || !selectedTransferRecipient) {
    feeInfoEl.classList.add('hidden');
    return;
  }

  const symbol = currentEconomyData?.currency?.symbol || '$';
  const { baseFee, offlineFee, totalFee, netAmount } = calculateTransferFees(amount, selectedTransferRecipient.isOnline);

  const config = currentEconomyData?.guildConfig;
  const hasFee = (config?.transferFeePercentage || 0) > 0 || (config?.transferOfflineFeePercentage || 0) > 0;

  if (!hasFee) {
    feeInfoEl.classList.add('hidden');
    return;
  }

  feeInfoEl.classList.remove('hidden');
  if (baseFeeEl) baseFeeEl.textContent = `${symbol}${baseFee.toFixed(2)}`;
  if (offlineFeeRowEl) offlineFeeRowEl.style.display = offlineFee > 0 ? '' : 'none';
  if (offlineFeeEl) offlineFeeEl.textContent = `${symbol}${offlineFee.toFixed(2)}`;
  if (netAmountEl) netAmountEl.textContent = `${symbol}${netAmount.toFixed(2)}`;
}

/**
 * Enable or disable the Send Money button based on current form state
 */
function updateTransferButtonState() {
  const btn = document.getElementById('confirmTransfer');
  const amount = parseFloat(document.getElementById('transferAmount')?.value);
  if (!btn) return;
  const valid = selectedTransferRecipient && !isNaN(amount) && amount > 0;
  btn.disabled = !valid;
}

/**
 * Perform a transfer
 */
async function performTransfer(fromIdentityId, toIdentityId, amount, message) {
  const response = await fetchWithCsrf('/api/economy/transfer', {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ fromIdentityId, toIdentityId, serverId: currentEconomyServerId, amount, message })
  });
  return response.json();
}

/**
 * Load and display transfer history
 */
async function loadTransferHistory(identityId, direction = 'all') {
  const container = document.getElementById('transferHistoryList');
  if (!container) return;

  container.innerHTML = '<div class="dzc-skeleton" style="height:1.25rem;width:220px"></div>';

  try {
    const response = await fetch(`/api/economy/player/${identityId}/transfers?serverId=${encodeURIComponent(currentEconomyServerId)}&direction=${direction}&limit=50`);
    const data = await response.json();

    if (!data.success) {
      container.innerHTML = '<p class="text-red-400 text-sm">Failed to load transfer history.</p>';
      return;
    }

    const symbol = currentEconomyData?.currency?.symbol || '$';
    const sent = data.transfers.sent;
    const received = data.transfers.received;
    const all = [...sent.map(t => ({ ...t, dir: 'sent' })), ...received.map(t => ({ ...t, dir: 'received' }))]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    let items = direction === 'sent' ? sent.map(t => ({ ...t, dir: 'sent' }))
      : direction === 'received' ? received.map(t => ({ ...t, dir: 'received' }))
      : all;

    if (items.length === 0) {
      container.innerHTML = '<div class="dzc-empty"><div class="dzc-empty-title">No transfers found.</div></div>';
      return;
    }

    let html = '<div class="space-y-2">';
    for (const t of items) {
      const isSent = t.dir === 'sent';
      const other = isSent ? (t.toGamertag || `ID: ${t.toIdentityId}`) : (t.fromGamertag || `ID: ${t.fromIdentityId}`);
      const amountStr = isSent
        ? `<span class="text-red-400 font-bold">-${symbol}${t.amount.toFixed(2)}</span>`
        : `<span class="text-green-400 font-bold">+${symbol}${t.amount.toFixed(2)}</span>`;
      const timeStr = t.timestamp ? new Date(t.timestamp).toLocaleString() : '-';
      const msgStr = t.message ? `<p class="text-xs text-gray-400 mt-1">💬 ${t.message}</p>` : '';
      const feeStr = isSent && t.fee != null && t.fee > 0
        ? `<p class="text-xs text-yellow-400 mt-1">Fee: ${symbol}${t.fee.toFixed(2)}</p>` : '';

      html += `
        <div class="bg-gray-700 p-3 rounded">
          <div class="flex justify-between items-center">
            <div>
              <span class="text-sm font-semibold">${isSent ? '→ To' : '← From'}: ${other}</span>
              ${msgStr}
              ${feeStr}
            </div>
            <div class="text-right">
              ${amountStr}
              <p class="text-xs text-gray-400">${timeStr}</p>
            </div>
          </div>
        </div>`;
    }
    html += '</div>';
    container.innerHTML = html;
  } catch (error) {
    console.error('Error loading transfer history:', error);
    container.innerHTML = '<p class="text-red-400 text-sm">Error loading transfer history.</p>';
  }
}

/**
 * Setup transfer modal event handlers
 */
function setupTransferModal() {
  const transferBtn = document.getElementById('transferBtn');
  const transferModal = document.getElementById('transferModal');
  const transferHistoryModal = document.getElementById('transferHistoryModal');

  if (!transferBtn) return;

  // Open transfer modal
  transferBtn.addEventListener('click', function() {
    if (this.disabled) return;
    if (!currentEconomyData?.guildConfig?.transferEnabled) {
      alert('Transfers are not enabled for this community.');
      return;
    }

    // Reset form
    selectedTransferRecipient = null;
    document.getElementById('recipientSearch').value = '';
    document.getElementById('recipientResults').classList.add('hidden');
    document.getElementById('recipientResults').innerHTML = '';
    document.getElementById('selectedRecipient').classList.add('hidden');
    document.getElementById('transferAmount').value = '';
    document.getElementById('transferMessage').value = '';
    document.getElementById('transferFeeInfo').classList.add('hidden');
    document.getElementById('confirmTransfer').disabled = true;

    // Show available balance
    const symbol = currentEconomyData?.currency?.symbol || '$';
    const walletBalance = currentEconomyData?.wallet?.cashOnHand ?? 0;
    document.getElementById('transferAvailable').textContent = `${symbol}${walletBalance.toFixed(2)}`;

    // Show limits
    const config = currentEconomyData?.guildConfig;
    const limitsEl = document.getElementById('transferLimits');
    if (limitsEl && config) {
      const parts = [];
      if (config.transferMinAmount) parts.push(`Min: ${symbol}${config.transferMinAmount}`);
      if (config.transferMaxAmount) parts.push(`Max: ${symbol}${config.transferMaxAmount}`);
      limitsEl.textContent = parts.join('  ');
    }

    transferModal.classList.remove('hidden');
  });

  // Cancel transfer
  document.getElementById('cancelTransfer').addEventListener('click', () => {
    transferModal.classList.add('hidden');
  });

  // Clear recipient
  document.getElementById('clearRecipient').addEventListener('click', () => {
    selectedTransferRecipient = null;
    document.getElementById('selectedRecipient').classList.add('hidden');
    document.getElementById('recipientSearch').value = '';
    document.getElementById('transferFeeInfo').classList.add('hidden');
    updateTransferButtonState();
  });

  // Recipient search input (debounced)
  document.getElementById('recipientSearch').addEventListener('input', function() {
    clearTimeout(searchTimeout);
    const query = this.value.trim();
    const resultsEl = document.getElementById('recipientResults');

    if (query.length < 2) {
      resultsEl.classList.add('hidden');
      resultsEl.innerHTML = '';
      return;
    }

    searchTimeout = setTimeout(async () => {
      const players = await searchPlayers(query, currentGuildId);
      displaySearchResults(players);
    }, 300);
  });

  // Amount change
  document.getElementById('transferAmount').addEventListener('input', function() {
    updateTransferFeePreview();
    updateTransferButtonState();
  });

  // Confirm transfer
  document.getElementById('confirmTransfer').addEventListener('click', async function() {
    if (!selectedTransferRecipient) { alert('Please select a recipient.'); return; }
    const amount = document.getElementById('transferAmount').value;
    if (!amount || parseFloat(amount) <= 0) { alert('Please enter a valid amount.'); return; }
    const message = document.getElementById('transferMessage').value.trim();

    this.disabled = true;
    this.textContent = 'Sending...';

    try {
      const data = await performTransfer(currentIdentityId, selectedTransferRecipient.identityId, amount, message || null);
      if (data.success) {
        transferModal.classList.add('hidden');
        await loadEconomy(currentIdentityId);
        const economyTabEl = document.getElementById('economy-tab');
        if (economyTabEl && economyTabEl.style.display !== 'none') {
          loadPlayerTransactions(currentIdentityId, currentTransactionFilter, TRANSACTION_PAGE_SIZE, 0);
        }
        alert('Transfer successful!');
      } else {
        alert('Transfer failed: ' + (data.error || 'Unknown error'));
        this.disabled = false;
        this.textContent = 'Send Money';
      }
    } catch (err) {
      alert('Error processing transfer: ' + err.message);
      this.disabled = false;
      this.textContent = 'Send Money';
    }
  });

  // View transfer history
  let currentHistoryDirection = 'all';

  function setHistoryFilter(dir) {
    currentHistoryDirection = dir;
    ['all', 'sent', 'received'].forEach(d => {
      const btn = document.getElementById(`filter${d.charAt(0).toUpperCase() + d.slice(1)}`);
      if (btn) {
        btn.classList.toggle('bg-blue-600', d === dir);
        btn.classList.toggle('bg-gray-600', d !== dir);
      }
    });
    loadTransferHistory(currentIdentityId, dir);
  }

  const viewHistoryBtn = document.getElementById('viewTransferHistory');
  if (viewHistoryBtn) {
    viewHistoryBtn.addEventListener('click', () => {
      transferHistoryModal.classList.remove('hidden');
      setHistoryFilter('all');
    });
  }

  document.getElementById('closeTransferHistory').addEventListener('click', () => {
    transferHistoryModal.classList.add('hidden');
  });

  document.getElementById('filterAll').addEventListener('click', () => setHistoryFilter('all'));
  document.getElementById('filterSent').addEventListener('click', () => setHistoryFilter('sent'));
  document.getElementById('filterReceived').addEventListener('click', () => setHistoryFilter('received'));
}

// ============================================
// PLAYER ECONOMY DASHBOARD
// ============================================

let currentTransactionFilter = 'all';
let transactionOffset = 0;
const TRANSACTION_PAGE_SIZE = 20;

/**
 * Load player economy dashboard
 */
async function loadPlayerEconomyDashboard(identityId) {
  // Load economy first to populate currentEconomyData
  await loadEconomy(identityId);

  // Update account overview card in economy tab
  const symbol = currentEconomyData?.currency?.symbol || '$';
  const wallet = currentEconomyData?.wallet?.cashOnHand ?? 0;
  const bank = currentEconomyData?.bank?.balance ?? 0;
  const playerWalletEl = document.getElementById('playerWalletBalance');
  const playerBankEl = document.getElementById('playerBankBalance');
  const playerTotalEl = document.getElementById('playerTotalWealth');
  if (playerWalletEl) playerWalletEl.textContent = `${symbol}${wallet.toFixed(2)}`;
  if (playerBankEl) playerBankEl.textContent = `${symbol}${bank.toFixed(2)}`;
  if (playerTotalEl) playerTotalEl.textContent = `${symbol}${(wallet + bank).toFixed(2)}`;

  // Update action button states
  const bankEnabled = currentEconomyData?.guildConfig?.bankEnabled;
  const transferEnabled = currentEconomyData?.guildConfig?.transferEnabled;
  const playerDepositBtn = document.getElementById('playerDepositBtn');
  const playerWithdrawBtn = document.getElementById('playerWithdrawBtn');
  const playerTransferBtn = document.getElementById('playerTransferBtn');
  if (playerDepositBtn) {
    playerDepositBtn.disabled = !bankEnabled;
    playerDepositBtn.classList.toggle('opacity-50', !bankEnabled);
  }
  if (playerWithdrawBtn) {
    playerWithdrawBtn.disabled = !bankEnabled;
    playerWithdrawBtn.classList.toggle('opacity-50', !bankEnabled);
  }
  if (playerTransferBtn) {
    playerTransferBtn.disabled = !transferEnabled;
    playerTransferBtn.classList.toggle('opacity-50', !transferEnabled);
  }

  // Load remaining dashboard components in parallel
  await Promise.all([
    loadEarningsSummary(identityId),
    loadPlayerTransactions(identityId, currentTransactionFilter, TRANSACTION_PAGE_SIZE, 0),
    loadLeaderboardPreview(identityId)
  ]);
}

/**
 * Load earnings breakdown by source and time periods
 */
async function loadEarningsSummary(identityId) {
  try {
    const response = await fetch(`/api/economy/player/${identityId}/earnings-summary?serverId=${encodeURIComponent(currentEconomyServerId)}`);
    const data = await response.json();
    if (!data.success) return;

    const symbol = currentEconomyData?.currency?.symbol || '$';
    const e = data.earnings;

    const totalEarnedEl = document.getElementById('totalEarned');
    const last24hEl = document.getElementById('earningsLast24h');
    const last7dEl = document.getElementById('earningsLast7d');
    if (totalEarnedEl) totalEarnedEl.textContent = `${symbol}${(e.total || 0).toFixed(2)}`;
    if (last24hEl) last24hEl.textContent = `${symbol}${(e.last24h || 0).toFixed(2)}`;
    if (last7dEl) last7dEl.textContent = `${symbol}${(e.last7d || 0).toFixed(2)}`;

    const bySource = e.bySource || {};
    const killEl = document.getElementById('killEarnings');
    const playtimeEl = document.getElementById('playtimeEarnings');
    const achievementEl = document.getElementById('achievementEarnings');
    const transferEl = document.getElementById('transferEarnings');
    if (killEl) killEl.textContent = `${symbol}${(bySource.kill || 0).toFixed(2)}`;
    if (playtimeEl) playtimeEl.textContent = `${symbol}${(bySource.playtime || 0).toFixed(2)}`;
    if (achievementEl) achievementEl.textContent = `${symbol}${(bySource.achievement || 0).toFixed(2)}`;
    if (transferEl) transferEl.textContent = `${symbol}${(bySource.transfer_receive || 0).toFixed(2)}`;
  } catch (error) {
    console.error('Error loading earnings summary:', error);
  }
}

/**
 * Load transaction history with filter and pagination
 */
async function loadPlayerTransactions(identityId, filter = 'all', limit = 20, offset = 0) {
  const container = document.getElementById('playerTransactionList');
  if (!container) return;

  if (offset === 0) {
    container.innerHTML = '<div class="dzc-skeleton" style="height:1.25rem;width:220px"></div>';
  }

  try {
    let url = `/api/economy/player/${identityId}/transactions?serverId=${encodeURIComponent(currentEconomyServerId)}&limit=${limit}&offset=${offset}`;
    if (filter === 'earn') url += '&type=earn';
    else if (filter === 'spend') url += '&type=spend';
    else if (filter === 'transfer') url += '&type=transfer';
    else if (filter === 'bank') url += '&accountType=bank';

    const response = await fetch(url);
    const data = await response.json();

    const loadMoreBtn = document.getElementById('loadMoreTransactions');

    if (!data.success || data.transactions.length === 0) {
      if (offset === 0) {
        container.innerHTML = '<div class="dzc-empty"><div class="dzc-empty-title">No transactions found.</div></div>';
      }
      if (loadMoreBtn) loadMoreBtn.classList.add('hidden');
      return;
    }

    const symbol = currentEconomyData?.currency?.symbol || '$';
    const html = data.transactions.map(tx => {
      const isPositive = tx.amount >= 0;
      const amountColor = isPositive ? 'text-green-400' : 'text-red-400';
      const amountStr = `${isPositive ? '+' : '-'}${symbol}${Math.abs(tx.amount).toFixed(2)}`;
      const timeStr = tx.timestamp ? new Date(tx.timestamp).toLocaleString() : '-';
      const typeClass = tx.transactionType === 'earn' ? 'transaction-earned'
        : tx.transactionType === 'spend' ? 'transaction-spent'
        : tx.transactionType === 'transfer' ? 'transaction-transfer'
        : 'transaction-bank';
      const sourceLabel = tx.source ? ` · ${tx.source}` : '';

      return `
        <div class="transaction-card ${typeClass}">
          <div>
            <p class="font-semibold text-sm capitalize">${tx.transactionType}${sourceLabel}</p>
            <p class="text-xs text-gray-400">${tx.description || ''} ${timeStr}</p>
          </div>
          <div class="text-right">
            <p class="font-bold ${amountColor}">${amountStr}</p>
            <p class="text-xs text-gray-400">${symbol}${(tx.balanceAfter || 0).toFixed(2)}</p>
          </div>
        </div>`;
    }).join('');

    if (offset === 0) {
      container.innerHTML = html;
    } else {
      container.insertAdjacentHTML('beforeend', html);
    }

    if (loadMoreBtn) {
      if (data.pagination?.hasMore) {
        loadMoreBtn.classList.remove('hidden');
        transactionOffset = offset + limit;
      } else {
        loadMoreBtn.classList.add('hidden');
      }
    }
  } catch (error) {
    console.error('Error loading transactions:', error);
    if (offset === 0) {
      container.innerHTML = '<p class="text-red-400 text-sm text-center py-4">Failed to load transactions.</p>';
    }
  }
}

/**
 * Filter transactions by type
 */
function filterTransactions(filterType) {
  currentTransactionFilter = filterType;
  transactionOffset = 0;

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-filter') === filterType);
  });

  if (currentIdentityId) {
    loadPlayerTransactions(currentIdentityId, filterType, TRANSACTION_PAGE_SIZE, 0);
  }
}

/**
 * Export transactions to CSV
 */
async function exportPlayerTransactions(identityId) {
  try {
    const response = await fetch(`/api/economy/player/${identityId}/transactions?serverId=${encodeURIComponent(currentEconomyServerId)}&limit=1000&offset=0`);
    const data = await response.json();

    if (!data.success || data.transactions.length === 0) {
      alert('No transactions to export.');
      return;
    }

    function csvField(value) {
      const str = String(value ?? '');
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }

    const headers = ['Date', 'Type', 'Source', 'Account', 'Amount', 'Balance After', 'Description'];
    const rows = data.transactions.map(tx => [
      tx.timestamp ? new Date(tx.timestamp).toLocaleString() : '',
      tx.transactionType || '',
      tx.source || '',
      tx.accountType || '',
      tx.amount?.toFixed(2) || '0.00',
      (tx.balanceAfter || 0).toFixed(2),
      tx.description || ''
    ]);

    const csvContent = [headers, ...rows].map(r => r.map(csvField).join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transactions-${identityId}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Error exporting transactions:', error);
    alert('Failed to export transactions.');
  }
}

/**
 * Load leaderboard rank and top 10 preview
 */
async function loadLeaderboardPreview(identityId) {
  try {
    const response = await fetch(`/api/economy/player/${identityId}/rank?serverId=${encodeURIComponent(currentEconomyServerId)}`);
    const data = await response.json();
    if (!data.success) return;

    const rankEl = document.getElementById('leaderboardRank');
    if (rankEl) rankEl.textContent = `#${data.rank}`;

    const container = document.getElementById('leaderboardPreview');
    if (!container) return;

    const symbol = currentEconomyData?.currency?.symbol || '$';

    if (!data.top10 || data.top10.length === 0) {
      container.innerHTML = '<div class="dzc-empty"><div class="dzc-empty-title">No leaderboard data available.</div></div>';
      return;
    }

    const html = data.top10.map(player => {
      const isCurrentPlayer = player.identityId === parseInt(identityId, 10);
      const medal = player.rank === 1 ? '🥇' : player.rank === 2 ? '🥈' : player.rank === 3 ? '🥉' : `#${player.rank}`;
      const highlight = isCurrentPlayer ? 'bg-yellow-900 border border-yellow-600' : 'bg-gray-700';
      const nameClass = isCurrentPlayer ? 'font-semibold text-yellow-300' : 'font-semibold';
      const nameSuffix = isCurrentPlayer ? ' (You)' : '';
      return `
        <div class="p-3 rounded flex justify-between items-center ${highlight}">
          <div class="flex items-center gap-3">
            <span class="text-lg font-bold w-10">${medal}</span>
            <span class="${nameClass}">${player.gamertag}${nameSuffix}</span>
          </div>
          <span class="font-bold text-green-400">${symbol}${(player.totalWealth || 0).toFixed(2)}</span>
        </div>`;
    }).join('');

    container.innerHTML = html;
  } catch (error) {
    console.error('Error loading leaderboard preview:', error);
    const container = document.getElementById('leaderboardPreview');
    if (container) container.innerHTML = '<p class="text-red-400 text-sm text-center py-4">Failed to load leaderboard.</p>';
  }
}

/**
 * Refresh all economy dashboard data
 */
async function refreshPlayerEconomy(identityId) {
  await loadPlayerEconomyDashboard(identityId);
}

/**
 * Setup economy tab action buttons
 */
function setupEconomyTabButtons() {
  const playerDepositBtn = document.getElementById('playerDepositBtn');
  const playerWithdrawBtn = document.getElementById('playerWithdrawBtn');
  const playerTransferBtn = document.getElementById('playerTransferBtn');
  const depositModal = document.getElementById('depositModal');
  const withdrawModal = document.getElementById('withdrawModal');
  const transferModal = document.getElementById('transferModal');

  if (playerDepositBtn) {
    playerDepositBtn.addEventListener('click', function() {
      if (this.disabled) return;
      const symbol = currentEconomyData?.currency?.symbol || '$';
      const walletBalance = currentEconomyData?.wallet?.cashOnHand ?? 0;
      document.getElementById('depositWalletBalance').textContent = `${symbol}${walletBalance.toFixed(2)}`;
      document.getElementById('depositAmount').value = '';
      document.getElementById('depositFeeInfo').classList.add('hidden');
      depositModal.classList.remove('hidden');
    });
  }

  if (playerWithdrawBtn) {
    playerWithdrawBtn.addEventListener('click', function() {
      if (this.disabled) return;
      const symbol = currentEconomyData?.currency?.symbol || '$';
      const bankBalance = currentEconomyData?.bank?.balance ?? 0;
      document.getElementById('withdrawBankBalance').textContent = `${symbol}${bankBalance.toFixed(2)}`;
      document.getElementById('withdrawAmount').value = '';
      document.getElementById('withdrawFeeInfo').classList.add('hidden');
      withdrawModal.classList.remove('hidden');
    });
  }

  if (playerTransferBtn) {
    playerTransferBtn.addEventListener('click', function() {
      if (this.disabled) return;
      if (!currentEconomyData?.guildConfig?.transferEnabled) {
        alert('Transfers are not enabled for this community.');
        return;
      }
      selectedTransferRecipient = null;
      document.getElementById('recipientSearch').value = '';
      document.getElementById('recipientResults').classList.add('hidden');
      document.getElementById('recipientResults').innerHTML = '';
      document.getElementById('selectedRecipient').classList.add('hidden');
      document.getElementById('transferAmount').value = '';
      document.getElementById('transferMessage').value = '';
      document.getElementById('transferFeeInfo').classList.add('hidden');
      document.getElementById('confirmTransfer').disabled = true;

      const symbol = currentEconomyData?.currency?.symbol || '$';
      const walletBalance = currentEconomyData?.wallet?.cashOnHand ?? 0;
      document.getElementById('transferAvailable').textContent = `${symbol}${walletBalance.toFixed(2)}`;

      const config = currentEconomyData?.guildConfig;
      const limitsEl = document.getElementById('transferLimits');
      if (limitsEl && config) {
        const parts = [];
        if (config.transferMinAmount) parts.push(`Min: ${symbol}${config.transferMinAmount}`);
        if (config.transferMaxAmount) parts.push(`Max: ${symbol}${config.transferMaxAmount}`);
        limitsEl.textContent = parts.join('  ');
      }

      transferModal.classList.remove('hidden');
    });
  }

  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      filterTransactions(this.getAttribute('data-filter'));
    });
  });

  // Load more button
  const loadMoreBtn = document.getElementById('loadMoreTransactions');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', function() {
      if (currentIdentityId) {
        loadPlayerTransactions(currentIdentityId, currentTransactionFilter, TRANSACTION_PAGE_SIZE, transactionOffset);
      }
    });
  }

  // Export CSV button
  const exportBtn = document.getElementById('exportTransactionsBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', function() {
      if (currentIdentityId) {
        exportPlayerTransactions(currentIdentityId);
      }
    });
  }
}

let autoRefreshInterval = null;
let displayUpdateInterval = null;
let lastUpdateTime = Date.now();
let isRefreshing = false;

function updateLastUpdatedDisplay() {
  const lastUpdatedEl = document.getElementById('lastUpdated');
  if (!lastUpdatedEl) return;

  const secondsAgo = Math.floor((Date.now() - lastUpdateTime) / 1000);

  if (secondsAgo < 5) {
    lastUpdatedEl.textContent = 'Last updated: Just now';
    lastUpdatedEl.className = 'text-success';
  } else if (secondsAgo < 60) {
    lastUpdatedEl.textContent = `Last updated: ${secondsAgo} seconds ago`;
    lastUpdatedEl.className = 'text-gray-400';
  } else if (secondsAgo < 3600) {
    const minutesAgo = Math.floor(secondsAgo / 60);
    lastUpdatedEl.textContent = `Last updated: ${minutesAgo} minute${minutesAgo > 1 ? 's' : ''} ago`;
    lastUpdatedEl.className = 'text-gray-400';
  } else {
    const hoursAgo = Math.floor(secondsAgo / 3600);
    lastUpdatedEl.textContent = `Last updated: ${hoursAgo} hour${hoursAgo > 1 ? 's' : ''} ago`;
    lastUpdatedEl.className = 'text-warning';
  }
}

async function refreshAllData() {
  if (isRefreshing) {
    console.log('⏳ Refresh already in progress, skipping...');
    return;
  }

  const identityId = currentIdentityId;
  if (!identityId) {
    console.warn('⚠️ No identity selected, skipping refresh');
    return;
  }

  isRefreshing = true;
  const refreshBtn = document.getElementById('refreshBtn');
  const refreshIcon = document.getElementById('refreshIcon');

  if (refreshBtn) refreshBtn.disabled = true;
  if (refreshIcon) {
    refreshIcon.classList.add('spinning');
  }

  console.log('🔄 Refreshing all player data...');

  try {
    const promises = [
      loadSessionStats(identityId),
      loadSessionHistory(identityId),
      loadCharacterHealth(identityId),
      loadDamageEvents(identityId),
      loadTopThreats(identityId),
      loadWeaponCategories(identityId),
      loadWeaponBreakdown(identityId),
      loadBodyPartStats(identityId),
      loadTerritoryStats(identityId),
      loadTerritoryEvents(identityId),
      loadFavoriteWeapons(identityId),
      loadRecentKills(identityId),
      loadRecentDeaths(identityId),
      loadPlaytimeBreakdown(identityId),
      loadAchievements(identityId),
      loadPerformanceTimeline(identityId)
    ];

    await Promise.all(promises);

    lastUpdateTime = Date.now();
    updateLastUpdatedDisplay();

    console.log('✅ Refresh complete!');
  } catch (error) {
    console.error('❌ Error refreshing data:', error);
  } finally {
    isRefreshing = false;
    if (refreshBtn) refreshBtn.disabled = false;
    if (refreshIcon) {
      refreshIcon.classList.remove('spinning');
    }
  }
}

function startAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
  }

  console.log('✅ Auto-refresh enabled (30s interval)');

  autoRefreshInterval = setInterval(() => {
    const autoRefreshEnabled = document.getElementById('autoRefreshToggle')?.checked;

    if (autoRefreshEnabled && document.visibilityState === 'visible') {
      console.log('⏰ Auto-refresh triggered');
      refreshAllData();
    } else if (document.visibilityState === 'hidden') {
      console.log('⏸️ Auto-refresh paused (tab hidden)');
    }
  }, 30000);

  if (!displayUpdateInterval) {
    displayUpdateInterval = setInterval(updateLastUpdatedDisplay, 1000);
  }
}

function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
    console.log('⏹️ Auto-refresh disabled');
  }
  if (displayUpdateInterval) {
    clearInterval(displayUpdateInterval);
    displayUpdateInterval = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    console.log('👁️ Tab visible - resuming auto-refresh');
    const autoRefreshEnabled = document.getElementById('autoRefreshToggle')?.checked;
    if (autoRefreshEnabled && currentIdentityId) {
      refreshAllData();
    }
  } else {
    console.log('🙈 Tab hidden - pausing auto-refresh');
  }
});

// --- Player Map ---
// Tracks whether the Leaflet map has been initialised yet (init is one-time).
let _playerMapInitialised = false;

/**
 * Opens the standalone player map page in the same tab.
 * Passes the current identity and selected map as URL parameters so the
 * standalone page (player-map.html / player-map-standalone.js) can
 * initialise Leaflet immediately on a fully-rendered container — the same
 * approach used by the server owner map (map.html / map.js).
 */
function openPlayerMap() {
  if (!currentIdentityId) {
    console.warn('No identity selected — cannot open player map');
    return;
  }

  const mapName = 'chernarusplus'; // standalone page default; user can switch there
  let url = '/player-map?identityId=' + encodeURIComponent(currentIdentityId) +
            '&mapName=' + encodeURIComponent(mapName) +
            '&serverId=' + encodeURIComponent(currentServerId);

  // If the player is in a faction, pass faction context so the map can show
  // faction markers and teammate positions (faction layers require both).
  if (window.callerFactionId && window.callerFactionGuildId) {
    url += '&factionId=' + encodeURIComponent(window.callerFactionId) +
           '&guildId=' + encodeURIComponent(window.callerFactionGuildId);
  }

  window.location.href = url;
}

document.addEventListener('DOMContentLoaded', function() {
  // Navigation buttons
  document.getElementById('nav-guilds').addEventListener('click', function() {
    showSection('guilds');
  });
  
  document.getElementById('nav-discovery').addEventListener('click', function() {
    showSection('discovery');
  });
  
  document.getElementById('nav-stats').addEventListener('click', function() {
    showSection('stats');
  });
  
  // Stats sub-sections (card 7/9)
  Object.keys(STAT_SUBSECTIONS).forEach(section => {
    const btn = document.getElementById('nav-' + section);
    if (btn) btn.addEventListener('click', function() {
      showSection(section);
    });
  });
  
  document.getElementById('nav-leaderboard').addEventListener('click', function() {
    showSection('leaderboard');
  });

  document.getElementById('nav-economy').addEventListener('click', function() {
    showSection('economy');
  });

  document.getElementById('nav-casino').addEventListener('click', function() {
    showSection('casino');
  });

  document.getElementById('nav-map').addEventListener('click', function() {
    showSection('map');
  });

  document.getElementById('nav-factions').addEventListener('click', function() {
    showSection('factions');
  });

  document.getElementById('nav-bounties').addEventListener('click', function() {
    showSection('bounties');
  });

  document.getElementById('nav-shop').addEventListener('click', function() {
    window.location.href = '/shop';
  });

  document.getElementById('nav-emotes').addEventListener('click', function() {
    showSection('emotes');
  });

  // Refresh controls
  document.getElementById('refreshBtn').addEventListener('click', () => {
    console.log('🔘 Manual refresh clicked');
    refreshAllData();
  });

  document.getElementById('autoRefreshToggle').addEventListener('change', (e) => {
    if (e.target.checked) {
      console.log('✅ Auto-refresh enabled by user');
      startAutoRefresh();
    } else {
      console.log('❌ Auto-refresh disabled by user');
      stopAutoRefresh();
    }
  });

  startAutoRefresh();

  // Search gamertag button and Enter key
  document.getElementById('searchGamertagBtn').addEventListener('click', searchGamertag);
  
  document.getElementById('searchGamertag').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      searchGamertag();
    }
  });

  // Back to guilds button
  document.getElementById('backToGuildsBtn').addEventListener('click', backToGuilds);

  // Leaderboard sort dropdown
  document.getElementById('sortBy').addEventListener('change', loadLeaderboard);

  // Modal buttons
  document.getElementById('confirmLinkBtn').addEventListener('click', confirmLink);
  document.getElementById('closeLinkModalBtn').addEventListener('click', closeLinkModal);

  // Economy modals
  setupEconomyModals();
  setupTransferModal();
  setupEconomyTabButtons();

  // Event delegation for dynamically generated guild cards
  // (click + keyboard: cards are role="button" tabindex="0").
  function activateGuildCard(guildCard) {
    const guildId = guildCard.getAttribute('data-guild-id');
    const guildName = guildCard.getAttribute('data-guild-name');
    const serverId = guildCard.getAttribute('data-server-id');
    const serverName = guildCard.getAttribute('data-server-name');
    selectGuild(guildId, guildName, serverId, serverName);
  }
  const guildsContainer = document.getElementById('guilds-container');
  guildsContainer.addEventListener('click', function(e) {
    const guildCard = e.target.closest('.guild-card');
    if (guildCard) activateGuildCard(guildCard);
  });
  guildsContainer.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const guildCard = e.target.closest('.guild-card');
    if (guildCard) {
      e.preventDefault();
      activateGuildCard(guildCard);
    }
  });
});
