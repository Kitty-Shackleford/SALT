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
const { shouldLogRequest } = require('../../utils/requestLogPolicy');
const {
  reconcileConfiguredDashboardOwner,
} = require('../../services/dashboardOwnerBootstrapService');
const { upsertDiscordOAuthUser } = require('../../services/discordOAuthUserService');
const { ensureAuthenticated } = require('../../middleware/auth');

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

  // Keep dynamic requests observable without logging high-volume static assets.
  app.use((req, res, next) => {
    if (shouldLogRequest(req)) console.log(`\n📨 ${req.method} ${req.path}`);
    next();
  });

  // Subdomain detection
  app.use((req, res, next) => {
    const host = req.get('host');
    if (isPlayerPortalHost(host, publicConfig)) req.isPlayerPortal = true;
    next();
  });

  // Only report-only mission diagnostics accept larger browser drafts.
  // Authentication precedes allocation; other APIs retain the default limit.
  app.use('/api/validate', ensureAuthenticated, express.json({ limit: '6mb' }));
  // AI chat/analysis carry the full working-copy file in the body (the read
  // endpoint caps it at 5MB); 12MB covers JSON escaping + history overhead.
  // Config intelligence routes carry up to five working-copy files in one
  // body (types.xml alone is ~740KB); same 12MB envelope as chat/analyze.
  // One shared parser instance across the routes: body parsing happens on the
  // first matching layer and is a no-op (req.body already set) for the rest.
  const largeAiBody = express.json({ limit: '12mb' });
  for (const routePath of [
    '/api/ai/chat', '/api/ai/analyze',
    '/api/ai/config-edit', '/api/ai/balance-pass', '/api/ai/config-validate',
  ]) {
    app.use(routePath, ensureAuthenticated, largeAiBody);
  }
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
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

  // Apply session-backed CSRF protection globally. csurf validates unsafe
  // methods and exposes req.csrfToken() on safe requests used to render pages.
  app.use(csrfProtection);

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
