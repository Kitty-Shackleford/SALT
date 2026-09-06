const fs = require('fs');

const htmlCache = new Map();
const isDevelopment = process.env.NODE_ENV !== 'production';

/**
 * Read an HTML file, inject the CSRF token as a <meta> tag, and send it.
 * In production the file is cached after the first read; in development it
 * is re-read on every request so changes are picked up immediately.
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

  const csrfToken = req.csrfToken ? req.csrfToken() : '';

  // HTML-escape the token to prevent XSS
  const escapedToken = csrfToken
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  // Inject CSRF token as a <meta> tag before </head>
  const htmlWithToken = html.replace(
    '</head>',
    `  <meta name="csrf-token" content="${escapedToken}">\n</head>`
  );

  res.send(htmlWithToken);
}

module.exports = { renderWithCsrf };
