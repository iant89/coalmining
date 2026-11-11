/**
 * Geology, exploration, drilling, blasting, excavation and material accounting (spec §12–20).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blackCreek, equipmentOf, runUntil } from "./helpers.js";
import { estimateAt } from "../src/sim/world/geology.js";
import { recordCoreSample } from "../src/sim/mining/exploration.js";
import { analyzeBlock } from "../src/sim/mining/blocks.js";
import { orderBlockWork, planBlast, planDrillPattern } from "../src/sim/commands.js";
import { executeBlast } from "../src/sim/mining/blasting.js";
import { completeHole } from "../src/sim/mining/drilling.js";
import { digBucket } from "../src/sim/mining/excavation.js";
import { createTask } from "../src/sim/tasks/service.js";

test("the player never starts with perfect geology: far from any hole the seam is UNKNOWN", () => {
  const ms = blackCreek();
  const e = estimateAt(ms.state.samples, -150, -150);
  assert.equal(e.state, "UNKNOWN");
  assert.equal(e.seamTopElevation, null);
});

test("a core hole measures the true seam where it is drilled and raises confidence nearby", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const before = estimateAt(sim.state.samples, 60, -100);
  const s = recordCoreSample(sim, 60, -100, 40);
  const t = sim.terrain;
  const { i, j } = t.cellOf(60, -100);
  const k = t.index(i, j);
  assert.ok(s.seamDepth !== null);
  assert.ok(Math.abs(s.seamDepth! - (t.state.surface[k]! - sim.state.geology.seamTop[k]!)) < 1e-4);
  const after = estimateAt(sim.state.samples, 60, -100);
  assert.ok(after.confidence > before.confidence);
  assert.ok(Math.abs(after.seamTopElevation! - sim.state.geology.seamTop[k]!) < 0.05);
  // Quality arrives from the lab later.
  assert.equal(s.quality, null);
  ms.advanceMinutes(8 * 60 + 1);
  const q = s.quality as { ash: number } | null;
  assert.ok(q && q.ash > 0);
});

test("unblasted rock blocks excavation with an explanation", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const r = createTask(sim, { type: "EXCAVATE", destination: { kind: "block", id: "A2" }, params: { mode: "OVERBURDEN" } });
  assert.ok(r.ok);
  if (!r.ok) return;
  createTask(sim, { type: "HAUL", source: { kind: "task", id: r.task.id } });
  runUntil(ms, () => r.task.status === "BLOCKED" && /unblasted rock/.test(r.task.blockedReason ?? ""), 8 * 60);
  assert.match(r.task.blockedReason!, /Drill and blast/);
});

test("drill-to-coal protects the seam; overdrilled fixed-depth holes damage coal", () => {
  const run = (mode: "TO_COAL" | "FIXED") => {
    const ms = blackCreek();
    const sim = ms.sim;
    const block = sim.block("A2")!;
    const pr = planDrillPattern(sim, "A2", { spacing: 6, burden: 6, depthMode: mode, depth: mode === "FIXED" ? 6 : 14, subdrill: 0.6 });
    assert.ok(pr.ok);
    if (!pr.ok) throw new Error();
    for (const h of pr.value.pattern.holes) completeHole(sim, pr.value.pattern, h);
    pr.value.pattern.completedAt = sim.minute;
    const b = planBlast(sim, "A2", 1);
    assert.ok(b.ok);
    if (!b.ok) throw new Error();
    executeBlast(sim, b.value, pr.value.pattern, block);
    let damage = 0;
    const g = sim.state.geology;
    for (let jj = block.rect.j0; jj <= block.rect.j1; jj++) for (let ii = block.rect.i0; ii <= block.rect.i1; ii++) damage += g.coalDamage[sim.terrain.index(ii, jj)]!;
    return { damage, unblasted: analyzeBlock(sim, block).unblastedRockT };
  };
  const toCoal = run("TO_COAL");
  const fixed = run("FIXED");
  assert.equal(toCoal.damage, 0);
  assert.ok(toCoal.unblasted < 1, `to-coal left ${toCoal.unblasted} t unblasted`);
  assert.ok(fixed.damage > 1, `fixed-depth damage ${fixed.damage}`);
});

test("excavation conserves mass: tonnes dug equal tonnes placed plus tonnes on trucks", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const r = orderBlockWork(sim, "A2", "OVERBURDEN");
  assert.ok(r.ok);
  if (!r.ok) return;
  const ex = r.value.find((t) => t.type === "EXCAVATE")!;
  runUntil(ms, () => ex.materialAmount > 1500, 20 * 60);
  const onTrucks = sim.state.equipment.reduce((s, e) => s + (e.payload?.tonnes ?? 0), 0);
  const placed = sim.state.dumps.reduce((s, d) => s + d.tonnes, 0);
  assert.ok(Math.abs(ex.materialAmount - placed - onTrucks) < 0.5, `dug ${ex.materialAmount} placed ${placed} on trucks ${onTrucks}`);
});

test("coal mining: recovery is below 100% and raw coal reaches the ROM stockpile with its quality", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const block = sim.block("A2")!;
  // Strip the block instantly (debug shortcut) so the test is about coal handling.
  const t = sim.terrain;
  const g = sim.state.geology;
  for (let j = block.rect.j0; j <= block.rect.j1; j++) {
    for (let i = block.rect.i0; i <= block.rect.i1; i++) {
      const k = t.index(i, j);
      t.state.surface[k] = Math.min(t.state.surface[k]!, g.seamTop[k]!);
    }
  }
  const inSitu = analyzeBlock(sim, block).coalT;
  const r = orderBlockWork(sim, "A2", "COAL");
  assert.ok(r.ok);
  if (!r.ok) return;
  runUntil(ms, () => block.state === "COMPLETE", 3 * 24 * 60);
  const rom = sim.stockpile("rom-1")!;
  assert.ok(rom.tonnes > inSitu * 0.85 && rom.tonnes < inSitu, `rom ${rom.tonnes} of ${inSitu}`);
  assert.ok(rom.quality && rom.quality.btu > 10000);
  assert.ok(block.coalLostT > 0);
});

test("buckets dig top-down and never dig coal in overburden mode", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const block = sim.block("A3")!;
  // Fragment everything so only the layer rules matter.
  for (let k = 0; k < sim.terrain.state.looseFloor.length; k++) sim.terrain.state.looseFloor[k] = -1e9;
  let coal = 0;
  for (let n = 0; n < 4000; n++) {
    const out = digBucket(sim, block, "OVERBURDEN", 6);
    if (out.kind !== "ok") break;
    if (out.parcel.type === "COAL_RAW") coal += out.parcel.tonnes;
  }
  assert.equal(coal, 0);
  const a = analyzeBlock(sim, block);
  assert.ok(a.overburdenT < 1);
  assert.ok(a.coalT > 100);
});

test("blast clearance moves equipment out of the exclusion zone before firing", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const truck = equipmentOf(ms, "ridgeline_rh60");
  truck.x = 136;
  truck.z = -20;
  const r = orderBlockWork(sim, "A2", "OVERBURDEN", { truckIds: [] });
  assert.ok(r.ok);
  if (!r.ok) return;
  const blast = r.value.find((t) => t.type === "BLAST")!;
  runUntil(ms, () => blast.phase === "clear" || blast.status === "COMPLETED", 16 * 60);
  runUntil(ms, () => blast.status === "COMPLETED", 3 * 60);
  const c = { x: 136, z: -24 };
  assert.ok(Math.hypot(truck.x - c.x, truck.z - c.z) >= 90, `truck at ${Math.hypot(truck.x - c.x, truck.z - c.z)} m`);
  assert.equal(truck.evacuating, false);
});
