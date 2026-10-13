# Link Accounts Page - Complete Implementation Analysis

## 🔴 CRITICAL BUG: "Keeps Loading" Issue

**Location:** `/routes/playerPortal.js`, lines 116-140  
**Endpoint:** `GET /api/player/discover/:guild_id`  
**Root Cause:** Missing `FROM` clause in SQL query

### The Bug
```sql
❌ BROKEN (Line 129 starts with JOIN, but no FROM table):
SELECT 
  pi.id, pi.platform, pi.platform_user_id, pi.player_id, pg.gamertag,
  STRING_AGG(DISTINCT s.id::text, ',') as server_ids,
  STRING_AGG(DISTINCT s.name, ',') as server_names,
  MAX(psa.last_seen) as last_seen,
  la.user_id as linked_user_id,
  u.username as linked_username,
  p.primary_identity_id
JOIN player_gamertags pg ON ...  ← ERROR: No FROM clause!
```

### The Fix
Add `FROM player_identities pi` before the first JOIN

---

## 📁 File Structure

| File | Lines | Purpose |
|------|-------|---------|
| `/public/player-portal.html` | 1,500 | Discovery UI + confirmation modal |
| `/public/js/player-portal.js` | 3,288 | Frontend logic (loadDiscovery, confirmLink, etc.) |
| `/routes/accountLinking.js` | 348 | POST /api/accounts/link, POST /api/accounts/unlink |
| `/routes/playerPortal.js` | ~2000 | GET /api/player/discover, GET /api/player/search, etc. |
| `/db/schema-v2.js` | ~900 | Database schema (players, player_identities, linked_accounts) |

---

## 🔑 Key Database Tables

### `linked_accounts` ⭐ Main linking table
```sql
CREATE TABLE linked_accounts (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  user_id INTEGER NOT NULL,              -- Discord user ID
  identity_id INTEGER NOT NULL,          -- Game account ID
  verified_by_guild_id INTEGER,
  verification_method TEXT,              -- 'manual', 'discord', 'auto'
  linked_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, identity_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE CASCADE
);
```

### `player_identities` Platform accounts
```sql
CREATE TABLE player_identities (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  player_id INTEGER NOT NULL,        -- Groups alts together
  platform TEXT NOT NULL,            -- 'steam', 'xbox', 'ps'
  platform_user_id TEXT NOT NULL,    -- Account ID on platform
  platform_username TEXT,
  device_id TEXT,                    -- Could track device/HWID
  first_seen TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  UNIQUE(platform, platform_user_id),
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);
```

### `players` Groups alt accounts
```sql
CREATE TABLE players (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  primary_identity_id INTEGER,  -- Reference account for alt detection
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (primary_identity_id) REFERENCES player_identities(id)
);
```

### `player_gamertags` Tracks name changes
```sql
CREATE TABLE player_gamertags (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  identity_id INTEGER NOT NULL,
  server_id INTEGER NOT NULL,
  gamertag TEXT NOT NULL,
  is_current_gamertag INTEGER DEFAULT 1,  -- Tracks name changes
  first_seen TIMESTAMPTZ,
  last_seen TIMESTAMPTZ
);
```

---

## 🔗 API Endpoints

### POST /api/accounts/link
**Main linking endpoint** (accountLinking.js:125)

**Request:**
```json
{
  "gameAccountId": 12345,
  "guildId": "123456789"
}
```

**Process:**
1. Verify user is Discord guild member
2. Verify game account on guild's servers
3. Check not already linked (or to same user)
4. Get `primary_identity_id` for the account
5. Find ALL identities with same `primary_identity_id` (alts)
6. Link ALL in transaction
7. Return `{ success: true, linkedCount: N }`

**Key Code:**
```javascript
// Find all alts by primary_identity_id
const allAccounts = await db.query(`
  SELECT DISTINCT pi.id, pg.gamertag
  FROM player_identities pi
  JOIN player_gamertags pg ON pi.id = pg.identity_id AND pg.is_current_gamertag = 1
  JOIN players p ON pi.player_id = p.id
  WHERE p.primary_identity_id = ?
`, [account.primary_identity_id]);

// Link all in transaction
await db.beginTransaction();
for (const acc of allAccounts) {
  await db.run(`
    INSERT INTO linked_accounts (user_id, identity_id, verified_by_guild_id, verification_method)
    VALUES (?, ?, ?, 'manual')
  `, [req.user.id, acc.id, guildId]);
}
await db.commit();
```

### GET /api/player/discover/:guild_id 🔴 BUG
**Discovers linkable accounts for a guild** (playerPortal.js:88)

**Response:**
```json
{
  "success": true,
  "accounts": [
    {
      "id": 12345,
      "gamertag": "PlayerName",
      "platform": "steam",
      "platformUserId": "76561198...",
      "lastSeen": "2024-03-13T10:30:00Z",
      "serverId": "1",
      "serverName": "PvP Server 1",
      "deviceId": 100,              // primary_identity_id
      "isAlreadyLinked": false,
      "linkedToOther": false,
      "possibleAlts": [12346, 12347] // Alt account IDs
    }
  ]
}
```

### GET /api/player/guilds
**Gets guilds where user has linked accounts** (playerPortal.js:13)

**Response:**
```json
{
  "success": true,
  "guilds": [
    {
      "id": 1,
      "guild_id": "123456789",
      "guild_name": "My Community",
      "icon_url": "https://...",
      "server_count": 3,
      "player_count": 150
    }
  ]
}
```

---

## 🔄 Current User Flow

```
1. User loads player-portal.html
   ↓
2. loadGuilds() → GET /api/player/guilds
   ↓
3. User clicks guild card
   ↓
4. selectGuild(guildId) 
   ├─ Store currentGuildId
   ├─ resolveLinkedIdentity() [background]
   └─ showSection('discovery')
      └─ loadDiscovery()
         └─ GET /api/player/discover/{guildId}
            ❌ HANGS DUE TO SQL ERROR
            
         (If fixed:)
         └─ displayDiscoveredAccounts() renders cards
            └─ User sees account list with Link buttons

5. User clicks "Link This Account"
   ↓
6. showLinkModal(accountId, gamertag, platform)
   ↓
7. User confirms in modal
   ↓
8. confirmLink() → POST /api/accounts/link
   ├─ Backend validates & links ALL alts
   └─ Frontend shows "Account linked successfully!"
      └─ Refreshes discovery list
         └─ Account now shows "LINKED" badge
```

---

## 🎯 Alt Detection Mechanism

### How It Works
1. **Backend Query** fetches `primary_identity_id` for all accounts
2. **Frontend Grouping** groups by `primary_identity_id`:
   ```javascript
   deviceMap[primary_identity_id] = [id1, id2, id3, ...]
   ```
3. **Assign to Each Account**:
   ```javascript
   possibleAlts = [other IDs with same primary_identity_id]
   ```
4. **Display in UI** with "ALT" badge

### Example
```
primary_identity_id = 100 (the main account)
├─ Identity 1 (Steam) → ALT badge, possibleAlts: [2, 3]
├─ Identity 2 (Xbox)  → ALT badge, possibleAlts: [1, 3]
└─ Identity 3 (PS)    → ALT badge, possibleAlts: [1, 2]

When user links any one → ALL THREE are linked to same Discord user
```

---

## 💾 How Already-Linked Accounts Are Stored/Retrieved

### Storage
```javascript
INSERT INTO linked_accounts (user_id, identity_id, verified_by_guild_id, verification_method)
VALUES (req.user.id, gameAccountId, guildId, 'manual')
```

### Retrieval Methods

**Method 1: Get user's linked accounts**
```javascript
fetch('/api/accounts/my-accounts')
// Returns: [{ id, gamertag, platform, linked_at }, ...]
```

**Method 2: Check if already linked (in discovery)**
```javascript
LEFT JOIN linked_accounts la ON pi.id = la.identity_id
// Then check: isAlreadyLinked = (account.linked_user_id === userId)
```

**Method 3: Cache first identity** (for Economy/Casino tabs)
```javascript
currentIdentityId = data.accounts[0].identity_id  // Cache in resolveLinkedIdentity()
```

---

## 🎬 Frontend Key Functions

### loadDiscovery() [player-portal.js:186]
```javascript
function loadDiscovery() {
  if (!currentGuildId) return;
  
  fetch(`/api/player/discover/${currentGuildId}`)
    .then(res => res.json())
    .then(data => {
      if (data.success) {
        displayDiscoveredAccounts(data.accounts);
      }
    })
    .catch(err => {
      console.error('Error loading accounts:', err);
      // Show error message
    });
}
```

### confirmLink() [player-portal.js:289]
```javascript
function confirmLink() {
  if (!selectedAccount || !currentGuildId) return;
  
  fetchWithCsrf('/api/accounts/link', {
    method: 'POST',
    body: JSON.stringify({
      gameAccountId: selectedAccount,
      guildId: currentGuildId
    })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success) {
      closeLinkModal();
      currentIdentityId = null;
      resolveLinkedIdentity();  // Re-fetch cache
      loadDiscovery();          // Refresh list
      alert('Account linked successfully!');
    } else {
      alert('Failed to link account: ' + data.error);
    }
  });
}
```

### resolveLinkedIdentity() [player-portal.js:94]
```javascript
function resolveLinkedIdentity() {
  if (currentIdentityId) return Promise.resolve(currentIdentityId);

  return fetch('/api/accounts/linked')
    .then(res => res.json())
    .then(data => {
      if (data.success && data.accounts && data.accounts.length > 0) {
        currentIdentityId = data.accounts[0].identity_id;  // Cache first
      }
      return currentIdentityId;
    });
}
```

---

## 📊 Current Features

✅ Link Discord user to game account  
✅ Automatic alt detection via `primary_identity_id`  
✅ Automatic alt linking (one click = links all alts)  
✅ Already-linked account display (status badges)  
✅ Manual gamertag search  
✅ Multi-guild support  
✅ Guild membership verification  
✅ Account unlinking (deletes all alts)  

## 🐛 Current Issues

🔴 **SQL Syntax Error** - Missing FROM clause in `/api/player/discover`  
- Causes page to hang indefinitely when loading discovery
- Fix: Add `FROM player_identities pi` before JOIN

---

## 🔍 Summary for Redesign

### What You're Working With
- **Database:** `linked_accounts` links Discord users to game identities
- **Alt Detection:** Via `primary_identity_id` in `players` table
- **Linking:** All-or-nothing (one account = all alts linked together)
- **Constraint:** One Discord user per identity, but multiple identities per player

### Key Tables
- `players`: Groups alts (via `primary_identity_id`)
- `player_identities`: One per platform account
- `linked_accounts`: Discord user ↔ game account mapping
- `player_gamertags`: Tracks gamertag per server

### Main Endpoints
- `GET /api/player/guilds`: List user's guilds
- `GET /api/player/discover/:guild_id`: Discover linkable accounts 🔴 BUG HERE
- `POST /api/accounts/link`: Link account (includes all alts)
- `POST /api/accounts/unlink`: Unlink account (includes all alts)

