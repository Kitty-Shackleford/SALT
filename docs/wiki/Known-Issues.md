# Known Issues

**Status: NEEDS REVIEW**

**Ledger snapshot reviewed:** `CURRENT_STATE.md`, `ROADMAP.md`, and `TECH_DEBT.md` dated 2026-09-05

**Current TESTING revision:** `6db37fa97e471ddb39e207e160ad28de33618e26`

This page records durable risk themes, not active work assignments. GitHub Issues should track owned work. The source and tests must be checked before acting because the underlying audit documents predate the current revision.

## Release evidence remains layered

### Problem

Canonical tests are broad, but environment-gated PostgreSQL rehearsals, authenticated browser flows, live provider mutations, restore/rollback, and soak evidence may not all run for every candidate.

### Do not

Do not describe a passing local `npm test` as complete production validation. Record skipped gates explicitly.

### Resolution direction

Use exact-candidate release evidence across Node 22, PostgreSQL 15, production images, authenticated staging, external integrations, backup restoration, rollback, and independent review.

## Generated CSS authority

### Problem

The 2026-09-05 audit reported that rebuilding Tailwind changed the tracked output and that the Dockerfile's later `COPY . .` could overwrite freshly generated CSS.

### Do not

Do not regenerate and commit CSS blindly, and do not assume a successful build proves the intended asset was shipped.

### Resolution direction

Reconfirm against current source, establish the authoritative input/output, inspect the UI diff, fix Docker ordering if still applicable, and add a clean-tree reproducibility check.

## Generic event projection worker

### Problem

`src/events/worker.js` was documented as dormant, with no startup registration and checkpoint behavior that could advance after handler failure.

### Do not

Do not enable it merely because the file exists.

### Resolution direction

Define durable claims, retries, dead-letter handling, idempotency, observability, and failure/checkpoint semantics first.

## Process-local coordination

### Problem

Some scheduler overlap guards and file locks protect one process only.

### Do not

Do not horizontally scale scheduler or provider-mutation responsibilities without reviewing each path.

### Resolution direction

Document the single-scheduler topology and move high-risk operations to PostgreSQL advisory locks, leases, or durable claims before scaling.

## Large active modules

### Problem

Several route, service, and browser modules combine many responsibilities, increasing review and regression cost.

### Do not

Do not perform a big-bang decomposition.

### Resolution direction

Extract tested use cases and pure transformations only when active feature work needs the seam.

## Uneven script ownership

### Problem

The repository has a large `scripts/` surface while lint/test registration is partly curated by explicit package commands. New scripts can miss canonical coverage.

### Do not

Do not assume every file under `scripts/` runs in CI or `npm test`.

### Resolution direction

Classify supported tests, operational tools, generated helpers, and one-offs; then use broader globs with narrow documented exceptions where practical.

## Documentation drift

### Problem

Long-lived documents mix current behavior with dated audits, historical migration assumptions, proposals, and AI planning artifacts. `docs/DATABASE.md` contains legacy camelCase examples that conflict with the current snake_case PostgreSQL schema and should not be treated as an authoritative column reference.

### Do not

Do not execute plans or database examples solely because they are documented.

### Resolution direction

Verify consequential claims against current source/schema, add status/revision markers, consolidate durable knowledge here, and mark obsolete material deprecated or historical rather than silently converting it into fact.

## Legacy UI surfaces

### Problem

Dated audits report unrouted HTML/browser assets whose capability parity with canonical pages was not proven.

### Do not

Do not delete or restore routing based only on filename/reference scans.

### Resolution direction

Compare roles, capabilities, workflows, and tests before removal.

## Mission editor lock durability and provider path exposure

### Problem

**Status: CONFIRMED in current source.** Mission-editor locks are process-local, are lost on backend restart, and do not coordinate across multiple backend instances. Separately, backup-list responses include host filesystem paths.

### Do not

Do not treat mission-editor locks as durable leases or cross-replica concurrency control. Do not copy returned host paths into logs, documentation, or client-visible diagnostics.

### Resolution direction

Move lock coordination to durable storage before running multiple editor-capable backend replicas, and return logical backup identifiers rather than host paths.

### Source anchors

- `services/missionFileService.js`
- `routes/missionFiles.js`

## Private map assets

### Problem

Private map tiles dominate repository and image-build size but are intentional operational assets.

### Do not

Do not publish, delete, move, or convert them as incidental cleanup.

### Resolution direction

Treat storage strategy as a separate measured decision. Public SALT should retain only intentionally released map documentation or placeholders unless explicitly approved otherwise.

## Source anchors

- `CURRENT_STATE.md`
- `ROADMAP.md`
- `TECH_DEBT.md`
- `src/events/worker.js`
- `scheduler.js`
- `Dockerfile`
- `styles/input.css`
- `public/css/tailwind.css`
- `package.json`
- `docs/DATABASE.md`
