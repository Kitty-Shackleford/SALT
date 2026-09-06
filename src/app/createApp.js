/**
 * Express Application Factory
 *
 * Creates and fully configures an Express application.  Call this function
 * once the database has been initialised and pass the `db` instance in so
 * that Passport strategies and middleware closures can reference it.
 *
 * Usage:
 *   const { createApp } = require('./src/app/createApp');
 *   const app = createApp(db);
 */

const express = require('express');
const csrf = require('csurf');

const { registerMiddleware } = require('./registerMiddleware');
const { registerRoutes } = require('./registerRoutes');

/**
 * @param {import('../../db/abstraction/postgres')} db - Initialised PostgreSQL database adapter
 * @returns {import('express').Application}
 */
function createApp(db) {
  const app = express();

  // Trust the first proxy (nginx / reverse-proxy in front of the app)
  app.set('trust proxy', 1);

  // Attach db to app.locals so every route handler can reach it via
  // req.app.locals.db without needing a module-level closure.
  app.locals.db = db;

  // CSRF protection middleware – created here so the same instance can be
  // shared between the middleware stack (applied per-request) and individual
  // routes that need to generate tokens.
  const csrfProtection = csrf({
    cookie: false, // Use session-based tokens (more secure than cookie-based)
    value: (req) => {
      // Accept tokens from a custom header first (used by fetchWithCsrf in the
      // frontend), then fall back to the body field.
      // Query parameters are intentionally NOT accepted (security risk).
      return (
        req.headers['csrf-token'] ||
        req.headers['x-csrf-token'] ||
        req.body._csrf
      );
    }
  });

  registerMiddleware(app, db, csrfProtection);
  registerRoutes(app, csrfProtection);

  return app;
}

module.exports = { createApp };
