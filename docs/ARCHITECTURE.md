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
roads → blast-zone clearance → tasks (which drive equipment, mining and logistics) → per-minute
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
  instead of looking them up (`models.ts`).

## Extending

- **Equipment** (spec §52, §79): add a JSON file in `src/data/equipment`, list it in
  `equipment/catalog.ts`, and (for a new category) add a model builder in `src/game/models.ts`.
- **Upgrades**: add to `upgrades.json`; effects are multipliers on named stats read by the sim.
- **Scenarios** (spec §54): add JSON in `src/data/scenarios` and register it in `scenario.ts`.
- **Task types**: add to `TaskType`, give it an executor in `executors.ts` and a category in
  `TASK_CATEGORY`; validation, assignment, blocking and the UI come for free.
- **Save format**: bump `SAVE_VERSION` and add a step to `MIGRATIONS` in `save/save.ts`.
