# Changelog

All notable public changes to S.A.L.T. will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project intends to use semantic versioning once stable releases are tagged.

## [2026-10-17] — Nasadara + Toolkit Update

### Added

- DayZ 1.30 Nasadara map support — map registry, coordinates, and tile grid (tiles remain operator-supplied, see the Map tiles section)
- DayZ Toolkit — client-side tools that run fully in the browser: XML/JSON/mission validators, duplicate classname checker, event conflict check
- PAA ↔ PNG map-tile converter in the toolkit (client-side WASM; files never leave the browser)
- Landing page fleet statistics and GitHub repository metrics
- Shop admin Restarts tab — owner-restart recording and restart history

### Fixed

- Guild removal — hiding a guild and having the bot leave it now completes and is visible in the admin UI
- Nasadara map tile seams — the tile grid was re-sliced with bleed so tile boundaries no longer show as a visible lattice
- Map destination preview and physical tile-size fallback now resolve through the canonical map registry

## [2026-10-13] — October Update

### Added

- AI log intelligence — reads RPT/ADM/server logs and explains what went wrong
- Config intelligence — multi-file balance passes with validation
- Data-driven tuning — loot, weapons, and economy tuning from real server data
- Natural-language admin — bounded answers, confirm prompts before actions
- Event & content generation — events, spawn points, seasons from a description
- Ask-the-server player AI — community answers, digests, and player onboarding
- Ops intelligence — predictive warnings, remediation suggestions, rollback advice
- 4 camo themes + high-contrast mode + holiday packs, with a live theme picker
- Route-aware app shell — role-aware sidebar, topbar, and mobile drawer
- Attention-first dashboard with an ops alerts panel
- Map page with docked controls, shareable map state, and a mobile sheet
- Mobile-first player portal
- Splash/landing page with Discord, GitHub, Admin, and Player links
- Discord notifications for ops alerts — per-guild opt-in, deduped, bot identity

### Changed

- Dashboard and player portal rebuilt on the new shell
- Full accessibility and mobile sweep across every page

### Fixed

- Registration and account-linking flow clarified and reworked
- Three UI defects from the community audit, including a panel lockout
- Log-sync server.log fetch — direct download, no retry loops

### Security

- Security fixes, CI lint cleanup, and static-analysis triage included in the release

## [2026-09-13] — Initial curated public source release candidate

### Added

- Initial curated public source release candidate.
- Public contribution and security-reporting guidance.

### Security

- Private map tiles, operational reports, deployment automation, local paths, and real provider identifiers are excluded or sanitized from the public source candidate.
