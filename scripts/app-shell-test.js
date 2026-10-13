#!/usr/bin/env node
'use strict';

/*
 * App shell unit test (card 3/9 — route-aware app shell).
 *
 * Verifies the server-side composition (utils/appShell.js) without a server:
 *   1. renderShellPage composes sidebar + topbar + content around a page body
 *      and sends it through the same chrome path as renderWithCsrf (theme
 *      attr, no-flash script, override CSS, CSRF meta).
 *   2. Nav is role-filtered per surface (owner / admin / player) — separate
 *      nav sets, one shared component. Active state + dimmed Tools entry.
 *   3. Context pill: guild/server/player variants, escaping of display-only
 *      values passed by the route.
 *   4. Page pins: the 5 migrated pages carry no copied inline nav block, and
 *      all 5 routes are wired through renderShellPage.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const {
  renderShellPage,
  OWNER_NAV,
  ADMIN_NAV,
  PLAYER_NAV,
  _internal,
} = require(path.join(root, 'utils/appShell.js'));

const pageFixture = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="/css/theme.css">
  <link rel="stylesheet" href="/css/tailwind.css">
</head>
<body class="bg-gray-900 text-white">
  <div class="container mx-auto p-6">
    <h1>Fixture Page</h1>
  </div>
</body>
</html>`;

function makeReq() {
  return {
    path: '/dashboard',
    theme: { overrideCss: ':root:root { --dzc-accent: #ff00ff; }' },
    csrfToken: () => 'tok&<en>"a\'b',
  };
}

function makeRes() {
  const out = { status: null, body: null };
  return {
    res: { status(code) { out.status = code; return this; }, send(body) { out.body = body; return this; } },
    out,
  };
}

async function render(opts, filePath) {
  const { res, out } = makeRes();
  await renderShellPage(filePath, makeReq(), res, opts);
  return out.body;
}

function tmpPage() {
  const file = path.join(os.tmpdir(), `app-shell-fixture-${Date.now()}.html`);
  fs.writeFileSync(file, pageFixture);
  fs.chmodSync(file, 0o755);
  return file;
}

async function testComposition() {
  const file = tmpPage();
  const html = await render({ surface: 'owner', activePath: '/dashboard', crumbs: [{ label: 'DayZ Ops', href: '/dashboard' }, { label: 'Dashboard', href: '/dashboard' }] }, file);
  assert.ok(html.includes('class="dzc-shell"'), 'shell wrapper missing');
  assert.ok(html.includes('id="dzc-shell-sidebar"'), 'sidebar missing');
  assert.ok(html.includes('class="dzc-shell-topbar"'), 'topbar missing');
  assert.ok(html.includes('<main class="dzc-shell-content">'), 'main landmark (content wrapper) missing');
  assert.ok(html.includes('Fixture Page'), 'original page body lost');
  assert.ok(html.includes('href="/css/shell.css"'), 'shell.css not injected');
  assert.ok(html.search('/css/theme.css') < html.search('/css/shell.css'), 'shell.css must load after theme.css');
  assert.ok(html.includes('<script src="/js/app-shell.js" defer></script>'), 'app-shell.js not loaded');
  assert.ok(html.includes('data-shell-backdrop'), 'mobile backdrop missing');
  assert.ok(/<html[^>]*data-theme=/.test(html), 'theme attribute not injected');
  assert.ok(html.includes('<meta name="csrf-token" content="tok&amp;&lt;en&gt;&quot;a&#39;b"'), 'CSRF meta not injected (or not escaped)');
  assert.ok(html.includes('--dzc-accent: #ff00ff'), 'override CSS not injected');
  assert.ok(/<\/main>\n  <\/div>\n  <\/div>\n  <div class="dzc-shell-backdrop"/.test(html), 'shell not closed in order');
  fs.unlinkSync(file);
}

function testNavSets() {
  // Owner surface: grouped nav + dimmed Tools at the bottom of System
  const owner = OWNER_NAV.map(g => g.title);
  assert.deepStrictEqual(owner, ['Overview', 'Server', 'People', 'World', 'System']);
  const systemItems = OWNER_NAV.find(g => g.title === 'System').items;
  const tools = systemItems[systemItems.length - 1];
  assert.strictEqual(tools.label, 'Tools (Coming Soon)');
  assert.ok(tools.dimmed, 'Tools entry must be dimmed');
  assert.strictEqual(systemItems.filter(i => i.dimmed).length, 1);

  // Admin surface: platform nav, no owner-only entries
  const adminLabels = ADMIN_NAV.flatMap(g => g.items.map(i => i.label));
  for (const only of ['Loot Finder', 'Console', 'Players', 'Rotation', 'Backups']) {
    assert.ok(!adminLabels.includes(only), `admin nav leaks owner item ${only}`);
  }
  for (const want of ['Guilds', 'Users', 'Audit', 'Theme']) {
    assert.ok(adminLabels.includes(want), `admin nav missing ${want}`);
  }
  assert.ok(ADMIN_NAV.find(g => g.title === 'System').items[0].dimmed, 'admin System must carry dimmed Tools');

  // Player surface: client-driven tab buttons with the ids player-portal.js binds
  const player = PLAYER_NAV.flatMap(g => g.items);
  const ids = player.filter(i => i.btnId).map(i => i.btnId);
  assert.deepStrictEqual(ids, [
    'nav-guilds', 'nav-discovery', 'nav-leaderboard',
    'nav-stats', 'nav-sessions', 'nav-health', 'nav-damage', 'nav-weapons',
    'nav-territory', 'nav-kills', 'nav-deaths', 'nav-achievements', 'nav-performance',
    'nav-economy', 'nav-shop', 'nav-map', 'nav-emotes', 'nav-casino', 'nav-factions', 'nav-bounties',
  ]);
  assert.ok(player.some(i => !i.btnId && i.href === '/player'), 'player nav must keep the /player root link');
  // player surface has its own brand treatment (distinct from owner/admin)
  const playerBrand = _internal.sidebarHtml('player', PLAYER_NAV, '/player');
  assert.ok(playerBrand.includes('dzc-shell-brand--player') && playerBrand.includes('Player Portal'),
    'player sidebar must carry the player brand variant');
  const ownerBrand = _internal.sidebarHtml('owner', OWNER_NAV, '/dashboard');
  assert.ok(!ownerBrand.includes('dzc-shell-brand--player'), 'owner sidebar must keep the ops brand');
  // nav sets are separate — no surface reuses another's items
  assert.ok(!player.some(i => i.href && i.href.startsWith('/dashboard')), 'player nav leaks owner hrefs');
}

function testActiveState() {
  const item = _internal.navItemHtml({ label: 'Players', href: '/server-players', icon: 'players' }, '/server-players');
  assert.ok(item.includes('is-active') && item.includes('aria-current="page"'), 'exact match must be active');
  const child = _internal.navItemHtml({ label: 'Dashboard', href: '/dashboard', icon: 'overview' }, '/dashboard/settings');
  assert.ok(child.includes('is-active'), 'prefix path must mark parent active');
  const off = _internal.navItemHtml({ label: 'Map', href: '/map', icon: 'map' }, '/dashboard');
  assert.ok(!off.includes('is-active') && !off.includes('aria-current'), 'non-matching item must not be active');
  const dimmed = _internal.navItemHtml({ label: 'Tools (Coming Soon)', dimmed: true, icon: 'tools' }, '/tools');
  assert.ok(dimmed.includes('<span class="dzc-shell-nav-item'), 'dimmed entry renders as a span, not a link');
  assert.ok(dimmed.includes('aria-disabled="true"'));
}

function testContextPill() {
  const guild = _internal.contextPillHtml({ kind: 'guild', guildName: 'Salt&Pepper <b>' });
  assert.ok(guild.includes('data-pill-kind="guild"'));
  assert.ok(guild.includes('Salt&amp;Pepper &lt;b&gt;'), 'guild name must be escaped');
  assert.ok(guild.includes('data-state="unknown"'));
  const server = _internal.contextPillHtml({ kind: 'server', guildName: 'G', serverName: 'Srv 1' });
  assert.ok(server.includes('data-pill-kind="server"') && server.includes('data-server-name="Srv 1"'));
  const player = _internal.contextPillHtml({ kind: 'player' });
  assert.ok(player.includes('data-pill-kind="player"') && player.includes('>Player<'));
}

function testPagePins() {
  // Card 8/9 sweep: every shell page must carry no copied inline nav block
  // (inline <nav>, the B1.3 dzc-nav-slot + shared-nav.js, or the playerNav
  // block) and its route must render through renderShellPage.
  const pages = {
    'public/dashboard.html': "pub('dashboard.html')",
    'public/server-players.html': "pub('server-players.html')",
    'public/map.html': "pub('map.html')",
    'public/player-portal.html': "pub('player-portal.html')",
    'public/dashboard/settings.html': "pub('dashboard', 'settings.html')",
    'public/dashboard/feeds.html': "pub('dashboard', 'feeds.html')",
    'public/dashboard/economy.html': "pub('dashboard', 'economy.html')",
    'public/dashboard/economy-leaderboard.html': "pub('dashboard', 'economy-leaderboard.html')",
    'public/dashboard/economy-transactions.html': "pub('dashboard', 'economy-transactions.html')",
    'public/dashboard/economy-settings.html': "pub('dashboard', 'economy-settings.html')",
    'public/dashboard/automation.html': "pub('dashboard', 'automation.html')",
    'public/dashboard/tasks.html': "pub('dashboard', 'tasks.html')",
    'public/dashboard/server-control.html': "pub('dashboard', 'server-control.html')",
    'public/dashboard/spawn-exclusions.html': "pub('dashboard', 'spawn-exclusions.html')",
    'public/dashboard/backups.html': "pub('dashboard', 'backups.html')",
    'public/dashboard/rotation.html': "pub('dashboard', 'rotation.html')",
    'public/dashboard/ai-assistant.html': "pub('dashboard', 'ai-assistant.html')",
    'public/dashboard/server-stats.html': "pub('dashboard', 'server-stats.html')",
    'public/dashboard/activity-log.html': "pub('dashboard', 'activity-log.html')",
    'public/dashboard/console.html': "pub('dashboard', 'console.html')",
    'public/dashboard/boost.html': "pub('dashboard', 'boost.html')",
    'public/dashboard/support.html': "pub('dashboard', 'support.html')",
    'public/dashboard/shop-admin.html': "pub('dashboard', 'shop-admin.html')",
    'public/dashboard/casino.html': "pub('dashboard', 'casino.html')",
    'public/mission-editor.html': "pub('mission-editor.html')",
    'public/logs.html': "pub('logs.html')",
    'public/server-lists.html': "pub('server-lists.html')",
    'public/admin/index.html': "pub('admin', 'index.html')",
    'public/admin/guilds.html': "pub('admin', 'guilds.html')",
    'public/admin/theme.html': "pub('admin', 'theme.html')",
    'public/admin/guilds-approval.html': "pub('admin', 'guilds-approval.html')",
    'public/admin/servers.html': "pub('admin', 'servers.html')",
    'public/admin/users.html': "pub('admin', 'users.html')",
    'public/admin/audit.html': "pub('admin', 'audit.html')",
    'public/admin/database.html': "pub('admin', 'database.html')",
    'public/admin/reports.html': "pub('admin', 'reports.html')",
    'public/admin/supply-monitor.html': "pub('admin', 'supply-monitor.html')",
    'public/admin/economy-analytics.html': "pub('admin', 'economy-analytics.html')",
  };
  for (const [rel, form] of Object.entries(pages)) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.ok(!src.includes('<nav'), `${rel} still carries an inline <nav> block`);
    assert.ok(!src.includes('id="playerNav"'), `${rel} still carries the playerNav block`);
    assert.ok(!src.includes('dzc-nav-slot'), `${rel} still carries the B1.3 nav slot`);
    assert.ok(!src.includes('/js/shared-nav.js'), `${rel} still loads shared-nav.js`);
  }
  const routes = fs.readFileSync(path.join(root, 'src/app/registerRoutes.js'), 'utf8');
  for (const [page, form] of Object.entries(pages)) {
    assert.ok(
      routes.includes(`renderShellPage(${form}`),
      `route must render ${page} through renderShellPage`
    );
  }
  // renderWithCsrf keeps working for non-migrated pages
  const rwc = fs.readFileSync(path.join(root, 'utils/renderWithCsrf.js'), 'utf8');
  assert.ok(rwc.includes('applyPageChromes') && rwc.includes('res.send(applyPageChromes'), 'renderWithCsrf must reuse the shared chrome path');
}

async function testAll() {
  await testComposition();
  testNavSets();
  testActiveState();
  testContextPill();
  testPagePins();
  console.log('✅ app-shell unit tests passed');
}

testAll().catch(err => { console.error('❌ app-shell unit test failed:', err.message); process.exit(1); });
