const fs = require('fs');
const themeService = require('../services/themeService');

const htmlCache = new Map();
const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Read an HTML file, inject the CSRF token as a <meta> tag, and send it.
 * In production the file is cached after the first read; in development it
 * is re-read on every request so changes are picked up immediately.
 *
 * Also injects the resolved theme (B1.2) when the theme middleware set
 * `req.theme`: a `data-theme` attribute on <html>, an inline no-flash script
 * that applies the user's persisted theme before first paint, and (when
 * present) a `<style data-theme-override>` block carrying the holiday/accent
 * token values. The override is emitted AFTER the page's own <link> tags so
 * it wins the cascade for the tokens it redeclares.
 *
 * @param {string} filePath - Absolute path to the HTML file
 * @param {import('express').Request} req - Express request (must have csrfToken())
 * @param {import('express').Response} res - Express response
 */
function renderWithCsrf(filePath, req, res) {
  let html;

  if (!isDevelopment && htmlCache.has(filePath)) {
    html = htmlCache.get(filePath);
  } else {
    html = fs.readFileSync(filePath, 'utf8');
    if (!isDevelopment) {
      htmlCache.set(filePath, html);
    }
  }

  res.send(applyPageChromes(html, req));
}

/**
 * Apply the shared per-request page "chromes" to an already-fully-assembled
 * HTML document: the `data-theme` attribute on <html>, the no-flash theme
 * script + floating theme toggle, the (optional) holiday/accent override
 * <style> block, and the CSRF <meta> token. This is the same injection
 * `renderWithCsrf` performs; it is exported so the route-aware app shell
 * (utils/appShell.js) can build a composed document and hand it back through
 * the exact same injection path.
 *
 * @param {string} html - A complete HTML document string.
 * @param {import('express').Request} req - Express request (must have csrfToken()).
 * @returns {string} The document with all chromes injected.
 */
function applyPageChromes(html, req) {
  const csrfToken = req.csrfToken ? req.csrfToken() : '';
  const escapedToken = csrfToken
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const overrideCss = req.theme && typeof req.theme.overrideCss === 'string'
    ? req.theme.overrideCss
    : '';
  const baseTheme = req.theme && themeService.normalizeThemeName(req.theme.baseTheme)
    ? themeService.normalizeThemeName(req.theme.baseTheme)
    : themeService.DEFAULT_BASE_THEME;
  const themeAttr = `<html data-theme="${baseTheme}"`;

  const headInjection = `  <meta name="csrf-token" content="${escapedToken}">
  <script>/* Theme (card 2/9): apply persisted preference before first paint (no flash). */(function(){try{var b=["livonia","chernarus","sakhal","nasadra","high-contrast"];var a={dark:"livonia",light:"sakhal"};var s=localStorage.getItem("dayz-theme");if(s){s=a[s]||s;if(b.indexOf(s)>-1)document.documentElement.setAttribute("data-theme",s);}}catch(e){}})();</script>
  <script defer src="/js/theme-toggle.js"></script>
${overrideCss ? `  <style data-theme-override>\n${overrideCss}\n  </style>` : ''}
`;

  return html
    .replace(/<html(\s[^>]*)?>/i, `${themeAttr}$1>`)
    .replace('</head>', `${headInjection}</head>`);
}

module.exports = { renderWithCsrf, applyPageChromes };
