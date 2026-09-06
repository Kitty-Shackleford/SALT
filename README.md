# S.A.L.T.

**Server Administration & Logistics Toolkit**

S.A.L.T. is a self-hosted web dashboard and Discord bot for administering Nitrado-hosted DayZ servers on Xbox, PlayStation, and PC. It combines server operations, Discord automation, player services, mission-file tooling, analytics, and an optional AI-assisted configuration workflow in one multi-tenant application.

> S.A.L.T. performs real provider and Discord actions. Start with dedicated test credentials and a non-production server whenever possible.

## What S.A.L.T. includes

### Server administration

- Register and manage multiple Nitrado DayZ services per Discord guild
- View server status, player counts, uptime, settings, statistics, and activity
- Start, stop, and restart servers with role-based authorization
- Inspect and create scheduled Nitrado tasks
- Synchronize and parse `.ADM`/`.RPT` logs for online state, kills, player activity, feeds, and analytics
- Access the administrative console, backups, log downloads, and support links
- Keep operations scoped to the exact guild and server selected by the operator

### Mission and gameplay tooling

- Browse, validate, edit, and upload DayZ XML and JSON mission files
- Configure mission initialization and reusable composition content
- Build and activate scheduled configuration-rotation presets
- Review spawn exclusions and event-health information
- Find loot and visualize loot-despawn activity on operator-supplied maps
- Queue audited player teleports and enforce position-restriction rules

### Discord and player features

- Live server-status embeds and player/restart voice-channel counters
- Kill feeds, faction feeds, restart notifications, and moderation logs
- Slash commands for status, online players, statistics, leaderboards, linking, bans, whitelists, server control, and more
- Discord OAuth login with guild- and server-scoped owner, admin, moderator, and player access
- Player portal with linked identities, statistics, kill history, map/radar access, and economy information

### Economy and community systems

- Wallets, bank accounts, transaction history, and supply auditing
- Shops, item provisioning, rentals, casino games, bounties, and leaderboards
- Factions, reports, account-link controls, and alt-account review
- Feature flags so operators can enable only the systems their community uses

### AI and GitHub assistance

- AI chat and analysis for supported DayZ configuration files
- OpenAI-compatible providers or the GitHub Copilot SDK
- Server-aware suggestions using authorized statistics and file context
- Optional GitHub repository links and pull-request workflows for reviewed changes
- User-owned GitHub Actions automation templates under `templates/dayz-server-automation/`

Some features require an approved guild, an enabled server, a linked player identity, a feature flag, or a role with the appropriate capability. Provider support can also differ by DayZ platform and Nitrado service configuration.

## Architecture

```text
Discord users ──► Discord bot ──────────────┐
                    │                       │
Web users ─────► Express dashboard          ├──► PostgreSQL
                    │                       │
                    └──► Nitrado / GitHub ──┘
```

The backend and bot are separate Node.js processes. They coordinate through the same PostgreSQL database; they do not call each other over HTTP. The frontend is vanilla JavaScript and Tailwind CSS served by Express.

## Requirements

### Docker deployment

- Docker Engine with Docker Compose v2
- A Discord application and bot
- A Nitrado account with at least one DayZ service
- A Nitrado long-life API token for the account that owns those services
- A public HTTPS reverse proxy for production web deployments

### Source development

- Node.js 22 (`>=22 <23`)
- npm
- PostgreSQL 15, or Docker for the supplied local stack

Optional integrations:

- A GitHub account/token for repository-backed suggestions and automation
- An OpenAI-compatible inference provider or GitHub Copilot for the built-in AI assistant
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) and optionally [Ollama](https://ollama.com/) for AI-assisted development

## Production walkthrough

### 1. Clone the repository

```bash
git clone https://github.com/Kitty-Shackleford/SALT.git
cd SALT
cp .env.example .env
```

Keep `.env` on the deployment host. Never commit it or paste its contents into an issue, pull request, chat, screenshot, or log.

### 2. Create the Discord application

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create an application and bot.
2. Record the application/client ID, client secret, and bot token in `.env`.
3. Add an OAuth redirect URL for every configured public hostname. If the dashboard and player portal use different hostnames, register both:

   ```text
   https://your-dashboard.example/auth/discord/callback
   https://your-player-portal.example/auth/discord/callback
   ```

4. Invite the bot with the `bot` and `applications.commands` scopes. Grant only the Discord permissions needed by the features you enable. Status-channel setup, feed setup, and voice-channel counters require permissions to manage the relevant channels, messages, and webhooks.
5. Set `DISCORD_GUILD_ID` during initial setup if you want commands registered to one test guild immediately. Leave it empty for global registration, which can take longer to propagate.

### 3. Configure `.env`

At minimum, review and set:

```dotenv
NODE_ENV=production
DEPLOYMENT_MODE=full
APP_NAME=S.A.L.T.
DASHBOARD_URL=https://your-dashboard.example
PLAYER_PORTAL_URL=https://your-player-portal.example
SESSION_SECURE_COOKIE=true
RATE_LIMIT_ENABLED=true

DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_BOT_TOKEN=...
DISCORD_GUILD_ID=...
DASHBOARD_OWNER_DISCORD_ID=...

SESSION_SECRET=...
ENCRYPTION_KEY=...
POSTGRES_PASSWORD=...
```

Generate secrets locally on the deployment host:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use separate output values for `SESSION_SECRET` and `ENCRYPTION_KEY`. `ENCRYPTION_KEY` must be exactly 64 hexadecimal characters. `DASHBOARD_OWNER_DISCORD_ID` identifies the initial global owner. The bot path verifies that configured ID through live guild membership; the web path verifies the same ID through Discord OAuth. S.A.L.T. never silently replaces an existing different owner.

The supplied Compose file binds the dashboard to `127.0.0.1:3000`. Put a trusted HTTPS reverse proxy in front of it; do not expose the backend port directly to the internet.

### 4. Build and start S.A.L.T.

```bash
docker compose up -d --build backend bot
```

Compose starts PostgreSQL and runs the one-shot database initializer before the backend and bot become available.

Inspect startup state without printing environment values:

```bash
docker compose ps
docker compose logs --since=10m backend bot
curl -I http://127.0.0.1:3000/
```

### 5. Register Discord slash commands

```bash
docker compose run --rm bot node deploy-commands.js
```

Run this again whenever command definitions change. Guild-scoped commands normally appear immediately; global commands may take up to an hour.

### 6. Complete first-time onboarding

1. Invite the bot to the Discord guild.
2. As the guild owner or a Discord administrator, run `/register-token` and provide the Nitrado token in the command's private interaction.
3. S.A.L.T. verifies the Nitrado account, discovers its DayZ services, encrypts the token, and leaves discovered servers disabled.
4. Sign in at `DASHBOARD_URL` through Discord OAuth.
5. Enable only the servers you intend to manage.
6. Run `/setup-status` for the status channels and `/setup-feeds` for optional Discord feeds.
7. Configure server roles, account-link policy, feature flags, automation, and player-facing systems from the dashboard.

Use `/server-status` to confirm registration. Players can then use `/link` or the configured account-link workflow before accessing identity-scoped features.

## Bot-only mode

For a deployment without the website:

```dotenv
DEPLOYMENT_MODE=bot
```

Then start the bot and its database dependencies:

```bash
docker compose up -d --build bot
```

The web dashboard, Discord OAuth, and browser-only administration pages are unavailable in this mode.

## Local development walkthrough

Install both dependency boundaries and create an isolated local environment:

```bash
npm ci
npm ci --prefix bot
npm run local:setup
```

`local:setup` creates an ignored, mode-`0600` `.env.local` with generated local session, encryption, and database secrets. It never overwrites an existing file or prints generated values.

Add credentials for a dedicated Discord test application and test guild to `.env.local`, including this OAuth callback:

```text
http://localhost:3000/auth/discord/callback
```

Start the isolated stack and register commands:

```bash
npm run local:up
npm run local:commands
```

Open `http://localhost:3000`. Useful development commands:

```bash
npm run local:ps
npm run local:logs
npm run local:down
```

Local mode still makes real Discord, Nitrado, GitHub, and AI-provider calls when those credentials are supplied. Use test accounts and disposable services.

## Developing S.A.L.T. with Hermes Agent

Hermes Agent is an optional coding assistant; it is not required to run S.A.L.T. The repository includes `AGENTS.md`, which gives Hermes the project architecture, security boundaries, commands, and conventions automatically when Hermes starts from the repository root.

### Install and configure Hermes

Linux, macOS, or WSL2:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes setup
hermes doctor
```

On native Windows, use the official PowerShell installer documented in the [Hermes installation guide](https://hermes-agent.nousresearch.com/docs/getting-started/installation).

Choose a model/provider with:

```bash
hermes model
```

Then work from the S.A.L.T. checkout:

```bash
cd SALT
hermes
```

A good first request is:

```text
Read AGENTS.md, inspect the relevant source and tests, make the smallest safe change, and run the affected tests and lint before reporting completion.
```

Recommended workflow:

1. Start Hermes from the repository root so `AGENTS.md` is loaded.
2. Ask it to inspect definitions, usages, tests, and package manifests before editing.
3. Keep production credentials out of prompts and test fixtures.
4. Require focused tests, then `npm test` and `npm run lint` for changes that can affect runtime behavior.
5. Review `git diff` yourself before committing or publishing.
6. Use `hermes -w` for parallel coding sessions so each agent works in an isolated Git worktree.

Hermes documentation: [installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation), [context files](https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files), and [providers](https://hermes-agent.nousresearch.com/docs/integrations/providers).

## Using Hermes with local Ollama models

This setup keeps the coding-assistant model on your machine. Choose a tool-capable model that fits your hardware; larger coding models generally produce better multi-file changes but need substantially more RAM or VRAM.

### 1. Install Ollama and pull a model

Linux:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3.5:27b
```

For macOS or Windows, use the installer from [ollama.com/download](https://ollama.com/download). Replace the example model with another tool-capable model if the 27B model does not fit your hardware.

Hermes requires at least a 64K-token context window for reliable agent/tool use. For a manually started Ollama server:

```bash
OLLAMA_CONTEXT_LENGTH=64000 ollama serve
```

For a systemd-managed Ollama service on Linux, run `sudo systemctl edit ollama.service`, add the following override, then restart the service:

```ini
[Service]
Environment="OLLAMA_CONTEXT_LENGTH=64000"
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

After sending the model a request, verify the loaded model's `CONTEXT` value:

```bash
ollama ps
```

### 2. Connect Hermes to Ollama

Run:

```bash
hermes model
```

Choose **Custom endpoint (self-hosted / VLLM / etc.)**, then enter:

```text
API base URL: http://localhost:11434/v1
API key:      no-key (a non-secret placeholder; Ollama does not authenticate local requests)
Model:        qwen3.5:27b
Context:      64000
```

Start a new session from the repository root:

```bash
cd SALT
hermes
```

Use `/model` inside a running session to switch among providers already configured in Hermes. Use the terminal command `hermes model` to add or reconfigure a provider.

Local models are best used for bounded, low-risk work that is easy to validate. Keep security, authorization, migrations, money handling, provider mutations, deployment, and destructive operations under human review, and always run the repository's real checks after an AI-generated change.

## Optional: use Ollama with S.A.L.T.'s built-in AI assistant

The dashboard AI assistant and Hermes Agent are separate systems:

- **Hermes + Ollama** helps a developer work on this repository.
- **S.A.L.T. AI Assistant** helps an authorized operator analyze and propose changes to DayZ configuration files.

S.A.L.T.'s assistant can use an operator-supplied OpenAI-compatible endpoint. For a backend running directly on the same host as Ollama, the optional deployment-wide fallback can be configured in the private environment file:

```dotenv
AI_API_BASE_URL=http://127.0.0.1:11434/v1/
AI_API_KEY=local-ollama-placeholder
AI_MODEL=qwen3.5:27b
AI_API_TIMEOUT_MS=60000
AI_MAX_OUTPUT_TOKENS=16384
```

The placeholder is not an Ollama secret; the current OpenAI-compatible client requires a non-empty bearer value. Never reuse a real credential as the placeholder.

When S.A.L.T. runs in Docker, `127.0.0.1` refers to the backend container, not the host. This repository does not bundle or expose an Ollama service. Configure a trusted endpoint reachable from the backend container, keep it off the public internet, and verify network isolation before enabling it. Per-user provider connections intentionally reject private/loopback destinations to prevent server-side request forgery, so local Ollama should be configured by the deployment operator rather than through the browser connection form.

See [External integrations](docs/EXTERNAL_INTEGRATIONS.md) for provider security, GitHub linking, request limits, and AI file-replacement safeguards.

## Validation and release checks

Before opening a pull request or deploying a change:

```bash
npm test
npm run lint
npm run security:audit
npm audit
npm run build:css
```

Database or migration changes also require a real PostgreSQL smoke test. Bot command changes require slash-command registration verification. A passing test suite does not prove that live Discord, Nitrado, GitHub, or container connectivity is configured correctly.

## Operations

```bash
# Current container state
docker compose ps

# Recent bounded logs
docker compose logs --since=10m backend bot

# Rebuild after pulling reviewed changes
docker compose up -d --build backend bot

# Optional interactive admin TUI
docker compose --profile tools run --rm tui
```

The TUI is deliberately excluded from the default service set. Back up PostgreSQL and provider-managed files before migrations or destructive operations.

## Security model

- Discord OAuth authenticates browser users; live Discord membership and scoped roles authorize tenant operations.
- State-changing browser requests use CSRF protection.
- Nitrado, GitHub, and personal AI-provider credentials are encrypted at rest and remain server-side.
- The backend applies exact-guild and exact-server authorization to sensitive routes.
- Provider writes are not blindly retried.
- Production requires HTTPS cookies and rate limiting.
- Secrets, private history, operational logs, database exports, real player data, and credentials do not belong in the public repository.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Map tiles

Map tile binaries are intentionally **not included** in this repository. The map UI expects operator-supplied tiles under:

```text
public/maps/<map-name>/tiles/<x>/<y>.png
```

Only host tiles you are legally permitted to use and redistribute. See [public/maps/README.md](public/maps/README.md) for the expected layout. The rest of the application can be developed and tested without committing tile binaries.

## Repository guide

```text
server.js               Express application entry point
scheduler.js            Scheduled log, economy, feed, and maintenance jobs
routes/                  HTTP route handlers
services/                Shared business logic
middleware/              Authentication, authorization, CSRF, and rate limits
workers/                 Background feed processing
bot/                     Separate Discord bot package and process
db/                      PostgreSQL schema and migrations
public/                  HTML, browser JavaScript, and compiled CSS
styles/                  Tailwind CSS source
scripts/                 Tests, checks, setup, and operational utilities
templates/               Optional user-owned automation kits
```

Additional documentation:

- [Contributor guide](CONTRIBUTING.md)
- [Agent/project architecture](AGENTS.md)
- [External integrations](docs/EXTERNAL_INTEGRATIONS.md)
- [Database notes](docs/DATABASE.md)
- [Migration notes](docs/MIGRATION.md)
- [Multi-tenant authorization](docs/multi-tenant-authorization.md)
- [DayZ loot system](docs/dayz-loot-system.md)
- [GitHub Actions automation kit](docs/GITHUB_ACTIONS_AUTOMATION_KIT.md)
- [Release history](CHANGELOG.md)

## Contributing

Issues and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and `AGENTS.md` before changing code. Do not include credentials, real provider identifiers, private infrastructure details, player data, production logs, database exports, or map-tile binaries in contributions.

## Community

- Website: https://saltskrew.xyz
- Discord: https://discord.gg/KJyRgfej7H

## Support and referral links

These links help fund development and operation of S.A.L.T. Some are referral links that may provide a benefit or commission to the project owner.

- [Patreon](https://patreon.com/Kitty_Shackleford)
- [Website hosting referral](https://aklam.io/sC6RTTi9)
- [NordVPN referral](https://refer-nordvpn.com/XnUQCeNcZvS)
- [BTC: `bc1qeun5ap3lgel3q6wel3vxpmvjgu2d5lp6gauxk3`](https://coinbase.com/join/B2XDVY4?src=ios-link) — Coinbase referral link
- [ETH: `0x33b68886ad3416c7f33c4a24a29731fcf7c18141`](https://coinbase.com/join/B2XDVY4?src=ios-link) — Coinbase referral link

## License

S.A.L.T. is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE). Bundled third-party browser assets retain their own notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
