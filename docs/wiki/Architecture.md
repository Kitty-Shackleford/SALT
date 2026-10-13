# Architecture

**Status: CONFIRMED**

**Verified against TESTING revision:** `6db37fa97e471ddb39e207e160ad28de33618e26`

## Runtime shape

DayZ Dashboard is a layered Node.js monolith plus a separately packaged Discord bot. Both processes share PostgreSQL but do not call each other over HTTP.

```text
Browser ──HTTPS──> Express backend ──> PostgreSQL
                         │                  ▲
                         ├── Nitrado        │
                         ├── GitHub         │
                         └── AI provider    │

Discord ──> Discord bot ────────────────> PostgreSQL
                 │
                 └── Nitrado / Discord APIs
```

## Backend startup

`server.js` is intentionally thin:

1. load and validate the environment;
2. initialize PostgreSQL and run pending migrations;
3. create the Express application;
4. listen for HTTP requests;
5. start the automation scheduler, economy scheduler, feed processor, and optional telemetry exporter.

`src/app/createApp.js` constructs the application. `src/app/registerMiddleware.js` owns middleware order, while `src/app/registerRoutes.js` composes API and HTML routes.

## Layer responsibilities

- `routes/` — HTTP boundary, middleware composition, request/response handling
- `services/` — business rules, provider orchestration, and reusable use cases
- `middleware/` — authentication, authorization, validation, CSRF, and request limiting
- `utils/` — shared low-level helpers; do not create a duplicate helper before searching here
- `db/` — PostgreSQL adapter, schema bootstrap, and ordered migrations
- `workers/` — queue consumers such as Discord feed delivery
- `scheduler.js` — active scheduled and provider-backed background work
- `public/` — canonical HTML documents, vanilla browser JavaScript, static assets, Tailwind output, Leaflet assets, and private map tiles
- `bot/` — separate Discord.js package, commands, events, and bot-specific services

At the verified revision the repository contains 40 route files, 53 service files, 29 bot command files, 77 migration files, and a large custom regression-script surface. Counts are navigation hints, not architectural contracts.

## Middleware and browser boundary

The backend trusts one reverse-proxy hop. Sessions use PostgreSQL storage. Passport serializes `users.discord_id`, not the internal integer user ID. Helmet sets the content security policy. Static serving is assets-only: direct `.html` requests are rejected, and canonical handlers render authorized documents with CSRF context.

Session-backed CSRF protection is global. Unsafe requests must send the token in an accepted header or request body; query-string CSRF tokens are intentionally rejected. API rate limiting is mounted centrally before route-specific handling.

## Discord bot boundary

`bot/index.js` loads commands and events dynamically, initializes the shared database schema, authorizes each command against the invoking guild and selected server, and then logs in to Discord. `bot/events/ready.js` starts health reporting, ownership reconciliation, server health monitoring, and the status loop.

The bot has its own `bot/package.json`. `Dockerfile.bot` copies selected root `utils/`, `services/`, and `db/` modules into the bot image. A shared-module change can therefore require both backend and bot image verification even when no file under `bot/` changed.

## Data and migration boundary

PostgreSQL is the only supported application database. `db/schema.js` distinguishes fresh, current, legacy, and unsupported schema states. Legacy Schema V1 conversion fails closed. Fresh Schema V2 creation is followed by incremental migrations.

`db/migrationRunnerPg.js` serializes migration execution with a PostgreSQL advisory lock and runs each non-baseline migration transactionally. A migration file is not a release by itself: production execution requires a backup, exact candidate, rehearsal, and explicit approval.

The shared database adapter returns row arrays directly from `db.query()`. Native `pg` pools/clients return `{ rows }`. Mixing those contracts is a recurring source of bugs.

## Background work

The backend process starts:

- scheduled log sync and parsing;
- teleport lifecycle processing;
- bounty expiry and other scheduled operations;
- economy scheduling;
- Discord feed queue processing.

Some overlap guards and locks are process-local. Do not assume horizontal backend replicas are safe for every scheduler or file-mutation path.

## External trust boundaries

Nitrado, Discord, GitHub, user-configured AI providers, downloaded provider files, and browser-supplied identifiers are untrusted boundaries. PostgreSQL is the authoritative application store. Downloaded files are runtime evidence/cache and must remain tenant- and server-scoped.

## Source anchors

- `server.js`
- `src/app/createApp.js`
- `src/app/registerMiddleware.js`
- `src/app/registerRoutes.js`
- `bot/index.js`
- `bot/events/ready.js`
- `Dockerfile.bot`
- `db/schema.js`
- `db/migrationRunnerPg.js`
- `scheduler.js`
- `workers/feedProcessor.js`
