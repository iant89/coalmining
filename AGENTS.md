# AGENTS.md — working in this repository

Read `docs/ARCHITECTURE.md` first; the design brief is `docs/GAME_DESIGN_SPEC.md`, status is
`docs/ROADMAP.md`.

## Setup

The game builds against a sibling checkout of Forge-Engine (`../Forge-Engine`, or
`FORGE_ENGINE_DIR`). Install both: `(cd ../Forge-Engine && npm ci)` then `npm install` here. For
the browser gate, run `npm run setup` in Forge-Engine once (it provisions headless Chromium +
SwiftShader in `/tmp`).

## Before every commit

```sh
npm run verify          # lint:arch + typecheck (sim and game) + simulation tests
npm run check:browser   # real WebGPU: plays the slice through the UI; open tools/shot-*.png
```

`verify` cannot tell you whether anything is visible. For rendering or UI changes, run the browser
gate and look at the screenshots. SwiftShader draws about one frame a second: the gate waits in
frames, not milliseconds, and uses `?quality=low`.

## Rules that are load-bearing

- **The simulation is authoritative and engine-free.** Nothing in `src/sim` imports
  `@forge/engine`, `src/game`, DOM globals, `Math.random` or the wall clock (`npm run lint:arch`).
  All randomness comes from `sim.rng`; all time from `sim.clock`.
- **State is plain data in `SimState`.** If you add state, it must survive `serialize` →
  `deserialize`; if you change its shape, bump `SAVE_VERSION` and add a migration.
- **Player actions go through `src/sim/commands.ts`.** UI previews must not mutate state (pass a
  fixed id to `designPattern`/`designBlast`).
- **Every block reason is a sentence the player can act on.** Name the machine/person/block and
  what to do.
- **Executors spend a time budget.** Never assume one tick = one step; loop over phases until the
  budget is spent so results do not depend on `TICK_SECONDS`.
- **No coal-mining logic in Forge-Engine.** Engine changes are for genuine engine gaps or bugs,
  made in that repo with its own tests and its AGENTS.md rules (change-log, mnemosyne).
- **Inside an engine system pass, components you add are journaled.** `entity.get(Renderable)`
  right after `addComponent` returns undefined; keep references (`models.ts` → `renderableOf`).
  Create entities with `placed()`, not `scene.createTransformedEntity()`: a scale or rotation set in
  the same pass otherwise resets the position to the origin (fixed in Forge-Engine too).
- **Panels are patched, not replaced** (`ui/morph.ts`), so clicks land while numbers update.
- **Crew tasks carry `crewId`**: they are staffed only from that crew. Anything that creates tasks
  for a foreman must pass it; player commands leave it null.
- **A `serviceHold` pauses a machine's own task** while a lube or service truck works on it; it is
  released when that truck's task ends (`release` in `tasks/service.ts`).
- **The morning meeting pauses only the UI**: tests and headless runs keep ticking with it pending.
- Forge debug-line colours are `0xAARRGGBB`; alpha < 128 means emissive radiance.

## Tests

`tests/*.test.ts` run with `node --test` through tsx. Use `runUntil` (tick-granular) rather than
fixed waits; phases can start and finish inside one simulated minute.
