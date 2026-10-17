// Splash fleet metrics — renders aggregate live stats from
// GET /api/public/fleet-stats. Public page: no auth, no uploads, no
// external calls other than the same-origin API.
(function () {
  'use strict';

  function el(id) {
    return document.getElementById(id);
  }

  function fmt(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return n.toLocaleString();
  }

  function set(id, text) {
    const node = el(id);
    if (node) node.textContent = text;
  }

  function renderUnreachable() {
    ['fleetPlayers', 'fleetServers', 'fleetGuilds', 'fleetGithub'].forEach(id => set(id, '—'));
    set('fleetStatsNote', 'Fleet stats are temporarily unavailable.');
  }

  function ageNote(fetchedAt, stale) {
    if (!fetchedAt) return '';
    const ageMs = Date.now() - new Date(fetchedAt).getTime();
    if (!isFinite(ageMs) || ageMs < 0) return '';
    if (stale) {
      return 'using cached GitHub metrics (live update unavailable)';
    }
    const hours = Math.floor(ageMs / 3600000);
    if (hours >= 1) return `GitHub metrics cached ${hours}h ago`;
    return 'GitHub metrics updated just now';
  }

  function render(payload) {
    const fleet = (payload && payload.fleet) || {};
    const gh = (payload && payload.github) || {};
    const players = fleet.players || {};
    const servers = fleet.servers || {};
    const guilds = fleet.guilds || {};

    set('fleetPlayers', fmt(players.total));
    set('fleetPlayersSub', players.registered > 0
      ? `${fmt(players.registered)} registered`
      : 'registered & unregistered');

    set('fleetServers', fmt(servers.total));
    set('fleetServersSub', typeof servers.active === 'number'
      ? `${fmt(servers.active)} active`
      : 'managed');

    set('fleetGuilds', fmt(guilds.active));
    set('fleetGuildsSub', 'active');

    if (gh.unavailable) {
      set('fleetGithub', '—');
      set('fleetGithubSub', `${gh.repo || 'GitHub'} · metrics unavailable`);
      set('fleetStatsNote', 'Fleet stats updated just now · GitHub metrics temporarily unavailable.');
    } else {
      set('fleetGithub', `★ ${fmt(gh.stars)}`);
      set('fleetGithubSub', `${fmt(gh.forks)} fork${gh.forks === 1 ? '' : 's'} · ${fmt(gh.openIssues)} open issues`);
      let note = '';
      if (typeof gh.commitsLast30d === 'number') {
        note = `${gh.commitsLast30d} commit${gh.commitsLast30d === 1 ? '' : 's'} in 30 days · `;
      }
      set('fleetStatsNote', note + ageNote(gh.fetchedAt, gh.stale));
    }
  }

  function init() {
    if (!el('fleetStats')) return;
    fetch('/api/public/fleet-stats', { credentials: 'same-origin' })
      .then(response => {
        if (!response.ok) throw new Error('http ' + response.status);
        return response.json();
      })
      .then(payload => {
        if (payload && payload.success === false) throw new Error('unavailable');
        render(payload);
      })
      .catch(() => renderUnreachable());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
