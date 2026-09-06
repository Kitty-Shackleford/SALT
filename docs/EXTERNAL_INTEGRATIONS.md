# Nitrado and GitHub integrations

The dashboard keeps both integrations server-side. Browser code calls authenticated DayZ Dashboard routes; it never receives a Nitrado token or GitHub PAT.

Official references:

- Nitrado API: https://doc.nitrado.net/
- GitHub REST API: https://docs.github.com/en/rest?apiVersion=2026-03-10
- GitHub authentication: https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api?apiVersion=2026-03-10
- GitHub rate limits: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2026-03-10
- GitHub pagination: https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api?apiVersion=2026-03-10

## Credentials and authorization

### Nitrado

A guild owner/admin registers a Nitrado long-life token through the dashboard or Discord bot. The backend validates both `/user` and `/services`, binds the immutable Nitrado user ID to the guild, encrypts the token with `ENCRYPTION_KEY`, and stores it in `guild_tokens`. A server can be registered only when its service ID is returned for that bound account.

The token must be able to read the account's services and perform the game-server/file operations enabled by the dashboard. Create and revoke tokens in Nitrado's developer portal. Tokens are never returned by an API route or logged.

### GitHub

Each approved dashboard operator connects a GitHub PAT from the AI Assistant page. The backend validates `/user`, encrypts the PAT with `ENCRYPTION_KEY`, and stores it in `github_connections`. Repository links are scoped to an exact registered DayZ server and are validated against the configured branch.

Prefer a fine-grained PAT restricted to the repositories the operator will link. Read-only status requires repository Metadata, Contents, and Actions read access. Creating branches/files/pull requests requires Contents and Pull requests write access. A classic PAT requires the equivalent repository access and should be avoided when a fine-grained PAT is sufficient.

GitHub requests send `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2026-03-10`, and a non-secret User-Agent.

### AI inference

GitHub Models was retired on July 30, 2026 and is not used. Each operator can choose one of two supported inference paths from the AI Assistant page:

1. Supply an OpenAI-compatible provider URL, model, and token. The backend verifies the connection before encrypting the token in `ai_provider_connections`; the token is never returned to the browser.
2. Use the official GitHub Copilot SDK with the operator's separately connected GitHub identity and Copilot subscription. Copilot runs in multi-user `empty` mode with a unique disposable session directory, a per-session user token, and no tools or ambient filesystem access. GitHub documents OAuth/GitHub App user tokens and personal fine-grained `github_pat_` tokens with the account-level **Copilot Requests** permission as supported; classic `ghp_` tokens are rejected.

An operator-supplied `AI_API_KEY` remains a deployment-wide fallback only when a user has not selected a personal provider. Personal provider URLs must use an approved exact hostname to prevent server-side request forgery; extend the default public-provider list with `AI_USER_PROVIDER_ALLOWED_HOSTS`. User-provider requests disable redirects and reject DNS results in private, loopback, link-local, reserved, or multicast ranges. Plaintext HTTP is accepted by the transport only for explicitly allow-listed loopback providers.

AI requests are bounded to 24 messages with at most 12,000 characters per message,
100,000 characters of persisted conversation history, and 40,000 characters for a
single analyzed or replacement file. Provider output defaults to 16,384 tokens
(configurable up to 32,768), and truncated completions are rejected rather than
persisted as full-file replacements.

## Service layer

- `utils/externalApiClient.js`: same-origin request construction, finite timeouts, safe errors, structured failure logging, retry classification, `Retry-After`/rate-reset handling, and cancellation signal forwarding.
- `utils/nitradoHttp.js`: compatibility client for existing backend and bot file/stream operations. It applies the configured Nitrado origin, finite timeouts, sanitized errors, cancellation, and bounded idempotent-read retries to legacy Axios and fetch callers; mutations are never automatically retried.
- `services/nitradoService.js`: authentication, services, normalized DayZ status/players, settings, actions, console commands, notifications, stats, logs, and scheduled tasks.
- `services/githubService.js`: authentication, repositories, branches, commits, releases, workflows/runs, contents, branch/file writes, and pull requests.
- `utils/externalApiResponse.js`: safe client-facing error categories without upstream bodies, headers, tokens, or stack traces.

Only idempotent reads are retried. Authentication/client failures and writes are not blindly retried. Provider-directed delays beyond the configured ceiling are returned to callers rather than retried early. Read caches are entry-bounded, remove expired entries, coalesce duplicate in-flight requests, and are invalidated by relevant mutations.

## Internal API routes

All routes require an authenticated user in an approved guild. Exact-server routes also use the existing server ownership/operator guard.

### Nitrado

- `GET /api/nitrado/servers`
- Existing `/api/control`, `/api/nitrado/settings`, `/api/tasks`, `/api/stats`, `/api/activity`, and `/api/console` operations use `NitradoService`.

Server control, setting changes, task mutations, and console commands retain their existing role and exact-server authorization checks plus CSRF protection for state-changing requests.

### GitHub

- `GET /api/ai/repos`
- `GET /api/ai/repos/:owner/:repo/branches`
- `GET /api/ai/server/:platformServerId/github/repository`
- `GET /api/ai/server/:platformServerId/github/commits`
- `GET /api/ai/server/:platformServerId/github/releases`
- `GET /api/ai/server/:platformServerId/github/workflows`
- `GET /api/ai/server/:platformServerId/github/workflows/:workflowId/runs`
- `GET /api/ai/server/:platformServerId/github/integration`
Repository branch/file/PR operations used by suggestion finalization remain server-side. Workflow dispatch is intentionally not exposed because the dashboard currently requires read-only workflow status, and replay-safe dispatch semantics would require durable idempotency.

The optional user-owned automation kit, manifest contract, GitHub Pages design, permissions, and failure model are documented in `docs/GITHUB_ACTIONS_AUTOMATION_KIT.md`. Those workflows run in the server owner's repository and call Nitrado directly; the dashboard is a consumer, not a runtime dependency.

## Environment configuration

Nitrado tokens, GitHub tokens, and personal AI-provider tokens are entered through authenticated application flows and encrypted at rest. The optional deployment-wide AI credential is supplied server-side through `AI_API_KEY`; no credential is returned to the browser.

| Variable | Default | Purpose |
|---|---:|---|
| `NITRADO_API_BASE_URL` | `https://api.nitrado.net` | Nitrado REST origin |
| `NITRADO_HTTP_TIMEOUT_MS` | `15000` | Nitrado request timeout |
| `NITRADO_API_RETRIES` | `2` | Maximum retries for retryable reads |
| `NITRADO_CACHE_TTL_MS` | `10000` | Operational read cache TTL |
| `NITRADO_CACHE_MAX_ENTRIES` | `500` | Process-local Nitrado cache entry limit |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub REST origin |
| `GITHUB_API_VERSION` | `2026-03-10` | GitHub REST API version header |
| `GITHUB_API_TIMEOUT_MS` | `15000` | GitHub request timeout |
| `GITHUB_API_RETRIES` | `2` | Maximum retries for retryable reads |
| `GITHUB_CACHE_TTL_MS` | `15000` | GitHub read cache TTL |
| `GITHUB_CACHE_MAX_ENTRIES` | `500` | Process-local GitHub cache entry limit |
| `GITHUB_MAX_PAGES` | `20` | Pagination safety limit |
| `EXTERNAL_API_MAX_RETRY_DELAY_MS` | `30000` | Retry delay ceiling |
| `AI_API_BASE_URL` | `https://api.openai.com/v1/` | Optional deployment-wide OpenAI-compatible fallback origin |
| `AI_API_KEY` | — | Optional deployment-wide fallback credential |
| `AI_MODEL` | `gpt-4o-mini` | Deployment-wide fallback model |
| `AI_API_TIMEOUT_MS` | `60000` | OpenAI-compatible request timeout |
| `AI_USER_PROVIDER_ALLOWED_HOSTS` | known public providers | Additional comma-separated exact hostnames users may configure |

Legacy `NITRADO_HTTP_MAX_RETRIES`, `GITHUB_API_BASE_URL`, `GITHUB_HTTP_TIMEOUT_MS`, and `GITHUB_HTTP_MAX_RETRIES` remain accepted.

## Error behavior

Internal routes distinguish authentication failure, rate limiting, missing resources, invalid requests, upstream failure, network failure, and timeout. Responses contain a stable `code` and `category`; rate-limit responses include a safe `Retry-After` value. Upstream payloads, authorization headers, credentials, stack traces, and connection details are not returned.

A failed Nitrado/GitHub request does not imply that the DayZ Dashboard itself is unhealthy. The affected integration route reports the external-service category while ordinary application routes remain available.

## Caching, polling, and webhooks

Operational reads use short process-local caches and duplicate-request coalescing. Existing background status/log schedules remain authoritative and are not replaced by per-render browser polling. Mutations invalidate the relevant cache.

No new webhook endpoint is installed. GitHub status is currently loaded on demand in an authenticated operator workflow, and the application has no durable webhook-delivery queue. Adding a public webhook receiver without that operational requirement would increase attack surface. If event-driven updates become required, add signature verification, delivery-ID deduplication, and durable idempotent processing first.

## Tests

Run:

```sh
npm test
npm run lint
npm run build:css
```

`scripts/external-integrations-test.js` uses injected transports; it never calls live Nitrado or GitHub accounts. It covers credentials, normalization, actions, retries, rate limits, timeouts, non-retryable writes, GitHub pagination, and route/service boundaries.

## Troubleshooting

- `*_AUTHENTICATION`: reconnect/re-register the credential and verify its repository/service access.
- `*_RATE_LIMITED`: wait for `Retry-After`; reduce polling or inspect the provider account's limits.
- `*_TIMEOUT` / `*_NETWORK`: verify outbound DNS/HTTPS and proxy/firewall rules.
- `*_NOT_FOUND`: verify the exact Nitrado service ID or GitHub owner/repository/branch/workflow ID.
- `*_UPSTREAM`: retry later and inspect structured server logs by service, operation, status, duration, and category.

Never troubleshoot by printing a token, decrypted credential, request Authorization header, session cookie, or database connection string.
