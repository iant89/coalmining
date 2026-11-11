# Roadmap and status

Status of the spec's development phases (§70) and success criteria (§84). "Slice" means the
system exists at the depth the first vertical slice needs; the spec's later depth is still owed.

## Phases

| Phase | Area | Status |
| --- | --- | --- |
| 01 | Engine integration, bootstrap, clock, scene, selection, camera, UI, save/load | **Done** — 5 s tick clock with speeds, Forge scene + day/night from the sim clock, picking, 4 camera modes, HUD/panels/dialogs, versioned saves (localStorage + file export/import, autosave) |
| 02 | Mine world, terrain chunks, roads, environment, map bounds | **Done (slice)** — 96×96 heightfield in 16-cell chunks with dirty rebuilds, road graph rasterised into the terrain, bounded camera |
| 03 | Geology, coal seam, overburden, materials, exploration, drilling | **Done (slice)** — layered geology with quality, true vs known geology, core holes with lab delay, blast-hole logging, legacy samples |
| 04 | Equipment, movement, state, fuel, wear, maintenance | **Done (slice)** — data-driven catalog (5 models), upgrades, routing over roads/off-road with grade/load/weather/operator effects, fuel, wear, breakdown hazard, service and repair |
| 05 | Workforce, skills, hiring, operators, fatigue | **Done (slice)** — 8 employees, skills, certifications with expiry, shifts, fatigue, payroll with burden, applicants, training |
| 06 | Task architecture, queue, dependencies, assignment, dispatch, AI | **Done** — full lifecycle, validation with reasons, prerequisites, priorities, Role/Equipment/Movement AI layers, production-objective orders |
| 07 | Benches, blasting, overburden, coal exposure, extraction | **Done (slice)** — mining blocks with states, pattern design, abstract blast design (fragmentation, vibration/airblast/flyrock, coal damage), exclusion-zone clearance, top-down excavation, coal recovery |
| 08 | Haul roads, stockpiles, conveyors, routing | **Partial** — roads (condition, traffic and rain wear), dumps, ROM stockpile, truck queuing. Conveyors not started; graders/water trucks not started |
| 09 | Preparation plant | Not started — raw coal is sold from the ROM stockpile |
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
- [ ] Build a haul road
- [ ] Build a conveyor
- [ ] Process coal (raw coal only)
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

1. Construction as tasks (§63): haul roads first (graders, road condition upkeep), then dumps and
   stockpiles placed by the player; the navigation graph already re-plans per trip.
2. Simulation tiers (§58) once fleets grow: statistical simulation for distant/off-screen machines.
3. Logistics: conveyors as a directed graph with throughput limits (and the spec's conveyor test).
4. Economy: contracts with delivery schedules, loans.
5. Regulation: inspector agent, rule-driven violations, fines, corrective actions.
6. Reclamation: backfill, grade, topsoil, seed — topsoil salvage is already tracked.
7. Campaign chapters 2–10 on the objective system.

## Known limitations

- Pit access is not modelled: trucks drive straight over pit walls (slowed by grade).
- Workers are records, not walking characters.
- The blast exclusion zone stops machines whose current target lies inside it, not ones whose
  route merely crosses it.
- Balance is a first pass (one block near the outcrop pays well; deeper blocks are dearer).
