'use strict';

/* global document, window */

/* eslint-env browser */
/*
 * B1.3 shared dashboard nav.
 *
 * Pages place a single <div class="dzc-nav-slot"></div> (usually right after
 * the <h1> header). This script replaces it with a consistent nav bar built
 * from the same token styles used everywhere else (.dzc-nav in theme.css),
 * and marks the link matching the current path as .active.
 *
 * It is intentionally self-contained: no fetch, no config dependency, so it
 * works on any page that includes it. Pages that do NOT include the slot are
 * left untouched — this never modifies existing markup.
 */

(function () {
  var ITEMS = [
    { label: 'Dashboard', href: '/dashboard' },
    { label: 'Servers', href: '/server-lists' },
    { label: 'Server Stats', href: '/dashboard/server-stats' },
    { label: 'Tasks', href: '/dashboard/tasks' },
    { label: 'Economy', href: '/dashboard/economy' },
    { label: 'Shop', href: '/dashboard/shop-admin' },
    { label: 'Rotation', href: '/dashboard/rotation' },
    { label: 'Automation', href: '/dashboard/automation' },
    { label: 'Console', href: '/dashboard/console' },
    { label: 'Logs', href: '/logs' },
    { label: 'Maps', href: '/map' },
  ];

  function currentPath() {
    return window.location.pathname;
  }

  function isActive(item) {
    var p = currentPath();
    // Exact match, or the item is a prefix of the current path (sub-routes).
    return p === item.href || p.indexOf(item.href + '/') === 0;
  }

  function render() {
    var slot = document.querySelector('.dzc-nav-slot');
    if (!slot) return;
    var nav = document.createElement('nav');
    nav.className = 'dzc-nav';
    nav.setAttribute('aria-label', 'Dashboard navigation');
    ITEMS.forEach(function (item) {
      var a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.label;
      if (isActive(item)) a.classList.add('active');
      nav.appendChild(a);
    });
    slot.parentNode.replaceChild(nav, slot);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
})();
