'use strict';

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ACTIONS = 20;
const MAX_CAPABILITIES = 100;
const ALLOWED_CAPABILITY = /^[a-z][a-z0-9_]{0,63}$/;
const ALLOWED_ACTION_ID = /^[a-z][a-z0-9-]{0,63}$/;
const ALLOWED_REPO_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function requiredString(value, label, max = 255) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`Invalid integration manifest ${label}`);
  }
  return value.trim();
}

function requireOnlyKeys(value, allowed, label) {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error(`Invalid integration manifest ${label}`);
  }
}

function stringList(value, label, pattern, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Invalid integration manifest ${label}`);
  const normalized = value.map(item => requiredString(item, label, 128));
  if (normalized.some(item => !pattern.test(item)) || new Set(normalized).size !== normalized.length) {
    throw new Error(`Invalid integration manifest ${label}`);
  }
  return normalized;
}

function repositoryPath(value, label) {
  const normalized = requiredString(value, label, 512);
  if (!ALLOWED_REPO_PATH.test(normalized)) throw new Error(`Invalid integration manifest ${label}`);
  return normalized;
}

function optionalHttpsUrl(value, label) {
  if (value === undefined || value === null) return null;
  const normalized = requiredString(value, label, 2048);
  let parsed;
  try { parsed = new URL(normalized); } catch (_) { throw new Error(`Invalid integration manifest ${label}`); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error(`Invalid integration manifest ${label}`);
  }
  return parsed.toString();
}

function isoDate(value, label) {
  const normalized = requiredString(value, label, 64);
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) {
    throw new Error(`Invalid integration manifest ${label}`);
  }
  return normalized;
}

function parseIntegrationManifest(content, options = {}) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_MANIFEST_BYTES) {
    throw new Error('Invalid integration manifest size');
  }
  let value;
  try { value = JSON.parse(content); } catch (_) { throw new Error('Invalid integration manifest JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema_version !== 1 || value.platform !== 'dayz') {
    throw new Error('Unsupported integration manifest');
  }
  requireOnlyKeys(value, [
    '$schema', 'schema_version', 'platform', 'server_id', 'integration_version',
    'generated_at', 'pages_url', 'capabilities', 'data_endpoints', 'actions',
  ], 'properties');
  if (value.$schema !== undefined && typeof value.$schema !== 'string') {
    throw new Error('Invalid integration manifest schema URL');
  }

  const serverId = requiredString(value.server_id, 'server ID', 128);
  if (options.expectedServerId !== undefined && serverId !== String(options.expectedServerId)) {
    throw new Error('Integration manifest server ID does not match the selected server');
  }
  const capabilities = stringList(value.capabilities, 'capabilities', ALLOWED_CAPABILITY, MAX_CAPABILITIES);
  if (!Array.isArray(value.actions) || value.actions.length > MAX_ACTIONS) throw new Error('Invalid integration manifest actions');
  if (!Array.isArray(value.data_endpoints) || value.data_endpoints.length > 100) throw new Error('Invalid integration manifest data endpoints');

  const actions = value.actions.map(action => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('Invalid integration manifest action');
    requireOnlyKeys(action, [
      'id', 'name', 'version', 'workflow', 'capabilities', 'data_outputs', 'expected_interval_minutes',
    ], 'action properties');
    const actionVersion = requiredString(action.version, 'action version', 32);
    if (!SEMVER.test(actionVersion)) throw new Error('Invalid integration manifest action version');
    const expectedInterval = action.expected_interval_minutes;
    if (expectedInterval !== undefined && (!Number.isInteger(expectedInterval)
        || expectedInterval < 1 || expectedInterval > 10080)) {
      throw new Error('Invalid integration manifest action expected interval');
    }
    return {
      id: requiredString(action.id, 'action ID', 64),
      name: requiredString(action.name, 'action name', 128),
      version: actionVersion,
      workflow: repositoryPath(action.workflow, 'workflow path'),
      capabilities: stringList(action.capabilities, 'action capabilities', ALLOWED_CAPABILITY, MAX_CAPABILITIES),
      dataOutputs: stringList(action.data_outputs, 'data outputs', ALLOWED_REPO_PATH, 100),
      expectedIntervalMinutes: expectedInterval ?? null,
    };
  });
  if (actions.some(action => !ALLOWED_ACTION_ID.test(action.id)) || new Set(actions.map(action => action.id)).size !== actions.length) {
    throw new Error('Invalid integration manifest action IDs');
  }
  if (actions.some(action => action.capabilities.some(capability => !capabilities.includes(capability)))) {
    throw new Error('Invalid integration manifest action capabilities');
  }

  const dataEndpoints = value.data_endpoints.map(endpoint => {
    if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) throw new Error('Invalid integration manifest data endpoint');
    requireOnlyKeys(endpoint, ['name', 'path', 'format'], 'data endpoint properties');
    const format = requiredString(endpoint.format, 'data endpoint format', 16);
    if (!['json', 'jsonl', 'csv', 'markdown'].includes(format)) throw new Error('Invalid integration manifest data endpoint format');
    return {
      name: requiredString(endpoint.name, 'data endpoint name', 64),
      path: repositoryPath(endpoint.path, 'data endpoint path'),
      format,
    };
  });
  if (new Set(dataEndpoints.map(endpoint => endpoint.name)).size !== dataEndpoints.length
      || new Set(dataEndpoints.map(endpoint => endpoint.path)).size !== dataEndpoints.length) {
    throw new Error('Invalid integration manifest duplicate data endpoints');
  }

  const integrationVersion = requiredString(value.integration_version, 'version', 32);
  if (!SEMVER.test(integrationVersion)) throw new Error('Invalid integration manifest version');

  return {
    schemaVersion: 1,
    platform: 'dayz',
    serverId,
    integrationVersion,
    generatedAt: isoDate(value.generated_at, 'generated timestamp'),
    capabilities,
    dataEndpoints,
    actions,
    pagesUrl: optionalHttpsUrl(value.pages_url, 'Pages URL'),
  };
}

function actionHealth(action, workflow, now) {
  if (!workflow) return { ...action, status: 'not_installed', lastRun: null, conclusion: null };
  if (workflow.state === 'missing') return { ...action, status: 'not_installed', lastRun: null, conclusion: null };
  if (workflow.state !== 'active') return { ...action, status: 'disabled', lastRun: null, conclusion: null };
  const run = workflow.run || null;
  if (!run) return { ...action, status: 'unknown', lastRun: null, conclusion: null };
  if (run.status !== 'completed') return { ...action, status: 'running', lastRun: run.updatedAt || null, conclusion: null };
  if (run.conclusion !== 'success') return { ...action, status: 'failing', lastRun: run.updatedAt || null, conclusion: run.conclusion || null };
  const lastRunMs = new Date(run.updatedAt).getTime();
  if (!Number.isFinite(lastRunMs)) return { ...action, status: 'unknown', lastRun: null, conclusion: run.conclusion };
  const staleAfterMs = action.expectedIntervalMinutes ? action.expectedIntervalMinutes * 3 * 60000 : null;
  const status = staleAfterMs && Number.isFinite(lastRunMs) && now.getTime() - lastRunMs > staleAfterMs ? 'stale' : 'healthy';
  return { ...action, status, lastRun: run.updatedAt || null, conclusion: run.conclusion };
}

function summarizeIntegrationHealth(manifest, workflows = [], now = new Date()) {
  const byPath = new Map(workflows.map(workflow => [workflow.path, workflow]));
  const actions = manifest.actions.map(action => actionHealth(action, byPath.get(action.workflow), now));
  const statuses = new Set(actions.map(action => action.status));
  let status = 'unknown';
  if (statuses.has('failing')) status = 'failing';
  else if (statuses.has('running')) status = 'running';
  else if (statuses.has('stale')) status = 'stale';
  else if (actions.length && [...statuses].every(item => item === 'healthy')) status = 'healthy';
  else if (actions.length && [...statuses].every(item => item === 'disabled')) status = 'disabled';
  else if (statuses.has('healthy')) status = 'partial';
  else if (actions.length && [...statuses].every(item => item === 'not_installed')) status = 'not_installed';
  return { installed: true, status, generatedAt: manifest.generatedAt, capabilities: manifest.capabilities, actions };
}

async function inspectGitHubActionsIntegration(options) {
  const { github, token, owner, repo, branch, expectedServerId } = options;
  const repository = await github.getRepository(token, owner, repo);
  const manifestFile = await github.getRepoFile(token, owner, repo, branch, 'dayz-integration.json');
  if (!manifestFile) return { installed: false, status: 'not_installed', repository, branch };
  const manifest = parseIntegrationManifest(manifestFile.content, { expectedServerId });
  const workflows = await github.listWorkflows(token, owner, repo, { perPage: 100 });
  const actionWorkflows = [];
  for (let index = 0; index < manifest.actions.length; index += 4) {
    const batch = await Promise.all(manifest.actions.slice(index, index + 4).map(async action => {
      const workflow = workflows.find(item => item.path === action.workflow);
      if (!workflow) return { path: action.workflow, state: 'missing', run: null };
      try {
        const runs = await github.listWorkflowRuns(token, owner, repo, workflow.id, { branch, perPage: 1 });
        return { path: workflow.path, state: workflow.state, run: runs[0] || null };
      } catch (_) {
        return { path: workflow.path, state: workflow.state, run: null, error: 'run_status_unavailable' };
      }
    }));
    actionWorkflows.push(...batch);
  }
  return {
    repository,
    branch,
    manifest,
    ...summarizeIntegrationHealth(manifest, actionWorkflows, options.now || new Date()),
  };
}

module.exports = {
  parseIntegrationManifest,
  summarizeIntegrationHealth,
  inspectGitHubActionsIntegration,
};
