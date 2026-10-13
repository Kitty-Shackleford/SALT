'use strict';

const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/auth');
const themeService = require('../services/themeService');

/**
 * Theme routes (B1.2). Mounted at /api/theme:
 *
 *   GET  /api/theme/packs   — available holiday packs (name + label + window).
 *   GET  /api/theme         — current user's preference.
 *   PUT  /api/theme         — set the user's personal theme (one of the five
 *                             base themes, or the legacy "dark"/"light"
 *                             aliases; null to clear back to the guild default).
 *
 * User-level theme is independent of the guild default and applies to every
 * page the user views (resolved by the theme injection middleware at render
 * time), so no client round-trip is needed to see the change on the next page
 * load — the toggle below also flips data-theme locally for instant feedback.
 */

router.use(ensureAuthenticated);

router.get('/packs', (req, res) => {
  const packs = themeService.loadHolidayPacks();
  res.json({
    success: true,
    packs: Object.entries(packs).map(([name, pack]) => ({
      name,
      label: pack.label,
      window: pack.window || null,
    })),
  });
});

router.get('/', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const row = await db.get('SELECT theme_preference FROM users WHERE id = ?', [req.user.id]);
    res.json({ success: true, theme: row ? row.theme_preference : null });
  } catch (error) {
    console.error('❌ [API] theme read error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

router.put('/', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { theme } = req.body || {};
    if (theme !== null && theme !== undefined && !themeService.validTheme(theme)) {
      return res.status(400).json({
        success: false,
        error: `theme must be one of: ${themeService.BASE_THEMES.join(', ')}`,
      });
    }
    await db.query(
      'UPDATE users SET theme_preference = ? WHERE id = ?',
      [
        theme === undefined ? null : themeService.normalizeThemeName(theme),
        req.user.id,
      ]
    );
    res.json({
      success: true,
      theme: theme === undefined ? null : themeService.normalizeThemeName(theme),
    });
  } catch (error) {
    console.error('❌ [API] theme update error:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
