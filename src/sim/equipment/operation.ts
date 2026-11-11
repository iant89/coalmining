/**
 * What running a machine costs it (spec §9): fuel, engine hours, operating cost, wear, and the
 * breakdown hazard that grows as condition falls. Breakdowns are drawn from the simulation RNG, but
 * the *rate* is fully determined by state — old, worn, overdue machines run by tired operators fail,
 * well-kept ones rarely do. There is no "random truck explodes" event.
 */
import type { Sim } from "../sim.js";
import type { EquipmentInstance } from "../state.js";
import { MATERIAL_LABEL, type MaterialType } from "../world/materials.js";

export type ConditionBand = "New" | "Good" | "Used" | "Worn" | "Critical" | "Failed";

export function conditionBand(c: number): ConditionBand {
  if (c >= 95) return "New";
  if (c >= 75) return "Good";
  if (c >= 55) return "Used";
  if (c >= 35) return "Worn";
  if (c > 0) return "Critical";
  return "Failed";
}

const BREAKDOWN_CAUSES: Record<string, string[]> = {
  HAUL_TRUCK: ["hydraulic hoist cylinder leak", "tyre sidewall failure", "transmission overheating", "suspension strut failure", "alternator failure"],
  EXCAVATOR: ["hydraulic hose burst", "swing bearing fault", "track chain damage", "boom cylinder seal failure", "engine overheating"],
  DRILL: ["rotary head failure", "compressor fault", "drill string jam", "mast hydraulic leak"],
  DOZER: ["final drive failure", "track roller seizure", "blade lift cylinder leak", "engine overheating"],
};

/** Payload capacity (t) for a material, with upgrades. */
export function payloadCapacity(sim: Sim, eq: EquipmentInstance, material: MaterialType | null): number {
  const def = sim.def(eq);
  let cap = (def.payloadT ?? 0) * sim.catalog.modifier(eq.upgrades, "payload");
  // Coal is light: a standard body fills by volume before it reaches rated payload.
  if (material === "COAL_RAW" || material === "COAL_CLEAN") {
    const byVolume = (def.bodyM3 ?? 0) * 1.05 * 0.95 * sim.catalog.modifier(eq.upgrades, "coalPayload");
    cap = Math.min(cap * sim.catalog.modifier(eq.upgrades, "coalPayload"), byVolume);
  }
  return cap;
}

export function fuelFraction(sim: Sim, eq: EquipmentInstance): number {
  return eq.fuelL / sim.def(eq).fuelCapacityL;
}

/**
 * Run the engine for `minutes`. `load` 0 = idle, 1 = full working load. Returns false when the tank
 * ran dry (the caller blocks the task).
 */
export function runEngine(sim: Sim, eq: EquipmentInstance, minutes: number, load: number, operatorSkill = 0.6): boolean {
  if (minutes <= 0) return true;
  const def = sim.def(eq);
  const hours = minutes / 60;
  const burn = (def.fuelBurnLph.idle + (def.fuelBurnLph.working - def.fuelBurnLph.idle) * load) * sim.catalog.modifier(eq.upgrades, "fuelBurn");
  const used = Math.min(eq.fuelL, burn * hours);
  eq.fuelL -= used;
  sim.state.today.fuelL += used;
  eq.operatingHours += hours;
  eq.hoursSinceService += hours;
  sim.accrue(def.operatingCostPerHour * hours * (0.4 + 0.6 * load), "operating");
  if (load > 0.05) {
    eq.stats.workingMin += minutes;
    sim.state.today.equipmentWorkingMin += minutes;
  } else {
    eq.stats.idleMin += minutes;
    sim.state.today.equipmentIdleMin += minutes;
  }
  // Wear: load, operator care, overdue service and upgrades all scale it.
  const overdue = eq.hoursSinceService > def.maintenanceIntervalH ? 1.8 : 1;
  const care = 1.25 - 0.5 * operatorSkill;
  const wear = def.wearPerHour * hours * (0.3 + 0.7 * load) * care * overdue * sim.catalog.modifier(eq.upgrades, "wear");
  eq.condition = Math.max(0, eq.condition - wear);
  // Breakdown hazard per working minute.
  if (load > 0.05) {
    const hazard = 2e-6 * Math.exp((70 - eq.condition) / 10) * overdue * sim.catalog.modifier(eq.upgrades, "breakdownHazard");
    const p = 1 - Math.exp(-hazard * minutes);
    if (eq.condition <= 0 || sim.rng.chance(p)) breakDown(sim, eq);
  }
  return eq.fuelL > 0.01;
}

export function breakDown(sim: Sim, eq: EquipmentInstance, cause?: string): void {
  if (eq.state === "BROKEN") return;
  const def = sim.def(eq);
  const why = cause ?? (eq.condition <= 0 ? "worn out" : sim.rng.pick(BREAKDOWN_CAUSES[def.category] ?? ["mechanical failure"]));
  eq.state = "BROKEN";
  eq.activity = "broken";
  eq.speed = 0;
  eq.breakdown = { cause: why, minute: sim.minute };
  sim.bus.emit({ type: "EquipmentBreakdown", equipmentId: eq.id, cause: why });
  const load = eq.payload ? ` It was carrying ${Math.round(eq.payload.tonnes)} t of ${MATERIAL_LABEL[eq.payload.type].toLowerCase()}.` : "";
  sim.notify("critical", `${eq.name} broke down`, `Cause: ${why}. Condition ${eq.condition.toFixed(0)}%, ${eq.hoursSinceService.toFixed(0)} h since service.${load}`, { kind: "equipment", id: eq.id });
}

/** Repair duration in hours for the current breakdown. */
export function repairHours(sim: Sim, eq: EquipmentInstance): number {
  const base = eq.condition < 20 ? 9 : eq.condition < 45 ? 6 : 3.5;
  return base * (sim.def(eq).category === "EXCAVATOR" ? 1.3 : 1);
}

export function repairCost(sim: Sim, eq: EquipmentInstance): number {
  return Math.round(sim.def(eq).maintenanceCost * (eq.condition < 30 ? 1.6 : 1.1));
}
