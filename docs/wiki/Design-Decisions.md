# Design Decisions

**Status: CONFIRMED unless an entry says otherwise**

**Verified against TESTING revision:** `6db37fa97e471ddb39e207e160ad28de33618e26`

## Decision: Separate TESTING and STABLE repositories

### Context

The private codebase contains experimentation, operational context, unreleased work, private assets, and history that is not automatically suitable for public release.

### Decision

Treat private `dayz-dashboard` as TESTING and public `SALT` as STABLE. Promote selected, sanitized, reviewed changes; never mirror or blindly merge the repositories.

### Consequences

Public candidates require history inspection, path-by-path classification, exact-scope review, and explicit approval. The public Wiki documents STABLE, not TESTING.

## Decision: Separate backend and bot processes

### Context

The web dashboard and Discord bot have different runtime responsibilities and dependency boundaries.

### Decision

Run them as separate containers/processes that coordinate through PostgreSQL, not internal HTTP.

### Consequences

The bot has its own package manifest. Its image copies selected root `utils/`, `services/`, and `db/`, so shared-code changes may require both images to be rebuilt and tested.

## Decision: PostgreSQL is authoritative

### Context

Tenant, identity, financial, queue, migration, and session integrity require one transactional authority.

### Decision

PostgreSQL is the only supported database. Fresh installs create Schema V2; unsupported/legacy conversion fails closed; incremental migrations run under an advisory lock and transaction.

### Consequences

Do not add SQLite compatibility paths. Do not run production migrations without backup, rehearsal, exact scope, and approval.

## Decision: Authorization is exact-server and capability based

### Context

Guild membership alone does not prove authority over every server, player, provider credential, or financial resource in that guild.

### Decision

Resolve actor, approved guild, exact active server, role/membership, and allow-listed capability into canonical trusted context. Recheck authority for consequential mutations.

### Consequences

Client identifiers are selectors, not proof. List queries must be actor-scoped. Ambiguous resources fail closed. Broad middleware such as `ensureApproved` is only a precondition when a handler accepts a specific resource ID.

## Decision: Nitrado credentials are guild-bound and server-side

### Context

Per-user token handling created duplication and weaker tenant semantics.

### Decision

Bind Nitrado credentials to a guild and stable provider account, encrypt them at rest, and expose only connection/status information to clients.

### Consequences

A service can be registered only after provider discovery and exact authorization. Browser code never receives the token.

## Decision: Filesystem access is descriptor anchored

### Context

Mission and backup paths include externally influenced identifiers, and lexical containment alone is vulnerable to symlink races.

### Decision

Use strict identifier validation, canonical roots, `O_NOFOLLOW`, and descriptor-anchored open/read/list/stat/write operations.

### Consequences

Do not replace `utils/safePath.js` usage with string-prefix checks or ordinary path joins. Preserve authorized root selection through the entire operation.

## Decision: Financial values use exact representations

### Context

Binary floating-point and ambiguous cross-server ownership can corrupt balances, supply, refunds, bounties, and settlements.

### Decision

Use exact decimal/integer representations, exact-server scope, transactions, idempotency, and immutable evidence.

### Consequences

Never infer or duplicate balances during migration. Conflicts, replay, overflow, and ambiguous ownership fail closed.

## Decision: Static HTML is not an authorization boundary

### Context

Serving privileged HTML directly can bypass route-level access checks even if API calls remain protected.

### Decision

Static delivery is assets-only. Canonical handlers authorize and render HTML with CSRF context; direct `.html` requests are blocked.

### Consequences

New pages need explicit routes and tests. Do not expose a page merely by placing it under `public/`.

## Decision: Background work remains single-process unless coordinated

**Status: CONFIRMED current constraint**

### Context

Some scheduler overlap guards and file locks are process-local.

### Decision

Operate one authoritative scheduler/backend process unless a job has durable PostgreSQL coordination.

### Consequences

Horizontal scaling requires per-job review and database-backed claim/lease/lock semantics before adding replicas.

## Source anchors

- `Dockerfile.bot`
- `docker-compose.yml`
- `db/schema.js`
- `db/migrationRunnerPg.js`
- `services/authorizationService.js`
- `utils/safePath.js`
- `utils/money.js`
- `src/app/registerMiddleware.js`
- `docs/multi-tenant-authorization.md`
