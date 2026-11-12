/**
 * Conveyors (spec §23): each is an edge of a directed logistics graph, hopper → belt → stockpile.
 * Trucks tip coal into the hopper; the belt draws from it at no more than its rated capacity, the
 * coal spends `length / speed` on the belt, and arrives on the stockpile. Physical limits are the
 * gameplay: a slow belt backs coal up into the hopper and trucks queue; a full stockpile jams the
 * belt; a worn belt breaks down and needs a mechanic.
 *
 * Belt model: plug flow. Each step loads at most `capacity × dt` from the hopper as one slice, which
 * rides the belt for `length / speed` and discharges whole. Because no slice is bigger than one
 * step's rated load and slices leave in the order they were loaded, discharge can never exceed the
 * rated capacity either (tested in tests/logistics.test.ts). A jam holds the whole belt in place.
 */
import type { Sim } from "../sim.js";
import type { Conveyor, Hopper } from "../state.js";
import { blendQuality, type MaterialParcel } from "../world/materials.js";
import { addToStockpile, stockpileRoomT } from "./stockpiles.js";
import { CONSTRUCTION } from "./construction.js";

const START_MINUTES = 1.5;

const BREAKDOWN_CAUSES = ["belt splice failure", "idler bearing seizure", "drive gearbox overheating", "belt misalignment and edge damage", "pulley lagging worn through"];

/** Minutes material spends on the belt. */
export function transitMinutes(c: Conveyor): number {
  return c.length / Math.max(0.1, c.speed) / 60;
}

/** Most material the belt can carry at once, t. */
export function beltCapacityT(c: Conveyor): number {
  return (c.capacityTph / 60) * transitMinutes(c);
}

export function hopperOf(sim: Sim, c: Conveyor): Hopper | null {
  return sim.state.hoppers.find((h) => h.id === c.hopperId) ?? null;
}

export function hopperById(sim: Sim, id: string | null | undefined): Hopper | null {
  if (!id) return null;
  return sim.state.hoppers.find((h) => h.id === id) ?? null;
}

export function conveyorById(sim: Sim, id: string | null | undefined): Conveyor | null {
  if (!id) return null;
  return sim.state.conveyors.find((c) => c.id === id) ?? null;
}

/** Tip a truckload into a hopper; returns tonnes that did not fit. */
export function addToHopper(h: Hopper, parcel: MaterialParcel): number {
  const fit = Math.max(0, Math.min(parcel.tonnes, h.capacityT - h.tonnes));
  h.quality = blendQuality(h.quality, h.tonnes, parcel.quality, fit);
  h.tonnes += fit;
  return parcel.tonnes - fit;
}

export function setConveyorEnabled(sim: Sim, c: Conveyor, on: boolean): void {
  c.enabled = on;
  if (!on && c.state !== "DAMAGED" && c.state !== "MAINTENANCE") c.state = "OFFLINE";
  sim.notify("info", `${c.name} switched ${on ? "on" : "off"}`, on ? "It starts when coal reaches the hopper." : "Coal in the hopper stays there; trucks will queue when it is full.");
}

/** One tick for every conveyor. */
export function tickConveyors(sim: Sim): void {
  const dt = sim.dt;
  for (const c of sim.state.conveyors) {
    const h = hopperOf(sim, c);
    const s = sim.stockpile(c.stockpileId);
    if (!h || !s) continue;
    if (c.state === "DAMAGED" || c.state === "MAINTENANCE") continue;
    if (!c.enabled) {
      c.state = "OFFLINE";
      continue;
    }
    const hasWork = h.tonnes > 1e-9 || c.slices.length > 0;
    if (!hasWork) {
      // Idle belts stop to save power; they restart through a start-up sequence.
      if (c.state === "RUNNING" || c.state === "STARTING") c.state = "OFFLINE";
      continue;
    }
    if (c.state === "OFFLINE") {
      c.state = "STARTING";
      c.startTimer = START_MINUTES;
    }
    // Power is drawn while the belt turns, whatever it carries.
    sim.accrue((c.powerKw * dt) / 60 * CONSTRUCTION.electricityPerKWh, "electricity");
    c.operatingHours += dt / 60;
    if (c.state === "STARTING") {
      c.startTimer -= dt;
      if (c.startTimer > 0) continue;
      c.state = "RUNNING";
    }
    // Discharge first: a full stockpile stops the belt (jam) rather than spilling coal.
    const due = c.slices.length && c.slices[0]!.arriveAt <= sim.minute + 1e-9 ? c.slices[0]! : null;
    if (due && stockpileRoomT(s) < due.tonnes) {
      if (c.state !== "JAMMED") sim.notify("warn", `${c.name} jammed`, `${s.name} is full; the belt stopped with ${Math.round(c.beltT)} t on it. Sell coal or send the belt elsewhere.`);
      c.state = "JAMMED";
      // A stopped belt does not move its load: everything on it arrives one step later.
      for (const sl of c.slices) sl.arriveAt += dt;
      continue;
    }
    if (c.state === "JAMMED") c.state = "RUNNING";
    while (c.slices.length && c.slices[0]!.arriveAt <= sim.minute + 1e-9) {
      const sl = c.slices.shift()!;
      addToStockpile(sim, s, { type: "COAL_RAW", tonnes: sl.tonnes, quality: sl.quality });
      c.beltT -= sl.tonnes;
      c.totalT += sl.tonnes;
    }
    if (c.slices.length === 0) c.beltT = 0;
    // Load one step's worth from the hopper, at no more than the rated rate.
    const load = Math.max(0, Math.min(h.tonnes, (c.capacityTph * dt) / 60));
    if (load > 1e-9) {
      c.slices.push({ tonnes: load, quality: h.quality ? { ...h.quality } : null, arriveAt: sim.minute + transitMinutes(c) });
      c.beltT += load;
      h.tonnes -= load;
      if (h.tonnes < 1e-9) {
        h.tonnes = 0;
        h.quality = null;
      }
    }
    // Wear and the breakdown hazard follow running hours and condition (like machines, spec §9).
    c.condition = Math.max(0, c.condition - 0.004 * dt);
    const hazard = 1.5e-6 * Math.exp((70 - c.condition) / 10);
    if (c.condition <= 0 || sim.rng.chance(1 - Math.exp(-hazard * dt))) breakConveyor(sim, c);
  }
}

export function breakConveyor(sim: Sim, c: Conveyor, cause?: string): void {
  if (c.state === "DAMAGED") return;
  const why = cause ?? sim.rng.pick(BREAKDOWN_CAUSES);
  c.state = "DAMAGED";
  c.breakdown = { cause: why, minute: sim.minute };
  sim.notify("critical", `${c.name} broke down`, `Cause: ${why}. ${Math.round(c.beltT)} t is stranded on the belt. Assign a mechanic to repair it.`);
}

export function repairConveyorHours(c: Conveyor): number {
  return c.condition < 30 ? 6 : 3.5;
}

export function finishConveyorRepair(sim: Sim, c: Conveyor, skill: number): number {
  c.condition = Math.max(c.condition, 55 + 30 * skill);
  c.breakdown = null;
  c.state = "OFFLINE";
  const cost = Math.round(4200 + c.length * 18);
  sim.spend(cost, "repairs", `Repair ${c.name}`);
  sim.notify("good", `${c.name} repaired`, `Back in service at ${c.condition.toFixed(0)}% condition. Cost $${cost.toLocaleString()}.`);
  return cost;
}
