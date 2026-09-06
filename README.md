# S.A.L.T.

**Server Administration, Logistics & Telemetry**

S.A.L.T. is a self-hostable web dashboard and Discord bot for administering DayZ servers hosted by Nitrado. It supports bot-only and full web deployments and keeps tenant access scoped to approved Discord guilds and registered game servers.

## Features

- Nitrado server registration, status, restart scheduling, and mission-file management
- Discord status embeds, slash commands, and player-account linking
- ADM/RPT log synchronization, kill feeds, player statistics, and radar data
- Economy, shops, factions, bounties, casino, and audited financial operations
- PostgreSQL-backed multi-tenant authorization and operational tooling
- Optional GitHub and AI-provider integrations

## Requirements

- Node.js 22 (`>=22 <23`)
- PostgreSQL 15 or the provided Docker Compose service
- A Discord application and bot
- A Nitrado account and API token for live server management

## Quick start

```bash
git clone https://github.com/Kitty-Shackleford/SALT.git
cd SALT
npm ci
npm ci --prefix bot
cp .env.example .env
```

Fill in `.env` using placeholders and comments in `.env.example`. Never commit `.env`, tokens, credentials, production exports, logs, or database dumps.

Build the frontend CSS and start the full stack:

```bash
npm run build:css
docker compose up -d backend bot
```

For bot-only operation, set `DEPLOYMENT_MODE=bot` and start the bot service:

```bash
docker compose up -d bot
```

For an isolated local environment:

```bash
npm run local:setup
# Add credentials for a dedicated test Discord application to .env.local.
npm run local:up
npm run local:commands
```

The local dashboard is available at `http://localhost:3000`. Add `http://localhost:3000/auth/discord/callback` to the test Discord application's OAuth redirect URLs.

`local:setup` creates an ignored `.env.local` with generated local session, encryption, and database secrets. It does not overwrite an existing file or print generated values. Use a dedicated test bot and guild: local integration calls are real when provider credentials are supplied.

## Runtime modes

- `DEPLOYMENT_MODE=full`: backend, bot, scheduler, and PostgreSQL
- `DEPLOYMENT_MODE=bot`: bot and PostgreSQL without the website
- `DEPLOYMENT_MODE=local`: isolated loopback-only development stack

The interactive admin TUI is an opt-in operational tool:

```bash
docker compose --profile tools run --rm tui
```

The bot and backend are separate processes sharing PostgreSQL. See `AGENTS.md` for architecture, security boundaries, and contribution conventions.

## Configuration and security

Required production values include:

- `POSTGRES_PASSWORD`
- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `ENCRYPTION_KEY` (exactly 64 hexadecimal characters)
- `DASHBOARD_OWNER_DISCORD_ID`

Full web mode additionally requires the Discord client secret, session secret, and public dashboard/OAuth URLs. See `.env.example` for the complete contract.

Nitrado tokens are registered through the application and encrypted at rest. They do not belong in repository files or environment examples.

Before deploying, run:

```bash
npm test
npm run lint
npm run security:audit
npm audit
npm run build:css
```

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Map tiles

Map tile binaries are intentionally **not included** in this public repository. The map UI expects operator-supplied tiles under:

```text
public/maps/<map-name>/tiles/<x>/<y>.png
```

Only use tiles you are legally permitted to host and redistribute. See `public/maps/README.md` for the expected layout. The application can otherwise be developed and tested without committing tile binaries.

## Documentation

- [External integrations](docs/EXTERNAL_INTEGRATIONS.md)
- [Database notes](docs/DATABASE.md)
- [Migration notes](docs/MIGRATION.md)
- [Multi-tenant authorization](docs/multi-tenant-authorization.md)
- [DayZ loot system](docs/dayz-loot-system.md)
- [Release history](CHANGELOG.md)
- [Contributor guide](CONTRIBUTING.md)

## Contributing

Issues and focused pull requests are welcome. Search the repository before creating a helper, service, script, or document; extend an existing implementation when possible. Read [CONTRIBUTING.md](CONTRIBUTING.md) and `AGENTS.md` before making changes.

## License

S.A.L.T. is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE). Bundled third-party browser assets retain their own notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Community

- Website: https://saltskrew.xyz
- Discord: https://discord.gg/KJyRgfej7H
- Patreon: https://www.patreon.com/Kitty_Shackleford

## Support the project

- BTC: `bc1qeun5ap3lgel3q6wel3vxpmvjgu2d5lp6gauxk3`
- ETH: `0x33b68886ad3416c7f33c4a24a29731fcf7c18141`
