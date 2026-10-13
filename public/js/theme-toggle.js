'use strict';

/* eslint-env browser */
/*
 * Theme toggle (B1.2, upgraded by card 2/9) — injected into every rendered
 * page by the server.
 *
 * Behavior:
 *   - Small floating button (top-right) that opens a picker for the five
 *     base themes: livonia (default), chernarus, sakhal (light), nasadra,
 *     high-contrast.
 *   - Persists the choice in localStorage ("dayz-theme") so the next page
 *     load applies it before first paint (see the inline no-flash script the
 *     server injects in <head>).
 *   - Also persists to the backend (PUT /api/theme) so the preference travels
 *     with the account across browsers; anonymous users keep a local-only
 *     preference (no auth call, no error).
 *   - When the server injected a holiday/accent override, the picker only
 *     changes the base theme; the accent is untouched.
 *   - Back-compat: a stored B1.2-era value ("dark"/"light") is migrated to
 *     its base theme on first use (dark -> livonia, light -> sakhal).
 *
 * The button uses token-driven inline styles (with hardcoded fallbacks) so
 * it is usable even on pages that do not load theme.css.
 */

(function () {
  var STORAGE_KEY = 'dayz-theme';

  var BASE_THEMES = [
    { value: 'livonia', label: 'Livonia (default)', swatch: '#6f9a3d', bg: '#0c120d' },
    { value: 'chernarus', label: 'Chernarus', swatch: '#9a8439', bg: '#0e0d08' },
    { value: 'sakhal', label: 'Sakhal (light)', swatch: '#3a63d6', bg: '#e8edf3' },
    { value: 'nasadra', label: 'Nasadra', swatch: '#c29a4a', bg: '#14100a' },
    { value: 'high-contrast', label: 'High contrast', swatch: '#46ff90', bg: '#000000' },
  ];

  // B1.2-era localStorage values keep working.
  var LEGACY_MAP = { dark: 'livonia', light: 'sakhal' };

  var currentBtn = null;
  var menuEl = null;

  function currentTheme() {
    var attr = document.documentElement.getAttribute('data-theme');
    if (BASE_THEMES.some(function (t) { return t.value === attr; })) return attr;
    if (attr && LEGACY_MAP[attr]) return LEGACY_MAP[attr];
    return 'livonia';
  }

  function isLight(theme) {
    return theme === 'sakhal';
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      if (theme) {
        localStorage.setItem(STORAGE_KEY, theme);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) {
      /* storage unavailable (private mode) — local flip still works */
    }
  }

  function persistToServer(theme) {
    var meta = document.querySelector('meta[name="csrf-token"]');
    var token = meta ? meta.getAttribute('content') : '';
    if (!token) return;
    fetch('/api/theme', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({ theme: theme }),
    }).catch(function () {
      /* anonymous or expired session — local preference is still active */
    });
  }

  function iconFor(theme) {
    return isLight(theme) ? '☀️' : '🌙';
  }

  function buildButton() {
    var btn = document.createElement('button');
    btn.id = 'dayz-theme-toggle';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Choose theme');
    btn.setAttribute('title', 'Theme');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.style.cssText =
      'position:fixed;top:12px;right:12px;z-index:1000;border:1px solid var(--dzc-border,#37492f);' +
      'background:var(--dzc-surface-2,#172019);color:var(--dzc-text,#eaf2e9);' +
      'border-radius:var(--dzc-radius-md,8px);padding:6px 10px;cursor:pointer;' +
      'font-size:14px;line-height:1;box-shadow:var(--dzc-shadow-md,0 4px 12px rgba(0,0,0,.35))';
    btn.textContent = iconFor(currentTheme());
    return btn;
  }

  function buildMenu() {
    var menu = document.createElement('div');
    menu.id = 'dayz-theme-menu';
    menu.setAttribute('role', 'menu');
    menu.style.cssText =
      'position:fixed;top:46px;right:12px;z-index:1001;display:none;min-width:190px;' +
      'border:1px solid var(--dzc-border,#37492f);background:var(--dzc-surface,#121a13);' +
      'color:var(--dzc-text,#eaf2e9);border-radius:var(--dzc-radius-md,8px);padding:6px;' +
      'box-shadow:var(--dzc-shadow-lg,0 8px 24px rgba(0,0,0,.45));font-size:14px';
    BASE_THEMES.forEach(function (t) {
      var row = document.createElement('button');
      row.type = 'button';
      row.setAttribute('role', 'menuitemradio');
      row.style.cssText =
        'display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;cursor:pointer;' +
        'background:transparent;border:none;border-radius:6px;color:inherit;font-size:inherit;text-align:left';
      row.addEventListener('mouseenter', function () { row.style.background = 'var(--dzc-surface-3,#1f2a1f)'; });
      row.addEventListener('mouseleave', function () { row.style.background = 'transparent'; });

      var swatch = document.createElement('span');
      swatch.style.cssText =
        'width:14px;height:14px;border-radius:4px;flex:none;border:1px solid var(--dzc-border,#37492f);' +
        'background:linear-gradient(135deg,' + t.swatch + ' 0 50%,' + t.bg + ' 50% 100%)';

      var label = document.createElement('span');
      label.textContent = t.label;

      var check = document.createElement('span');
      check.style.cssText = 'margin-left:auto;font-size:12px;color:var(--dzc-accent,#6f9a3d)';
      check.textContent = '';

      row.appendChild(swatch);
      row.appendChild(label);
      row.appendChild(check);

      row.addEventListener('click', function () {
        apply(t.value);
        setButtonIcon(t.value);
        syncMenuChecks(menu);
        closeMenu();
        persistToServer(t.value);
      });

      menu.appendChild(row);
    });
    return menu;
  }

  function setButtonIcon(theme) {
    if (currentBtn) currentBtn.textContent = iconFor(theme);
  }

  function syncMenuChecks(menu) {
    var cur = currentTheme();
    var rows = menu.querySelectorAll('button[role="menuitemradio"]');
    Array.prototype.forEach.call(rows, function (row, i) {
      var active = BASE_THEMES[i].value === cur;
      row.setAttribute('aria-checked', active ? 'true' : 'false');
      row.lastChild.textContent = active ? '✓' : '';
    });
  }

  function openMenu() {
    if (!menuEl) {
      menuEl = buildMenu();
      document.body.appendChild(menuEl);
    }
    syncMenuChecks(menuEl);
    menuEl.style.display = 'block';
    if (currentBtn) currentBtn.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    if (menuEl) menuEl.style.display = 'none';
    if (currentBtn) currentBtn.setAttribute('aria-expanded', 'false');
  }

  function init() {
    if (document.getElementById('dayz-theme-toggle')) return;
    currentBtn = buildButton();
    currentBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (menuEl && menuEl.style.display === 'block') {
        closeMenu();
      } else {
        openMenu();
      }
    });
    document.addEventListener('click', function (e) {
      if (menuEl && menuEl.style.display === 'block' && !menuEl.contains(e.target) && e.target !== currentBtn) {
        closeMenu();
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });
    document.body.appendChild(currentBtn);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
