# AI Agent Guide

**Status: CONFIRMED**

**Applies to:** TESTING stewardship, STABLE promotion, and Wiki maintenance

## Operating model

- TESTING is the private workshop.
- STABLE is the public product.
- The public Wiki is curated memory about STABLE.
- Source code is the current technical authority.
- GitHub Issues track active work.
- Git history records what actually happened.

Private-to-public movement is a security boundary, not ordinary repository synchronization.

## Required behavior

1. Understand before modifying.
2. Search before creating.
3. Reuse existing services and utilities.
4. Trace definitions and usages instead of guessing APIs.
5. Make the smallest coherent change.
6. Preserve tenant, exact-server, identity, financial, filesystem, and provider boundaries.
7. Run tests proportional to the change plus canonical gates when preparing a release.
8. Update documentation only when durable knowledge changed.
9. Remove temporary artifacts and avoid generated clutter.
10. State uncertainty and stop when consequences could be public, destructive, or irreversible.

## Knowledge discipline

Use these labels:

- **CONFIRMED** — verified against current source/behavior or an accepted decision.
- **PROVISIONAL** — proposal; not implemented architecture.
- **DEPRECATED** — no longer valid or recommended.
- **HISTORICAL** — previous state, not current behavior.
- **NEEDS REVIEW** — useful but unverified.

Never turn “could,” “might,” “probably,” a TODO, roadmap entry, old plan, or failed experiment into a requirement or current fact.

When Wiki and source conflict, report:

```text
WIKI DRIFT DETECTED
Wiki says: ...
Current source says: ...
Recommendation: ...
```

Do not silently ignore or “fix” intentional architecture without understanding it.

## Search-before-create checklist

Before creating a module, helper, service, script, endpoint, abstraction, configuration mechanism, or Wiki page:

- search names and behavior across the repository;
- inspect neighboring imports and call sites;
- check README, `docs/`, Wiki, tests, and recent history;
- prefer reuse, then extension, then focused refactoring, then creation;
- justify a new artifact when a near-equivalent exists.

## Change discipline

Avoid mixing feature work with unrelated refactors, formatting, dependency upgrades, cleanup, and documentation rewrites. Do not add wrappers or abstractions without a current consumer and tested benefit.

Large files are not permission for broad rewrites. Extract only tested seams needed by current work.

Do not commit local plans, logs, downloads, credentials, database dumps, temporary files, or speculative notes.

## Security rules

- Never print, copy, or commit secrets.
- Never trust caller-provided tenant/server/resource identifiers as authorization.
- Preserve global CSRF and middleware ordering.
- Use descriptor-anchored safe-path helpers for externally influenced filesystem work.
- Preserve exact-money, transaction, evidence, and idempotency rules.
- Use centralized provider clients with bounded timeout/retry/error behavior.
- Treat browser/provider strings as untrusted output.
- Never weaken validation to satisfy a test.

## Testing rules

- Add a regression that fails before the fix when practical.
- Run focused tests while developing.
- Run `npm run lint` and `npm test` before declaring a code change complete.
- Run UI contract/manifest checks for UI surfaces.
- Record environment-gated skips.
- Use Node 22 and PostgreSQL 15 evidence for release claims.
- A mock or source-contract test does not prove live-provider behavior.
- A successful migration source test does not authorize production migration.

## TESTING to STABLE

Never copy the repository wholesale. Inventory and classify every candidate path, inspect history, exclude private/sensitive material, construct a clean public candidate, verify it, obtain independent review for its exact identity, produce a release report, and stop for explicit approval.

Never push to STABLE, modify the public Wiki, tag, create a release, force-push, rewrite history, or publish uncertain information without exact human approval.

## Wiki rules

- Search existing pages before creating one.
- Prefer updating a durable page over adding a notes page.
- Put active tasks in Issues, not the Wiki.
- Record non-obvious, verified knowledge that will prevent rediscovery or regression.
- Mark deprecation/history instead of silently deleting useful context.
- Public Wiki content must be independently safe for public disclosure.
- Never bulk-copy this private Wiki to the public Wiki.

## Review handoff

A review brief should include:

- exact repository, branch, and SHA/tree/hash;
- intended behavior and exclusions;
- relevant security/data boundaries;
- tests and skipped gates;
- explicit prohibition on unrelated edits or public writes.

A reviewer PASS applies only to the named unchanged candidate.
