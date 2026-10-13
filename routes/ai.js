/*
 * AI Server Assistant Routes
 *
 * Provides REST endpoints for:
 *   - Connecting / disconnecting a GitHub account (PAT or OAuth)
 *   - Linking a GitHub repo to a server for config versioning
 *   - AI-powered chat against a server config file
 *   - Data-driven file analysis (generates suggestions from real server stats)
 *   - Applying / rejecting suggestions (optionally committing to GitHub)
 *
 * All routes require authentication. GitHub tokens are encrypted at rest
 * using the same AES-256-CBC scheme as Nitrado tokens.
 *
 * Base path: /api/ai  (mounted in registerRoutes.js)
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { encryptToken, decryptToken } = require('../utils/encryption');
const { authorizePlatformServer, authorizeServer, CAPABILITIES } = require('../services/authorizationService');
const githubService = require('../services/githubService');
const {
  inspectGitHubActionsIntegration,
} = require('../services/githubActionsIntegrationService');
const aiService     = require('../services/aiService');
const aiProviderService = require('../services/aiProviderService');
const aiSharedRouterService = require('../services/aiSharedRouterService');
const logIntelligenceService = require('../services/logIntelligenceService');
const opsIntelligenceService = require('../services/opsIntelligenceService');
const configIntelligenceService = require('../services/aiConfigIntelligenceService');
const patchEngine = require('../services/aiConfigPatchService');
const dataTuningService = require('../services/dataTuningService');
const { patchError } = patchEngine;
const { getGuildDownloadPath } = require('../services/logSyncService');
const { resolveExistingContainedPath } = require('../utils/safePath');
const { sendExternalApiError } = require('../utils/externalApiResponse');

/**
 * Resolve the on-disk ingested `config/` directory for the exact server the
 * caller is authorized for (downloads/<guildId>/server_<platformServerId>/
 * config). Returns null when no ingested data exists yet. Contained-path
 * resolution guarantees we never read outside the authorized download root.
 */
function resolveServerConfigDir(req) {
  const access = req.platformServerAccess || {};
  if (!access.discordGuildId || !access.platformServerId) return null;
  let serverRoot;
  try {
    serverRoot = getGuildDownloadPath(access.discordGuildId, access.platformServerId);
  } catch (_error) {
    return null;
  }
  try {
    return resolveExistingContainedPath(serverRoot, 'config');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null; // nothing ingested yet
    throw error;
  }
}

/**
 * Resolve the caller's AI provider and, for the shared free router, consume one
 * of their daily calls before any AI work happens. Mirrors the /chat and
 * /analyze quota semantics so the shared-router budget is never bypassed.
 * @returns {Promise<object|null>} the resolved provider, or null when none.
 */
async function prepareAiProvider(req) {
  const db = req.app.locals.db;
  const userId = req.user.id;
  const provider = await aiProviderService.resolveUserProvider(db, userId);
  if (!provider) return null;
  if (provider.source === 'shared-router') {
    await aiSharedRouterService.consumeCall(db, userId); // throws 429 when over budget
  }
  return provider;
}

async function ensureAiServerManage(req, res, next) {
  try {
    const context = await authorizePlatformServer(
      req.app.locals.db,
      req.user,
      req.params.platformServerId || req.body?.platformServerId || req.body?.serverId,
      CAPABILITIES.SERVER_MANAGE
    );
    if (!context) return res.status(404).json({ error: 'Server not found' });
    req.platformServerAccess = {
      serverId: context.server.id,
      guildId: context.guild.id,
      discordGuildId: context.guild.discordGuildId,
      platformServerId: context.server.platformServerId,
    };
    return next();
  } catch (error) {
    console.error('[AI] server authorization error:', error.message);
    return res.status(500).json({ error: 'Failed to authorize server' });
  }
}

router.param('platformServerId', ensureAiServerManage);

const MAX_CHAT_MESSAGES = 24;
const MAX_CHAT_MESSAGE_CHARS = 12000;
const MAX_CHAT_HISTORY_CHARS = 100000;

function boundChatHistory(value, maxChars = MAX_CHAT_HISTORY_CHARS) {
  if (!Array.isArray(value)) return [];
  let bounded = value
    .filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
    .map(item => ({ role: item.role, content: item.content.slice(0, MAX_CHAT_MESSAGE_CHARS) }))
    .slice(-MAX_CHAT_MESSAGES);
  while (bounded.length > 1 && JSON.stringify(bounded).length > maxChars) {
    bounded.shift();
  }
  return bounded;
}

function withoutLegacyFileContext(history) {
  if (history[0]?.role === 'user' && history[0].content.startsWith('Here is the current content of ') &&
      history[1]?.role === 'assistant' && history[1].content.startsWith("Got it — I've loaded ")) {
    return history.slice(2);
  }
  return history;
}

function buildCurrentFileContext(filename, fileContent) {
  if (typeof fileContent !== 'string') return [];
  return [{
    role: 'user',
    content: `Here is the complete current content of ${filename}:\n\`\`\`\n${fileContent}\n\`\`\`\nUse this current version, not any file content from earlier messages.`,
  }];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Pull the decrypted GitHub token for the current user, or null. */
async function getUserGithubToken(db, userId) {
  const row = await db.get(
    'SELECT token_hash, auto_commit FROM github_connections WHERE user_id = $1',
    [userId]
  );
  if (!row) return null;
  return {
    token: decryptToken(row.token_hash),
    autoCommit: row.auto_commit === 1 || row.auto_commit === true,
  };
}

/** Resolve a platform_server_id string to an internal servers.id integer. */
async function resolveServerId(db, platformServerId) {
  const row = await db.get(
    'SELECT id FROM servers WHERE platform_server_id = $1 LIMIT 1',
    [String(platformServerId)]
  );
  return row?.id || null;
}

/** Resolve an exact server's repository link and the current user's connection. */
async function getServerGithubContext(db, userId, platformServerId) {
  const row = await db.get(
    `SELECT grl.repo_owner, grl.repo_name, grl.branch, grl.base_path, gc.token_hash
     FROM servers s
     JOIN github_repo_links grl ON grl.server_id = s.id AND grl.user_id = $1
     JOIN github_connections gc ON gc.user_id = grl.user_id
     WHERE CAST(s.platform_server_id AS TEXT) = $2
     LIMIT 1`,
    [userId, String(platformServerId)]
  );
  if (!row) return null;
  return {
    token: decryptToken(row.token_hash),
    owner: row.repo_owner,
    repo: row.repo_name,
    branch: row.branch,
    basePath: row.base_path,
  };
}

/** Resolve the canonical Actions repository only while its connection owner remains an exact-server administrator. */
async function getServerActionsContext(db, serverId, guildId) {
  const row = await db.get(
    `SELECT gai.repo_owner, gai.repo_name, gai.branch, gc.token_hash
     FROM github_action_integrations gai
     JOIN servers s ON s.id = gai.server_id
     JOIN guilds g ON g.id = s.guild_id
     JOIN github_connections gc ON gc.user_id = gai.connection_user_id
     LEFT JOIN guild_roles gr
       ON gr.guild_id = g.id
      AND gr.user_id = gai.connection_user_id
     LEFT JOIN server_role_assignments sra
       ON sra.server_id = s.id
      AND sra.guild_id = g.id
      AND sra.user_id = gai.connection_user_id
     WHERE gai.server_id = $1
       AND s.guild_id = $2
       AND s.status = 'active'
       AND g.status = 'approved'
       AND (
         gr.role IN ('owner', 'admin')
         OR (sra.role = 'admin' AND sra.status = 'active')
       )
     LIMIT 1`,
    [serverId, guildId]
  );
  if (!row) return null;
  return {
    token: decryptToken(row.token_hash),
    owner: row.repo_owner,
    repo: row.repo_name,
    branch: row.branch,
  };
}

/** Resolve a suggestion only while its creator still administers its approved server. */
async function getAuthorizedSuggestion(db, user, suggestionId) {
  const suggestion = await db.get(
    `SELECT ais.*
     FROM ai_suggestions ais
     JOIN servers s ON s.id = ais.server_id
     JOIN guilds g ON g.id = s.guild_id
     WHERE ais.id = ? AND ais.user_id = ?
       AND s.status = 'active' AND g.status = 'approved'
     LIMIT 1`,
    [suggestionId, user.id]
  );
  if (!suggestion) return null;
  const context = await authorizeServer(db, user, suggestion.server_id, CAPABILITIES.SERVER_MANAGE);
  return context ? suggestion : null;
}

/**
 * Normalize a provider failure or a deterministic validation failure from the
 * AI routes into an HTTP response. Deterministic errors thrown by the config
 * intelligence services (patch validation, file-list normalization, ...) carry
 * their own .status/.code — surface them with per-file detail. Everything else
 * goes through the shared external-API error mapping.
 */
function sendAiError(res, error, fallbackService = 'AI') {
  if (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 500
      && typeof error.code === 'string' && error.code) {
    return res.status(error.status).json({
      success: false,
      error: error.message,
      code: error.code,
      ...(Array.isArray(error.fileErrors) ? { fileErrors: error.fileErrors } : {}),
    });
  }
  return sendExternalApiError(res, error, fallbackService);
}

// ─── GitHub Connection ────────────────────────────────────────────────────────

router.get('/provider/status', async (req, res) => {
  try {
    const status = await aiProviderService.getUserProviderStatus(
      req.app.locals.db,
      req.user.id
    );
    // When the user will ride the shared free router, report how much
    // budget is left today so the UI can set expectations.
    if (status.source === 'shared-router') {
      status.sharedRemaining = await aiSharedRouterService.remaining(req.app.locals.db, req.user.id);
    }
    res.json(status);
  } catch (err) {
    console.error('[AI] provider/status error:', err.message);
    res.status(500).json({ error: 'Failed to get AI provider status' });
  }
});

router.put('/provider/connection', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const userId = req.user.id;
    const { type, token, baseURL, model } = req.body || {};
    if (type === aiProviderService.OPENAI_COMPATIBLE) {
      const validated = aiProviderService.validateOpenAiConnection({ token, baseURL, model });
      await aiService.callAiApi(
        [{ role: 'user', content: 'Reply with exactly: connected' }],
        0,
        {
          apiKey: validated.token,
          baseURL: validated.baseURL,
          model: validated.model,
          enforcePublicAddress: true,
        }
      );
      const saved = await aiProviderService.saveOpenAiConnection(db, userId, validated);
      return res.json({ success: true, ...saved });
    }
    if (type === aiProviderService.COPILOT) {
      const provider = await aiProviderService.prepareCopilotProvider(db, userId, model);
      await aiService.callCopilotApi(
        [{ role: 'user', content: 'Reply with exactly: connected' }],
        provider
      );
      const selected = await aiProviderService.selectCopilot(db, userId, provider);
      return res.json({ success: true, ...selected });
    }
    return res.status(400).json({ error: 'Unsupported AI provider type' });
  } catch (err) {
    console.error('[AI] provider connection error:', err.code || err.name);
    if (err.code === 'AI_PROVIDER_URL_INVALID' || err.code === 'AI_PROVIDER_URL_INSECURE' ||
        err.code === 'AI_PROVIDER_URL_CREDENTIALS' ||
        err.code === 'AI_PROVIDER_HOST_NOT_ALLOWED' ||
        err.code === 'AI_PROVIDER_TOKEN_INVALID' || err.code === 'AI_PROVIDER_MODEL_INVALID') {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === 'COPILOT_GITHUB_REQUIRED' || err.code === 'COPILOT_TOKEN_UNSUPPORTED' ||
        err.code === 'COPILOT_GITHUB_CHANGED') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    return sendExternalApiError(res, err, 'AI');
  }
});

router.delete('/provider/connection', async (req, res) => {
  try {
    await aiProviderService.disconnect(req.app.locals.db, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[AI] provider disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect AI provider' });
  }
});

/** List approved servers the current operator may administer. */
router.get('/servers', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const rows = await db.query(
      `SELECT s.id, CAST(s.platform_server_id AS TEXT) AS platform_server_id,
              s.name, s.platform
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
       LEFT JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = $1
       LEFT JOIN server_role_assignments sra
         ON sra.server_id = s.id AND sra.guild_id = s.guild_id AND sra.user_id = $1
       WHERE s.status = 'active'
         AND (gr.role IN ('owner', 'admin') OR (sra.role = 'admin' AND sra.status = 'active'))
       ORDER BY s.name ASC`,
      [req.user.id]
    );
    res.json({
      servers: rows.map(row => ({
        id: row.id,
        platformServerId: String(row.platform_server_id),
        name: row.name,
        platform: row.platform,
      })),
    });
  } catch (err) {
    console.error('[AI] list servers error:', err.message);
    res.status(500).json({ error: 'Failed to list servers' });
  }
});

/**
 * GET /api/ai/github/status
 * Returns the current GitHub connection status for the authenticated user.
 */
router.get('/github/status', async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;

    const row = await db.get(
      `SELECT github_username, auto_commit, token_type, created_at
       FROM github_connections WHERE user_id = $1`,
      [userId]
    );

    if (!row) return res.json({ connected: false });

    res.json({
      connected: true,
      username: row.github_username,
      tokenType: row.token_type,
      autoCommit: row.auto_commit === 1 || row.auto_commit === true,
      connectedAt: row.created_at,
    });
  } catch (err) {
    console.error('[AI] github/status error:', err.message);
    res.status(500).json({ error: 'Failed to get GitHub status' });
  }
});

/**
 * POST /api/ai/github/connect-pat
 * Body: { token: string }
 * Verifies the PAT against the GitHub API and saves it encrypted.
 */
router.post('/github/connect-pat', async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;
    const { token } = req.body;

    if (!token || typeof token !== 'string' || token.trim().length < 10) {
      return res.status(400).json({ error: 'A valid GitHub token is required' });
    }

    // Verify the token works and fetch the GitHub username
    let ghUser;
    try {
      ghUser = await githubService.getAuthenticatedUser(token.trim());
    } catch (verificationError) {
      if (verificationError.category === 'authentication' || verificationError.category === 'client') {
        return res.status(400).json({ error: 'GitHub rejected the token or its permissions' });
      }
      return sendExternalApiError(res, verificationError, 'GitHub');
    }

    const encrypted = encryptToken(token.trim());

    // Links were validated under the previous credential, so replacing a PAT
    // invalidates them even when the GitHub username is unchanged.
    await db.transaction(async transactionDb => {
      await transactionDb.query('DELETE FROM github_action_integrations WHERE connection_user_id = $1', [userId]);
      await transactionDb.query('DELETE FROM github_repo_links WHERE user_id = $1', [userId]);
      await transactionDb.query(
        `INSERT INTO github_connections (user_id, github_username, token_hash, token_type)
         VALUES ($1, $2, $3, 'pat')
         ON CONFLICT (user_id) DO UPDATE SET
           github_username = EXCLUDED.github_username,
           token_hash      = EXCLUDED.token_hash,
           token_type      = 'pat',
           updated_at      = NOW()`,
        [userId, ghUser.login, encrypted]
      );
    });

    res.json({ success: true, username: ghUser.login });
  } catch (err) {
    console.error('[AI] connect-pat error:', err.message);
    res.status(500).json({ error: 'Failed to connect GitHub account' });
  }
});

/**
 * PATCH /api/ai/github/settings
 * Body: { autoCommit }
 * Update GitHub PR preferences without changing the token.
 */
router.patch('/github/settings', async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;
    const { autoCommit } = req.body;

    const updates = [];
    const values  = [];
    let idx = 1;


    if (autoCommit !== undefined) {
      updates.push(`auto_commit = $${idx++}`);
      values.push(autoCommit ? 1 : 0);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

    values.push(userId);
    await db.query(
      `UPDATE github_connections SET ${updates.join(', ')}, updated_at = NOW() WHERE user_id = $${idx}`,
      values
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[AI] settings error:', err.message);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

/**
 * DELETE /api/ai/github/disconnect
 * Removes the GitHub connection (token deleted).
 */
router.delete('/github/disconnect', async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;
    await db.transaction(async transactionDb => {
      await transactionDb.query('DELETE FROM github_repo_links WHERE user_id = $1', [userId]);
      await transactionDb.query('DELETE FROM github_connections WHERE user_id = $1', [userId]);
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[AI] disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect GitHub' });
  }
});

// ─── GitHub Repos ─────────────────────────────────────────────────────────────

/**
 * GET /api/ai/repos
 * List GitHub repos available to the authenticated user.
 */
router.get('/repos', async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;

    const conn = await getUserGithubToken(db, userId);
    if (!conn) return res.status(400).json({ error: 'No GitHub account connected' });

    const repos = await githubService.listRepos(conn.token, { allPages: true });
    res.json({ repos });
  } catch (err) {
    console.error('[AI] list repos error:', err.code || err.name);
    sendExternalApiError(res, err, 'GitHub');
  }
});

/**
 * GET /api/ai/repos/:owner/:repo/branches
 */
router.get('/repos/:owner/:repo/branches', async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;

    const conn = await getUserGithubToken(db, userId);
    if (!conn) return res.status(400).json({ error: 'No GitHub account connected' });

    const branches = await githubService.listBranches(conn.token, req.params.owner, req.params.repo);
    res.json({ branches });
  } catch (err) {
    console.error('[AI] list branches error:', err.code || err.name);
    sendExternalApiError(res, err, 'GitHub');
  }
});

// ─── GitHub repository operations (exact-server scoped) ─────────────────────

async function requireServerGithubContext(req, res) {
  const context = await getServerGithubContext(
    req.app.locals.db,
    req.user.id,
    req.params.platformServerId
  );
  if (!context) {
    res.status(404).json({ success: false, error: 'No GitHub repository is linked to this server' });
    return null;
  }
  return context;
}

router.get('/server/:platformServerId/github/repository', async (req, res) => {
  try {
    const context = await requireServerGithubContext(req, res);
    if (!context) return;
    const repository = await githubService.getRepository(context.token, context.owner, context.repo);
    res.json({ success: true, repository, branch: context.branch, basePath: context.basePath });
  } catch (err) {
    sendExternalApiError(res, err, 'GitHub');
  }
});

router.get('/server/:platformServerId/github/commits', async (req, res) => {
  try {
    const context = await requireServerGithubContext(req, res);
    if (!context) return;
    const commits = await githubService.listCommits(context.token, context.owner, context.repo, {
      branch: context.branch,
      page: req.query.page,
      perPage: req.query.perPage,
    });
    res.json({ success: true, commits });
  } catch (err) {
    sendExternalApiError(res, err, 'GitHub');
  }
});

router.get('/server/:platformServerId/github/releases', async (req, res) => {
  try {
    const context = await requireServerGithubContext(req, res);
    if (!context) return;
    const releases = await githubService.listReleases(context.token, context.owner, context.repo, req.query);
    res.json({ success: true, releases });
  } catch (err) {
    sendExternalApiError(res, err, 'GitHub');
  }
});

router.get('/server/:platformServerId/github/workflows', async (req, res) => {
  try {
    const context = await requireServerGithubContext(req, res);
    if (!context) return;
    const workflows = await githubService.listWorkflows(context.token, context.owner, context.repo, req.query);
    res.json({ success: true, workflows });
  } catch (err) {
    sendExternalApiError(res, err, 'GitHub');
  }
});

router.get('/server/:platformServerId/github/workflows/:workflowId/runs', async (req, res) => {
  try {
    const context = await requireServerGithubContext(req, res);
    if (!context) return;
    const runs = await githubService.listWorkflowRuns(
      context.token,
      context.owner,
      context.repo,
      req.params.workflowId,
      { ...req.query, branch: req.query.branch || context.branch }
    );
    res.json({ success: true, runs });
  } catch (err) {
    sendExternalApiError(res, err, 'GitHub');
  }
});

router.get('/server/:platformServerId/github/integration', async (req, res) => {
  try {
    const context = await getServerActionsContext(
      req.app.locals.db,
      req.platformServerAccess.serverId,
      req.platformServerAccess.guildId
    );
    if (!context) {
      return res.json({ success: true, installed: false, status: 'not_installed', repository: null });
    }
    try {
      const integration = await inspectGitHubActionsIntegration({
        github: githubService,
        ...context,
        expectedServerId: req.platformServerAccess.platformServerId,
      });
      return res.json({ success: true, ...integration });
    } catch (error) {
      if (/integration manifest|manifest server ID|Unsupported integration/.test(error.message)) {
        return res.status(422).json({
          success: false,
          installed: true,
          status: 'invalid',
          error: error.message,
        });
      }
      throw error;
    }
  } catch (err) {
    return sendExternalApiError(res, err, 'GitHub');
  }
});

// ─── Repo Links (per server) ──────────────────────────────────────────────────

/**
 * GET /api/ai/server/:platformServerId/repo
 * Get the repo link for a server (if any).
 */
router.get('/server/:platformServerId/repo', async (req, res) => {
  try {
    const db       = req.app.locals.db;
    const userId   = req.user.id;
    const serverId = await resolveServerId(db, req.params.platformServerId);
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const row = await db.get(
      `SELECT repo_owner, repo_name, branch, base_path FROM github_repo_links
       WHERE server_id = $1 AND user_id = $2`,
      [serverId, userId]
    );

    res.json(row || null);
  } catch (err) {
    console.error('[AI] get repo link error:', err.message);
    res.status(500).json({ error: 'Failed to get repo link' });
  }
});

/**
 * POST /api/ai/server/:platformServerId/repo
 * Body: { repoOwner, repoName, branch, basePath }
 * Link (or update) a GitHub repo to this server.
 */
router.post('/server/:platformServerId/repo', async (req, res) => {
  try {
    const db       = req.app.locals.db;
    const userId   = req.user.id;
    const serverId = await resolveServerId(db, req.params.platformServerId);
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const { repoOwner, repoName, branch = 'main', basePath = '/' } = req.body;
    if (!repoOwner || !repoName) {
      return res.status(400).json({ error: 'repoOwner and repoName are required' });
    }
    if (typeof basePath !== 'string' || basePath.split('/').includes('..')) {
      return res.status(400).json({ error: 'basePath must be a repository-relative path' });
    }

    const conn = await getUserGithubToken(db, userId);
    if (!conn) return res.status(400).json({ error: 'No GitHub account connected' });
    await githubService.getRepository(conn.token, repoOwner, repoName);
    const branches = await githubService.listBranches(conn.token, repoOwner, repoName);
    if (!branches.includes(branch)) {
      return res.status(400).json({ error: 'Selected GitHub branch does not exist' });
    }

    await db.transaction(async transactionDb => {
      await transactionDb.query(
        `INSERT INTO github_repo_links (server_id, user_id, repo_owner, repo_name, branch, base_path)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (server_id, user_id) DO UPDATE SET
           repo_owner = EXCLUDED.repo_owner,
           repo_name  = EXCLUDED.repo_name,
           branch     = EXCLUDED.branch,
           base_path  = EXCLUDED.base_path`,
        [serverId, userId, repoOwner, repoName, branch, basePath]
      );
      await transactionDb.query(
        `INSERT INTO github_action_integrations
           (server_id, connection_user_id, repo_owner, repo_name, branch)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (server_id) DO UPDATE SET
           connection_user_id = EXCLUDED.connection_user_id,
           repo_owner = EXCLUDED.repo_owner,
           repo_name = EXCLUDED.repo_name,
           branch = EXCLUDED.branch,
           updated_at = NOW()`,
        [serverId, userId, repoOwner, repoName, branch]
      );
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[AI] set repo link error:', err.message);
    sendExternalApiError(res, err, 'GitHub');
  }
});

/**
 * DELETE /api/ai/server/:platformServerId/repo
 * Remove the repo link for this server.
 */
router.delete('/server/:platformServerId/repo', async (req, res) => {
  try {
    const db       = req.app.locals.db;
    const userId   = req.user.id;
    const serverId = await resolveServerId(db, req.params.platformServerId);
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    await db.transaction(async transactionDb => {
      await transactionDb.query(
        'DELETE FROM github_action_integrations WHERE server_id = $1 AND connection_user_id = $2',
        [serverId, userId]
      );
      await transactionDb.query(
        'DELETE FROM github_repo_links WHERE server_id = $1 AND user_id = $2',
        [serverId, userId]
      );
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[AI] delete repo link error:', err.message);
    res.status(500).json({ error: 'Failed to unlink repo' });
  }
});

// ─── Server Context (for display) ────────────────────────────────────────────

/**
 * GET /api/ai/context/:platformServerId
 * Returns the text context block the AI sees about this server.
 * Used by the frontend to show "What the AI knows" in the chat sidebar.
 */
router.get('/context/:platformServerId', async (req, res) => {
  try {
    const db       = req.app.locals.db;
    const serverId = req.platformServerAccess.serverId;

    const context = await aiService.buildServerContext(db, serverId);
    res.json({ context });
  } catch (err) {
    console.error('[AI] context error:', err.message);
    res.status(500).json({ error: 'Failed to build context' });
  }
});

// ─── Log Intelligence (RPT / ADM / server.log) ───────────────────────────────
//
// These routes summarize the ingested DayZ log files for the exact server the
// caller is authorized for (via ensureAiServerManage -> per-server SERVER_MANAGE,
// wired through router.param('platformServerId') above). The deterministic
// extraction/clustering is computed from the real files; the optional AI layer
// only ever sees a bounded, grounded digest of that computed data, so answers
// are anchored to ingested data rather than a hallucination.
//
// No hard input cap: the AI layers pass a compact digest of real ingested data
// to the provider. All AI calls go through the provider resolver (per-user key
// > Copilot > shared router > operator key) and respect the shared-router
// daily quota.

/** Parse an investigation instant from ?at= / body.atMs (ISO or epoch ms). */
function parseMomentAt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * GET /api/ai/log-summary/:platformServerId
 * Deterministic RPT error summarizer: per crash/restart window, clusters
 * exceptions, returns top root-cause candidates, CE-Loop tick stats and the
 * repeated warning offenders. Pure computation — no AI call, no quota.
 */
router.get('/log-summary/:platformServerId', async (req, res) => {
  try {
    const serverId = req.platformServerAccess.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });
    const configDir = resolveServerConfigDir(req);
    if (!configDir) {
      return res.status(404).json({ error: 'No ingested RPT/ADM data for this server yet' });
    }
    const summary = logIntelligenceService.summarizeRptErrors(logIntelligenceService.defaultDeps(configDir));
    res.json({ serverId, configDir, summary });
  } catch (err) {
    console.error('[AI] log-summary error:', err.code || err.message);
    sendExternalApiError(res, err, 'AI');
  }
});

/**
 * POST /api/ai/log-summary/:platformServerId/explain
 * Body: { question? } — grounded AI prose on the deterministic summary.
 * Optional AI: when no provider is configured the deterministic summary is
 * still returned and the explanation is null. Shared-router calls consume the
 * per-user daily budget.
 */
router.post('/log-summary/:platformServerId/explain', async (req, res) => {
  try {
    const serverId = req.platformServerAccess.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });
    const configDir = resolveServerConfigDir(req);
    if (!configDir) {
      return res.status(404).json({ error: 'No ingested RPT/ADM data for this server yet' });
    }
    const question = typeof req.body?.question === 'string' && req.body.question.trim()
      ? req.body.question.trim().slice(0, 4000)
      : 'Summarize this server recent errors, warnings and likely root causes.';

    const summary = logIntelligenceService.summarizeRptErrors(logIntelligenceService.defaultDeps(configDir));
    const provider = await prepareAiProvider(req);
    let aiExplanation = null;
    if (provider) {
      try {
        aiExplanation = await logIntelligenceService.explainWithAi(provider, question, summary, null);
      } catch (error) {
        // Deterministic summary still stands; only the prose is unavailable.
        aiExplanation = null;
        summary.aiError = error && error.message ? error.message : 'AI explanation unavailable';
      }
    }
    res.json({
      serverId,
      question,
      summary,
      aiExplanation,
      providerConfigured: Boolean(provider),
      source: provider ? provider.source : null,
    });
  } catch (err) {
    console.error('[AI] log-summary explain error:', err.code || err.message);
    sendExternalApiError(res, err, 'AI');
  }
});

/**
 * POST /api/ai/log-why/:platformServerId
 * Body: { atMs (ISO or epoch ms, required), question? }
 * "Why did it crash / lag spike at X" — correlates the RPT warnings/ticks with
 * ADM-side tick telemetry and session/death activity around that moment. AI
 * prose is grounded in the assembled evidence. Shared-router calls consume the
 * per-user daily budget.
 */
router.post('/log-why/:platformServerId', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const serverId = req.platformServerAccess.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });
    const configDir = resolveServerConfigDir(req);
    if (!configDir) {
      return res.status(404).json({ error: 'No ingested RPT/ADM data for this server yet' });
    }
    const atMs = parseMomentAt(req.body?.atMs);
    if (atMs === null) {
      return res.status(400).json({ error: 'atMs is required (an ISO timestamp or epoch milliseconds)' });
    }
    if (atMs < 946684800000 || atMs > 4102444800000) {
      return res.status(400).json({ error: 'atMs is outside a sane range' });
    }
    const question = typeof req.body?.question === 'string' && req.body.question.trim()
      ? req.body.question.trim().slice(0, 4000)
      : 'Why did the server crash or lag spike at this time?';

    const deps = logIntelligenceService.defaultDeps(configDir);
    deps.db = db;
    deps.serverId = serverId;
    deps.atMs = atMs;

    const provider = await prepareAiProvider(req);
    const analysis = await logIntelligenceService.analyzeMoment(deps, provider, question);
    res.json({
      serverId,
      at: new Date(atMs).toISOString(),
      analysis,
      providerConfigured: Boolean(provider),
      source: provider ? provider.source : null,
    });
  } catch (err) {
    console.error('[AI] log-why error:', err.code || err.message);
    sendExternalApiError(res, err, 'AI');
  }
});

// ─── Ops intelligence (AI feature 7/7): predictive, remediation, rollback ───
//
// All three capabilities are DETERMINISTIC: detection is pure pattern-matching
// / metric comparison against the ingested RPT/ADM + CE-Loop telemetry. The AI
// provider (if configured) only writes human explanation prose and is NEVER
// required for detection — a missing provider still returns the full
// deterministic picture. Shared-router calls consume the per-user daily quota
// via prepareAiProvider, mirroring the log-intelligence routes.
//
// Restore is never done here: the rollback advisor only *advises* and points
// at the existing /mission-files/.../restore endpoint (authorization unchanged).

const {
  readWorkingCopyFile: opsReadWorkingCopyFile,
  discoverWorkingCopyFiles: opsDiscoverWorkingCopyFiles,
} = require('../services/missionFileInspectionService');

/**
 * Resolve the server's working-copy root (the mission dir that holds the .xml/
 * .json config files), or null when no mission copy is ingested yet.
 * @returns {string|null}
 */
function resolveServerWorkingCopyRoot(req) {
  const access = req.platformServerAccess || {};
  if (!access.discordGuildId || !access.platformServerId) return null;
  let serverRoot;
  try {
    serverRoot = getGuildDownloadPath(access.discordGuildId, access.platformServerId);
  } catch (_error) {
    return null;
  }
  // The working-copy mission dir is dayzOffline.<map> under the server root.
  let entries;
  try {
    entries = fs.readdirSync(serverRoot, { withFileTypes: true });
  } catch (_error) {
    return null;
  }
  const missionDirs = entries
    .filter(e => e.isDirectory() && /^dayzOffline\./i.test(e.name))
    .map(e => e.name)
    .sort();
  if (!missionDirs.length) return null;
  // Prefer the map the caller named (query.map / body.map), else the first.
  const currentMap = req.body?.map || req.query.map;
  if (currentMap) {
    const wanted = missionDirs.find(d => d.toLowerCase().endsWith(String(currentMap).toLowerCase()));
    if (wanted) return path.join(serverRoot, wanted);
  }
  return path.join(serverRoot, missionDirs[0]);
}

/** Read the named working-copy file (contained, bounded) as text or null. */
function readWorkingCopyText(root, fileName) {
  try {
    const r = opsReadWorkingCopyFile(root, fileName);
    return typeof r.content === 'string' ? r.content : null;
  } catch (_error) {
    return null;
  }
}

/** List the working-copy file paths (relative) for patch-backed suggestions. */
function listWorkingCopyFiles(root) {
  try {
    const { files } = opsDiscoverWorkingCopyFiles(root);
    return Object.keys(files || {});
  } catch (_error) {
    return [];
  }
}

/**
 * GET /api/ai/ops-intelligence/:platformServerId
 * Deterministic ops picture for the dashboard server panel:
 *   - active predictive crash/lag precursors (+ whether each preceded this
 *     server's own prior crash), persisted idempotently to ops_warnings;
 *   - CE Loop tick stats;
 *   - last crash time + recent crash windows.
 * Detection is deterministic; no AI, no quota. `?explain=true` adds an
 * optional grounded AI prose summary (provider-gated, never required).
 */
router.get('/ops-intelligence/:platformServerId', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const serverId = req.platformServerAccess?.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const configDir = resolveServerConfigDir(req);
    const detection = configDir
      ? opsIntelligenceService.detectPredictiveWarnings(logIntelligenceService.defaultDeps(configDir))
      : { precursors: [], crashWindows: [], lastCrashAt: null, warnings: [], ceLoop: null };

    const persisted = configDir ? await opsIntelligenceService.persistWarnings(db, serverId, detection) : [];
    const summary = opsIntelligenceService.warningSummary(detection, persisted);

    let aiExplanation = null;
    let source = null;
    if (req.query.explain === 'true') {
      const provider = await prepareAiProvider(req);
      if (provider) {
        try {
          const digest = [
            'Ops intelligence summary (real ingested data, deterministic):',
            `Last crash: ${summary.lastCrashAt || 'none in the 24h window'}`,
            `Recent crash windows: ${summary.recentCrashCount}`,
            summary.ceLoop
              ? `CE Loop ticks: ${summary.ceLoop.samples} samples, avg ${summary.ceLoop.avgSeconds}s, max ${summary.ceLoop.maxSeconds}s, ${summary.ceLoop.slowSamples} slow(>=2s)`
              : 'CE Loop ticks: no samples in window',
            ...summary.activeWarnings.map(w =>
              `- [${w.severity}] ${w.label}: ${w.occurrences}x; last crash it preceded: ${w.lastCrashPreceded ? new Date(w.lastCrashPreceded.at).toISOString() : 'n/a'}`),
            '',
            'Summarize the current ops risk for this server in a couple of sentences.',
          ].filter(Boolean).join('\n');
          const aiService = require('../services/aiService');
          aiExplanation = await aiService.callProvider([
            { role: 'system', content: 'You are an operations advisor for a DayZ dedicated server. Answer ONLY from the grounded data provided; never invent metrics.' },
            { role: 'user', content: digest },
          ], 0.2, provider);
          source = provider.source;
        } catch (_error) {
          aiExplanation = null; // deterministic picture still stands
        }
      }
    }

    res.json({
      serverId,
      summary,
      aiExplanation,
      source,
      providerConfigured: source !== null,
    });
  } catch (err) {
    console.error('[AI] ops-intelligence error:', err.code || err.message);
    sendExternalApiError(res, err, 'AI');
  }
});

/**
 * POST /api/ai/ops-remediation/:platformServerId
 * Deterministic lag-cause analysis -> patch-backed config suggestions.
 * Detection (CE Loop tick duration, entity counts, recent crash windows) is
 * deterministic from ingested data; every suggested change is validated
 * all-or-nothing by the patch engine and stored as a reviewable suggestion
 * group — NEVER auto-applied. With a provider the suggestion prose can be
 * enriched; without one the deterministic explanation is used.
 *
 * Body: { files?: [{filename, fileContent}] } — optionally supply the working
 * copies to patch against; when omitted, patchable files are read from the
 * server's working copy automatically.
 */
router.post('/ops-remediation/:platformServerId', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const userId = req.user.id;
    const serverId = req.platformServerAccess?.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const configDir = resolveServerConfigDir(req);
    const filesystem = configDir
      ? logIntelligenceService.defaultDeps(configDir)
      : null;
    const analysis = await opsIntelligenceService.analyzeLagCauses({
      db, serverId, filesystem,
    });

    // Gather the working-copy files to patch against (caller-supplied or read
    // from disk). Only .xml/.json are patchable.
    let files = Array.isArray(req.body?.files) ? req.body.files : null;
    if (!files || files.length === 0) {
      const root = resolveServerWorkingCopyRoot(req);
      if (root) {
        files = listWorkingCopyFiles(root)
          .filter(f => /\.(xml|json)$/i.test(f))
          .slice(0, 20)
          .map(f => ({ filename: f, fileContent: readWorkingCopyText(root, f) }))
          .filter(f => typeof f.fileContent === 'string' && f.fileContent.trim());
      } else {
        files = [];
      }
    }

    const suggestions = opsIntelligenceService.planLagSuggestions(
      analysis,
      files.map(f => ({ filename: f.filename, content: f.fileContent })),
    );

    let groupId = null;
    let saved = [];
    if (suggestions.length) {
      // Re-validate every patch against the real working-copy bytes BEFORE
      // anything is stored (all-or-nothing, mirroring /config-edit).
      const revalidated = [];
      const byFile = new Map(files.map(f => [f.filename, f.fileContent]));
      for (const s of suggestions) {
        try {
          const applied = patchEngine.applyPatch(s.filename, byFile.get(s.filename) ?? s.originalContent, s.patch);
          revalidated.push({ ...s, suggestedContent: applied.content });
        } catch (_error) {
          // invalid/obsolete patch (file changed since analysis) — skip it
        }
      }
      if (revalidated.length) {
        const saveResult = await saveSuggestionGroup(db, serverId, userId, {
          kind: 'ops-remediation',
          goal: `Deterministic lag remediation: ${analysis.causes.map(c => c.id).join(', ')}`,
          suggestions: revalidated,
        });
        groupId = saveResult.groupId;
        saved = saveResult.suggestions;
      }
    }

    res.json({
      success: true,
      serverId,
      analysis,
      suggestionCount: suggestions.length,
      savedCount: saved.length,
      groupId,
      suggestions: saved,
      applyHint: 'Suggestions never auto-apply — review them, then POST /api/ai/suggestions/:suggestionId/apply',
    });
  } catch (err) {
    console.error('[AI] ops-remediation error:', err.code || err.message);
    sendExternalApiError(res, err, 'AI');
  }
});

/**
 * GET /api/ai/ops-rollback/:platformServerId
 * Rollback advisor: compare the tick/perf + crash metrics before vs. after
 * each of the server's recent config edits (the mission-files backup chain).
 * Flags edits that degraded the server ("your edit at <time> degraded TPS ~X%
 * — restore this version?"). Restore is left to the existing
 * /mission-files/.../restore endpoint (authorization unchanged); this route
 * only advises. Fully deterministic — no AI, no quota.
 *
 * Query: ?windowHours=2 (default), ?maxBackups=8 (default)
 */
router.get('/ops-rollback/:platformServerId', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const serverId = req.platformServerAccess?.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });
    const psid = req.platformServerAccess.platformServerId;

    const windowHours = Math.max(0.5, Math.min(24, Number(req.query.windowHours) || 2));
    const maxBackups = Math.max(2, Math.min(50, Number(req.query.maxBackups) || 8));

    const backupRoot = path.join(__dirname, '..', 'data', 'backups');
    const groups = opsIntelligenceService.collectBackupGroups(backupRoot, psid);
    const results = await opsIntelligenceService.adviseRollbacks(db, serverId, groups, { windowHours, maxBackups });

    // Human-facing headline for the top degraded edit, if any.
    const top = results.find(r => r.worstEdit?.degraded)?.worstEdit || null;
    res.json({
      serverId,
      filesAnalyzed: results.length,
      backupFiles: (groups._allFiles || []).length,
      results,
      headline: top ? {
        fileName: results.find(r => r.worstEdit?.degraded)?.fileName,
        editAt: top.at,
        deltaPct: top.deltaPct,
        backupFile: top.backupFile,
        message: `Your edit to ${results.find(r => r.worstEdit?.degraded)?.fileName} at ${top.at} degraded tick time ~${Math.abs(top.deltaPct)}%. Consider restoring ${top.backupFile} via the existing restore endpoint.`,
      } : null,
    });
  } catch (err) {
    console.error('[AI] ops-rollback error:', err.code || err.message);
    sendExternalApiError(res, err, 'AI');
  }
});

// ─── Config intelligence (multi-file edits, balance pass, validation) ────────
//
// Patch-style AI editing for config working copies. The provider output cap in
// aiService (~40k chars) cannot round-trip large files (types.xml is ~745KB),
// so these routes never ask for full-file replacements: the provider returns
// small per-file patches (aiConfigPatchService: xml-search-replace /
// json-merge) which are validated all-or-nothing against the real working-copy
// bytes BEFORE anything is stored. A multi-file request or balance pass is
// persisted as one linked suggestion group (ai_suggestion_groups anchor row +
// per-file rows sharing group_id); per-suggestion apply keeps the existing
// claim-lease / atomic status machinery unchanged.
// All AI routes below share the provider resolver + shared-router quota path
// (prepareAiProvider), mirroring /chat, /analyze and the log-intelligence
// routes. Deterministic layers (validation report, diff-explain fallback) work
// with no provider configured.

/**
 * Persist a validated plan as a suggestion group: one anchor row plus one
 * ai_suggestions row per file. diff_explanation is deterministic at creation
 * time (zero extra provider calls); the on-demand diff-explain route upgrades
 * it to AI prose when a provider is available.
 */
async function saveSuggestionGroup(db, serverId, userId, { kind, goal, suggestions }) {
  const groupRows = await db.query(
    `INSERT INTO ai_suggestion_groups (server_id, user_id, kind, goal, file_count)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [serverId, userId, kind, goal || null, suggestions.length]
  );
  const groupId = groupRows[0]?.id || null;
  const saved = [];
  for (const suggestion of suggestions) {
    const diffExplanation = configIntelligenceService.deterministicDiffExplanation(suggestion);
    const rows = await db.query(
      `INSERT INTO ai_suggestions
         (server_id, user_id, filename, trigger_type, explanation, original_content, suggested_content,
          diff_summary, group_id, patch, base_content_hash, diff_explanation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        serverId, userId, suggestion.filename,
        kind === 'balance' ? 'balance-pass' : 'multi-file',
        suggestion.explanation, suggestion.originalContent, suggestion.suggestedContent,
        suggestion.diffSummary.summary, groupId,
        JSON.stringify(suggestion.patch), suggestion.baseContentHash, diffExplanation,
      ]
    );
    saved.push({
      id: rows[0]?.id || null,
      filename: suggestion.filename,
      explanation: suggestion.explanation,
      diff_summary: suggestion.diffSummary.summary,
      diff_explanation: diffExplanation,
      group_id: groupId,
    });
  }
  return { groupId, suggestions: saved };
}

/**
 * POST /api/ai/config-edit
 * Body: { platformServerId, instruction, files: [{filename, fileContent}] }
 * Multi-file / cross-file edit: one request names an ordered list of working
 * copies (up to 5); the provider returns one patch per file; every patch is
 * validated independently (unique search span, well-formed result) and stored
 * as a linked suggestion group. All-or-nothing: any invalid patch rejects the
 * whole request with per-file errors.
 */
router.post('/config-edit', ensureAiServerManage, async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;
    const serverId = req.platformServerAccess?.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const { instruction, files } = req.body || {};
    if (typeof instruction !== 'string' || !instruction.trim()) {
      return res.status(400).json({ error: 'instruction (a plain-English edit request) is required' });
    }
    const normalized = configIntelligenceService.normalizeFileList(files);
    const provider = await prepareAiProvider(req);
    if (!provider) return res.status(409).json({ error: 'Connect an AI provider to continue' });

    const suggestions = await configIntelligenceService.planPatchSuggestions(db, serverId, {
      instruction: instruction.trim().slice(0, 4000),
      files: normalized,
      provider,
    });
    const saved = await saveSuggestionGroup(db, serverId, userId, { kind: 'multi-file', suggestions });
    res.json({ success: true, groupId: saved.groupId, suggestions: saved.suggestions, source: provider.source });
  } catch (err) {
    console.error('[AI] config-edit error:', err.code || err.name);
    sendAiError(res, err, 'AI');
  }
});

/**
 * POST /api/ai/balance-pass
 * Body: { platformServerId, goal, files: [{filename, fileContent}] }
 * Balance pass: a plain-language goal ("make early game harder") returns 2-4
 * coordinated patch suggestions across the included files (typically
 * types.xml / events.xml / randompresets.xml), each with its own rationale.
 * Files beyond the balance cap are trimmed to the first MAX_BALANCE_FILES.
 */
router.post('/balance-pass', ensureAiServerManage, async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;
    const serverId = req.platformServerAccess?.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const { goal, files } = req.body || {};
    if (typeof goal !== 'string' || !goal.trim()) {
      return res.status(400).json({ error: 'goal (a plain-English balance goal) is required' });
    }
    let normalized = configIntelligenceService.normalizeFileList(files, {
      maxFiles: configIntelligenceService.MAX_BALANCE_FILES,
    });
    normalized = normalized.slice(0, configIntelligenceService.MAX_BALANCE_FILES);
    const provider = await prepareAiProvider(req);
    if (!provider) return res.status(409).json({ error: 'Connect an AI provider to continue' });

    const suggestions = await configIntelligenceService.planPatchSuggestions(db, serverId, {
      goal: goal.trim().slice(0, 2000),
      files: normalized,
      provider,
    });
    const saved = await saveSuggestionGroup(db, serverId, userId, { kind: 'balance', goal: goal.trim().slice(0, 2000), suggestions });
    res.json({ success: true, goal: goal.trim().slice(0, 2000), groupId: saved.groupId, suggestions: saved.suggestions, source: provider.source });
  } catch (err) {
    console.error('[AI] balance-pass error:', err.code || err.name);
    sendAiError(res, err, 'AI');
  }
});

/**
 * GET /api/ai/suggestion-groups/:platformServerId?limit=
 * List recent suggestion groups (multi-file edits / balance passes) with their
 * member suggestions, most recent first.
 */
router.get('/suggestion-groups/:platformServerId', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const serverId = await resolveServerId(db, req.params.platformServerId);
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const groups = await db.query(
      `SELECT id, kind, goal, file_count, created_at
       FROM ai_suggestion_groups
       WHERE server_id = $1 AND user_id = $2
       ORDER BY created_at DESC LIMIT $3`,
      [serverId, req.user.id, limit]
    );
    const groupsWithMembers = [];
    for (const group of groups) {
      const members = await db.query(
        `SELECT id, filename, trigger_type, explanation, diff_summary, diff_explanation, status, created_at
         FROM ai_suggestions
         WHERE group_id = $1
         ORDER BY created_at ASC`,
        [group.id]
      );
      groupsWithMembers.push({ ...group, suggestions: members });
    }
    res.json({ groups: groupsWithMembers });
  } catch (err) {
    console.error('[AI] suggestion-groups error:', err.code || err.name);
    res.status(500).json({ error: 'Failed to list suggestion groups' });
  }
});

/**
 * POST /api/ai/config-validate
 * Body: { platformServerId, filename, fileContent, question? }
 * Deterministic config validation (known-good schema + DayZ invariants, on top
 * of the CE-registration typing) plus an optional plain-language AI
 * explanation of the findings. Works with no provider (aiExplanation null);
 * a configured provider consumes the shared-router quota as usual.
 */
router.post('/config-validate', ensureAiServerManage, async (req, res) => {
  try {
    const serverId = req.platformServerAccess?.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const { filename, fileContent, question } = req.body || {};
    if (typeof filename !== 'string' || !filename.trim()) {
      return res.status(400).json({ error: 'filename is required' });
    }
    if (typeof fileContent !== 'string' || !fileContent.trim()) {
      return res.status(400).json({ error: 'complete fileContent is required' });
    }
    const trimmedQuestion = typeof question === 'string' && question.trim() ? question.trim().slice(0, 4000) : null;
    const provider = await prepareAiProvider(req); // null is fine: deterministic report still stands
    const result = await configIntelligenceService.validateAndExplain({
      filename,
      content: fileContent,
      provider,
      question: trimmedQuestion,
    });
    res.json({
      success: true,
      filename,
      valid: result.valid,
      documentType: result.documentType,
      findings: result.findings,
      aiExplanation: result.aiExplanation,
      providerConfigured: Boolean(provider),
      source: provider ? provider.source : null,
    });
  } catch (err) {
    console.error('[AI] config-validate error:', err.code || err.name);
    sendAiError(res, err, 'AI');
  }
});

// ─── AI Chat ──────────────────────────────────────────────────────────────────

/**
 * POST /api/ai/chat
 * Body: { platformServerId, filename, fileContent, message, clearHistory? }
 *
 * Sends a message to the AI with the file as context.
 * Maintains per-user per-file chat history in the DB.
 * Returns { reply, editedContent? }
 */
router.post('/chat', ensureAiServerManage, async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;

    const { filename, fileContent, message, clearHistory } = req.body;
    if (!filename || typeof fileContent !== 'string' || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'platformServerId, filename, complete fileContent, and message are required' });
    }
    if (message.length > MAX_CHAT_MESSAGE_CHARS) {
      return res.status(400).json({ error: `message must be ${MAX_CHAT_MESSAGE_CHARS} characters or fewer` });
    }
    // No hard input cap: the full working copy goes to the provider. The
    // working-copy read endpoint already bounds files (5MB), and the provider
    // context window is the natural ceiling. Replacement *output* remains
    // validated by assertValidReplacement below.

    const serverId = req.platformServerAccess.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    // Load or clear chat history for this file
    let history = [];
    if (!clearHistory) {
      const sessionRow = await db.get(
        'SELECT messages FROM ai_chat_sessions WHERE user_id = $1 AND server_id = $2 AND filename = $3',
        [userId, serverId, filename]
      );
      if (sessionRow?.messages) {
        try { history = withoutLegacyFileContext(boundChatHistory(JSON.parse(sessionRow.messages))); } catch (_) { history = []; }
      }
    }

    // Append the user's message
    history.push({ role: 'user', content: message });
    const fileContext = buildCurrentFileContext(filename, fileContent);
    const historyBudget = Math.max(
      MAX_CHAT_MESSAGE_CHARS + 256,
      MAX_CHAT_HISTORY_CHARS - JSON.stringify(fileContext).length - 256
    );
    history = boundChatHistory(history, historyBudget);
    const providerHistory = [...fileContext, ...history];

    // Build server context for the system prompt
    const serverContext = await aiService.buildServerContext(db, serverId);
    const provider = await aiProviderService.resolveUserProvider(db, userId);
    if (!provider) return res.status(409).json({ error: 'Connect an AI provider to continue' });
    if (provider.source === 'shared-router') {
      await aiSharedRouterService.consumeCall(db, userId); // throws 429 when over budget
    }

    // Call the AI
    const reply = await aiService.chat(providerHistory, serverContext, provider);

    // Append the AI reply to history
    history.push({ role: 'assistant', content: reply });
    history = boundChatHistory(history);

    // Persist updated history
    await db.query(
      `INSERT INTO ai_chat_sessions (user_id, server_id, filename, messages, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, server_id, filename) DO UPDATE SET
         messages   = EXCLUDED.messages,
         updated_at = NOW()`,
      [userId, serverId, filename, JSON.stringify(history)]
    );

    // If the reply contains a fenced code block, extract it as editedContent
    const fenceMatch = reply.match(/```(?:xml|json)?\n([\s\S]*?)```/);
    const editedContent = fenceMatch ? aiService.assertValidReplacement(filename, fenceMatch[1].trim()) : null;
    let suggestionId = null;
    if (editedContent && fileContent && editedContent !== fileContent) {
      const inserted = await db.query(
        `INSERT INTO ai_suggestions
           (server_id, user_id, filename, trigger_type, explanation, original_content, suggested_content, diff_summary)
         VALUES ($1, $2, $3, 'chat', $4, $5, $6, $7)
         RETURNING id`,
        [serverId, userId, filename, message.slice(0, 1000), fileContent, editedContent, 'AI chat edit']
      );
      suggestionId = inserted[0]?.id || null;
    }

    res.json({ reply, editedContent, suggestionId });
  } catch (err) {
    console.error('[AI] chat error:', err.code || err.name);
    sendExternalApiError(res, err, 'AI');
  }
});

/**
 * DELETE /api/ai/chat/history
 * Body: { platformServerId, filename }
 * Clear chat history for a specific file.
 */
router.delete('/chat/history', ensureAiServerManage, async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;
    const { filename } = req.body;

    const serverId = req.platformServerAccess.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    await db.query(
      'DELETE FROM ai_chat_sessions WHERE user_id = $1 AND server_id = $2 AND filename = $3',
      [userId, serverId, filename]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[AI] clear history error:', err.message);
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

// ─── Analysis (data-driven suggestions) ──────────────────────────────────────

/**
 * POST /api/ai/analyze
 * Body: { platformServerId, filename, fileContent }
 *
 * Analyzes a config file using real server data (kills, loot, players)
 * and stores up to 3 suggestions in the ai_suggestions table.
 */
router.post('/analyze', ensureAiServerManage, async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;
    const { filename, fileContent } = req.body;

    if (!filename || !fileContent) {
      return res.status(400).json({ error: 'platformServerId, filename, and fileContent are required' });
    }
    // No hard input cap: the full working copy goes to the provider (see
    // /chat). Suggestion output is still validated as a complete replacement.

    const serverId = req.platformServerAccess.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const provider = await aiProviderService.resolveUserProvider(db, userId);
    if (!provider) return res.status(409).json({ error: 'Connect an AI provider to continue' });
    if (provider.source === 'shared-router') {
      await aiSharedRouterService.consumeCall(db, userId); // throws 429 when over budget
    }
    const suggestions = await aiService.analyzeFile(db, serverId, filename, fileContent, provider);

    // Persist each suggestion
    const inserted = [];
    for (const s of suggestions) {
      const rows = await db.query(
        `INSERT INTO ai_suggestions
           (server_id, user_id, filename, trigger_type, explanation, original_content, suggested_content, diff_summary)
         VALUES ($1, $2, $3, 'manual', $4, $5, $6, $7)
         RETURNING id`,
        [serverId, userId, s.filename, s.explanation, fileContent, s.suggestedContent, s.diffSummary]
      );
      inserted.push({ id: rows[0]?.id, ...s });
    }

    res.json({ suggestions: inserted });
  } catch (err) {
    console.error('[AI] analyze error:', err.code || err.name);
    sendExternalApiError(res, err, 'AI');
  }
});

// ─── Suggestions CRUD ────────────────────────────────────────────────────────

/**
 * GET /api/ai/suggestions/:platformServerId
 * List pending (and recently resolved) suggestions for a server.
 */
router.get('/suggestions/:platformServerId', async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;

    const serverId = await resolveServerId(db, req.params.platformServerId);
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const rows = await db.query(
      `SELECT id, filename, trigger_type, explanation, diff_summary, diff_explanation, group_id, status, github_pr_url, created_at, applied_at
       FROM ai_suggestions
       WHERE server_id = $1 AND user_id = $2
       ORDER BY created_at DESC LIMIT 50`,
      [serverId, userId]
    );

    res.json({ suggestions: rows });
  } catch (err) {
    console.error('[AI] list suggestions error:', err.message);
    res.status(500).json({ error: 'Failed to list suggestions' });
  }
});

/**
 * GET /api/ai/suggestions/detail/:suggestionId
 * Get a suggestion including full original + suggested content (for diff view).
 */
router.get('/suggestions/detail/:suggestionId', async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const row = await getAuthorizedSuggestion(db, req.user, req.params.suggestionId);

    if (!row) return res.status(404).json({ error: 'Suggestion not found' });
    res.json(row);
  } catch (err) {
    console.error('[AI] suggestion detail error:', err.message);
    res.status(500).json({ error: 'Failed to get suggestion' });
  }
});

/**
 * POST /api/ai/suggestions/:suggestionId/diff-explain
 * Body: {}
 * Generate a fresh plain-language delta explanation for a stored suggestion
 * (AI when a provider is available; deterministic line-delta fallback
 * otherwise) and persist it on the suggestion row. Safe to call repeatedly.
 */
router.post('/suggestions/:suggestionId/diff-explain', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const suggestion = await getAuthorizedSuggestion(db, req.user, req.params.suggestionId);
    if (!suggestion) return res.status(404).json({ error: 'Suggestion not found' });

    const provider = await prepareAiProvider(req);
    const explanation = await configIntelligenceService.explainDiff({
      filename: suggestion.filename,
      explanation: suggestion.explanation,
      originalContent: suggestion.original_content,
      suggestedContent: suggestion.suggested_content,
    }, provider);

    await db.query(
      `UPDATE ai_suggestions
       SET diff_explanation = $1
       WHERE id = $2 AND user_id = $3`,
      [explanation, suggestion.id, req.user.id]
    );
    res.json({ success: true, diffExplanation: explanation, source: provider ? provider.source : null });
  } catch (err) {
    console.error('[AI] diff-explain error:', err.code || err.name);
    sendAiError(res, err, 'AI');
  }
});

/**
 * PATCH /api/ai/suggestions/:suggestionId
 * Body: { status: 'accepted' | 'rejected' }
 * Accept or reject a suggestion without applying it.
 */
router.patch('/suggestions/:suggestionId', async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const { status } = req.body;

    if (!['accepted', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be accepted or rejected' });
    }

    const suggestion = await getAuthorizedSuggestion(db, req.user, req.params.suggestionId);
    if (!suggestion) return res.status(404).json({ error: 'Suggestion not found' });

    const updatedRows = await db.query(
      `UPDATE ai_suggestions ais
       SET status = $1
       WHERE ais.id = $2 AND ais.user_id = $3 AND status IN ('pending', 'accepted')
         AND EXISTS (
           SELECT 1
           FROM servers s
           JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
           LEFT JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = $3
           LEFT JOIN server_role_assignments sra
             ON sra.server_id = s.id AND sra.guild_id = s.guild_id AND sra.user_id = $3
           WHERE s.id = ais.server_id
             AND s.status = 'active'
             AND (gr.role IN ('owner', 'admin') OR (sra.role = 'admin' AND sra.status = 'active'))
         )
       RETURNING id`,
      [status, suggestion.id, req.user.id]
    );
    if (!updatedRows.length) return res.status(409).json({ error: 'Suggestion state changed; refresh and try again' });

    res.json({ success: true });
  } catch (err) {
    console.error('[AI] patch suggestion error:', err.message);
    res.status(500).json({ error: 'Failed to update suggestion' });
  }
});

/**
 * POST /api/ai/suggestions/:suggestionId/apply
 * Body: { uploadToNitrado?: boolean }
 *
 * Applies a suggestion:
 *   1. If a GitHub repo is linked and auto_commit is on: creates a PR
 *   2. Marks suggestion as applied
 *
 * Actual Nitrado upload is handled client-side (or via missionFiles routes)
 * since file upload requires the Nitrado token which lives in the guild context.
 * This endpoint returns the suggested content for the client to upload.
 */
router.post('/suggestions/:suggestionId/apply', async (req, res) => {
  let claimedSuggestion = null;
  let externalFinalizationCompleted = false;
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;

    let suggestion = await getAuthorizedSuggestion(db, req.user, req.params.suggestionId);
    if (!suggestion) return res.status(404).json({ error: 'Suggestion not found' });
    if (!['pending', 'accepted', 'applying'].includes(suggestion.status)) {
      return res.status(400).json({ error: suggestion.status === 'applied' ? 'Already applied' : 'Suggestion cannot be finalized' });
    }

    const claimId = crypto.randomUUID();
    const claimRows = await db.query(
      `UPDATE ai_suggestions ais
       SET status = 'applying',
           application_claimed_at = NOW(),
           application_claim_id = $2,
           application_previous_status = CASE
             WHEN status IN ('pending', 'accepted') THEN status
             ELSE COALESCE(application_previous_status, 'accepted')
           END
       WHERE ais.id = $1 AND ais.user_id = $3
         AND EXISTS (
           SELECT 1
           FROM servers s
           JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
           LEFT JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = $3
           LEFT JOIN server_role_assignments sra
             ON sra.server_id = s.id AND sra.guild_id = s.guild_id AND sra.user_id = $3
           WHERE s.id = ais.server_id
             AND s.status = 'active'
             AND (gr.role IN ('owner', 'admin') OR (sra.role = 'admin' AND sra.status = 'active'))
         ) AND (
           status IN ('pending', 'accepted')
           OR (status = 'applying' AND application_claimed_at < NOW() - INTERVAL '10 minutes')
           OR (status = 'applying' AND application_claimed_at IS NULL)
         )
       RETURNING ais.id, ais.server_id, ais.filename, ais.original_content, ais.suggested_content,
                 ais.diff_summary, ais.explanation, ais.patch, ais.base_content_hash, ais.status`,
      [suggestion.id, claimId, userId]
    );
    if (!claimRows.length) return res.status(409).json({ error: 'Suggestion finalization is already in progress' });
    suggestion = claimRows[0];
    claimedSuggestion = { id: suggestion.id, claimId, db };

    // Revalidate after acquiring the lease. Two shapes:
    //
    //  Legacy full-replacement rows (no `patch` column): run the complete-file
    //  checks as before (assertValidReplacement — the 40k output cap applies).
    //
    //  Patch-style rows (config intelligence, `patch` + `base_content_hash`
    //  set): re-materialize the stored patch against the pinned `original_content`
    //  with the deterministic engine instead of trusting the stored
    //  `suggested_content`. This is the whole point of the patch design — the
    //  engine validates the search span is still unique and the result is still
    //  well-formed at apply time, so a stale or tampered patch throws a
    //  structured error rather than silently writing a corrupted file. The
    //  re-materialized content is NOT run through assertValidReplacement because
    //  its 40k cap exists to bound *provider* output, not a deterministically
    //  applied edit to a 740KB types.xml. Drift in the on-disk working copy
    //  since the suggestion was made is caught downstream by the mission-files
    //  expectedHash conflict guard when the client uploads the returned content.
    let validatedSuggestedContent;
    if (suggestion.patch) {
      let storedPatch;
      try { storedPatch = JSON.parse(suggestion.patch); }
      catch (_e) { throw patchError('PATCH_STORED_INVALID', 'Stored patch is not valid JSON'); }
      if (typeof suggestion.original_content !== 'string') {
        throw patchError('PATCH_ORIGINAL_MISSING', 'Patch suggestion is missing its original content');
      }
      // Pin the base: the patch was validated against the working copy captured
      // at suggestion time (base_content_hash). If the stored original no longer
      // hashes to that value, something rewrote it — fail closed.
      if (suggestion.base_content_hash
          && patchEngine.contentFingerprint(suggestion.original_content) !== suggestion.base_content_hash) {
        throw patchError('PATCH_BASE_DRIFT', 'The base file no longer matches the version this patch was validated against');
      }
      const rematerialized = patchEngine.applyPatch(suggestion.filename, suggestion.original_content, storedPatch);
      if (!rematerialized.content || !rematerialized.content.trim()) {
        throw patchError('PATCH_RESULT_EMPTY', 'Patch materialization produced empty content');
      }
      validatedSuggestedContent = rematerialized.content;
    } else {
      validatedSuggestedContent = aiService.assertValidReplacement(
        suggestion.filename,
        suggestion.suggested_content,
      );
    }

    let prUrl = null;

    // If auto-commit is on, attempt to create a GitHub PR
    const conn = await getUserGithubToken(db, userId);
    if (conn?.autoCommit) {
      const repoLink = await db.get(
        'SELECT * FROM github_repo_links WHERE server_id = $1 AND user_id = $2',
        [suggestion.server_id, userId]
      );
      if (repoLink) {
        const filePath = [
          repoLink.base_path.replace(/\/$/, ''),
          suggestion.filename,
        ].join('/').replace(/^\//, '');

        const result = await githubService.commitAndCreatePR(
          conn.token,
          repoLink.repo_owner,
          repoLink.repo_name,
          repoLink.branch,
          filePath,
          validatedSuggestedContent,
          `AI edit: ${suggestion.diff_summary}`,
          `[AI] ${suggestion.diff_summary}`,
          `## AI-Generated Suggestion\n\n${suggestion.explanation}\n\n*Generated by DayZ Dashboard AI Assistant*`,
          {
            branchName: `ai-edit/suggestion-${suggestion.id}`,
            expectedOriginalContent: suggestion.original_content,
          }
        );
        prUrl = result.prUrl;
        externalFinalizationCompleted = true;
      }
    }

    // Mark as applied
    const appliedRows = await db.query(
      `UPDATE ai_suggestions ais
       SET status = 'applied', applied_at = NOW(), github_pr_url = $1,
           application_claimed_at = NULL, application_claim_id = NULL,
           application_previous_status = NULL
       WHERE ais.id = $2 AND status = 'applying' AND application_claim_id = $3
         AND EXISTS (
           SELECT 1
           FROM servers s
           JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
           LEFT JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = $4
           LEFT JOIN server_role_assignments sra
             ON sra.server_id = s.id AND sra.guild_id = s.guild_id AND sra.user_id = $4
           WHERE s.id = ais.server_id
             AND s.status = 'active'
             AND (gr.role IN ('owner', 'admin') OR (sra.role = 'admin' AND sra.status = 'active'))
         )
       RETURNING id`,
      [prUrl, suggestion.id, claimId, userId]
    );
    if (!appliedRows.length) throw new Error('Suggestion finalization claim was lost');

    res.json({
      success: true,
      suggestedContent: validatedSuggestedContent,
      filename: suggestion.filename,
      prUrl,
    });
  } catch (err) {
    const canReleaseClaim = err.service !== 'GitHub' || err.category === 'conflict';
    if (claimedSuggestion && !externalFinalizationCompleted && canReleaseClaim) {
      try {
        await claimedSuggestion.db.query(
          `UPDATE ai_suggestions
           SET status = COALESCE(application_previous_status, 'accepted'),
               application_claimed_at = NULL, application_claim_id = NULL,
               application_previous_status = NULL
           WHERE id = $1 AND status = 'applying' AND application_claim_id = $2`,
          [claimedSuggestion.id, claimedSuggestion.claimId]
        );
      } catch (restoreError) {
        console.error('[AI] failed to release suggestion finalization claim:', restoreError.code || restoreError.name);
      }
    }
    console.error('[AI] finalize suggestion error:', err.code || err.name);
    if (err.service === 'GitHub') return sendExternalApiError(res, err, 'GitHub');
    // Deterministic patch-materialization failures (drift, tamper, bad stored
    // patch) carry their own .status/.code — surface them with detail instead
    // of a blanket 500. The claim was already released above.
    if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500 && typeof err.code === 'string') {
      return sendAiError(res, err, 'AI');
    }
    res.status(500).json({ error: 'Failed to finalize suggestion' });
  }
});

// ─── Data-driven tuning (AI feature 3/7) ─────────────────────────────────────
// POST /api/ai/data-tuning/:area   body: { days?, suggest?, map? }
// area: loot | weapons | deathzones | economy
//   - Deterministic report is ALWAYS computed from real server data
//     (kill_events / loot_despawn_events / economy_snapshots + the live
//     working-copy types.xml). No provider needed.
//   - With suggest=true and a provider available, the report is turned into
//     patch-backed suggestion groups (kind 'data-tuning') reusing the
//     feature-2 parse-and-materialize pipeline. Without a provider,
//     `suggestions` is null and the report stands alone.
//   - Every stored suggestion carries a one-paragraph `prediction`.

const DATA_TUNING_AREAS = ['loot', 'weapons', 'deathzones', 'economy'];

async function saveDataTuningGroup(db, serverId, userId, area, report, suggestions) {
  const groupRows = await db.query(
    `INSERT INTO ai_suggestion_groups (server_id, user_id, kind, goal, file_count)
     VALUES ($1, $2, 'data-tuning', $3, $4) RETURNING id`,
    [serverId, userId, report.summary, suggestions.length]
  );
  const groupId = groupRows[0]?.id || null;
  const saved = [];
  for (const suggestion of suggestions) {
    const diffExplanation = configIntelligenceService.deterministicDiffExplanation(suggestion);
    const rows = await db.query(
      `INSERT INTO ai_suggestions
         (server_id, user_id, filename, trigger_type, explanation, original_content, suggested_content,
          diff_summary, group_id, patch, base_content_hash, diff_explanation, prediction)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        serverId, userId, suggestion.filename,
        'data-tuning',
        suggestion.explanation, suggestion.originalContent, suggestion.suggestedContent,
        suggestion.diffSummary.summary, groupId,
        JSON.stringify(suggestion.patch), suggestion.baseContentHash,
        diffExplanation, suggestion.prediction || null,
      ]
    );
    saved.push({
      id: rows[0]?.id || null,
      filename: suggestion.filename,
      explanation: suggestion.explanation,
      diff_summary: suggestion.diffSummary.summary,
      diff_explanation: diffExplanation,
      prediction: suggestion.prediction || null,
      group_id: groupId,
    });
  }
  return { groupId, suggestions: saved };
}

function runDataTuning(area) {
  return async (req, res) => {
    try {
      const db     = req.app.locals.db;
      const userId = req.user.id;
      const serverId = req.platformServerAccess?.serverId;
      if (!serverId) return res.status(404).json({ error: 'Server not found' });
      if (!DATA_TUNING_AREAS.includes(area)) {
        return res.status(404).json({ error: `Unknown tuning area "${area}"` });
      }

      const days = Math.min(Math.max(parseInt(req.body?.days, 10) || 7, 1), dataTuningService.MAX_DAYS);

      // Resolve the working copy (only needed where the report reads config).
      let mapContext = null;
      let spawnConfig = null;
      if (area === 'loot' || area === 'economy' || area === 'weapons' || area === 'deathzones') {
        mapContext = dataTuningService.resolveMapForReport(req.platformServerAccess, req.body?.map);
        if (mapContext) spawnConfig = dataTuningService.loadSpawnConfig(mapContext.mapDir);
      }

      let report;
      if (area === 'loot')      report = await dataTuningService.lootReport(db, serverId, days, spawnConfig);
      else if (area === 'weapons') report = await dataTuningService.weaponReport(db, serverId, days);
      else if (area === 'deathzones') report = await dataTuningService.deathzoneReport(db, serverId, days);
      else report = await dataTuningService.economyReport(db, serverId, spawnConfig);
      report.map = mapContext ? mapContext.mapName : null;

      const wantSuggest = req.body?.suggest === true;
      let suggestions = null;
      let source = null;
      if (wantSuggest) {
        const provider = await prepareAiProvider(req);
        if (provider) {
          const files = dataTuningService.targetFilesForArea(area, mapContext ? mapContext.mapDir : null, spawnConfig);
          if (files.length) {
            try {
              const planned = await dataTuningService.planSuggestions(area, report, files, provider);
              if (planned.length) {
                const saved = await saveDataTuningGroup(db, serverId, userId, area, report, planned);
                suggestions = saved.suggestions;
              }
            } catch (planErr) {
              // A provider rejection (bad patch, empty plan) must not sink the
              // deterministic report — surface the plan error alongside it.
              report.suggestionError = planErr.code || 'SUGGESTION_PLAN_FAILED';
              report.suggestionMessage = planErr.message || 'AI plan failed validation';
            }
            source = provider.source;
          }
        }
      }

      res.json({
        success: true,
        area,
        days,
        map: report.map,
        report,
        suggestions,
        source,
      });
    } catch (err) {
      console.error(`[AI] data-tuning ${area} error:`, err.code || err.name, err.message);
      sendAiError(res, err, 'AI');
    }
  };
}

router.post('/data-tuning/loot', ensureAiServerManage, runDataTuning('loot'));
router.post('/data-tuning/weapons', ensureAiServerManage, runDataTuning('weapons'));
router.post('/data-tuning/deathzones', ensureAiServerManage, runDataTuning('deathzones'));
router.post('/data-tuning/economy', ensureAiServerManage, runDataTuning('economy'));

// ─── Natural-language admin (AI feature 4/7) ─────────────────────────────────
// POST /api/ai/nl-query/:platformServerId        English in -> bounded,
//   whitelisted query spec -> parameterized read-only execution. The provider
//   fills a fixed JSON schema over a template catalog (text-to-bounded-query,
//   NOT text-to-SQL); out-of-whitelist templates/tables/columns are rejected
//   before any db call.
// POST /api/ai/nl-action/:platformServerId       English in -> explicit
//   human-confirmable action plan (deterministic target resolution + the
//   exact existing API call per affected player). Plans are stored pending
//   with a TTL. Nothing executes here.
// POST /api/ai/nl-action/:platformServerId/confirm
//   Re-checks ownership + plan freshness + explicit per-action confirmation,
//   then drives the existing ownerDashboard handlers (list add/remove,
//   player wipe) with the caller's real auth context. No new mutation paths.
// POST /api/ai/nl-config/:platformServerId       NL config change ->
//   suggestion: a thin wrapper that binds the server and delegates to the
//   card-1/2 /config-edit suggestion pipeline (patch engine; the
//   claim-lease finalization in the apply route is the only write path).

const nlQueryPlannerService = require('../services/nlQueryPlannerService');
const nlActionPlannerService = require('../services/nlActionPlannerService');
const cryptoNl = require('crypto');

const NL_ACTION_PLAN_TTL_MS = 30 * 60 * 1000; // plans expire after 30 minutes

/**
 * POST /api/ai/nl-query/:platformServerId
 * Body: { question, plan? }
 *   - plan omitted/{}: the provider resolves the question into a bounded
 *     query spec (consumes shared-router quota when that is the provider).
 *   - plan provided: validated against the whitelist and executed directly
 *     (no provider call) — this is the deterministic path tests exercise.
 */
router.post('/nl-query/:platformServerId', async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const serverId = req.platformServerAccess?.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question && !req.body?.plan) {
      return res.status(400).json({ error: 'question (plain English) or an explicit plan is required' });
    }

    let plan;
    let explain = null;
    let source = null;
    let planned = false;
    if (req.body?.plan && typeof req.body.plan === 'object') {
      plan = nlQueryPlannerService.validatePlan(req.body.plan); // throws on whitelist violations
    } else {
      const provider = await prepareAiProvider(req);
      if (!provider) return res.status(409).json({ error: 'Connect an AI provider to continue' });
      source = provider.source;
      const outcome = await nlQueryPlannerService.planQuery(question, provider);
      plan = outcome.plan;
      explain = outcome.explain;
      planned = true;
    }

    const result = await nlQueryPlannerService.executeQuery(db, serverId, plan);
    res.json({
      success: true,
      planned,
      source,
      explain,
      template: result.template,
      params: result.params,
      rows: result.rows,
    });
  } catch (err) {
    console.error('[AI] nl-query error:', err.code || err.name, err.message);
    sendAiError(res, err, 'AI');
  }
});

/**
 * Persist a pending NL action plan (TTL-bounded) for later confirmation.
 */
async function saveNlActionPlan(db, serverId, userId, plan, request) {
  const id = cryptoNl.randomUUID();
  const expiresAt = new Date(Date.now() + NL_ACTION_PLAN_TTL_MS);
  await db.query(
    `INSERT INTO nl_action_plans (id, server_id, user_id, request, action, resolver, params, plan, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, serverId, userId, request, plan.action, plan.resolver, JSON.stringify(plan.params), JSON.stringify(plan), expiresAt]
  );
  return id;
}

/** Load only pending, unexpired plans owned by the caller on their server. */
async function loadPendingNlActionPlan(db, userId, serverId, planId) {
  return db.get(
    `SELECT id, request, action, resolver, params, plan, expires_at
     FROM nl_action_plans
    WHERE id = $1 AND server_id = $2 AND user_id = $3
      AND status = 'pending'
      AND expires_at > NOW()
    LIMIT 1`,
    [planId, serverId, userId]
  );
}

/**
 * POST /api/ai/nl-action/:platformServerId
 * Body: { request, action?, resolver?, params?, execute? }
 * Without action/resolver the provider picks them from the catalog; with
 * them the request is resolved deterministically. The response ALWAYS
 * includes the full plan (affected players + exact API call each). Execution
 * happens only via the confirm route (execute=true still requires confirm).
 */
router.post('/nl-action/:platformServerId', async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;
    const serverId = req.platformServerAccess?.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const request = typeof req.body?.request === 'string' ? req.body.request.trim() : '';
    if (!request) return res.status(400).json({ error: 'request (a plain-English admin request) is required' });

    let spec;
    let source = null;
    let planned = false;
    if (req.body?.action && req.body?.resolver) {
      spec = nlActionPlannerService.validateRequest({
        action: req.body.action,
        resolver: req.body.resolver,
        params: req.body.params,
      });
    } else {
      const provider = await prepareAiProvider(req);
      if (!provider) return res.status(409).json({ error: 'Connect an AI provider to continue' });
      source = provider.source;
      spec = await nlActionPlannerService.planAction(request, provider);
      planned = true;
    }

    const plan = await nlActionPlannerService.buildActionPlan(db, serverId, {
      request,
      action: spec.action,
      resolver: spec.resolver,
      params: spec.params,
      rationale: spec.rationale || null,
    });
    const planId = await saveNlActionPlan(db, serverId, userId, plan, request);

    res.json({
      success: true,
      planned,
      source,
      planId,
      request,
      ...plan,
      confirmHint: `To execute: POST /api/ai/nl-action/:platformServerId/confirm with { planId: "${planId}", confirm: [${plan.actions.map(a => a.index).join(', ')}] }`,
    });
  } catch (err) {
    console.error('[AI] nl-action error:', err.code || err.name, err.message);
    sendAiError(res, err, 'AI');
  }
});

/**
 * POST /api/ai/nl-action/:platformServerId/confirm
 * Body: { planId, confirm: [action indexes] }
 * Every planned action must be explicitly listed in `confirm` — a plan never
 * executes without explicit per-action confirmation. Ownership and plan
 * freshness are re-checked server-side; execution drives the existing
 * ownerDashboard handlers (existing RBAC is the only execution path).
 */
router.post('/nl-action/:platformServerId/confirm', async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;
    const serverId = req.platformServerAccess?.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const planId = typeof req.body?.planId === 'string' ? req.body.planId : '';
    if (!planId) return res.status(400).json({ error: 'planId is required' });

    const stored = await loadPendingNlActionPlan(db, userId, serverId, planId);
    if (!stored) return res.status(404).json({ error: 'Action plan not found, already executed, or expired' });

    // The stored plan is a JSONB column — the adapter returns it as a string.
    let plan = stored.plan && typeof stored.plan === 'object' ? stored.plan : {};
    if (typeof stored.plan === 'string') {
      try { plan = JSON.parse(stored.plan); } catch (parseError) { plan = {}; }
    }
    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    if (!actions.length) {
      return res.status(409).json({ error: 'Stored action plan is malformed — no actions to execute' });
    }
    const confirmed = new Set(
      (Array.isArray(req.body?.confirm) ? req.body.confirm : [])
        .map(Number)
        .filter(n => Number.isInteger(n))
    );
    const missing = actions.filter(a => !confirmed.has(a.index));
    if (missing.length) {
      return res.status(409).json({
        error: 'Explicit confirmation is required for every planned action',
        unconfirmed: missing.map(a => ({ index: a.index, action: a.action, target: a.target })),
      });
    }

    const results = [];
    for (const action of actions) {
      // eslint-disable-next-line no-await-in-loop
      try {
        const outcome = await nlActionPlannerService.executePlannedAction(req, action);
        results.push({ index: action.index, action: action.action, target: action.target.gamertag, ok: true, outcome });
      } catch (execErr) {
        results.push({
          index: action.index,
          action: action.action,
          target: action.target.gamertag,
          ok: false,
          error: execErr.code || 'execution_failed',
          message: execErr.message,
        });
      }
    }

    const failed = results.filter(r => !r.ok);
    if (failed.length === actions.length) {
      // Nothing succeeded — leave the plan pending so the caller can retry.
      return res.status(502).json({ success: false, results, error: 'All actions were rejected by the existing authorization path' });
    }
    await db.query(
      `UPDATE nl_action_plans
          SET status = 'executed', executed_at = NOW(), results = $1
        WHERE id = $2`,
      [JSON.stringify(results), planId]
    );
    res.json({
      success: true,
      planId,
      executed: results.filter(r => r.ok).length,
      failed: failed.length,
      results,
    });
  } catch (err) {
    console.error('[AI] nl-action confirm error:', err.code || err.name, err.message);
    sendAiError(res, err, 'AI');
  }
});

/**
 * POST /api/ai/nl-config/:platformServerId
 * Body: { instruction, files: [{filename, fileContent}] }
 * NL config change -> suggestion. A thin wrapper over the card-1/2
 * /config-edit pipeline: same provider resolver, same patch engine, same
 * suggestion-group persistence. Suggestions never auto-apply; the
 * claim-lease finalization in the existing apply route is the only write path.
 */
router.post('/nl-config/:platformServerId', async (req, res) => {
  try {
    const db     = req.app.locals.db;
    const userId = req.user.id;
    const serverId = req.platformServerAccess?.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const { instruction, files } = req.body || {};
    if (typeof instruction !== 'string' || !instruction.trim()) {
      return res.status(400).json({ error: 'instruction (a plain-English config change) is required' });
    }
    const normalized = configIntelligenceService.normalizeFileList(files);
    const provider = await prepareAiProvider(req);
    if (!provider) return res.status(409).json({ error: 'Connect an AI provider to continue' });

    const suggestions = await configIntelligenceService.planPatchSuggestions(db, serverId, {
      instruction: instruction.trim().slice(0, 4000),
      files: normalized,
      provider,
    });
    const saved = await saveSuggestionGroup(db, serverId, userId, { kind: 'multi-file', suggestions });
    res.json({
      success: true,
      instruction: instruction.trim().slice(0, 4000),
      groupId: saved.groupId,
      suggestions: saved.suggestions,
      source: provider.source,
      applyHint: 'Suggestions never auto-apply — review them, then POST /api/ai/suggestions/:suggestionId/apply',
    });
  } catch (err) {
    console.error('[AI] nl-config error:', err.code || err.name);
    sendAiError(res, err, 'AI');
  }
});

// ─── Event / content generation (AI feature 5/7) ────────────────────────────
//
// Deterministic event/spawn/loot generation, validated against the real
// mission XML shapes, materialized through the feature-2 patch engine so
// every result is a reviewable suggestion (never auto-applied). Optional AI
// layer: with a provider the theme plan is regenerated via a grounded prompt
// (real mission state in the context); a failed AI plan falls back to the
// deterministic template plan with a planError field (data-tuning
// convention).

const eventContentService = require('../services/eventContentService');

async function saveEventGroup(db, serverId, userId, kind, goal, suggestions, predictions) {
  const groupRows = await db.query(
    `INSERT INTO ai_suggestion_groups (server_id, user_id, kind, goal, file_count)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [serverId, userId, kind, goal || null, suggestions.length]
  );
  const groupId = groupRows[0]?.id || null;
  const saved = [];
  for (let i = 0; i < suggestions.length; i++) {
    const suggestion = suggestions[i];
    const diffExplanation = configIntelligenceService.deterministicDiffExplanation(suggestion);
    const rows = await db.query(
      `INSERT INTO ai_suggestions
         (server_id, user_id, filename, trigger_type, explanation, original_content, suggested_content,
          diff_summary, group_id, patch, base_content_hash, diff_explanation, prediction)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        serverId, userId, suggestion.filename,
        kind,
        suggestion.explanation, suggestion.originalContent, suggestion.suggestedContent,
        suggestion.diffSummary.summary, groupId,
        JSON.stringify(suggestion.patch), suggestion.baseContentHash,
        diffExplanation, (predictions && predictions[i]) || null,
      ]
    );
    saved.push({
      id: rows[0]?.id || null,
      filename: suggestion.filename,
      explanation: suggestion.explanation,
      diff_summary: suggestion.diffSummary.summary,
      diff_explanation: diffExplanation,
      prediction: (predictions && predictions[i]) || null,
      group_id: groupId,
    });
  }
  return { groupId, suggestions: saved };
}

function readEventMapContext(req, mapName) {
  let access = req.platformServerAccess;
  if (!access?.discordGuildId) {
    access = {
      discordGuildId: req.body?.discordGuildId,
      platformServerId: req.body?.platformServerId || req.params.platformServerId,
    };
  }
  return dataTuningService.resolveMapForReport(access, mapName);
}

/**
 * POST /api/ai/event-generate/:platformServerId
 * Body: { theme, map?, eventPositions?: [[x,z,a]...] }
 * Generates a coherent event (cfgeventgroups + cfgeventspawns + cfgweather
 * overrides) and stores it as a reviewable suggestion group. `suggest: true`
 * (default) with a provider attempts an AI-grounded plan first; any provider
 * failure falls back to the deterministic template plan.
 */
router.post('/event-generate/:platformServerId', ensureAiServerManage, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const userId = req.user.id;
    const serverId = req.platformServerAccess?.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const theme = String(req.body?.theme || '').trim();
    if (!eventContentService.SEASONS.has(theme.toLowerCase())) {
      return res.status(400).json({
        error: `Unknown theme "${theme}"`,
        themes: [...eventContentService.SEASONS],
      });
    }
    let mapContext;
    try {
      mapContext = readEventMapContext(req, req.body?.map);
    } catch (mapErr) {
      return res.status(mapErr.status || 404).json({ error: mapErr.message });
    }
    if (!mapContext) return res.status(404).json({ error: 'No mission working copy found for this server' });

    const positions = Array.isArray(req.body?.eventPositions) ? req.body.eventPositions : undefined;

    const plan = eventContentService.generateEventBlocks(mapContext, theme.toLowerCase(), {
      eventPositions: positions,
    });

    // Deterministic materialization first — this is the guaranteed baseline.
    const deterministic = eventContentService.materializeEventSuggestions(plan);
    const predictions = deterministic.map(() =>
      `Review-gated ${plan.label} for ${mapContext.mapName}: adds event "${plan.eventName}" and loot group "${plan.groupName}"; weather drifts toward the ${plan.season} profile. No server-side effect until the suggestion is applied.`);

    let source = null;
    let planError = null;
    let suggestions = deterministic;
    let savedPredictions = predictions;
    if (req.body?.suggest !== false) {
      const provider = await prepareAiProvider(req);
      if (provider) {
        const files = deterministic
          .map(s => ({ filename: s.filename, content: s.originalContent }))
          .reduce((acc, f) => (acc.some(x => x.filename === f.filename) ? acc : acc.concat(f)), []);
        try {
          const aiPlan = await eventContentService.planEventWithProvider(plan, mapContext.mapName, files, provider);
          if (aiPlan.length) {
            suggestions = aiPlan;
            source = provider.source;
            savedPredictions = aiPlan.map(() => predictions[0]);
          }
        } catch (aiErr) {
          planError = { code: aiErr.code || 'AI_PLAN_FAILED', message: aiErr.message };
        }
      }
    }

    const saved = await saveEventGroup(db, serverId, userId, 'event-content',
      `${plan.label} (${plan.eventName} / ${plan.groupName}) on ${mapContext.mapName}`,
      suggestions, savedPredictions);
    res.json({
      success: true,
      theme: plan.season,
      label: plan.label,
      map: mapContext.mapName,
      plan: {
        eventName: plan.eventName,
        groupName: plan.groupName,
        blocks: plan.blocks,
        validation: plan.validation,
      },
      groupId: saved.groupId,
      suggestions: saved.suggestions,
      source,
      planError,
    });
  } catch (err) {
    console.error('[AI] event-generate error:', err.code || err.name, err.message);
    sendAiError(res, err, 'AI');
  }
});

/**
 * POST /api/ai/spawn-design/:platformServerId
 * Body: { name, positions: [[x,z]...], map?, lifetime?, counter? }
 * New player-spawn group (cfgplayerspawnpoints.xml) — every coordinate is
 * validated against the mission map bounds; result is a reviewable suggestion.
 */
router.post('/spawn-design/:platformServerId', ensureAiServerManage, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const userId = req.user.id;
    const serverId = req.platformServerAccess?.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
    if (!positions.length) return res.status(400).json({ error: 'positions ([[x,z]...] or [{x,z}...]) is required' });

    let mapContext;
    try {
      mapContext = readEventMapContext(req, req.body?.map);
    } catch (mapErr) {
      return res.status(mapErr.status || 404).json({ error: mapErr.message });
    }
    if (!mapContext) return res.status(404).json({ error: 'No mission working copy found for this server' });

    const designed = eventContentService.designSpawnGroup(mapContext, name, positions, {
      lifetime: req.body?.lifetime,
      counter: req.body?.counter,
    });
    const saved = await saveEventGroup(db, serverId, userId, 'event-content',
      `Spawn group "${designed.name}" on ${mapContext.mapName}`,
      [designed.suggestion],
      [`Spawn group "${designed.name}" (${designed.positions.length} positions, bounds-checked on ${mapContext.mapName}) — review before applying; no effect until applied.`]);
    res.json({
      success: true,
      map: mapContext.mapName,
      name: designed.name,
      positions: designed.positions,
      groupId: saved.groupId,
      suggestions: saved.suggestions,
    });
  } catch (err) {
    console.error('[AI] spawn-design error:', err.code || err.name, err.message);
    sendAiError(res, err, 'AI');
  }
});

/**
 * POST /api/ai/loot-design/:platformServerId
 * Body: { item_class, nominal?, min?, lifetime?, restock?, map? }
 * New types.xml loot entry with nominal/bias bounded by the server economy
 * (card-3 spawn config); result is a reviewable suggestion.
 */
router.post('/loot-design/:platformServerId', ensureAiServerManage, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const userId = req.user.id;
    const serverId = req.platformServerAccess?.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const itemClass = String(req.body?.item_class || req.body?.itemClass || '').trim();
    if (!itemClass) return res.status(400).json({ error: 'item_class is required' });

    let mapContext;
    try {
      mapContext = readEventMapContext(req, req.body?.map);
    } catch (mapErr) {
      return res.status(mapErr.status || 404).json({ error: mapErr.message });
    }
    if (!mapContext) return res.status(404).json({ error: 'No mission working copy found for this server' });

    const designed = eventContentService.designLootEntry(mapContext, itemClass, req.body || {});
    const saved = await saveEventGroup(db, serverId, userId, 'event-content',
      `Loot class "${designed.item_class}" (nominal ${designed.nominal}) on ${mapContext.mapName}`,
      [designed.suggestion],
      [`Loot class "${designed.item_class}" nominal ${designed.nominal}/min ${designed.min} — within the server's economy bounds; review before applying.`]);
    res.json({
      success: true,
      map: mapContext.mapName,
      item: {
        item_class: designed.item_class,
        nominal: designed.nominal,
        min: designed.min,
        lifetime: designed.lifetime,
        restock: designed.restock,
        existing: designed.existing,
      },
      groupId: saved.groupId,
      suggestions: saved.suggestions,
    });
  } catch (err) {
    console.error('[AI] loot-design error:', err.code || err.name, err.message);
    sendAiError(res, err, 'AI');
  }
});

/**
 * POST /api/ai/season-plan/:platformServerId
 * Body: { theme, duration_days? }
 * Season planner: theme + duration -> reviewable markdown schedule across
 * every mission working copy on the server + per-mission config suggestions
 * (stored when the server has multiple missions; single-mission plans return
 * the suggestions inline as a saved group).
 */
router.post('/season-plan/:platformServerId', ensureAiServerManage, async (req, res) => {
  try {
    const db = req.app.locals.db;
    const userId = req.user.id;
    const serverId = req.platformServerAccess?.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const theme = String(req.body?.theme || '').trim();
    if (!eventContentService.SEASONS.has(theme.toLowerCase())) {
      return res.status(400).json({
        error: `Unknown theme "${theme}"`,
        themes: [...eventContentService.SEASONS],
      });
    }
    const serverRoot = getGuildDownloadPath(req.platformServerAccess.discordGuildId, req.platformServerAccess.platformServerId);
    const result = eventContentService.planSeason(serverRoot, theme.toLowerCase(), req.body?.duration_days);

    // Persist per-mission suggestion groups (each mission is a reviewable unit).
    const savedMissions = [];
    for (const mission of result.missions) {
      if (!mission.suggestions) {
        savedMissions.push({ ...mission, group: null });
        continue;
      }
      const saved = await saveEventGroup(db, serverId, userId, 'season-plan',
        `${result.theme} season — ${mission.mapName} (wave ${mission.waves})`,
        mission.suggestions,
        mission.suggestions.map(() =>
          `${mission.theme} season wave on ${mission.mapName}: event "${mission.eventName}" + group "${mission.groupName}" — review-gated, no effect until applied.`));
      savedMissions.push({ ...mission, group: saved.groupId, suggestions: saved.suggestions });
    }

    res.json({
      success: true,
      theme: result.theme,
      durationDays: result.durationDays,
      markdown: result.markdown,
      missions: savedMissions.map(m => ({
        mapName: m.mapName,
        theme: m.theme,
        eventName: m.eventName,
        groupName: m.groupName,
        waves: m.waves,
        schedule: m.schedule,
        group: m.group,
        suggestionError: m.suggestionError,
      })),
    });
  } catch (err) {
    console.error('[AI] season-plan error:', err.code || err.name, err.message);
    sendAiError(res, err, 'AI');
  }
});

module.exports = router;
