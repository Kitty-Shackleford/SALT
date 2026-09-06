# User-Owned GitHub Actions for DayZ

## Status

Version 1.0.0 implements a standalone automation kit plus read-only discovery in the DayZ Dashboard and Discord bot. The kit is copied into a server owner's repository and has no runtime dependency on the dashboard, bot, or API.

Implemented v1 capabilities:

- Six-hour and manually dispatched Nitrado server-status collection
- Bounded JSONL status history
- DayZ XML/JSON well-formedness validation
- Expiring, repository-scoped Nitrado backup artifacts for explicitly configured paths
- Machine-readable integration manifest and JSON schemas
- Static GitHub Pages server-status and validation site
- Dashboard manifest/capability/workflow/run discovery
- Discord `/github` health summary

Not claimed by v1: semantic Central Economy validation, ADM/RPT event parsing, chat/admin/player archives, economy analytics, signed callbacks, or platform-triggered workflow dispatch. These require separate reviewed capabilities and schemas; the manifest is designed to add them without pretending they already exist.

## Architecture

```text
DayZ server ← Nitrado API/file server ← user repository GitHub Actions
                                           │
                              JSON/JSONL, reports, artifacts
                                           │
                         ┌─────────────────┴───────────────┐
                         ▼                                 ▼
                  GitHub Pages                    optional read-only
                                                   platform discovery
                                                        │
                                          Dashboard + Discord bot
```

The user repository is the automation boundary and data owner. Workflows schedule themselves, authenticate with repository secrets, and call Nitrado directly. Platform outages cannot stop scheduled workflows. GitHub outages do not stop the dashboard's direct Nitrado features. The platform never runs a GitHub-hosted runner and v1 does not expose workflow dispatch.

## Repository contract

The installable template is `templates/dayz-server-automation/`:

```text
.github/workflows/
  dayz-monitor.yml
  dayz-validate.yml
  dayz-backup.yml
  dayz-pages.yml
dayz/
  config/                    # owner-selected XML/JSON input
  data/current/              # current machine-readable status
  data/history/YYYY-MM-DD/   # bounded JSONL history
  pages/                     # static application
  reports/current/           # JSON + Markdown validation reports
  schemas/                   # interoperability contracts
  scripts/                   # standalone collectors/generators
dayz-integration.json        # discovery manifest at repository root
```

The manifest remains at the repository root so discovery has one deterministic, non-secret location. Data endpoint paths are repository-relative and validated before the platform uses them.

## Manifest and capability discovery

Schema: `dayz/schemas/integration-manifest.schema.json`.

Required identity fields:

- `schema_version`: currently `1`
- `platform`: `dayz`
- `server_id`: exact Nitrado service ID
- `integration_version`: semantic kit version
- `generated_at`: canonical ISO-8601 timestamp

Each action declares its ID, display name, version, exact workflow path, capabilities, outputs, and expected interval. The platform rejects a manifest whose `server_id` differs from the exact authorized server. It caps manifest size, action count, path length, and capability syntax.

Health states:

- `not_installed`: repository linked, manifest absent or workflow absent
- `running`: latest run has not completed
- `healthy`: latest run succeeded within three expected intervals
- `failing`: latest run completed unsuccessfully
- `stale`: last success is older than three expected intervals
- `disabled`: workflow exists but is inactive
- `partial`: some declared actions are healthy and others are not
- `unknown`: insufficient run information
- `invalid`: manifest is malformed, unsupported, or belongs to another server

## Data schemas

### Server status

`dayz/data/current/server-status.json` is the current application record. Daily `server-status.jsonl` files provide append-only history suitable for streaming and aggregation. The v1 schema records exact server ID, generation timestamp, provider status, player count/capacity, nullable uptime, and provider status-change value.

### Validation

`dayz/reports/current/validation.json` is machine-readable; `validation.md` is the human report. v1 checks syntax/well-formedness for XML and JSON. Semantic CE rules require future schema-aware validators and will use a new capability identifier rather than silently changing this result.

### Backups

Backups are GitHub Actions artifacts, not repository data endpoints. Metadata records generation time, configured source paths, and total bytes. Artifacts expire after 14 days and are not copied to Pages.

### GitHub Pages

Pages is a static, dependency-free site generated entirely in the owner's repository. It also listens for Monitor and Validator completion through `workflow_run`; pushes made by a repository `GITHUB_TOKEN` do not recursively start ordinary `push` workflows.

## Installation flow

1. Owner chooses or creates a private GitHub repository.
2. Owner copies `templates/dayz-server-automation/`, including `.github`.
3. Owner sets repository secret `NITRADO_API_TOKEN`.
4. Owner sets repository variable `NITRADO_SERVER_ID` and the same value in `dayz-integration.json`.
5. Optional backup variables configure exact remote roots and maximum bytes; Backup is manual-only until the owner deliberately schedules it.
6. Owner manually runs Server Monitor and checks the generated status file.
7. Optional: owner enables GitHub Pages with GitHub Actions as source.
8. Optional: owner connects GitHub in the DayZ Dashboard and links that repository to the exact server.
9. Dashboard reads the manifest and GitHub workflow metadata; `/github` shows the same health model in Discord.

No secret is entered into a workflow file. The dashboard's existing GitHub connection is separate from the Nitrado secret stored by GitHub.

## Authentication and authorization

### Actions to Nitrado

The user's repository secret authenticates directly to Nitrado. The token is never written to output files. Requests have a finite timeout, validate response shape, and return sanitized status-only errors. Backup download URLs must use HTTPS and backup size is bounded.

### Platform to GitHub

V1 uses the existing user-connected, encrypted, fine-grained GitHub token and an exact per-user/per-server repository link. Discovery requires the current user to retain `server.manage` authority. Repository access should be limited to metadata, Actions read, and contents read for discovery. Existing pull-request features may require separate contents/pull-request write permissions; those are not required by the Actions health endpoint.

A GitHub App is the recommended long-term connection model because installations are repository-scoped, revocable, auditable, and use short-lived tokens. Migration should preserve this contract:

1. GitHub App requests Metadata read, Contents read, and Actions read.
2. Contents/Pull requests write is a separately consented feature for configuration PRs.
3. Actions write is requested only if explicit allowlisted dispatch is enabled.
4. Installation repository ID, not only owner/name, is bound to the exact internal server.
5. Every refresh and dispatch rechecks current exact-server authority.

The bot reads only an already linked exact-server repository after centralized command authorization. Replies are ephemeral; private repository names are not displayed.

## Platform communication options

| Mechanism | Strength | Limitation | Decision |
|---|---|---|---|
| Repository manifest through GitHub API | Simple, private-repo capable, deterministic | Polling and API rate limits | Implemented discovery source |
| Workflow/run API | Authoritative health | Requires Actions read | Implemented health source |
| GitHub Pages JSON | No token for public sites | Public-only and cache/staleness ambiguity | Optional presentation, not authority |
| Webhooks | Timely | Public callback, signature/key lifecycle | Future cache/update optimization |
| User callback from Actions | Works without GitHub polling | Creates dashboard dependency and secret | Not required; optional future signal only |
| Signed output | Tamper evidence outside GitHub | Key provisioning/rotation complexity | Future cross-platform federation |
| GitHub App | Least-privilege short-lived auth | Installation/OAuth implementation cost | Recommended authentication target |

## Data-source priority

1. Direct Nitrado API/file access supplies live operational state.
2. GitHub-generated structured data supplies owner-controlled history and reports.
3. When both exist, the UI labels source and generated timestamp; live state is not overwritten by older repository data.
4. Markdown is never parsed when a declared JSON endpoint exists.

## Permissions

Workflows declare explicit permissions. Monitor and validator need `contents: write` only because they commit small generated records. Backup is `contents: read` and uploads an expiring artifact. Pages gets only `contents: read`, `pages: write`, and `id-token: write`. No workflow uses `write-all`.

Repository owners should use branch protection deliberately: scheduled commits to a protected branch may require a dedicated data branch or ruleset exception. V1 defaults to the current branch for a minimal install; teams with protected `main` should move generated data to a reviewed data branch before enabling schedules.

## Privacy

Private is the default recommendation. The kit does not collect IP addresses, authentication data, player platform identifiers, chat, or raw logs in v1. Owners must review data before enabling public Pages. Backup artifacts may contain private configuration, are accessible to readers allowed by GitHub's repository/artifact policy, and must never be published or committed; use a private repository for backups. Fork-based workflows do not receive repository secrets by GitHub design and should stay that way.

## Retention and repository growth

- Current status is overwritten.
- Six-hour samples are grouped into daily JSONL files and working-tree history is removed after `DAYZ_RETENTION_DAYS` (31 by default). Git retains old commits; long-lived installations should periodically squash/archive the data branch if repository size becomes material.
- Backup artifacts expire after 14 days.
- Raw logs are not committed.
- Future log support should checkpoint offsets, aggregate events, compress archives, cap bytes per run, and use Releases/object storage for archives rather than unlimited Git history.

## Explicit operations and workflow dispatch

V1 is read-only from platform to repository. If dispatch is added, it must be an allowlist such as `health_check`, `validate`, `report`, `backup`, or `refresh`; each maps to a fixed workflow filename and validated inputs. Requirements:

- current `server.manage` authorization
- exact repository installation bound to exact server
- separate Actions-write consent
- fixed ref and workflow ID from the manifest
- no caller-provided command, script, path, environment, or runner label
- rate limit, idempotency key, audit record, and provider result readback
- backup remains a distinct high-impact capability

Arbitrary shell execution is permanently out of scope.

## Versioning

Kit files use semantic versions; manifests and output formats use independent integer schema versions. Owners pin a reviewed kit release and opt into upgrades. Patch releases fix compatible behavior, minor releases add optional fields/capabilities, and majors may require workflow changes. Breaking data changes require a new schema file and dual-read migration period.

## Failure and recovery

- Dashboard down: Actions and Pages continue.
- Bot down: Actions, Pages, and dashboard continue.
- Platform API down: no effect on user workflows.
- GitHub down: direct Nitrado dashboard/bot features continue; Actions resume on GitHub recovery.
- Nitrado down: workflow fails visibly without replacing prior good data.
- Invalid manifest: platform shows `invalid` and refuses cross-server data.
- Deleted/disabled workflow: health reports `not_installed`/`disabled`.
- Stale run: health becomes `stale`; manual dispatch is the first recovery step.
- Partial backup: workflow fails and no successful artifact should be trusted.

## Troubleshooting

- **401/403 from Nitrado:** rotate/re-enter `NITRADO_API_TOKEN`; confirm it can access `NITRADO_SERVER_ID`.
- **Manifest invalid:** use canonical timestamps ending in `.000Z`, keep paths repository-relative, and confirm exact server ID.
- **Monitor cannot push:** grant workflow `contents: write` in repository Actions settings or adapt to a data branch allowed by branch protection.
- **Backup finds no files:** confirm `/noftp/dayzxb`, `/noftp/dayzps`, or `/noftp/dayz` platform prefixes and list permissions.
- **Pages empty:** run Monitor/Validator first, select GitHub Actions as Pages source, then dispatch Pages.
- **Dashboard says not installed:** ensure `dayz-integration.json` is at repository root on the linked branch.
- **Dashboard says stale:** inspect the workflow's latest run and expected interval.

## Roadmap

1. Extract collectors/parsers into a separately versioned `dayz-actions` repository and publish immutable `v1` tags/releases while preserving copy-in standalone mode.
2. Add a GitHub App for least-privilege discovery.
3. Add incremental ADM/RPT collection with redaction and byte-bounded artifact retention.
4. Reuse hardened DayZ parsers for structured player/event/admin data with privacy modes.
5. Add semantic CE/config validators and schemas.
6. Add daily/weekly aggregation and richer static Pages views.
7. Add optional signed webhooks for low-latency health cache updates.
8. Add audited allowlisted dispatch only after the read-only model is stable.
