# Current State

Audit snapshot: 2026-09-05
Audited revision: `e8266049b15e4de2dd0866026e166a66541092c5` (`main`, equal to `origin/main`)
Documentation state: this audit includes uncommitted working-tree documents and edits; it is not an exact staged release candidate or release-review artifact.
Package version: `1.0.0`
Git release tags: none
Release status: **NOT READY** (repository checks pass; runtime, database, restore, and release-candidate gates remain)

## Project

DayZ Dashboard is a self-hosted Node.js system for operating DayZ servers. It combines an Express dashboard, a separate Discord bot, PostgreSQL, scheduled/background work, Nitrado integration, mission-file tooling, log parsing, player features, and an in-game economy.

The codebase is active and broad rather than abandoned: recent work has concentrated on exact-server authorization, financial integrity, provider mutation recovery, mission initialization, shop provisioning, and release hardening.

## Architecture

Runtime boundaries:

1. `server.js` validates the web environment, initializes PostgreSQL, builds the Express app, and starts the scheduler, economy scheduler, feed processor, and optional telemetry exporter.
2. `src/app/` assembles middleware and routes. `src/app/registerRoutes.js` is the main route-composition file.
3. `routes/` contains HTTP handlers; `services/` contains most shared business and provider logic; `middleware/` owns authentication, authorization, validation, CSRF, and request limits.
4. `bot/` is a separately packaged Discord.js process. It shares PostgreSQL and selected root `services/`, `utils/`, and `db/` code but does not call the web process.
5. `db/schema.js`, `db/schema-v2.js`, and `db/migrationRunnerPg.js` create and migrate the PostgreSQL schema. Migrations are serialized with a PostgreSQL advisory lock.
6. `scheduler.js` and `workers/feedProcessor.js` provide active scheduled/queue work. `src/events/worker.js` is a dormant projection-worker skeleton with no runtime registration/startup path found.
7. `public/` contains server-rendered/static HTML, vanilla browser JavaScript, Tailwind output, Leaflet assets, and bundled map tiles.
8. Nitrado, Discord, GitHub, and configured AI providers are external trust boundaries. PostgreSQL is the authoritative application store; downloaded provider files under `downloads/` are runtime evidence/cache.

The current architecture is a pragmatic layered monolith plus a separate bot. It is coherent, but some route, browser, and service files have grown large enough to weaken change isolation.

## Major Modules

- Identity and access: Discord OAuth, PostgreSQL sessions, guild roles, exact-server capability checks, linked player identities.
- Server operations: registration, status, control, automation, rotations, backups, console, logs, and health.
- Mission management: file editor, validation, managed mission initialization, provider mutation/recovery, GitHub actions/config integration.
- Player systems: portal, maps, radar, sessions, statistics, achievements, factions, bounties, and teleports.
- Economy: wallets, banks, casino, shop, orders, rentals, fixed-supply controls, and immutable transaction/history protections.
- Discord: status updates, slash commands, feeds, role automation, and server management commands.
- Observability: health/readiness routes, event-health views, logging, and optional telemetry.

## Working Features

The following are implemented and have meaningful automated regression coverage at this revision:

- PostgreSQL-only bootstrap and ordered migrations.
- Discord OAuth/session flow and centralized dashboard-owner reconciliation.
- Tenant, guild, and exact-server authorization boundaries.
- Server registration and Nitrado-backed discovery/read operations.
- Log synchronization/parsing, restart evidence, player/session data, and feed queue processing.
- Mission file editing, locking, validation, managed mission initialization, and provider mutation recovery.
- Economy, casino, bounties, shop checkout/refunds/rentals, object-spawner/event provisioning, and exact-money protections.
- Player portal/account linking, statistics, maps, factions, radar, and teleport workflows.
- Discord bot commands, status updates, autocomplete, and linked dashboard functionality.
- UI route/capability manifest generation and contract checks.

“Working” here means implemented and locally covered. It does not mean every provider mutation or browser workflow was live-tested during this audit.

## Partially Implemented or Incomplete Features

- `scheduler.js`: weekly AI analysis is scheduled, but automatic provider-file download and analysis is explicitly skipped.
- `utils/territoryRewards.js`: the scheduler and payout implementation remain a dormant no-op placeholder. The admin controls are now visibly disabled, reads report the feature unsupported/disabled, and write attempts are rejected until an authoritative ownership model exists.
- `src/events/worker.js`: the projection-worker skeleton has no runtime registration/startup path, and it advances its checkpoint after handler failures; it is not ready to integrate or enable as a durable projection system.
- `src/app/registerRoutes.js`: authenticated `/api/public/servers` is a placeholder that always returns an empty list.
- Recurring rotation behavior is only partly represented; scheduler comments state that full recurring activation tracking is still required.
- Eight legacy/unrouted HTML documents remain in `public/`; canonical replacements exist, but behavioral parity has not been proven for every page.

## Known Broken Areas

- The checked-in Tailwind output is not reproducible from the current source/configuration; a clean build changes `public/css/tailwind.css`.

## Known Technical Debt

See `TECH_DEBT.md`. Highest-value themes are:

- fix or explicitly disable incomplete surfaced features;
- complete PostgreSQL-backed release rehearsals and runtime smoke tests;
- add durable failure semantics before enabling the generic event worker;
- reduce oversized route/browser modules along change boundaries, not through broad rewrites;
- bring the large operational `scripts/` surface under systematic lint/test ownership;
- reconcile stale documentation and historical AI planning artifacts;
- standardize dependency versions across root and bot packages where practical.

## Testing Status

Verified locally on 2026-09-05:

- `npm run test`: **PASS**.
- `npm run lint`: **PASS**.
- `npm run security:audit`: **PASS**, no potential secrets found in 3,726 scanned source files.
- Root `npm audit --json`: **PASS**, zero reported vulnerabilities.
- Bot `npm audit --prefix bot --json`: **PASS**, zero reported vulnerabilities.
- `node scripts/release-ready-checks.js`: executable checks passed; three `--full` checks were skipped.
- GitHub Actions: recent CI runs inspected during the audit were green; CI uses Node 22 and PostgreSQL 15.

Limitations:

- The local host was running Node 26.7.0 even though the supported engine is Node `>=22 <23`; CI is the stronger Node-version evidence.
- PostgreSQL rehearsals guarded by dedicated `*_PG_TEST_DATABASE` variables were skipped in the local aggregate test run when those variables were absent.
- No numeric coverage report is configured. The test suite is broad but relies heavily on custom Node regression scripts and source-contract tests.
- No authenticated browser, live Discord, live Nitrado mutation, or production runtime smoke was performed as part of this audit.

## Build Status

- JavaScript syntax, lint, and the canonical test suite pass.
- Dockerfiles target Node 22 and use `npm ci` for their package boundaries.
- Tailwind compilation succeeds, but the generated file differs from the tracked `public/css/tailwind.css`; moreover, `Dockerfile` builds CSS before `COPY . .`, so the later copy overwrites the fresh asset with the stale tracked file.
- The tag-triggered Piper workflow builds/pushes images and creates a GitHub release without depending on the exact SHA passing CI.

## Release Status

**NOT READY** for production release.

The source tree is suitable for focused stabilization and release testing, not immediate production promotion. Remaining gates include:

1. Gate tag-triggered image publication and GitHub releases on complete checks for the exact source SHA.
2. Reconcile and commit reproducible CSS output, and ensure the Docker build does not overwrite it after generation.
3. Run all PostgreSQL integration/migration rehearsals against PostgreSQL 15, including admin RBAC, link security, fresh install, prior-schema upgrade, and rerun behavior.
4. Register the real mission-file fixture test in a canonical release gate.
5. Validate backup and restore into a disposable database.
6. Build and smoke-test backend and bot production images, including the bot’s shared-module dependency closure.
7. Exercise authenticated critical paths and failure states in a staging/disposable environment.
8. Cut and review an exact clean release candidate, then complete the required soak and rollback rehearsal.

## Immediate Risks

1. Local green tests do not prove the skipped PostgreSQL, provider, browser, or deployed-runtime paths.
2. The generic event worker can lose failed projection work if integrated and enabled as written.
3. Large modules and a manually curated lint surface increase the chance that changes bypass targeted checks.

## Recommended Next Steps

1. Make the CSS build reproducible and add a clean-tree generated-asset check.
2. Execute the full PostgreSQL/container release gate and record exact evidence.
3. Perform the low-risk repository cleanup listed in `TECH_DEBT.md` as a separate reviewable change.
4. Refactor only the modules touched by active feature work, beginning with tested seams in `routes/logParser.js`, `routes/casino.js`, and `public/js/player-portal.js`.
