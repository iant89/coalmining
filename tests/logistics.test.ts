/**
 * Development phase 08 — logistics: haul-road construction, road maintenance, conveyors and coal
 * routing (spec §22–24, §63, §76 "Conveyor cannot exceed throughput capacity"), and the save
 * migration that introduced them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blackCreek, equipmentOf, runUntil, catalog } from "./helpers.js";
import * as cmd from "../src/sim/commands.js";
import { planRoute } from "../src/sim/logistics/navigation.js";
import { estimateRoad } from "../src/sim/logistics/construction.js";
import { addToHopper, transitMinutes } from "../src/sim/logistics/conveyors.js";
import { deserialize, serialize } from "../src/sim/save/save.js";
import { MineSimulation } from "../src/sim/simulation.js";
import { SAVE_VERSION } from "../src/sim/scenario.js";
import type { MineSimulation as MS } from "../src/sim/simulation.js";

const FROM = { x: 112, z: 108 };
const TO = { x: 80, z: 0 };

function travelMinutes(ms: MS, a: { x: number; z: number }, b: { x: number; z: number }): number {
  let t = 0;
  let x = a.x;
  let z = a.z;
  for (const w of planRoute(ms.sim, a.x, a.z, b.x, b.z)) {
    t += Math.hypot(w.x - x, w.z - z) / w.limit / 60;
    x = w.x;
    z = w.z;
  }
  return t;
}

/** Build the conveyor beside Block A4 into the ROM stockpile and wait for commissioning. */
function withConveyor(ms: MS, tph = 400) {
  const r = cmd.buildConveyor(ms.sim, { x: 158, z: 40 }, { x: 0, z: 0 }, tph, "rom-1");
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (!r.ok) throw new Error();
  runUntil(ms, () => r.value.project.status === "COMPLETE", 5 * 24 * 60);
  return { conveyor: ms.state.conveyors[0]!, hopper: ms.state.hoppers[0]! };
}

test("a dozer builds a haul road: paid as estimated, graded to the planned profile, and routing uses it", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const before = travelMinutes(ms, FROM, TO);
  const est = estimateRoad(sim, { from: FROM, to: TO });
  const cash = sim.state.treasury.cash;
  const r = cmd.buildRoad(sim, FROM, TO);
  assert.ok(r.ok);
  if (!r.ok) return;
  const p = r.value.project;
  // Nothing changes in the world until the road is finished.
  ms.advanceMinutes(30);
  assert.equal(sim.state.roadEdges.length, 6);
  assert.ok(p.progress > 0 && p.progress < 1);
  runUntil(ms, () => p.status === "COMPLETE", 2 * 24 * 60);
  assert.equal(sim.state.roadEdges.length, 7);
  assert.ok(Math.abs(p.spent - est.cost) < 1, `spent ${p.spent} vs estimate ${est.cost}`);
  assert.ok(cash - sim.state.treasury.cash >= est.cost, "the road was paid for");
  // The finished surface follows the straight profile between the ends.
  const t = sim.terrain;
  const len = Math.hypot(TO.x - FROM.x, TO.z - FROM.z);
  const h0 = p.startElevation!;
  const h1 = p.endElevation!;
  for (let k = 1; k < 20; k++) {
    const f = k / 20;
    const h = t.heightAt(FROM.x + (TO.x - FROM.x) * f, FROM.z + (TO.z - FROM.z) * f);
    assert.ok(Math.abs(h - (h0 + (h1 - h0) * f)) < 0.35, `profile off by ${(h - (h0 + (h1 - h0) * f)).toFixed(2)} m at ${(f * len).toFixed(0)} m`);
  }
  const after = travelMinutes(ms, FROM, TO);
  assert.ok(after < before * 0.7, `travel ${before.toFixed(2)} → ${after.toFixed(2)} min`);
  const route = planRoute(sim, FROM.x, FROM.z, TO.x, TO.z);
  assert.ok(route.some((w) => w.edgeId === sim.state.roadEdges[6]!.id), "the route runs on the new road");
  assert.equal(new Set(sim.state.roadEdges.map((e) => e.id)).size, 7, "road ids stay unique");
});

test("a grader restores a worn road, and idle graders take the worst road on their own", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  sim.state.treasury.cash += 1_000_000;
  const g = cmd.buyEquipment(sim, "ironback_gr14");
  assert.ok(g.ok);
  if (!g.ok) return;
  g.value.operatorId = "emp-dale";
  for (const e of sim.state.roadEdges) e.condition = 80;
  const worst = sim.state.roadEdges[3]!;
  worst.condition = 35;
  ms.advanceMinutes(61);
  const t = sim.state.tasks.find((x) => x.type === "GRADE_ROAD");
  assert.ok(t, "auto-grading dispatched the grader");
  assert.deepEqual(t!.destination, { kind: "road", id: worst.id });
  runUntil(ms, () => t!.status === "COMPLETED", 12 * 60);
  assert.ok(worst.condition >= 35 + 30, `condition ${worst.condition}`);
});

test("conveyor throughput never exceeds its rated capacity, and no coal is created or lost", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const { conveyor, hopper } = withConveyor(ms, 400);
  const rom = sim.stockpile("rom-1")!;
  hopper.capacityT = 1e9;
  let fed = 0;
  let maxPerTick = 0;
  const cap = (conveyor.capacityTph / 60) * sim.dt;
  for (let n = 0; n < 12 * 120; n++) {
    // Feed far faster than the belt can take.
    const r = addToHopper(hopper, { type: "COAL_RAW", tonnes: 20, quality: { ash: 12, sulfur: 1, moisture: 8, btu: 12000 } });
    fed += 20 - r;
    const before = rom.tonnes;
    ms.tick();
    maxPerTick = Math.max(maxPerTick, rom.tonnes - before);
  }
  assert.ok(maxPerTick <= cap + 1e-6, `delivered ${maxPerTick.toFixed(3)} t in a tick, capacity ${cap.toFixed(3)}`);
  assert.ok(maxPerTick > cap * 0.95, "and it does run at capacity when fed");
  assert.ok(Math.abs(fed - (hopper.tonnes + conveyor.beltT + rom.tonnes)) < 1e-3, "mass is conserved");
  assert.ok(transitMinutes(conveyor) > 0.3);
});

test("a full stockpile jams the belt instead of spilling, and it restarts when there is room", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const { conveyor, hopper } = withConveyor(ms);
  const rom = sim.stockpile("rom-1")!;
  rom.tonnes = rom.capacityT - 5;
  addToHopper(hopper, { type: "COAL_RAW", tonnes: 150, quality: null });
  ms.advanceMinutes(30);
  assert.equal(conveyor.state, "JAMMED");
  assert.ok(rom.tonnes <= rom.capacityT + 1e-6);
  rom.tonnes = 0;
  ms.advanceMinutes(30);
  // Unjammed, it delivers the backlog and then stops itself once the belt and hopper are empty.
  assert.notEqual(conveyor.state, "JAMMED");
  assert.ok(Math.abs(conveyor.totalT - 150) < 1e-6, `delivered ${conveyor.totalT}`);
  assert.ok(conveyor.beltT < 1e-6 && hopper.tonnes < 1e-6);
});

test("coal orders route trucks to a hopper, and trucks wait for space rather than block", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const { hopper } = withConveyor(ms);
  assert.ok(cmd.setCoalDestination(sim, hopper.id).ok);
  // Uncover A2's coal so the test is about routing.
  const b = sim.block("A2")!;
  const t = sim.terrain;
  for (let j = b.rect.j0; j <= b.rect.j1; j++) for (let i = b.rect.i0; i <= b.rect.i1; i++) {
    const k = t.index(i, j);
    t.state.surface[k] = Math.min(t.state.surface[k]!, sim.state.geology.seamTop[k]!);
  }
  const r = cmd.orderBlockWork(sim, "A2", "COAL");
  assert.ok(r.ok);
  if (!r.ok) return;
  const hauls = r.value.filter((x) => x.type === "HAUL");
  assert.ok(hauls.every((h) => h.params.coalHopperId === hopper.id));
  let waited = false;
  runUntil(ms, () => {
    if (hauls.some((h) => /Waiting for space/.test(h.note ?? ""))) waited = true;
    return b.state === "COMPLETE";
  }, 3 * 24 * 60);
  assert.ok(waited, "trucks queued at the full hopper");
  // The block is done when the last bucket is loaded; the last trucks still have to tip.
  runUntil(ms, () => hauls.every((h) => h.status === "COMPLETED"), 2 * 60);
  ms.advanceMinutes(30);
  const onTrucks = sim.state.equipment.reduce((a, e) => a + (e.payload?.tonnes ?? 0), 0);
  const rom = sim.stockpile("rom-1")!.tonnes;
  assert.ok(Math.abs(rom + onTrucks + hopper.tonnes - b.coalMinedT) < 1e-6, `mined ${b.coalMinedT} = stockpile ${rom} + trucks ${onTrucks} + hopper ${hopper.tonnes}`);
  assert.ok(rom > b.coalMinedT - 2, "all but a final part-bucket reached the stockpile through the belt");
});

test("a broken conveyor needs a mechanic; repair puts it back in service", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const { conveyor } = withConveyor(ms);
  conveyor.condition = 20;
  conveyor.state = "DAMAGED";
  conveyor.breakdown = { cause: "test", minute: sim.minute };
  const r = cmd.repairConveyorTask(sim, conveyor.id);
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  runUntil(ms, () => r.value.status === "COMPLETED", 24 * 60);
  assert.equal(r.value.assignedWorkerId, "emp-hank");
  assert.notEqual(conveyor.state, "DAMAGED");
  assert.ok(conveyor.condition >= 55);
});

test("a version-1 save migrates to the current format and keeps playing", () => {
  const ms = blackCreek(5);
  equipmentOf(ms, "ridgeline_rh60");
  const json = JSON.parse(serialize(ms.sim.sync(), "old", new Date(0)));
  json.state.saveVersion = 1;
  delete json.state.projects;
  delete json.state.hoppers;
  delete json.state.conveyors;
  delete json.state.settings.autoGrade;
  delete json.state.settings.coalDestination;
  const { state } = deserialize(JSON.stringify(json));
  assert.equal(state.saveVersion, SAVE_VERSION);
  assert.deepEqual(state.projects, []);
  assert.deepEqual(state.conveyors, []);
  assert.equal(state.settings.coalDestination, null);
  const next = new MineSimulation(state, catalog);
  next.advanceMinutes(60);
  assert.ok(cmd.buildStockpile(next.sim, { x: -120, z: -60 }, 5000).ok);
});
