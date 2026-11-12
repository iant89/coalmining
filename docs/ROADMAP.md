# Roadmap and status

Status of the spec's development phases (§70) and success criteria (§84). "Slice" means the
system exists at the depth the first vertical slice needs; the spec's later depth is still owed.

## Phases

| Phase | Area | Status |
| --- | --- | --- |
| 01 | Engine integration, bootstrap, clock, scene, selection, camera, UI, save/load | **Done** — 5 s tick clock with speeds, Forge scene + day/night from the sim clock, picking, 4 camera modes, HUD/panels/dialogs, versioned saves (localStorage + file export/import, autosave) |
| 02 | Mine world, terrain chunks, roads, environment, map bounds | **Done (slice)** — 96×96 heightfield in 16-cell chunks with dirty rebuilds, road graph rasterised into the terrain, bounded camera |
| 03 | Geology, coal seam, overburden, materials, exploration, drilling | **Done (slice)** — layered geology with quality, true vs known geology, core holes with lab delay, blast-hole logging, legacy samples |
| 04 | Equipment, movement, state, fuel, wear, maintenance | **Done (slice)** — data-driven catalog (8 models), upgrades, lube trucks (field refuelling and greasing; grease interval affects wear) and service trucks (field repairs and preventive maintenance by the mechanic), routing over roads/off-road with grade/load/weather/operator effects, fuel, wear, breakdown hazard, service and repair |
| 05 | Workforce, skills, hiring, operators, fatigue | **Done (slice)** — 9 employees, skills, certifications with expiry, shifts, fatigue, payroll with burden, applicants, training. **Management:** foremen lead crews (machines + people) from prioritised orders (remove overburden, mine coal, strip topsoil, core-drill a block, keep roads graded), staff tasks only from their crew, follow them up on rounds paced by leadership, re-drill unbroken rock; a morning meeting at each shift start reports per crew and is where the player re-plans |
| 06 | Task architecture, queue, dependencies, assignment, dispatch, AI | **Done** — full lifecycle, validation with reasons, prerequisites, priorities, Role/Equipment/Movement AI layers, production-objective orders |
| 07 | Benches, blasting, overburden, coal exposure, extraction | **Done (slice)** — mining blocks with states, pattern design, abstract blast design (fragmentation, vibration/airblast/flyrock, coal damage), exclusion-zone clearance, top-down excavation, coal recovery |
| 08 | Haul roads, stockpiles, conveyors, routing | **Done (slice)** — data-driven construction projects (`src/data/construction.json`) built through tasks: haul roads built by a dozer that grades the alignment and joins the road graph; truck hoppers + overland conveyors (plug-flow belt, rated capacity, start-up, jams on a full stockpile, power cost, wear, breakdowns, mechanic repairs); player-built stockpiles; graders and an automatic road-maintenance objective; coal routing to a stockpile or hopper. Water trucks / dust not started (they belong with phase 14's dust) |
| 09 | Preparation plant | **Done (slice)** — a mothballed plant refurbished by contractors; feeder → crusher → screen → dense-medium separator as data-driven units (capacity, power, wear, breakdowns, mechanic repairs); two-component washability with a player-set cut density (yield vs ash, sulfur and heat value, mass/ash/sulfur balanced); a plant operator on shift; clean coal stockpile and a refuse pile that grows on the terrain; power and reagent costs; a truck loadout that ships sales at its rate and pays when loading ends. Thermal drying, fines circuits and blending are not modelled |
| 10 | Economy | **Partial** — treasury, ledger, daily reports, payroll, fuel, maintenance, explosives, royalties, overhead, three customers with quality specs and drifting prices. Contracts and loans not started |
| 11 | Land | **Partial** — one leased parcel with royalty, mineral-rights checks. Negotiation/acquisition not started |
| 12 | Permits | **Partial** — permits gate tasks by type and area, expire, and renew. Applications for new areas and reclamation bonds not started |
| 13 | Safety, certifications, inspections, violations, accidents | **Partial** — explainable risk per machine, condition-driven incidents with reports, certification checks. Inspections/violations (MSHA) not started |
| 14 | Environment | **Partial** — weather (Markov, effects on speed, roads, blasting, risk; clouds/fog/wetness drawn). Water, sediment, dust, reclamation not started |
| 15 | Campaign | **Started** — Chapter 1 objectives driven by simulation state, with hints |
| 16 | Advanced mining | Not started |
| 17 | Polish | Not started (procedural models stand in for authored GLBs; no audio or particles yet) |

## Success criteria (§84)

- [x] Load a mine
- [x] Inspect terrain (elevation, geology, mining and permit overlays; ground inspector)
- [x] Discover geology
- [x] Drill
- [x] Create a blast
- [x] Execute a blast
- [x] Remove overburden
- [x] Expose coal
- [x] Mine coal
- [x] Assign operators
- [x] Move haul trucks
- [x] Haul material
- [x] Build a haul road
- [x] Build a conveyor
- [x] Process coal
- [x] Sell coal
- [x] Buy equipment
- [x] Upgrade equipment
- [x] Hire employees
- [x] Maintain equipment
- [ ] Acquire land
- [~] Obtain permits (renewal only)
- [ ] Receive an inspection
- [ ] Receive violations
- [ ] Correct violations
- [x] Manage finances
- [ ] Reclaim land
- [x] Save and load the mine
- [ ] Complete the grandfather campaign

## Next steps, in the spec's priority order (§71)

1. Phase 10, economy: contracts with delivery schedules and quality bonuses (the loadout already
   ships against a customer), loans, weekly and monthly reports.
2. Simulation tiers (§58) once fleets grow: statistical simulation for distant/off-screen machines.
3. Player-placed dumps and pit ramps (construction is data-driven; these are new project types).
4. Regulation: inspector agent, rule-driven violations, fines, corrective actions.
5. Reclamation: backfill, grade, topsoil, seed — topsoil salvage is already tracked; refuse
   needs covering too.
6. Campaign chapters 2–10 on the objective system.

## Known limitations

- One preparation plant per mine, at a fixed site; no new plant can be built yet, and clean coal is
  one product (no blending to a customer's spec).
- Foremen do not yet plan blocks themselves (which block next) or ask to hire; the player gives
  every order. Crews share the support trucks, which are dispatched mine-wide.
- Haul roads are straight segments between two points; curves are built from several roads.
- Conveyors are single straight flights from one hopper to one stockpile (no transfer points yet).

- Pit access is not modelled: trucks drive straight over pit walls (slowed by grade).
- Workers are records, not walking characters.
- The blast exclusion zone stops machines whose current target lies inside it, not ones whose
  route merely crosses it.
- Balance is a first pass (one block near the outcrop pays well; deeper blocks are dearer).
