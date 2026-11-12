/**
 * Task executors — the Equipment AI layer (spec §50). Each executor turns one task type into
 * machine behaviour by spending a time budget (minutes) per tick across its phases, so a haul cycle
 * takes the same simulated time whatever the tick length. Executors call into the domain modules
 * (excavation, drilling, blasting, stockpiles …) and never into rendering.
 */
import type { Sim } from "../sim.js";
import type { Employee, EquipmentInstance, MiningBlock, Task, TaskTarget, TaskType } from "../state.js";
import { arrived, setDestination, setDirect, travel } from "../equipment/movement.js";
import { breakDown, payloadCapacity, repairCost, repairHours, runEngine } from "../equipment/operation.js";
import { analyzeBlock, blockCenter, refreshBlockState } from "../mining/blocks.js";
import { digBucket, digStatus, nextDigCell, unblastedTonnes, type Reach } from "../mining/excavation.js";
import { completeHole, holeMinutes, patternProgress } from "../mining/drilling.js";
import { BLAST_EXCLUSION_M, executeBlast } from "../mining/blasting.js";
import { CORE_COST_PER_M, recordCoreSample } from "../mining/exploration.js";
import { addToStockpile, dumpPoint, placeInDump } from "../logistics/stockpiles.js";
import { alongPath, workOnProject } from "../logistics/construction.js";
import { addToHopper, conveyorById, finishConveyorRepair, hopperById, repairConveyorHours } from "../logistics/conveyors.js";
import { haulClass, MATERIAL_LABEL, mergeParcel, surfaceMaterialIsRock } from "./helpers.js";
import { mineralRightsProblem, permitProblem } from "../regulatory/permits.js";
import { weatherEffects } from "../environment/weather.js";
import { workerPerformance } from "../workforce/workforce.js";
import { blockTask, completeTask, failTask, TERMINAL } from "./service.js";

export interface TaskExecutor {
  /** Structural problems that stop the task being created or assigned. */
  validate(sim: Sim, t: Task): string[];
  /** Conditions re-checked every tick while the task is assigned; a reason blocks it. */
  check?(sim: Sim, t: Task, eq: EquipmentInstance | null, w: Employee | null): string | null;
  start(sim: Sim, t: Task, eq: EquipmentInstance | null, w: Employee | null): void;
  /** Spend `budget` minutes of work. */
  run(sim: Sim, t: Task, eq: EquipmentInstance | null, w: Employee | null, budget: number): void;
  cancel?(sim: Sim, t: Task): void;
}

const EPS = 1e-7;
/** Excavator bucket reach from where the machine stands (m). */
export const EXCAVATOR_REACH = 11;
/** Haul trucks spot this far from the excavator, and queue at this spacing. */
const SPOT_OFFSET = 9;
const QUEUE_SPACING = 15;
const FUEL_RATE_LPM = 300;

// ---------------------------------------------------------------- shared helpers

export function targetPoint(sim: Sim, target: TaskTarget | null): { x: number; z: number } | null {
  if (!target) return null;
  switch (target.kind) {
    case "point":
      return { x: target.x, z: target.z };
    case "block": {
      const b = sim.block(target.id);
      return b ? blockCenter(sim, b) : null;
    }
    case "task": {
      const t = sim.task(target.id);
      const e = sim.equipment(t?.assignedEquipmentId);
      return e ? { x: e.x, z: e.z } : t ? targetPoint(sim, t.destination) : null;
    }
    case "stockpile": {
      const s = sim.stockpile(target.id);
      return s ? { x: s.x, z: s.z } : null;
    }
    case "dump": {
      const d = sim.dump(target.id);
      if (!d) return null;
      const p = dumpPoint(sim, d);
      return p ?? { x: (sim.terrain.cellX(d.rect.i0) + sim.terrain.cellX(d.rect.i1)) / 2, z: (sim.terrain.cellZ(d.rect.j0) + sim.terrain.cellZ(d.rect.j1)) / 2 };
    }
    case "facility": {
      const f = sim.facility(target.id);
      return f ? { x: f.x, z: f.z } : null;
    }
    case "equipment": {
      const e = sim.equipment(target.id);
      return e ? { x: e.x, z: e.z } : null;
    }
    case "road": {
      const e = sim.state.roadEdges.find((r) => r.id === target.id);
      const n = e ? sim.state.roadNodes.find((x) => x.id === e.a) : null;
      return n ? { x: n.x, z: n.z } : null;
    }
    case "project": {
      const p = sim.state.projects.find((x) => x.id === target.id);
      return p ? alongPath(p, p.progress) : null;
    }
    case "conveyor": {
      const c = conveyorById(sim, target.id);
      const h = c ? hopperById(sim, c.hopperId) : null;
      return h ? { x: h.x, z: h.z } : null;
    }
    case "hopper": {
      const h = hopperById(sim, target.id);
      return h ? { x: h.x, z: h.z } : null;
    }
  }
}

function targetBlock(sim: Sim, t: Task): MiningBlock | null {
  const d = t.destination ?? t.source;
  return d && d.kind === "block" ? sim.block(d.id) : null;
}

/**
 * Drive toward (x, z), re-planning when the target moved or the route was dropped (a blast
 * evacuation, a load). Returns the unused budget and whether the machine is there.
 */
function goTo(sim: Sim, t: Task, eq: EquipmentInstance, x: number, z: number, w: Employee | null, budget: number, tolerance = 1.5): { arrived: boolean; left: number } {
  const moved = Math.hypot((t.scratch.tx ?? NaN) - x, (t.scratch.tz ?? NaN) - z);
  const dist = Math.hypot(eq.x - x, eq.z - z);
  if (dist <= tolerance && arrived(eq)) return { arrived: true, left: budget };
  if (!(moved < 2) || (arrived(eq) && dist > tolerance)) {
    t.scratch.tx = x;
    t.scratch.tz = z;
    setDestination(sim, eq, x, z);
    if (!eq.route) return { arrived: true, left: budget };
  }
  const left = travel(sim, eq, budget, w);
  return { arrived: arrived(eq), left };
}

/** State can change inside runEngine (a breakdown), which TypeScript's narrowing cannot see. */
function isBroken(eq: EquipmentInstance): boolean {
  return eq.state === "BROKEN";
}

function idle(sim: Sim, eq: EquipmentInstance, minutes: number, w: Employee | null): void {
  eq.speed = 0;
  runEngine(sim, eq, minutes, 0, w?.skills.equipmentOperation);
}

/**
 * Field refuelling for machines that do not drive to the fuel station (excavator, drill, dozer):
 * with auto-fuel on, a fuel truck comes out when the tank drops below 15%. Returns the budget left.
 */
function fieldFuel(sim: Sim, t: Task, eq: EquipmentInstance, budget: number): number {
  const def = sim.def(eq);
  const low = eq.fuelL / def.fuelCapacityL < 0.15;
  if (t.scratch.fueling !== 1 && !(low && sim.state.settings.autoFuel)) return budget;
  if (t.scratch.fueling !== 1) {
    t.scratch.fueling = 1;
    t.scratch.fuelTimer = 0;
    sim.bus.emit({ type: "LowFuel", equipmentId: eq.id });
  }
  eq.state = "FUELING";
  eq.activity = "fuel";
  eq.speed = 0;
  t.note = "Fuel truck refuelling in the field";
  const use = Math.min(budget, 25 - (t.scratch.fuelTimer ?? 0));
  t.scratch.fuelTimer = (t.scratch.fuelTimer ?? 0) + use;
  if ((t.scratch.fuelTimer ?? 0) >= 25 - EPS) {
    const litres = def.fuelCapacityL - eq.fuelL;
    eq.fuelL = def.fuelCapacityL;
    sim.spend(litres * sim.state.fuelPricePerL + 120, "fuel", `Field refuel ${eq.name} (${Math.round(litres)} L)`);
    t.scratch.fueling = 0;
    t.note = null;
  }
  return budget - use;
}

function perf(w: Employee | null, skill: Parameters<typeof workerPerformance>[1]): number {
  return w ? workerPerformance(w, skill) : 0.5;
}

function miningPermit(sim: Sim, block: MiningBlock | null): string[] {
  if (!block) return [];
  const out: string[] = [];
  const p = permitProblem(sim, "SURFACE_MINING", block.rect);
  if (p) out.push(p);
  const r = mineralRightsProblem(sim, block.rect);
  if (r) out.push(r);
  return out;
}

// ---------------------------------------------------------------- MOVE / PARK

const MOVE: TaskExecutor = {
  validate(sim, t) {
    return targetPoint(sim, t.destination) ? [] : ["Choose a destination"];
  },
  start(_sim, t, eq) {
    t.phase = "travel";
    if (eq) eq.state = "TRAVELING";
  },
  run(sim, t, eq, w, budget) {
    if (!eq) return;
    const p = targetPoint(sim, t.destination);
    if (!p) return failTask(sim, t, "Destination no longer exists");
    eq.activity = "drive";
    eq.state = "TRAVELING";
    t.status = "TRAVELING";
    const r = goTo(sim, t, eq, p.x, p.z, w, budget);
    if (r.arrived) completeTask(sim, t);
  },
};

function parkingSlot(sim: Sim, eq: EquipmentInstance): { x: number; z: number } | null {
  const lot = sim.facilityOfType("PARKING", eq.x, eq.z);
  if (!lot) return null;
  const idx = sim.state.equipment.indexOf(eq);
  const perRow = Math.max(1, Math.floor(lot.width / 9));
  const col = idx % perRow;
  const row = Math.floor(idx / perRow);
  return { x: lot.x - lot.width / 2 + 4.5 + col * 9, z: lot.z - lot.depth / 2 + 6 + row * 13 };
}

const PARK: TaskExecutor = {
  validate(sim) {
    return sim.facilityOfType("PARKING") ? [] : ["The mine has no parking area"];
  },
  start(_sim, t) {
    t.phase = "travel";
  },
  run(sim, t, eq, w, budget) {
    if (!eq) return;
    const p = parkingSlot(sim, eq);
    if (!p) return failTask(sim, t, "No parking area");
    eq.activity = "drive";
    eq.state = "TRAVELING";
    t.status = "TRAVELING";
    const r = goTo(sim, t, eq, p.x, p.z, w, budget, 1);
    if (r.arrived) {
      eq.heading = Math.PI;
      completeTask(sim, t);
    }
  },
};

// ---------------------------------------------------------------- FUEL / MAINTENANCE / REPAIR

const FUEL: TaskExecutor = {
  validate(sim) {
    return sim.facilityOfType("FUEL") ? [] : ["The mine has no fuel station"];
  },
  start(_sim, t) {
    t.phase = "travel";
  },
  run(sim, t, eq, w, budget) {
    if (!eq) return;
    const def = sim.def(eq);
    let left = budget;
    for (let guard = 0; guard < 4 && left > EPS && t.status !== "COMPLETED"; guard++) {
      if (t.phase === "travel") {
        if (eq.fuelL <= 0.5) {
          // Dry tank: the fuel bowser comes out to the machine (dearer, slower).
          t.phase = "field";
          t.phaseTimer = 0;
          continue;
        }
        const f = sim.facilityOfType("FUEL", eq.x, eq.z)!;
        eq.activity = "drive";
        eq.state = "TRAVELING";
        t.status = "TRAVELING";
        const r = goTo(sim, t, eq, f.x + 6, f.z, w, left);
        left = r.left;
        if (r.arrived) t.phase = "fuel";
      } else if (t.phase === "field") {
        eq.state = "FUELING";
        eq.activity = "fuel";
        t.status = "EXECUTING";
        t.note = "Fuel bowser called out to the machine";
        const need = 30 - t.phaseTimer;
        const use = Math.min(need, left);
        t.phaseTimer += use;
        left -= use;
        if (t.phaseTimer >= 30 - EPS) {
          const litres = def.fuelCapacityL * 0.5 - eq.fuelL;
          eq.fuelL += Math.max(0, litres);
          sim.spend(Math.max(0, litres) * sim.state.fuelPricePerL + 450, "fuel", `Field refuel ${eq.name} (${Math.round(litres)} L + call-out)`);
          t.phase = "travel";
          t.note = null;
        }
      } else {
        eq.state = "FUELING";
        eq.activity = "fuel";
        t.status = "EXECUTING";
        const need = def.fuelCapacityL - eq.fuelL;
        const litres = Math.min(need, FUEL_RATE_LPM * left);
        eq.fuelL += litres;
        left -= litres / FUEL_RATE_LPM;
        sim.spend(litres * sim.state.fuelPricePerL, "fuel", `Refuel ${eq.name}`);
        t.progress = eq.fuelL / def.fuelCapacityL;
        if (eq.fuelL >= def.fuelCapacityL - 0.5) completeTask(sim, t);
      }
    }
  },
};

const MAINTENANCE: TaskExecutor = {
  validate(sim, t) {
    const out: string[] = [];
    if (!sim.facilityOfType("SHOP")) out.push("The mine has no maintenance shop");
    const eq = sim.equipment(t.assignedEquipmentId);
    if (eq?.state === "BROKEN") out.push(`${eq.name} is broken down: assign a REPAIR instead`);
    return out;
  },
  start(_sim, t) {
    t.phase = "travel";
  },
  run(sim, t, eq, w, budget) {
    if (!eq) return;
    const def = sim.def(eq);
    let left = budget;
    if (t.phase === "travel") {
      const shop = sim.facilityOfType("SHOP", eq.x, eq.z)!;
      eq.activity = "drive";
      eq.state = "TRAVELING";
      t.status = "TRAVELING";
      const r = goTo(sim, t, eq, shop.x, shop.z + shop.depth / 2 + 7, w, left);
      left = r.left;
      if (!r.arrived) return;
      t.phase = "service";
      t.phaseTimer = 0;
    }
    eq.state = "MAINTENANCE";
    eq.activity = "service";
    t.status = "EXECUTING";
    const total = def.maintenanceHours * 60;
    t.phaseTimer += left;
    t.progress = Math.min(1, t.phaseTimer / total);
    t.estimatedDuration = Math.max(0, total - t.phaseTimer);
    if (t.phaseTimer >= total) {
      eq.condition = Math.min(100, eq.condition + 18);
      eq.hoursSinceService = 0;
      sim.spend(def.maintenanceCost, "maintenance", `Scheduled service: ${eq.name}`);
      sim.notify("good", `${eq.name} serviced`, `Condition now ${eq.condition.toFixed(0)}%.`, { kind: "equipment", id: eq.id });
      completeTask(sim, t);
    }
  },
};

/** Conveyor repairs: a mechanic, no machine. */
function repairConveyor(sim: Sim, t: Task, w: Employee | null, budget: number): void {
  const c = conveyorById(sim, t.destination?.kind === "conveyor" ? t.destination.id : null);
  if (!c) return failTask(sim, t, "The conveyor no longer exists");
  if (c.state !== "DAMAGED" && c.state !== "MAINTENANCE" && t.phaseTimer === 0 && c.condition > 40) return completeTask(sim, t);
  c.state = "MAINTENANCE";
  t.status = "EXECUTING";
  const skill = perf(w, "maintenance");
  const total = 15 + repairConveyorHours(c) * 60 * (1.3 - 0.5 * skill);
  t.phaseTimer += budget;
  t.note = t.phaseTimer < 15 ? "Mechanic walking the belt" : `Repairing: ${c.breakdown?.cause ?? "overhaul"}`;
  t.progress = Math.min(1, t.phaseTimer / total);
  t.estimatedDuration = Math.max(0, total - t.phaseTimer);
  if (t.phaseTimer >= total) {
    finishConveyorRepair(sim, c, skill);
    completeTask(sim, t);
  }
}

const REPAIR: TaskExecutor = {
  validate(sim, t) {
    if (t.destination?.kind === "conveyor") {
      const c = conveyorById(sim, t.destination.id);
      if (!c) return ["Unknown conveyor"];
      return c.state === "DAMAGED" || c.condition < 60 ? [] : [`${c.name} does not need a repair (condition ${c.condition.toFixed(0)}%)`];
    }
    const eq = sim.equipment(t.assignedEquipmentId);
    if (!eq) return ["Choose the machine to repair"];
    return eq.state === "BROKEN" || eq.condition <= 0 ? [] : [`${eq.name} is not broken down`];
  },
  start(sim, t, eq) {
    t.phase = "callout";
    t.phaseTimer = 0;
    if (eq) t.estimatedDuration = 20 + repairHours(sim, eq) * 60;
  },
  run(sim, t, eq, w, budget) {
    if (t.destination?.kind === "conveyor") return repairConveyor(sim, t, w, budget);
    if (!eq) return;
    if (eq.state !== "BROKEN" && eq.condition > 0) return completeTask(sim, t);
    t.status = "EXECUTING";
    const skill = perf(w, "maintenance");
    const total = 20 + repairHours(sim, eq) * 60 * (1.3 - 0.5 * skill);
    t.phaseTimer += budget;
    t.phase = t.phaseTimer < 20 ? "callout" : "repair";
    t.note = t.phase === "callout" ? "Mechanic driving out" : `Repairing: ${eq.breakdown?.cause ?? "fault"}`;
    t.progress = Math.min(1, t.phaseTimer / total);
    t.estimatedDuration = Math.max(0, total - t.phaseTimer);
    eq.stats.downMin += budget;
    sim.state.today.equipmentDownMin += budget;
    if (t.phaseTimer >= total) {
      eq.state = eq.currentTaskId ? "ASSIGNED" : "AVAILABLE";
      eq.activity = "idle";
      eq.condition = Math.max(eq.condition, 45 + 20 * skill);
      eq.breakdown = null;
      const cost = repairCost(sim, eq);
      sim.spend(cost, "repairs", `Repair ${eq.name}`);
      sim.bus.emit({ type: "EquipmentRepaired", equipmentId: eq.id });
      sim.notify("good", `${eq.name} repaired`, `Back in service at ${eq.condition.toFixed(0)}% condition. Cost $${cost.toLocaleString()}.`, { kind: "equipment", id: eq.id });
      completeTask(sim, t);
    }
  },
};

// ---------------------------------------------------------------- EXPLORE_DRILL

const EXPLORE_DRILL: TaskExecutor = {
  validate(sim, t) {
    const p = targetPoint(sim, t.destination);
    if (!p) return ["Choose a drill site"];
    const { i, j } = sim.terrain.cellOf(p.x, p.z);
    const rect = { i0: i, j0: j, i1: i, j1: j };
    const out: string[] = [];
    const permit = permitProblem(sim, "EXPLORATION", rect) && permitProblem(sim, "SURFACE_MINING", rect);
    if (permit) out.push(permit);
    const r = mineralRightsProblem(sim, rect);
    if (r) out.push(r);
    const eq = sim.equipment(t.assignedEquipmentId);
    const depth = t.params.depth ?? 30;
    if (eq && depth > (sim.def(eq).maxHoleDepthM ?? 40)) out.push(`${eq.name} can drill to ${sim.def(eq).maxHoleDepthM} m`);
    return out;
  },
  start(_sim, t) {
    t.phase = "travel";
    t.params.depth ??= 30;
  },
  run(sim, t, eq, w, budget) {
    if (!eq) return;
    const p = targetPoint(sim, t.destination)!;
    let left = fieldFuel(sim, t, eq, budget);
    if (left <= EPS) return;
    if (t.phase === "travel") {
      eq.activity = "drive";
      eq.state = "TRAVELING";
      t.status = "TRAVELING";
      const r = goTo(sim, t, eq, p.x, p.z, w, left);
      left = r.left;
      if (!r.arrived) return;
      t.phase = "drill";
      t.phaseTimer = 0;
    }
    const def = sim.def(eq);
    const depth = t.params.depth ?? 30;
    const total = 20 + (depth / ((def.coreMph ?? 10) * (0.8 + 0.35 * perf(w, "drilling")))) * 60;
    eq.state = "WORKING";
    eq.activity = "drill";
    t.status = "EXECUTING";
    t.phaseTimer += left;
    runEngine(sim, eq, left, 0.8, w?.skills.equipmentOperation);
    t.progress = Math.min(1, t.phaseTimer / total);
    t.estimatedDuration = Math.max(0, total - t.phaseTimer);
    if (t.phaseTimer >= total) {
      const s = recordCoreSample(sim, p.x, p.z, depth);
      sim.spend(depth * CORE_COST_PER_M, "exploration", `Core hole ${s.id} (${depth} m)`);
      completeTask(sim, t);
    }
  },
};

// ---------------------------------------------------------------- DRILL_PATTERN

const DRILL_PATTERN: TaskExecutor = {
  validate(sim, t) {
    const block = targetBlock(sim, t);
    if (!block) return ["Choose a block"];
    const pattern = sim.state.drillPatterns.find((p) => p.id === t.params.patternId);
    if (!pattern) return ["Design a drill pattern first"];
    if (pattern.completedAt !== null) return ["That pattern has already been drilled"];
    return miningPermit(sim, block);
  },
  start(sim, t) {
    t.phase = "to-hole";
    const block = targetBlock(sim, t);
    if (block && block.state !== "BLASTED" && block.state !== "EXCAVATING") block.state = "DRILLING";
    sim.bus.emit({ type: "DrillStarted", taskId: t.id, blockId: block?.id ?? null });
  },
  run(sim, t, eq, w, budget) {
    if (!eq) return;
    const pattern = sim.state.drillPatterns.find((p) => p.id === t.params.patternId);
    const block = targetBlock(sim, t);
    if (!pattern || !block) return failTask(sim, t, "Pattern or block no longer exists");
    let left = fieldFuel(sim, t, eq, budget);
    for (let guard = 0; guard < 8 && left > EPS; guard++) {
      const idx = pattern.holes.findIndex((h) => !h.drilled);
      if (idx < 0) {
        pattern.completedAt = sim.minute;
        block.state = "BLAST_READY";
        block.patternId = pattern.id;
        sim.bus.emit({ type: "DrillCompleted", taskId: t.id, blockId: block.id });
        const coal = pattern.holes.filter((h) => h.coalAt !== null).length;
        sim.notify("good", `Drilling complete in ${block.name}`, `${pattern.holes.length} holes drilled; ${coal} logged coal. Design and fire the blast next.`, { kind: "block", id: block.id });
        completeTask(sim, t);
        return;
      }
      const hole = pattern.holes[idx]!;
      if (t.phase === "to-hole") {
        eq.activity = "drive";
        eq.state = "TRAVELING";
        t.status = t.progress === 0 ? "TRAVELING" : "EXECUTING";
        if (Math.hypot(eq.x - hole.x, eq.z - hole.z) > 0.5 && arrived(eq)) setDirect(eq, hole.x, hole.z, Math.hypot(eq.x - hole.x, eq.z - hole.z) > 30 ? 12 : 3);
        if (Math.hypot(eq.x - hole.x, eq.z - hole.z) > 30) {
          const r = goTo(sim, t, eq, hole.x, hole.z, w, left, 0.5);
          left = r.left;
          if (!r.arrived) return;
        } else {
          left = travel(sim, eq, left, w);
          if (!arrived(eq)) return;
        }
        t.phase = "drilling";
        t.phaseTimer = 0;
        t.scratch.holeMin = holeMinutes(sim, eq, pattern, hole, perf(w, "drilling"));
      }
      eq.state = "WORKING";
      eq.activity = "drill";
      t.status = "EXECUTING";
      const need = (t.scratch.holeMin ?? 10) - t.phaseTimer;
      const use = Math.min(need, left);
      t.phaseTimer += use;
      left -= use;
      runEngine(sim, eq, use, 0.85, w?.skills.equipmentOperation);
      if (isBroken(eq)) return;
      if (t.phaseTimer >= (t.scratch.holeMin ?? 10) - EPS) {
        completeHole(sim, pattern, hole);
        t.phase = "to-hole";
        t.progress = patternProgress(pattern);
      }
      const remaining = pattern.holes.filter((h) => !h.drilled).length;
      t.estimatedDuration = remaining * (t.scratch.holeMin ?? 10) + remaining * 1.5;
    }
  },
};

// ---------------------------------------------------------------- BLAST

function blastWindowProblem(sim: Sim): string | null {
  const h = sim.clock.hourOfDay;
  const { blastStartHour, blastEndHour } = sim.state.shift;
  if (h < blastStartHour || h >= blastEndHour) return `Blasting is only permitted between ${String(blastStartHour).padStart(2, "0")}:00 and ${blastEndHour}:00`;
  return null;
}

const BLAST: TaskExecutor = {
  validate(sim, t) {
    const block = targetBlock(sim, t);
    if (!block) return ["Choose a block"];
    const blast = sim.state.blasts.find((b) => b.id === t.params.blastId);
    if (!blast) return ["Design the blast first"];
    if (blast.state === "COMPLETED") return ["That blast has already been fired"];
    const pattern = sim.state.drillPatterns.find((p) => p.id === blast.patternId);
    const out: string[] = [];
    const p = permitProblem(sim, "BLASTING", block.rect);
    if (p) out.push(p);
    out.push(...miningPermit(sim, block));
    if (pattern && pattern.completedAt === null) {
      const drillTask = sim.state.tasks.find((x) => x.type === "DRILL_PATTERN" && x.params.patternId === pattern.id && !TERMINAL.has(x.status));
      if (!drillTask || !t.prerequisites.includes(drillTask.id)) out.push(`The pattern in ${block.name} is not fully drilled (${Math.round(patternProgress(pattern) * 100)}%)`);
    }
    return out;
  },
  check(sim, t) {
    if (t.phase === "clear" || t.phase === "fire") {
      if (!weatherEffects(sim.state.weather.kind).blastingAllowed) return `No blasting in ${weatherEffects(sim.state.weather.kind).label.toLowerCase()}`;
      return blastWindowProblem(sim);
    }
    return null;
  },
  start(sim, t) {
    t.phase = "travel";
    t.phaseTimer = 0;
    const blast = sim.state.blasts.find((b) => b.id === t.params.blastId);
    if (blast) blast.state = "APPROVED";
  },
  run(sim, t, _eq, w, budget) {
    const block = targetBlock(sim, t)!;
    const blast = sim.state.blasts.find((b) => b.id === t.params.blastId)!;
    const pattern = sim.state.drillPatterns.find((p) => p.id === blast.patternId)!;
    t.status = "EXECUTING";
    let left = budget;
    if (t.phase === "travel") {
      t.status = "TRAVELING";
      t.note = "Blaster driving to the bench";
      t.phaseTimer += left;
      left = Math.max(0, t.phaseTimer - 10);
      if (t.phaseTimer < 10) return;
      t.phase = "load";
      t.phaseTimer = 0;
      t.status = "EXECUTING";
    }
    if (t.phase === "load") {
      const total = pattern.holes.length * 2.5 * (1.25 - 0.4 * perf(w, "blasting"));
      t.note = `Loading holes (${Math.min(pattern.holes.length, Math.floor((t.phaseTimer / total) * pattern.holes.length))}/${pattern.holes.length})`;
      t.phaseTimer += left;
      t.progress = Math.min(0.8, (t.phaseTimer / total) * 0.8);
      t.estimatedDuration = Math.max(0, total - t.phaseTimer) + 15;
      if (t.phaseTimer < total) return;
      blast.state = "READY";
      t.phase = "clear";
      t.phaseTimer = 0;
    }
    if (t.phase === "clear") {
      const c = blockCenter(sim, block);
      sim.state.blastHold = { taskId: t.id, blockId: block.id, x: c.x, z: c.z, radius: BLAST_EXCLUSION_M };
      const inside = sim.state.equipment.filter((e) => Math.hypot(e.x - c.x, e.z - c.z) < BLAST_EXCLUSION_M);
      if (inside.length) {
        t.note = `Clearing the blast zone: ${inside.map((e) => `${e.name} (${Math.round(Math.hypot(e.x - c.x, e.z - c.z))} m)`).join(", ")}`;
        return;
      }
      t.phase = "fire";
    }
    if (t.phase === "fire") {
      blast.state = "EXECUTING";
      executeBlast(sim, blast, pattern, block);
      t.phase = "inspect";
      t.phaseTimer = 0;
      t.progress = 0.9;
      t.note = "Post-blast inspection";
      return;
    }
    if (t.phase === "inspect") {
      t.phaseTimer += left;
      if (t.phaseTimer >= 10) {
        sim.state.blastHold = null;
        for (const e of sim.state.equipment) {
          if (e.evacuating) {
            e.evacuating = false;
            e.route = null;
            e.speed = 0;
            if (!e.currentTaskId && e.state !== "BROKEN") e.activity = "idle";
          }
        }
        completeTask(sim, t);
      }
    }
  },
  cancel(sim, t) {
    if (sim.state.blastHold?.taskId === t.id) {
      sim.state.blastHold = null;
      for (const e of sim.state.equipment) e.evacuating = false;
    }
  },
};

/**
 * While a blast is being cleared, every machine inside the exclusion zone drives out to its edge,
 * and machines whose work lies inside the zone hold. Runs before the task system each tick.
 */
export function blastClearance(sim: Sim): void {
  const hold = sim.state.blastHold;
  if (!hold) return;
  for (const eq of sim.state.equipment) {
    const d = Math.hypot(eq.x - hold.x, eq.z - hold.z);
    const task = sim.task(eq.currentTaskId);
    const target = task && task.scratch.tx !== undefined ? Math.hypot(task.scratch.tx - hold.x, (task.scratch.tz ?? 0) - hold.z) : Infinity;
    if (d >= hold.radius + 2 && target >= hold.radius) continue;
    if (eq.state === "BROKEN") continue;
    if (!eq.evacuating) {
      eq.evacuating = true;
      eq.route = null;
    }
    if (d < hold.radius + 2) {
      if (!eq.route) {
        const ux = d > 1 ? (eq.x - hold.x) / d : 1;
        const uz = d > 1 ? (eq.z - hold.z) / d : 0;
        const t = sim.terrain;
        const sx = Math.max(t.state.originX + 4, Math.min(t.state.originX + t.width - 4, hold.x + ux * (hold.radius + 20)));
        const sz = Math.max(t.state.originZ + 4, Math.min(t.state.originZ + t.depth - 4, hold.z + uz * (hold.radius + 20)));
        setDestination(sim, eq, sx, sz);
      }
      eq.activity = "drive";
      travel(sim, eq, sim.dt, sim.worker(eq.operatorId));
    } else {
      eq.speed = 0;
      eq.activity = "idle";
    }
  }
}

// ---------------------------------------------------------------- STRIP_TOPSOIL (dozer)

function topsoilCells(sim: Sim, block: MiningBlock): number[] {
  const t = sim.terrain;
  const g = sim.state.geology;
  const out: number[] = [];
  for (let j = block.rect.j0; j <= block.rect.j1; j++) {
    for (let i = block.rect.i0; i <= block.rect.i1; i++) {
      const k = t.index(i, j);
      if (t.state.fill[k]! > 0.01) continue;
      const s = t.state.surface[k]!;
      if (s > g.topsoilBase[k]! + 0.02 && s > g.seamTop[k]! + 0.02) out.push(k);
    }
  }
  return out;
}

const STRIP_TOPSOIL: TaskExecutor = {
  validate(sim, t) {
    const block = targetBlock(sim, t);
    if (!block) return ["Choose a block"];
    const out = miningPermit(sim, block);
    const dumpId = t.params.topsoilDumpId ?? sim.state.dumps.find((d) => d.accepts === "TOPSOIL")?.id;
    if (!dumpId) out.push("The mine has no topsoil stockpile area");
    if (topsoilCells(sim, block).length === 0) out.push(`No topsoil left in ${block.name}`);
    return out;
  },
  start(sim, t) {
    t.phase = "travel";
    t.params.topsoilDumpId ??= sim.state.dumps.find((d) => d.accepts === "TOPSOIL")?.id;
    const block = targetBlock(sim, t);
    if (block && block.state === "UNMINED") block.state = "PREPARING";
    if (block) t.scratch.total = Math.max(1, topsoilCells(sim, block).length);
  },
  run(sim, t, eq, w, budget) {
    if (!eq) return;
    const block = targetBlock(sim, t)!;
    const dump = sim.dump(t.params.topsoilDumpId)!;
    const tr = sim.terrain;
    let left = fieldFuel(sim, t, eq, budget);
    if (left <= EPS) return;
    if (t.phase === "travel") {
      const c = blockCenter(sim, block);
      eq.activity = "drive";
      eq.state = "TRAVELING";
      t.status = "TRAVELING";
      const r = goTo(sim, t, eq, c.x, c.z, w, left, 3);
      left = r.left;
      if (!r.arrived) return;
      t.phase = "push";
    }
    eq.state = "WORKING";
    eq.activity = "push";
    t.status = "EXECUTING";
    const def = sim.def(eq);
    const cells = topsoilCells(sim, block);
    if (cells.length === 0) {
      if (block.state === "PREPARING") block.state = "UNMINED";
      sim.notify("good", `Topsoil stripped in ${block.name}`, `${Math.round(block.topsoilSalvagedT).toLocaleString()} t salvaged for reclamation.`, { kind: "block", id: block.id });
      return completeTask(sim, t);
    }
    // Long pushes are slow: dozers move material efficiently only over short distances.
    const dp = dumpPoint(sim, dump);
    const c = blockCenter(sim, block);
    const pushDist = dp ? Math.hypot(dp.x - c.x, dp.z - c.z) : 100;
    const rate = (def.stripRateM3h ?? 200) * Math.max(0.3, Math.min(1, 70 / pushDist)) * (0.7 + 0.45 * perf(w, "equipmentOperation")) * (eq.condition < 40 ? 0.8 : 1);
    let m3 = (rate * left) / 60;
    runEngine(sim, eq, left, 0.95, w?.skills.equipmentOperation);
    const g = sim.state.geology;
    for (const k of cells) {
      if (m3 <= 1e-4) break;
      const s = tr.state.surface[k]!;
      const dz = Math.min(s - Math.max(g.topsoilBase[k]!, g.seamTop[k]!), m3 / tr.cellArea, 0.2);
      if (dz <= 0) continue;
      tr.state.surface[k] = s - dz;
      tr.state.disturbed[k] = 1;
      const i = k % tr.cols;
      const j = Math.floor(k / tr.cols);
      tr.markDirty(i, j);
      m3 -= dz * tr.cellArea;
      const tonnes = dz * tr.cellArea * 1.6;
      block.topsoilSalvagedT += tonnes;
      sim.state.today.topsoilT += tonnes;
      if (dp) placeInDump(sim, dump, { type: "TOPSOIL", tonnes, quality: null }, dp.x, dp.z);
      // The dozer works back and forth across the strip being cut.
      eq.heading = Math.atan2(tr.cellX(i) - eq.x, tr.cellZ(j) - eq.z);
      eq.x += (tr.cellX(i) - eq.x) * 0.15;
      eq.z += (tr.cellZ(j) - eq.z) * 0.15;
    }
    t.progress = 1 - cells.length / (t.scratch.total ?? cells.length);
  },
};

// ---------------------------------------------------------------- EXCAVATE

function haulTasksFor(sim: Sim, excavateTaskId: string): Task[] {
  return sim.state.tasks.filter((x) => x.type === "HAUL" && x.source?.kind === "task" && x.source.id === excavateTaskId && !TERMINAL.has(x.status));
}

/** Truck queue for an excavator, in arrival order. */
function queueOf(sim: Sim, excavateTaskId: string): Task[] {
  return haulTasksFor(sim, excavateTaskId)
    .filter((x) => (x.phase === "queue" || x.phase === "loading") && x.status !== "BLOCKED")
    .sort((a, b) => (a.scratch.qt ?? 0) - (b.scratch.qt ?? 0) || (a.id < b.id ? -1 : 1));
}

/** Where trucks spot for loading: beside the excavator, on the side facing the haul exit. */
export function loadingSpot(sim: Sim, ex: Task): { x: number; z: number; dx: number; dz: number } | null {
  const eq = sim.equipment(ex.assignedEquipmentId);
  if (!eq) return null;
  const exitX = ex.scratch.exitX ?? eq.x + 1;
  const exitZ = ex.scratch.exitZ ?? eq.z;
  let dx = exitX - eq.x;
  let dz = exitZ - eq.z;
  const d = Math.hypot(dx, dz) || 1;
  dx /= d;
  dz /= d;
  return { x: eq.x + dx * SPOT_OFFSET, z: eq.z + dz * SPOT_OFFSET, dx, dz };
}

function releaseTruck(_sim: Sim, haul: Task, truck: EquipmentInstance): void {
  haul.phase = "to-dump";
  haul.scratch.qt = 0;
  delete haul.scratch.dumpK;
  truck.state = "HAULING";
  truck.route = null;
}

const EXCAVATE: TaskExecutor = {
  validate(sim, t) {
    const block = targetBlock(sim, t);
    if (!block) return ["Choose a block"];
    const mode = t.params.mode ?? "OVERBURDEN";
    const out = miningPermit(sim, block);
    const status = digStatus(sim, block, mode);
    if (status === "done") out.push(mode === "OVERBURDEN" ? `No overburden left in ${block.name}` : `No coal left in ${block.name}`);
    return out;
  },
  check(sim, t) {
    const block = targetBlock(sim, t);
    return block ? (miningPermit(sim, block)[0] ?? null) : "Block no longer exists";
  },
  start(sim, t) {
    const block = targetBlock(sim, t)!;
    const mode = t.params.mode ?? "OVERBURDEN";
    t.params.mode = mode;
    t.materialType = mode === "COAL" ? "COAL_RAW" : "OVERBURDEN";
    t.phase = "to-face";
    const a = analyzeBlock(sim, block);
    t.scratch.target = mode === "COAL" ? a.coalT * 0.95 : a.overburdenT;
    block.state = mode === "COAL" ? "COAL_MINING" : "EXCAVATING";
    // Haul exit: toward the nearest road node from the block centre.
    const c = blockCenter(sim, block);
    let best = { x: c.x + 50, z: c.z };
    let bd = Infinity;
    for (const n of sim.state.roadNodes) {
      const d = Math.hypot(n.x - c.x, n.z - c.z);
      if (d < bd) {
        bd = d;
        best = { x: n.x, z: n.z };
      }
    }
    t.scratch.exitX = best.x;
    t.scratch.exitZ = best.z;
  },
  run(sim, t, eq, w, budget) {
    if (!eq) return;
    const block = targetBlock(sim, t)!;
    const mode = t.params.mode ?? "OVERBURDEN";
    const def = sim.def(eq);
    const tr = sim.terrain;
    let left = fieldFuel(sim, t, eq, budget);
    for (let guard = 0; guard < 12 && left > EPS; guard++) {
      if (t.phase === "to-face") {
        const near: Reach = { x: eq.x, z: eq.z, reach: EXCAVATOR_REACH };
        if (nextDigCell(sim, block, mode, near) !== null && arrived(eq) && t.scratch.face === 1) {
          t.phase = "dig";
          continue;
        }
        const k = nextDigCell(sim, block, mode);
        if (k === null) {
          const status = digStatus(sim, block, mode);
          if (status === "done") return finishExcavation(sim, t, block);
          if (status === "unblasted") return blockTask(sim, t, `${block.name}: the remaining ${Math.round(unblastedTonnes(sim, block)).toLocaleString()} t of overburden is unblasted rock. Drill and blast it`);
          return blockTask(sim, t, `${block.name}: the coal is not exposed yet. Remove the overburden first`);
        }
        const x = tr.cellX(k % tr.cols);
        const z = tr.cellZ(Math.floor(k / tr.cols));
        eq.activity = "drive";
        eq.state = "TRAVELING";
        t.status = t.materialAmount > 0 ? "EXECUTING" : "TRAVELING";
        const r = goTo(sim, t, eq, x, z, w, left, 2);
        left = r.left;
        if (!r.arrived) return;
        t.scratch.face = 1;
        t.phase = "dig";
        continue;
      }
      // dig
      t.status = "EXECUTING";
      const near: Reach = { x: eq.x, z: eq.z, reach: EXCAVATOR_REACH };
      const queue = queueOf(sim, t.id);
      const spot = loadingSpot(sim, t);
      const head = queue[0];
      const truck = head ? sim.equipment(head.assignedEquipmentId) : null;
      const spotted = truck && spot && Math.hypot(truck.x - spot.x, truck.z - spot.z) < 3 && arrived(truck) ? truck : null;
      const status = digStatus(sim, block, mode);
      if (status !== "ok") {
        if (status === "done") return finishExcavation(sim, t, block);
        // Send away a partly loaded truck rather than strand it.
        if (spotted && head && spotted.payload && spotted.payload.tonnes > 1) releaseTruck(sim, head, spotted);
        if (status === "unblasted") return blockTask(sim, t, `${block.name}: the remaining ${Math.round(unblastedTonnes(sim, block)).toLocaleString()} t of overburden is unblasted rock. Drill and blast it`);
        return blockTask(sim, t, `${block.name}: the coal is not exposed yet. Remove the overburden first`);
      }
      if (nextDigCell(sim, block, mode, near) === null) {
        if (spotted && head && spotted.payload && spotted.payload.tonnes > 1) releaseTruck(sim, head, spotted);
        t.phase = "to-face";
        t.scratch.face = 0;
        continue;
      }
      if (!spotted || !head) {
        eq.state = "WAITING";
        eq.activity = "idle";
        t.note = haulTasksFor(sim, t.id).length ? "Waiting for the next haul truck" : "Waiting for haul trucks: assign a truck to haul from this excavator";
        idle(sim, eq, left, w);
        return;
      }
      t.note = null;
      head.phase = "loading";
      spotted.state = "LOADING";
      eq.state = "LOADING";
      eq.activity = "dig";
      // Face the truck between buckets.
      const frag = block.fragmentation ?? 0.6;
      const k = nextDigCell(sim, block, mode, near)!;
      const rock = surfaceMaterialIsRock(sim, k);
      const digRate =
        (rock ? (0.55 + 0.45 * frag) * Math.pow(sim.catalog.modifier(eq.upgrades, "roughDig"), 1 - frag) : 1) *
        (0.72 + 0.4 * perf(w, "equipmentOperation")) *
        (eq.condition < 40 ? 0.85 : 1) *
        weatherEffects(sim.state.weather.kind).speed ** 0.5;
      const cycle = (def.cycleSeconds ?? 30) / 60 / digRate;
      const need = cycle - t.phaseTimer;
      if (need > left) {
        t.phaseTimer += left;
        runEngine(sim, eq, left, 1, w?.skills.equipmentOperation);
        left = 0;
        break;
      }
      left -= need;
      runEngine(sim, eq, need, 1, w?.skills.equipmentOperation);
      t.phaseTimer = 0;
      if (isBroken(eq)) return;
      const bucket = (def.bucketM3 ?? 5) * 0.92 * sim.catalog.modifier(eq.upgrades, "bucket");
      const out = digBucket(sim, block, mode, bucket, near);
      if (out.kind !== "ok") {
        t.phase = out.kind === "out-of-reach" ? "to-face" : "dig";
        t.scratch.face = 0;
        continue;
      }
      spotted.payload = mergeParcel(spotted.payload, out.parcel);
      eq.heading = Math.atan2(spotted.x - eq.x, spotted.z - eq.z);
      t.materialAmount += out.parcel.tonnes;
      t.scratch.lastBucket = out.parcel.tonnes;
      eq.stats.tonnesMoved += out.parcel.tonnes;
      sim.bus.emit({ type: "MaterialLoaded", equipmentId: spotted.id, material: out.parcel.type, tonnes: out.parcel.tonnes });
      if (mode === "COAL") {
        block.coalMinedT += out.parcel.tonnes;
        block.coalLostT += out.coalLostT;
        sim.state.today.coalMinedT += out.parcel.tonnes;
      } else {
        block.overburdenMovedT += out.parcel.tonnes;
        if (out.parcel.type === "TOPSOIL") sim.state.today.topsoilT += out.parcel.tonnes;
        else sim.state.today.overburdenT += out.parcel.tonnes;
      }
      t.progress = Math.min(0.99, t.materialAmount / Math.max(1, t.scratch.target ?? 1));
      const cap = payloadCapacity(sim, spotted, spotted.payload.type);
      if (spotted.payload.tonnes >= cap - 0.55 * out.parcel.tonnes) {
        spotted.stats.loads++;
        eq.stats.loads++;
        releaseTruck(sim, head, spotted);
      }
    }
    const remaining = Math.max(0, (t.scratch.target ?? 0) - t.materialAmount);
    const perHour = (60 / ((def.cycleSeconds ?? 30) / 60)) * (def.bucketM3 ?? 5) * 1.6 * 0.6;
    t.estimatedDuration = (remaining / Math.max(1, perHour)) * 60;
  },
};

function finishExcavation(sim: Sim, t: Task, block: MiningBlock): void {
  const mode = t.params.mode ?? "OVERBURDEN";
  if (mode === "OVERBURDEN") block.state = "EXCAVATING";
  refreshBlockState(sim, block);
  for (const h of haulTasksFor(sim, t.id)) {
    const truck = sim.equipment(h.assignedEquipmentId);
    if (truck?.payload && truck.payload.tonnes > 1 && (h.phase === "loading" || h.phase === "queue")) releaseTruck(sim, h, truck);
  }
  completeTask(sim, t);
}

// ---------------------------------------------------------------- HAUL

function haulDestination(sim: Sim, t: Task, truck: EquipmentInstance): { kind: "dump" | "stockpile" | "hopper"; id: string; x: number; z: number } | string {
  const cls = truck.payload ? haulClass(truck.payload.type) : "SPOIL";
  if (cls === "COAL" && t.params.coalHopperId) {
    const h = hopperById(sim, t.params.coalHopperId);
    if (!h) return "The hopper for this haul no longer exists";
    // Trucks back up to the hopper's tipping side.
    return { kind: "hopper", id: h.id, x: h.x - 7, z: h.z };
  }
  if (cls === "COAL") {
    const s = sim.stockpile(t.params.coalStockpileId);
    if (!s) return "No coal stockpile set for this haul";
    // Trucks tip around the toe of the pile, not into its centre.
    const a = (Number(truck.id.replace(/\D/g, "")) * 2.4) % (Math.PI * 2);
    const r = 6 + Math.sqrt(Math.max(0, s.tonnes)) * 0.12;
    return { kind: "stockpile", id: s.id, x: s.x + Math.cos(a) * r, z: s.z + Math.sin(a) * r };
  }
  const dumpId = cls === "TOPSOIL" ? (t.params.topsoilDumpId ?? t.params.spoilDumpId) : t.params.spoilDumpId;
  const d = sim.dump(dumpId);
  if (!d) return "No spoil dump set for this haul";
  if (t.scratch.dumpK !== undefined) {
    const k = t.scratch.dumpK;
    return { kind: "dump", id: d.id, x: sim.terrain.cellX(k % sim.terrain.cols), z: sim.terrain.cellZ(Math.floor(k / sim.terrain.cols)) };
  }
  const src = sim.task(t.source?.kind === "task" ? t.source.id : null);
  const ex = sim.equipment(src?.assignedEquipmentId);
  const p = dumpPoint(sim, d, ex ? { x: ex.x, z: ex.z } : { x: truck.x, z: truck.z });
  if (!p) return `${d.name} is full`;
  t.scratch.dumpK = p.k;
  return { kind: "dump", id: d.id, x: p.x, z: p.z };
}

const HAUL: TaskExecutor = {
  validate(sim, t) {
    const out: string[] = [];
    const src = t.source?.kind === "task" ? sim.task(t.source.id) : null;
    if (!src || src.type !== "EXCAVATE") out.push("Choose the excavator this truck hauls from");
    else if (TERMINAL.has(src.status)) out.push(`The excavation task (${src.label}) has ended`);
    const spoil = t.params.spoilDumpId ?? sim.state.dumps.find((d) => d.accepts === "SPOIL")?.id;
    const coal = t.params.coalStockpileId ?? sim.state.stockpiles.find((s) => s.materialType === "COAL_RAW")?.id;
    if (src?.params.mode === "COAL" && !coal) out.push("The mine has no coal stockpile");
    if (src?.params.mode !== "COAL" && !spoil) out.push("The mine has no spoil dump");
    return out;
  },
  start(sim, t, eq) {
    t.params.spoilDumpId ??= sim.state.dumps.find((d) => d.accepts === "SPOIL")?.id;
    t.params.coalStockpileId ??= sim.state.stockpiles.find((s) => s.materialType === "COAL_RAW")?.id;
    t.params.topsoilDumpId ??= sim.state.dumps.find((d) => d.accepts === "TOPSOIL")?.id;
    const src = sim.task(t.source?.kind === "task" ? t.source.id : null);
    t.materialType = src?.materialType ?? null;
    t.phase = eq?.payload && eq.payload.tonnes > 1 ? "to-dump" : "to-loader";
  },
  run(sim, t, eq, w, budget) {
    if (!eq) return;
    const src = sim.task(t.source?.kind === "task" ? t.source.id : null);
    const srcEnded = !src || TERMINAL.has(src.status);
    const def = sim.def(eq);
    let left = budget;
    for (let guard = 0; guard < 10 && left > EPS; guard++) {
      switch (t.phase) {
        case "to-loader": {
          if (srcEnded) {
            if (eq.payload && eq.payload.tonnes > 1) {
              t.phase = "to-dump";
              continue;
            }
            return completeTask(sim, t);
          }
          if (sim.state.settings.autoFuel && eq.fuelL / def.fuelCapacityL < 0.18 && sim.facilityOfType("FUEL")) {
            sim.bus.emit({ type: "LowFuel", equipmentId: eq.id });
            t.phase = "to-fuel";
            continue;
          }
          const spot = loadingSpot(sim, src!);
          if (!spot) {
            idle(sim, eq, left, w);
            t.note = "Waiting for the excavator to be assigned";
            return;
          }
          t.note = null;
          eq.activity = "drive";
          eq.state = "TRAVELING";
          t.status = "TRAVELING";
          // Approach the back of the queue, not the loading spot itself.
          const rank = queueOf(sim, src!.id).length;
          const qx = spot.x + spot.dx * QUEUE_SPACING * Math.min(rank, 3);
          const qz = spot.z + spot.dz * QUEUE_SPACING * Math.min(rank, 3);
          const r = goTo(sim, t, eq, qx, qz, w, left, 3);
          left = r.left;
          if (!r.arrived) return;
          t.phase = "queue";
          t.scratch.qt = sim.clock.state.tick;
          continue;
        }
        case "queue":
        case "loading": {
          t.status = "EXECUTING";
          if (srcEnded || src!.status === "BLOCKED") {
            if (eq.payload && eq.payload.tonnes > 1) {
              t.phase = "to-dump";
              continue;
            }
            if (srcEnded) return completeTask(sim, t);
            // Engine off: operators do not idle a truck behind a stopped excavator.
            t.note = `Excavator stopped: ${src!.blockedReason ?? ""}`;
            eq.state = "WAITING";
            eq.activity = "idle";
            eq.speed = 0;
            return;
          }
          if (t.phase === "queue" && sim.state.settings.autoFuel && eq.fuelL / def.fuelCapacityL < 0.12 && sim.facilityOfType("FUEL")) {
            t.phase = "to-fuel";
            t.scratch.qt = 0;
            continue;
          }
          const spot = loadingSpot(sim, src!);
          const queue = queueOf(sim, src!.id);
          const rank = Math.max(0, queue.findIndex((x) => x.id === t.id));
          if (spot) {
            const qx = spot.x + spot.dx * QUEUE_SPACING * rank;
            const qz = spot.z + spot.dz * QUEUE_SPACING * rank;
            if (Math.hypot(eq.x - qx, eq.z - qz) > 2.5 || !arrived(eq)) {
              if (arrived(eq) || Math.hypot((t.scratch.tx ?? 0) - qx, (t.scratch.tz ?? 0) - qz) > 2) {
                setDirect(eq, qx, qz, 8);
                t.scratch.tx = qx;
                t.scratch.tz = qz;
              }
              eq.activity = "drive";
              left = travel(sim, eq, left, w);
              if (!arrived(eq)) return;
            }
            // Spotted trucks face away from the excavator, ready to pull out.
            if (rank === 0) eq.heading = Math.atan2(spot.dx, spot.dz);
          }
          eq.state = t.phase === "loading" ? "LOADING" : "WAITING";
          eq.activity = "idle";
          t.note = rank === 0 ? (t.phase === "loading" ? "Being loaded" : "Spotted at the excavator") : `Queued at the excavator (#${rank + 1})`;
          idle(sim, eq, left, w);
          return;
        }
        case "to-dump": {
          if (!eq.payload || eq.payload.tonnes <= 1) {
            eq.payload = null;
            t.phase = "to-loader";
            continue;
          }
          const dest = haulDestination(sim, t, eq);
          if (typeof dest === "string") return blockTask(sim, t, dest);
          t.note = null;
          eq.activity = "drive";
          eq.state = "HAULING";
          t.status = "EXECUTING";
          const r = goTo(sim, t, eq, dest.x, dest.z, w, left, 2);
          left = r.left;
          if (!r.arrived) return;
          t.phase = "dumping";
          t.phaseTimer = 0;
          continue;
        }
        case "dumping": {
          eq.state = "UNLOADING";
          eq.activity = "dump";
          const total = def.dumpMinutes ?? 1;
          const use = Math.min(left, total - t.phaseTimer);
          t.phaseTimer += use;
          left -= use;
          runEngine(sim, eq, use, 0.6, w?.skills.equipmentOperation);
          if (t.phaseTimer < total - EPS) return;
          const dest = haulDestination(sim, t, eq);
          if (typeof dest === "string") return blockTask(sim, t, dest);
          const parcel = eq.payload!;
          let rest = 0;
          if (dest.kind === "hopper") {
            const h = hopperById(sim, dest.id)!;
            const c = conveyorById(sim, h.conveyorId);
            rest = addToHopper(h, parcel);
            // Coal is accounted to the gram: any remainder stays on the truck until it fits.
            if (rest > 1e-9) {
              // A full hopper is normal operation: tip what fits and wait for the belt to draw it down.
              if (rest < parcel.tonnes - 0.01) {
                sim.bus.emit({ type: "MaterialDumped", equipmentId: eq.id, material: parcel.type, tonnes: parcel.tonnes - rest, destination: h.id });
                t.materialAmount += parcel.tonnes - rest;
                eq.stats.tonnesMoved += parcel.tonnes - rest;
              }
              eq.payload = { ...parcel, tonnes: rest };
              t.phaseTimer = total;
              if (!c || c.state === "DAMAGED" || c.state === "MAINTENANCE" || !c.enabled) {
                return blockTask(sim, t, `${h.name} is full and ${c?.name ?? "its conveyor"} is ${!c ? "gone" : !c.enabled ? "switched off" : "down"}`);
              }
              t.note = `Waiting for space in ${h.name} (${Math.round(h.tonnes)}/${h.capacityT} t)`;
              eq.state = "WAITING";
              eq.activity = "idle";
              idle(sim, eq, left, w);
              return;
            }
          } else if (dest.kind === "stockpile") rest = addToStockpile(sim, sim.stockpile(dest.id)!, parcel);
          else rest = placeInDump(sim, sim.dump(dest.id)!, parcel, eq.x, eq.z);
          const dumped = parcel.tonnes - rest;
          sim.bus.emit({ type: "MaterialDumped", equipmentId: eq.id, material: parcel.type, tonnes: dumped, destination: dest.id });
          t.materialAmount += dumped;
          eq.stats.tonnesMoved += dumped;
          if (rest > 0.5 || (dest.kind === "stockpile" && rest > 1e-9)) {
            eq.payload = { ...parcel, tonnes: rest };
            delete t.scratch.dumpK;
            t.phaseTimer = total;
            const name = dest.kind === "stockpile" ? sim.stockpile(dest.id)!.name : dest.kind === "hopper" ? hopperById(sim, dest.id)!.name : sim.dump(dest.id)!.name;
            return blockTask(sim, t, `${name} is full: ${Math.round(rest)} t of ${MATERIAL_LABEL[parcel.type].toLowerCase()} still on board`);
          }
          eq.payload = null;
          delete t.scratch.dumpK;
          t.phase = "to-loader";
          t.phaseTimer = 0;
          t.progress = src ? src.progress : 1;
          continue;
        }
        case "to-fuel": {
          const f = sim.facilityOfType("FUEL", eq.x, eq.z)!;
          eq.activity = "drive";
          eq.state = "TRAVELING";
          t.note = "Refuelling";
          const r = goTo(sim, t, eq, f.x + 6, f.z + 4, w, left);
          left = r.left;
          if (!r.arrived) return;
          t.phase = "fueling";
          continue;
        }
        case "fueling": {
          eq.state = "FUELING";
          eq.activity = "fuel";
          const litres = Math.min(def.fuelCapacityL - eq.fuelL, FUEL_RATE_LPM * left);
          eq.fuelL += litres;
          left -= litres / FUEL_RATE_LPM;
          sim.spend(litres * sim.state.fuelPricePerL, "fuel", `Refuel ${eq.name}`);
          if (eq.fuelL >= def.fuelCapacityL - 0.5) {
            t.phase = eq.payload && eq.payload.tonnes > 1 ? "to-dump" : "to-loader";
            t.note = null;
          }
          continue;
        }
        default:
          t.phase = "to-loader";
      }
    }
  },
};

// ---------------------------------------------------------------- CONSTRUCT (spec §63)

function projectOf(sim: Sim, t: Task) {
  return t.destination?.kind === "project" ? (sim.state.projects.find((p) => p.id === (t.destination as { id: string }).id) ?? null) : null;
}

/** Contractor crews work the day shift, like the mine. */
function crewOnSite(sim: Sim): boolean {
  const { startHour, lengthHours } = sim.state.shift;
  const h = sim.clock.hourOfDay;
  const end = startHour + lengthHours;
  return end <= 24 ? h >= startHour && h < end : h >= startHour || h < end - 24;
}

const CONSTRUCT: TaskExecutor = {
  validate(sim, t) {
    const p = projectOf(sim, t);
    if (!p) return ["Choose a construction project"];
    if (p.status === "COMPLETE") return [`${p.name} is already complete`];
    if (p.status === "CANCELLED") return [`${p.name} was cancelled`];
    const other = sim.state.tasks.find((x) => x !== t && x.type === "CONSTRUCT" && x.destination?.kind === "project" && x.destination.id === p.id && !TERMINAL.has(x.status));
    if (other && t.id !== "draft" && other.createdAt < t.createdAt) return [`${p.name} is already being built (${other.id})`];
    if (other && t.id === "draft") return [`${p.name} is already being built (${other.id})`];
    return [];
  },
  check(sim, t) {
    const p = projectOf(sim, t);
    return p && p.status === "CANCELLED" ? `${p.name} was cancelled` : null;
  },
  start(_sim, t, eq) {
    t.phase = eq ? "travel" : "work";
  },
  run(sim, t, eq, w, budget) {
    const p = projectOf(sim, t);
    if (!p || p.status === "CANCELLED") return failTask(sim, t, "The project was cancelled");
    t.estimatedDuration = Math.max(0, (1 - p.progress) * p.workMinutes);
    if (!eq) {
      // Contractor crew: day shift only.
      t.status = "EXECUTING";
      if (!crewOnSite(sim)) {
        t.note = `Contractor crew off site until ${String(sim.state.shift.startHour).padStart(2, "0")}:00`;
        return;
      }
      t.note = "Contractor crew on site";
      if (workOnProject(sim, p, budget, 1)) completeTask(sim, t);
      t.progress = p.progress;
      return;
    }
    let left = fieldFuel(sim, t, eq, budget);
    if (left <= EPS) return;
    if (t.phase === "travel") {
      const at = alongPath(p, p.progress);
      eq.activity = "drive";
      eq.state = "TRAVELING";
      t.status = "TRAVELING";
      const r = goTo(sim, t, eq, at.x, at.z, w, left, 3);
      left = r.left;
      if (!r.arrived) return;
      t.phase = "work";
    }
    t.status = "EXECUTING";
    eq.state = "WORKING";
    eq.activity = "push";
    t.note = null;
    const rate = (0.7 + 0.45 * perf(w, "equipmentOperation")) * (eq.condition < 40 ? 0.8 : 1);
    runEngine(sim, eq, left, 0.9, w?.skills.equipmentOperation);
    if (isBroken(eq)) return;
    const done = workOnProject(sim, p, left, rate);
    // The dozer works its way along the alignment.
    const at = alongPath(p, p.progress);
    const a = p.path[0]!;
    const b = p.path[p.path.length - 1]!;
    eq.heading = Math.atan2(b.x - a.x, b.z - a.z);
    eq.x = at.x;
    eq.z = at.z;
    t.progress = p.progress;
    if (done) completeTask(sim, t);
  },
};

// ---------------------------------------------------------------- GRADE_ROAD (spec §22)

const GRADE_ROAD: TaskExecutor = {
  validate(sim, t) {
    if (t.destination?.kind !== "road") return ["Choose a haul road"];
    const id = t.destination.id;
    return sim.state.roadEdges.some((e) => e.id === id) ? [] : ["Unknown haul road"];
  },
  start(_sim, t) {
    t.phase = "to-start";
  },
  run(sim, t, eq, w, budget) {
    if (!eq) return;
    const edge = sim.state.roadEdges.find((e) => e.id === (t.destination as { id: string }).id);
    const a = edge ? sim.state.roadNodes.find((n) => n.id === edge.a) : null;
    const b = edge ? sim.state.roadNodes.find((n) => n.id === edge.b) : null;
    if (!edge || !a || !b) return failTask(sim, t, "The road no longer exists");
    const def = sim.def(eq);
    let left = budget;
    if (t.phase === "to-start") {
      eq.activity = "drive";
      eq.state = "TRAVELING";
      t.status = "TRAVELING";
      const r = goTo(sim, t, eq, a.x, a.z, w, left, 2);
      left = r.left;
      if (!r.arrived) return;
      t.phase = "grade";
      t.scratch.startCondition = edge.condition;
      t.scratch.restore = (def.gradeRestore ?? 50) * (0.7 + 0.5 * perf(w, "equipmentOperation"));
      setDirect(eq, b.x, b.z, def.gradeSpeedKmh ?? 7);
    }
    t.status = "EXECUTING";
    eq.state = "WORKING";
    eq.activity = "push";
    t.note = `Grading ${a.id} → ${b.id}`;
    if (arrived(eq)) setDirect(eq, b.x, b.z, def.gradeSpeedKmh ?? 7);
    travel(sim, eq, left, w);
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const done = 1 - Math.min(1, Math.hypot(b.x - eq.x, b.z - eq.z) / len);
    t.progress = done;
    // Condition comes back as the blade passes, not all at once at the end.
    edge.condition = Math.min(100, Math.max(edge.condition, (t.scratch.startCondition ?? edge.condition) + (t.scratch.restore ?? 50) * done));
    if (arrived(eq) && Math.hypot(b.x - eq.x, b.z - eq.z) < 1) {
      sim.notify("good", `Road ${a.id} → ${b.id} graded`, `Condition now ${edge.condition.toFixed(0)}%.`);
      completeTask(sim, t);
    }
  },
};

export const EXECUTORS: Record<TaskType, TaskExecutor> = {
  MOVE,
  PARK,
  FUEL,
  MAINTENANCE,
  REPAIR,
  EXPLORE_DRILL,
  DRILL_PATTERN,
  BLAST,
  STRIP_TOPSOIL,
  EXCAVATE,
  HAUL,
  CONSTRUCT,
  GRADE_ROAD,
};

/** Dev/debug hook: force a breakdown (spec §56 "damage equipment"). */
export function forceBreakdown(sim: Sim, eq: EquipmentInstance): void {
  breakDown(sim, eq, "forced by developer command");
}
