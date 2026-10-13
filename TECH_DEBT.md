# Technical Debt

Snapshot: 2026-09-05
Priority rule: security/data integrity first, then broken behavior and release gates, then maintainability and cosmetic cleanup.

This is an actionable debt register, not a list of every TODO or large file. Items stay here until resolved, deliberately accepted, or superseded by source/tests.

## Critical

No confirmed critical defect was found in the audited revision. This is not proof that none exists; live provider, authenticated browser, restored-database, and production-runtime paths were not fully exercised.

## High

### TD-001 — AI server-context query/schema mismatch (resolved)

Original problem: `services/aiService.js` filtered `kill_events.killed_at` and queried `loot_events.logged_at`, but `kill_events` uses `timestamp` and the implemented parsed-loot table is `loot_despawn_events` with `log_date`/`created_at`; `loot_events` is not created by the current schema or migrations.
Location: `services/aiService.js`, `scripts/ai-user-provider-test.js`, `scripts/db-smoke-test.js`, `db/schema-v2.js`, `db/migrations/041_add_loot_despawn_events.js`.
Why it mattered: mounted AI context/analysis routes could fail against the real schema even though provider/source-contract tests passed.
Impact: user-visible 500 responses and misleading release confidence.
Resolution: queries now use `kill_events.timestamp` and `loot_despawn_events.log_date`; focused query-contract coverage and PostgreSQL schema-smoke coverage were added.
Estimated complexity: Small.
Priority: Resolved on 2026-09-05; focused regression and PostgreSQL schema-smoke coverage added.

### TD-002 — Territory rewards are exposed but do not settle rewards (resolved boundary)

Original problem: `utils/territoryRewards.js` contains placeholder processing, awards nothing, swallows errors, and would log completion if called. Its scheduler export is not wired into application startup, while economy settings exposed the feature.
Location: `utils/territoryRewards.js`, economy settings UI/service/API, migration `013_add_economy_system.js`.
Why it mattered: operators could enable behavior that silently did not exist.
Impact: false operational success and player trust issues.
Resolution: the UI now marks both controls unavailable and disables them; configuration reads force `territoryRewardsEnabled: false` and expose `territoryRewardsSupported: false`; API attempts to persist either territory setting fail before any transaction. The dormant implementation remains deferred until an authoritative ownership model exists.
Estimated complexity: Small to disable; Large to implement safely.
Priority: Resolved on 2026-09-05; future implementation remains deferred.

### TD-003 — Full release evidence is incomplete

Problem: canonical tests pass, but some PostgreSQL tests skip without dedicated test-database variables. No exact-candidate restore, container smoke, authenticated staging, external integration, rollback, or soak evidence exists.
Location: `package.json`, `.github/workflows/ci.yml`, `scripts/*-pg-test.js`, Docker/Compose definitions.
Why it matters: source-level confidence is not deployed-system confidence.
Impact: migration, dependency-closure, configuration, or integration failures may appear only during deployment.
Suggested solution: execute the `ROADMAP.md` release-candidate gate against PostgreSQL 15 and production images.
Estimated complexity: Medium.
Priority: High.

### TD-004 — Generated CSS is not reproducible from the tracked source

Problem: `npm run build:css` succeeds, but its generated output differs from `public/css/tailwind.css`.
Location: `styles/input.css`, `tailwind.config.js`, `public/css/tailwind.css`.
Why it matters: clean builds and source checkouts can ship different UI assets.
Impact: release nondeterminism and difficult UI review.
Suggested solution: determine the authoritative Tailwind input/config, regenerate intentionally, inspect the UI diff, and add a clean-tree reproducibility check.
Estimated complexity: Small to Medium.
Priority: High before an exact release candidate.

### TD-015 — Public release publication is not bound to CI success

Problem: tag pushes trigger `.github/workflows/piper.yml`, which builds/pushes images and creates a GitHub release without running or depending on the exact SHA’s CI result.
Location: `.github/workflows/piper.yml`, `.github/workflows/ci.yml`.
Why it matters: a tag can publish images and a release even when tests, lint, PostgreSQL checks, secret scanning, or dependency audit fail independently.
Impact: unverified public artifacts can be presented as releases.
Suggested solution: publish only from a workflow/job that requires the complete exact-SHA gate, or reproduce those checks inside Piper before any image push or release creation.
Estimated complexity: Medium.
Priority: High; release blocker.

### TD-016 — Docker overwrites freshly generated CSS

Problem: the backend Dockerfile runs `npm run build:css`, then `COPY . .` overwrites the result with the stale tracked `public/css/tailwind.css`.
Location: `Dockerfile`, `public/css/tailwind.css`.
Why it matters: the image appears to compile CSS but actually ships the checked-in artifact.
Impact: stale UI output and misleading build confidence.
Suggested solution: reorder/copy inputs so generation occurs after the final source copy, and add a generated-asset clean-tree check.
Estimated complexity: Small.
Priority: High; release blocker.

### TD-017 — PostgreSQL and migration gates omit important behavior

Problem: admin RBAC and link-security PostgreSQL tests are separate scripts outside canonical `npm test` and CI. Other PG tests silently skip without dedicated variables. The DB smoke test checks an older table subset, initializes only once, and does not prove prior-schema upgrade, all migration records, constraints/indexes, or rerun safety.
Location: `package.json`, `.github/workflows/ci.yml`, `scripts/admin-rbac-pg-test.js`, `scripts/link-security-pg-test.js`, `scripts/db-smoke-test.js`.
Why it matters: concurrency, authorization, migration, and schema defects can evade otherwise green gates.
Impact: release-time database or security failures.
Suggested solution: register all required PG suites in the release gate, fail rather than skip in CI/release mode, expand schema assertions, and rehearse a production-derived upgrade plus a second migration run.
Estimated complexity: Medium.
Priority: High; release blocker.

### TD-018 — Real mission composition fixture is outside canonical gates

Problem: `scripts/shop-mission-fixture-test.js` mutates and validates real mission fixtures but is not invoked by `package.json`, CI, or another test runner.
Location: `scripts/shop-mission-fixture-test.js`, `package.json`.
Why it matters: production-like mission composition can regress while canonical tests stay green.
Impact: invalid or incomplete provider mission files.
Suggested solution: register the fixture test in the canonical/release test taxonomy and lint ownership.
Estimated complexity: Small.
Priority: High before release.

## Medium

### TD-005 — Generic event worker can skip failed projections

Problem: `src/events/worker.js` is not wired into application startup. If integrated and enabled as written, handler failures are logged but the batch checkpoint still advances.
Location: `src/events/worker.js`.
Why it matters: enabling it can permanently lose projection work.
Impact: inconsistent derived state.
Suggested solution: define per-projection failure/retry semantics, add durable claims or blocking checkpoints, dead-letter visibility, and replay tests before enabling it.
Estimated complexity: Medium to Large.
Priority: Medium while disabled; High before enablement.

### TD-006 — Process-local scheduler coordination limits safe scaling

Problem: scheduler overlap guards and some locks are in-memory. They serialize one process but not multiple backend replicas.
Location: `scheduler.js` and feature-specific in-memory locks.
Why it matters: a second replica can duplicate scheduled/provider work.
Impact: duplicate external side effects or conflicting file mutations if deployment topology changes.
Suggested solution: document single-scheduler topology now; migrate high-risk jobs to PostgreSQL advisory locks/leases before horizontal scaling.
Estimated complexity: Medium.
Priority: Medium.

### TD-007 — Several modules are too large for safe change isolation

Problem: major files combine routing, SQL, transformations, policy, and response handling. Examples include `routes/logParser.js`, `routes/casino.js`, `public/js/player-portal.js`, `services/shopFileService.js`, `routes/playerPortal.js`, and `src/app/registerRoutes.js`.
Location: listed files.
Why it matters: broad files increase coupling, review cost, and regression risk.
Impact: slower feature delivery and harder testing.
Suggested solution: extract use cases and pure transformations only when touching a feature; retain route composition and avoid a big-bang rewrite.
Estimated complexity: Large, incremental.
Priority: Medium.

### TD-008 — Operational scripts have uneven static-analysis ownership

Problem: `scripts/` contains roughly 135 JavaScript files. `.eslintignore` excludes `scripts/*`, while `package.json` manually opts selected scripts back into lint. New scripts can silently miss lint coverage.
Location: `.eslintignore`, `package.json`, `scripts/`.
Why it matters: release, migration, security, and recovery tooling is production-significant code.
Impact: inconsistent quality and hidden syntax/style defects.
Suggested solution: classify scripts into supported tooling, tests, generated helpers, and one-offs; lint supported groups by glob with narrow explicit exceptions.
Estimated complexity: Medium.
Priority: Medium.

### TD-009 — Test breadth is high, but coverage and test taxonomy are unclear

Problem: the canonical test command is a long chain of custom Node scripts. Some tests are behavior-driven, some inspect source text, and infrastructure-based skips can be easy to miss. No numeric coverage report is configured.
Location: `package.json`, `scripts/`.
Why it matters: a green aggregate result can obscure which runtime boundaries were actually exercised.
Impact: maintenance friction and overstatement of confidence.
Suggested solution: emit a machine-readable test summary classifying unit, integration, real-PostgreSQL, source-contract, browser, and external-provider checks; add selective coverage reporting for core business modules.
Estimated complexity: Medium.
Priority: Medium.

### TD-010 — Root and bot dependency ranges drift

Problem: separately packaged components use different declared versions for shared libraries such as `axios`, `dotenv`, `fast-xml-parser`, and `pg`.
Location: `package.json`, `bot/package.json`.
Why it matters: shared code copied into the bot image may behave differently across package boundaries.
Impact: container-only failures and duplicated upgrade work.
Suggested solution: inventory shared imports, align versions where compatible, and preserve a production-only bot image import/startup smoke test.
Estimated complexity: Small to Medium.
Priority: Medium.

### TD-011 — Documentation and historical AI context are not consistently authoritative

Problem: README and contributor guidance contain mixed old/new operational details; historical analyses/plans coexist with current implementation and can contain superseded defects or migration assumptions. This audit corrected stale Node/install guidance and obsolete `AGENTS.md` paths for the database adapter, OAuth setup, HTML pages, and Tailwind input, but broader route/command documentation still requires reconciliation.
Location: `README.md`, `LINK_ACCOUNTS_ANALYSIS.md`, `.hermes/plans/`, selected `docs/` and `reports/`.
Why it matters: operators and agents can follow obsolete instructions.
Impact: incorrect setup, duplicate work, or unsafe architectural assumptions.
Suggested solution: make `README.md`, `CURRENT_STATE.md`, `ROADMAP.md`, `TECH_DEBT.md`, and `CHANGELOG.md` authoritative; archive or remove superseded analyses only after checking references and unresolved findings.
Estimated complexity: Medium.
Priority: Medium.

### TD-012 — Legacy UI documents remain without proven parity

Problem: eight HTML documents are unrouted and direct `.html` requests are blocked. Canonical routes redirect elsewhere, but behavioral parity is not fully proven.
Location: `public/admin/feeds.html`, `public/automation.html`, legacy economy pages, `public/nitrado-settings.html`, `public/index.html`, `public/onboarding.html`.
Why it matters: they add maintenance and audit surface while still potentially containing unique workflows.
Impact: duplicate UI logic and stale security assumptions.
Suggested solution: compare capabilities and role behavior, migrate any missing behavior, then delete as a dedicated change.
Estimated complexity: Medium.
Priority: Medium.

## Low

### TD-013 — Public server route is a mounted placeholder

Problem: authenticated `/api/public/servers` always returns an empty array.
Location: `src/app/registerRoutes.js`.
Why it matters: it is an ambiguous contract rather than an explicit unsupported feature.
Impact: client confusion; low current operational risk.
Suggested solution: remove the route until product/privacy requirements exist, or return an explicit disabled/not-implemented response.
Estimated complexity: Small.
Priority: Low.

### TD-014 — Bundled map tiles dominate repository size

Problem: `public/` is approximately 941 MB and contains more than 3,000 PNG map tiles. These appear intentional, not accidental build output.
Location: `public/maps/`.
Why it matters: clone, CI, and image build costs are high.
Impact: slower operations and larger artifacts.
Suggested solution: measure actual build/deploy cost and evaluate Git LFS, a release artifact, or static object storage only if deployment simplicity is preserved.
Estimated complexity: Medium to Large.
Priority: Low.

## Cleanup Ledger

### Safe Cleanup

#### CL-001

Location: root files `subprocess` and `sys`.
Problem: tracked, zero-byte, identical files with no repository references found.
Evidence: Git tracks both; content and repository reference scans found no use.
Risk: Very low.
Recommended action: delete in an isolated cleanup change and stage the deletions before running `npm run security:audit` (the scanner enumerates the Git index).
Status: Ready.

#### CL-002

Location: `.gitignore`.
Problem: stale `package-lock.json` ignore and duplicate `.DS_Store` rule.
Evidence: root lockfile is tracked and CI/Docker use `npm ci`.
Risk: Very low.
Action: removed the stale and duplicate entries during this audit.
Status: Completed.

#### CL-003

Location: `README.md`.
Problem: prerequisite said Node 14+, while both package manifests require Node `>=22 <23`.
Evidence: package engine fields and CI/Docker all target Node 22.
Risk: Very low.
Action: updated the prerequisite to Node 22.x during this audit. Broader Compose-command normalization remains review work.
Status: Completed.

#### CL-011

Location: `src/app/registerRoutes.js.bak.auto.merge`.
Problem: tracked merge-backup file containing unresolved conflict markers.
Evidence: the active implementation is `src/app/registerRoutes.js`; repository reference search found no consumer of the backup.
Risk: Very low.
Recommended action: delete in the isolated safe-cleanup change.
Status: Completed (removed via `git rm` on `chore/hygiene-remove-merge-backup`).

#### CL-012

Location: `scripts/migrate-to-guild-tokens.sh`.
Problem: deprecated no-op migration script that only prints a warning and exits successfully.
Evidence: its own header marks Schema V1-to-V2 conversion unsupported; no repository references were found.
Risk: Very low.
Recommended action: delete in the isolated safe-cleanup change, retaining supported migration/import guidance in current documentation.
Status: Ready.

#### CL-013

Location: `scripts/add-missing-constraints.js`.
Problem: orphaned repair script uses obsolete camelCase columns (`guildId`, `tokenType`, `platformServerId`) while current constraints already use canonical snake_case columns.
Evidence: no repository references were found; current constraints are defined in `db/schema-v2.js`.
Risk: Low; running it today is more dangerous than removing it.
Recommended action: delete in the isolated safe-cleanup change after recording that current schema initialization owns these constraints.
Status: Ready.

### Review Required

#### CL-004

Location: `LINK_ACCOUNTS_ANALYSIS.md`.
Problem: historical implementation analysis reports a discovery SQL defect that is fixed in current source.
Evidence: current query includes `FROM player_identities pi`; no repository references to the document were found.
Risk: Low, but it may retain design context not captured elsewhere.
Recommended action: preserve any still-current requirements, then archive outside the authoritative root docs or delete.
Status: Review required.

#### CL-005

Location: `.hermes/plans/`.
Problem: multiple time-bound AI planning files can be mistaken for current requirements. The untracked EffectArea recovery plan also names migration `081`, which is already used by the current repository.
Evidence: plans are dated snapshots; current code and migrations have moved on.
Risk: Medium if executed blindly; low if retained as history.
Recommended action: keep only active plans in the working context, mark superseded plans clearly, and never infer the next migration number from them. Do not delete the current untracked user plan without confirmation.
Status: Review required.

#### CL-006

Location: `reports/parser_coverage_report.md` and `reports/parser-coverage.md`.
Problem: overlapping generated/static reports include stale snapshots and real-looking player/event examples.
Evidence: two reports cover the same domain; observed data and schema have changed since generation.
Risk: Medium due to privacy and stale operational conclusions.
Recommended action: retain a sanitized generated summary or generation command, remove identity-bearing snapshots, and document generation date/schema revision.
Status: Review required.

#### CL-007

Location: eight unrouted legacy HTML files under `public/`.
Problem: likely obsolete pages remain tracked.
Evidence: UI manifest identifies them as unrouted; direct `.html` access is blocked; no current navigation references were found in the prior UI audit.
Risk: Medium because parity is not fully proven.
Recommended action: perform role/capability parity checks before deletion.
Status: Review required.

#### CL-008

Location: root `package.json`.
Problem: `enquirer` and `jsonwebtoken` are direct dependencies, but no imports/usages were found in tracked JavaScript. `@github/copilot` is both direct and pulled by `@github/copilot-sdk`, so the need for the duplicate direct declaration is also unclear.
Evidence: repository source search returned no imports for these direct package names; `npm explain` shows their package-graph positions. Dynamic or executable-package use has not been ruled out.
Risk: Medium if removed without a clean-install/container test.
Recommended action: validate one dependency at a time with clean root/bot installs, canonical tests, and production-image startup/import smoke before removal.
Status: Review required.

#### CL-014

Location: `public/js/player-map.js`.
Problem: likely superseded player-map implementation.
Evidence: no HTML document loads it; the routed page uses `public/js/player-map-standalone.js`, while a static regression still reads the older file.
Risk: Medium because capability parity has not been proven.
Recommended action: compare behavior, move any required regression assertions to the authoritative implementation, then delete if parity is confirmed.
Status: Review required.

#### CL-015

Location: old one-off scripts under `scripts/`, including backfill, parser inspection, migration-005, and local log-pipeline utilities.
Problem: several operational/incident scripts have no package command, workflow, documentation, or code reference and some depend on hardcoded ignored artifacts or obsolete migration assumptions.
Evidence: repository reference scan and script contents; representative examples include `scripts/backfill_territory_events.js`, `scripts/extract_unknown_samples.js`, and `scripts/run-migration-005.js`.
Risk: Medium because some may remain useful operator tools.
Recommended action: classify each as supported runbook, archived incident tool, or removable script; document supported tools before deleting the rest.
Status: Review required.

#### CL-016

Location: `scripts/release-ready-checks.js`.
Problem: useful unified release helper is not exposed through `package.json`, README, or workflows, creating competing release procedures.
Evidence: no repository caller/reference outside its own file was found.
Risk: Low to Medium.
Recommended action: make it an explicit documented npm release command or retire it after its checks are absorbed into the authoritative workflow.
Status: Review required.

### Architectural Cleanup

#### CL-009

Location: oversized route, service, and browser modules.
Problem: mixed responsibilities and high review cost.
Evidence: several active files exceed roughly 1,500–3,500 lines.
Risk: High if rewritten wholesale.
Recommended action: extract only tested seams needed by current work; no mass refactor.
Status: Incremental.

#### CL-010

Location: server-context selection and shared UI behavior.
Problem: selectors and storage keys vary across pages (`serverSelect`, `server-select`, `serverSelector`, query parameters, and guild-first flows).
Evidence: generated UI surface audit and page scripts.
Risk: Medium because contexts and permissions differ by page.
Recommended action: define a small explicit context contract after behavioral tests exist; do not force a universal selector prematurely.
Status: Planned.
