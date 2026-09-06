# Database Schema Documentation (V2)

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Tables Reference](#tables-reference)
4. [Entity Relationships](#entity-relationships)
5. [Key Differences from V1](#key-differences-from-v1)
6. [Best Practices](#best-practices)
7. [Common Queries](#common-queries)

---

## Overview

The DayZ Dashboard uses a **multi-tenant, platform-agnostic database architecture** (Schema V2) designed to support:

- **Multiple Discord communities** (guilds) in one database
- **Multi-platform gaming** (Xbox, PlayStation, Steam, Epic)
- **Player identity management** across platforms and name changes
- **Per-server statistics** and activity tracking
- **Role-based access control** for guild members
- **Feature flags** for granular control at guild and server levels

### Database Support

- **PostgreSQL** (required)

The schema targets PostgreSQL exclusively and uses PostgreSQL-native types (`TIMESTAMPTZ`, `GENERATED ALWAYS AS IDENTITY`, proper `BOOLEAN` defaults).

### Fresh Database Setup (Smoke Check)

To start the application against a clean PostgreSQL database:

```bash
docker compose down -v && docker compose up --build
```

The `-v` flag removes the named `postgres-data` volume, giving you a completely fresh database.  On startup the application will log:

```
✨ Fresh installation detected - creating Schema V2...
  ✓ users
  ✓ guilds
  ...
  ✓ guild_economy_config
  ...
✅ Schema V2 created successfully!
```

> **Tip:** If schema creation fails mid-way (e.g. after a failed attempt left a partial schema), run the command above to reset the database.

### Schema Version

- **Current Version:** 2
- **Previous Version:** 1 (deprecated)
- **Migration:** Fresh Schema V2 creation and incremental PostgreSQL migrations

---

## Architecture

### Multi-Tenant Design

The schema supports multiple Discord communities (guilds) in a single database, with proper isolation and access control:

```
guilds (Discord communities)
  ├── guild_tokens (API credentials)
  ├── guild_roles (RBAC)
  ├── guild_features (feature flags)
  └── servers (DayZ game servers)
      ├── server_features (server-specific features)
      └── player activity, stats, events
```

### Player Identity System

Players are tracked through a sophisticated identity management system that handles:

- **Multiple platforms** (Xbox, PS, Steam) for the same person
- **Gamertag changes** over time per server
- **Cross-platform linking** to Discord accounts

```
players (real humans)
  └── player_identities (platform accounts)
      └── player_gamertags (names per server, with history)
```

### Database Layer Separation

1. **Platform Layer** - Guilds and authentication
2. **Server Layer** - Game servers and configuration
3. **Identity Layer** - Player tracking across platforms
4. **Activity Layer** - Sessions, stats, and events
5. **Integration Layer** - Discord OAuth and account linking
6. **System Layer** - Sessions, jobs, and audit logs

---

## Tables Reference

### 1. Platform & Multi-Tenant

#### `guilds`

Discord communities using the dashboard.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `discordGuildId` | TEXT | Discord server ID (unique) |
| `name` | TEXT | Discord server name |
| `iconUrl` | TEXT | Discord server icon URL |
| `status` | TEXT | `pending`, `active`, or `disabled` |
| `createdAt` | TIMESTAMP | When the guild was added |
| `approvedAt` | TIMESTAMP | When the guild was approved |
| `approvedBy` | INTEGER | User ID who approved (FK to `users.id`) |
| `disabledAt` | TIMESTAMP | When the guild was disabled |
| `disabledBy` | INTEGER | User ID who disabled (FK to `users.id`) |
| `disabledReason` | TEXT | Reason for disabling |

**Indexes:**
- `idx_guilds_discord` on `discordGuildId`
- `idx_guilds_status` on `status`

#### `guild_tokens`

API tokens for external services (e.g., Nitrado API).

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `guildId` | INTEGER | **Foreign key** to `guilds.id` (CASCADE) |
| `tokenHash` | TEXT | Hashed API token |
| `tokenType` | TEXT | Token type (e.g., `nitrado`) |
| `createdAt` | TIMESTAMP | When the token was added |
| `lastUsed` | TIMESTAMP | Last time the token was used |

#### `guild_roles`

Role-based access control for guild members.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `guildId` | INTEGER | **Foreign key** to `guilds.id` (CASCADE) |
| `userId` | INTEGER | **Foreign key** to `users.id` (CASCADE) |
| `role` | TEXT | Role name (e.g., `admin`, `moderator`, `viewer`) |
| `assignedAt` | TIMESTAMP | When the role was assigned |
| `assignedBy` | INTEGER | User ID who assigned (FK to `users.id`) |

**Unique constraint:** `(guildId, userId)` - One role per user per guild

#### `guild_features`

Feature toggles per guild for gradual rollout and A/B testing.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `guildId` | INTEGER | **Foreign key** to `guilds.id` (CASCADE) |
| `featureName` | TEXT | Feature identifier |
| `enabled` | INTEGER | 1 = enabled, 0 = disabled |
| `config` | TEXT | JSON configuration for the feature |
| `updatedAt` | TIMESTAMP | Last update time |

**Unique constraint:** `(guildId, featureName)`

---

### 2. Server Layer

#### `servers`

DayZ game servers.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `guildId` | INTEGER | **Foreign key** to `guilds.id` (CASCADE) |
| `name` | TEXT | Server display name |
| `platform` | TEXT | Platform type (`nitrado`, `gportal`, etc.) |
| `platformServerId` | TEXT | External platform's server ID |
| `ip` | TEXT | Server IP address |
| `port` | INTEGER | Server port |
| `region` | TEXT | Server region |
| `status` | TEXT | `active` or `inactive` |
| `lastSyncAt` | TIMESTAMP | Last data sync timestamp |
| `createdAt` | TIMESTAMP | When the server was added |

**Unique constraint:** `(platformServerId, platform)`

**Indexes:**
- `idx_servers_guild` on `guildId`
- `idx_servers_platform` on `(platform, platformServerId)`

**Important:** The `id` field is the database ID used in all foreign key relationships. The `platformServerId` is the external platform's ID (e.g., Nitrado server ID).

#### `server_features`

Feature toggles per server (more granular than guild-level).

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `serverId` | INTEGER | **Foreign key** to `servers.id` (CASCADE) |
| `featureName` | TEXT | Feature identifier |
| `enabled` | INTEGER | 1 = enabled, 0 = disabled |
| `config` | TEXT | JSON configuration for the feature |
| `updatedAt` | TIMESTAMP | Last update time |

**Unique constraint:** `(serverId, featureName)`

---

### 3. Player Identity Layer

#### `players`

Real human players (one record per person, regardless of platforms).

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `primaryIdentityId` | INTEGER | **Foreign key** to `player_identities.id` |
| `createdAt` | TIMESTAMP | When the player record was created |
| `updatedAt` | TIMESTAMP | Last update time |

#### `player_identities`

Platform-specific accounts (Xbox, PlayStation, Steam).

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `playerId` | INTEGER | **Foreign key** to `players.id` (CASCADE) |
| `platform` | TEXT | Platform name (`xbox`, `playstation`, `steam`, `epic`) |
| `platformUserId` | TEXT | Platform's unique user ID |
| `platformUsername` | TEXT | Current platform username |
| `deviceId` | TEXT | Device identifier (if available) |
| `firstSeen` | TIMESTAMP | First time this identity was seen |
| `lastSeen` | TIMESTAMP | Last time this identity was seen |

**Unique constraint:** `(platform, platformUserId)`

**Indexes:**
- `idx_player_identities_player` on `playerId`
- `idx_player_identities_platform` on `(platform, platformUserId)`

#### `player_gamertags`

Gamertag history per server (tracks name changes).

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `identityId` | INTEGER | **Foreign key** to `player_identities.id` (CASCADE) |
| `serverId` | INTEGER | **Foreign key** to `servers.id` (CASCADE) |
| `gamertag` | TEXT | The gamertag/username |
| `isCurrentGamertag` | INTEGER | 1 if current, 0 if historical |
| `firstSeen` | TIMESTAMP | First time this gamertag was used |
| `lastSeen` | TIMESTAMP | Last time this gamertag was seen |

**Indexes:**
- `idx_gamertags_search` on `gamertag` (case-insensitive)
- `idx_gamertags_current` on `(serverId, isCurrentGamertag)`

---

### 4. Activity & Stats

#### `player_server_activity`

Player presence per server (when they were first/last seen).

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `identityId` | INTEGER | **Foreign key** to `player_identities.id` (CASCADE) |
| `serverId` | INTEGER | **Foreign key** to `servers.id` (CASCADE) |
| `firstSeen` | TIMESTAMP | First time seen on this server |
| `lastSeen` | TIMESTAMP | Last time seen on this server |
| `totalSessions` | INTEGER | Total number of play sessions |

**Unique constraint:** `(identityId, serverId)`

**Indexes:**
- `idx_player_server_activity_identity` on `identityId`
- `idx_player_server_activity_server` on `serverId`

**Critical:** In V2, `serverId` correctly references `servers.id` (database ID), not the external platform ID. This was a critical bug fix from V1.

#### `player_sessions`

Individual login/logout sessions.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `identityId` | INTEGER | **Foreign key** to `player_identities.id` (CASCADE) |
| `serverId` | INTEGER | **Foreign key** to `servers.id` (CASCADE) |
| `loginAt` | TIMESTAMP | Session start time |
| `logoutAt` | TIMESTAMP | Session end time (NULL if still active) |
| `duration` | INTEGER | Session duration in seconds |
| `ipAddress` | TEXT | Player's IP address |
| `logSource` | TEXT | Source of the log data |

**Indexes:**
- `idx_player_sessions_identity` on `identityId`
- `idx_player_sessions_server` on `serverId`

#### `player_stats`

Aggregated statistics per server.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `identityId` | INTEGER | **Foreign key** to `player_identities.id` (CASCADE) |
| `serverId` | INTEGER | **Foreign key** to `servers.id` (CASCADE) |
| `kills` | INTEGER | Total kills |
| `deaths` | INTEGER | Total deaths |
| `suicides` | INTEGER | Total suicides |
| `longestKillDistance` | REAL | Longest kill distance in meters |
| `totalPlaytimeSeconds` | INTEGER | Total playtime in seconds |
| `longestSurvivalSeconds` | INTEGER | Longest survival streak |
| `currentSurvivalSeconds` | INTEGER | Current survival time |
| `updatedAt` | TIMESTAMP | Last stats update |

**Unique constraint:** `(identityId, serverId)`

**Indexes:**
- `idx_player_stats_identity` on `identityId`
- `idx_player_stats_server` on `serverId`

#### `kill_events`

Individual kill event log.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `serverId` | INTEGER | **Foreign key** to `servers.id` (CASCADE) |
| `killerIdentityId` | INTEGER | **Foreign key** to `player_identities.id` (NULL for suicides) |
| `killerGamertag` | TEXT | Killer's gamertag at the time |
| `killerPosition` | TEXT | Killer's position (coordinates) |
| `victimIdentityId` | INTEGER | **Foreign key** to `player_identities.id` |
| `victimGamertag` | TEXT | Victim's gamertag at the time |
| `victimPosition` | TEXT | Victim's position (coordinates) |
| `weapon` | TEXT | Weapon used |
| `distance` | REAL | Kill distance in meters |
| `timestamp` | TIMESTAMP | When the kill occurred |
| `logSource` | TEXT | Source of the log data |

**Indexes:**
- `idx_kill_events_server` on `serverId`
- `idx_kill_events_killer` on `killerIdentityId`
- `idx_kill_events_victim` on `victimIdentityId`
- `idx_kill_events_timestamp` on `timestamp`

---

### 5. Discord Integration

#### `users`

Discord users who have logged in via OAuth.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `discordId` | TEXT | Discord user ID (unique) |
| `username` | TEXT | Discord username |
| `discriminator` | TEXT | Discord discriminator (legacy) |
| `avatar` | TEXT | Discord avatar hash |
| `email` | TEXT | Discord email (if shared) |
| `isAdmin` | INTEGER | 1 if global admin, 0 otherwise |
| `isBanned` | INTEGER | 1 if banned, 0 otherwise |
| `accessToken` | TEXT | OAuth access token |
| `refreshToken` | TEXT | OAuth refresh token |
| `tokenExpiresAt` | TIMESTAMP | Token expiration time |
| `createdAt` | TIMESTAMP | Account creation time |
| `lastLoginAt` | TIMESTAMP | Last login time |

**Index:** `idx_users_discord` on `discordId`

#### `linked_accounts`

Links Discord users to their in-game identities.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `userId` | INTEGER | **Foreign key** to `users.id` (CASCADE) |
| `identityId` | INTEGER | **Foreign key** to `player_identities.id` (CASCADE) |
| `verifiedByGuildId` | INTEGER | **Foreign key** to `guilds.id` (verification scope) |
| `verificationMethod` | TEXT | How the link was verified |
| `linkedAt` | TIMESTAMP | When the link was created |

**Unique constraint:** `(userId, identityId)`

**Indexes:**
- `idx_linked_accounts_user` on `userId`
- `idx_linked_accounts_identity` on `identityId`

---

### 6. System Tables

#### `sessions`

Web session storage (Express sessions).

| Column | Type | Description |
|--------|------|-------------|
| `sid` | TEXT | **Primary key** - Session ID |
| `sess` | TEXT | Session data (JSON) |
| `expire` | BIGINT | Expiration timestamp |

**Index:** `idx_sessions_expire` on `expire`

#### `automation_settings`

Stores user automation preferences for background tasks.

| Column | Type | Description |
|--------|------|-------------|
| `userId` | INTEGER | **Primary key** - User ID (FK → `users.id`) |
| `autoLogSync` | TEXT | JSON config for auto log download |
| `autoTracking` | TEXT | JSON config for auto player tracking |
| `createdAt` | TIMESTAMP | Settings creation timestamp |
| `updatedAt` | TIMESTAMP | Last modification timestamp |

**Relationships:**
- `userId` → `users.id` (ON DELETE CASCADE)

**Index:** `idx_automation_userid` on `userId`

**Example autoLogSync JSON:**
```json
{
  "enabled": true,
  "interval": 15,
  "autoScan": true,
  "servers": ["5551234", "5555678"],
  "lastRun": "2026-02-19T10:30:00.000Z"
}
```

**Example autoTracking JSON:**
```json
{
  "enabled": false,
  "interval": 60,
  "lastRun": null
}
```

#### `sync_jobs`

Tracks background file sync operations from Nitrado servers. Used by the "🔄 Sync All Server Files" feature.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `userId` | INTEGER | **Foreign key** to `users.id` (CASCADE) |
| `serverId` | INTEGER | **Nitrado platform server ID** (NOT a database ID!) |
| `remotePath` | TEXT | JSON array of remote paths to sync |
| `status` | TEXT | `running`, `completed`, or `failed` |
| `filesDownloaded` | INTEGER | Number of files downloaded |
| `totalSize` | INTEGER | Total bytes downloaded |
| `errors` | TEXT | Error messages if any |
| `startedAt` | TIMESTAMP | When the sync job started |
| `completedAt` | TIMESTAMP | When the sync job completed |

**Relationships:**
- `userId` → `users.id` (ON DELETE CASCADE)
- ⚠️ **IMPORTANT:** `serverId` is **NOT a foreign key**. It stores the Nitrado platform server ID (e.g., `12345678`), not a database ID. This is intentional because sync operations target external platform servers using the Nitrado API.

**Indexes:**
- `idx_sync_jobs_user` on `userId`
- `idx_sync_jobs_status` on `status`
- `idx_sync_jobs_started` on `startedAt DESC`

**Key Design Note:**

Unlike player tracking tables (`player_server_activity`, `player_sessions`, `player_stats`, `kill_events`) which correctly use `serverId` as a foreign key to `servers.id` (database ID), the `sync_jobs` table stores the **Nitrado platform ID** directly. This is because:

1. Sync operations are external API calls to Nitrado servers
2. The platform ID is what the Nitrado API requires
3. Sync tracking is operational data, not relational data
4. Losing the foreign key constraint here is acceptable

#### `downloads`

Tracks individual file downloads from sync jobs. Allows users to see their download history.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `userId` | INTEGER | **Foreign key** to `users.id` (CASCADE) |
| `serverId` | INTEGER | **Nitrado platform server ID** (NOT a database ID!) |
| `syncJobId` | INTEGER | **Foreign key** to `sync_jobs.id` (SET NULL) |
| `filePath` | TEXT | Remote file path on Nitrado server |
| `localPath` | TEXT | Local file path where downloaded |
| `fileSize` | INTEGER | File size in bytes |
| `downloadedAt` | TIMESTAMP | When the file was downloaded |

**Relationships:**
- `userId` → `users.id` (ON DELETE CASCADE)
- `syncJobId` → `sync_jobs.id` (ON DELETE SET NULL)
- ⚠️ **IMPORTANT:** `serverId` is **NOT a foreign key**. It stores the Nitrado platform server ID (e.g., `12345678`), not a database ID. Same reasoning as `sync_jobs` table.

**Indexes:**
- `idx_downloads_user` on `userId`
- `idx_downloads_server` on `serverId`
- `idx_downloads_job` on `syncJobId`
- `idx_downloads_date` on `downloadedAt DESC`

#### `jobs`

Background job queue.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `type` | TEXT | Job type |
| `status` | TEXT | `pending`, `running`, `completed`, `failed` |
| `serverId` | INTEGER | **Foreign key** to `servers.id` (CASCADE) |
| `guildId` | INTEGER | **Foreign key** to `guilds.id` (CASCADE) |
| `payload` | TEXT | Job data (JSON) |
| `createdAt` | TIMESTAMP | Job creation time |
| `startedAt` | TIMESTAMP | Job start time |
| `completedAt` | TIMESTAMP | Job completion time |
| `result` | TEXT | Job result data |
| `error` | TEXT | Error message if failed |

#### `file_downloads`

Tracks downloaded log files to avoid re-processing.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `serverId` | INTEGER | **Foreign key** to `servers.id` (CASCADE) |
| `filename` | TEXT | File name |
| `fileType` | TEXT | File type (e.g., `ADM`, `KILL`) |
| `fileDate` | DATE | File date |
| `fileSize` | INTEGER | File size in bytes |
| `status` | TEXT | `pending`, `downloaded`, `parsed`, `failed` |
| `downloadedAt` | TIMESTAMP | Download timestamp |
| `parsedAt` | TIMESTAMP | Parse timestamp |
| `playersFound` | INTEGER | Number of players found |
| `eventsFound` | INTEGER | Number of events found |

**Unique constraint:** `(serverId, filename)`

#### `audit_log`

System audit trail.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | **Primary key** (auto-increment) |
| `userId` | INTEGER | **Foreign key** to `users.id` |
| `action` | TEXT | Action performed |
| `targetType` | TEXT | Type of target (e.g., `guild`, `server`) |
| `targetId` | INTEGER | ID of the target |
| `details` | TEXT | Additional details (JSON) |
| `timestamp` | TIMESTAMP | When the action occurred |

**Indexes:**
- `idx_audit_user` on `userId`
- `idx_audit_timestamp` on `timestamp`

---

## Entity Relationships

### Core Relationships

```
guilds
  ├── 1:N → guild_tokens
  ├── 1:N → guild_roles
  ├── 1:N → guild_features
  └── 1:N → servers
        ├── 1:N → server_features
        ├── 1:N → player_server_activity
        ├── 1:N → player_sessions
        ├── 1:N → player_stats
        └── 1:N → kill_events

players
  ├── 1:1 → player_identities (primary)
  └── 1:N → player_identities (all)
        ├── 1:N → player_gamertags
        ├── 1:N → player_server_activity
        ├── 1:N → player_sessions
        ├── 1:N → player_stats
        ├── 1:N → kill_events (as killer)
        ├── 1:N → kill_events (as victim)
        └── 1:N → linked_accounts

users
  ├── 1:N → linked_accounts
  ├── 1:N → guild_roles
  └── 1:N → audit_log
```

### Key Foreign Key Cascades

- **ON DELETE CASCADE**: When parent is deleted, children are deleted
  - `guilds` → `servers`, `guild_tokens`, `guild_roles`, `guild_features`
  - `servers` → `server_features`, `player_server_activity`, `player_sessions`, `player_stats`, `kill_events`, `file_downloads`, `jobs`
  - `players` → `player_identities`
  - `player_identities` → `player_gamertags`, `player_server_activity`, `player_sessions`, `player_stats`, `linked_accounts`
  - `users` → `linked_accounts`, `guild_roles`

---

## Key Differences from V1

### 🔧 Critical Bug Fix

**Problem in V1:**
```sql
-- V1 bug: serverId was actually a Nitrado ID, not database ID
player_server_activity.serverId = 5551234  -- ❌ Nitrado ID
```

**Fixed in V2:**
```sql
-- V2 fix: serverId is now the database ID
player_server_activity.serverId = 1  -- ✅ Database ID
servers.platformServerId = "5551234"  -- Nitrado ID stored here
```

This fix enables proper foreign key relationships and JOINs.

### Table Changes

| V1 Table | V2 Tables | Change |
|----------|-----------|--------|
| `discord_guilds` | `guilds` + `guild_tokens` + `guild_roles` + `guild_features` | Split and normalized |
| `servers` | `servers` | Restructured with proper ID relationships |
| `game_accounts` | `players` + `player_identities` + `player_gamertags` | Multi-identity system |
| `player_server_activity` | `player_server_activity` | Fixed serverId bug |
| `linked_accounts` | `linked_accounts` | Updated to use identityId |

### New Features in V2

1. **Multi-platform support** - Track players across Xbox, PlayStation, Steam, Epic
2. **Identity management** - One player can have multiple platform accounts
3. **Gamertag history** - Track name changes per server
4. **Role-based access control** - Fine-grained permissions per guild
5. **Feature flags** - Enable/disable features per guild or server
6. **Audit logging** - Track all administrative actions
7. **Job queue** - Background task management
8. **File tracking** - Avoid re-downloading processed files

### Schema Version Tracking

V2 introduces schema versioning:
- Version stored in database metadata
- Automated migration detection
- Backward compatibility checks

---

## Best Practices

### Querying

#### ✅ DO: Use Database IDs in Joins

```sql
-- Correct: Join using database IDs
SELECT
  psa.firstSeen,
  psa.lastSeen,
  s.name AS serverName,
  s.platformServerId
FROM player_server_activity psa
JOIN servers s ON s.id = psa.serverId;
```

#### ❌ DON'T: Use Platform IDs Directly

```sql
-- Incorrect: Don't join on platformServerId
SELECT ...
FROM player_server_activity psa
JOIN servers s ON s.platformServerId = psa.serverId;  -- ❌ Wrong!
```

### Player Identity

#### ✅ DO: Track by Identity, Not Gamertag

```sql
-- Correct: Use identityId
SELECT * FROM player_stats
WHERE identityId = ?;
```

#### ❌ DON'T: Search by Gamertag Alone

```sql
-- Incorrect: Gamertags can change
SELECT * FROM player_stats
WHERE gamertag = 'Player123';  -- ❌ Column doesn't exist!
```

To search by gamertag:

```sql
-- Correct way to find identity by gamertag
SELECT pi.*
FROM player_identities pi
JOIN player_gamertags pg ON pg.identityId = pi.id
WHERE pg.gamertag = 'Player123'
  AND pg.serverId = ?
  AND pg.isCurrentGamertag = 1;
```

### Multi-Tenant Isolation

Always filter by `guildId` when querying guild-specific data:

```sql
-- Correct: Filter by guild
SELECT s.* FROM servers s
JOIN guilds g ON g.id = s.guildId
WHERE g.discordGuildId = ?;
```

### Performance

1. **Use indexes** - All foreign keys and common search fields are indexed
2. **Limit results** - Use `LIMIT` for large tables
3. **Batch inserts** - Use transactions for bulk operations
4. **Avoid N+1 queries** - Use JOINs instead of separate queries

---

## Common Queries

### Get All Players for a Server

```sql
SELECT
  pi.platform,
  pi.platformUserId,
  pg.gamertag,
  psa.firstSeen,
  psa.lastSeen,
  ps.kills,
  ps.deaths
FROM player_server_activity psa
JOIN player_identities pi ON pi.id = psa.identityId
JOIN player_gamertags pg ON pg.identityId = pi.id AND pg.serverId = psa.serverId
LEFT JOIN player_stats ps ON ps.identityId = pi.id AND ps.serverId = psa.serverId
WHERE psa.serverId = ?
  AND pg.isCurrentGamertag = 1
ORDER BY psa.lastSeen DESC;
```

### Get Player's Gamertag History

```sql
SELECT
  pg.gamertag,
  pg.firstSeen,
  pg.lastSeen,
  pg.isCurrentGamertag,
  s.name AS serverName
FROM player_gamertags pg
JOIN servers s ON s.id = pg.serverId
WHERE pg.identityId = ?
ORDER BY pg.lastSeen DESC;
```

### Get Top Killers for a Server

```sql
SELECT
  pi.platformUserId,
  pg.gamertag,
  ps.kills,
  ps.deaths,
  ROUND(CAST(ps.kills AS REAL) / NULLIF(ps.deaths, 0), 2) AS kdr
FROM player_stats ps
JOIN player_identities pi ON pi.id = ps.identityId
JOIN player_gamertags pg ON pg.identityId = pi.id AND pg.serverId = ps.serverId
WHERE ps.serverId = ?
  AND pg.isCurrentGamertag = 1
ORDER BY ps.kills DESC
LIMIT 10;
```

### Get Recent Kill Events

```sql
SELECT
  ke.timestamp,
  ke.killerGamertag,
  ke.victimGamertag,
  ke.weapon,
  ke.distance,
  s.name AS serverName
FROM kill_events ke
JOIN servers s ON s.id = ke.serverId
WHERE ke.serverId = ?
ORDER BY ke.timestamp DESC
LIMIT 50;
```

### Get Active Sessions

```sql
SELECT
  ps.loginAt,
  pg.gamertag,
  pi.platform,
  s.name AS serverName
FROM player_sessions ps
JOIN player_identities pi ON pi.id = ps.identityId
JOIN player_gamertags pg ON pg.identityId = pi.id AND pg.serverId = ps.serverId
JOIN servers s ON s.id = ps.serverId
WHERE ps.logoutAt IS NULL
  AND ps.serverId = ?
  AND pg.isCurrentGamertag = 1;
```

### Find Discord User's Game Accounts

```sql
SELECT
  u.username AS discordUsername,
  pi.platform,
  pi.platformUserId,
  pg.gamertag,
  la.linkedAt
FROM linked_accounts la
JOIN users u ON u.id = la.userId
JOIN player_identities pi ON pi.id = la.identityId
LEFT JOIN player_gamertags pg ON pg.identityId = pi.id AND pg.isCurrentGamertag = 1
WHERE u.discordId = ?;
```

### Get Guild Statistics

```sql
SELECT
  g.name AS guildName,
  COUNT(DISTINCT s.id) AS totalServers,
  COUNT(DISTINCT psa.identityId) AS uniquePlayers,
  COUNT(DISTINCT ps.id) AS totalSessions
FROM guilds g
LEFT JOIN servers s ON s.guildId = g.id
LEFT JOIN player_server_activity psa ON psa.serverId = s.id
LEFT JOIN player_sessions ps ON ps.serverId = s.id
WHERE g.id = ?
GROUP BY g.id, g.name;
```

---

## Database Maintenance

### Regular Tasks

1. **Clean up old sessions**: Delete expired web sessions
   ```sql
   DELETE FROM sessions WHERE expire < ?;
   ```

2. **Archive old kill events**: Move events older than 90 days to archive table
3. **Update statistics**: Recompute aggregated stats periodically
4. **Vacuum database**: Reclaim storage and update planner statistics
   ```sql
   VACUUM ANALYZE;
   ```

### Backup Recommendations

- **PostgreSQL**: Use `pg_dump` for backups
- **Frequency**: Daily for production, weekly for development
- **Retention**: Keep at least 30 days of backups

### Monitoring

Monitor these metrics:
- Database size growth
- Query performance (slow queries)
- Foreign key constraint violations
- Failed jobs in `jobs` table
- Audit log for suspicious activity

---

## Schema Evolution

### Future Considerations

The schema is designed to be extensible:

1. **New platforms**: Add new platform types to `player_identities`
2. **New stats**: Add columns to `player_stats` or create new tables
3. **Custom features**: Use `guild_features` and `server_features` tables
4. **API integrations**: Add new token types to `guild_tokens`

### Migration Strategy

When schema changes are needed:
1. Create a new migration in `db/migrations/`
2. Update `schema-v2.js` with the new structure
3. Update the smoke-test expectations when adding tables
4. Test the migration against a disposable PostgreSQL database
5. Document changes in this file

---

## Support

For questions or issues:
- Check startup migration logs
- Run the schema smoke test: `npm run db:smoke-test`
- Open an issue on GitHub

**Database Version**: Schema V2
**Last Updated**: 2024
