/* global document, window, fetch */
'use strict';

/*
 * Route-aware app shell — client side (card 3/9).
 *
 * Responsibilities:
 *   1. Mobile off-canvas drawer (<=780px): hamburger toggle, Esc to close,
 *      backdrop click to close, keyboard focus trap, aria-expanded sync.
 *   2. Server-context pill: populate the live fields (status / player count /
 *      last-sync) from data the page is ALREADY authorized to load. The shell
 *      never infers tenant/server authorization — it only displays what a
 *      page's own selector hands it. If nothing is selected, the pill shows
 *      the static guild label only (meta hidden).
 *
 * No dependencies. Safe to load on any page; no-ops when no shell is present.
 */
(function () {
  'use strict';

  var MOBILE_BREAKPOINT = 780;

  /* ── Drawer ─────────────────────────────────────────────────────────── */

  function isMobile() {
    return window.matchMedia ? window.matchMedia('(max-width: ' + MOBILE_BREAKPOINT + 'px)').matches : window.innerWidth <= MOBILE_BREAKPOINT;
  }

  var root = document.querySelector('.dzc-shell');
  var toggle = document.getElementById('dzc-shell-hamburger');
  var sidebar = document.getElementById('dzc-shell-sidebar');
  var backdrop = document.querySelector('[data-shell-backdrop]');

  var lastFocused = null;

  function focusables() {
    if (!sidebar) return [];
    return Array.prototype.filter.call(
      sidebar.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      function (el) {
        return el.offsetParent !== null || getComputedStyle(el).display !== 'none';
      }
    );
  }

  function setDrawer(open) {
    if (!root) return;
    root.classList.toggle('is-open', open);
    if (backdrop) {
      backdrop.hidden = !open;
      backdrop.style.display = open ? 'block' : 'none';
    }
    if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      lastFocused = document.activeElement;
      var items = focusables();
      if (items.length) items[0].focus();
    } else if (lastFocused && typeof lastFocused.focus === 'function') {
      lastFocused.focus();
      lastFocused = null;
    }
  }

  function onKeydown(ev) {
    if (!root || !root.classList.contains('is-open')) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      setDrawer(false);
      return;
    }
    if (ev.key === 'Tab') {
      var items = focusables();
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      var active = document.activeElement;
      if (ev.shiftKey && (active === first || !sidebar.contains(active))) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && (active === last || !sidebar.contains(active))) {
        ev.preventDefault();
        first.focus();
      }
    }
  }

  function initDrawer() {
    if (!root || !toggle || !sidebar) return;
    toggle.addEventListener('click', function () {
      setDrawer(!root.classList.contains('is-open'));
    });
    // Client-driven nav (player-portal tabs are <button>s, not links): closing
    // the drawer on activation is the only way the section underneath is seen.
    sidebar.addEventListener('click', function (ev) {
      var item = ev.target.closest('button.dzc-shell-nav-item');
      if (item && root.classList.contains('is-open')) setDrawer(false);
    });
    if (backdrop) {
      backdrop.addEventListener('click', function () { setDrawer(false); });
    }
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('resize', function () {
      if (!isMobile() && root.classList.contains('is-open')) setDrawer(false);
    });
  }

  /* ── Context pill ───────────────────────────────────────────────────── */

  var pill = document.querySelector('.dzc-context-pill');
  var pollTimer = null;

  function setPillMeta(status, players, lastSync) {
    if (!pill) return;
    pill.setAttribute('data-state', status || 'unknown');
    var meta = pill.querySelector('.dzc-pill-meta');
    var empty = !(status || players || lastSync);
    if (meta) meta.setAttribute('data-empty', empty ? 'true' : 'false');
    var statusEl = pill.querySelector('.dzc-pill-status');
    var playersEl = pill.querySelector('.dzc-pill-players');
    var syncEl = pill.querySelector('.dzc-pill-sync');
    if (statusEl) statusEl.textContent = status ? String(status) : '';
    if (playersEl) playersEl.textContent = players != null ? String(players) : '';
    if (syncEl) syncEl.textContent = lastSync ? String(lastSync) : '';
  }

  function relTime(value) {
    if (!value) return '';
    var ts = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!isFinite(ts)) return '';
    var diff = Math.max(0, Date.now() - ts);
    var min = Math.floor(diff / 60000);
    if (min < 1) return 'now';
    if (min < 60) return min + 'm';
    var h = Math.floor(min / 60);
    if (h < 24) return h + 'h';
    return Math.floor(h / 24) + 'd';
  }

  function applyOverview(data) {
    var s = (data && data.server) || {};
    var status = s.status || 'unknown';
    var players = s.players && s.players.current != null
      ? (s.players.current + '/' + (s.players.maximum != null ? s.players.maximum : '?'))
      : null;
    setPillMeta(status, players, relTime(s.observedAt || (data && data.generatedAt)));
  }

  /**
   * Poll /api/stats/<serverId>/overview (the canonical per-server live snapshot,
   * authorized by the page's own selector) and reflect it in the pill. The shell
   * never authorizes here — it only displays what the page selected. A modest
   * 60s interval keeps the "last-sync" honest without hammering the provider.
   */
  window.dzcShellPollServer = function (serverId, serverName) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (!pill || pill.getAttribute('data-pill-kind') !== 'server' || !serverId) return;
    if (serverName) {
      var label = pill.querySelector('.dzc-pill-guild');
      if (label) label.textContent = String(serverName);
    }
    var url = '/api/stats/' + encodeURIComponent(String(serverId)) + '/overview';
    var poll = function () {
      return fetch(url, { credentials: 'same-origin' }).then(function (res) {
        if (!res.ok) throw new Error('status ' + res.status);
        return res.json();
      }).then(applyOverview).catch(function (err) {
        console.warn('[app-shell] live pill poll failed:', err.message);
        setPillMeta('offline', null, '');
      });
    };
    poll();
    pollTimer = setInterval(poll, 60000);
  };

  /** Stop any running poll (e.g. server deselected). */
  window.dzcShellPollServerStop = function () {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    setPillMeta(null, null, null);
  };

  /** Static "no live data" display — used when a page has no server poller. */
  window.dzcShellPillStatic = function (status) {
    setPillMeta(status || null, null, null);
  };

  /* ── Boot ───────────────────────────────────────────────────────────── */

  function boot() {
    initDrawer();
    if (pill) {
      // Server-scoped pages call window.dzcShellPollServer(id, name) from their
      // own (already authorized) selector handlers. Guild/player pills show a
      // static label only.
      if (pill.getAttribute('data-pill-kind') === 'guild' ||
          pill.getAttribute('data-pill-kind') === 'player') {
        window.dzcShellPillStatic(null);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
