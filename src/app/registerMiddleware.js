/**
 * Middleware Registration
 *
 * Registers all Express middleware in the correct order.  This module is
 * intentionally free of route definitions – see registerRoutes.js for those.
 */

const session = require('express-session');
const connectPgSimple = require('connect-pg-simple')(session);
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const express = require('express');

const { encryptToken } = require('../../utils/encryption');
const { getPublicConfig, isPlayerPortalHost } = require('../../utils/publicConfig');
const { apiLimiter, apiMutationLimiter, authLimiter } = require('../../middleware/rateLimiter');
const { requestAbortMiddleware } = require('../../utils/requestAbort');
const {
  reconcileConfiguredDashboardOwner,
} = require('../../services/dashboardOwnerBootstrapService');
const { upsertDiscordOAuthUser } = require('../../services/discordOAuthUserService');

/**
 * Configure Passport.js serialisation/deserialisation and the Discord OAuth
 * strategy.  Must be called before `app.use(passport.initialize())`.
 *
 * @param {Object} db - Initialised database adapter
 */
function configurePassport(db) {
  // Schema uses snake_case column names (discord_id, access_token).
  passport.serializeUser((user, done) => {
    const id = user.discord_id;
    if (process.env.NODE_ENV !== 'production') {
      console.log('🔐 Serializing user:', id);
    }
    done(null, id);
  });

  passport.deserializeUser(async (id, done) => {
    if (process.env.NODE_ENV !== 'production') {
      console.log('🔓 Deserializing user:', id);
    }
    try {
      const row = await db.get('SELECT * FROM users WHERE discord_id = ?', [id]);
      if (!row) {
        console.error('❌ User not found:', id);
        return done(null, false);
      }
      if (process.env.NODE_ENV !== 'production') {
        console.log('✅ Deserialized user:', row.username);
      }
      done(null, row);
    } catch (err) {
      console.error('❌ Deserialize error:', err);
      done(err);
    }
  });

  passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: 'dummy', // Overridden dynamically per-request
    scope: ['identify', 'email', 'guilds'],
    state: true
  }, async (accessToken, refreshToken, profile, done) => {
    if (process.env.NODE_ENV !== 'production') {
      console.log('🎮 Discord strategy callback for:', profile.username);
    }

    const user = {
      discord_id: profile.id,
      username: profile.username,
      avatar: `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`,
      access_token: encryptToken(accessToken)
    };

    try {
      await upsertDiscordOAuthUser(db, {
        discordId: user.discord_id,
        username: user.username,
        avatar: user.avatar,
        accessToken: user.access_token,
      });

      const ownerBootstrap = await reconcileConfiguredDashboardOwner(db.pool, {
        discordId: user.discord_id,
        username: user.username,
        avatar: user.avatar,
      }, { source: 'discord_oauth' });
      if (ownerBootstrap.status === 'owner_conflict') {
        throw new Error('Configured Dashboard Owner conflicts with the existing Dashboard Owner');
      }

      const authenticatedUser = await db.get('SELECT * FROM users WHERE discord_id = ?', [user.discord_id]);
      done(null, authenticatedUser);
    } catch (err) {
      console.error('❌ DB error:', err);
      done(err);
    }
  }));
}

/**
 * Register all middleware on the Express `app`.
 *
 * @param {import('express').Application} app
 * @param {Object} db - Initialised database adapter (PostgreSQL adapter with pool property)
 * @param {Function} csrfProtection - csurf middleware instance
 */
function registerMiddleware(app, db, csrfProtection) {
  const publicConfig = getPublicConfig();
  app.use(requestAbortMiddleware);
  // Create PostgreSQL-backed session store using the existing connection pool
  const sessionStore = new connectPgSimple({
    pool: db.pool,
    createTableIfMissing: true
  });

  // Session configuration
  const sessionSecure = process.env.SESSION_SECURE_COOKIE === 'true';

  app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      secure: sessionSecure,
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: 'lax'
    }
  }));

  console.log(`🔐 Session cookies: ${sessionSecure ? 'secure (HTTPS only)' : 'insecure (HTTP allowed)'}`);

  app.use(cookieParser());

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
        scriptSrcAttr: ["'none'"],
        imgSrc: ["'self'", "data:", "https://cdn.discordapp.com", "https://avatars.githubusercontent.com"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: []
      }
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  }));

  // Passport – must be configured before initialising
  configurePassport(db);
  app.use(passport.initialize());
  app.use(passport.session());

  // Request logger. Never log cookies or session identifiers.
  app.use((req, res, next) => {
    console.log(`\n📨 ${req.method} ${req.path}`);
    next();
  });

  // Subdomain detection
  app.use((req, res, next) => {
    const host = req.get('host');
    console.log(`   🌐 Host detected: ${host}`);

    if (isPlayerPortalHost(host, publicConfig)) {
      req.isPlayerPortal = true;
      console.log(`   🎮 Player portal detected!`);
    } else {
      console.log(`   🔧 Admin portal (or main site)`);
    }

    next();
  });

  app.use(express.json());
  // HTML documents are served only by the canonical route handlers, where
  // authentication and authorization are enforced. Static delivery is assets-only.
  app.use((req, res, next) => {
    if (req.method === 'GET' && req.path.endsWith('.html')) {
      return res.status(404).send('Not found');
    }
    return next();
  });
  app.use(express.static('public', {
    index: false,
    redirect: false,
  }));

  // Apply CSRF protection to all state-changing requests and to GET requests
  // that render HTML pages (so they receive the token in the page).
  app.use((req, res, next) => {
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
      return csrfProtection(req, res, next);
    }
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      return csrfProtection(req, res, next);
    }
    next();
  });

  // Make CSRF token available to all route handlers via res.locals
  app.use((req, res, next) => {
    if (req.csrfToken) {
      res.locals.csrfToken = req.csrfToken();
    }
    next();
  });

  // Rate limiters
  app.use('/api/', apiLimiter, apiMutationLimiter);
  app.use('/auth/discord', authLimiter);
}

module.exports = { registerMiddleware };
