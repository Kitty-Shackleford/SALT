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
const router = express.Router();

const { encryptToken, decryptToken } = require('../utils/encryption');
const { authorizePlatformServer, authorizeServer, CAPABILITIES } = require('../services/authorizationService');
const githubService = require('../services/githubService');
const {
  inspectGitHubActionsIntegration,
} = require('../services/githubActionsIntegrationService');
const aiService     = require('../services/aiService');
const aiProviderService = require('../services/aiProviderService');
const { sendExternalApiError } = require('../utils/externalApiResponse');

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

// ─── GitHub Connection ────────────────────────────────────────────────────────

router.get('/provider/status', async (req, res) => {
  try {
    const status = await aiProviderService.getUserProviderStatus(
      req.app.locals.db,
      req.user.id
    );
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
    try {
      aiService.assertCompleteFileContent(fileContent);
    } catch (error) {
      if (error.code === 'AI_FILE_TOO_LARGE') return res.status(413).json({ error: 'File is too large for safe AI editing' });
      throw error;
    }

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
    try {
      aiService.assertCompleteFileContent(fileContent);
    } catch (error) {
      if (error.code === 'AI_FILE_TOO_LARGE') return res.status(413).json({ error: 'File is too large for safe AI editing' });
      throw error;
    }

    const serverId = req.platformServerAccess.serverId;
    if (!serverId) return res.status(404).json({ error: 'Server not found' });

    const provider = await aiProviderService.resolveUserProvider(db, userId);
    if (!provider) return res.status(409).json({ error: 'Connect an AI provider to continue' });
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
      `SELECT id, filename, trigger_type, explanation, diff_summary, status, github_pr_url, created_at, applied_at
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
                 ais.diff_summary, ais.explanation, ais.repository, ais.branch,
                 ais.pull_request_url, ais.status`,
      [suggestion.id, claimId, userId]
    );
    if (!claimRows.length) return res.status(409).json({ error: 'Suggestion finalization is already in progress' });
    suggestion = claimRows[0];
    claimedSuggestion = { id: suggestion.id, claimId, db };

    // Revalidate after acquiring the lease so legacy pending rows cannot bypass
    // the complete-file checks now applied when suggestions are created.
    const validatedSuggestedContent = aiService.assertValidReplacement(
      suggestion.filename,
      suggestion.suggested_content,
    );

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
    res.status(500).json({ error: 'Failed to finalize suggestion' });
  }
});

module.exports = router;
