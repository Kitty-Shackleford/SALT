# Multi-tenant authorization architecture

## Security invariant

Every request, bot interaction, background operation, and cached result must resolve an authenticated actor to an approved guild and then to the exact DayZ server/resource being accessed. Client-provided identifiers select a candidate resource; they never prove authorization.

Unknown, disabled, mismatched, or ambiguous resources fail closed. Resource lookup and authorization use one query where practical. Tenant-owned resources that are absent or unauthorized return the same `404` response when enumeration would be harmful.

## Trust planes

1. **Platform authorization** — `users.is_admin` grants global dashboard maintenance only. Platform checks are explicit and are not inferred from a guild role.
2. **Guild authorization** — `guild_roles` grants `owner` or `admin` for one approved guild. The legacy guild-wide `moderator` value does not grant server access.
3. **Server operator authorization** — `server_role_assignments` grants `admin` or `moderator` for one server. The assignment carries both `server_id` and `guild_id`, protected by a composite foreign key.
4. **Player authorization** — global identity ownership (`linked_accounts`) is separate from an active `server_player_memberships` row. Owning an identity alone does not grant access to every server where that identity has historical activity.
5. **Provider authorization** — a Nitrado credential is bound to a guild and stable Nitrado account. A discovered service may be registered only after the authenticated operator, approved guild, bound provider account, and exact service are verified together.

## Capability matrix

| Capability | Platform admin | Guild owner/admin | Server admin | Server moderator | Player |
|---|---:|---:|---:|---:|---:|
| Platform configuration and global audit | yes | no | no | no | no |
| Guild overview and Discord settings | yes | assigned guild | no | no | limited membership view |
| Register/connect a Nitrado server | yes | assigned guild | no | no | no |
| View server operational data | yes | assigned guild | assigned server | assigned server | explicitly associated server, player-safe fields only |
| Manage Nitrado, channels, automation, bot config | yes | assigned guild | assigned server | no | no |
| Change server settings | yes | assigned guild | assigned server | limited capabilities only | no |
| Assign server moderators | yes | assigned guild | no | no | no |
| Moderate players and view server logs | yes | assigned guild | assigned server | assigned server | no |
| View/edit own player data | yes | where administratively required | where administratively required | limited moderation view | self on associated server |
| View tenant audit | yes | assigned guild | assigned server subset | assigned server subset | no |

Capabilities are allow-listed. Role rank comparisons must not silently create new privileges.

## Central authorization contract

Server-side code uses a centralized authorization service with these capability classes:

- `platform.manage`
- `guild.view`, `guild.manage`, `guild.audit`
- `server.view`, `server.manage`, `server.moderate`
- `nitrado.manage`, `bot.manage`
- `player.self`

The service returns a canonical context only after authorization:

```text
actor: { userId, discordId, platformAdmin }
guild: { id, discordGuildId, role, status }
server: { id, platformServerId, role, status }
player: { identityId, membershipId } // only for player capabilities
```

Handlers use this context instead of re-reading identifiers from `params`, `query`, or `body`. Middleware never mutates caller-controlled route parameters to communicate trusted context.

## Data model

- `server_role_assignments(server_id, guild_id, user_id, role, status, assigned_by_user_id, created_at, updated_at)`
- `server_player_memberships(server_id, guild_id, identity_id, status, verification_method, verified_by_user_id, created_at, updated_at)`
- `security_audit_events(guild_id, server_id, actor_user_id, action, result, target_type, target_id, request_id, metadata, created_at)`
- `guild_setup_state(guild_id, current_step, status, completed_steps, last_error, updated_by_user_id, updated_at)`

`servers` has `UNIQUE(id, guild_id)`. Tables that redundantly store `guild_id` and `server_id` must use `(server_id, guild_id) -> servers(id, guild_id)` or derive the guild from the server.

## Request rules

- Guild context may be selected by internal or Discord guild ID, but the authorization query binds it to the actor.
- Server context uses the internal server ID in dashboard APIs. `platform_server_id` is provider metadata, not the dashboard authorization key.
- If a Discord command can target multiple servers, the user must select one. A single-server guild may resolve its sole active server. Multiple matches produce an explicit selection-required error; there is no `ORDER BY ... LIMIT 1` fallback.
- List endpoints query through authorized relationships and never return a global list for client-side filtering.
- Provider credentials and raw integration configuration are never serialized to clients. Responses expose connection/health status only.
- Background jobs persist canonical guild and server IDs and revalidate their relationship before each consequential operation.
- Cache keys include canonical guild and server IDs. Cached values are returned only after authorization.
- This application currently has no tenant-facing WebSocket/SSE implementation. Any future implementation must authorize joins and use `guild:{id}:server:{id}` rooms; global tenant-data broadcasts are prohibited.

## Onboarding state machine

1. Bot joined and pending guild record created.
2. Discord guild owner/authorized setup actor verified.
3. Bot permissions verified.
4. Nitrado credential connected and stable account identity verified.
5. Available DayZ services discovered from that credential.
6. Exact service selected and registered to the approved guild.
7. Discord channels and bot configuration selected.
8. Guild/server administrators assigned.
9. Server moderators and player-link policy configured.
10. Health checks pass and setup is completed.

The setup API derives the actor and guild authorization server-side and computes checks from persisted guild, credential-status, server, feature, and assignment records. The browser cannot mark a check complete directly. `guild_setup_state` is reserved for explicit workflow transitions that require durable operator acknowledgement.

## Safe migration policy

1. Back up and inventory production before applying constraints.
2. Add new nullable/provenance structures without inferring ownership.
3. Backfill only deterministic relationships. Never infer player authorization from historical activity alone.
4. Detect cross-guild `(server_id, guild_id)` mismatches and stop migration with a sanitized count. Quarantine ambiguous records for manual resolution.
5. Migration 050 adds composite foreign keys to the new empty assignment tables. Existing tables that redundantly store guild/server IDs require a separately rehearsed cleanup migration: add constraints as `NOT VALID`, validate after cleanup, then enforce non-null/check constraints if production volume requires it.
6. Preserve legacy roles for evidence, but do not treat guild-wide `moderator` as server authorization. Administrators must assign moderators to exact servers.
7. Roll out read authorization first, then writes, bot commands, jobs, and finally remove compatibility paths.

## Audit events

Record successful and denied sensitive operations with actor, canonical guild/server, action, result, target type/id, request correlation ID, and non-secret metadata. Never log tokens, cookies, session IDs, provider responses containing credentials, player platform identifiers, or connection strings.

## Known legacy risks being removed

- guild-wide moderator access instead of exact-server assignments;
- player access inferred from identity ownership or historical server activity;
- implicit first/default server selection in bot commands and some pages;
- routes that prove access to any guild before operating on a caller-selected server;
- independently stored guild/server IDs without composite integrity;
- static privileged HTML reachable before page authorization;
- unscoped or ambiguous internal-vs-provider server identifiers;
- two incompatible audit tables without canonical tenant scope.

## Implementation and rollout status

Migration 050 and the accompanying authorization service establish the canonical model, but they do not make every legacy route secure by themselves. The current rollout includes:

- exact-server capability middleware and canonical trusted request context;
- active server-scoped administrator/moderator assignments with audited create/revoke operations;
- active server-player membership creation after the existing emote ownership challenge;
- actor-filtered guild/server discovery and Nitrado server lists;
- explicit bot server selection when a guild has multiple active servers;
- server-derived registration names and provider-service ownership validation;
- assets-only static delivery so privileged HTML cannot bypass route guards;
- fail-closed dashboard authorization errors;
- a server-derived setup checklist that never accepts guild/server IDs as authorization evidence;
- exact-server account discovery/link lifecycle, leaderboard association provenance, and faction-map position scoping with active approved tenant checks;
- shop and AI operator actions authorized through canonical active exact-server `server.manage`, including atomic AI suggestion claim/completion rechecks;
- exact-server economy balances, ledgers, supply accounting, and management APIs;
- economy management authorization through the centralized `server.manage` capability, allowing guild owner/admin and active exact-server administrator policy while denying moderators, revoked assignments, and unrelated tenants; and
- a deterministic focused security/migration regression suite included once in both `npm test` and the release-readiness test gate.

Before production migration, run a read-only ownership inventory and reconcile any ambiguous legacy role, player-link, and redundant guild/server rows. Migration 050 intentionally does not infer server moderator assignments or player memberships from historical activity. Existing operators must create exact assignments, and existing players must complete the verified linking flow to receive a server membership.

Remaining legacy routes must continue to be audited against the route matrix. A broad `ensureApproved` or `ensurePlayerApproved` mount is only an authentication/eligibility precondition; it is not sufficient authorization for a handler that consumes a caller-selected guild, server, player, channel, or provider identifier.

### Known release blockers

- The exact-server economy implementation and fail-closed migration 052 are present, but production migration remains blocked on a verified backup, read-only ownership/balance inventory, reconciliation of every ambiguous legacy monetary row, and a real PostgreSQL rehearsal. Existing balances must never be copied into multiple tenants by assumption; migration 052 must continue to abort before DDL when unsafe legacy monetary data exists.
- Discord command approval currently proves the invoking Discord guild is approved, but several command classes still need actor-to-server capability enforcement. Explicit server selection prevents wrong-server fallback, but selection alone is not authorization.
- Migrations 050-054 require real PostgreSQL rehearsals plus read-only production inventories before deployment. Source-level migration checks are not a substitute for executing the DDL and route transactions.
- `guild_setup_state` is reserved but not yet used as a durable transition log; current onboarding checks are computed from authoritative records.
