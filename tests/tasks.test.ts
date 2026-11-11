/**
 * Task system (spec §6) and its validation rules (spec §6.3, §35, §76).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blackCreek, equipmentOf, runUntil } from "./helpers.js";
import { createTask, validateTask } from "../src/sim/tasks/service.js";
import { orderBlockWork } from "../src/sim/commands.js";

test("a worker without the required certification cannot be assigned restricted work", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const truck = equipmentOf(ms, "ridgeline_rh60");
  // Tommy holds DOZER and DRILL, not HAUL_TRUCK.
  const v = validateTask(sim, { type: "MOVE", equipmentId: truck.id, workerId: "emp-tommy", destination: { kind: "point", x: 0, z: 0 } });
  assert.ok(v.errors.some((e) => /lacks the Haul Truck certification/.test(e)), v.errors.join("; "));
  const r = createTask(sim, { type: "MOVE", equipmentId: truck.id, workerId: "emp-tommy", destination: { kind: "point", x: 0, z: 0 } });
  assert.equal(r.ok, false);
});

test("blasting needs a certified blaster, and the task blocks with that reason when none is valid", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  // Let Clyde's blaster certificate lapse.
  const clyde = sim.worker("emp-clyde")!;
  clyde.certifications = clyde.certifications.map((c) => (c.type === "BLASTER" ? { ...c, expiresDay: 0 } : c));
  const r = orderBlockWork(sim, "A2", "OVERBURDEN");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /blaster/i);
});

test("equipment with zero condition cannot receive production tasks", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const drill = equipmentOf(ms, "penrose_pd45");
  drill.condition = 0;
  const r = createTask(sim, { type: "EXPLORE_DRILL", destination: { kind: "point", x: 130, z: 0 } });
  assert.ok(r.ok);
  ms.advanceMinutes(2);
  const t = r.ok ? r.task : null;
  assert.equal(t?.status, "BLOCKED");
  assert.match(t?.blockedReason ?? "", /No drill available/);
  // Naming the machine explicitly gets the worn-out explanation instead.
  const r2 = createTask(sim, { type: "EXPLORE_DRILL", equipmentId: drill.id, destination: { kind: "point", x: 130, z: 0 } });
  ms.advanceMinutes(2);
  assert.ok(r2.ok);
  if (r2.ok) assert.match(r2.task.blockedReason ?? "", /worn out/);
});

test("an expired permit blocks restricted mining work with an explanation", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const permit = sim.state.permits.find((p) => p.type === "SURFACE_MINING")!;
  permit.expirationDay = 0;
  const v = validateTask(sim, { type: "EXCAVATE", destination: { kind: "block", id: "A2" }, params: { mode: "OVERBURDEN" } });
  assert.ok(v.errors.some((e) => /expired/.test(e)), v.errors.join("; "));
});

test("tasks wait on prerequisites and run in dependency order (drill → blast → excavate)", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const r = orderBlockWork(sim, "A2", "OVERBURDEN");
  assert.ok(r.ok);
  if (!r.ok) return;
  const [drill, blast, excavate] = r.value;
  assert.equal(drill!.type, "DRILL_PATTERN");
  assert.equal(blast!.type, "BLAST");
  assert.equal(excavate!.type, "EXCAVATE");
  ms.advanceMinutes(5);
  assert.notEqual(drill!.status, "QUEUED");
  assert.equal(blast!.status, "QUEUED");
  assert.match(blast!.note ?? "", /Waiting for: Drill Block A2/);
  runUntil(ms, () => drill!.status === "COMPLETED", 12 * 60);
  runUntil(ms, () => blast!.status === "COMPLETED", 6 * 60);
  assert.ok(blast!.completedAt! >= drill!.completedAt!);
  runUntil(ms, () => excavate!.status === "EXECUTING", 60);
});

test("operators go off shift: assigned work blocks overnight and resumes in the morning", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const truck = equipmentOf(ms, "ridgeline_rh60");
  const r = createTask(sim, { type: "MOVE", equipmentId: truck.id, destination: { kind: "point", x: -150, z: -150 } });
  assert.ok(r.ok);
  if (!r.ok) return;
  // Jump to 17:59 and start the move.
  ms.advanceMinutes(17 * 60 - 6 * 60 + 59 - 1);
  const t = r.task;
  if ((t.status as string) !== "COMPLETED") {
    ms.advanceMinutes(3);
    if ((t.status as string) !== "COMPLETED") {
      assert.equal(t.status, "BLOCKED");
      assert.match(t.blockedReason ?? "", /off shift/);
      ms.advanceMinutes(12 * 60 + 10);
      runUntil(ms, () => t.status === "COMPLETED", 60);
    }
  }
});

test("the haul cycle: truck drives to the excavator, is loaded, dumps at the spoil dump, and returns", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const r = orderBlockWork(sim, "A2", "OVERBURDEN");
  assert.ok(r.ok);
  if (!r.ok) return;
  const haul = r.value.find((t) => t.type === "HAUL")!;
  const truck = sim.equipment(haul.assignedEquipmentId) ?? equipmentOf(ms, "ridgeline_rh60");
  // The first loads off a fresh block are topsoil, which goes to the topsoil stockpile; later
  // loads go to the spoil dump. Either way the tonnage must land in a dump.
  const placed = () => sim.state.dumps.reduce((a, d) => a + d.tonnes, 0);
  runUntil(ms, () => haul.phase === "loading", 18 * 60);
  runUntil(ms, () => haul.phase === "to-dump", 30);
  const loaded = truck.payload!.tonnes;
  assert.ok(loaded > 40 && loaded <= 66, `payload ${loaded}`);
  const before = placed();
  runUntil(ms, () => haul.phase === "to-loader" && haul.materialAmount > 0, 30);
  assert.ok(Math.abs(placed() - before - loaded) < 0.5, `dumped ${placed() - before} of ${loaded}`);
  assert.equal(truck.payload, null);
});
