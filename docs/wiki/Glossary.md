# Glossary

**Status: CONFIRMED**

**Verified against TESTING revision:** `6db37fa97e471ddb39e207e160ad28de33618e26`

- **TESTING** — private `dayz-dashboard` workshop. May contain experiments, private assets, unfinished work, and operational context.
- **STABLE** — public `SALT` product containing intentionally released and sanitized code.
- **Knowledge hub** — curated Wiki content that preserves durable, status-labeled project knowledge.
- **Guild** — a Discord community/tenant represented internally by a `guilds` row.
- **Platform administrator** — global dashboard maintenance authority; distinct from guild/server roles.
- **Guild owner/admin** — operator role scoped to one approved guild.
- **Server administrator/moderator** — role assignment scoped to one exact server and guild.
- **Internal server ID** — PostgreSQL primary key used for application relationships and authorization.
- **Platform server ID** — provider service identifier (for example, a Nitrado service ID); metadata, not proof of authorization.
- **Player** — a person represented by a `players` row.
- **Identity** — a platform account represented by `player_identities`; one player may have multiple identities.
- **Linked account** — evidence connecting a dashboard user to a player identity.
- **Server player membership** — active association authorizing a linked identity within one exact guild/server.
- **Capability** — allow-listed server-side permission such as `server.view`, `server.manage`, or `player.financial`.
- **Canonical context** — trusted actor/guild/server/player structure returned after authorization.
- **Provider mutation** — a state-changing operation against Nitrado, GitHub, Discord, or another external system.
- **Runtime evidence** — downloaded logs/files or provider observations used to derive application state; not source code.
- **ADM log** — DayZ administrative log used for player, kill, position, and related evidence.
- **RPT log** — DayZ server runtime log used for restart and diagnostic evidence.
- **CE** — DayZ Central Economy configuration and runtime system.
- **Mission files** — DayZ configuration files such as `types.xml`, `cfgeconomycore.xml`, and related JSON/XML assets.
- **Exact money** — canonical decimal/integer representation that avoids binary floating-point authority.
- **Idempotency** — safely recognizing a repeated operation so it does not duplicate an effect.
- **Finality watermark** — timestamp/evidence boundary indicating which source observations are safe to publish as processed state.
- **Descriptor-anchored access** — filesystem traversal/read/write through validated open descriptors to resist traversal and symlink races.
- **Release candidate identity** — immutable staged-diff hash, Git tree ID, or full commit SHA reviewed and approved for promotion.
- **Wiki drift** — a contradiction between Wiki documentation and current source/behavior.
- **Private information firewall** — the mandatory verification and sanitization boundary between TESTING and anything public.
