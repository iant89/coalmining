/**
 * Clock, hauling physics, equipment wear, economy, save/load and determinism (spec §5, §9, §21,
 * §26–27, §55, §76).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blackCreek, digest, equipmentOf, runUntil } from "./helpers.js";
import { SimClock, TICK_SECONDS } from "../src/sim/core/clock.js";
import { createTask } from "../src/sim/tasks/service.js";
import { orderBlockWork, sell, buyEquipment, buyUpgrade } from "../src/sim/commands.js";
import { deserialize, serialize } from "../src/sim/save/save.js";
import { MineSimulation } from "../src/sim/simulation.js";
import { catalog } from "./helpers.js";
import { runEngine, payloadCapacity } from "../src/sim/equipment/operation.js";
import { equipmentRisk } from "../src/sim/regulatory/safety.js";
import { quoteSale } from "../src/sim/economy/market.js";

test("the clock converts real time to whole ticks and carries the remainder", () => {
  const c = SimClock.create(6);
  c.setSpeed(1);
  let ticks = 0;
  for (let f = 0; f < 40; f++) ticks += c.ticksFor(0.25);
  // 10 real seconds at 1x = 10 simulated seconds.
  assert.equal(ticks, Math.floor(10 / TICK_SECONDS));
  c.setSpeed(50);
  assert.equal(c.ticksFor(1), (50 / TICK_SECONDS) | 0);
  c.setSpeed(0);
  assert.equal(c.ticksFor(5), 0);
});

test("a truck hauling 100 t over a 1 km road arrives with 100 t", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  sim.state.treasury.cash += 2_000_000;
  const bought = buyEquipment(sim, "ridgeline_rh90");
  assert.ok(bought.ok);
  if (!bought.ok) return;
  const t = bought.value;
  t.operatorId = "emp-wanda";
  t.payload = { type: "OVERBURDEN", tonnes: 100, quality: null };
  const r = createTask(sim, { type: "MOVE", equipmentId: t.id, destination: { kind: "point", x: t.x + 1000 * 0.6, z: t.z - 1000 * 0.8 } });
  assert.ok(r.ok);
  if (!r.ok) return;
  const minutes = runUntil(ms, () => r.task.status === "COMPLETED", 60);
  assert.equal(t.payload.tonnes, 100);
  // Loaded, mostly off-road: a few minutes, not seconds and not an hour.
  assert.ok(minutes >= 3 && minutes <= 20, `took ${minutes} min`);
});

test("upgrades modify simulation properties, not labels", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const truck = equipmentOf(ms, "ridgeline_rh60");
  const base = payloadCapacity(sim, truck, "OVERBURDEN");
  const coalBase = payloadCapacity(sim, truck, "COAL_RAW");
  assert.ok(coalBase < base, "a standard body fills by volume on light coal");
  assert.ok(buyUpgrade(sim, truck.id, "body_high_capacity").ok);
  assert.ok(Math.abs(payloadCapacity(sim, truck, "OVERBURDEN") - base * 1.12) < 1e-6);
  // Same slot replaces: fitting the coal body removes the high-capacity body.
  assert.ok(buyUpgrade(sim, truck.id, "body_coal").ok);
  assert.deepEqual(truck.upgrades, ["body_coal"]);
  assert.ok(payloadCapacity(sim, truck, "COAL_RAW") > coalBase);
});

test("wear and breakdown hazard follow condition and service, deterministically", () => {
  const ms = blackCreek(7);
  const sim = ms.sim;
  const good = equipmentOf(ms, "ridgeline_rh60", 0);
  const bad = equipmentOf(ms, "ridgeline_rh60", 1);
  good.condition = 95;
  good.hoursSinceService = 0;
  bad.condition = 25;
  bad.hoursSinceService = 900;
  let goodFail = 0;
  let badFail = 0;
  for (let n = 0; n < 400; n++) {
    good.state = "WORKING";
    bad.state = "WORKING";
    good.fuelL = bad.fuelL = 700;
    good.condition = 95;
    bad.condition = 25;
    runEngine(sim, good, 60, 1, 0.6);
    runEngine(sim, bad, 60, 1, 0.6);
    if ((good.state as string) === "BROKEN") goodFail++;
    if ((bad.state as string) === "BROKEN") badFail++;
  }
  assert.ok(badFail > goodFail * 4 + 2, `good ${goodFail} vs bad ${badFail}`);
});

test("risk is explained by its factors", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const truck = equipmentOf(ms, "ridgeline_rh60");
  sim.worker(truck.operatorId)!.fatigue = 95;
  truck.condition = 30;
  const r = equipmentRisk(sim, truck);
  assert.ok(r.score >= 40);
  assert.ok(r.factors.some((f) => /fatigue/.test(f.label)));
  assert.ok(r.factors.some((f) => /condition/.test(f.label)));
  assert.equal(r.score, Math.min(100, r.factors.reduce((s, f) => s + f.points, 0)));
});

test("coal sales check the customer's quality spec and adjust price for quality", () => {
  const ms = blackCreek();
  const sim = ms.sim;
  const rom = sim.stockpile("rom-1")!;
  rom.tonnes = 1000;
  rom.quality = { ash: 14, sulfur: 1.4, moisture: 8, btu: 12000 };
  const premium = sim.customer("cust-premium")!;
  const power = sim.customer("cust-power")!;
  assert.ok(quoteSale(sim, premium, rom, 500).problems.some((p) => /Ash/.test(p)));
  const q = quoteSale(sim, power, rom, 500);
  assert.equal(q.problems.length, 0);
  assert.ok(q.pricePerT < power.price, "ash above 10% is penalised");
  const revenue0 = sim.state.today.revenue;
  const r = sell(sim, power.id, rom.id, 500);
  assert.ok(r.ok);
  // The sale is loaded out at the loadout's rate and paid when the last truck leaves.
  assert.equal(rom.tonnes, 1000);
  assert.ok(quoteSale(sim, power, rom, 800).tonnes <= 500 + 1e-9, "sold coal is committed");
  runUntil(ms, () => sim.state.loadout!.shipments.length === 0, 3 * 60);
  assert.ok(Math.abs(rom.tonnes - 500) < 1e-6);
  assert.ok(Math.abs(sim.state.today.revenue - revenue0 - q.revenue) < 0.01);
  assert.equal(sim.state.today.coalSoldT, 500);
});

test("same seed and commands give the same mine (determinism)", () => {
  const run = () => {
    const ms = blackCreek(1234);
    orderBlockWork(ms.sim, "A3", "OVERBURDEN");
    ms.advanceMinutes(16 * 60);
    return digest(ms.state);
  };
  assert.equal(run(), run());
});

test("save → load → continue gives the same result as never saving", () => {
  const a = blackCreek(99);
  orderBlockWork(a.sim, "A2", "OVERBURDEN");
  a.advanceMinutes(9 * 60);
  const json = serialize(a.sim.sync(), "test", new Date(0));
  const loaded = deserialize(json);
  assert.equal(loaded.metadata.scenarioId, a.state.scenarioId);
  const b = new MineSimulation(loaded.state, catalog);
  assert.equal(digest(b.state), digest(a.state));
  a.advanceMinutes(6 * 60);
  b.advanceMinutes(6 * 60);
  assert.equal(digest(b.state), digest(a.state));
  assert.ok(b.state.terrain.surface instanceof Float32Array);
});

test("a full day of operation produces a daily report", () => {
  const ms = blackCreek();
  orderBlockWork(ms.sim, "A2", "OVERBURDEN");
  ms.advanceMinutes(24 * 60);
  const day = ms.state.history[0]!;
  assert.equal(day.day, 1);
  assert.ok(day.overburdenT > 1000, `overburden ${day.overburdenT}`);
  assert.ok((day.expenses.payroll ?? 0) > 0);
  assert.ok(day.workerHours > 0);
  assert.ok(day.equipmentWorkingMin > 0);
});
