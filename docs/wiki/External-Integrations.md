# External Integrations

**Status: CONFIRMED**

**Verified against TESTING revision:** `6db37fa97e471ddb39e207e160ad28de33618e26`

All credentials remain server-side. Browser code calls authenticated dashboard routes and receives status or sanitized data, never raw provider credentials.

## Nitrado

A guild operator registers a long-life token through an authenticated application flow. The application validates the provider account and services, binds the stable provider identity to the guild, encrypts the token at rest, and permits registration only for services discovered through that credential.

### File operations

Nitrado downloads are two-step operations: request a short-lived download URL, then fetch the returned URL without forwarding the original authorization header.

Provider file paths vary by platform. Discover the game root from the listing response and preserve its platform prefix, such as `/noftp/dayzxb/`, `/noftp/dayzps/`, or the detected PC root. Listing paths may use `/ftproot/`; normalize them through the established provider-path logic rather than hardcoding a bare `/mpmissions/...` path.

Downloaded ADM/RPT files are runtime evidence. They are stored by authorized guild/server scope, parsed into PostgreSQL, and must not be committed or used as public documentation examples.

### Time and restart evidence

Nitrado scheduled tasks expose cron fields, not a ready-made datetime. Native `messages.xml` can provide restart deadlines, but its location must be resolved through `cfgeconomycore.xml`. Provider `last_status_change` may be Unix seconds and must be normalized before conversion to a JavaScript date.

## Discord

Discord provides OAuth identity, guild membership/ownership evidence, slash commands, status channels, feeds, and role workflows.

### Linked-player role transition

**Status: CONFIRMED in TESTING source and focused regression coverage.**

A successful exact-server player link writes the ownership/membership state and enqueues durable Discord role reconciliation in the same database transaction, then commits them atomically. After commit, the bot immediately attempts reconciliation. For the configured community policy, the desired linked-member state is:

- **Verified Player** is present (`assignOnLink`);
- **Freshies** is absent (`removeOnLink`).

Reconciliation derives desired state across all active memberships in the Discord guild. It must not remove a shared role while another active membership still requires it. A Discord lookup or mutation failure does not roll back a valid player link; the reconciliation job remains retryable instead of being silently forgotten.

Discord role rules store immutable role IDs, not role names. Deleting and recreating a role produces a new ID even when the visible name is unchanged. Re-select recreated roles through `/link-settings`; current TESTING hardening refreshes the guild role inventory during role-setting mutations and prunes references to roles that Discord no longer returns.

Operational requirements:

- Configure **Verified Player** for **Assign when player links**.
- Configure **Freshies** for **Remove when player links**.
- Grant the bot Discord **Manage Roles**.
- Keep the bot's highest role above both managed roles in the Discord hierarchy.
- Do not select integration-managed or otherwise non-editable roles.
- If linking succeeds but roles do not converge, inspect the durable reconciliation job and sanitized bot error category before asking the player to relink.

The web and bot are separate processes. The bot authorizes the actor and exact selected server before dispatching a command. Changes to slash-command definitions require command redeployment and readback verification; source deployment alone does not update Discord registration.

Discord destinations are untrusted configuration. Validate canonical channel IDs and webhook URLs before network access. Webhook requests use bounded timeouts and must not follow redirects outside the validated destination.

## GitHub

GitHub integration is operator-scoped and server-side. Personal access tokens are validated and encrypted. Repository links belong to an exact registered DayZ server and branch.

`services/githubService.js` owns repository, branch, commit, release, workflow, content, branch/file-write, and pull-request operations. Provider behavior belongs in this service rather than directly in browser code or route handlers.

The dashboard exposes workflow status but intentionally does not expose workflow dispatch without a durable replay/idempotency contract.

## AI providers

Operators may use an approved OpenAI-compatible provider or the Copilot SDK path. User-configured origins are subject to exact-host and network-address validation. Requests have bounded message/file/output sizes and reject truncated full-file replacements.

AI output is untrusted. It does not override authorization, validation, migration policy, financial rules, or publication approvals. Never give an agent ambient access to secrets or unrelated private context.

## Shared client conventions

- finite timeout;
- cancellation propagation where available;
- safe error categories without upstream bodies or credentials;
- bounded retry for idempotent reads only;
- respect bounded `Retry-After`/rate-reset delays;
- no blind retry for mutations or authentication failures;
- bounded, expiring caches with mutation invalidation;
- exact tenant/server authorization before returning cached data.

## Troubleshooting

Classify authentication, rate-limit, timeout, network, not-found, invalid-request, and upstream failures separately. A provider outage does not necessarily mean the dashboard is unhealthy.

Never troubleshoot by printing a token, cookie, authorization header, decrypted credential, provider response containing credentials, or database connection string.

## Source anchors

- `docs/EXTERNAL_INTEGRATIONS.md`
- `utils/externalApiClient.js`
- `utils/nitradoHttp.js`
- `services/nitradoService.js`
- `services/githubService.js`
- `utils/externalApiResponse.js`
- `utils/dayzPlatform.js`
- `services/logSyncService.js`
- `utils/discordPoster.js`
- `utils/linkRoleReconciler.js`
- `bot/commands/link-settings.js`
- `bot/utils/linkSettings.js`
- `bot/utils/commandAuthorization.js`
- `scripts/link-lifecycle-test.js`
- `scripts/link-security-behavior-test.js`
