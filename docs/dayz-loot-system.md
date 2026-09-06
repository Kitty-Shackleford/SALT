# DayZ loot system knowledge model

This document describes how DayZ item configuration, Central Economy (CE) mission files, map data, persistence, and runtime observations fit together. It is a research and design reference only. It does not authorize automated changes to live mission files.

## 1. Provenance and confidence rules

Choose authority by the kind of claim rather than applying one global ranking:

1. **Configured values:** the exact server's loaded game configuration and mission files.
2. **Documented engine/CE semantics:** official Bohemia documentation and source repositories.
3. **Observed runtime state:** runtime server logs and observations from that exact build.
4. **Dashboard behavior:** this repository's current implementation and tests.
5. **Interpretation:** community explanations or deductions, clearly labeled as inference.

When sources appear to disagree, first determine whether they answer different questions. An exact mission file establishes what that server configured; it does not override documented engine semantics, and neither one proves the server's current runtime state.

The official CE repository is versioned data, not a universal truth for every server. Values vary by DayZ release, map, platform, mission, and mods. The examples cited here are pinned to Bohemia's repository commit `9a21bb9f5fb9c62a7ce2761402196091588133e6` so later upstream changes cannot silently alter the evidence.[5][6][7]

Important distinctions:

- **Documented** means Bohemia describes the behavior or exposes it in an official file/API.
- **Configured/sample** means a value appears in an exact-server file or official sample; it proves that configuration, not complete runtime behavior.
- **Repository-implemented** means the behavior exists in this dashboard's current code and tests.
- **Runtime-observed** means exact-build logs or measurements show the state or behavior at a recorded time.
- **Inferred** means an interpretation is derived from evidence but is not stated authoritatively.
- **Unknown** means the data cannot be derived safely from mission XML or available evidence.
- **Configured value** is not necessarily the current runtime value; persistence and existing world objects can make them differ.

## 2. Architecture

```text
Loaded game/mod config
  CfgVehicles / CfgWeapons / CfgMagazines / CfgSlots
            |
            | class identity, inheritance, physical properties,
            | attachment and magazine compatibility
            v
Mission CE configuration
  cfgeconomycore.xml -> registered CE files and root classes
  db/types.xml       -> item population and spawn filters
  mapgroupproto.xml  -> building/container loot-point blueprints
  mapgrouppos.xml    -> placed building instances
  db/events.xml      -> event population and child rules
  cfgeventspawns.xml -> candidate event positions
  cfgeventgroups.xml -> grouped event compositions
  cfgspawnabletypes.xml -> initial damage/cargo/attachment recipes
  db/economy.xml     -> init/load/respawn/save policy by entity family
            |
            v
Central Economy runtime
  counts -> candidate selection -> eligible points -> spawn/cleanup
            |
            +---- persistence storage
            +---- RPT diagnostics and cleanup telemetry
```

`cfgeconomycore.xml` defines CE root classes, defaults, and additional mission files. Bohemia documents file registration for types such as `types`, `events`, and `spawnabletypes`; the official sample declares the root classes that participate in the economy.[2][9]

## 3. Item identity and physical attributes

### 3.1 Class names and inheritance

The classname used by `types.xml` is an engine config classname, not a friendly display name. Effective properties come from the loaded config inheritance chain after vanilla data and all mod overrides are applied. Official script APIs can query config paths, base classes, children, arrays, and inherited class relationships.[15]

A mod can:

- add a new config class;
- inherit from a vanilla class;
- override an existing class;
- add or replace mission CE entries for either class.

Bohemia's modding workflow packages `config.cpp` data into PBOs, and official samples demonstrate declaring `CfgPatches` and deriving classes under config namespaces.[4][19]

Do not classify an item as modded only because it is absent from one map's `types.xml`. Vanilla craft-only, hidden/base, event-only, or non-CE classes may also be absent. Safer classifications are:

- `vanilla_unchanged` — exact class/property baseline matches the selected official build;
- `vanilla_overridden` — vanilla class exists but the loaded value differs;
- `mod_added` — loaded class is attributable to a mod package;
- `unknown_origin` — provenance cannot be proved.

### 3.2 Attribute source matrix

| Attribute | Authoritative source | Mission XML? | Can mods change it? | Operational note |
|---|---|---:|---:|---|
| Class name / inheritance | Loaded engine config | No | Yes | Relevant inventory classes commonly live under `CfgVehicles`, `CfgWeapons`, or `CfgMagazines`; query the exact loaded build because static vanilla data is only a baseline.[15][20] |
| Display name / description | Loaded config/string tables | No | Yes | Localization means one stored string is not universally authoritative. |
| Base weight | Loaded item config/runtime item API | No | Yes | Store the native unit and a display conversion separately; container contents can change total runtime weight. |
| Item footprint | Loaded config/runtime inventory API | No | Yes | Width/height describe a grid footprint, not "slots" in the equipment-slot sense. |
| Cargo dimensions | Runtime `CargoBase`/loaded config | No | Yes | Width × height is nominal cells; fit also depends on footprints, rotation, occupancy, restrictions, and nesting.[16] |
| Equipment/attachment slots | Loaded `CfgSlots` and class config | No | Yes | Resolve slot IDs/names through the loaded slot registry.[17] |
| Magazine/ammo compatibility | Loaded weapon/magazine config and weapon APIs | No | Yes | Weapon magazine and chamberable-ammunition relationships come from loaded configuration/runtime checks; do not infer compatibility from caliber text alone.[18][23] |
| Default spawned cargo/attachments/damage | `cfgspawnabletypes.xml` and presets | Yes | Yes | This controls spawn recipes/probabilities, not structural compatibility or maximum cargo.[14] |
| CE population/spawn filters | Loaded `types.xml` sources | Yes | Yes | Apply files in the order registered by `cfgeconomycore.xml`.[2][5][9] |

### 3.3 Weight

Mission CE XML does not define item weight. The loaded class's inherited `weight` is the configured base value and DayZ's UI treats it as grams.[20] The bot can answer weight questions reliably only after ingesting or querying the exact loaded game configuration/runtime. Runtime weight can include quantity, state-dependent behavior, attachments, and cargo; official item and magazine code explicitly calculates dynamic and quantity-dependent contributions.[21][22] Therefore store both `base_weight_grams` and an explicitly runtime-derived `observed_total_weight_grams` rather than pretending one static number answers both questions.

**Change/restart/risk:** changing config-defined weight requires a mod/config build and normally a server/client content reload. Exact restart and client-mod requirements depend on how the server distributes that config. Risk includes client/server mismatch and unintended stamina/inventory balance changes. This cannot be inferred from `types.xml`.

### 3.4 Size, cargo, and slots

Keep these concepts separate:

- **Item footprint:** width × height cells occupied in cargo.
- **Cargo dimensions:** the grid owned by a container.
- **Equipment slot:** a named attachment location such as a body or weapon slot.
- **Attachment compatibility:** which classes may occupy a slot on a given parent.
- **Proxy/model position:** visual attachment placement; not cargo capacity.

`CargoBase` exposes cargo width/height and item dimensions for current contents; actual fit is a packing decision, not just arithmetic capacity.[16] `InventorySlots` exposes the engine's slot registry and lookup behavior.[17]

### 3.5 Attachments and magazines

There are two different questions:

1. **Can this class attach?** Use loaded config/runtime compatibility.
2. **Might it spawn attached or in cargo?** Use `cfgspawnabletypes.xml`, including attachment/cargo groups, presets, and chances.[14]

A spawned rifle lacking a magazine does not prove incompatibility. Conversely, an attachment listed in a spawn recipe should not be treated as the complete compatibility list.

## 4. `types.xml`: item population and placement filters

The official sample shows one `<type name="ClassName">` with scalar population fields, count flags, and zero or more category/usage/value/tag selectors.[5]

### 4.1 Field model

| Field | Safe meaning | Common mistake |
|---|---|---|
| `nominal` | Desired/target CE population for the type, subject to counting flags, available points, global limits, and runtime state. | Calling it an absolute maximum. |
| `min` | Low population threshold associated with replenishment candidacy. | Assuming CE spawns exactly when one pickup occurs. |
| `lifetime` | Configured cleanup lifetime in seconds for CE-managed instances. | Treating it as a guaranteed wall-clock despawn time. |
| `restock` | Replenishment pacing value in seconds. Exact queue/timer details are not fully documented in the cited Bohemia material. | Calling it simply "time after pickup." |
| `quantmin`, `quantmax` | Initial quantity range, generally percentage-like for quantity-bearing items; `-1` means quantity initialization is not applied by this field. | Treating it as stack capacity or item count. |
| `cost` | CE numeric priority/cost input present in official data. Complete engine semantics are not documented here. | Inventing a rarity formula from the number. |
| `category` | Content classification matched against compatible loot containers/points. | Assuming one universal list; valid names are mission-defined. |
| `usage` | Environment/use selector such as Military, Police, Town, or Hunting. | Treating usage as a map coordinate. |
| `value` | Value-layer selector, commonly Tier1–Tier4 in official missions. | Treating tier as a universal rarity grade. |
| `tag` | Additional spawn-point selector such as floor, shelves, or ground when defined by the mission. | Confusing tags with item categories. |

Valid category, tag, usage, and value names are declared by the mission's limit-definition files. The official Chernarus sample demonstrates that these vocabularies are data, not hard-coded assumptions.[8]

### 4.2 Count flags

The CE population count can include or exclude instances by context. The following names are the conventional interpretation supported by the fields and runtime use; Bohemia's published material does not fully define classifier boundaries:

- `count_in_map` — world/map instances;
- `count_in_player` — player-held/inventory instances;
- `count_in_cargo` — instances inside cargo;
- `count_in_hoarder` — instances in hoarder/storage contexts.

The flags determine what contributes to CE counting; they do not move an item or define a spawn point. Official entries demonstrate different combinations.[5] In particular, do not claim that every tent, barrel, vehicle, buried stash, or nested container maps to a specific cargo/hoarder bucket without an exact-build observation.

Other relevant flags in official `types.xml`:

- `crafted` marks craft-related handling in the CE data model;
- `deloot` associates a type with dynamic-event loot handling.

The exact native implementation of every flag is not fully described in the public documentation. Expose raw values and avoid stronger claims than the loaded mission and runtime observations support.

### 4.3 Replenishment lifecycle

A safe model is:

1. On startup, CE loads configuration and, according to persistence policy, loads saved world state and initializes entity families.[1][13]
2. CE counts instances in contexts enabled by the type's count flags.
3. Under-populated types become candidates relative to their configured thresholds. Public evidence does not settle whether every current build uses `< min` or `<= min`, so the dashboard should not encode that distinction as universal.
4. CE attempts replenishment toward `nominal`, constrained by restock pacing, global limits, player-avoidance settings, available matching points, and per-cycle work limits.[1]
5. Pickup changes context. Whether that reduces the CE count depends on the count flags.
6. Destruction/removal reduces the counted population when the destroyed instance was counted.
7. Lifetime makes an item eligible for cleanup, but proximity protections, cleanup batching, refreshed state, persistence, and engine rules can delay removal.[1]
8. A failed placement attempt does not prove bad XML; compatible free points and runtime limits may be unavailable.

### 4.4 Quantity

`quantmin`/`quantmax` initialize the quantity of quantity-bearing entities, such as ammunition stacks, food, or liquid containers. They do not define magazine capacity, container cargo capacity, or nominal population. Interpret the resulting gameplay value through the class's quantity system; a percentage-like range only becomes an actual unit count when combined with class/runtime capacity.

### 4.5 Rarity

Do not store one unsupported `rarity` number as if DayZ provides it. Rarity is an interpretation derived from multiple facts:

- target and minimum population;
- eligible map/building points;
- usage/value/category/tag filters;
- event-only restrictions;
- restock and cleanup behavior;
- count flags and player/hoarder holdings;
- current persistence state and competition.

A useful bot can report these factors and an explicitly derived score, but must label the score as dashboard-derived, versioned, and server-specific.

## 5. Where loot can spawn

The official filename is `mapgroupproto.xml`, not `cfgmapgroupproto.xml`.[3][6]

### 5.1 Static building pipeline

```text
types.xml item selectors
        |
        v
mapgroupproto.xml group/container selectors + local loot points
        |
        v
mapgrouppos.xml placed group position/orientation
        |
        v
world-space candidate loot positions
```

- `mapgroupproto.xml` is the blueprint layer. A group corresponds to a building/object class and contains containers, allowed category/tag/usage/value selectors, local points, and loot limits.[6]
- `mapgrouppos.xml` is the placement layer. It lists instances of those groups with world position and orientation.[7]
- An item is eligible only where its selectors are compatible with the point/container/group selectors and the CE accepts the point at runtime.

A parser can transform local prototype points by the placed group's orientation and position to derive candidate world coordinates. Those are **candidate positions**, not proof that an item is currently there.

### 5.2 Categories, usage, tags, and values

These selectors form an intersection/matching problem rather than a simple chain with one value at each level. An item may have multiple usages or values, and a group/container may supply selectors at different levels.

- **Category** groups content kinds used by loot containers.
- **Usage** identifies environment/function layers, such as Military or Town.
- **Tag** narrows point form, such as floor or shelves, where the mission defines it.
- **Value** selects spatial/value layers such as Tier1–Tier4.

The valid vocabulary comes from the loaded mission. Never reject a modded selector merely because it is absent from the vanilla Chernarus list; `cfglimitsdefinitionuser.xml` and other loaded files can extend combinations.[8]

### 5.3 Tiers

Tier values are map-specific spatial/value layers. They are not universal statements that "Tier 4 is always northwest" or that an item is intrinsically rare. The official CE tool data contains map-specific layer assets, while `types.xml` and map groups consume named values.[5][6]

For each map/version, store:

- the tier/value name;
- its source mission/snapshot;
- eligible groups/points or a derived spatial geometry when available;
- the item definitions that reference it.

A bot should say "this definition is eligible for Tier3 and Tier4 points on this mission snapshot," not "this is a Tier4 item everywhere."

## 6. Event loot

### 6.1 File responsibilities

- `db/events.xml` defines event population, lifetime/restock/radii, active/position/limit modes, flags, and child types/weights or bounds.[10]
- `cfgeventspawns.xml` supplies candidate coordinates for named events.[11]
- `cfgeventgroups.xml` defines grouped compositions and relative members for applicable events.[12]
- `cfgspawnabletypes.xml` can define damage, cargo, and attachments for spawned entity classes.[14]

The event name is the join key. The child class or group connects the event to actual entities. Event child `min`/`max` and event `nominal` do not mean the same thing as item `types.xml` population fields.

### 6.2 Dynamic versus static

Avoid using "dynamic" to mean merely "not currently present." Model event behavior with explicit fields:

- position mode (`fixed`, `player`, or other loaded value);
- candidate anchors;
- limit mode;
- event population and child composition;
- persistence policy for the entity family;
- active state;
- cleanup and safety radii.

Helicopter crashes, convoys, vehicles, infected, animals, and custom airdrops may use different combinations. A modded airdrop is not documented by the vanilla sample merely because it uses the same file format.

### 6.3 Event query model

For "where and how often does this event spawn?", return:

- event definition source and active state;
- configured nominal/min/max/restock/lifetime;
- candidate positions or positioning mode;
- child types/groups and their bounds/weights;
- spawnable cargo/attachment recipes;
- current runtime observation if available, clearly separated from configuration.

## 7. Persistence, restarts, and wipes

`db/economy.xml` independently controls initialization, loading, respawning, and saving for entity families such as dynamic entities, animals, zombies, vehicles, buildings, and players.[13] The pinned Chernarus globals sample configures `InitialSpawn=100` and `RestartSpawn=0`; the sample alone does not establish the complete native semantics of those values.[24]

Keep three layers separate:

1. **Configuration:** desired rules in XML and loaded config.
2. **Persistent state:** saved entities and CE state from storage.
3. **Temporary runtime state:** current objects, queues, occupied points, nearby players, and transient events.

Consequences:

- A restart is not automatically a wipe or a guaranteed loot refill.
- Editing `types.xml` changes future CE decisions but does not necessarily delete or transform already persisted objects immediately.
- Pickup can move an item between count contexts rather than make it cease to exist.
- Disconnect behavior depends on where the item is stored and persistence rules.
- Destruction removes the current object; replacement still depends on CE thresholds and placement.
- Deleting the mission's `storage_*` state is a destructive CE wipe/reinitialization, not cache clearing.[3] A wipe discards some or all persistent state, after which initialization and current configuration repopulate the world. Exact wipe scope is an operator action and must be recorded explicitly.

Whether a specific mission-file edit is hot-reloaded is not established by the cited sources. The safe operational policy is: validate offline, back up every affected file and persistence state, upload only with explicit authorization, and plan a controlled restart unless the exact server/version documents a supported reload path.

## 8. Modded loot and override order

A complete modded item requires two independent layers:

- a loaded engine class supplied/overridden by game or mod config;
- CE/event configuration if it should be spawned by those systems.

Common failure classes:

- CE references a classname not loaded on the server;
- class exists but has no eligible CE selectors/points;
- a later registered custom types file overrides earlier values;
- dependencies or client mod sets do not match;
- event or spawnable recipe references a missing child/attachment;
- a valid type remains below nominal because no eligible free point exists.

Store source files with load order and hashes. Never flatten overrides without preserving provenance; otherwise the bot cannot answer "which XML controls this effective value?"

## 9. Existing DayZ Dashboard capabilities

The project already provides a useful file-backed and runtime-observation foundation:

- `services/lootParserService.js:97-115` parses core type fields, flags, categories, usages, values, and tags.
- `services/lootParserService.js:153-197` parses map-group usage and placement data; the service builds an in-memory index cached by guild/server/map.
- `routes/lootFinder.js:37-56` resolves the exact server and guild for authenticated loot queries.
- `services/lootLiveService.js:82-90,117-157` parses RPT `RESPAWN CANDIDATE` and item-addition diagnostics.
- `bot/services/lootService.js:83-96` provides a bot-local `types.xml` view.
- `bot/commands/economy.js:9-14,42-49` exposes `/economy search` and `/economy item`.
- `db/migrations/041_add_loot_despawn_events.js:15-30` stores exact-server cleanup observations for the heatmap.
- Mission editor, validation, GitHub review, and Nitrado file services can read/review/deploy configuration, but deployment must remain a separate privileged workflow.

Current gaps:

- no normalized, versioned item/config knowledge tables;
- no authoritative loaded-config ingestion for weight, footprint, cargo, slots, or compatibility;
- no durable source/load-order graph for effective overrides;
- no normalized event/group/spawn-point model;
- no explicit distinction between configured facts, derived facts, and runtime observations;
- no confidence/provenance field for bot answers.

## 10. Conceptual SQL model (do not implement yet)

The user's four-table sketch is directionally correct but loses server/map/version scope, many-to-many selectors, override provenance, and observations. A safer normalized design is:

```sql
loot_items (
  id, class_name, namespace, display_name, description,
  origin_kind, mod_name, metadata_json
)

loot_config_snapshots (
  id, server_id, map_key, game_version, captured_at,
  aggregate_hash, status
)

loot_sources (
  id, snapshot_id, file_type, relative_path, load_order,
  content_hash, is_base, is_override
)

loot_type_definitions (
  id, source_id, item_id,
  nominal, minimum, lifetime_seconds, restock_seconds,
  quant_min, quant_max, cost,
  count_in_cargo, count_in_hoarder, count_in_map, count_in_player,
  crafted, deloot, raw_json
)

loot_type_selectors (
  type_definition_id, selector_kind, selector_name
)

loot_item_config_versions (
  id, item_id, game_version, mod_set_hash, config_path,
  parent_class, base_weight, footprint_width, footprint_height,
  cargo_width, cargo_height, provenance, source_hash
)

loot_slots (
  id, slot_name, display_name, source_hash
)

loot_item_slots (
  item_config_version_id, slot_id, relation_kind
)

loot_compatibility (
  source_item_config_id, target_item_id, relation_kind, provenance
)

loot_map_groups (
  id, snapshot_id, group_name, loot_max, source_id
)

loot_group_selectors (
  group_id, container_name, selector_kind, selector_name
)

loot_spawn_points (
  id, group_id, local_x, local_y, local_z, range, height, tags_json
)

loot_group_instances (
  id, snapshot_id, group_id, world_x, world_y, world_z,
  rotation_json
)

loot_events (
  id, snapshot_id, source_id, event_name,
  nominal, minimum, maximum, lifetime_seconds, restock_seconds,
  position_mode, limit_mode, active, radii_json, flags_json
)

loot_event_children (
  event_id, child_class, group_name, minimum, maximum,
  loot_min, loot_max, weight_or_raw_json
)

loot_event_positions (
  event_id, x, y, z, angle, source_id
)

loot_spawn_recipes (
  snapshot_id, item_id, damage_json, cargo_json,
  attachments_json, presets_json, source_id
)

loot_runtime_observations (
  id, server_id, snapshot_id, observed_at, observation_type,
  item_id, event_id, x, z, count_value, raw_evidence_hash
)
```

Key constraints:

- Every server-derived row is exact-server scoped.
- `class_name` alone is not globally unique across versions/mod sets; identity must include a versioned config context.
- Preserve raw validated data beside normalized fields for forward compatibility.
- Use immutable snapshot/source hashes so answers are reproducible.
- Separate authoritative configuration, dashboard-derived values, and runtime observations.
- Never store provider credentials, signed transfer URLs, player/session details, or full sensitive logs in the knowledge model.

## 11. Bot query capabilities and required evidence

| Question | Required data | Safe answer style |
|---|---|---|
| Where does this item spawn? | Effective type selectors + group/container selectors + instances + event links | Candidate areas/points for this exact snapshot; not current presence. |
| How much does it weigh? | Exact loaded config/runtime property | Base weight and source/version; optional observed total weight. |
| How much inventory space? | Footprint plus cargo/slot data | `W×H` footprint; cargo dimensions and equipment slots separately. |
| How often does it respawn? | Effective type fields + runtime limits/telemetry | Explain target, threshold, restock, and constraints; do not promise a fixed pickup-to-respawn time. |
| Is it vanilla or modded? | Versioned vanilla baseline + loaded mod ownership/override graph | One of the four provenance states, with evidence. |
| Why is it not spawning? | Effective config, selectors, counts, points, logs, persistence | Ranked causes with evidence and unknowns; never assert one cause from XML alone. |
| Which XML controls it? | Ordered source graph and winning definition | All contributing files and the effective winner. |
| What is the rarest rifle? | Explicit derived scoring policy + snapshot | Label as a dashboard-derived ranking and show factors. |
| How do I increase spawn rate? | Effective source and safety analysis | Describe candidate fields and consequences; do not mutate automatically. |
| Does this require restart? | Exact server/version reload documentation or controlled test | Return `unknown` unless verified; default operational plan is backup + controlled restart. |

Each bot answer should carry:

- server/map/version/snapshot identity;
- source file(s) and hashes;
- fact kind (`configured`, `runtime_observed`, `derived`, `unknown`);
- confidence and timestamp;
- caveats about persistence and mods.

## 12. Attribute verification cards

### Weight

- **Source:** loaded game/mod config and runtime item API.
- **File:** mod/game `config.cpp`/`config.bin`; not CE XML.
- **Example:** query the effective class after inheritance.
- **Can be changed:** yes, through game/mod config.
- **Requires restart:** deployment-specific; assume controlled content reload/restart until verified.
- **Risk:** client/server mismatch, stamina and balance changes.

### Item footprint and cargo

- **Source:** loaded config/runtime inventory APIs.[16]
- **File:** game/mod config; not `types.xml`.
- **Example:** footprint `W×H`; cargo `W×H`, reported separately.
- **Can be changed:** yes, by mod config.
- **Requires restart:** deployment-specific; do not claim hot reload.
- **Risk:** invalid inventory layouts, clipping, persistence incompatibility.

### Attachments and magazines

- **Source:** loaded config/runtime compatibility; spawn defaults in `cfgspawnabletypes.xml`.[14][17][18]
- **Can be changed:** yes, by mod config and spawn recipes.
- **Requires restart:** config changes normally require content reload; mission recipe reload is unverified.
- **Risk:** incompatible classes, dependency mismatch, unexpected loaded weapons/containers.

### CE population fields

- **Source:** effective ordered `types.xml` definitions.[2][5][9]
- **Can be changed:** yes, in mission configuration.
- **Requires restart:** exact hot-reload behavior is unknown; plan backup + validation + controlled restart.
- **Risk:** shortages, oversupply, queue pressure, no-point conditions, persistence lag.

### Spawn location selectors

- **Source:** effective types, limit definitions, `mapgroupproto.xml`, and `mapgrouppos.xml`.[6][7][8]
- **Event source:** effective event definitions and positions.[10][11]
- **Can be changed:** yes, with map/mission edits.
- **Requires restart:** treat as restart-required unless verified otherwise.
- **Risk:** invalid references/coordinates, no eligible points, excessive entity density.

## 13. Unknowns and prohibited assumptions

The following must remain `unknown` or `derived` until verified against an exact build/server:

- complete native semantics of `cost`;
- exact internal replenishment queue/timer behavior for every `restock` value;
- a guaranteed despawn timestamp from `lifetime` alone;
- universal tier geography;
- a universal rarity classification;
- physical attributes derived from `types.xml`;
- mod ownership inferred only from presence/absence in vanilla CE data;
- hot-reload/restart requirements for every provider/platform/version;
- current item presence inferred from candidate spawn points;
- current CE counts inferred only from static configuration.

## 14. Safe future automation boundary

A future mutation workflow should be separate from knowledge ingestion:

1. Resolve exact guild/server and current provider identity.
2. Download and hash all affected files.
3. Back up every affected file and relevant persistence state.
4. Parse all registered sources in load order.
5. Produce a complete proposed replacement and semantic diff.
6. Validate XML/JSON, class references, selector vocabularies, and path containment.
7. Require explicit authorized review.
8. Prefer a GitHub pull request for durable review/history.
9. Upload only after approval, with exact-server reauthorization.
10. Read back and verify provider bytes; preserve ambiguous claims rather than retrying blindly.
11. Restart only under an approved maintenance plan.
12. Observe logs and provide rollback from the verified backup.

No loot mutation should be triggered merely because the bot can explain a field.

## Sources

[1] https://community.bistudio.com/wiki/DayZ:Central_Economy_Configuration — Central Economy Configuration – DayZ
[2] https://community.bistudio.com/wiki/DayZ:Central_Economy_mission_files_modding — Central Economy mission files modding – DayZ
[3] https://community.bistudio.com/wiki/DayZ:Central_Economy_setup_for_custom_terrains — Central Economy setup for custom terrains – DayZ
[4] https://community.bistudio.com/wiki/DayZ:Modding_Basics — DayZ Modding Basics
[5] https://github.com/BohemiaInteractive/DayZ-Central-Economy/blob/9a21bb9f5fb9c62a7ce2761402196091588133e6/dayzOffline.chernarusplus/db/types.xml — Official ChernarusPlus types.xml (pinned)
[6] https://github.com/BohemiaInteractive/DayZ-Central-Economy/blob/9a21bb9f5fb9c62a7ce2761402196091588133e6/dayzOffline.chernarusplus/mapgroupproto.xml — Official ChernarusPlus mapgroupproto.xml (pinned)
[7] https://github.com/BohemiaInteractive/DayZ-Central-Economy/blob/9a21bb9f5fb9c62a7ce2761402196091588133e6/dayzOffline.chernarusplus/mapgrouppos.xml — Official ChernarusPlus mapgrouppos.xml (pinned)
[8] https://github.com/BohemiaInteractive/DayZ-Central-Economy/blob/9a21bb9f5fb9c62a7ce2761402196091588133e6/dayzOffline.chernarusplus/cfglimitsdefinition.xml — Official ChernarusPlus CE limit definitions (pinned)
[9] https://github.com/BohemiaInteractive/DayZ-Central-Economy/blob/9a21bb9f5fb9c62a7ce2761402196091588133e6/dayzOffline.chernarusplus/cfgeconomycore.xml — Official ChernarusPlus cfgeconomycore.xml (pinned)
[10] https://github.com/BohemiaInteractive/DayZ-Central-Economy/blob/9a21bb9f5fb9c62a7ce2761402196091588133e6/dayzOffline.chernarusplus/db/events.xml — Official ChernarusPlus events.xml (pinned)
[11] https://github.com/BohemiaInteractive/DayZ-Central-Economy/blob/9a21bb9f5fb9c62a7ce2761402196091588133e6/dayzOffline.chernarusplus/cfgeventspawns.xml — Official ChernarusPlus cfgeventspawns.xml (pinned)
[12] https://github.com/BohemiaInteractive/DayZ-Central-Economy/blob/9a21bb9f5fb9c62a7ce2761402196091588133e6/dayzOffline.chernarusplus/cfgeventgroups.xml — Official ChernarusPlus cfgeventgroups.xml (pinned)
[13] https://github.com/BohemiaInteractive/DayZ-Central-Economy/blob/9a21bb9f5fb9c62a7ce2761402196091588133e6/dayzOffline.chernarusplus/db/economy.xml — Official ChernarusPlus economy.xml (pinned)
[14] https://github.com/BohemiaInteractive/DayZ-Central-Economy/blob/9a21bb9f5fb9c62a7ce2761402196091588133e6/dayzOffline.chernarusplus/cfgspawnabletypes.xml — Official ChernarusPlus cfgspawnabletypes.xml (pinned)
[15] https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/global/game.c — Official DayZ script API: game config access
[16] https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/systems/inventory/cargo.c — Official DayZ script API: CargoBase
[17] https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/systems/inventory/inventoryslots.c — Official DayZ script API: InventorySlots
[18] https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/4_world/entities/core/inherited/weapon.c — Official DayZ script API: weapon compatibility
[19] https://github.com/BohemiaInteractive/DayZ-Samples/blob/master/Test_Crafting/config.cpp — Official DayZ config.cpp sample
[20] https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/entities/entityai.c — DayZ EntityAI config roots and attachment slots
[21] https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/4_world/entities/itembase.c — DayZ runtime item weight calculation
[22] https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/4_world/entities/itembase/magazine/magazine.c — DayZ magazine quantity-dependent weight
[23] https://github.com/BohemiaInteractive/DayZ-Script-Diff/blob/main/scripts/3_game/dayzgame.c — DayZ chamberable ammunition compatibility
[24] https://github.com/BohemiaInteractive/DayZ-Central-Economy/blob/9a21bb9f5fb9c62a7ce2761402196091588133e6/dayzOffline.chernarusplus/db/globals.xml — Official ChernarusPlus CE globals (pinned)
