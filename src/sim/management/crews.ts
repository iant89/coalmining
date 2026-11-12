/**
 * Foremen and crews: the management layer above the task system. The player gives each crew a
 * prioritised list of orders ("remove the overburden from A2", "keep the roads graded"); the
 * crew's foreman turns them into tasks staffed only from the crew, checks on them through the
 * shift and fixes what stalls (re-drilling rock that did not break, re-issuing work the player
 * cancelled). Every morning the foremen report at a meeting (`meeting.ts`).
 */
import type { Sim } from "../sim.js";
import type { Crew, CrewOrder, CrewOrderType, EquipmentCategory, EquipmentInstance, MiningBlock, Task } from "../state.js";
import { assignTask, orderBlockWork } from "../commands.js";
import { cancelTask, TERMINAL } from "../tasks/service.js";
import { topsoilCells } from "../tasks/executors.js";
import { isOnShift } from "../workforce/workforce.js";
import { ROAD_MAINTENANCE_THRESHOLD } from "../automation.js";

export const ORDER_LABEL: Record<CrewOrderType, string> = {
  REMOVE_OVERBURDEN: "Remove overburden",
  MINE_COAL: "Mine coal",
  STRIP_TOPSOIL: "Strip topsoil",
  EXPLORE_BLOCK: "Core-drill block",
  MAINTAIN_ROADS: "Keep haul roads graded",
};

/** Orders that need a block. */
export const BLOCK_ORDERS: ReadonlySet<CrewOrderType> = new Set(["REMOVE_OVERBURDEN", "MINE_COAL", "STRIP_TOPSOIL", "EXPLORE_BLOCK"]);

/** Give up and report STUCK after issuing an order this many times without finishing it. */
export const MAX_ATTEMPTS = 3;

/** Minutes between a foreman's rounds: 12 min for a born leader, 42 min for a reluctant one. */
export function checkInterval(leadership: number): number {
  return 30 * (1.4 - Math.max(0, Math.min(1, leadership)));
}

export function crewById(sim: Sim, id: string | null | undefined): Crew | null {
  return id ? (sim.state.crews.find((c) => c.id === id) ?? null) : null;
}

export function crewOfEquipment(sim: Sim, equipmentId: string): Crew | null {
  return sim.state.crews.find((c) => c.equipmentIds.includes(equipmentId)) ?? null;
}

export function crewOfWorker(sim: Sim, workerId: string): Crew | null {
  return sim.state.crews.find((c) => c.workerIds.includes(workerId) || c.foremanId === workerId) ?? null;
}

export function orderLabel(sim: Sim, o: CrewOrder): string {
  const b = o.blockId ? sim.block(o.blockId) : null;
  return b ? `${ORDER_LABEL[o.type]}: ${b.name}` : ORDER_LABEL[o.type];
}

export function crewTonnes(sim: Sim, crew: Crew): number {
  let t = 0;
  for (const id of crew.equipmentIds) {
    const e = sim.equipment(id);
    if (e && sim.def(e).category === "HAUL_TRUCK") t += e.stats.tonnesMoved;
  }
  return t;
}

export function newOrder(sim: Sim, type: CrewOrderType, blockId: string | null): CrewOrder {
  return { id: sim.nextId("order"), type, blockId, status: "PENDING", note: null, taskIds: [], attempts: 0, issuedDay: sim.day, doneDay: null };
}

const COAL_READY: ReadonlySet<string> = new Set(["COAL_EXPOSED", "COAL_MINING"]);
const PAST_OVERBURDEN: ReadonlySet<string> = new Set(["COAL_EXPOSED", "COAL_MINING", "COMPLETE", "RECLAIMING", "RECLAIMED"]);
const PAST_COAL: ReadonlySet<string> = new Set(["COMPLETE", "RECLAIMING", "RECLAIMED"]);

function isDone(sim: Sim, o: CrewOrder, block: MiningBlock | null, live: Task[]): boolean {
  switch (o.type) {
    case "REMOVE_OVERBURDEN":
      return !!block && PAST_OVERBURDEN.has(block.state);
    case "MINE_COAL":
      return !!block && PAST_COAL.has(block.state);
    case "STRIP_TOPSOIL":
      return !!block && topsoilCells(sim, block).length === 0;
    case "EXPLORE_BLOCK":
      return o.attempts > 0 && live.length === 0 && (!block || exploreTargets(sim, block).length === 0 || o.attempts >= 2);
    case "MAINTAIN_ROADS":
      return false;
  }
}

/** Core-hole collars inside the block, one per quarter, skipping any already near a sample. */
export function exploreTargets(sim: Sim, block: MiningBlock): { x: number; z: number }[] {
  const t = sim.terrain;
  const x0 = t.cellX(block.rect.i0);
  const x1 = t.cellX(block.rect.i1);
  const z0 = t.cellZ(block.rect.j0);
  const z1 = t.cellZ(block.rect.j1);
  const out: { x: number; z: number }[] = [];
  for (const fx of [0.25, 0.75]) {
    for (const fz of [0.25, 0.75]) {
      const x = x0 + (x1 - x0) * fx;
      const z = z0 + (z1 - z0) * fz;
      const near = sim.state.samples.some((s) => Math.hypot(s.x - x, s.z - z) < 12);
      if (!near) out.push({ x, z });
    }
  }
  return out;
}

/** Machines of a category in the crew that are fit to work. */
function crewMachines(sim: Sim, crew: Crew, cat: EquipmentCategory): EquipmentInstance[] {
  return crew.equipmentIds
    .map((id) => sim.equipment(id))
    .filter((e): e is EquipmentInstance => !!e && sim.def(e).category === cat);
}

const NEEDS: Record<CrewOrderType, EquipmentCategory> = {
  REMOVE_OVERBURDEN: "EXCAVATOR",
  MINE_COAL: "EXCAVATOR",
  STRIP_TOPSOIL: "DOZER",
  EXPLORE_BLOCK: "DRILL",
  MAINTAIN_ROADS: "GRADER",
};

function setNote(o: CrewOrder, status: CrewOrder["status"], note: string | null): void {
  o.status = status;
  o.note = note;
}

/** One foreman's round: retire finished orders, chase stalled ones, start the next. */
export function reviewCrew(sim: Sim, crew: Crew): void {
  const foreman = sim.worker(crew.foremanId);
  // Machines and people that left the mine leave the crew.
  crew.equipmentIds = crew.equipmentIds.filter((id) => !!sim.equipment(id));
  crew.workerIds = crew.workerIds.filter((id) => sim.worker(id)?.employmentStatus !== "TERMINATED" && !!sim.worker(id));
  const who = foreman?.name ?? crew.name;
  // Machines already working on a higher-priority order of this crew.
  const claimed = new Set<string>();
  for (const o of crew.orders) {
    if (o.status === "DONE") continue;
    const block = o.blockId ? sim.block(o.blockId) : null;
    if (BLOCK_ORDERS.has(o.type) && !block) {
      setNote(o, "STUCK", "The block no longer exists");
      continue;
    }
    const tasks = o.taskIds.map((id) => sim.state.tasks.find((t) => t.id === id)).filter((t): t is Task => !!t);
    const live = tasks.filter((t) => !TERMINAL.has(t.status));
    o.taskIds = o.type === "EXPLORE_BLOCK" ? tasks.map((t) => t.id) : live.map((t) => t.id);
    if (isDone(sim, o, block, live)) {
      for (const t of live) cancelTask(sim, t.id, `${who}: order finished`);
      o.taskIds = [];
      setNote(o, "DONE", null);
      o.doneDay = sim.day;
      sim.notify("good", `${crew.name}: ${orderLabel(sim, o)} done`, `${who} reports the order finished.`, block ? { kind: "block", id: block.id } : null);
      continue;
    }
    const need = NEEDS[o.type];
    const machines = crewMachines(sim, crew, need);
    if (machines.length === 0) {
      setNote(o, "STUCK", `${crew.name} has no ${need.toLowerCase().replace("_", " ")}. Move one into the crew`);
      continue;
    }
    for (const t of live) if (t.assignedEquipmentId) claimed.add(t.assignedEquipmentId);

    if (o.type === "MAINTAIN_ROADS") {
      maintainRoads(sim, crew, o, machines, claimed);
      continue;
    }
    if (live.length > 0) {
      chase(sim, crew, o, block!, live, claimed);
      continue;
    }
    // Nothing running: (re)start it, if the work can start and the machine is free.
    if (o.type === "MINE_COAL" && !COAL_READY.has(block!.state)) {
      setNote(o, "PENDING", `Waiting for the overburden to come off ${block!.name}`);
      continue;
    }
    const free = machines.filter((m) => !claimed.has(m.id) && !m.currentTaskId);
    if (free.length === 0) {
      setNote(o, "PENDING", `Waiting for ${machines[0]!.name} to finish its current job`);
      continue;
    }
    if (o.attempts >= MAX_ATTEMPTS) {
      setNote(o, "STUCK", o.note ?? "The work keeps failing; check the block and the crew");
      continue;
    }
    issue(sim, crew, o, block!, free[0]!, claimed);
  }
}

function issue(sim: Sim, crew: Crew, o: CrewOrder, block: MiningBlock, machine: EquipmentInstance, claimed: Set<string>): void {
  o.attempts += 1;
  const created: Task[] = [];
  let error: string | null = null;
  if (o.type === "REMOVE_OVERBURDEN" || o.type === "MINE_COAL") {
    const trucks = crewMachines(sim, crew, "HAUL_TRUCK").filter((e) => !claimed.has(e.id) && !e.currentTaskId).map((e) => e.id);
    const r = orderBlockWork(sim, block.id, o.type === "MINE_COAL" ? "COAL" : "OVERBURDEN", { excavatorId: machine.id, truckIds: trucks, crewId: crew.id });
    if (r.ok) created.push(...r.value);
    else error = r.error;
  } else if (o.type === "STRIP_TOPSOIL") {
    const r = assignTask(sim, { type: "STRIP_TOPSOIL", equipmentId: machine.id, destination: { kind: "block", id: block.id }, crewId: crew.id, label: `Strip topsoil: ${block.name}` });
    if (r.ok) created.push(r.value);
    else error = r.error;
  } else if (o.type === "EXPLORE_BLOCK") {
    for (const p of exploreTargets(sim, block)) {
      const r = assignTask(sim, { type: "EXPLORE_DRILL", destination: { kind: "point", x: p.x, z: p.z }, params: { depth: 30 }, crewId: crew.id, label: `Core hole in ${block.name}` });
      if (r.ok) created.push(r.value);
      else error = r.error;
    }
  }
  for (const t of created) {
    o.taskIds.push(t.id);
    if (t.assignedEquipmentId) claimed.add(t.assignedEquipmentId);
  }
  claimed.add(machine.id);
  if (created.length > 0) setNote(o, "ACTIVE", null);
  else setNote(o, o.attempts >= MAX_ATTEMPTS ? "STUCK" : "PENDING", error ?? "Nothing to do yet");
}

/** Follow up running work: report what blocks it and fix what a foreman can fix. */
function chase(sim: Sim, crew: Crew, o: CrewOrder, block: MiningBlock, live: Task[], claimed: Set<string>): void {
  const ex = live.find((t) => t.type === "EXCAVATE");
  // Rock the last blast did not break: drill and blast it again rather than wait for the player.
  if (ex && ex.status === "BLOCKED" && (ex.blockedReason ?? "").includes("unblasted") && !live.some((t) => t.type === "DRILL_PATTERN" || t.type === "BLAST")) {
    const excavatorId = ex.assignedEquipmentId;
    for (const t of live) cancelTask(sim, t.id, `${sim.worker(crew.foremanId)?.name ?? crew.name}: re-drilling ${block.name}`);
    const trucks = crewMachines(sim, crew, "HAUL_TRUCK").filter((e) => !e.currentTaskId).map((e) => e.id);
    const r = orderBlockWork(sim, block.id, "OVERBURDEN", { excavatorId: excavatorId ?? undefined, truckIds: trucks, crewId: crew.id, redrill: true });
    o.taskIds = r.ok ? r.value.map((t) => t.id) : [];
    for (const t of r.ok ? r.value : []) if (t.assignedEquipmentId) claimed.add(t.assignedEquipmentId);
    setNote(o, r.ok ? "ACTIVE" : "STUCK", r.ok ? `Unbroken rock left in ${block.name}: drilling and blasting it again` : r.error);
    return;
  }
  const blocked = live.find((t) => t.status === "BLOCKED");
  if (blocked) {
    setNote(o, "ACTIVE", blocked.blockedReason ?? "Held up");
    return;
  }
  const working = live.find((t) => t.status === "EXECUTING" || t.status === "TRAVELING") ?? live[0]!;
  setNote(o, "ACTIVE", working.note ?? `${working.label}: ${Math.round(working.progress * 100)} %`);
}

function maintainRoads(sim: Sim, crew: Crew, o: CrewOrder, graders: EquipmentInstance[], claimed: Set<string>): void {
  const busyRoads = new Set(sim.state.tasks.filter((t) => t.type === "GRADE_ROAD" && !TERMINAL.has(t.status) && t.destination?.kind === "road").map((t) => (t.destination as { id: string }).id));
  const worst = sim.state.roadEdges.filter((e) => e.condition < ROAD_MAINTENANCE_THRESHOLD && !busyRoads.has(e.id)).sort((a, b) => a.condition - b.condition);
  for (const g of graders) {
    if (claimed.has(g.id) || g.currentTaskId || g.state === "BROKEN") continue;
    const road = worst.shift();
    if (!road) break;
    const r = assignTask(sim, { type: "GRADE_ROAD", equipmentId: g.id, destination: { kind: "road", id: road.id }, priority: "LOW", crewId: crew.id, label: `Grade road ${road.a} → ${road.b}` });
    if (r.ok) {
      o.taskIds.push(r.value.id);
      claimed.add(g.id);
    }
  }
  const running = o.taskIds.length;
  const poor = sim.state.roadEdges.filter((e) => e.condition < ROAD_MAINTENANCE_THRESHOLD).length;
  setNote(o, "ACTIVE", running > 0 ? `Grading ${running} road${running > 1 ? "s" : ""}` : poor > 0 ? `${poor} road${poor > 1 ? "s" : ""} below ${ROAD_MAINTENANCE_THRESHOLD} %, waiting for a grader` : "All haul roads in good condition");
}

/** Called once a simulated minute: each on-shift foreman makes a round when it is due. */
export function tickForemen(sim: Sim): void {
  const now = sim.clock.minute;
  for (const crew of sim.state.crews) {
    const foreman = sim.worker(crew.foremanId);
    if (!foreman || foreman.employmentStatus !== "ACTIVE" || !isOnShift(sim, foreman)) continue;
    if (now - crew.lastCheck < checkInterval(foreman.skills.leadership)) continue;
    crew.lastCheck = now;
    reviewCrew(sim, crew);
  }
}
