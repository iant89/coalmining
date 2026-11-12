# Architecture

The game follows the spec's one rule (§82): **the mine is a simulation.** Everything that matters
lives in `src/sim` as plain data and functions; `src/game` draws it with Forge-Engine and turns
clicks into commands.

```
          real time ─► SimClock.ticksFor(speed) ─► MineSimulation.tick() × n
                                                        │  (authoritative SimState)
   ┌──────────── src/game (Forge-Engine) ───────────────┼──────────────────────────┐
   │ TerrainView  — dirty chunks → meshes + textures    │ reads state              │
   │ EquipmentView — interpolated poses, pivots         │ interpolates by alpha    │
   │ WorldView    — buildings, stockpile, line overlays │                          │
   │ GameUI       — HUD, panels, dialogs ─────────────── commands.ts ──► SimState   │
   └────────────────────────────────────────────────────────────────────────────────┘
```

## Layers and boundaries

| Layer | May import | Must not |
| --- | --- | --- |
| `src/sim` | itself, `src/data` JSON | `@forge/engine`, `src/game`, DOM globals, `Math.random`, wall-clock time |
| `src/game` | `src/sim`, `@forge/engine` (package root) | engine deep imports; change sim state except through `commands.ts` / `MineSimulation` |
| Forge-Engine | — | anything coal-mining specific (spec §2) |

`tools/lint-arch.mjs` enforces the first two rows and `tsconfig.sim.json` compiles the simulation
without DOM or WebGPU types. The only engine change this project has needed was a genuine engine
bug (debug lines losing endpoints), fixed in Forge-Engine with its own regression test.

## Simulation

**State.** `SimState` (`src/sim/state.ts`) is the whole mine: terrain and geology as typed arrays,
equipment, workers, tasks, blocks, patterns, blasts, roads, dumps, stockpiles, treasury, customers,
permits, weather, notifications and statistics. It round-trips through `save/save.ts` unchanged.
`Sim` (`sim.ts`) wraps it with the catalog, the RNG, the domain event bus and money/notification
helpers.

**Time.** A fixed tick of `TICK_SECONDS = 5` simulated seconds. 1× is real time; speeds run to 250×
(1000× in debug). This departs from the spec's *suggested* one-minute tick on purpose: at 1× a
minute tick means a minute of command latency and trucks jumping 750 m. Executors spend a time
*budget* per tick across their phases, so cycle times do not depend on the tick length.

**Pipeline** (`simulation.ts`, spec §5.1): store previous poses → advance clock → hourly weather and
roads → blast-zone clearance → tasks (which drive equipment, mining and logistics) → conveyors →
preparation plant → loadout → per-minute
safety, lab results and objectives → hourly ledger flush → end-of-day reports, market, permits.

**Determinism.** All randomness is the seeded `Rng` in state; nothing reads the clock. Same seed +
same commands = same mine, and save → load → continue equals never saving (both tested).

### The task system (spec §6)

`tasks/service.ts` is the Task AI: lifecycle `CREATED → VALIDATING → QUEUED → ASSIGNED → TRAVELING →
EXECUTING → COMPLETED`, with `BLOCKED → RESOLVING` and `CANCELLED`/`FAILED`. Every block carries a
sentence the player can act on ("RH60 #01: Ray Combs is off shift (shift 06:00–18:00)", "Block A2:
the remaining 211 t of overburden is unblasted rock. Drill and blast it").

- `validateTask` runs before a task exists (the task dialog shows its errors and warnings live).
- Assignment (the Role AI) picks a free machine of the right category and a qualified, on-shift,
  not-busy operator — the machine's regular operator first.
- Each tick, assigned tasks are re-checked (breakdown, fuel, shift, qualification, permits,
  executor-specific conditions such as the blasting window) before their executor runs.
- `tasks/executors.ts` is the Equipment AI: one executor per task type, spending the tick budget
  across phases (`to-loader → queue → loading → to-dump → dumping → …`). Executors call domain
  modules; equipment itself has no business logic. `equipment/movement.ts` is the Movement AI.
- The excavator and its trucks cooperate through state: trucks queue at a loading spot beside the
  excavator in arrival order; the excavator loads the spotted truck bucket by bucket and releases it
  when full.
- `commands.orderBlockWork` is the production-objective layer (spec §11, §65): one order becomes
  drill → blast → excavate with every free truck hauling.

### Geology: true vs known

`world/geology.ts` holds the true layers (topsoil, sandstone, shale, coal, underclay) and coal
quality per cell. The player only ever sees `estimateAt(samples, x, z)` — an inverse-distance
estimate from core holes, blast holes that hit coal and the two legacy holes, with a confidence.
Overlays, block estimates and drill designs use the estimate; digging uses the truth.

### Mining rules

- Drill patterns are data (hole positions/depths), not entities. *Drill to coal* stops at the roof
  (protects the seam); *fixed depth* goes to depth plus subdrill (damages coal it passes into).
- A blast sets a per-cell `looseFloor` from each hole's absolute bottom plus a small fracture zone
  that stops at the coal; rock above it is diggable. Coal damage dilutes the coal later mined.
- Excavation is top-down within the bucket's reach, in ≤ 0.5 m lifts, one layer per bite, and never
  sends coal to spoil. Coal recovery is 95 % less blast damage.
- Dumps raise terrain cells near the tipping point up to a height limit; stockpiles blend quality.

### Logistics and construction (development phase 08)

- **Construction** (`logistics/construction.ts`, data in `src/data/construction.json`): a project is
  planned with a full estimate (cost, work time, finished grade, earthworks, warnings), paid pro rata
  as work is done, and changes the world only when finished. Each project is worked by a `CONSTRUCT`
  task: a dozer for haul roads (it grades the alignment cell by cell to a straight profile as it
  advances), a day-shift contractor crew for conveyors and stockpiles. A finished road joins the
  road graph, so routing uses it from the next trip.
- **Conveyors** (`logistics/conveyors.ts`): hopper → belt → stockpile, a directed edge of the
  logistics graph, simulated at pipeline step 09. The belt is plug flow: each tick loads at most the
  rated capacity × dt as one slice, which discharges whole after `length / speed`, so throughput can
  never exceed capacity (tested). A full stockpile jams the belt, idle belts stop, running belts
  draw power and wear, and breakdowns need a mechanic (`REPAIR` on a conveyor target).
- **Road maintenance**: graders run `GRADE_ROAD`; with auto-grading on, an hourly dispatch sends idle
  graders to the worst road below the threshold (`automation.ts`, spec §11.2 MAINTAIN_ROAD).
- **Coal routing**: `settings.coalDestination` points MINE COAL orders at a stockpile or a hopper.
  Coal is accounted exactly: a truck keeps any part-load a full hopper or stockpile cannot take.

### Preparation plant and loadout (development phase 09)

- **The plant** (`processing/plant.ts`, data in `src/data/plant.json`) runs at pipeline step 10, after
  the conveyors. It is a chain of units (feeder, breaker, screen, dense-medium cyclone), each with a
  capacity, power draw, wear per kilotonne and a breakdown hazard that rises as it wears. The
  slowest unit sets the capacity; the cyclone's and screen's condition and the operator's skill set
  the separation efficiency.
- **Washability** (`wash`) is a pure function: raw coal is coal with inherent ash plus rock at 80 %
  ash. A lower cut density rejects more rock and some of the dirtiest coal, so the product is cleaner
  and smaller. Pyritic sulfur leaves with the rock. Mass, ash and sulfur balance exactly between
  feed, product and refuse (tested), and the PLANT tab previews the result for the current setting.
- The plant runs only when it is switched on, refurbished, unbroken, staffed by a plant operator on
  shift, has feed and has room for the product; otherwise it stops with a reason. Refuse is placed on
  the refuse pile like spoil, so the pile grows on the terrain. Breakdowns file a mechanic `REPAIR`
  on a `{ kind: "plant" }` target.
- **Loadout** (`economy/market.ts`): with a loadout, a sale becomes a `Shipment` loaded at the loadout's
  rate, first come first served, and paid when loading ends. Coal sold and waiting is committed: it
  cannot be sold twice or reclaimed by the plant. A pile that runs dry ships short and is paid for
  what was loaded. Mines without a loadout (older saves) keep instant sales.

### Management: support trucks, foremen and the morning meeting

- **Lube truck** (`FIELD_FUEL`): every ten minutes `supportDispatch` sends an idle lube truck to the
  thirstiest machine (below 35 % fuel or over 60 h since greasing). It fills its own and its cargo
  tank at the fuel station when low, parks beside the machine and pumps. While it works it sets the
  machine's `serviceHold`, which pauses that machine's own task without blocking it (the hold is
  released with the lube truck's task). With a lube truck on site the contractor bowser is only a
  last resort below 5 %.
- **Service truck** (`SERVICE_CALL`): a breakdown files a field repair when a service truck exists
  (otherwise the old walking `REPAIR`); overdue machines get a preventive service in the field.
- **Crews** (`management/crews.ts`): a crew is a foreman plus machines and people, with a prioritised
  order list. Tasks carry a `crewId`; assignment (`pickEquipment`/`pickWorker`) then only considers
  the crew's machines and people. On each round (every 12–42 min by the foreman's leadership, on
  shift only) the foreman retires finished orders, reports what blocks running ones, re-issues work
  that ended unfinished (up to three times, then STUCK with a reason) and starts the next order
  when its machine is free. Orders lower in the list wait for machines claimed by higher ones.
  Player orders (`crewId` null) can still use any machine.
- **Morning meeting** (`management/meeting.ts`): at every shift start `holdMeeting` writes a report per
  crew (tonnes hauled since the last meeting, orders, broken or overdue machines, tired people,
  foremen without a crew). The simulation does not wait for it; the UI pauses the clock while the
  meeting is pending and `closeMeeting` ends it and sends the foremen out at once.

## Presentation

- `TerrainView`: one mesh + one colour texture per 16×16-cell chunk, rebuilt only when the chunk's
  version changed, at most a few per frame (spec §14.2). Overlays (NORMAL, GEOLOGY, ELEVATION,
  MINING, PERMITS) recolour the same chunks.
- `EquipmentView`: procedural models from engine primitives with animation pivots (truck body,
  excavator house/boom/stick/bucket, drill mast, dozer blade), interpolated between ticks and
  pitched/rolled to the ground.
- `WorldView`: buildings, the ROM stockpile cone (volume = tonnage), and per-frame line overlays
  (block outlines, holes, samples, routes, blast zone, selection).
- `CameraRig`: ISOMETRIC / FREE / OVERVIEW / FOLLOW (spec §48). Picking and label projection use the
  render camera's own view-projection matrix.
- `GameUI`: DOM panels patched in place (`ui/morph.ts`) so live numbers update without detaching
  the button under the cursor.
- The game runs as an engine `ISystem` (gameplay band, order 200). Forge journals component
  additions made during a system pass, so views keep references to the renderables they create
  instead of looking them up (`models.ts`), and create entities with `placed()`, which writes the
  position through the transform handle so a scale or rotation set in the same pass cannot reset it
  to the origin.

## Extending

- **Equipment** (spec §52, §79): add a JSON file in `src/data/equipment`, list it in
  `equipment/catalog.ts`, and (for a new category) add a model builder in `src/game/models.ts`.
- **Upgrades**: add to `upgrades.json`; effects are multipliers on named stats read by the sim.
- **Scenarios** (spec §54): add JSON in `src/data/scenarios` and register it in `scenario.ts`.
- **Crew orders**: add to `CrewOrderType`, give it a done condition, the machine category it needs
  and how it is issued in `management/crews.ts`.
- **Task types**: add to `TaskType`, give it an executor in `executors.ts` and a category in
  `TASK_CATEGORY`; validation, assignment, blocking and the UI come for free.
- **Save format**: bump `SAVE_VERSION` and add a step to `MIGRATIONS` in `save/save.ts`.
