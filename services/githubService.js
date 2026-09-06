'use strict';

const crypto = require('crypto');
const { createExternalApiClient, ExternalApiError } = require('../utils/externalApiClient');

const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const DEFAULT_GITHUB_API_VERSION = '2026-03-10';
const DEFAULT_CACHE_TTL_MS = 15000;
const DEFAULT_CACHE_MAX_ENTRIES = 500;
const MAX_PAGES = 20;

function invalidResponse(operation) {
  return new ExternalApiError('GitHub', operation, 'invalid_response', 502);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function requireToken(token) {
  if (!token || typeof token !== 'string') throw new Error('GitHub access token is required');
  return token;
}

function segment(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) throw new Error(`Invalid GitHub ${label}`);
  return encodeURIComponent(normalized);
}

function refSegment(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.startsWith('/') || normalized.endsWith('/') ||
      normalized.includes('..') || normalized.includes('//') || normalized.includes('@{') ||
      normalized.endsWith('.lock') || !/^[A-Za-z0-9._/-]+$/.test(normalized)) {
    throw new Error(`Invalid GitHub ${label}`);
  }
  return encodeURIComponent(normalized);
}

function contentPath(filePath) {
  const normalized = String(filePath || '').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid GitHub file path');
  }
  return normalized.split('/').map(part => encodeURIComponent(part)).join('/');
}

function normalizedContentPath(filePath) {
  return String(filePath || '').replace(/^\/+/, '');
}

function decodeCanonicalBase64(value, operation) {
  const compact = value.replace(/\s/g, '');
  if (!compact || compact.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw invalidResponse(operation);
  }
  const decoded = Buffer.from(compact, 'base64');
  if (decoded.toString('base64') !== compact) throw invalidResponse(operation);
  return decoded.toString('utf8');
}

function gitBlobSha(content) {
  const bytes = Buffer.from(content);
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function validatePullRequest(data, owner, repo, base, head, operation) {
  const fullName = `${owner}/${repo}`.toLowerCase();
  const expectedUrl = `https://github.com/${owner}/${repo}/pull/${data?.number}`;
  if (data?.state !== 'open' || data?.number === undefined || data?.html_url !== expectedUrl ||
      data?.head?.ref !== head || data?.base?.ref !== base ||
      data?.head?.repo?.full_name?.toLowerCase() !== fullName ||
      data?.base?.repo?.full_name?.toLowerCase() !== fullName) {
    throw invalidResponse(operation);
  }
  return { prNumber: data.number, prUrl: data.html_url };
}

function tokenKey(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function hasNextPage(linkHeader) {
  return typeof linkHeader === 'string' && /<[^>]+>;\s*rel="next"/.test(linkHeader);
}

function normalizeRepository(repo) {
  return {
    id: repo.id,
    fullName: repo.full_name,
    name: repo.name,
    owner: repo.owner?.login || null,
    defaultBranch: repo.default_branch || null,
    private: Boolean(repo.private),
    url: repo.html_url || null,
    updatedAt: repo.updated_at || null,
  };
}

function normalizeCommit(item) {
  return {
    sha: item.sha,
    message: item.commit?.message || '',
    authorName: item.commit?.author?.name || null,
    authorLogin: item.author?.login || null,
    authoredAt: item.commit?.author?.date || null,
    url: item.html_url || null,
  };
}

function normalizeRelease(item) {
  return {
    id: item.id,
    tagName: item.tag_name,
    name: item.name || item.tag_name,
    draft: Boolean(item.draft),
    prerelease: Boolean(item.prerelease),
    publishedAt: item.published_at || null,
    url: item.html_url || null,
  };
}

function normalizeWorkflow(item) {
  return { id: item.id, name: item.name, path: item.path, state: item.state, url: item.html_url || null };
}

function normalizeWorkflowRun(item) {
  return {
    id: item.id,
    name: item.name || null,
    status: item.status || null,
    conclusion: item.conclusion || null,
    event: item.event || null,
    branch: item.head_branch || null,
    commitSha: item.head_sha || null,
    createdAt: item.created_at || null,
    updatedAt: item.updated_at || null,
    url: item.html_url || null,
  };
}

function createGitHubService(options = {}) {
  const apiBaseUrl = options.apiBaseUrl || process.env.GITHUB_API_URL || process.env.GITHUB_API_BASE_URL || DEFAULT_GITHUB_API_URL;
  const apiVersion = options.apiVersion || process.env.GITHUB_API_VERSION || DEFAULT_GITHUB_API_VERSION;
  const cacheTtlMs = positiveInteger(options.cacheTtlMs ?? process.env.GITHUB_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
  const cacheMaxEntries = positiveInteger(options.cacheMaxEntries ?? process.env.GITHUB_CACHE_MAX_ENTRIES, DEFAULT_CACHE_MAX_ENTRIES);
  const maxPages = Math.min(MAX_PAGES, positiveInteger(options.maxPages ?? process.env.GITHUB_MAX_PAGES, MAX_PAGES));
  const client = options.request
    ? { request: options.request }
    : createExternalApiClient({
      serviceName: 'GitHub',
      baseURL: apiBaseUrl,
      timeoutMs: process.env.GITHUB_API_TIMEOUT_MS || process.env.GITHUB_HTTP_TIMEOUT_MS,
      maxRetries: Number(process.env.GITHUB_API_RETRIES ?? process.env.GITHUB_HTTP_MAX_RETRIES ?? 2),
      maxRetryDelayMs: process.env.EXTERNAL_API_MAX_RETRY_DELAY_MS,
      defaultHeaders: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': apiVersion,
        'User-Agent': process.env.GITHUB_USER_AGENT || 'dayz-dashboard',
      },
    });
  const cache = new Map();
  const inflight = new Map();

  function headers(token) {
    return { Authorization: `Bearer ${requireToken(token)}` };
  }

  function request(token, config) {
    return client.request({ ...config, headers: { ...headers(token), ...(config.headers || {}) } });
  }

  async function cached(key, loader) {
    const now = Date.now();
    for (const [cacheKey, entry] of cache) if (entry.expiresAt <= now) cache.delete(cacheKey);
    const current = cache.get(key);
    if (current) return current.value;
    if (inflight.has(key)) return inflight.get(key);
    const pending = Promise.resolve().then(loader).then(value => {
      while (cache.size >= cacheMaxEntries) cache.delete(cache.keys().next().value);
      cache.set(key, { value, expiresAt: Date.now() + cacheTtlMs });
      return value;
    }).finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  }

  function clearCache(token) {
    const prefix = `${tokenKey(token)}:`;
    for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
  }

  async function paginate(token, path, params, extract) {
    const results = [];
    let page = Math.max(1, Number.parseInt(params.page, 10) || 1);
    for (let count = 0; count < maxPages; count += 1) {
      const response = await request(token, { method: 'GET', path, params: { ...params, page }, operation: `paginate ${path}` });
      const items = extract(response.data);
      if (!Array.isArray(items)) throw invalidResponse(`paginate ${path}`);
      results.push(...items);
      if (!hasNextPage(response.headers?.link)) return results;
      page += 1;
    }
    throw new Error(`GitHub pagination exceeded ${maxPages} pages`);
  }

  async function getAuthenticatedUser(token) {
    const response = await request(token, { method: 'GET', path: '/user', operation: 'get authenticated user' });
    const data = response.data;
    if (!data?.login || data.id === undefined) throw invalidResponse('get authenticated user');
    return { login: data.login, id: data.id, avatarUrl: data.avatar_url || null };
  }

  async function listRepos(token, pageOrOptions = 1, legacyPerPage = 100) {
    const options = typeof pageOrOptions === 'object' ? pageOrOptions : { page: pageOrOptions, perPage: legacyPerPage };
    const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, Number.parseInt(options.perPage, 10) || 100));
    const params = { sort: 'updated', per_page: perPage, page, affiliation: 'owner,collaborator,organization_member' };
    const key = `${tokenKey(requireToken(token))}:repos:${page}:${perPage}:${Boolean(options.allPages)}`;
    return cached(key, async () => {
      const raw = options.allPages
        ? await paginate(token, '/user/repos', params, data => data)
        : (await request(token, { method: 'GET', path: '/user/repos', params, operation: 'list repositories' })).data;
      if (!Array.isArray(raw) || raw.some(repo => repo?.id === undefined || !repo?.full_name || !repo?.name || !repo?.owner?.login)) {
        throw invalidResponse('list repositories');
      }
      return raw.map(normalizeRepository);
    });
  }

  async function getRepository(token, owner, repo) {
    const path = `/repos/${segment(owner, 'owner')}/${segment(repo, 'repository')}`;
    const expectedFullName = `${owner}/${repo}`.toLowerCase();
    const key = `${tokenKey(requireToken(token))}:${path}`;
    return cached(key, async () => {
      const data = (await request(token, { method: 'GET', path, operation: 'get repository' })).data;
      if (data?.id === undefined || data?.full_name?.toLowerCase() !== expectedFullName ||
          data?.name?.toLowerCase() !== String(repo).toLowerCase() ||
          data?.owner?.login?.toLowerCase() !== String(owner).toLowerCase()) {
        throw invalidResponse('get repository');
      }
      return normalizeRepository(data);
    });
  }

  async function listBranches(token, owner, repo) {
    const path = `/repos/${segment(owner, 'owner')}/${segment(repo, 'repository')}/branches`;
    const data = await paginate(token, path, { per_page: 100, page: 1 }, value => value);
    if (data.some(branch => !branch?.name)) throw invalidResponse('list branches');
    return data.map(branch => branch.name);
  }

  async function listCommits(token, owner, repo, options = {}) {
    const path = `/repos/${segment(owner, 'owner')}/${segment(repo, 'repository')}/commits`;
    const params = { per_page: Math.min(100, positiveInteger(options.perPage, 30)), page: positiveInteger(options.page, 1) };
    if (options.branch) params.sha = options.branch;
    const data = (await request(token, { method: 'GET', path, params, operation: 'list commits' })).data;
    if (!Array.isArray(data) || data.some(item => !item?.sha || !item?.commit || typeof item.commit.message !== 'string')) {
      throw invalidResponse('list commits');
    }
    return data.map(normalizeCommit);
  }

  async function listReleases(token, owner, repo, options = {}) {
    const path = `/repos/${segment(owner, 'owner')}/${segment(repo, 'repository')}/releases`;
    const data = (await request(token, { method: 'GET', path, params: { per_page: Math.min(100, positiveInteger(options.perPage, 30)), page: positiveInteger(options.page, 1) }, operation: 'list releases' })).data;
    if (!Array.isArray(data) || data.some(item => item?.id === undefined || !item?.tag_name)) throw invalidResponse('list releases');
    return data.map(normalizeRelease);
  }

  async function listWorkflows(token, owner, repo, options = {}) {
    const path = `/repos/${segment(owner, 'owner')}/${segment(repo, 'repository')}/actions/workflows`;
    const data = (await request(token, { method: 'GET', path, params: { per_page: Math.min(100, positiveInteger(options.perPage, 30)), page: positiveInteger(options.page, 1) }, operation: 'list workflows' })).data;
    if (!Array.isArray(data?.workflows) || data.workflows.some(item => item?.id === undefined || !item?.name || !item?.path || !item?.state)) {
      throw invalidResponse('list workflows');
    }
    return data.workflows.map(normalizeWorkflow);
  }

  async function listWorkflowRuns(token, owner, repo, workflowId, options = {}) {
    const path = `/repos/${segment(owner, 'owner')}/${segment(repo, 'repository')}/actions/workflows/${segment(workflowId, 'workflow ID')}/runs`;
    const params = { per_page: Math.min(100, positiveInteger(options.perPage, 30)), page: positiveInteger(options.page, 1) };
    if (options.branch) params.branch = options.branch;
    const data = (await request(token, { method: 'GET', path, params, operation: 'list workflow runs' })).data;
    if (!Array.isArray(data?.workflow_runs) || data.workflow_runs.some(item => item?.id === undefined || !item?.status || !item?.head_sha)) {
      throw invalidResponse('list workflow runs');
    }
    return data.workflow_runs.map(normalizeWorkflowRun);
  }


  async function getRepoFile(token, owner, repo, branch, filePath) {
    const path = `/repos/${segment(owner, 'owner')}/${segment(repo, 'repository')}/contents/${contentPath(filePath)}`;
    try {
      const data = (await request(token, { method: 'GET', path, params: { ref: branch }, operation: 'get repository file' })).data;
      if (Array.isArray(data) || !data?.sha || data?.path !== normalizedContentPath(filePath) ||
          data?.encoding !== 'base64' || typeof data.content !== 'string') throw invalidResponse('get repository file');
      const content = decodeCanonicalBase64(data.content, 'get repository file');
      if (data.sha !== gitBlobSha(content)) throw invalidResponse('get repository file');
      return { content, sha: data.sha };
    } catch (error) {
      if (error.category === 'not_found' || error.status === 404) return null;
      throw error;
    }
  }

  async function commitFile(token, owner, repo, branch, filePath, content, message, sha) {
    const path = `/repos/${segment(owner, 'owner')}/${segment(repo, 'repository')}/contents/${contentPath(filePath)}`;
    const body = { message, content: Buffer.from(content).toString('base64'), branch };
    if (sha) body.sha = sha;
    const data = (await request(token, { method: 'PUT', path, data: body, operation: 'commit repository file' })).data;
    if (!data?.commit?.sha || data?.content?.sha !== gitBlobSha(content) ||
        data.content.path !== normalizedContentPath(filePath)) {
      throw invalidResponse('commit repository file');
    }
    clearCache(token);
    return { commitSha: data.commit?.sha, fileUrl: data.content?.html_url || null };
  }

  async function createBranch(token, owner, repo, baseBranch, newBranch) {
    refSegment(newBranch, 'branch');
    const basePath = `/repos/${segment(owner, 'owner')}/${segment(repo, 'repository')}`;
    const ref = (await request(token, { method: 'GET', path: `${basePath}/git/ref/heads/${refSegment(baseBranch, 'base branch')}`, operation: 'get branch reference' })).data;
    if (ref?.ref !== `refs/heads/${baseBranch}` || !ref?.object?.sha) throw invalidResponse('get branch reference');
    const created = (await request(token, { method: 'POST', path: `${basePath}/git/refs`, data: { ref: `refs/heads/${newBranch}`, sha: ref.object.sha }, operation: 'create branch' })).data;
    if (created?.ref !== `refs/heads/${newBranch}` || created?.object?.sha !== ref.object.sha) throw invalidResponse('create branch');
    clearCache(token);
    return ref.object.sha;
  }

  async function getBranchSha(token, owner, repo, branch) {
    const basePath = `/repos/${segment(owner, 'owner')}/${segment(repo, 'repository')}`;
    try {
      const data = (await request(token, {
        method: 'GET',
        path: `${basePath}/git/ref/heads/${refSegment(branch, 'branch')}`,
        operation: 'get branch reference',
      })).data;
      if (data?.ref !== `refs/heads/${branch}` || !data?.object?.sha) throw invalidResponse('get branch reference');
      return data.object.sha;
    } catch (error) {
      if (error.category === 'not_found' || error.status === 404) return null;
      throw error;
    }
  }

  async function inspectDeterministicBranch(token, owner, repo, baseSha, headSha, filePath) {
    const repoPath = `/repos/${segment(owner, 'owner')}/${segment(repo, 'repository')}`;
    const data = (await request(token, {
      method: 'GET',
      path: `${repoPath}/compare/${segment(baseSha, 'base commit')}...${segment(headSha, 'branch commit')}`,
      operation: 'verify deterministic branch',
    })).data;
    if (!data || data.base_commit?.sha !== baseSha || data.merge_base_commit?.sha !== baseSha ||
        !Number.isInteger(data.ahead_by) || !Number.isInteger(data.behind_by) ||
        !Number.isInteger(data.total_commits) || !Array.isArray(data.commits) || !Array.isArray(data.files)) {
      throw invalidResponse('verify deterministic branch');
    }
    if (data.status === 'identical' && data.ahead_by === 0 && data.behind_by === 0 &&
        data.total_commits === 0 && data.commits.length === 0 && data.files.length === 0 && headSha === baseSha) {
      return 'identical';
    }
    const file = data.files[0];
    if (data.status === 'ahead' && data.ahead_by === 1 && data.behind_by === 0 &&
        data.total_commits === 1 && data.commits.length === 1 && data.commits[0]?.sha === headSha &&
        data.files.length === 1 && file?.filename === normalizedContentPath(filePath) &&
        ['added', 'modified'].includes(file.status)) {
      return 'intended';
    }
    throw new ExternalApiError('GitHub', 'verify deterministic branch', 'conflict', 409);
  }

  async function findOpenPR(token, owner, repo, base, head) {
    const path = `/repos/${segment(owner, 'owner')}/${segment(repo, 'repository')}/pulls`;
    const data = (await request(token, {
      method: 'GET',
      path,
      params: { state: 'open', base, head: `${owner}:${head}`, per_page: 10 },
      operation: 'find pull request',
    })).data;
    if (!Array.isArray(data) || data.some(item => item?.state !== 'open' || item?.number === undefined || typeof item?.html_url !== 'string' ||
      typeof item?.head?.ref !== 'string' || typeof item?.base?.ref !== 'string' ||
      typeof item?.head?.repo?.full_name !== 'string' || typeof item?.base?.repo?.full_name !== 'string')) {
      throw invalidResponse('find pull request');
    }
    const match = data.find(item => item.head?.ref === head && item.base?.ref === base);
    return match ? validatePullRequest(match, owner, repo, base, head, 'find pull request') : null;
  }

  async function createPR(token, owner, repo, base, head, title, body) {
    const path = `/repos/${segment(owner, 'owner')}/${segment(repo, 'repository')}/pulls`;
    const data = (await request(token, { method: 'POST', path, data: { title, body, head, base }, operation: 'create pull request' })).data;
    const pullRequest = validatePullRequest(data, owner, repo, base, head, 'create pull request');
    clearCache(token);
    return pullRequest;
  }

  async function commitAndCreatePR(token, owner, repo, baseBranch, filePath, newContent, commitMsg, prTitle, prBody, options = {}) {
    const branchName = options.branchName || `ai-edit/${Date.now()}`;
    refSegment(branchName, 'branch');
    const baseSha = await getBranchSha(token, owner, repo, baseBranch);
    if (!baseSha) throw new ExternalApiError('GitHub', 'verify base branch', 'not_found', 404);
    if (Object.prototype.hasOwnProperty.call(options, 'expectedOriginalContent')) {
      const baseFile = await getRepoFile(token, owner, repo, baseSha, filePath);
      if (baseFile?.content !== options.expectedOriginalContent) {
        throw new ExternalApiError('GitHub', 'verify repository file freshness', 'conflict', 409);
      }
    }
    let branchSha = await getBranchSha(token, owner, repo, branchName);
    if (branchSha) {
      const branchState = await inspectDeterministicBranch(token, owner, repo, baseSha, branchSha, filePath);
      const existing = await getRepoFile(token, owner, repo, branchName, filePath);
      if (branchState === 'intended') {
        if (existing?.content !== newContent) {
          throw new ExternalApiError('GitHub', 'verify deterministic branch content', 'conflict', 409);
        }
        const existingPR = await findOpenPR(token, owner, repo, baseBranch, branchName);
        const pullRequest = existingPR || await createPR(token, owner, repo, baseBranch, branchName, prTitle, prBody);
        if (await getBranchSha(token, owner, repo, branchName) !== branchSha) {
          throw new ExternalApiError('GitHub', 'verify pull request branch head', 'conflict', 409);
        }
        return { prUrl: pullRequest.prUrl, branchName, commitSha: null };
      }
    }
    if (!branchSha) {
      const createdFromSha = await createBranch(token, owner, repo, baseBranch, branchName);
      if (createdFromSha !== baseSha) throw new ExternalApiError('GitHub', 'verify created branch base', 'conflict', 409);
      branchSha = baseSha;
    }
    const existing = await getRepoFile(token, owner, repo, branchName, filePath);
    let commitSha = null;
    if (!existing || existing.content !== newContent) {
      ({ commitSha } = await commitFile(token, owner, repo, branchName, filePath, newContent, commitMsg, existing?.sha));
      branchSha = commitSha;
    }
    const branchState = await inspectDeterministicBranch(token, owner, repo, baseSha, branchSha, filePath);
    if (branchState !== 'intended') throw new ExternalApiError('GitHub', 'verify deterministic branch', 'conflict', 409);
    const existingPR = await findOpenPR(token, owner, repo, baseBranch, branchName);
    const pullRequest = existingPR || await createPR(token, owner, repo, baseBranch, branchName, prTitle, prBody);
    if (await getBranchSha(token, owner, repo, branchName) !== branchSha) {
      throw new ExternalApiError('GitHub', 'verify pull request branch head', 'conflict', 409);
    }
    return { prUrl: pullRequest.prUrl, branchName, commitSha };
  }

  return {
    getAuthenticatedUser, listRepos, getRepository, listBranches, listCommits, listReleases,
    listWorkflows, listWorkflowRuns, getRepoFile, commitFile, createBranch,
    createPR, commitAndCreatePR, clearCache,
  };
}

const githubService = createGitHubService();
module.exports = Object.assign(githubService, {
  DEFAULT_GITHUB_API_URL,
  DEFAULT_GITHUB_API_VERSION,
  createGitHubService,
  normalizeCommit,
  normalizeRelease,
  normalizeRepository,
  normalizeWorkflow,
  normalizeWorkflowRun,
});
