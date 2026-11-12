/**
 * The preparation plant (spec §25, development phase 09): FEEDER → CRUSHER → SCREEN → SEPARATOR →
 * clean coal + refuse. Simulated at pipeline step 10, after conveyors.
 *
 * Washability is a two-component model. Raw coal is coal with its own (inherent) ash plus rock
 * picked up in mining with ash `rockAsh`. The dense-medium separator rejects rock and the heaviest,
 * dirtiest coal; a lower cut density rejects more of both. Mass, ash and sulfur balance exactly
 * between feed, clean coal and refuse (tested).
 */
import type { Sim } from "../sim.js";
import type { DumpArea, PlantUnit, PlantUnitKind, PrepPlant } from "../state.js";
import type { CoalQuality } from "../world/materials.js";
import { addToStockpile, dumpPoint, placeInDump, stockpileRoomT, takeFromStockpile } from "../logistics/stockpiles.js";
import { CONSTRUCTION } from "../logistics/construction.js";
import { isOnShift, shiftLabel } from "../workforce/workforce.js";
import { createTask, TERMINAL } from "../tasks/service.js";
import { committedT } from "../economy/market.js";
import plantData from "../../data/plant.json" with { type: "json" };

export const PLANT = plantData as {
  units: { kind: PlantUnitKind; name: string; capacityTph: number; powerKw: number; wearPerKt: number }[];
  startMinutes: number;
  reagentCostPerT: number;
  cutDensity: { min: number; max: number; default: number };
  rockAsh: number;
  inherentAshFraction: number;
  pyriticSulfurFraction: number;
  productMoistureAdd: number;
  refuseMoisture: number;
  refurbish: { cost: number; hours: number; condition: number };
  repairHours: number;
  repairCostPerUnit: number;
  breakdownCauses: Record<PlantUnitKind, string[]>;
  loadoutRateTph: number;
};

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export interface WashResult {
  /** Clean coal mass / feed mass. */
  yield: number;
  clean: CoalQuality;
  refuse: { ash: number; sulfur: number };
}

/**
 * Wash one tonne of raw coal at cut density `cut` with separation efficiency `efficiency` (0…1).
 * Pure: the plant, the UI preview and the tests all call it.
 */
export function wash(raw: CoalQuality, cut: number, efficiency: number): WashResult {
  const a = raw.ash;
  const a0 = a * PLANT.inherentAshFraction;
  const rock = clamp((a - a0) / (PLANT.rockAsh - a0), 0, 0.95);
  const e = clamp(efficiency, 0, 1);
  // Heaviest coal lost at a low cut, plus coal misplaced to refuse by an imperfect separator.
  const coalLoss = clamp(0.005 + 0.5 * (1.6 - cut), 0.005, 0.3) + (1 - e) * 0.05;
  const rockRejected = e * clamp(0.6 + 0.8 * (1.9 - cut), 0, 1);
  const coalKept = (1 - rock) * (1 - coalLoss);
  const rockKept = rock * (1 - rockRejected);
  const y = coalKept + rockKept;
  // The coal rejected is the dirtiest: about 2.5× the average coal ash.
  const coalAsh = (a0 * Math.max(0.3, 1 - 2.5 * coalLoss)) / (1 - coalLoss);
  const ash = (coalKept * coalAsh + rockKept * PLANT.rockAsh) / y;
  // Pyritic sulfur travels with the rock; organic sulfur with the coal.
  const sp = raw.sulfur * PLANT.pyriticSulfurFraction;
  const so = raw.sulfur - sp;
  const sulfur = rock > 1e-6 ? (coalKept * (so / (1 - rock)) + rockKept * (sp / rock)) / y : raw.sulfur;
  const moisture = raw.moisture + PLANT.productMoistureAdd;
  const btu = raw.btu * ((100 - ash - moisture) / Math.max(1, 100 - a - raw.moisture));
  const r = 1 - y;
  return {
    yield: y,
    clean: { ash, sulfur, moisture, btu },
    refuse: { ash: r > 1e-9 ? (a - y * ash) / r : PLANT.rockAsh, sulfur: r > 1e-9 ? Math.max(0, (raw.sulfur - y * sulfur) / r) : 0 },
  };
}

export function newPlant(_sim: Sim, at: { x: number; z: number; width: number; depth: number }, feedStockpileId: string, cleanStockpileId: string, refuseDumpId: string, condition: number, mothballed: boolean): PrepPlant {
  return {
    id: "plant-1",
    name: "Preparation plant",
    x: at.x,
    z: at.z,
    width: at.width,
    depth: at.depth,
    status: mothballed ? "MOTHBALLED" : "OFF",
    stopReason: mothballed ? "Mothballed since your grandfather's day: refurbish it before it can run" : null,
    enabled: false,
    units: PLANT.units.map((u, n) => ({ id: `unit-${n + 1}`, kind: u.kind, name: u.name, capacityTph: u.capacityTph, powerKw: u.powerKw, wearPerKt: u.wearPerKt, condition, breakdown: null, throughputT: 0 })),
    feedStockpileId,
    cleanStockpileId,
    refuseDumpId,
    feedRateTph: 220,
    cutDensity: PLANT.cutDensity.default,
    operatorId: null,
    startTimer: 0,
    rateTph: 0,
    lastProduct: null,
    lastYield: null,
    totalFeedT: 0,
    totalCleanT: 0,
    totalRefuseT: 0,
  };
}

/** Rated capacity right now: the slowest unit, derated when worn. */
export function plantCapacityTph(p: PrepPlant): number {
  return Math.min(...p.units.map((u) => u.capacityTph * (u.condition < 30 ? 0.7 : 1)));
}

/** Separation efficiency from the cyclone's and screen's condition and the operator's skill. */
export function plantEfficiency(sim: Sim, p: PrepPlant): number {
  const sep = p.units.find((u) => u.kind === "SEPARATOR")?.condition ?? 50;
  const screen = p.units.find((u) => u.kind === "SCREEN")?.condition ?? 50;
  const w = sim.worker(p.operatorId);
  const skill = w ? (w.skills.equipmentOperation + w.skills.mining) / 2 : 0.5;
  return clamp((0.72 + 0.2 * (sep / 100) + 0.05 * skill) * (0.9 + 0.1 * (screen / 100)), 0, 0.97);
}

export function plantPowerKw(p: PrepPlant, load: number): number {
  return p.units.reduce((s, u) => s + u.powerKw, 0) * (0.35 + 0.65 * clamp(load, 0, 1));
}

function refuseDump(sim: Sim, p: PrepPlant): DumpArea | null {
  return sim.dump(p.refuseDumpId);
}

/** Why the plant cannot run now (null = it can), as a sentence the player can act on. */
export function plantProblem(sim: Sim, p: PrepPlant): string | null {
  if (p.status === "MOTHBALLED") return p.stopReason;
  if (p.status === "REFURBISHING") return "Being refurbished by the contractors";
  const broken = p.units.filter((u) => u.breakdown);
  if (broken.length) return `${broken.map((u) => `${u.name}: ${u.breakdown!.cause.toLowerCase()}`).join("; ")}. A mechanic must repair it`;
  if (!p.enabled) return "Switched off";
  const w = sim.worker(p.operatorId);
  if (!w || w.employmentStatus !== "ACTIVE") return "No plant operator assigned. Hire a plant operator (WORKERS) and assign them to the plant";
  if (!isOnShift(sim, w)) return `${w.name} is off shift (shift ${shiftLabel(sim)})`;
  const feed = sim.stockpile(p.feedStockpileId);
  if (!feed) return "The feed stockpile no longer exists";
  if (feed.tonnes - committedT(sim, feed.id) < 1) return `${feed.name} is empty (or all of it is sold): the plant has no raw coal to wash`;
  const clean = sim.stockpile(p.cleanStockpileId);
  if (!clean) return "The clean coal stockpile no longer exists";
  if (stockpileRoomT(clean) < 1) return `${clean.name} is full. Sell clean coal to make room`;
  const d = refuseDump(sim, p);
  if (!d || !dumpPoint(sim, d, { x: p.x, z: p.z })) return `${d?.name ?? "The refuse pile"} is full`;
  return null;
}

function setStopped(sim: Sim, p: PrepPlant, status: "STOPPED" | "OFF" | "BROKEN", reason: string): void {
  const was = p.status;
  p.status = status;
  p.rateTph = 0;
  p.startTimer = 0;
  if (reason !== p.stopReason && status === "STOPPED" && (was === "RUNNING" || was === "STARTING")) sim.notify("warn", `${p.name} stopped`, reason, { kind: "plant", id: p.id });
  p.stopReason = reason;
}

function breakUnit(sim: Sim, p: PrepPlant, u: PlantUnit, cause?: string): void {
  if (u.breakdown) return;
  u.breakdown = { cause: cause ?? sim.rng.pick(PLANT.breakdownCauses[u.kind]), minute: sim.minute };
  sim.notify("critical", `${p.name}: ${u.name} broke down`, `${u.breakdown.cause}. The plant is stopped until a mechanic repairs it.`, { kind: "plant", id: p.id });
  if (sim.state.settings.autoMaintenance) fileRepair(sim, p);
}

/** File a mechanic repair for the plant unless one is already open. */
export function fileRepair(sim: Sim, p: PrepPlant): void {
  const open = sim.state.tasks.some((t) => t.type === "REPAIR" && t.destination?.kind === "plant" && !TERMINAL.has(t.status));
  if (!open) createTask(sim, { type: "REPAIR", destination: { kind: "plant", id: p.id }, priority: "HIGH", label: `Repair ${p.name}` });
}

/** For the developer panel and tests. */
export function forcePlantBreakdown(sim: Sim, unitKind: PlantUnitKind = "CRUSHER"): void {
  const p = sim.state.plant;
  const u = p?.units.find((x) => x.kind === unitKind);
  if (p && u) breakUnit(sim, p, u);
}

/** Hours a mechanic needs for the plant's current faults (or an overhaul of worn units). */
export function plantRepairHours(p: PrepPlant): number {
  const n = p.units.filter((u) => u.breakdown || u.condition < 50).length;
  return PLANT.repairHours * Math.max(1, n) * 0.75 + 0.5;
}

export function plantNeedsRepair(p: PrepPlant): boolean {
  return p.units.some((u) => u.breakdown || u.condition < 50);
}

export function finishPlantRepair(sim: Sim, p: PrepPlant, skill: number): number {
  const fixed = p.units.filter((u) => u.breakdown || u.condition < 50);
  for (const u of fixed) {
    u.breakdown = null;
    u.condition = Math.max(u.condition, 55 + 30 * skill);
  }
  const cost = PLANT.repairCostPerUnit * Math.max(1, fixed.length);
  sim.spend(cost, "repairs", `Repair ${p.name}`);
  if (p.status === "BROKEN") p.status = "OFF";
  sim.notify("good", `${p.name} repaired`, `${fixed.map((u) => u.name).join(", ") || "Overhaul"} back in service. Cost $${cost.toLocaleString()}.`, { kind: "plant", id: p.id });
  return cost;
}

/** Pipeline step 10: run the plant for one tick. */
export function tickPlant(sim: Sim): void {
  const p = sim.state.plant;
  if (!p) return;
  const dt = sim.dt;
  if (p.status === "MOTHBALLED" || p.status === "REFURBISHING") {
    p.rateTph = 0;
    return;
  }
  const problem = plantProblem(sim, p);
  if (problem) {
    setStopped(sim, p, p.units.some((u) => u.breakdown) ? "BROKEN" : !p.enabled ? "OFF" : "STOPPED", problem);
    return;
  }
  p.stopReason = null;
  const w = sim.worker(p.operatorId)!;
  w.activity = "operating";
  const kwh = (kw: number, minutes: number): number => (kw * minutes) / 60;
  let runMin = dt;
  // Start-up: motors, medium circuit and water come up before feed goes on.
  if (p.status !== "RUNNING") {
    if (p.status !== "STARTING") p.startTimer = 0;
    p.status = "STARTING";
    const use = Math.min(dt, PLANT.startMinutes - p.startTimer);
    p.startTimer += use;
    sim.accrue(kwh(plantPowerKw(p, 0), use) * CONSTRUCTION.electricityPerKWh, "electricity");
    if (p.startTimer < PLANT.startMinutes - 1e-9) return;
    runMin = dt - use;
    p.status = "RUNNING";
    sim.notify("info", `${p.name} running`, `Washing ${sim.stockpile(p.feedStockpileId)?.name ?? "raw coal"} at ${Math.round(Math.min(p.feedRateTph, plantCapacityTph(p)))} t/h, cut density ${p.cutDensity.toFixed(2)}.`, { kind: "plant", id: p.id });
  }
  const feedPile = sim.stockpile(p.feedStockpileId)!;
  const cleanPile = sim.stockpile(p.cleanStockpileId)!;
  const dump = refuseDump(sim, p)!;
  const rate = Math.min(p.feedRateTph, plantCapacityTph(p));
  const quality = feedPile.quality;
  if (!quality) {
    setStopped(sim, p, "STOPPED", `${feedPile.name} holds no coal`);
    return;
  }
  const result = wash(quality, p.cutDensity, plantEfficiency(sim, p));
  // Coal already sold from the feed pile and waiting at the loadout is not the plant's to take.
  let feed = Math.min((rate * runMin) / 60, Math.max(0, feedPile.tonnes - committedT(sim, feedPile.id)));
  // Never make more clean coal than the clean stockpile can take.
  feed = Math.min(feed, stockpileRoomT(cleanPile) / Math.max(0.05, result.yield));
  if (feed <= 1e-9) return;
  const parcel = takeFromStockpile(feedPile, feed);
  const clean = parcel.tonnes * result.yield;
  const refuse = parcel.tonnes - clean;
  addToStockpile(sim, cleanPile, { type: "COAL_CLEAN", tonnes: clean, quality: result.clean });
  const at = dumpPoint(sim, dump, { x: p.x, z: p.z });
  const left = at ? placeInDump(sim, dump, { type: "REFUSE", tonnes: refuse, quality: null }, at.x, at.z) : refuse;
  if (left > 0.01) dump.tonnes += left; // the last of it is spread over the pile
  // Wear, power, reagents, statistics.
  for (const u of p.units) {
    u.throughputT += parcel.tonnes;
    u.condition = Math.max(0, u.condition - (u.wearPerKt * parcel.tonnes) / 1000);
  }
  p.rateTph = (parcel.tonnes / dt) * 60;
  sim.accrue(kwh(plantPowerKw(p, p.rateTph / Math.max(1, plantCapacityTph(p))), runMin) * CONSTRUCTION.electricityPerKWh, "electricity");
  sim.accrue(parcel.tonnes * PLANT.reagentCostPerT, "operating");
  p.lastProduct = result.clean;
  p.lastYield = result.yield;
  p.totalFeedT += parcel.tonnes;
  p.totalCleanT += clean;
  p.totalRefuseT += refuse;
  sim.state.today.plantFeedT += parcel.tonnes;
  sim.state.today.cleanCoalT += clean;
  sim.state.today.refuseT += refuse;
  // Breakdowns: a worn unit is far more likely to fail.
  for (const u of p.units) {
    const perHour = 0.002 + 0.03 * (1 - u.condition / 100) ** 2;
    if (sim.rng.chance((perHour * runMin) / 60)) {
      breakUnit(sim, p, u);
      setStopped(sim, p, "BROKEN", plantProblem(sim, p) ?? "Breakdown");
      break;
    }
  }
}
