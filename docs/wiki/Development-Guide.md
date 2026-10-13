# Development Guide

**Status: CONFIRMED**

**Verified against TESTING revision:** `6db37fa97e471ddb39e207e160ad28de33618e26`

## Understand before modifying

Before a substantial change:

1. Read the relevant source, tests, and Wiki pages.
2. Trace a symbol to its definition and usages.
3. Search for existing routes, services, utilities, scripts, and documentation.
4. Identify tenant, exact-server, persistence, money, filesystem, and provider boundaries.
5. State the smallest coherent change and meaningful failure behavior.

Prefer:

`reuse → extend → focused refactor → create`

Do not treat a TODO, roadmap item, old plan, audit snapshot, or abandoned file as a current requirement.

## Where code belongs

### New API endpoint

1. Add the handler to the appropriate `routes/` module.
2. Put reusable business/provider logic in `services/`.
3. Apply authentication and capability middleware at the correct boundary.
4. Ensure state-changing requests retain global CSRF protection.
5. Mount a new router through `src/app/registerRoutes.js`.
6. Add focused behavior and authorization tests.

### New dashboard page

1. Reuse an existing page and browser module when practical.
2. Put canonical HTML under `public/` and browser JavaScript under `public/js/`.
3. Serve HTML through an explicit authorized route with `renderWithCsrf`; static `.html` delivery is intentionally blocked.
4. Use DOM-safe output APIs (`textContent`, element construction) for untrusted content.
5. Update the UI surface manifest and contract tests when the surface changes.
6. Rebuild committed Tailwind output only when source/configuration changes are intended and reviewed.

### New bot command

1. Add a command under `bot/commands/` exporting `data` and `execute`.
2. Define and test its guild/server authorization classification.
3. Add dependencies to `bot/package.json`, not the root package, unless root code also imports them.
4. Redeploy slash-command registration and verify the registered command shape.
5. Rebuild the bot image when bot code or copied shared modules change.

### Database change

1. Enumerate all files under `db/migrations/`; never infer the next number from documentation.
2. Create the next unused numbered migration.
3. Use PostgreSQL-compatible, transactional, rerunnable behavior.
4. Fail closed on ambiguous ownership, tenant, identity, or financial data.
5. Add migration and runtime behavior tests.
6. Never execute a production migration without explicit approval and a verified backup.

## Frontend conventions

The frontend is vanilla JavaScript plus Tailwind and Leaflet; there is no client framework. Page scripts fetch REST endpoints and update the DOM manually. Async UI work must guard against stale context and out-of-order responses when guild/server selection can change.

Avoid inline script and event-handler attributes because the content security policy blocks them. Prefer existing CSRF-aware fetch helpers and canonical route rendering.

## External calls

Use established provider clients. Requests need finite timeouts, sanitized errors, cancellation where available, and bounded retry logic. Retry only safe idempotent reads; do not blindly retry writes or provider mutations.

Nitrado file paths are provider- and platform-specific. Discover the authoritative game root and preserve the `/noftp/dayz*` platform prefix. Do not invent bare mission paths.

## Scope discipline

Keep feature work separate from unrelated cleanup, dependency upgrades, formatting, generated output, and architecture rewrites. Large active modules should be decomposed only along tested seams needed by current work—never through a broad rewrite merely because a file is large.

Remove temporary artifacts before review. Do not commit local plans, logs, downloaded provider data, credentials, database dumps, or generated junk.

## Canonical local setup

The supported runtime is Node.js 22 (`>=22 <23`). Install exact dependencies with:

```bash
npm ci
npm ci --prefix bot
```

For an isolated full local stack:

```bash
npm run local:setup
npm run local:up
npm run local:commands
npm run local:ps
```

The local stack can call real Discord and Nitrado services when configured; it is isolated, not mocked. Use dedicated test identities and infrastructure.

## Source anchors

- `package.json`
- `bot/package.json`
- `README.md`
- `src/app/registerRoutes.js`
- `src/app/registerMiddleware.js`
- `utils/renderWithCsrf.js`
- `artifacts/ui-surface-manifest.json`
- `.github/workflows/ci.yml`
