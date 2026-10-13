/**
 * Route-aware app shell (card 3/9)
 * ----------------------------------------------------------------------------
 * Server-composes a sidebar + topbar around an existing authenticated page
 * body and sends it through the SAME CSRF + theme injection path used by
 * renderWithCsrf (utils/renderWithCsrf.js -> applyPageChromes). No framework.
 *
 * Design rules honored:
 *   - NO tenant/server context is inferred for AUTHORIZATION here. Each route
 *     keeps its own reauthorization middleware exactly as-is. The shell only
 *     DISPLAYS a guild label (a cheap, cached, display-only lookup that
 *     mirrors themeInjection's primary-guild pattern) and a server pill whose
 *     live fields are populated client-side from data the page is already
 *     authorized to load.
 *   - Nav is role-filtered: owner/operator, platform-admin, and player portal
 *     get SEPARATE nav sets (not merged), rendered by one shared component.
 *   - All colors come from --dzc-* theme tokens (see public/css/shell.css),
 *     so the shell is correct under all 5 base themes + the holiday layer.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const { applyPageChromes } = require('./renderWithCsrf');

const htmlCache = new Map();
const isDevelopment = process.env.NODE_ENV !== 'production';

/* ---------------------------------------------------------------------------
 * 16x16 stroke icons (currentColor). Inline per-item; no dependency.
 * ------------------------------------------------------------------------- */
const ICONS = {
  overview: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>',
  control: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="2" y1="5" x2="14" y2="5"/><line x1="2" y1="11" x2="14" y2="11"/><circle cx="6" cy="5" r="1.6"/><circle cx="10" cy="11" r="1.6"/></svg>',
  stats: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="2" y1="13" x2="14" y2="13"/><rect x="3" y="7" width="3" height="6"/><rect x="7" y="4" width="3" height="9"/><rect x="11" y="9" width="3" height="4"/></svg>',
  automation: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2M4 4l1.5 1.5M10.5 10.5 12 12M12 4l-1.5 1.5M4 12l1.5-1.5"/></svg>',
  rotation: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 5a5 5 0 0 0-9-1"/><path d="M3 11a5 5 0 0 0 9 1"/><path d="M4 2v3h3M12 14v-3h-3"/></svg>',
  backups: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="8" cy="3" rx="5" ry="2"/><path d="M3 3v10c0 1.1 2.2 2 5 2s5-.9 5-2V3"/><path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/></svg>',
  console: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 7l2 2-2 2M8 11h3"/></svg>',
  activity: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8h3l2-5 3 10 2-5h2"/></svg>',
  boost: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2 4 9h3l-1 5 4-7H7z"/></svg>',
  support: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M6 6.5a2 2 0 1 1 2.5 2c-.6.2-1 .6-1 1.2"/><circle cx="7.5" cy="11" r=".6" fill="currentColor" stroke="none"/></svg>',
  players: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5.5" r="2.5"/><path d="M2 13c0-2 1.8-3.5 4-3.5s4 1.5 4 3.5"/><circle cx="12" cy="5.5" r="2"/><path d="M11 13c0-1.6 1-2.7 2.5-2.7"/></svg>',
  lists: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="4" x2="14" y2="4"/><line x1="5" y1="8" x2="14" y2="8"/><line x1="5" y1="12" x2="14" y2="12"/><circle cx="2.5" cy="4" r=".7" fill="currentColor" stroke="none"/><circle cx="2.5" cy="8" r=".7" fill="currentColor" stroke="none"/><circle cx="2.5" cy="12" r=".7" fill="currentColor" stroke="none"/></svg>',
  roles: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2l5 2v3c0 3.2-2.1 5.7-5 7-2.9-1.3-5-3.8-5-7V4z"/><path d="M6 8l1.5 1.5L10 6"/></svg>',
  map: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4l4-1.5L10 4l4-1.5v9L10 13l-4 1.5L2 13z"/><line x1="6" y1="2.5" x2="6" y2="14.5"/><line x1="10" y1="4" x2="10" y2="13"/></svg>',
  loot: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/></svg>',
  shield: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2l5 2v3c0 3.2-2.1 5.7-5 7-2.9-1.3-5-3.8-5-7V4z"/></svg>',
  economy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M6.5 5.5c0-1 3-1 3 0s-3 1.2-3 2.5 3 1.5 3 2.5"/><line x1="8" y1="4.5" x2="8" y2="11.5"/></svg>',
  shop: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h10l-1 8H4z"/><path d="M6 5V4a2 2 0 0 1 4 0v1"/></svg>',
  tasks: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.5 8l2 2 3.5-3.5"/></svg>',
  feeds: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="round" aria-hidden="true"><circle cx="3" cy="12" r="1.3"/><path d="M2.5 7.5a6 6 0 0 1 6 6M2.5 3.5a10 10 0 0 1 10 10"/></svg>',
  ai: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="10" height="8" rx="2"/><circle cx="6.5" cy="8" r=".8" fill="currentColor" stroke="none"/><circle cx="9.5" cy="8" r=".8" fill="currentColor" stroke="none"/><path d="M8 2v2M6 12v2M10 12v2"/></svg>',
  settings: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8 3.4 3.4"/></svg>',
  tools: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 2.5a2.5 2.5 0 0 0 2.5 2.5L12 5l-5 5 1.5 1.5L13 6.5 11 4.5a2.5 2.5 0 0 0 2.5-2.5z"/><path d="M4 8l3 3-2 2-3-3z"/></svg>',
  guilds: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 13V7l3-3 3 3 3-3 3 3v6z"/><path d="M6 13V9h4v4"/></svg>',
  server: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="11" height="4" rx="1"/><rect x="2.5" y="9" width="11" height="4" rx="1"/><circle cx="5" cy="5" r=".7" fill="currentColor" stroke="none"/><circle cx="5" cy="11" r=".7" fill="currentColor" stroke="none"/></svg>',
  users: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5.5" cy="5.5" r="2.3"/><path d="M2 12.5c0-2 1.6-3.3 3.5-3.3s3.5 1.3 3.5 3.3"/><path d="M11 4.5a2 2 0 0 1 0 4M12.5 12.5c0-1.5-.6-2.6-1.8-3"/></svg>',
  audit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="2" width="9" height="12" rx="1.5"/><path d="M6 5h4M6 8h4M6 11h2.5"/></svg>',
  reports: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13V3M3 13h10"/><rect x="5" y="8" width="2" height="5"/><rect x="8" y="5" width="2" height="8"/><rect x="11" y="9.5" width="2" height="3.5"/></svg>',
  supply: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2 4 5v6l4 3 4-3V5z"/><path d="M4 5l4 3 4-3M8 8v6"/></svg>',
  db: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="8" cy="3.5" rx="5" ry="2"/><path d="M3 3.5v9c0 1.1 2.2 2 5 2s5-.9 5-2v-9"/></svg>',
  theme: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2a6 6 0 1 0 0 12c1 0 1.5-.7 1.5-1.5S9 11 8 11h1a3 3 0 0 0 3-3 6 6 0 0 0-4-6z"/><circle cx="6" cy="6" r=".7" fill="currentColor" stroke="none"/><circle cx="9.5" cy="5" r=".7" fill="currentColor" stroke="none"/></svg>',
  community: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="5" r="2"/><circle cx="11" cy="5" r="2"/><path d="M2 12c0-2 1.4-3 3-3s3 1 3 3M8 12c0-2 1.4-3 3-3s3 1 3 3"/></svg>',
  accounts: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="5" width="11" height="8" rx="1.5"/><path d="M5 5V4a3 3 0 0 1 6 0v1"/><circle cx="8" cy="9" r="1.4"/></svg>',
  mystats: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="4.5" r="2.5"/><path d="M3 13c0-2.5 2.2-4 5-4s5 1.5 5 4"/></svg>',
  leaderboard: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="3" width="5" height="7"/><rect x="2" y="6" width="3" height="7"/><rect x="11" y="6" width="3" height="7"/><line x1="5.5" y1="13" x2="10.5" y2="13"/></svg>',
  casino: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.5"/><line x1="8" y1="2" x2="8" y2="5.5"/><line x1="8" y1="10.5" x2="8" y2="14"/><line x1="2" y1="8" x2="5.5" y2="8"/><line x1="10.5" y1="8" x2="14" y2="8"/></svg>',
  factions: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v12M2 5h12M4 4l8 8M12 4l-8 8"/></svg>',
  bounties: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="7.5" r="5"/><line x1="11" y1="11" x2="14" y2="14"/><circle cx="7.5" cy="7.5" r="2"/></svg>',
  pmap: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4l4-1.5L10 4l4-1.5v9L10 13l-4 1.5L2 13z"/><circle cx="8" cy="9" r="1.6"/></svg>',
  pshop: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h10l-1 8H4z"/><path d="M6 5V4a2 2 0 0 1 4 0v1"/></svg>',
  emotes: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M6 9.5a3 3 0 0 0 4 0"/><circle cx="6" cy="6.5" r=".6" fill="currentColor" stroke="none"/><circle cx="10" cy="6.5" r=".6" fill="currentColor" stroke="none"/></svg>',
  portal: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="5.5" r="3"/><path d="M2.5 13.5c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5"/></svg>',
  health: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13.5C4.5 11 2.5 8.8 2.5 6.3 2.5 4.4 4 3 5.8 3c1.2 0 2 .5 2.2.5S9.2 3 10.4 3c1.7 0 3.1 1.4 3.1 3.3 0 2.5-2 4.7-5.5 7.2z"/></svg>',
  weapon: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 10.5 13 4l1.5 1.5-2 1.5-1.5 1.5-3 3-2-2-2.5 2z"/><path d="M4 12l-1.5 2.5M5.5 12.5 4.5 14.5"/></svg>',
  flag: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14V2"/><path d="M4 3h8l-2 2.5L12 8H4"/></svg>',
  skull: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5a5 5 0 0 0-5 5c0 1.8 1 3 2 3.8V13h2v-1.5h2V13h2v-1.7c1-.8 2-2 2-3.8a5 5 0 0 0-5-5z"/><circle cx="6" cy="7.5" r=".8" fill="currentColor" stroke="none"/><circle cx="10" cy="7.5" r=".8" fill="currentColor" stroke="none"/></svg>',
};

function icon(name) {
  return ICONS[name] || ICONS.overview;
}

/* ---------------------------------------------------------------------------
 * Nav sets (separate per surface — authorization models are NOT merged).
 * ------------------------------------------------------------------------- */
const OWNER_NAV = [
  { title: 'Overview', items: [
    { label: 'Dashboard', href: '/dashboard', icon: 'overview' },
  ] },
  { title: 'Server', items: [
    { label: 'Control', href: '/dashboard/server-control', icon: 'control' },
    { label: 'Stats', href: '/dashboard/server-stats', icon: 'stats' },
    { label: 'Automation', href: '/dashboard/automation', icon: 'automation' },
    { label: 'Rotation', href: '/dashboard/rotation', icon: 'rotation' },
    { label: 'Backups', href: '/dashboard/backups', icon: 'backups' },
    { label: 'Console', href: '/dashboard/console', icon: 'console' },
    { label: 'Activity', href: '/dashboard/activity-log', icon: 'activity' },
  ] },
  { title: 'People', items: [
    { label: 'Players', href: '/server-players', icon: 'players' },
    { label: 'Lists', href: '/server-lists', icon: 'lists' },
    { label: 'Roles', href: '/dashboard/roles', icon: 'roles' },
  ] },
  { title: 'World', items: [
    { label: 'Map', href: '/map', icon: 'map' },
    { label: 'Loot Finder', href: '/loot-finder', icon: 'loot' },
    { label: 'Exclusions', href: '/dashboard/spawn-exclusions', icon: 'shield' },
  ] },
  { title: 'System', items: [
    { label: 'Economy', href: '/dashboard/economy', icon: 'economy' },
    { label: 'Shop', href: '/dashboard/shop-admin', icon: 'shop' },
    { label: 'Tasks', href: '/dashboard/tasks', icon: 'tasks' },
    { label: 'Feeds', href: '/dashboard/feeds', icon: 'feeds' },
    { label: 'AI Assistant', href: '/dashboard/ai-assistant', icon: 'ai' },
    { label: 'Settings', href: '/dashboard/settings', icon: 'settings' },
    { label: 'Tools (Coming Soon)', dimmed: true, icon: 'tools' },
  ] },
];

const ADMIN_NAV = [
  { title: 'Overview', items: [
    { label: 'Dashboard', href: '/dashboard', icon: 'overview' },
  ] },
  { title: 'Platform', items: [
    { label: 'Guilds', href: '/admin/guilds', icon: 'guilds' },
    { label: 'Approvals', href: '/admin/guilds-approval', icon: 'shield' },
    { label: 'Servers', href: '/admin/servers', icon: 'server' },
    { label: 'Users', href: '/admin/users', icon: 'users' },
    { label: 'Audit', href: '/admin/audit', icon: 'audit' },
    { label: 'Reports', href: '/admin/reports', icon: 'reports' },
    { label: 'Supply', href: '/admin/supply-monitor', icon: 'supply' },
    { label: 'Economy', href: '/admin/economy-analytics', icon: 'economy' },
    { label: 'Database', href: '/admin/database', icon: 'db' },
    { label: 'Theme', href: '/admin/theme', icon: 'theme' },
  ] },
  { title: 'System', items: [
    { label: 'Tools (Coming Soon)', dimmed: true, icon: 'tools' },
  ] },
];

// Player portal variant. These are client-driven tabs (same ids player-portal.js
// already drives), rendered as shell nav items so the portal reuses the shell.
// Section list follows the route inventory in routes/playerPortal.js.
const PLAYER_NAV = [
  { title: 'Community', items: [
    { label: 'Player Portal', href: '/player', icon: 'portal', dataSection: 'root' },
    { label: 'Communities', icon: 'community', dataSection: 'guilds', btnId: 'nav-guilds' },
    { label: 'Link Accounts', icon: 'accounts', dataSection: 'discovery', btnId: 'nav-discovery' },
    { label: 'Leaderboard', icon: 'leaderboard', dataSection: 'leaderboard', btnId: 'nav-leaderboard' },
  ] },
  { title: 'My Stats', items: [
    { label: 'My Stats', icon: 'mystats', dataSection: 'stats', btnId: 'nav-stats' },
    { label: 'Sessions', icon: 'activity', dataSection: 'sessions', btnId: 'nav-sessions' },
    { label: 'Health', icon: 'health', dataSection: 'health', btnId: 'nav-health' },
    { label: 'Damage', icon: 'boost', dataSection: 'damage', btnId: 'nav-damage' },
    { label: 'Weapons', icon: 'weapon', dataSection: 'weapons', btnId: 'nav-weapons' },
    { label: 'Territory', icon: 'flag', dataSection: 'territory', btnId: 'nav-territory' },
    { label: 'Kills', icon: 'bounties', dataSection: 'kills', btnId: 'nav-kills' },
    { label: 'Deaths', icon: 'skull', dataSection: 'deaths', btnId: 'nav-deaths' },
    { label: 'Achievements', icon: 'tasks', dataSection: 'achievements', btnId: 'nav-achievements' },
    { label: 'Performance', icon: 'reports', dataSection: 'performance', btnId: 'nav-performance' },
  ] },
  { title: 'Game', items: [
    { label: 'Economy', icon: 'economy', dataSection: 'economy', btnId: 'nav-economy' },
    { label: 'Shop', icon: 'pshop', dataSection: 'shop', btnId: 'nav-shop' },
    { label: 'Map', icon: 'pmap', dataSection: 'map', btnId: 'nav-map' },
    { label: 'Emotes', icon: 'emotes', dataSection: 'emotes', btnId: 'nav-emotes' },
    { label: 'Casino', icon: 'casino', dataSection: 'casino', btnId: 'nav-casino' },
    { label: 'Factions', icon: 'factions', dataSection: 'factions', btnId: 'nav-factions' },
    { label: 'Bounties', icon: 'bounties', dataSection: 'bounties', btnId: 'nav-bounties' },
  ] },
];

/* ---------------------------------------------------------------------------
 * Small display-only guild-name lookup (mirrors themeInjection's primary
 * guild). Cached per user; pure display — it never gates anything.
 * ------------------------------------------------------------------------- */
const guildNameCache = new Map(); // userId -> { at, name }
const GUILD_NAME_TTL_MS = 5 * 60 * 1000;

async function displayGuildName(db, userId) {
  if (!db || !userId) return null;
  const cached = guildNameCache.get(userId);
  if (cached && Date.now() - cached.at < GUILD_NAME_TTL_MS) return cached.name;
  try {
    const row = await db.get(
      `SELECT g.name FROM guilds g
       JOIN guild_roles gr ON gr.guild_id = g.id
       WHERE gr.user_id = ? AND g.status = 'approved'
       ORDER BY g.id ASC LIMIT 1`,
      [userId]
    );
    const name = row ? row.name : null;
    guildNameCache.set(userId, { at: Date.now(), name });
    return name;
  } catch (err) {
    console.warn('⚠️ appShell: guild-name display lookup failed:', err.message);
    return null;
  }
}

/* ---------------------------------------------------------------------------
 * HTML builders
 * ------------------------------------------------------------------------- */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function navItemHtml(item, activePath) {
  const isActive = item.href && (activePath === item.href || activePath.indexOf(item.href + '/') === 0);
  const dimmed = item.dimmed ? ' is-dimmed' : '';
  const active = isActive ? ' is-active' : '';
  if (item.btnId) {
    // Player-portal client-driven tab (same id player-portal.js binds to).
    const hidden = item.dataSection !== 'guilds' ? ' hidden' : '';
    return `        <button type="button" id="${esc(item.btnId)}" class="dzc-shell-nav-item${active}${dimmed}" data-section="${esc(item.dataSection)}"${hidden} aria-label="${esc(item.label)}">\n          <span class="dzc-nav-icon">${icon(item.icon)}</span>\n          <span class="dzc-nav-label">${esc(item.label)}</span>\n        </button>`;
  }
  const tag = item.dimmed ? 'span' : 'a';
  const hrefAttr = item.dimmed ? 'aria-disabled="true"' : `href="${esc(item.href)}"`;
  const aria = isActive && !item.dimmed ? ' aria-current="page"' : '';
  return `        <${tag} class="dzc-shell-nav-item${active}${dimmed}" ${hrefAttr}${aria}>\n          <span class="dzc-nav-icon">${icon(item.icon)}</span>\n          <span class="dzc-nav-label">${esc(item.label)}</span>\n        </${tag}>`;
}

function sidebarNavHtml(groups, activePath) {
  return groups.map(group => {
    const items = group.items.map(item => navItemHtml(item, activePath)).join('\n');
    return `      <div class="dzc-nav-group" role="group" aria-label="${esc(group.title)}">\n        <span class="dzc-nav-group-title">${esc(group.title)}</span>\n${items}\n      </div>`;
  }).join('\n');
}

function brandHtml(surface) {
  // Player surface: distinct brand treatment (different mark + subtitle) so the
  // portal reads as a different product surface than owner/operator.
  if (surface === 'player') {
    return `    <div class="dzc-shell-brand dzc-shell-brand--player">
      <span class="dzc-shell-brand-mark" aria-hidden="true">${icon('portal')}</span>
      <span>
        <span class="dzc-shell-brand-name">SaltSkrew</span><br>
        <span class="dzc-shell-brand-sub">Player Portal</span>
      </span>
    </div>`;
  }
  return `    <div class="dzc-shell-brand">
      <span class="dzc-shell-brand-mark" aria-hidden="true">${icon('overview')}</span>
      <span>
        <span class="dzc-shell-brand-name">SaltSkrew</span><br>
        <span class="dzc-shell-brand-sub">DayZ Ops Platform</span>
      </span>
    </div>`;
}

function sidebarFootHtml(surface) {
  if (surface === 'player') {
    return `    <div class="dzc-shell-foot">
        <a class="dzc-shell-nav-item" href="/dashboard" data-shell-ownerlink>
          <span class="dzc-nav-icon">${icon('overview')}</span>
          <span class="dzc-nav-label">Owner Portal</span>
        </a>
        <a class="dzc-shell-nav-item" href="/logout">
          <span class="dzc-nav-icon">${icon('shield')}</span>
          <span class="dzc-nav-label">Logout</span>
        </a>
    </div>`;
  }
  return `    <div class="dzc-shell-foot">
        <a class="dzc-shell-nav-item" href="/player-portal">
          <span class="dzc-nav-icon">${icon('portal')}</span>
          <span class="dzc-nav-label">Player Portal</span>
        </a>
        <a class="dzc-shell-nav-item" href="/logout">
          <span class="dzc-nav-icon">${icon('shield')}</span>
          <span class="dzc-nav-label">Logout</span>
        </a>
    </div>`;
}

function sidebarHtml(surface, groups, activePath) {
  return `  <aside class="dzc-shell-sidebar" id="dzc-shell-sidebar" aria-label="Primary navigation">
${brandHtml(surface)}
    <nav class="dzc-shell-nav" aria-label="Primary">${sidebarNavHtml(groups, activePath)}
    </nav>
${sidebarFootHtml(surface)}
  </aside>`;
}

function breadcrumbHtml(crumbs) {
  const parts = (crumbs || []).map((crumb, i) => {
    const isLast = i === (crumbs || []).length - 1;
    if (isLast) {
      return `<span class="dzc-shell-crumb-current" aria-current="page">${esc(crumb.label)}</span>`;
    }
    return `<a href="${esc(crumb.href)}" class="dzc-shell-crumb-link">${esc(crumb.label)}</a>`;
  }).join('\n        <span class="dzc-shell-crumb-sep" aria-hidden="true">/</span>\n        ');
  return `      <nav class="dzc-shell-crumb" aria-label="Breadcrumb">\n        ${parts}\n      </nav>`;
}

/**
 * Build the server/guild context pill.
 * @param {object} ctx - display-only context passed by the ROUTE:
 *   { kind: 'guild'|'server'|'player', guildName, serverName, live: boolean }
 * Live fields (status dot / players / last-sync) are populated client-side by
 * public/js/app-shell.js from data the page is already authorized to load.
 */
function contextPillHtml(ctx) {
  const kind = ctx && ctx.kind ? ctx.kind : 'guild';
  const primary = kind === 'guild' ? (ctx.guildName || 'Guild')
    : kind === 'server' ? (ctx.serverName || ctx.guildName || 'Server')
    : 'Player';
  const dataServer = (kind === 'server' && ctx.serverName) ? ` data-server-name="${esc(ctx.serverName)}"` : '';
  return `      <div class="dzc-context-pill" data-pill-kind="${esc(kind)}" data-state="unknown"${dataServer}>
        <span class="dzc-pill-dot" aria-hidden="true"></span>
        <span class="dzc-pill-guild">${esc(primary)}</span>
        <span class="dzc-pill-meta" data-empty="true" aria-live="polite">
          <span class="dzc-pill-status"></span>
          <span class="dzc-pill-sep" aria-hidden="true">·</span>
          <span class="dzc-pill-players"></span>
          <span class="dzc-pill-sep" aria-hidden="true">·</span>
          <span class="dzc-pill-sync"></span>
        </span>
      </div>`;
}

function hamburgerHtml() {
  return `      <button type="button" class="dzc-shell-hamburger" id="dzc-shell-hamburger" aria-label="Open navigation menu" aria-controls="dzc-shell-sidebar" aria-expanded="false">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </button>`;
}

function topbarHtml(surface, crumbs, ctx, contentClass) {
  const extra = contentClass ? ` ${contentClass}` : '';
  return `  <div class="dzc-shell-main">
    <header class="dzc-shell-topbar" data-surface="${esc(surface)}">
${hamburgerHtml()}
${breadcrumbHtml(crumbs)}
${contextPillHtml(ctx)}
    </header>
    <main class="dzc-shell-content${extra}">`;
}

/* ---------------------------------------------------------------------------
 * Composition
 * ------------------------------------------------------------------------- */
function readPage(filePath) {
  if (!isDevelopment && htmlCache.has(filePath)) return htmlCache.get(filePath);
  const html = fs.readFileSync(filePath, 'utf8');
  if (!isDevelopment) htmlCache.set(filePath, html);
  return html;
}

/**
 * Compose the shell around an existing page file and send it.
 *
 * @param {string} filePath - absolute path to the page HTML file.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} opts
 *   surface: 'owner' | 'admin' | 'player'
 *   activePath: path to mark active (defaults to req.path)
 *   crumbs: [{label, href}] breadcrumb trail (last = current page)
 *   serverContext: display-only { kind, guildName, serverName }
 *   contentClass: optional extra class on .dzc-shell-content (page-scoped styling hook)
 */
async function renderShellPage(filePath, req, res, opts) {
  const options = opts || {};
  const surface = options.surface || 'owner';
  const activePath = options.activePath || req.path || req.originalUrl.split('?')[0];
  const groups = surface === 'admin' ? ADMIN_NAV : surface === 'player' ? PLAYER_NAV : OWNER_NAV;

  let html = readPage(filePath);
  const ctx = options.serverContext || { kind: 'guild' };

  // 1) Add shell.css into <head> (after theme.css so token cascade is intact,
  //    before tailwind.css so page utility classes still apply to content).
  html = html.replace(
    /(<link[^>]*href="\/css\/theme\.css"[^>]*>)/i,
    `$1\n  <link rel="stylesheet" href="/css/shell.css">`
  );

  // 2) Wrap the body content with the shell.
  //    .dzc-shell (flex) > [sidebar, .dzc-shell-main > topbar + .dzc-shell-content > page]
  const bodyOpen = html.match(/<body[^>]*>/i);
  if (bodyOpen) {
    const contentClass = options.contentClass || '';
    const shellOpen = `\n  <div class="dzc-shell">`
      + `\n${sidebarHtml(surface, groups, activePath)}`
      + `\n${topbarHtml(surface, options.crumbs, ctx, contentClass)}`;
    html = html.replace(/<body[^>]*>/i, `${bodyOpen[0]}${shellOpen}`);
    // Close .dzc-shell-content, .dzc-shell-main, .dzc-shell; then the
    // off-canvas backdrop + shell script, then restore the original </body>.
    const shellClose = `    </main>\n  </div>\n  </div>\n  <div class="dzc-shell-backdrop" data-shell-backdrop hidden></div>\n  <script src="/js/app-shell.js" defer></script>\n</body>`;
    html = html.replace(/<\/body>/i, shellClose);
  }

  // Reuse the exact CSRF + theme injection path from renderWithCsrf.
  res.send(applyPageChromes(html, req));
}

module.exports = {
  renderShellPage,
  displayGuildName,
  OWNER_NAV,
  ADMIN_NAV,
  PLAYER_NAV,
  // exported for unit tests
  _internal: { navItemHtml, sidebarNavHtml, contextPillHtml, sidebarHtml, topbarHtml, esc, icon },
};
