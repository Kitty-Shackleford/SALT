# Player Radar and Jammer Design

Status: implemented and feature-verified locally; PostgreSQL migration rehearsal and the canonical full-suite release gate remain outstanding.

## CONFIRMED

- Radar and jammer access is bought or rented through the shop on an exact server.
- Supported jammer behaviors include:
  - full-map jamming;
  - player-centered jamming;
  - fixed-area jamming;
  - deception instead of suppression.
- Deception may emit non-violent synthetic activity: emotes, placements, builds, take-downs, pings, and false player locations.
- Synthetic activity uses the purchaser's player name.
- The bot and administrator dashboard must identify synthetic activity as jammer-generated.
- Synthetic activity must never overwrite or masquerade as authoritative ADM/RPT observations inside the database.

## PROPOSED DATA BOUNDARIES

1. A shop item carries an immutable capability snapshot describing configurable radar/jammer flavor, radius, map scope, affected audience, suppression/deception mode, deception persistence, radar reveal precision, and deception action allowlist.
2. Options that can safely vary are configured per shop product rather than hard-coded globally. Exact-server policy may place upper bounds on product settings.
3. Checkout activates that capability for the purchasing `user_id`, `identity_id`, `server_id`, and `guild_id`. Rentals use the existing restart-count lifecycle; permanent products remain active until explicitly disabled/refunded.
4. Authoritative log tables (`player_position_snapshots`, `territory_events`, `player_emote_events`, deaths, kills, and shop placement records) remain unchanged.
5. Jammer activations and generated deception are recorded separately with:
   - exact server/guild and purchaser identity;
   - source order/order-item;
   - `source = 'jammer'`;
   - jammer flavor and activation window;
   - synthetic action kind and generated coordinates;
   - creation seed/version for reproducibility and audit.
6. Bot/dashboard serializers include jammer provenance. Player radar serializers deliberately project only the game-facing event fields and purchaser display name; they never expose another player's order, order item, real private placement, or authoritative trail.
7. Deception generation is deterministic for an activation/time bucket so browser refreshes cannot multiply events or leak a random-number side channel. Generated coordinates are clamped to the selected map bounds.
8. A radar response is computed server-side from the authenticated viewer's exact active link and active purchased/rented capability. The browser never receives a superset and filters it locally.

## JAMMER FLAVORS

- `full_map`: applies across the configured map; no center/radius is required.
- `player`: center follows the purchaser's newest sufficiently fresh authoritative position.
- `area`: center is the purchased/activated fixed coordinate and has a configured radius.
- Deception is a configurable effect (`deceive` or `both`) applied to any scope above; it injects selected synthetic non-violent activity instead of, or in addition to, suppressing real radar results.

The suppression/deception operation should be an explicit enum (`suppress`, `deceive`, or `both`) rather than inferred from flavor. This allows full-map, player, and area products to use the same safe processing path.

## PRIVACY AND AUTHORIZATION INVARIANTS

- Exact linked account, user, identity, server, guild, active membership, and active shop lifecycle are revalidated before every radar response.
- Ordinary player-map layers remain self-only except explicitly enabled faction-member locations and future radar results.
- Radar output is a purpose-built projection. It cannot reuse dashboard map payloads.
- No API response exposes another player's purchases, shop placements, movement trail, source order IDs, jammer metadata, or exact location unless that exact datum is an authorized radar result.
- Disabled or expired products fail closed and produce no radar/jammer effect.
- Configuration and activation mutations use CSRF protection, exact-server manager/player authority, and transaction-time revalidation.

## RUNTIME FLOW AND FRESHNESS

- Checkout creates the capability activation in the same transaction as the completed order; a separate application or game-server restart is not part of activation.
- Full-map radar reads the newest fresh position observation for every observed identity on the exact server. It does not wait for the purchaser to receive a new position snapshot and does not require targets to have dashboard memberships.
- Radius-limited radar still requires a fresh purchaser position so the radius can be enforced fail-closed.
- The player map requests radar in parallel with its larger map-data payload, refreshes every 30 seconds while visible, and shows an explicit active, stale, or error state.
- Exact and approximate returns use high-contrast markers plus a current-contact heat overlay. Presence-only returns remain visible as a contact list even though their locations are intentionally hidden.
- Radar is log-derived, not live GPS. New movement cannot appear before the next successful provider log sync and parse; increasing the browser poll rate alone cannot make stale provider evidence current.

## DISCORD DELIVERY ASSESSMENT

A private ephemeral `/radar` image response is safer than creating temporary channels: it avoids channel-permission races, cleanup failures, and guild clutter. This remains a separate proposed increment because the bot image currently has neither map assets nor a raster renderer. Any Discord implementation must reuse the same exact-server authorization, capability lifecycle, freshness policy, and jammer projection rather than introducing an independent data path.

## REMAINING IMPLEMENTATION DECISIONS

The affected audience, deception persistence, suppression/deception combination, radar reveal precision, scope, radius, and allowed synthetic actions are product-level configuration options. Exact-server policy can constrain their permitted ranges rather than imposing one global behavior.

The remaining server-level decision is the maximum authoritative location age that may qualify as a live radar target. It must account for Nitrado log publication and the configured sync cadence; stale positions must never be presented as current without an explicit stale indicator.
