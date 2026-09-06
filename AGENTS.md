# AGENTS.md

AI agent reference for the **DayZ Dashboard** repository. Read this before making any changes.

---

## What This Project Is

A self-hosted web dashboard + Discord bot for managing DayZ game servers hosted on **Nitrado** (Xbox/PS/PC). Features include:

- Live server status embed in Discord (player count, restart timer, settings)
- Discord voice channel renamed to show time until next restart
- Log sync: downloads `.ADM`/`.RPT` logs from Nitrado file server
- Kill/death feed posted to Discord via webhooks
- Loot despawn heatmap on the map page
- Player portal (stats, kill history, economy balance)
- In-game economy (wallets, bank, casino, shop)
- Mission file editor (edit `types.xml`, `cfgeconomycore.xml`, etc. via web UI)
- Faction system, admin reports, session analytics

**Stack:** Node.js + Express backend, vanilla JS + Tailwind CSS frontend, PostgreSQL database, Discord.js bot. No frontend framework. No ORM.

---

## Directory Map

```
server.js               Express app entry point; mounts all routes
scheduler.js            node-cron jobs (log sync, economy tasks, feed processor)
docker-compose.yml      Three services: postgres, backend, bot
Dockerfile              Backend container
Dockerfile.bot          Bot container (separate process, separate package.json)

routes/                 Express route handlers (one file per domain)
services/               Business logic called by routes and scheduler
middleware/             Auth checks, rate limiting, CSRF
workers/                Feed processor (kill/event feed to Discord webhooks)
utils/                  Shared utilities (encryption, Nitrado HTTP helpers)

bot/                    Entirely separate Node process
  bot/index.js          Entry point; loads commands and events
  bot/commands/         Slash command handlers
  bot/events/           Discord.js event handlers (ready, interactionCreate)
  bot/services/         Bot-specific services (server status loop, log sync)
  bot/db.js             Bot's own DB connection (same PostgreSQL instance)
  bot/package.json      Bot has its own dependencies — add deps here for bot code

db/                     Database schema and migrations
  db/schema.js          initializeDatabase() — runs on every backend start
  db/migrations/        Numbered migrations (004 baseline plus incremental files; enumerate before adding one)

public/                 Static HTML and assets served through Express
  public/*.html          HTML documents rendered/served by application routes
  public/js/             Client-side JavaScript (vanilla, per-page modules)
  public/css/            Compiled Tailwind output

styles/                 Tailwind CSS source (`styles/input.css`)
bin/                    Local DayZ server files + wiki docs (NOT served; used for reference/dev)
downloads/              Runtime directory: Nitrado log files downloaded here (gitignored)
scripts/                One-off maintenance scripts
```

---

## Architecture: How the Pieces Connect

```
Discord User
    │
    ▼
Discord Bot (bot/) ──────────────────────────────────────┐
    │  slash commands                                     │
    │  reads/writes PostgreSQL directly via bot/db.js     │
    │  polls Nitrado API every 5 min (serverStatusService)│
    │                                                     │
    └──► Nitrado API (file server, gameserver API)        │
                                                          │
Web Browser                                               │
    │                                                     │
    ▼                                                     │
Express Backend (server.js) ◄─────────────────────────────┘
    │  REST API + HTML rendering via renderWithCsrf              (shared PostgreSQL)
    │  reads/writes PostgreSQL
    │  calls Nitrado API on behalf of logged-in user
    │
    ▼
PostgreSQL (db/)
```

The bot and backend are **separate containers** that share the same PostgreSQL database. They do not communicate via HTTP — they coordinate through shared DB state only.

---

## Database Essentials

**Connection:** `db/abstraction/index.js` creates the shared PostgreSQL adapter. Adapter `db.query()` results are plain row arrays—**never access `.rows` on an adapter result**. Native `pg` clients/pools still return `{ rows }`.

**Key tables:**

| Table | Purpose |
|---|---|
| `users` | Discord OAuth users. `discord_id` (string) is the auth key; `id` is internal PK |
| `guilds` | Discord guilds (servers) that have registered the bot |
| `game_servers` | Nitrado server registrations. Stores `platform_server_id` (Nitrado service ID) |
| `guild_tokens` | Encrypted Nitrado API tokens. `token_hash` is AES-256-CBC encrypted |
| `guild_features` | Feature flags per guild. `config` column is JSON |
| `players` | Unified player records (cross-platform) |
| `player_identities` | One row per platform account (xbox/ps/steam) per player |
| `player_gamertags` | Name history per identity per server |
| `kill_events` | Parsed kill log entries (killer, victim, weapon, coordinates, timestamp) |
| `feed_events` | Queue for Discord webhook posts. `processed=0` = pending |
| `player_wallets` | In-game cash per player |
| `player_bank_accounts` | In-game bank balance per player |
| `economy_transactions` | Full audit log of all economy movements |
| `server_restart_log` | History of server restarts (scheduled vs crash) |
| `automation_settings` | Per-user log sync schedule config (JSON) |
| `loot_despawn_events` | Parsed despawn/cleanup log entries for heatmap |

**Migrations:** `db/schema.js` runs `initializeDatabase()` on startup. Migration `004` is the full v2 schema baseline; later numbered files are incremental. Before adding a migration, enumerate the complete directory and choose the next unused numeric prefix—never rely on this document’s snapshot.

---

## Authentication & Authorization

- Login is Discord OAuth via Passport.js (configured in `src/app/registerMiddleware.js`)
- `passport.serializeUser` stores `user.discord_id` (string), NOT `user.id` (integer) — mixing these up breaks auth
- Sessions stored in PostgreSQL via `connect-pg-simple`
- Role hierarchy per guild: `owner > admin > moderator > user`
- Middleware in `middleware/auth.js` — use `requireAuth`, `requireGuildMember`, `requireRole('admin')` etc.
- CSRF tokens: all state-changing routes need `X-CSRF-Token` header. Frontend fetches token from `GET /api/csrf-token` on page load.

---

## Token Encryption

Nitrado API tokens are encrypted at rest using AES-256-CBC.

- `utils/encryption.js` — used by backend
- `bot/utils/nitrado.js` — used by bot (same algorithm)
- Key comes from `ENCRYPTION_KEY` env var (must be exactly 64 hex chars = 32 bytes)
- Encrypted format: `{iv_hex}:{ciphertext_hex}` stored in `guild_tokens.token_hash`

**To get a decrypted token for a guild:**
```js
const { decryptToken } = require('../../utils/encryption');
const rows = await db.query(
  'SELECT token_hash FROM guild_tokens WHERE guild_id=$1 AND token_type=$2',
  [guildId, 'nitrado']
);
const token = decryptToken(rows[0].token_hash);
```

---

## Nitrado API Patterns

All Nitrado calls go through `https://api.nitrado.net/services/{platformServerId}/gameservers/...`

**File download is a two-step process:**
1. `GET /file_server/download?file=/path/to/file` → returns `{data: {token: {url}}}`
2. `GET {url}` (no auth header on second call) → returns file content

**File listing:**
- `GET /file_server/list` (no `dir` param) → root directory entries
- `GET /file_server/list?dir=/noftp/dayzxb` → contents of that directory
- Returns `{data: {entries: [{name, type, path, size, modified_at}]}}`

**Platform path structure (CRITICAL):**

| Platform | Root dir | Mission files path |
|---|---|---|
| Xbox | `/noftp/dayzxb/` | `/noftp/dayzxb/mpmissions/{mission}/` |
| PlayStation | `/noftp/dayzps/` | `/noftp/dayzps/mpmissions/{mission}/` |
| PC | `/noftp/dayz/` or similar | `/noftp/dayz/mpmissions/{mission}/` |

The raw path from the listing API uses `/ftproot/` — replace with `/noftp/` before using in download calls.

**Discover the correct base path at runtime** by listing the root and finding the `dayzxb`/`dayzps`/`dayz` directory. See `resolveGameBasePath()` in `bot/services/serverStatusService.js` for the reference implementation. **Never hardcode `/mpmissions/...` without the platform prefix** — this causes HTTP 500.

---

## Bot Architecture

The bot is a standalone Node process (`bot/index.js`) that:
1. Loads all slash commands from `bot/commands/`
2. Registers Discord event handlers from `bot/events/`
3. Starts a polling loop via `startLoop(client)` in `bot/events/ready.js`

**The status update loop** (`bot/services/serverStatusService.js`):
- Runs every 5 minutes (Discord rate-limits VC renames to 2/10min per channel)
- For each guild with `server_status` feature enabled:
  1. Fetches Nitrado gameserver data
  2. Computes next restart time (see below)
  3. Edits pinned embed in status text channel
  4. Renames player-count VC and restart-countdown VC

**Restart time computation** (two methods, tried in order):
1. **Nitrado scheduled tasks** (`fetchNextRestart`): reads cron-format tasks from Nitrado API. Fields are `minute/hour/day/month/weekday` — NOT a datetime. Uses `parseCronField()` + `getNextCronOccurrenceMs()`.
2. **messages.xml** (`fetchRestartFromXml`): reads `<deadline>` (minutes from server boot) from the DayZ native messages.xml. Server boot time comes from the newest `.RPT` filename in downloads, falling back to `last_status_change`.
   - `cfgeconomycore.xml` declares where `messages.xml` lives — always resolve it via `resolveMessagesXmlPath()`, don't assume `db/messages.xml`
   - `last_status_change` from Nitrado is Unix **seconds** (not ms). Detect: `value < 1e12 ? value * 1000 : value`

**Bot slash commands** live in `bot/commands/`. Each file exports a `data` (SlashCommandBuilder) and `execute(interaction)`. Deploy commands by running `node bot/deploy-commands.js`.

---

## Log Sync

`services/logSyncService.js` (backend service, also called from bot):
- Downloads `.ADM` (admin/kill log) and `.RPT` (server log) files from Nitrado
- Files saved to `downloads/{guildDiscordId}/server_{platformServerId}/config/`
- Triggered by: scheduler (cron), manual API call, or bot command
- After download, `logParserService.js` parses ADM files for kill events
- RPT filenames encode server start time: `DayZServer_X1_x64_YYYY-MM-DD_HH-MM-SS.RPT`

**Important:** `logSyncService.js` uses `axios`. `serverStatusService.js` uses `node-fetch`. Keep them consistent within each file — don't mix HTTP clients.

---

## Feed System (Kill/Event Discord Posts)

1. Kill events parsed from logs → inserted into `kill_events` table
2. `feed_events` table is the queue: `processed=0` = needs posting
3. `workers/feedProcessor.js` polls every 30 seconds, formats embeds, posts to Discord webhooks, marks `processed=1`
4. Webhook URL stored in `guild_features` config for the `kill_feed` feature

---

## Frontend Patterns

- Pages are HTML documents under `public/`, served through explicit Express routes and `utils/renderWithCsrf.js`
- Client-side JS in `public/js/` — one file per page, vanilla JS only, no framework
- Data fetched via `fetch()` to REST API endpoints, then manually set on DOM elements
- Tailwind CSS: source in `styles/input.css`, compiled output in `public/css/`. Run `npm run build:css` after changing Tailwind config or adding new utility classes
- CSRF: every page that POSTs data must call `GET /api/csrf-token` on load and include the token in subsequent requests

---

## guild_features Table

Stores feature configuration per guild:

```sql
-- Check if feature is enabled:
SELECT config FROM guild_features WHERE guild_id=$1 AND feature_name=$2 AND enabled=1

-- Upsert a feature config:
INSERT INTO guild_features (guild_id, feature_name, enabled, config)
VALUES ($1, $2, 1, $3)
ON CONFLICT (guild_id, feature_name) DO UPDATE SET enabled=1, config=$3
```

The `config` column is a JSON string. Parse it with `JSON.parse(row.config)`. Known feature names:
`server_status`, `restart_countdown`, `kill_feed`, `casino_enabled`, `economy_enabled`, `faction_enabled`, `shop_enabled`, `alt_ban`

---

## Environment Variables

Required in `.env`:

```
# Database
POSTGRES_PASSWORD=

# Session & Security
SESSION_SECRET=          # random string, 32+ chars
ENCRYPTION_KEY=          # exactly 64 hex chars (32 bytes)
                         # generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Discord
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
DASHBOARD_OWNER_DISCORD_ID= # initial global Dashboard Owner Discord user ID
DISCORD_GUILD_ID=        # Guild for slash command deployment

# App
DEPLOYMENT_MODE=         # full | bot
APP_NAME=
DASHBOARD_URL=           # e.g. https://dashboard.yourdomain.com
PLAYER_PORTAL_URL=       # e.g. https://player.yourdomain.com
DISCORD_INVITE_URL=      # optional
SESSION_SECURE_COOKIE=   # true if behind HTTPS proxy
RATE_LIMIT_ENABLED=      # true in production
NODE_ENV=                # development | production
```

---

## Common Gotchas

1. **`db.query()` returns rows directly** — never do `.rows` on the result.

2. **`*/` inside JSDoc comments** terminates the block comment early.
   Write `"*\/4"` not `"*/4"` inside `/* */` comment blocks.

3. **Nitrado file paths** always need the platform prefix (`/noftp/dayzxb/`). Using `/mpmissions/...` bare returns HTTP 500 on Xbox/PS servers.

4. **`last_status_change` is Unix seconds**, not milliseconds. Values < 1e12 must be multiplied by 1000 before passing to `new Date()`.

5. **Bot and backend are separate containers** with separate `package.json` files. If you add an npm dependency to bot code, add it to `bot/package.json`, not the root.

6. **Mission file locks are in-memory** in `missionFileService.js`. They are lost on backend restart.

7. **Passport serializes `discord_id` (string)**, not `id` (integer). Never mix them in auth middleware.

8. **`players` vs `player_identities`**: A player is a person; an identity is a platform account. One player can have multiple identities. Kill events link to `identity_id`, not `player_id`.

9. **`cfgeconomycore.xml` declares where `messages.xml` lives.** Do not assume `db/messages.xml` — always use `resolveMessagesXmlPath()`.

10. **Slash commands need re-deploying** after changes to `bot/commands/`. Run `node bot/deploy-commands.js` then restart the bot container.

---

## How to Add a Feature

**New API endpoint:**
1. Add route to the appropriate file in `routes/` (or create a new one and mount it in `server.js`)
2. Put business logic in a new or existing file in `services/`
3. Add auth middleware (`requireAuth`, `requireRole`) as needed
4. If it changes state, protect with `csrfProtection` middleware

**New dashboard page:**
1. Add an HTML document under `public/`
2. Add client-side JS to `public/js/`
3. Add an Express route that serves it through `renderWithCsrf`
4. If it needs data, add a JSON API endpoint

**New bot slash command:**
1. Create `bot/commands/your-command.js` exporting `data` and `execute`
2. Re-run `node bot/deploy-commands.js` to register with Discord
3. No changes needed to `bot/index.js` — commands are auto-loaded

**New scheduled job:**
1. Add to `scheduler.js` using `node-cron`
2. Or add a `setInterval` in `bot/events/ready.js` for bot-side polling

**New database table:**
1. Create `db/migrations/0NN_your_migration.js`
2. Export a `migrate(db)` async function that runs the DDL
3. Register it in `db/schema.js` migration runner

---

## Safe Change Checklist

Before modifying anything:
- Read the file you're changing and all files it imports
- Check if any route tests exist in `scripts/`
- Understand which container owns the file (backend vs bot)
- Verify any Nitrado API calls use the platform-prefixed path

After modifying:
- Check for syntax errors: `node --check path/to/file.js`
- For bot changes: rebuild with `docker-compose up -d --build bot`
- For backend changes: rebuild with `docker-compose up -d --build backend`
- Watch logs: `docker-compose logs -f bot` or `docker-compose logs -f backend`

---

## License

GNU Affero General Public License (AGPL). All contributions must remain AGPL-compatible. Preserve license headers in files that have them. Do not introduce dependencies with incompatible licenses.