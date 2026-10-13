# Parser Coverage Report

Generated: 2026-08-18T02:14:00Z

Summary
- Focus: map parsed fields → DB columns, show example values, data types, and 30-day null-rate where available.
- Source of parser code: routes/logParser.js, utils/killEventParser.js, utils/economyHelper.js, services/shopRestartService.js

Methodology
- Located parser functions by searching for ADM/RPT parsing and save* functions.
- Queried Postgres information_schema to get column types and ran per-column null-rate queries (30d) where a time column exists.

1) Kill events (event type: kill)
- Source: routes/logParser.js parseKillEvents (lines ~1490-1575) & saveKillEvents (lines ~1575-1700)
- Sample DB row (most recent): id=561804, killer_gamertag="Kayliw63", killer_identity_id=8990, killer_position="15085.4,13822.3,14.7", victim_gamertag="YBD FR33eLO1410", victim_identity_id=8992, weapon="(MeleeFist)", distance=NULL, timestamp=2026-08-17 21:02:58

Parsed fields -> DB mapping (kill_events)
- timestamp: example "2026-08-17 21:02:58", source routes/logParser.js:1496, DB: kill_events.timestamp (timestamp with time zone), null-rate(last30d): 0/211 (0%), priority: OK
- victimGamertag -> kill_events.victim_gamertag (text), null-rate: 0/211 (0%), priority: OK
- victimPlatformUserId -> resolved -> kill_events.victim_identity_id (integer), null-rate: 0/211 (0%), priority: OK
- victimPosition -> kill_events.victim_position (text), null-rate: 0/211 (0%), priority: OK
- killerGamertag -> kill_events.killer_gamertag (text), null-rate: 0/211 (0%), priority: OK
- killerPlatformUserId -> resolved -> kill_events.killer_identity_id (integer), null-rate: 0/211 (0%), priority: OK
- killerPosition -> kill_events.killer_position (text), null-rate: 0/211 (0%), priority: OK
- weapon -> kill_events.weapon (text), null-rate: 0/211 (0%), priority: OK
- distance -> kill_events.distance (real), example: NULL, null-rate: 128/211 (60.7%), priority: LOW COVERAGE (many kills lack distance)
- log_source -> kill_events.log_source (text), set to 'adm_log' in saveKillEvents, null-rate: 0/211, priority: OK

Notes: saveKillEvents INSERT columns confirmed in routes/logParser.js (see lines ~1575-1700).

2) Loot despawn (event type: cleanup/despawn)
- Source: routes/logParser.js parseCleanupEvents (lines ~2210-2240) and saveCleanupEvents (lines ~2300-2360)
- Parsed fields -> DB mapping (loot_despawn_events)
- itemClass -> loot_despawn_events.item_class (text). Example: "PorkCan". last30d totals: 0 rows (no recent processed cleanup rows), priority: MISSING
- posX -> loot_despawn_events.pos_x (real), last30d: 0 rows, priority: MISSING
- posZ -> loot_despawn_events.pos_z (real), last30d: 0 rows, priority: MISSING
- damage -> loot_despawn_events.damage (real), last30d: 0 rows, priority: MISSING
- logDate -> loot_despawn_events.log_date (date), last30d: 0 rows, priority: MISSING

3) Economy transactions (event type: economy)
- Source: utils/economyHelper.js (awardMoney, deductMoney, lootFromVictim) — INSERT INTO economy_transactions observed
- Parsed fields -> DB mapping (economy_transactions)
- identityId -> economy_transactions.identity_id (integer), example: 8990, null-rate(last30d): 0/316 (0%), priority: OK
- transaction_type -> economy_transactions.transaction_type (text), example: 'earn', null-rate: 0/316, priority: OK
- amount -> economy_transactions.amount (real), example: 100, null-rate: 0/316, priority: OK
- balance_after -> economy_transactions.balance_after (real), example: 10200, null-rate: 0/316, priority: OK
- account_type -> economy_transactions.account_type (text), example: 'wallet', null-rate: 0/316, priority: OK
- source -> economy_transactions.source (text), example: 'kill', null-rate: 0/316, priority: OK
- description -> economy_transactions.description (text), example: 'Kill reward (YBD FR33eLO1410)', null-rate: 0/316, priority: OK
- server_id -> economy_transactions.server_id (integer), example: 1, null-rate: 101/316 (32.0%), priority: LOW COVERAGE (server_id missing for many TX rows)
- metadata -> economy_transactions.metadata (text), used occasionally (JSON string), null-rate: not explicitly measured, priority: LOW COVERAGE
- timestamp -> economy_transactions.timestamp (timestamp with time zone), null-rate(all_rows): 0/481, priority: OK

4) Player / identity parsing
- Sources: routes/logParser.js parseADMLog (lines ~664-700) and parseRPTLog (lines ~700-770), savePlayersToDatabase
- Parsed fields -> DB mapping (player_identities / players / player_gamertags)
- playerName -> player_identities.platform_username OR player_gamertags.gamertag, example: "Kayliw63", null-rate(last30d): player_identities rows in last30d: 0 rows, priority: MISSING
- platformUserId -> player_identities.platform_user_id (text), example: "54875E7B8D56E1D3...", null-rate(last30d): 0 rows, priority: MISSING
- dpnid -> parsed but no dedicated column named dpnid in schema → MAPPING: MISSING (needs schema or column for dpnid)
- deviceId -> player_identities.device_id (text), example: 'vNJTCvQr226jqbpIxEn7...', null-rate(last30d): 0 rows, priority: MISSING
- first_seen / last_seen -> player_identities.first_seen/last_seen (timestamp), sample rows show empty last_seen in recent sample, priority: LOW COVERAGE

5) Server restart (server logs)
- Source: services/shopRestartService.js parseServerLog() and processRestartEvents()
- Parsed fields -> DB mapping (server_restart_log)
- biosSessionId -> server_restart_log.bios_session_id (text), example: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', last30d rows: 0, priority: MISSING
- detectedAt -> server_restart_log.detected_at (timestamp with time zone), priority: MISSING
- isScheduled -> restart_type -> server_restart_log.restart_type (text), priority: MISSING

6) Admin / mission
- Mission-related parsing and messages.xml handling live in services/missionFileService.js and bot/services/serverStatusService.js (fetchRestartFromXml). These compute restart deadlines but do not always persist new columns beyond server_restart_log. Priority: PARTIAL

Columns showing low/no coverage in the last 30 days (quick pass)
- kill_events.distance — 128/211 NULL (60.7%) → low coverage; enhance distance capture
- economy_transactions.server_id — 101/316 NULL (32.0%) → low coverage; ensure callers provide server_id
- loot_despawn_events.* — zero rows in last 30d → verify scheduler/log paths
- player_identities.* — zero rows in last 30d → verify identity-saving runs
- server_restart_log.* — zero rows in last 30d → verify restart detection

DB columns apparently parsed but without dedicated storage
- dpnid — parsed in parseRPTLog but no dpnid column in schema (MISSING). Consider adding a column to player_identities or player_identities.dpni reference.

Top 3 action items
1. Improve kill distance extraction (regex fallback / RPT cross-check) — high priority.
2. Populate economy_transactions.server_id consistently (audit callers such as lootFromVictim and awardMoney) — medium priority.
3. Verify log scanner/scheduler for RPT cleanup parsing (loot despawn events missing in last 30d) — medium priority.

Appendix: runnable re-check script included at tools/check_parser_coverage.sh

(End of report)
