# UI Surface and Capability Audit

This is the human-readable companion to `artifacts/ui-surface-manifest.json`.
The JSON artifact is generated from current source with `npm run manifest:ui` and checked by the canonical test suite. It records canonical page routes, declared/inherited middleware evidence, every HTML document, ordered scripts, and statically discoverable frontend `fetch()` capabilities. Each route keeps page and redirect targets separate; `kind: "mixed"` identifies handlers that may do either. Dynamic request methods and redirect targets remain `DYNAMIC` and `{dynamic}` rather than being guessed.

Static evidence is not authorization proof. Behavioral route and API security tests remain authoritative.

## Status labels

- **CONFIRMED:** Directly established from current source or generated inventory.
- **PROPOSED:** A modernization direction that still requires implementation and testing.
- **UNKNOWN:** Requires authenticated runtime or administrator validation.

## Confirmed surface

- 49 HTML documents: 20 dashboard, 11 platform-admin, and 18 root-level documents.
- 53 canonical page/redirect route records generated from `src/app/registerRoutes.js`.
- 41 routed documents and 8 unrouted documents.
- 211 normalized first-party frontend request capabilities; unresolved expressions remain visible rather than being guessed.
- Direct `GET *.html` requests are blocked; HTML is delivered through canonical handlers.
- Global state-changing requests receive CSRF protection and API mutation limiting.
- Five documents poll: admin overview, dashboard, map, player map, and player portal.

## Authorization evidence

Cross-cutting controls:

- Sessions are PostgreSQL-backed and use Passport Discord OAuth with HTTP-only, `SameSite=Lax` cookies.
- `ensureAdmin` recognizes legacy `is_admin` and platform roles `dashboard_admin` and `dashboard_owner`.
- Exact-server capabilities are resolved separately:
  - `SERVER_OWNER`: exact server guild owner.
  - `SERVER_MANAGE`: guild owner/admin or active exact-server admin.
  - `SERVER_MODERATE`: adds active exact-server moderator.
  - `SERVER_VIEW`: adds active verified player membership.
- Platform administrators do not receive an automatic exact-server capability bypass.

Important limitations:

- Middleware names in the generated manifest are source evidence only.
- `ensureApproved` proves membership in some approved guild; downstream resource handlers must still enforce exact tenant/server authorization.
- `ensureHasServers` proves a guild-role relationship to a server but does not itself require approved-guild or active-server status and does not bind a subsequently selected server.
- Several sensitive-looking pages are authenticated-only while their APIs enforce stronger authorization. Runtime navigation visibility for each role is **UNKNOWN**.

## Canonical page groups

### Public and player

- `/` renders the splash unless the player-portal host helper selects a dynamic redirect target.
- `/player` and `/player-portal` share the player portal.
- `/player-map` serves the standalone player map.
- `/shop` serves the player shop.

### Owner/operator

- `/dashboard` uses a special approved-guild-role check and otherwise renders onboarding.
- `/dashboard/automation` and `/logs` require an operable server.
- Task, control, spawn-exclusion, backup, rotation, AI, statistics, activity, console, boost, support, settings, map, and mission-editor pages use `ensureHasServers`.
- Feeds, economy pages, shop administration, roles, loot finder, server players, and server lists declare authentication but depend on stronger API authorization for mutations and private resources.

### Platform administration

- `/admin` and `/admin/*` are platform-admin surfaces.
- Guild approval, guild/server/user management, audit, database reset, reports, supply monitoring, and economy analytics remain distinct workflows.
- `/dashboard/roles` intentionally shares the role-management page but does not inherit the `/admin/*` page gate; API role calculations constrain its non-platform-admin use.

## Page capability findings

### High-risk or operational mutations

- Server control has an inline confirmation for start/stop/restart.
- Rotation activation warns that provider files will be uploaded or removed.
- Mission Editor confirms unsaved discard/reload, conflict resolution, and releasing all locks.
- Server Players uses strong confirmations for player wipes, full-server wipes, and list clearing.
- Shop administration confirms activation changes, deletion, preset deletion, and refunds.
- Platform database resets and destructive guild/server actions are confirmed.

Missing or inconsistent dedicated confirmation:

- Console arbitrary command submission, including the restart preset.
- Individual server-list entry removal.
- Automation full-log rescan, which is operationally expensive but not destructive.

### State and context fragmentation

- Server context is selected through `serverSelect`, `server-select`, `serverSelector`, query parameters, guild-first selectors, account-derived defaults, and multi-server checkboxes.
- Loading/error/empty/success handling exists broadly but is inconsistent; many failures use native `alert()` rather than retryable page state.
- Confirmation UX mixes native dialogs, custom modals, and inline panels.
- Authenticated role/data-state/mobile behavior remains **UNKNOWN** until browser QA is completed.

## Legacy and unrouted documents

These are present in the generated artifact with no canonical page route and cannot be requested directly because `.html` delivery is blocked:

| Document | Current route/replacement | Finding |
|---|---|---|
| `public/admin/feeds.html` | `/admin/feeds` redirects to `/dashboard/feeds` | Not proven equivalent; legacy page had platform-wide guild selection. |
| `public/automation.html` | `/automation` redirects to `/dashboard/automation` | Same core script; canonical page additionally exposes full rescan. |
| `public/economy-dashboard.html` | Redirects to `/dashboard/economy` | Not equivalent: legacy player wallet workflow redirects to administration settings. Player Portal may replace it, but parity is unproven. |
| `public/economy-leaderboard.html` | Redirects to dashboard leaderboard | Legacy shell around shared components. |
| `public/economy-transactions.html` | Redirects to dashboard transactions | Legacy shell around shared components. |
| `public/nitrado-settings.html` | Redirects to dashboard settings | Canonical page contains newer settings sections. |
| `public/index.html` | `/` renders splash | Old landing document. |
| `public/onboarding.html` | Root/dashboard splash | Old token-form onboarding; no route exists. |

No current HTML link, form action, or client navigation targets those direct `.html` documents. They must not be removed until capability parity is proven.

## Security and correctness follow-ups

1. Add behavioral HTTP access tests for representative anonymous, ordinary user, platform-admin, no-server, and exact-server operator cases.
2. Review whether `GET /logout` should become a CSRF-protected state-changing request.
3. Decide whether `ensureHasServers` should converge with approved/active operable-server semantics without broadening access.
4. Verify page/API role parity for authenticated-only administration surfaces.
5. Review faction invite eligibility evidence separately from acceptance-time verified identity.

## Next Phase 0 checks

- Static viewport, unique-ID, local-script, canonical-route, and duplicate-navigation contracts.
- Authenticated role matrix and redacted browser baselines.
- Poll overlap, hidden-tab behavior, request counts, map tile counts, and large-table behavior.
- Administrator validation of frequent tasks and costly pain points.
