# Contributing to S.A.L.T.

Thank you for helping improve S.A.L.T.

## Before you start

1. Search existing code, issues, and pull requests before creating a new utility, service, script, abstraction, or document.
2. Keep changes focused. Do not mix feature work with unrelated refactoring or generated cleanup.
3. Read `AGENTS.md` for architecture and security invariants.
4. Open an issue first for breaking changes, migrations, new dependencies, or major architectural work.

## Development setup

Use Node.js 22, then install both package boundaries:

```bash
npm ci
npm ci --prefix bot
npm run local:setup
npm run local:up
```

Use credentials for dedicated test accounts and servers. Never use production secrets in fixtures, screenshots, logs, or pull requests.

## Required checks

```bash
npm test
npm run lint
npm run security:audit
npm audit
npm run build:css
```

Database or migration changes also require the PostgreSQL smoke tests described in `AGENTS.md`. Bot command changes require command-registration verification.

## Pull requests

- Explain the problem and the smallest solution.
- List tests run and any checks that could not be run.
- Call out migrations, configuration changes, new environment variables, and breaking behavior.
- Include no credentials, real provider IDs, player data, production logs, database exports, map tiles, or private infrastructure details.
- Update documentation when behavior changes.
- Do not commit generated temporary files or unrelated formatting changes.

Contributions are accepted under the repository's AGPL-3.0-or-later license.
