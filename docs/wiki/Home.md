# DayZ Dashboard TESTING Knowledge Hub

> **Private knowledge base. Do not copy this Wiki directly to the public SALT Wiki.** Every public promotion requires verification against STABLE, sanitization, an exact-candidate review, a publication report, and explicit human approval.

**Status: CONFIRMED**

**Verified against TESTING revision:** `6db37fa97e471ddb39e207e160ad28de33618e26`

DayZ Dashboard is a self-hosted Node.js system for operating DayZ servers. It combines an Express dashboard, a separate Discord bot, PostgreSQL, scheduled and queued work, Nitrado integration, mission-file tooling, log parsing, player systems, and an in-game economy.

## Repository model

- **TESTING:** private workshop for experiments, unfinished work, operational learning, and release candidates.
- **STABLE:** public SALT product containing intentionally released and sanitized code.
- **Public Wiki:** curated shared memory about STABLE. It is not a mirror of TESTING or this private knowledge base.

## Authority order

1. Current source and tests
2. Current schema and migrations
3. Accepted design decisions
4. This Wiki, considering each page's status and verification revision
5. Historical audits, plans, and analyses

If source and Wiki disagree, report **WIKI DRIFT DETECTED** rather than silently choosing one.

## Start here

- [[Architecture]] — runtime boundaries, trust boundaries, and coupling
- [[Development-Guide]] — where changes belong and how to avoid duplication
- [[Testing-and-Release]] — canonical checks and release evidence
- [[Security-and-Data-Integrity]] — authorization, filesystem, financial, and secret-handling rules
- [[External-Integrations]] — Nitrado, Discord, GitHub, and AI-provider conventions
- [[Design-Decisions]] — intentional architecture future agents must preserve
- [[Known-Issues]] — durable risks and documentation drift, not active ticket tracking
- [[AI-Agent-Guide]] — required behavior for AI-assisted work
- [[Glossary]] — project terminology

## Existing detailed documents

The Wiki summarizes durable knowledge and points contributors toward source. It does not replace:

- `README.md` — setup, usage, and front-door documentation
- `AGENTS.md` — repository-local implementation reference
- `CURRENT_STATE.md` — dated audit snapshot
- `ROADMAP.md` — planned and proposed work; never proof of implementation
- `TECH_DEBT.md` — dated debt and cleanup ledger
- `CHANGELOG.md` — release history
- `docs/` — detailed domain and integration documentation

## Knowledge statuses

- **CONFIRMED:** verified against current source, behavior, or an accepted decision.
- **PROVISIONAL:** proposal or work in progress; not current architecture.
- **DEPRECATED:** formerly valid and no longer to be followed.
- **HISTORICAL:** records prior behavior or decisions.
- **NEEDS REVIEW:** potentially useful but not recently verified; do not rely on it for consequential decisions.

## Maintenance rule

Update a page only when durable project knowledge changes. Search existing Wiki pages and repository documentation before creating another page. Active work belongs in GitHub Issues; temporary reasoning belongs in a local plan, not permanent project memory.
