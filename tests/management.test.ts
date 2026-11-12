/**
 * Support trucks and management: the lube truck refuels and greases machines where they stand,
 * the service truck takes the mechanic out to breakdowns, foremen run their crews from orders,
 * and the morning meeting reports on the day.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blackCreek, catalog, equipmentOf, runUntil } from "./helpers.js";
import * as cmd from "../src/sim/commands.js";
import { forceBreakdown } from "../src/sim/tasks/executors.js";
import { TERMINAL } from "../src/sim/tasks/service.js";
import { deserialize, serialize } from "../src/sim/save/save.js";
import { MineSimulation } from "../src/sim/simulation.js";
import { SAVE_VERSION } from "../src/sim/scenario.js";

test("the lube truck drives out, refuels and greases a machine where it stands", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  cmd.closeMeeting(sim);
  const ex = equipmentOf(ms, "hartmann_hx350");
  const lube = equipmentOf(ms, "ridgeline_lt9");
  const cap = sim.def(ex).fuelCapacityL;
  ex.fuelL = cap * 0.2;
  ex.hoursSinceGrease = 80;
  const cargo0 = lube.cargoFuelL;
  runUntil(ms, () => sim.state.tasks.some((t) => t.type === "FIELD_FUEL" && t.status === "COMPLETED"), 3 * 60);
  assert.ok(ex.fuelL > cap * 0.99, `excavator at ${ex.fuelL} of ${cap} L`);
  assert.equal(ex.hoursSinceGrease, 0);
  assert.ok(lube.cargoFuelL < cargo0 - cap * 0.7, "the diesel came out of the lube truck's tank");
  assert.equal(ex.serviceHold, null);
  // The excavator never drove to the fuel station.
  assert.ok(!sim.state.tasks.some((t) => t.type === "FUEL" && t.assignedEquipmentId === ex.id));
});

test("a breakdown sends the mechanic out in the service truck", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  cmd.closeMeeting(sim);
  const truck = equipmentOf(ms, "ridgeline_rh60", 1);
  const st = equipmentOf(ms, "ridgeline_st5");
  forceBreakdown(sim, truck);
  const call = sim.state.tasks.find((t) => t.type === "SERVICE_CALL" && t.destination?.kind === "equipment" && t.destination.id === truck.id);
  assert.ok(call, "a field repair was filed");
  runUntil(ms, () => call!.status === "COMPLETED", 24 * 60);
  assert.equal(call!.assignedEquipmentId, st.id);
  assert.equal(call!.assignedWorkerId, "emp-hank");
  assert.notEqual(truck.state, "BROKEN");
  assert.equal(truck.breakdown, null);
  assert.ok(Math.hypot(st.x - truck.x, st.z - truck.z) < 20, "the service truck is parked beside it");
});

test("the service truck does overdue preventive maintenance in the field", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  cmd.closeMeeting(sim);
  const dozer = equipmentOf(ms, "ironback_dz9");
  dozer.hoursSinceService = 300;
  const before = dozer.condition;
  runUntil(ms, () => dozer.hoursSinceService === 0, 12 * 60);
  assert.ok(dozer.condition > before);
  const call = sim.state.tasks.find((t) => t.type === "SERVICE_CALL" && t.params.service === "PM");
  assert.equal(call?.status, "COMPLETED");
  assert.ok(!sim.state.tasks.some((t) => t.type === "MAINTENANCE" && t.assignedEquipmentId === dozer.id), "it never went to the shop");
});

test("a foreman works an order with only the crew's machines and people", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const crew = sim.state.crews[0]!;
  // A truck the player bought but never put in the crew.
  sim.state.treasury.cash += 2_000_000;
  const spare = cmd.buyEquipment(sim, "ridgeline_rh60");
  assert.ok(spare.ok);
  if (!spare.ok) return;
  const r = cmd.addCrewOrder(sim, crew.id, "REMOVE_OVERBURDEN", "A2");
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  cmd.closeMeeting(sim);
  const ex = () => sim.state.tasks.find((t) => t.type === "EXCAVATE" && t.crewId === crew.id);
  runUntil(ms, () => (ex()?.materialAmount ?? 0) > 400, 24 * 60);
  const crewTasks = sim.state.tasks.filter((t) => t.crewId === crew.id);
  assert.ok(crewTasks.some((t) => t.type === "DRILL_PATTERN") && crewTasks.some((t) => t.type === "BLAST"), "the foreman drilled and blasted first");
  for (const t of crewTasks) {
    if (t.assignedEquipmentId) assert.ok(crew.equipmentIds.includes(t.assignedEquipmentId), `${t.label} on a machine outside the crew`);
    if (t.assignedWorkerId) assert.ok(crew.workerIds.includes(t.assignedWorkerId), `${t.label} staffed from outside the crew`);
  }
  assert.ok(!sim.state.tasks.some((t) => t.assignedEquipmentId === spare.value.id && !TERMINAL.has(t.status)));
  assert.equal(r.value.status, "ACTIVE");
});

test("orders the crew cannot do yet wait or report why", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const crew = sim.state.crews[0]!;
  const coal = cmd.addCrewOrder(sim, crew.id, "MINE_COAL", "A3");
  const roads = cmd.addCrewOrder(sim, crew.id, "MAINTAIN_ROADS");
  assert.ok(coal.ok && roads.ok);
  if (!coal.ok || !roads.ok) return;
  cmd.closeMeeting(sim);
  ms.advanceMinutes(5);
  assert.equal(coal.value.status, "PENDING");
  assert.match(coal.value.note ?? "", /overburden/);
  assert.equal(roads.value.status, "STUCK");
  assert.match(roads.value.note ?? "", /no grader/);
});

test("the morning meeting opens at each shift start with every crew's report", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  assert.equal(sim.state.meeting?.pending, true, "day 1 opens with a meeting");
  cmd.closeMeeting(sim);
  assert.equal(sim.state.meeting?.pending, false);
  runUntil(ms, () => sim.state.meeting?.pending === true, 26 * 60);
  const m = sim.state.meeting!;
  assert.equal(m.day, 2);
  assert.equal(sim.clock.hourOfDay, sim.state.shift.startHour);
  const pit = m.reports.find((x) => x.crewName === "Pit crew")!;
  assert.equal(pit.foremanName, "Loretta Caudill");
  assert.ok(pit.lines.some((l) => /No orders/.test(l.text)));
  cmd.setMorningMeeting(sim, false);
  cmd.closeMeeting(sim);
  ms.advanceMinutes(25 * 60);
  assert.equal(sim.state.meeting?.day, 2, "no meeting once they are turned off");
});

test("a version-2 save migrates to version 3 with no crews and no service holds", () => {
  const ms = blackCreek(3);
  const json = JSON.parse(serialize(ms.sim.sync(), "old", new Date(0)));
  const s = json.state;
  s.saveVersion = 2;
  delete s.crews;
  delete s.meeting;
  delete s.settings.morningMeeting;
  s.equipment = s.equipment.filter((e: { defId: string }) => e.defId !== "ridgeline_lt9" && e.defId !== "ridgeline_st5");
  for (const e of s.equipment) {
    delete e.serviceHold;
    delete e.cargoFuelL;
    delete e.hoursSinceGrease;
  }
  for (const t of s.tasks) delete t.crewId;
  const { state } = deserialize(JSON.stringify(json));
  assert.equal(state.saveVersion, SAVE_VERSION);
  assert.deepEqual(state.crews, []);
  assert.equal(state.meeting, null);
  assert.equal(state.settings.morningMeeting, true);
  assert.equal(state.equipment[0]!.serviceHold, null);
  const next = new MineSimulation(state, catalog);
  next.advanceMinutes(120);
});
