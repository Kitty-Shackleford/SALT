'use strict';

const crypto = require('crypto');
const { encryptToken, decryptToken } = require('../utils/encryption');

const OPENAI_COMPATIBLE = 'openai-compatible';
const COPILOT = 'copilot';
const SUPPORTED_TYPES = new Set([OPENAI_COMPATIBLE, COPILOT]);
const DEFAULT_USER_PROVIDER_HOSTS = new Set([
  'api.openai.com',
  'openrouter.ai',
  'api.groq.com',
  'api.together.xyz',
  'api.fireworks.ai',
  'api.mistral.ai',
  'inference.cerebras.ai',
  'api.x.ai',
  'api.deepseek.com',
  'api.perplexity.ai',
]);

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (_) {
    const error = new Error('A valid AI provider base URL is required');
    error.code = 'AI_PROVIDER_URL_INVALID';
    throw error;
  }
  if (url.username || url.password) {
    const error = new Error('AI provider URLs must not contain embedded credentials');
    error.code = 'AI_PROVIDER_URL_CREDENTIALS';
    throw error;
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    const error = new Error('AI provider URLs must use HTTPS unless they target loopback');
    error.code = 'AI_PROVIDER_URL_INSECURE';
    throw error;
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function isSupportedCopilotToken(token) {
  return /^(github_pat_|gho_|ghu_)/.test(String(token || ''));
}

function allowedUserProviderHosts(env = process.env) {
  const hosts = new Set(DEFAULT_USER_PROVIDER_HOSTS);
  String(env.AI_USER_PROVIDER_ALLOWED_HOSTS || '')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean)
    .forEach(host => hosts.add(host));
  return hosts;
}

async function prepareCopilotProvider(db, userId, model = 'auto') {
  const github = await db.get(
    'SELECT token_hash, token_type FROM github_connections WHERE user_id = $1',
    [userId]
  );
  if (!github) {
    const error = new Error('Connect GitHub before selecting GitHub Copilot');
    error.code = 'COPILOT_GITHUB_REQUIRED';
    error.status = 409;
    throw error;
  }
  const githubToken = decryptToken(github.token_hash);
  if (!isSupportedCopilotToken(githubToken)) {
    const error = new Error('GitHub Copilot requires OAuth, GitHub App, or a fine-grained personal access token');
    error.code = 'COPILOT_TOKEN_UNSUPPORTED';
    error.status = 409;
    throw error;
  }
  return {
    type: COPILOT,
    source: 'user',
    githubToken,
    credentialBinding: crypto.createHash('sha256').update(github.token_hash).digest('hex'),
    expectedCredentialHash: github.token_hash,
    model: String(model || 'auto').trim().slice(0, 200) || 'auto',
  };
}

async function getConnection(db, userId) {
  return db.get(
    `SELECT provider_type, credential_hash, credential_binding_hash,
            base_url, model, created_at, updated_at
     FROM ai_provider_connections WHERE user_id = $1`,
    [userId]
  );
}

async function resolveUserProvider(db, userId, env = process.env) {
  const row = await getConnection(db, userId);
  if (row?.provider_type === OPENAI_COMPATIBLE) {
    return {
      type: OPENAI_COMPATIBLE,
      source: 'user',
      apiKey: decryptToken(row.credential_hash),
      baseURL: row.base_url,
      model: row.model,
      enforcePublicAddress: true,
    };
  }
  if (row?.provider_type === COPILOT) {
    const provider = await prepareCopilotProvider(db, userId, row.model);
    if (provider.credentialBinding !== row.credential_binding_hash) {
      const error = new Error('Reconnect GitHub before using GitHub Copilot');
      error.code = 'COPILOT_GITHUB_CHANGED';
      error.status = 409;
      throw error;
    }
    delete provider.expectedCredentialHash;
    return provider;
  }
  if (env.AI_API_KEY) {
    return {
      type: OPENAI_COMPATIBLE,
      source: 'operator',
      apiKey: env.AI_API_KEY,
      baseURL: env.AI_API_BASE_URL || 'https://api.openai.com/v1/',
      model: env.AI_MODEL || 'gpt-4o-mini',
    };
  }
  return null;
}

async function getUserProviderStatus(db, userId, env = process.env) {
  const row = await getConnection(db, userId);
  if (row?.provider_type === OPENAI_COMPATIBLE) {
    return {
      configured: true,
      type: OPENAI_COMPATIBLE,
      source: 'user',
      model: row.model,
      baseURL: row.base_url,
    };
  }
  if (row?.provider_type === COPILOT) {
    const github = await db.get(
      'SELECT token_hash, token_type FROM github_connections WHERE user_id = $1',
      [userId]
    );
    const credentialMatches = Boolean(github)
      && crypto.createHash('sha256').update(github.token_hash).digest('hex') === row.credential_binding_hash;
    const supported = credentialMatches && isSupportedCopilotToken(decryptToken(github.token_hash));
    return {
      configured: supported,
      type: COPILOT,
      source: 'user',
      model: row.model || 'auto',
      requiresGitHub: !github,
      requiresGitHubReconnect: Boolean(github) && !supported,
    };
  }
  if (env.AI_API_KEY) {
    return {
      configured: true,
      type: OPENAI_COMPATIBLE,
      source: 'operator',
      model: env.AI_MODEL || 'gpt-4o-mini',
    };
  }
  return { configured: false, type: null, source: null, model: null };
}

function validateOpenAiConnection({ token, baseURL, model }) {
  const cleanToken = String(token || '').trim();
  const cleanModel = String(model || '').trim();
  if (cleanToken.length < 10) {
    const error = new Error('A valid AI provider token is required');
    error.code = 'AI_PROVIDER_TOKEN_INVALID';
    throw error;
  }
  if (!cleanModel || cleanModel.length > 200) {
    const error = new Error('A valid AI model is required');
    error.code = 'AI_PROVIDER_MODEL_INVALID';
    throw error;
  }
  const normalizedBaseURL = normalizeBaseUrl(baseURL);
  const hostname = new URL(normalizedBaseURL).hostname.toLowerCase();
  if (!allowedUserProviderHosts().has(hostname)) {
    const error = new Error('This AI provider host is not allowed by the dashboard operator');
    error.code = 'AI_PROVIDER_HOST_NOT_ALLOWED';
    throw error;
  }
  return { token: cleanToken, baseURL: normalizedBaseURL, model: cleanModel };
}

async function saveOpenAiConnection(db, userId, connection) {
  const validated = validateOpenAiConnection(connection);
  await db.query(
    `INSERT INTO ai_provider_connections
       (user_id, provider_type, credential_hash, base_url, model, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       provider_type = EXCLUDED.provider_type,
       credential_hash = EXCLUDED.credential_hash,
       credential_binding_hash = NULL,
       base_url = EXCLUDED.base_url,
       model = EXCLUDED.model,
       updated_at = NOW()`,
    [userId, OPENAI_COMPATIBLE, encryptToken(validated.token), validated.baseURL, validated.model]
  );
  return { type: OPENAI_COMPATIBLE, baseURL: validated.baseURL, model: validated.model };
}

async function selectCopilot(db, userId, provider) {
  const cleanModel = String(provider?.model || 'auto').trim().slice(0, 200) || 'auto';
  const credentialBinding = provider?.credentialBinding;
  const expectedCredentialHash = provider?.expectedCredentialHash;
  if (!credentialBinding || !expectedCredentialHash) {
    const error = new Error('GitHub connection changed while enabling Copilot');
    error.code = 'COPILOT_GITHUB_CHANGED';
    error.status = 409;
    throw error;
  }
  await db.transaction(async transactionDb => {
    const github = await transactionDb.get(
      'SELECT token_hash FROM github_connections WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (!github || github.token_hash !== expectedCredentialHash) {
      const error = new Error('GitHub connection changed while enabling Copilot');
      error.code = 'COPILOT_GITHUB_CHANGED';
      error.status = 409;
      throw error;
    }

    await transactionDb.query(
      `INSERT INTO ai_provider_connections
         (user_id, provider_type, credential_hash, credential_binding_hash, base_url, model, updated_at)
       VALUES ($1, $2, NULL, $4, NULL, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         provider_type = EXCLUDED.provider_type,
         credential_hash = NULL,
         credential_binding_hash = EXCLUDED.credential_binding_hash,
         base_url = NULL,
         model = EXCLUDED.model,
         updated_at = NOW()`,
      [userId, COPILOT, cleanModel, credentialBinding]
    );
  });
  return { type: COPILOT, model: cleanModel };
}

async function disconnect(db, userId) {
  await db.query('DELETE FROM ai_provider_connections WHERE user_id = $1', [userId]);
}

module.exports = {
  OPENAI_COMPATIBLE,
  COPILOT,
  SUPPORTED_TYPES,
  normalizeBaseUrl,
  validateOpenAiConnection,
  allowedUserProviderHosts,
  isSupportedCopilotToken,
  prepareCopilotProvider,
  resolveUserProvider,
  getUserProviderStatus,
  saveOpenAiConnection,
  selectCopilot,
  disconnect,
};
