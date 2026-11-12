/**
 * Player and developer commands — the only way the UI changes the simulation. Each returns a result
 * with a reason on failure, so the UI can explain instead of silently doing nothing.
 */
import type { Sim } from "./sim.js";
import type { Employee, EquipmentInstance, ExcavateMode, Task, WeatherKind } from "./state.js";
import { cancelTask, createTask, TERMINAL, type TaskSpec } from "./tasks/service.js";
import { designPattern, estimatePattern, type PatternOptions } from "./mining/drilling.js";
import { designBlast } from "./mining/blasting.js";
import { newEquipment } from "./scenario.js";
import { sellCoal } from "./economy/market.js";
import { applyForRenewal } from "./regulatory/permits.js";
import { revealGeology } from "./mining/exploration.js";
import { setWeather } from "./environment/weather.js";
import { forceBreakdown } from "./tasks/executors.js";
import { generateCandidate, operatorProblem } from "./workforce/workforce.js";
import { cancelProject, planConveyorProject, planRoadProject, planStockpileProject, type ProjectEstimate } from "./logistics/construction.js";
import { conveyorById, hopperById, setConveyorEnabled } from "./logistics/conveyors.js";
import type { ConstructionProject } from "./state.js";

export type CommandResult<T = undefined> = { ok: true; value: T; warnings?: string[] } | { ok: false; error: string };

const ok = <T>(value: T, warnings?: string[]): CommandResult<T> => ({ ok: true, value, ...(warnings?.length ? { warnings } : {}) });
const fail = (error: string): CommandResult<never> => ({ ok: false, error });

export function assignTask(sim: Sim, spec: TaskSpec): CommandResult<Task> {
  const r = createTask(sim, spec);
  return r.ok ? ok(r.task, r.warnings) : fail(r.errors.join("; "));
}

/** Design (or replace an undrilled) drill pattern for a block. */
export function planDrillPattern(sim: Sim, blockId: string, opts: PatternOptions) {
  const block = sim.block(blockId);
  if (!block) return fail("Unknown block");
  const busy = sim.state.tasks.find((t) => t.type === "DRILL_PATTERN" && t.destination?.kind === "block" && t.destination.id === blockId && !TERMINAL.has(t.status));
  if (busy) return fail(`${block.name} is already being drilled (${busy.id})`);
  sim.state.drillPatterns = sim.state.drillPatterns.filter((p) => !(p.blockId === blockId && p.completedAt === null && !p.holes.some((h) => h.drilled)));
  const pattern = designPattern(sim, block, opts);
  sim.state.drillPatterns.push(pattern);
  block.patternId = pattern.id;
  const drill = sim.state.equipment.find((e) => sim.def(e).category === "DRILL") ?? null;
  return ok({ pattern, estimate: estimatePattern(sim, pattern, drill) });
}

export function planBlast(sim: Sim, blockId: string, chargeFactor: number) {
  const block = sim.block(blockId);
  if (!block) return fail("Unknown block");
  const pattern = sim.state.drillPatterns.find((p) => p.id === block.patternId);
  if (!pattern) return fail(`Design a drill pattern for ${block.name} first`);
  sim.state.blasts = sim.state.blasts.filter((b) => !(b.patternId === pattern.id && b.state === "PLANNED"));
  const blast = designBlast(sim, block, pattern, chargeFactor);
  sim.state.blasts.push(blast);
  block.blastId = blast.id;
  return ok(blast);
}

/**
 * Production objective (spec §11, §65): "remove the overburden from this block" becomes a task
 * chain — drill → blast → excavate, with every truck hauling from that excavator. Steps already
 * done (pattern drilled, blast fired) are skipped.
 */
export function orderBlockWork(sim: Sim, blockId: string, mode: ExcavateMode, opts: { excavatorId?: string; truckIds?: string[]; chargeFactor?: number; pattern?: PatternOptions } = {}): CommandResult<Task[]> {
  const block = sim.block(blockId);
  if (!block) return fail("Unknown block");
  const created: Task[] = [];
  const prereq: string[] = [];
  if (mode === "OVERBURDEN" && block.state !== "BLASTED" && block.state !== "EXCAVATING") {
    let pattern = sim.state.drillPatterns.find((p) => p.id === block.patternId);
    if (!pattern || (pattern.completedAt !== null && sim.state.blasts.some((b) => b.patternId === pattern!.id && b.state === "COMPLETED"))) {
      const r = planDrillPattern(sim, blockId, opts.pattern ?? { spacing: 6, burden: 6, depthMode: "TO_COAL", depth: 14 });
      if (!r.ok) return r;
      pattern = r.value.pattern;
    }
    if (pattern.completedAt === null) {
      const d = assignTask(sim, { type: "DRILL_PATTERN", destination: { kind: "block", id: blockId }, params: { patternId: pattern.id }, label: `Drill ${block.name}` });
      if (!d.ok) return d;
      created.push(d.value);
      prereq.push(d.value.id);
    }
    const blastR = planBlast(sim, blockId, opts.chargeFactor ?? 1);
    if (!blastR.ok) return blastR;
    const b = assignTask(sim, { type: "BLAST", destination: { kind: "block", id: blockId }, params: { blastId: blastR.value.id }, prerequisites: [...prereq], label: `Blast ${block.name}` });
    if (!b.ok) return b;
    created.push(b.value);
    prereq.splice(0, prereq.length, b.value.id);
  }
  const ex = assignTask(sim, {
    type: "EXCAVATE",
    equipmentId: opts.excavatorId ?? null,
    destination: { kind: "block", id: blockId },
    params: { mode },
    prerequisites: [...prereq],
    label: `${mode === "COAL" ? "Mine coal" : "Remove overburden"}: ${block.name}`,
  });
  if (!ex.ok) return ex;
  created.push(ex.value);
  const trucks = opts.truckIds ?? sim.state.equipment.filter((e) => sim.def(e).category === "HAUL_TRUCK" && !e.currentTaskId).map((e) => e.id);
  // Coal goes where the mine's coal routing says: a stockpile, or a conveyor hopper.
  const dest = sim.state.settings.coalDestination;
  const coalParams = hopperById(sim, dest) ? { coalHopperId: dest! } : sim.stockpile(dest) ? { coalStockpileId: dest! } : {};
  for (const id of trucks) {
    const h = assignTask(sim, {
      type: "HAUL",
      equipmentId: id,
      params: mode === "COAL" ? coalParams : {},
      source: { kind: "task", id: ex.value.id },
      prerequisites: [...prereq],
      label: `Haul ${mode === "COAL" ? "coal" : "overburden"} from ${block.name}`,
    });
    if (h.ok) created.push(h.value);
  }
  return ok(created);
}

export function buyEquipment(sim: Sim, defId: string): CommandResult<EquipmentInstance> {
  const def = sim.catalog.equipment.get(defId);
  if (!def) return fail("Unknown model");
  if (!sim.canAfford(def.purchasePrice)) return fail(`Not enough cash or credit for the ${def.name} ($${def.purchasePrice.toLocaleString()})`);
  const lot = sim.facilityOfType("PARKING");
  const n = sim.state.equipment.filter((e) => e.defId === defId).length + 1;
  const eq = newEquipment(sim.nextId("eq"), defId, `${def.model} #${n}`, lot ? lot.x + lot.width / 2 - 6 : 0, lot ? lot.z + lot.depth / 2 + 6 : 0, Math.PI, def.fuelCapacityL);
  eq.purchasedDay = sim.day;
  sim.state.equipment.push(eq);
  sim.spend(def.purchasePrice, "equipment", `Purchased ${def.name}`);
  sim.bus.emit({ type: "EquipmentPurchased", equipmentId: eq.id });
  sim.notify("good", `${eq.name} delivered`, `A new ${def.name} is waiting in the equipment yard. Assign it an operator.`, { kind: "equipment", id: eq.id });
  return ok(eq);
}

export function buyUpgrade(sim: Sim, equipmentId: string, upgradeId: string): CommandResult<undefined> {
  const eq = sim.equipment(equipmentId);
  if (!eq) return fail("Unknown equipment");
  const def = sim.def(eq);
  const up = sim.catalog.upgrades.get(upgradeId);
  if (!up || !def.availableUpgrades.includes(upgradeId)) return fail(`${upgradeId} is not available for the ${def.model}`);
  if (eq.upgrades.includes(upgradeId)) return fail("Already installed");
  if (eq.currentTaskId) return fail(`${eq.name} must be idle to fit an upgrade`);
  if (!sim.canAfford(up.price)) return fail("Not enough cash or credit");
  // One upgrade per slot: fitting a new engine replaces the old one.
  eq.upgrades = eq.upgrades.filter((u) => sim.catalog.upgrades.get(u)?.slot !== up.slot);
  eq.upgrades.push(upgradeId);
  sim.spend(up.price, "upgrades", `${up.name} for ${eq.name}`);
  return ok(undefined);
}

export function setOperator(sim: Sim, equipmentId: string, workerId: string | null): CommandResult<undefined> {
  const eq = sim.equipment(equipmentId);
  if (!eq) return fail("Unknown equipment");
  if (workerId === null) {
    const prev = sim.worker(eq.operatorId);
    if (prev) prev.assignedEquipmentId = null;
    eq.operatorId = null;
    return ok(undefined);
  }
  const w = sim.worker(workerId);
  if (!w) return fail("Unknown employee");
  const p = operatorProblem(sim, w, sim.def(eq));
  if (p) return fail(p);
  for (const other of sim.state.equipment) if (other.operatorId === w.id && other !== eq) other.operatorId = null;
  const prev = sim.worker(eq.operatorId);
  if (prev && prev !== w) prev.assignedEquipmentId = null;
  eq.operatorId = w.id;
  w.assignedEquipmentId = eq.id;
  // The running task, if any, picks the new operator up on its next assignment check.
  const t = sim.task(eq.currentTaskId);
  if (t && !t.workerLocked) t.assignedWorkerId = w.id;
  return ok(undefined);
}

export function hireCandidate(sim: Sim, candidateId: string): CommandResult<Employee> {
  const i = sim.state.candidates.findIndex((c) => c.id === candidateId);
  if (i < 0) return fail("That applicant is no longer available");
  const c = sim.state.candidates.splice(i, 1)[0]!;
  c.hiredDay = sim.day;
  sim.state.workers.push(c);
  sim.state.candidates.push(generateCandidate(sim, sim.rng.chance(0.2) ? "BLASTER" : sim.rng.chance(0.15) ? "MECHANIC" : "OPERATOR"));
  sim.bus.emit({ type: "WorkerHired", workerId: c.id });
  sim.notify("good", `${c.name} hired`, `$${c.wagePerHour}/h. Certifications: ${c.certifications.map((x) => x.type).join(", ") || "none"}.`, { kind: "worker", id: c.id });
  return ok(c);
}

export function dismissWorker(sim: Sim, workerId: string): CommandResult<undefined> {
  const w = sim.worker(workerId);
  if (!w) return fail("Unknown employee");
  if (sim.state.tasks.some((t) => t.assignedWorkerId === w.id && !TERMINAL.has(t.status) && t.status !== "QUEUED")) return fail(`${w.name} is working a task; reassign it first`);
  w.employmentStatus = "TERMINATED";
  for (const e of sim.state.equipment) if (e.operatorId === w.id) e.operatorId = null;
  w.assignedEquipmentId = null;
  return ok(undefined);
}

export function sell(sim: Sim, customerId: string, stockpileId: string, tonnes: number): CommandResult<number> {
  const r = sellCoal(sim, customerId, stockpileId, tonnes);
  return r.ok ? ok(r.quote!.revenue) : fail(r.error ?? "Sale refused");
}

export function renewPermit(sim: Sim, permitId: string): CommandResult<undefined> {
  const e = applyForRenewal(sim, permitId);
  return e ? fail(e) : ok(undefined);
}

/** Renew a certification through training: costs money and takes the worker off for the day. */
export function trainCertification(sim: Sim, workerId: string, cert: string): CommandResult<undefined> {
  const w = sim.worker(workerId);
  if (!w) return fail("Unknown employee");
  const cost = cert === "BLASTER" ? 2400 : 900;
  if (!sim.canAfford(cost)) return fail("Not enough cash or credit");
  sim.spend(cost, "payroll", `${cert} training for ${w.name}`);
  const c = w.certifications.find((x) => x.type === cert);
  const expires = cert === "BLASTER" ? sim.day + 365 : null;
  if (c) c.expiresDay = expires;
  else w.certifications.push({ type: cert, expiresDay: expires });
  return ok(undefined);
}

// ---------------------------------------------------------------- construction & logistics (spec §22–24, §63)

function startProject(sim: Sim, r: { project: ConstructionProject; estimate: ProjectEstimate } | { problems: string[] }, equipmentId?: string | null): CommandResult<{ project: ConstructionProject; task: Task; estimate: ProjectEstimate }> {
  if ("problems" in r) return fail(r.problems.join("; "));
  const t = assignTask(sim, { type: "CONSTRUCT", equipmentId: equipmentId ?? null, destination: { kind: "project", id: r.project.id }, label: `Build ${r.project.name}` });
  if (!t.ok) {
    r.project.status = "CANCELLED";
    return t;
  }
  sim.notify("info", `${r.project.name} planned`, `$${r.estimate.cost.toLocaleString()}, about ${Math.round(r.estimate.workMinutes / 60)} h of work. Paid as the work is done.`);
  return ok({ project: r.project, task: t.value, estimate: r.estimate }, r.estimate.warnings);
}

/** Plan a haul road and order a dozer to build it. */
export function buildRoad(sim: Sim, from: { x: number; z: number }, to: { x: number; z: number }, dozerId?: string | null) {
  return startProject(sim, planRoadProject(sim, { from, to }), dozerId);
}

/** Plan a hopper + conveyor feeding `stockpileId` (or a new stockpile at `to`) and hire the crew. */
export function buildConveyor(sim: Sim, from: { x: number; z: number }, to: { x: number; z: number }, capacityTph: number, stockpileId: string | null) {
  return startProject(sim, planConveyorProject(sim, from, to, capacityTph, stockpileId));
}

export function buildStockpile(sim: Sim, at: { x: number; z: number }, capacityT: number) {
  return startProject(sim, planStockpileProject(sim, at, capacityT));
}

export function cancelConstruction(sim: Sim, projectId: string): CommandResult<undefined> {
  const e = cancelProject(sim, projectId);
  if (e) return fail(e);
  for (const t of sim.state.tasks) if (t.type === "CONSTRUCT" && t.destination?.kind === "project" && t.destination.id === projectId) cancelTask(sim, t.id, "Project cancelled");
  return ok(undefined);
}

export function switchConveyor(sim: Sim, conveyorId: string, on: boolean): CommandResult<undefined> {
  const c = conveyorById(sim, conveyorId);
  if (!c) return fail("Unknown conveyor");
  if (on && (c.state === "DAMAGED" || c.state === "MAINTENANCE")) return fail(`${c.name} is ${c.state === "DAMAGED" ? "broken down" : "under repair"}`);
  setConveyorEnabled(sim, c, on);
  return ok(undefined);
}

export function repairConveyorTask(sim: Sim, conveyorId: string): CommandResult<Task> {
  const c = conveyorById(sim, conveyorId);
  if (!c) return fail("Unknown conveyor");
  return assignTask(sim, { type: "REPAIR", destination: { kind: "conveyor", id: c.id }, priority: "HIGH", label: `Repair ${c.name}` });
}

/** Where MINE COAL orders send coal: a stockpile or hopper id, or null for the default stockpile. */
export function setCoalDestination(sim: Sim, id: string | null): CommandResult<undefined> {
  if (id !== null && !sim.stockpile(id) && !hopperById(sim, id)) return fail("Unknown stockpile or hopper");
  sim.state.settings.coalDestination = id;
  return ok(undefined);
}

export function gradeRoad(sim: Sim, roadId: string, graderId?: string | null): CommandResult<Task> {
  const r = sim.state.roadEdges.find((e) => e.id === roadId);
  if (!r) return fail("Unknown road");
  return assignTask(sim, { type: "GRADE_ROAD", equipmentId: graderId ?? null, destination: { kind: "road", id: r.id }, label: `Grade road ${r.a} → ${r.b}` });
}

// ---------------------------------------------------------------- developer commands (spec §56, §78)

export const dev = {
  addCash(sim: Sim, amount: number): void {
    sim.state.treasury.cash += amount;
  },
  spawnEquipment(sim: Sim, defId: string): CommandResult<EquipmentInstance> {
    const def = sim.catalog.equipment.get(defId);
    if (!def) return fail("Unknown model");
    sim.state.treasury.cash += def.purchasePrice;
    return buyEquipment(sim, defId);
  },
  damage(sim: Sim, equipmentId: string, amount = 25): void {
    const eq = sim.equipment(equipmentId);
    if (eq) eq.condition = Math.max(0, eq.condition - amount);
  },
  breakdown(sim: Sim, equipmentId: string): void {
    const eq = sim.equipment(equipmentId);
    if (eq) forceBreakdown(sim, eq);
  },
  repairNow(sim: Sim, equipmentId: string): void {
    const eq = sim.equipment(equipmentId);
    if (!eq) return;
    eq.condition = 100;
    eq.hoursSinceService = 0;
    eq.breakdown = null;
    if (eq.state === "BROKEN") eq.state = eq.currentTaskId ? "ASSIGNED" : "AVAILABLE";
    eq.activity = "idle";
  },
  refuel(sim: Sim, equipmentId: string): void {
    const eq = sim.equipment(equipmentId);
    if (eq) eq.fuelL = sim.def(eq).fuelCapacityL;
  },
  revealGeology(sim: Sim): number {
    return revealGeology(sim);
  },
  setWeather(sim: Sim, kind: WeatherKind): void {
    setWeather(sim, kind);
  },
  restWorkers(sim: Sim): void {
    for (const w of sim.state.workers) w.fatigue = 0;
  },
  setPrice(sim: Sim, customerId: string, price: number): void {
    const c = sim.customer(customerId);
    if (c) c.price = price;
  },
  approvePermits(sim: Sim): void {
    for (const p of sim.state.permits) {
      p.status = "APPROVED";
      p.expirationDay = sim.day + 365;
    }
  },
};
