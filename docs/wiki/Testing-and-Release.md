# Testing and Release

**Status: CONFIRMED**

**Verified against TESTING revision:** `6db37fa97e471ddb39e207e160ad28de33618e26`

## Canonical local checks

Run the repository-owned commands rather than inventing a partial substitute:

```bash
npm run lint
npm test
npm run security:audit
npm audit --audit-level=high
npm audit --prefix bot --audit-level=high
```

Use syntax checks for changed JavaScript entry points and focused tests for the affected domain. `npm test` is a long chain of custom Node regression scripts; passing it is necessary but does not prove every live provider, browser, or production path.

## UI and generated assets

For UI-surface changes:

```bash
npm run test:ui-contract
npm run manifest:ui:check
```

For intentional Tailwind changes:

```bash
npm run build:css
```

Inspect the generated diff. Do not accept generated changes blindly.

## Release helper

```bash
node scripts/release-ready-checks.js
node scripts/release-ready-checks.js --full
```

The quick form runs syntax, lint, canonical tests, environment validation, encryption checks when configured, and scheduler/bot syntax checks. The `--full` form additionally attempts database smoke, dependency audit, and CSS build checks. Read its summary: skipped checks are not passes.

## CI evidence

The main CI workflow uses Node 22 and PostgreSQL 15, installs root and bot dependencies, runs lint, syntax checks, source secret audit, canonical tests with selected PostgreSQL test databases, database smoke checks, and high-severity dependency audit.

CI is stronger evidence for the supported Node version than a workstation running another Node release. CI still does not replace exact production-image, restore, authenticated-browser, or live-provider validation.

## Optional and environment-gated tests

Several PostgreSQL rehearsals require dedicated database environment variables. A local aggregate run may skip them when those variables are absent. Record every skip explicitly in release evidence.

Tests that use injected transports or fixtures do not prove live Nitrado, Discord, GitHub, or AI-provider behavior. Live mutation tests require a disposable/staging target and explicit scope.

## TESTING to STABLE promotion

Never merge or mirror the repositories wholesale.

1. Record exact TESTING and STABLE SHAs and worktree states.
2. Inspect current trees and relevant Git history.
3. Inventory every added, modified, removed, generated, binary, dependency, configuration, test, and documentation path.
4. Classify each path as release, private-only, sensitive, uncertain, or unrelated.
5. Build a sanitized candidate that preserves public history, licensing, branding, and contributor experience.
6. Check whether public Wiki knowledge changes.
7. Stage exact scope and calculate an immutable staged-diff SHA-256 or Git tree ID.
8. Run focused and canonical verification.
9. Obtain independent blocker-only review for that exact unchanged candidate.
10. Produce the public release review and stop for explicit human approval.

Any source or staging change after review invalidates that review.

## Production rollout rules

- Deploy an exact full SHA already tested locally.
- Inspect the production worktree before updating it.
- Preserve unexpected production changes before any destructive checkout.
- Rebuild only affected services where practical.
- Avoid triggering database initialization/migration paths when no approved migration is part of the release.
- Verify host, origin, production checkout, and in-container artifacts match.
- Check running state, restart counts, database health, HTTP smoke behavior, and current fatal/module-load log patterns.
- Keep rollback evidence until the observation window has passed.

## Database migration gate

Production migration requires:

- explicit human approval;
- a verified database backup;
- exact migration inventory;
- disposable PostgreSQL rehearsal, including rerun behavior;
- preflight of ambiguous tenant, identity, and monetary rows;
- post-migration schema and application verification;
- a tested restore/rollback path.

A successful source-level migration test is not proof that production DDL is safe.

## Source anchors

- `package.json`
- `.github/workflows/ci.yml`
- `scripts/release-ready-checks.js`
- `scripts/security-audit.js`
- `docker-compose.yml`
- `Dockerfile`
- `Dockerfile.bot`
- `db/migrationRunnerPg.js`
