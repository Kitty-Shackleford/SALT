/*
 * AI Service
 *
 * Wraps per-user OpenAI-compatible or GitHub Copilot inference to provide
 * AI-assisted DayZ server config editing. Routes resolve encrypted credentials
 * server-side and pass them only for the current authenticated request.
 *
 * Key responsibilities:
 *   buildServerContext  — compiles real server stats (kills, loot, players)
 *                         into a system prompt so the AI understands the server
 *   chat                — single-turn or multi-turn completion
 *   analyzeFile         — asks the AI to review a config file and return suggestions
 *   applyEdit           — asks the AI to apply a plain-English instruction to a file
 *                         and return the full edited content
 *
 */

const { createExternalApiClient, ExternalApiError } = require('../utils/externalApiClient');
const { XMLValidator } = require('fast-xml-parser');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPublicAddressLookup } = require('../utils/publicAddressLookup');

// Maximum complete file size accepted for replacement-generating operations.
const MAX_FILE_CHARS = 40000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
const MAX_OUTPUT_TOKENS = 32768;

// ─── Internal helpers ────────────────────────────────────────────────────────

async function callAiApi(messages, temperature = 0.3, options = {}) {
  const baseURL = options.baseURL || process.env.AI_API_BASE_URL || 'https://api.openai.com/v1/';
  const apiKey = options.apiKey || process.env.AI_API_KEY;
  const model = options.model || process.env.AI_MODEL || 'gpt-4o-mini';
  const configuredOutputTokens = Number(options.maxOutputTokens || process.env.AI_MAX_OUTPUT_TOKENS);
  const maxOutputTokens = Number.isFinite(configuredOutputTokens)
    ? Math.min(MAX_OUTPUT_TOKENS, Math.max(1024, Math.floor(configuredOutputTokens)))
    : DEFAULT_MAX_OUTPUT_TOKENS;
  if (!apiKey) throw new Error('AI provider is not configured');

  const client = createExternalApiClient({
    serviceName: 'AI',
    baseURL: baseURL.endsWith('/') ? baseURL : `${baseURL}/`,
    timeoutMs: Number(options.timeoutMs || process.env.AI_API_TIMEOUT_MS) || 60000,
    maxRetries: 0,
    logger: options.logger,
    transport: options.transport,
    defaultHeaders: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  const response = await client.request({
    method: 'POST',
    path: 'chat/completions',
    operation: 'chat completion',
    maxRedirects: 0,
    proxy: options.enforcePublicAddress ? false : undefined,
    lookup: options.enforcePublicAddress ? createPublicAddressLookup() : undefined,
    data: { model, messages, temperature, max_tokens: maxOutputTokens },
  });
  const choice = response?.data?.choices?.[0];
  const content = choice?.message?.content;
  if (choice?.finish_reason !== 'stop' || typeof content !== 'string' || !content.trim()) {
    throw new ExternalApiError('AI', 'chat completion', 'invalid_response', 502);
  }
  return content;
}

async function createCopilotClient(options) {
  const { CopilotClient } = await import('@github/copilot-sdk');
  return new CopilotClient(options);
}

function copilotRuntimeEnvironment(baseDirectory) {
  const env = {
    HOME: baseDirectory,
    TMPDIR: baseDirectory,
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    SSL_CERT_DIR: process.env.SSL_CERT_DIR,
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string'));
}

async function stopCopilotClient(client, timeoutMs = 5000) {
  let stopTimer;
  const stoppedCleanly = await Promise.race([
    Promise.resolve()
      .then(() => client.stop())
      .then(errors => !Array.isArray(errors) || errors.length === 0, () => false),
    new Promise(resolve => {
      stopTimer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (stopTimer) clearTimeout(stopTimer);
  if (stoppedCleanly || typeof client.forceStop !== 'function') return;

  let forceTimer;
  await Promise.race([
    Promise.resolve().then(() => client.forceStop()).catch(() => {}),
    new Promise(resolve => {
      forceTimer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (forceTimer) clearTimeout(forceTimer);
}

async function callCopilotApi(messages, options = {}) {
  if (!options.githubToken) throw new Error('GitHub Copilot is not connected');
  const sdkFactory = options.sdkFactory || createCopilotClient;
  const baseDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dayz-ai-copilot-'));
  let client;
  let timeoutId;
  const configuredTimeout = Number(options.timeoutMs || process.env.AI_API_TIMEOUT_MS || 60000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.floor(configuredTimeout)
    : 60000;
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new ExternalApiError('AI Copilot', 'chat completion', 'timeout', 504));
    }, timeoutMs);
  });
  try {
    client = await Promise.race([
      sdkFactory({
        mode: 'empty',
        baseDirectory,
        workingDirectory: baseDirectory,
        env: copilotRuntimeEnvironment(baseDirectory),
        gitHubToken: options.githubToken,
        useLoggedInUser: false,
        sessionIdleTimeoutSeconds: 300,
      }),
      timeout,
    ]);
    const systemContent = messages
      .filter(message => message.role === 'system')
      .map(message => String(message.content || ''))
      .join('\n\n');
    const completion = (async () => {
      const session = await client.createSession({
        sessionId: `dayz-dashboard-${crypto.randomUUID()}`,
        model: options.model || 'auto',
        availableTools: [],
        gitHubToken: options.githubToken,
        systemMessage: {
          content: `${systemContent}\n\nDo not use tools or access the host filesystem.`.trim(),
        },
      });
      const prompt = messages
        .filter(message => message.role !== 'system')
        .map(message => `${String(message.role || 'user').toUpperCase()}:\n${String(message.content || '')}`)
        .join('\n\n');
      return session.sendAndWait({ prompt }, timeoutMs);
    })();
    const response = await Promise.race([completion, timeout]);
    const content = response?.data?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ExternalApiError('AI', 'Copilot completion', 'invalid_response', 502);
    }
    return content;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (client) {
      const configuredCleanupTimeout = Number(options.cleanupTimeoutMs || 5000);
      const cleanupTimeoutMs = Number.isFinite(configuredCleanupTimeout) && configuredCleanupTimeout > 0
        ? Math.floor(configuredCleanupTimeout)
        : 5000;
      await stopCopilotClient(client, cleanupTimeoutMs);
    }
    await fs.promises.rm(baseDirectory, { recursive: true, force: true });
  }
}

async function callProvider(messages, temperature = 0.3, provider = {}) {
  if (provider.type === 'copilot') return callCopilotApi(messages, provider);
  return callAiApi(messages, temperature, provider);
}

/** Reject files that cannot be sent and returned as a complete replacement. */
function assertCompleteFileContent(content, maxChars = MAX_FILE_CHARS) {
  if (typeof content !== 'string') throw new Error('File content must be text');
  if (content.length > maxChars) {
    const error = new Error(`File exceeds the ${maxChars}-character safe AI editing limit`);
    error.code = 'AI_FILE_TOO_LARGE';
    error.status = 413;
    throw error;
  }
  return content;
}

function invalidReplacement(message) {
  const error = new ExternalApiError('AI', 'validate complete replacement', 'invalid_response', 502);
  error.message = message;
  return error;
}

function assertValidReplacement(filename, content) {
  const completeContent = assertCompleteFileContent(content);
  if (!completeContent.trim()) throw invalidReplacement('AI replacement must not be empty');
  const lowerName = String(filename || '').toLowerCase();
  if (lowerName.endsWith('.json')) {
    try {
      JSON.parse(completeContent);
    } catch (_) {
      throw invalidReplacement('AI replacement must be valid JSON');
    }
  } else if (lowerName.endsWith('.xml')) {
    const validation = XMLValidator.validate(completeContent, { allowBooleanAttributes: true });
    if (validation !== true) throw invalidReplacement('AI replacement must be valid XML');
  }
  return completeContent;
}

// ─── Context builder ─────────────────────────────────────────────────────────

/**
 * Pull server statistics from the database and format them as a
 * concise text block for the AI system prompt.
 *
 * @param {object} db        - PostgreSQL database adapter (`db/abstraction`)
 * @param {number} serverId  - Internal servers.id
 * @param {number} days      - How many days of history to include (default 7)
 * @returns {string}
 */
async function buildServerContext(db, serverId, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Server metadata
  const server = await db.get(
    'SELECT name, platform, platform_server_id FROM servers WHERE id = $1',
    [serverId]
  );
  if (!server) return 'No server data available.';

  // Kill events summary
  const killRows = await db.query(
    `SELECT weapon, COUNT(*) AS cnt
     FROM kill_events
     WHERE server_id = $1 AND timestamp >= $2
     GROUP BY weapon ORDER BY cnt DESC LIMIT 10`,
    [serverId, since]
  );

  const totalKills = killRows.reduce((sum, r) => sum + parseInt(r.cnt, 10), 0);
  const topWeapons = killRows
    .slice(0, 5)
    .map(r => `${r.weapon} (${r.cnt})`)
    .join(', ') || 'none';

  // Loot despawn summary
  const lootRows = await db.query(
    `SELECT item_class, COUNT(*) AS cnt
     FROM loot_despawn_events
     WHERE server_id = $1 AND log_date >= $2::date
     GROUP BY item_class ORDER BY cnt DESC LIMIT 10`,
    [serverId, since]
  );

  const totalDespawns = lootRows.reduce((sum, r) => sum + parseInt(r.cnt, 10), 0);
  const topDespawns = lootRows
    .slice(0, 5)
    .map(r => `${r.item_class} (${r.cnt})`)
    .join(', ') || 'none';

  // Player activity (unique active players in period)
  const activityRow = await db.get(
    `SELECT COUNT(DISTINCT killer_identity_id) + COUNT(DISTINCT victim_identity_id) AS approx_players
     FROM kill_events WHERE server_id = $1 AND timestamp >= $2`,
    [serverId, since]
  );
  const approxPlayers = activityRow?.approx_players || 0;

  // Server feature settings (day/night speed etc.)
  const featureRow = await db.get(
    `SELECT config FROM server_features WHERE feature_name = 'server_status'
     AND server_id = $1`,
    [serverId]
  );
  let settingsSummary = '';
  try {
    if (featureRow?.config) {
      const cfg = JSON.parse(featureRow.config);
      if (cfg.lastServerInfo) {
        const si = cfg.lastServerInfo;
        settingsSummary = `Day speed: ${si.timeAcceleration || '?'}x, Night speed: ${si.nightTimeAcceleration || '?'}x, Map: ${si.map || '?'}`;
      }
    }
  } catch (_) { /* non-critical */ }

  return [
    `Server: ${server.platform?.toUpperCase()} — platform_id ${server.platform_server_id}`,
    settingsSummary ? `Settings: ${settingsSummary}` : '',
    `Kill data (last ${days}d): ${totalKills} total kills | Top weapons: ${topWeapons}`,
    `Loot data (last ${days}d): ${totalDespawns} despawn events | Most despawned: ${topDespawns}`,
    `Approximate unique active players: ${approxPlayers}`,
  ].filter(Boolean).join('\n');
}

// ─── Core AI functions ───────────────────────────────────────────────────────

/**
 * Single or multi-turn chat with the AI, with optional server context injected
 * as a system message.
 *
 * @param {Array}    messages   - Array of {role, content} objects
 * @param {string}   [context]  - Server context string (from buildServerContext)
 * @returns {string}  AI response text
 */
async function chat(messages, context, provider) {
  const systemContent = [
    'You are an expert DayZ server administrator assistant.',
    'You help server owners edit their DayZ XML and JSON config files accurately.',
    'When asked to modify a file, return ONLY the complete updated file content between',
    '```xml``` or ```json``` fences — no explanations inside the fenced block.',
    'Explain your changes BEFORE the fenced block.',
    '',
    context ? `--- Server Data ---\n${context}` : '',
  ].filter(Boolean).join('\n');

  const fullMessages = [
    { role: 'system', content: systemContent },
    ...messages,
  ];

  return callProvider(fullMessages, 0.3, provider);
}

/**
 * Analyze a server config file using real server data and return
 * an array of structured suggestions.
 *
 * Each suggestion: { filename, explanation, suggestedContent, diffSummary }
 *
 * @param {object}  db          - DB connection
 * @param {number}  serverId    - Server ID
 * @param {string}  filename    - e.g. 'types.xml'
 * @param {string}  fileContent - Current file content
 * @returns {Array}
 */
async function analyzeFile(db, serverId, filename, fileContent, provider) {
  const context = await buildServerContext(db, serverId);
  const completeContent = assertCompleteFileContent(fileContent);

  const prompt = `Based on the server data provided, analyze this ${filename} file and suggest up to 3 specific improvements.

For each suggestion:
1. Explain the problem or opportunity in 1-2 sentences
2. Provide the complete modified file content in a fenced code block
3. Summarize what changed in one line (e.g. "Increased M4A1 nominal from 3 to 5")

Current file content:
\`\`\`
${completeContent}
\`\`\``;

  const response = await chat([{ role: 'user', content: prompt }], context, provider);

  // Parse suggestions from the response — extract fenced blocks and their preceding text
  const suggestions = [];
  const fenceRegex = /```(?:xml|json)?\n([\s\S]*?)```/g;
  const explanationRegex = /(?:^|\n)((?:(?!```).)+)(?=\n```)/g;

  let fenceMatch;
  let explMatch;
  const contents = [];
  const explanations = [];

  while ((fenceMatch = fenceRegex.exec(response)) !== null) {
    contents.push(assertValidReplacement(filename, fenceMatch[1].trim()));
  }
  while ((explMatch = explanationRegex.exec(response)) !== null) {
    const text = explMatch[1].trim();
    if (text.length > 20) explanations.push(text);
  }

  contents.forEach((suggestedContent, i) => {
    suggestions.push({
      filename,
      explanation: explanations[i] || response.split('\n')[0],
      suggestedContent,
      diffSummary: `AI suggestion ${i + 1} for ${filename}`,
    });
  });

  // Fallback: if no fenced blocks, treat the whole response as one suggestion
  if (suggestions.length === 0) {
    suggestions.push({
      filename,
      explanation: response,
      suggestedContent: fileContent, // unchanged — owner reviews explanation
      diffSummary: 'AI recommendation (review explanation)',
    });
  }

  return suggestions;
}

/**
 * Apply a plain-English instruction to a file and return the modified content.
 * Used when the user types "double the nominal value of the M4A1" in chat.
 *
 * @param {object}  db           - DB connection
 * @param {number}  serverId     - Server ID
 * @param {string}  filename     - e.g. 'types.xml'
 * @param {string}  fileContent  - Current file content
 * @param {string}  instruction  - Plain-English edit instruction
 * @returns {{ explanation: string, editedContent: string | null }}
 */
async function applyEdit(db, serverId, filename, fileContent, instruction, provider) {
  const context = await buildServerContext(db, serverId);
  const completeContent = assertCompleteFileContent(fileContent);

  const prompt = `Apply the following instruction to this ${filename} file:

INSTRUCTION: ${instruction}

Current file content:
\`\`\`
${completeContent}
\`\`\`

Return your explanation first, then the complete modified file in a fenced code block.
Return no partial file: the fenced block must contain the complete replacement.`;

  const response = await chat([{ role: 'user', content: prompt }], context, provider);

  // Extract the edited content from the fenced block
  const fenceMatch = response.match(/```(?:xml|json)?\n([\s\S]*?)```/);
  const editedContent = fenceMatch ? assertValidReplacement(filename, fenceMatch[1].trim()) : null;

  // The explanation is everything before the first fence
  const explanation = fenceMatch
    ? response.slice(0, response.indexOf('```')).trim()
    : response;

  return { explanation, editedContent };
}

module.exports = {
  buildServerContext,
  callAiApi,
  callCopilotApi,
  callProvider,
  chat,
  analyzeFile,
  applyEdit,
  assertCompleteFileContent,
  assertValidReplacement,
};
