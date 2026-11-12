/**
 * Development phase 09 — the preparation plant (spec §25) and the loadout: washability balances,
 * the plant runs only when it can, breaks down and is repaired, washed coal opens better markets,
 * and sales are loaded out at the loadout's rate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blackCreek, catalog, runUntil } from "./helpers.js";
import * as cmd from "../src/sim/commands.js";
import { forcePlantBreakdown, plantCapacityTph, PLANT, wash } from "../src/sim/processing/plant.js";
import { quoteSale } from "../src/sim/economy/market.js";
import { deserialize, serialize } from "../src/sim/save/save.js";
import { MineSimulation } from "../src/sim/simulation.js";
import { SAVE_VERSION } from "../src/sim/scenario.js";
import type { MineSimulation as MS } from "../src/sim/simulation.js";

const RAW_A = { ash: 14.5, sulfur: 1.5, moisture: 9, btu: 11950 };

/**
 * Advance, undoing any random plant breakdown as it happens: for tests that are not about
 * breakdowns (one in roughly a hundred running hours would otherwise make them seed-dependent).
 */
function runSteady(ms: MS, minutes: number, until?: () => boolean): void {
  const p = ms.state.plant!;
  for (let n = 0; n < minutes * 12 && !(until?.()); n++) {
    ms.tick();
    if (p.units.some((u) => u.breakdown)) {
      for (const u of p.units) u.breakdown = null;
      p.status = "OFF";
    }
  }
  if (until) assert.ok(until(), `condition not met within ${minutes} simulated minutes`);
}

/** A refurbished plant with a plant operator and 3,000 t of raw coal on the ROM pile. */
function readyPlant(ms: MS, rawT = 3000) {
  const sim = ms.sim;
  cmd.closeMeeting(sim);
  const p = sim.state.plant!;
  for (const u of p.units) u.condition = PLANT.refurbish.condition;
  p.status = "OFF";
  const cand = sim.state.candidates.find((c) => c.role === "PLANT_OPERATOR")!;
  const hired = cmd.hireCandidate(sim, cand.id);
  assert.ok(hired.ok);
  if (!hired.ok) throw new Error();
  assert.ok(cmd.setPlantOperator(sim, hired.value.id).ok);
  const rom = sim.stockpile("rom-1")!;
  rom.tonnes = rawT;
  rom.quality = { ...RAW_A };
  return { p, rom, clean: sim.stockpile("clean-1")!, refuse: sim.dump("dump-refuse")!, operator: hired.value };
}

test("washing balances mass, ash and sulfur, and a lower cut makes cleaner coal at a lower yield", () => {
  for (const cut of [1.35, 1.45, 1.55, 1.7, 1.9]) {
    const r = wash(RAW_A, cut, 0.92);
    const y = r.yield;
    assert.ok(y > 0.7 && y < 1, `yield ${y} at ${cut}`);
    assert.ok(Math.abs(y * r.clean.ash + (1 - y) * r.refuse.ash - RAW_A.ash) < 1e-9, "ash balances");
    assert.ok(Math.abs(y * r.clean.sulfur + (1 - y) * r.refuse.sulfur - RAW_A.sulfur) < 1e-9, "sulfur balances");
    assert.ok(r.clean.ash < RAW_A.ash && r.clean.btu > RAW_A.btu);
  }
  const tight = wash(RAW_A, 1.4, 0.92);
  const loose = wash(RAW_A, 1.8, 0.92);
  assert.ok(tight.clean.ash < loose.clean.ash && tight.yield < loose.yield);
  // A worn separator misplaces rock into the product.
  assert.ok(wash(RAW_A, 1.55, 0.75).clean.ash > wash(RAW_A, 1.55, 0.95).clean.ash);
});

test("the mothballed plant must be refurbished by contractors before it can run", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  cmd.closeMeeting(sim);
  const p = sim.state.plant!;
  assert.equal(p.status, "MOTHBALLED");
  assert.ok(!cmd.setPlantEnabled(sim, true).ok);
  const r = cmd.refurbishPlant(sim);
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.equal(p.status, "REFURBISHING");
  runUntil(ms, () => r.value.status === "COMPLETE", 6 * 24 * 60);
  assert.equal(p.status, "OFF");
  assert.ok(p.units.every((u) => u.condition >= PLANT.refurbish.condition));
  assert.ok(Math.abs(r.value.spent - PLANT.refurbish.cost) < 1);
  assert.ok(cmd.setPlantEnabled(sim, true).ok);
});

test("the plant washes raw coal into clean coal and refuse, never above its capacity", () => {
  const ms = blackCreek(2);
  const sim = ms.sim;
  const { p, rom, clean, refuse } = readyPlant(ms);
  const refuse0 = refuse.tonnes;
  assert.ok(cmd.setPlantSettings(sim, { feedRateTph: 400, cutDensity: 1.5 }).ok);
  assert.ok(cmd.setPlantEnabled(sim, true).ok);
  runSteady(ms, 2 * 60);
  assert.equal(p.status, "RUNNING");
  const fed = 3000 - rom.tonnes;
  // 15 minutes of start-up, then at most the slowest unit's capacity.
  assert.ok(fed > 0 && fed <= plantCapacityTph(p) * (105 / 60) + 1e-6, `fed ${fed} t`);
  assert.ok(Math.abs(fed - clean.tonnes - (refuse.tonnes - refuse0)) < 1e-6, "feed = clean + refuse");
  assert.ok(Math.abs(fed - p.totalFeedT) < 1e-6 && Math.abs(sim.state.today.cleanCoalT - clean.tonnes) < 1e-6);
  assert.ok(clean.quality!.ash < RAW_A.ash - 3, `clean ash ${clean.quality!.ash}`);
  assert.ok(p.lastYield! > 0.75 && p.lastYield! < 0.97);
});

test("the plant stops with a reason when it has no operator on shift, no feed or no room", () => {
  const ms = blackCreek(3);
  const sim = ms.sim;
  const { p, rom, clean, operator } = readyPlant(ms, 200);
  cmd.setPlantEnabled(sim, true);
  cmd.setPlantOperator(sim, null);
  runSteady(ms, 5);
  assert.equal(p.status, "STOPPED");
  assert.match(p.stopReason!, /plant operator/);
  cmd.setPlantOperator(sim, operator.id);
  clean.tonnes = clean.capacityT;
  runSteady(ms, 5);
  assert.match(p.stopReason!, /full/);
  clean.tonnes = 0;
  runSteady(ms, 3 * 60, () => rom.tonnes < 1);
  runSteady(ms, 2);
  assert.equal(p.status, "STOPPED");
  assert.match(p.stopReason!, /empty/);
  // Night: the day-shift operator goes home and the plant stops.
  rom.tonnes = 3000;
  rom.quality = { ...RAW_A };
  runSteady(ms, 24 * 60, () => sim.clock.hourOfDay >= 18.5);
  assert.match(p.stopReason!, /off shift/);
});

test("a plant breakdown stops it until the mechanic repairs it", () => {
  const ms = blackCreek(4);
  const sim = ms.sim;
  const { p } = readyPlant(ms);
  cmd.setPlantEnabled(sim, true);
  runSteady(ms, 30);
  forcePlantBreakdown(sim, "SEPARATOR");
  ms.advanceMinutes(1);
  assert.equal(p.status, "BROKEN");
  assert.match(p.stopReason!, /mechanic/);
  const repair = sim.state.tasks.find((t) => t.type === "REPAIR" && t.destination?.kind === "plant");
  assert.ok(repair, "auto-maintenance filed a repair");
  runUntil(ms, () => repair!.status === "COMPLETED", 12 * 60);
  assert.equal(repair!.assignedWorkerId, "emp-hank");
  assert.ok(p.units.every((u) => !u.breakdown));
  runUntil(ms, () => p.status === "RUNNING", 60);
});

test("washed coal meets a buyer's spec that raw coal does not", () => {
  const ms = blackCreek(5);
  const sim = ms.sim;
  const { clean, rom } = readyPlant(ms);
  const industrial = sim.customer("cust-industrial")!;
  assert.ok(quoteSale(sim, industrial, rom, 500).problems.some((x) => /Ash/.test(x)));
  cmd.setPlantSettings(sim, { cutDensity: 1.5 });
  cmd.setPlantEnabled(sim, true);
  runSteady(ms, 4 * 60, () => clean.tonnes > 600);
  const q = quoteSale(sim, industrial, clean, 500);
  assert.deepEqual(q.problems, []);
  assert.ok(q.pricePerT > quoteSale(sim, sim.customer("cust-power")!, rom, 500).pricePerT);
});

test("the loadout ships sales at its rate, and a stockpile that runs dry ships short", () => {
  const ms = blackCreek(6);
  const sim = ms.sim;
  cmd.closeMeeting(sim);
  const rom = sim.stockpile("rom-1")!;
  rom.tonnes = 1500;
  rom.quality = { ash: 14, sulfur: 1.4, moisture: 8, btu: 12000 };
  const power = sim.customer("cust-power")!;
  assert.ok(cmd.sell(sim, power.id, rom.id, 1000).ok);
  const lo = sim.state.loadout!;
  ms.advanceMinutes(60);
  assert.ok(Math.abs(lo.shipments[0]!.loadedT - lo.rateTph) < 1e-6, "one hour at the loadout rate");
  runUntil(ms, () => lo.shipments.length === 0, 3 * 60);
  assert.equal(sim.state.today.coalSoldT, 1000);
  // Sell the rest, then lose most of the pile before it loads.
  assert.ok(cmd.sell(sim, power.id, rom.id, 500).ok);
  rom.tonnes = 100;
  runUntil(ms, () => lo.shipments.length === 0, 60);
  assert.ok(Math.abs(sim.state.today.coalSoldT - 1100) < 1e-6);
  assert.ok(sim.state.notifications.some((n) => /short/.test(n.title)));
});

test("a version-3 save migrates to version 4 without a plant and keeps instant sales", () => {
  const ms = blackCreek(7);
  const json = JSON.parse(serialize(ms.sim.sync(), "old", new Date(0)));
  const s = json.state;
  s.saveVersion = 3;
  delete s.plant;
  delete s.loadout;
  for (const d of [s.today, ...s.history]) {
    delete d.plantFeedT;
    delete d.cleanCoalT;
    delete d.refuseT;
  }
  const { state } = deserialize(JSON.stringify(json));
  assert.equal(state.saveVersion, SAVE_VERSION);
  assert.equal(state.plant, null);
  assert.equal(state.loadout, null);
  assert.equal(state.today.cleanCoalT, 0);
  const next = new MineSimulation(state, catalog);
  const rom = next.sim.stockpile("rom-1")!;
  rom.tonnes = 800;
  rom.quality = { ash: 14, sulfur: 1.4, moisture: 8, btu: 12000 };
  assert.ok(cmd.sell(next.sim, "cust-power", "rom-1", 500).ok);
  assert.equal(rom.tonnes, 300);
  next.advanceMinutes(60);
});
