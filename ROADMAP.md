# Roadmap

This roadmap is intentionally lightweight. Dates are not commitments unless explicitly assigned. Feature status is based on the audited source at revision `e8266049b15e4de2dd0866026e166a66541092c5`.

## Current Release

Version: `1.0.0` (proposed release baseline)
Target date: Unknown
Status: **STABILIZATION / NOT READY FOR RELEASE**

### In Progress

- No product feature is currently designated **IMPLEMENTING**. The next work item is the stabilization sequence below.

### Testing

- Shop/provider lifecycle and recovery behavior is in stabilization testing.
- Managed mission initialization and configuration lifecycle is in stabilization testing.
- Canonical JavaScript regression suite and lint: passing locally.
- Security regression, tenant isolation, financial integrity, shop/provider, teleport, mission, bot, and UI-contract suites: included in the canonical test command.
- PostgreSQL 15 rehearsals requiring dedicated test-database variables: must be run as a release-candidate gate.
- Authenticated browser role/viewport matrix: not yet completed for the exact candidate.
- Live Nitrado/Discord integration checks: not completed for the exact candidate.

### Stabilization

1. **Completed:** corrected the AI context query/schema mismatch with a focused regression and a real-schema DB smoke assertion.
2. **Completed:** disabled territory-reward controls, forced the read contract to unsupported/disabled, and rejected persistence attempts until a real ownership model exists.
3. Reconcile generated Tailwind output and enforce reproducibility.
4. Review the dormant event worker’s retry/checkpoint contract before enabling it.
5. Reconcile current documentation with Node 22, PostgreSQL-only operation, current routes, and current migration behavior.
6. Complete safe cleanup without mixing it into feature work.

### Release Blockers

- Tag-triggered Piper publication is not gated on the exact SHA passing CI or equivalent checks.
- Generated CSS differs from the checked-in artifact, and the Dockerfile overwrites its fresh build with the tracked file.
- Admin RBAC and link-security PostgreSQL tests are outside canonical `npm test` and CI; other PG tests can skip without dedicated variables.
- The real mission-file fixture test is not registered in a canonical gate.
- Migration smoke coverage checks only an older table subset and does not rehearse prior-schema upgrade or a second migration run.
- Backup/restore and rollback have not been rehearsed for this candidate.
- Production backend and bot images have not been smoke-tested for this candidate.
- Authenticated staging and external-integration checks are outstanding.
- No exact clean release candidate, final independent review, or soak evidence exists yet.

### Release Candidate Gate

A candidate may advance to **RELEASE CANDIDATE** only when:

- the known blockers above are resolved or explicitly removed from scope;
- tag-triggered publication is bound to successful complete checks for the exact source SHA;
- `npm ci` and `npm ci --prefix bot` succeed on a clean Node 22 checkout;
- canonical tests—including admin RBAC, link-security PostgreSQL, and real mission fixtures—lint, security scan, dependency audit, syntax checks, and generated-artifact checks pass;
- PostgreSQL fresh-install and all registered `*_PG_TEST_DATABASE` rehearsals pass on PostgreSQL 15;
- pending migrations run successfully twice against a disposable restored database;
- backend and bot images start using production-only dependency installs;
- critical authenticated role/server paths pass staging smoke tests;
- backup restoration and application rollback are demonstrated;
- the exact candidate tree receives an independent blocker-only review.

## Next Release

Status: **PLANNED**

Order work by dependency and risk rather than by feature novelty:

1. Durable background work
   - Define claim, lease, retry, dead-letter, idempotency, and observability contracts.
   - Migrate queue consumers incrementally; do not enable `src/events/worker.js` first.

2. UI/runtime integrity
   - Consolidate server-context selection patterns where this reduces real bugs.
   - Add authenticated browser tests for permissions, empty/error states, stale async requests, and destructive confirmations.
   - Prove parity before removing legacy HTML surfaces.

3. Active-module decomposition
   - Extract tested use cases from oversized route files only as those areas change.
   - Prioritize parser, casino, player portal, shop file, and route-registration seams.

4. Operational quality
   - Expand lint ownership for `scripts/` or explicitly classify generated/one-off scripts.
   - Add measurable coverage reporting without optimizing for a vanity percentage.
   - Align shared dependency versions between root and bot packages when verified safe.

## Future

- Territory ownership and rewards, only with authoritative ownership data and exact-server settlement rules.
- Typed notification/subscription registry backed by durable delivery records.
- Reviewed base/territory domain and season lifecycle.
- Mission-side weather, gas, restricted-area, and CE automation after reversible provider evidence is proven.
- Optional public server directory after privacy, tenant opt-in, and metadata contracts are decided.
- Broader UI-shell modernization only after current behavior is covered and migration parity is proven.

## Feature Lifecycle Ledger

| Feature | Purpose | Status | Owner | Dependencies | Implementation | Tests | Known issue / risk | Release target |
|---|---|---|---|---|---|---|---|---|
| Exact-server authorization | Prevent cross-tenant/server access | STABILIZATION | Unassigned | PostgreSQL, Discord identity | `middleware/`, `services/serverAuthorizationService.js` | Security/admin/runtime suites | Runtime role revocation must remain fail-closed | Current release |
| Shop/provider lifecycle | Safe paid mission-file provisioning and cleanup | STABILIZATION | Unassigned | Economy, Nitrado, mission files, scheduler | `routes/shop.js`, `services/shop*`, migrations | Extensive shop/provider/financial regressions | Requires exact-candidate PG/provider smoke | Current release |
| Managed mission init | Version and apply supported mission init content | TESTING | Unassigned | Nitrado, mission files, bot | `routes/missionInit.js`, `services/missionInit*`, bot command | Mission init suites | Platform capability varies | Current release |
| AI assistant | Analyze/edit server configuration | STABILIZATION | Unassigned | AI provider, server data, GitHub optional | `routes/ai.js`, `services/aiService.js` | Provider, context-query, and DB smoke coverage | Live-provider and authenticated staging validation remain | Current release if remaining gates pass |
| Territory rewards | Reward territory ownership | DEFERRED / DISABLED | Unassigned | Territory ownership model, economy | `utils/territoryRewards.js`, economy settings UI/service | Unsupported-boundary regression; no settlement tests | Controls and persistence are disabled until an authoritative ownership model exists | Future |
| Generic event projections | Replay durable domain events | DESIGNED / DORMANT | Unassigned | `events`, projection checkpoints | `src/events/worker.js` | Limited | No runtime wiring; failed handlers do not block checkpoint advancement | Future |
| Public server directory | Opt-in discovery | IDEA / PLACEHOLDER | Unassigned | Privacy and tenant policy | `src/app/registerRoutes.js` | Placeholder contract only | Always returns an empty list | Future |
| UI modernization | Improve consistency and maintainability | PLANNED | Unassigned | UI contracts, role/browser QA | `public/`, `styles/` | UI manifest/contracts | Scope is broad; avoid big-bang rewrite | Next/Future |

## Work Intake Rule

Before accepting a new significant feature:

1. Identify its exact-server, identity, persistence, and external-provider boundaries.
2. Search for existing implementation and contracts.
3. State the smallest module/use-case change needed.
4. Define meaningful tests and failure behavior.
5. Decide whether a current-release blocker must be fixed first.
6. Keep feature work separate from unrelated cleanup and dependency upgrades.
