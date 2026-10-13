# Security and Data Integrity

**Status: CONFIRMED**

**Verified against TESTING revision:** `6db37fa97e471ddb39e207e160ad28de33618e26`

## Core authorization invariant

Every consequential operation must bind the authenticated actor to an approved guild and the exact DayZ server/resource being accessed. Client-provided identifiers select a candidate; they never prove authorization.

Unknown, disabled, mismatched, or ambiguous resources fail closed. Where enumeration would be harmful, absent and unauthorized tenant resources should produce the same response.

## Trust planes

- **Platform:** global dashboard maintenance is explicit and separate from guild roles.
- **Guild:** owner/admin rights belong to one approved Discord guild.
- **Server:** admin/moderator assignments belong to one active server within one guild.
- **Player:** linked identity ownership and active server membership are separate concepts.
- **Provider:** a credential is bound to a guild and stable provider account; discovered services still require exact ownership verification.

`services/authorizationService.js` defines allow-listed capabilities and returns canonical trusted actor/guild/server/player context. Handlers should consume that context rather than re-trusting route, query, or body identifiers.

Mutation authorization is rechecked under database locks where authority could change during a transaction. Broad eligibility middleware such as “approved guild” is not sufficient for a handler operating on a caller-selected server, player, channel, file, or provider resource.

## Authentication, sessions, and CSRF

Passport serializes `discord_id`. Sessions live in PostgreSQL and cookies are HTTP-only, SameSite=Lax, and secure when configured for HTTPS. Discord OAuth uses state validation.

CSRF protection is global and session-backed. Unsafe requests need a valid token in an accepted header or body field. Query-string tokens are rejected. Preserve middleware order: request handling, sessions, security headers, Passport, body parsing/static policy, CSRF, then rate limiting and routes.

## Filesystem boundary

Do not build paths with untrusted user, guild, server, filename, backup, or provider identifiers.

`utils/safePath.js` provides:

- strict storage-identifier validation;
- lexical containment checks;
- canonical root verification;
- descriptor-anchored directory traversal;
- `O_NOFOLLOW` file opens;
- contained read/list/stat/write helpers;
- atomic contained writes.

Mission-file and backup operations must remain anchored to the already-authorized server root. Reject traversal, absolute-path escape, separator injection, NULs, symlink roots, symlink swaps, and non-file targets. Do not replace descriptor-anchored operations with a simple `path.resolve()` prefix check.

## Financial integrity

Money and supply changes require exact-server scope, exact decimal handling, transaction boundaries, immutable evidence, and idempotency. Never use binary floating-point for stored monetary authority. Authorization must be revalidated at operation time; active linked accounts with accepted verification methods are the ownership basis defined by current policy.

Refund, bounty, casino, shop, bank, wallet, and supply mutations must leave auditable transaction/evidence rows and fail closed on conflicts, overflow/capacity, replay, or ambiguous ownership. Do not “repair” financial data by guessing a tenant or copying a balance across servers.

## Secrets and sensitive data

- Never print or commit `.env` values, credentials, tokens, cookies, session IDs, private keys, connection strings, or raw provider authorization headers.
- Keep Nitrado, GitHub, Discord, and AI-provider credentials server-side and encrypted at rest.
- Never return decrypted credentials to browser code.
- A secret deleted from the current tree can remain in Git history; rotate/revoke first and evaluate history separately.
- `.gitignore` is not a security boundary.

Run `npm run security:audit` before release work. Use its history mode when evaluating repository publication. Scanner success does not replace manual review of private documentation, binary files, branches, tags, or deleted history.

## External requests

Use finite timeouts, sanitized client errors, cancellation, redirect restrictions, and bounded retries. Retry safe idempotent reads only. Mutations and authentication failures are not blindly retried.

User-configured provider URLs need exact-host allow-listing and DNS/IP checks that reject loopback, private, link-local, reserved, and multicast destinations except explicitly allowed local testing paths.

Discord webhook URLs and channel IDs must be normalized and validated before network access. Do not follow provider redirects that can bypass the validated destination.

## Browser output

Treat API and provider strings as untrusted. Prefer `textContent`, node construction, and safe attribute setters. Do not insert untrusted strings with `innerHTML`. Inline event handlers and inline scripts conflict with the content security policy.

## Logging and errors

Logs and client responses must use sanitized categories and metadata. Do not expose upstream bodies, credentials, headers, stack traces, player identifiers, or private connection details. Error paths must fail closed without converting provider failure into authorization bypass or false success.

## Source anchors

- `services/authorizationService.js`
- `middleware/auth.js`
- `middleware/serverAccess.js`
- `src/app/createApp.js`
- `src/app/registerMiddleware.js`
- `utils/safePath.js`
- `routes/missionFiles.js`
- `utils/encryption.js`
- `utils/money.js`
- `utils/externalApiClient.js`
- `utils/discordPoster.js`
- `docs/multi-tenant-authorization.md`
