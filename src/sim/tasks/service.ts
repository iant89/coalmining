/**
 * The task system (spec §6) — the backbone every physical operation runs through.
 *
 * Lifecycle: CREATED → VALIDATING → QUEUED → ASSIGNED → TRAVELING → EXECUTING → COMPLETED, with
 * BLOCKED → RESOLVING → (previous state) whenever a condition fails, and CANCELLED / FAILED as
 * alternative ends. Every block carries a human-readable reason (spec §6.3).
 *
 * Layering (spec §50): this service is the Task AI (what must happen, in what order), `assign` is
 * the Role AI (which machine, which qualified operator), executors are the Equipment AI (how a haul
 * cycle runs) and equipment/movement.ts is the Movement AI. Equipment carries no business logic.
 */
import type { Sim } from "../sim.js";
import type {
  Employee,
  EquipmentCategory,
  EquipmentInstance,
  Task,
  TaskParams,
  TaskPriority,
  TaskStatus,
  TaskTarget,
  TaskType,
  WorkerRole,
} from "../state.js";
import { EXECUTORS, targetPoint } from "./executors.js";
import { isOnShift, qualificationProblem, shiftLabel, tickWorkers } from "../workforce/workforce.js";

export const PRIORITY_ORDER: Record<TaskPriority, number> = { EMERGENCY: 0, CRITICAL: 1, HIGH: 2, NORMAL: 3, LOW: 4 };
export const TERMINAL: ReadonlySet<TaskStatus> = new Set(["COMPLETED", "CANCELLED", "FAILED"]);
const ACTIVE: ReadonlySet<TaskStatus> = new Set(["ASSIGNED", "TRAVELING", "EXECUTING", "RESOLVING"]);

/** Categories that do each task type; null = no machine (BLAST) or "whichever machine is named". */
export const TASK_CATEGORY: Record<TaskType, EquipmentCategory | null> = {
  MOVE: null,
  PARK: null,
  EXPLORE_DRILL: "DRILL",
  DRILL_PATTERN: "DRILL",
  BLAST: null,
  STRIP_TOPSOIL: "DOZER",
  EXCAVATE: "EXCAVATOR",
  HAUL: "HAUL_TRUCK",
  FUEL: null,
  MAINTENANCE: null,
  REPAIR: null,
  CONSTRUCT: null,
  GRADE_ROAD: "GRADER",
  FIELD_FUEL: "LUBE_TRUCK",
  SERVICE_CALL: "SERVICE_TRUCK",
};

/**
 * The machine category a task needs, which for some types depends on what it targets: a haul-road
 * project is built by a dozer, a conveyor or stockpile by a contractor crew with no machine.
 */
export function categoryFor(sim: Sim, type: TaskType, target: TaskTarget | null | undefined): EquipmentCategory | null {
  if (type === "CONSTRUCT") {
    const p = target?.kind === "project" ? sim.state.projects.find((x) => x.id === target.id) : null;
    return p?.type === "HAUL_ROAD" ? "DOZER" : null;
  }
  return TASK_CATEGORY[type];
}

/** Worker rule for tasks whose worker is not a machine's operator (undefined = the operator). */
function ownWorker(sim: Sim, type: TaskType, target: TaskTarget | null | undefined): { role: WorkerRole | null; cert: string | null } | undefined {
  if (type === "CONSTRUCT" && categoryFor(sim, type, target) === null) return { role: null, cert: null };
  return OWN_WORKER[type];
}

/** A task that works on a conveyor rather than a machine. */
function onConveyor(target: TaskTarget | null | undefined): boolean {
  return target?.kind === "conveyor" || target?.kind === "plant";
}

/** Task types that need a named machine even without a category. */
const NEEDS_EQUIPMENT: ReadonlySet<TaskType> = new Set(["MOVE", "PARK", "FUEL", "MAINTENANCE", "REPAIR", "EXPLORE_DRILL", "DRILL_PATTERN", "STRIP_TOPSOIL", "EXCAVATE", "HAUL"]);
/** Task types whose worker is not the machine's operator. */
const OWN_WORKER: Partial<Record<TaskType, { role: WorkerRole | null; cert: string | null }>> = {
  BLAST: { role: null, cert: "BLASTER" },
  REPAIR: { role: "MECHANIC", cert: null },
};
/** Task types that work ON a machine without occupying it (its own task stays assigned). */
const NON_OCCUPYING: ReadonlySet<TaskType> = new Set(["REPAIR"]);

export const TASK_LABEL: Record<TaskType, string> = {
  MOVE: "Move",
  PARK: "Park",
  EXPLORE_DRILL: "Exploration drilling",
  DRILL_PATTERN: "Drill blast pattern",
  BLAST: "Blast",
  STRIP_TOPSOIL: "Strip topsoil",
  EXCAVATE: "Excavate",
  HAUL: "Haul",
  FUEL: "Refuel",
  MAINTENANCE: "Scheduled maintenance",
  REPAIR: "Repair",
  CONSTRUCT: "Construction",
  GRADE_ROAD: "Grade haul road",
  FIELD_FUEL: "Field refuel & grease",
  SERVICE_CALL: "Field service",
};

export interface TaskSpec {
  type: TaskType;
  priority?: TaskPriority;
  equipmentId?: string | null;
  workerId?: string | null;
  source?: TaskTarget | null;
  destination?: TaskTarget | null;
  params?: TaskParams;
  prerequisites?: string[];
  label?: string;
  /** Issued by this crew's foreman: only the crew's machines and people may work it. */
  crewId?: string | null;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

function draft(sim: Sim, spec: TaskSpec): Task {
  const eq = sim.equipment(spec.equipmentId);
  const own = ownWorker(sim, spec.type, spec.destination);
  const def = eq ? sim.def(eq) : null;
  return {
    id: "draft",
    type: spec.type,
    status: "CREATED",
    priority: spec.priority ?? "NORMAL",
    label: spec.label ?? TASK_LABEL[spec.type],
    source: spec.source ?? null,
    destination: spec.destination ?? null,
    requiredEquipmentCategory: categoryFor(sim, spec.type, spec.destination),
    assignedEquipmentId: eq?.id ?? null,
    equipmentLocked: !!eq,
    requiredWorkerRole: own ? own.role : (def?.requiredRole ?? null),
    requiredCertification: own ? own.cert : (def?.requiredCertification ?? null),
    assignedWorkerId: spec.workerId ?? null,
    workerLocked: !!spec.workerId,
    prerequisites: spec.prerequisites ?? [],
    createdAt: sim.minute,
    startedAt: null,
    completedAt: null,
    estimatedDuration: null,
    progress: 0,
    materialType: null,
    materialAmount: 0,
    failureReason: null,
    blockedReason: null,
    lastBlockReason: null,
    note: null,
    resumeStatus: null,
    params: { ...(spec.params ?? {}) },
    phase: "start",
    phaseTimer: 0,
    scratch: {},
    crewId: spec.crewId ?? null,
  };
}

function crewOf(sim: Sim, t: Task) {
  return t.crewId ? (sim.state.crews.find((c) => c.id === t.crewId) ?? null) : null;
}

/**
 * Validate a task before it exists (spec §46: the UI shows errors before assignment). Errors stop
 * creation; warnings describe why it will wait once queued.
 */
export function validateTask(sim: Sim, spec: TaskSpec): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const t = draft(sim, spec);
  const eq = sim.equipment(spec.equipmentId);
  if (spec.equipmentId && !eq) errors.push(`Unknown equipment ${spec.equipmentId}`);
  if (eq) {
    const def = sim.def(eq);
    if (t.requiredEquipmentCategory && def.category !== t.requiredEquipmentCategory) {
      errors.push(`${eq.name} is a ${def.category.toLowerCase().replace("_", " ")}; ${TASK_LABEL[spec.type].toLowerCase()} needs a ${t.requiredEquipmentCategory.toLowerCase().replace("_", " ")}`);
    }
    if (eq.state === "DISABLED") errors.push(`${eq.name} is disabled`);
    if (spec.type !== "REPAIR" && eq.state === "BROKEN") warnings.push(`${eq.name} is broken down (${eq.breakdown?.cause ?? "fault"}): the task will wait for a repair`);
    if (eq.currentTaskId && spec.type !== "REPAIR") {
      const cur = sim.task(eq.currentTaskId);
      if (cur) warnings.push(`${eq.name} is busy (${cur.label}); this task will queue behind it`);
    }
    if (spec.type !== "FUEL" && eq.fuelL / def.fuelCapacityL < 0.12) warnings.push(`${eq.name} is low on fuel (${Math.round((eq.fuelL / def.fuelCapacityL) * 100)}%)`);
  } else if (NEEDS_EQUIPMENT.has(spec.type) && !t.requiredEquipmentCategory && !onConveyor(spec.destination)) {
    errors.push(`${TASK_LABEL[spec.type]} needs a machine`);
  } else if (t.requiredEquipmentCategory && !sim.state.equipment.some((e) => sim.def(e).category === t.requiredEquipmentCategory)) {
    errors.push(`The mine has no ${t.requiredEquipmentCategory.toLowerCase().replace("_", " ")}`);
  }
  if (spec.workerId) {
    const w = sim.worker(spec.workerId);
    if (!w) errors.push(`Unknown employee ${spec.workerId}`);
    else {
      const p = qualificationProblem(sim, w, t.requiredWorkerRole, t.requiredCertification);
      if (p) errors.push(p);
      else if (!isOnShift(sim, w)) warnings.push(`${w.name} is off shift until ${shiftLabel(sim).split("–")[0]}`);
    }
  } else if (t.requiredCertification || t.requiredWorkerRole) {
    const anyQualified = sim.state.workers.some((w) => !qualificationProblem(sim, w, t.requiredWorkerRole, t.requiredCertification));
    if (!anyQualified) errors.push(noQualifiedMessage(t));
  }
  for (const id of t.prerequisites) {
    const p = sim.task(id);
    if (!p) errors.push(`Unknown prerequisite ${id}`);
    else if (p.status === "FAILED" || p.status === "CANCELLED") errors.push(`Prerequisite ${p.label} was ${p.status.toLowerCase()}`);
  }
  const ex = EXECUTORS[spec.type];
  errors.push(...ex.validate(sim, t));
  return { errors, warnings };
}

function noQualifiedMessage(t: Task): string {
  if (t.requiredCertification) return `No employee holds the ${t.requiredCertification.toLowerCase().replace(/_/g, " ")} certification`;
  return `No ${String(t.requiredWorkerRole).toLowerCase().replace(/_/g, " ")} on the payroll`;
}

export function createTask(sim: Sim, spec: TaskSpec): { ok: true; task: Task; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] } {
  const v = validateTask(sim, spec);
  if (v.errors.length) return { ok: false, errors: v.errors, warnings: v.warnings };
  const task = draft(sim, spec);
  task.id = sim.nextId("task");
  task.status = "QUEUED";
  sim.state.tasks.push(task);
  sim.bus.emit({ type: "TaskCreated", taskId: task.id });
  return { ok: true, task, warnings: v.warnings };
}

export function cancelTask(sim: Sim, id: string, reason = "Cancelled by player"): boolean {
  const t = sim.task(id);
  if (!t || TERMINAL.has(t.status)) return false;
  EXECUTORS[t.type].cancel?.(sim, t);
  t.status = "CANCELLED";
  t.failureReason = reason;
  t.completedAt = sim.minute;
  release(sim, t);
  sim.bus.emit({ type: "TaskCancelled", taskId: t.id });
  return true;
}

export function completeTask(sim: Sim, t: Task): void {
  t.status = "COMPLETED";
  t.progress = 1;
  t.completedAt = sim.minute;
  t.blockedReason = null;
  t.note = null;
  release(sim, t);
  sim.bus.emit({ type: "TaskCompleted", taskId: t.id });
}

export function failTask(sim: Sim, t: Task, reason: string): void {
  t.status = "FAILED";
  t.failureReason = reason;
  t.completedAt = sim.minute;
  release(sim, t);
  sim.bus.emit({ type: "TaskFailed", taskId: t.id, reason });
  sim.notify("warn", `Task failed: ${t.label}`, reason, { kind: "task", id: t.id });
}

function release(sim: Sim, t: Task): void {
  // A lube or service truck's hold on the machine it was working on ends with its task.
  for (const e of sim.state.equipment) if (e.serviceHold?.by === t.id) e.serviceHold = null;
  const eq = sim.equipment(t.assignedEquipmentId);
  if (eq && eq.currentTaskId === t.id) {
    eq.currentTaskId = null;
    eq.route = null;
    eq.speed = 0;
    if (eq.state !== "BROKEN") {
      eq.state = t.type === "PARK" ? "PARKED" : "AVAILABLE";
      eq.activity = "idle";
    }
  }
}

export function blockTask(sim: Sim, t: Task, reason: string): void {
  if (t.status === "BLOCKED" && t.blockedReason === reason) return;
  if (t.status !== "BLOCKED") t.resumeStatus = t.status;
  t.status = "BLOCKED";
  t.blockedReason = reason;
  t.scratch.runTicks = 0;
  // An executor that re-detects the same condition every tick must not re-announce it.
  if (t.lastBlockReason === reason) return;
  t.lastBlockReason = reason;
  sim.bus.emit({ type: "TaskBlocked", taskId: t.id, reason });
  // Assigned work that stops is news; a queued task waiting for a machine is not.
  if (t.resumeStatus !== "QUEUED") sim.notify("warn", `Task blocked: ${t.label}`, reason, { kind: "task", id: t.id });
}

function unblock(sim: Sim, t: Task): void {
  if (t.status !== "BLOCKED") return;
  t.status = "RESOLVING";
  if (t.lastBlockReason === null) sim.bus.emit({ type: "TaskUnblocked", taskId: t.id });
  t.status = t.resumeStatus ?? "QUEUED";
  t.resumeStatus = null;
  t.blockedReason = null;
}

// ---------------------------------------------------------------- assignment (Role AI)

function workersBusy(sim: Sim): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of sim.state.tasks) {
    if (t.assignedWorkerId && (ACTIVE.has(t.status) || (t.status === "BLOCKED" && t.resumeStatus !== "QUEUED"))) m.set(t.assignedWorkerId, t.id);
  }
  return m;
}

function pickEquipment(sim: Sim, t: Task): { eq: EquipmentInstance | null; reason: string | null } {
  if (t.assignedEquipmentId) {
    const eq = sim.equipment(t.assignedEquipmentId);
    if (!eq) return { eq: null, reason: "Assigned equipment no longer exists" };
    if (!NON_OCCUPYING.has(t.type) && eq.currentTaskId && eq.currentTaskId !== t.id) {
      const cur = sim.task(eq.currentTaskId);
      return { eq: null, reason: `Waiting for ${eq.name} (busy: ${cur?.label ?? eq.currentTaskId})` };
    }
    return { eq, reason: null };
  }
  const cat = t.requiredEquipmentCategory;
  if (!cat) return { eq: null, reason: null };
  const p = targetPoint(sim, t.destination ?? t.source);
  const crew = crewOf(sim, t);
  const free = sim.state.equipment
    .filter((e) => sim.def(e).category === cat && !e.currentTaskId && e.state !== "BROKEN" && e.state !== "DISABLED" && e.condition > 0)
    .filter((e) => !e.serviceHold && (!crew || crew.equipmentIds.includes(e.id)))
    .sort((a, b) => (p ? Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z) : 0));
  if (free.length === 0) return { eq: null, reason: `No ${cat.toLowerCase().replace("_", " ")} available${crew ? ` in ${crew.name}` : ""}` };
  return { eq: free[0]!, reason: null };
}

function pickWorker(sim: Sim, t: Task, eq: EquipmentInstance | null, busy: Map<string, string>): { w: Employee | null; reason: string | null } {
  const own = ownWorker(sim, t.type, t.destination);
  const def = eq ? sim.def(eq) : null;
  const role = own ? own.role : (def?.requiredRole ?? null);
  const cert = own ? own.cert : (def?.requiredCertification ?? null);
  t.requiredWorkerRole = role;
  t.requiredCertification = cert;
  if (!role && !cert) return { w: null, reason: null };
  const usable = (w: Employee): string | null => {
    const q = qualificationProblem(sim, w, role, cert);
    if (q) return q;
    if (!isOnShift(sim, w)) return `${w.name} is off shift (shift ${shiftLabel(sim)})`;
    const b = busy.get(w.id);
    if (b && b !== t.id) return `${w.name} is busy with ${sim.task(b)?.label ?? b}`;
    return null;
  };
  if (t.workerLocked && t.assignedWorkerId) {
    const w = sim.worker(t.assignedWorkerId);
    if (!w) return { w: null, reason: "Assigned employee no longer works here" };
    const p = usable(w);
    return p ? { w: null, reason: p } : { w, reason: null };
  }
  // The machine's regular operator first (spec §45 "Operator"), then anyone qualified. A
  // foreman's task is staffed from the foreman's crew only.
  const crew = crewOf(sim, t);
  const inCrew = (w: Employee): boolean => !crew || crew.workerIds.includes(w.id);
  const regular = !own && eq?.operatorId ? sim.worker(eq.operatorId) : null;
  if (regular && inCrew(regular) && !usable(regular)) return { w: regular, reason: null };
  const qualified = sim.state.workers.filter((w) => inCrew(w) && !qualificationProblem(sim, w, role, cert));
  if (qualified.length === 0) return { w: null, reason: crew ? `Nobody in ${crew.name} is qualified (${noQualifiedMessage(t).replace(/^No employee holds/, "needs")})` : noQualifiedMessage(t) };
  const candidates = qualified
    .filter((w) => !usable(w))
    // Prefer workers not regularly assigned to another machine, then the most skilled.
    .sort((a, b) => Number(!!a.assignedEquipmentId && a.assignedEquipmentId !== eq?.id) - Number(!!b.assignedEquipmentId && b.assignedEquipmentId !== eq?.id) || b.skills.equipmentOperation - a.skills.equipmentOperation);
  if (candidates.length) return { w: candidates[0]!, reason: null };
  if (qualified.every((w) => !isOnShift(sim, w))) return { w: null, reason: `No qualified ${cert ? cert.toLowerCase().replace(/_/g, " ") + " " : ""}operator on shift (shift ${shiftLabel(sim)})` };
  return { w: null, reason: `All qualified operators are busy` };
}

function tryAssign(sim: Sim, t: Task, busy: Map<string, string>): void {
  for (const id of t.prerequisites) {
    const p = sim.task(id);
    if (!p) continue;
    if (p.status === "FAILED" || p.status === "CANCELLED") {
      failTask(sim, t, `Prerequisite "${p.label}" was ${p.status.toLowerCase()}`);
      return;
    }
    if (p.status !== "COMPLETED") {
      t.note = `Waiting for: ${p.label}`;
      if (t.status === "BLOCKED") unblock(sim, t);
      return;
    }
  }
  const ex = EXECUTORS[t.type];
  const errors = ex.validate(sim, t);
  if (errors.length) {
    blockTask(sim, t, errors[0]!);
    return;
  }
  const { eq, reason: eqReason } = pickEquipment(sim, t);
  if (eqReason) {
    blockTask(sim, t, eqReason);
    return;
  }
  const { w, reason: wReason } = pickWorker(sim, t, eq, busy);
  if (wReason) {
    blockTask(sim, t, wReason);
    return;
  }
  if (t.status === "BLOCKED") unblock(sim, t);
  t.note = null;
  t.assignedEquipmentId = eq?.id ?? t.assignedEquipmentId;
  t.assignedWorkerId = w?.id ?? null;
  if (eq && !NON_OCCUPYING.has(t.type)) {
    eq.currentTaskId = t.id;
    if (w) eq.operatorId = w.id;
    eq.state = "ASSIGNED";
  }
  if (w) busy.set(w.id, t.id);
  t.status = "ASSIGNED";
  t.startedAt = sim.minute;
  t.phase = "start";
  sim.bus.emit({ type: "TaskAssigned", taskId: t.id, equipmentId: eq?.id ?? null, workerId: w?.id ?? null });
  ex.start(sim, t, eq, w);
  sim.bus.emit({ type: "TaskStarted", taskId: t.id });
}

/** Conditions that suspend any assigned task (spec §6.3), in the order a supervisor would check them. */
function runningProblem(sim: Sim, t: Task, eq: EquipmentInstance | null, w: Employee | null): string | null {
  if (eq && t.type !== "REPAIR") {
    if (eq.state === "BROKEN") return `${eq.name} is broken down: ${eq.breakdown?.cause ?? "fault"}`;
    if (eq.condition <= 0) return `${eq.name} is worn out (0% condition) and must be repaired`;
    if (eq.fuelL <= 0.01 && t.type !== "FUEL") return `${eq.name} is out of fuel`;
  }
  if (w) {
    if (!isOnShift(sim, w)) return `${w.name} is off shift (shift ${shiftLabel(sim)})`;
    const q = qualificationProblem(sim, w, t.requiredWorkerRole, t.requiredCertification);
    if (q) return q;
  } else if (t.requiredCertification || t.requiredWorkerRole) {
    return "No operator assigned";
  }
  return EXECUTORS[t.type].check?.(sim, t, eq, w) ?? null;
}

export function sortedTasks(sim: Sim): Task[] {
  return sim.state.tasks
    .filter((t) => !TERMINAL.has(t.status))
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** One simulation tick of the task system, workforce included. */
export function tickTasks(sim: Sim): void {
  const busy = workersBusy(sim);
  const working = new Set<string>();
  for (const t of sortedTasks(sim)) {
    const queued = t.status === "QUEUED" || (t.status === "BLOCKED" && t.resumeStatus === "QUEUED");
    if (queued) {
      tryAssign(sim, t, busy);
      if (t.status !== "ASSIGNED") continue;
    }
    const eq = sim.equipment(t.assignedEquipmentId);
    const w = sim.worker(t.assignedWorkerId);
    // A lube or service truck working on this machine: its own work waits (not a block: it is
    // routine and short, and the player should not be told about every refuel).
    if (eq?.serviceHold && eq.currentTaskId === t.id) {
      t.note = eq.serviceHold.reason;
      eq.speed = 0;
      if (eq.state !== "BROKEN") eq.activity = "service";
      if (w) working.add(w.id);
      continue;
    }
    if (eq?.evacuating && t.type !== "REPAIR") {
      blockTask(sim, t, `Holding for blast in ${sim.block(sim.state.blastHold?.blockId)?.name ?? "the pit"}`);
      continue;
    }
    const problem = runningProblem(sim, t, eq, w);
    if (problem) {
      blockTask(sim, t, problem);
      if (eq && eq.currentTaskId === t.id && eq.state !== "BROKEN") {
        eq.speed = 0;
        eq.activity = "idle";
      }
      continue;
    }
    if (t.status === "BLOCKED") unblock(sim, t);
    if (w) {
      working.add(w.id);
      w.activity = t.type === "BLAST" ? "blasting" : t.type === "REPAIR" ? "repairing" : "operating";
    }
    EXECUTORS[t.type].run(sim, t, eq, w, sim.dt);
    // A minute of unblocked running clears the remembered block, so a later recurrence is news.
    if (t.status !== "BLOCKED" && t.lastBlockReason !== null && (t.scratch.runTicks = (t.scratch.runTicks ?? 0) + 1) >= 12) {
      t.lastBlockReason = null;
      sim.bus.emit({ type: "TaskUnblocked", taskId: t.id });
    }
  }
  tickWorkers(sim, working);
}
