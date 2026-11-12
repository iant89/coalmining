/**
 * Construction (spec §63): data-driven projects that generate tasks. A project is planned with a
 * full estimate (cost, work time, grade), paid for as the work is done, and only changes the world
 * when it completes — a half-built road is graded ground, not a road the trucks can use.
 *
 *  - HAUL_ROAD is built by a dozer working along the alignment, grading the ground to a straight
 *    profile between its ends. On completion it joins the road graph (spec §22, §49), so routing
 *    uses it from the next trip on.
 *  - CONVEYOR and STOCKPILE are built by a contractor crew (no machine): a truck hopper and an
 *    overland belt feeding a stockpile (spec §23), or a new stockpile pad.
 */
import type { Sim } from "../sim.js";
import type { ConstructionProject, ConstructionType, Conveyor, Hopper, RoadEdge, RoadNode, Stockpile } from "../state.js";
import { rasterizeRoads } from "./navigation.js";
import { rectContains } from "../world/terrain.js";
import data from "../../data/construction.json" with { type: "json" };

export const CONSTRUCTION = data;

export interface ProjectEstimate {
  type: ConstructionType;
  length: number;
  cost: number;
  workMinutes: number;
  /** HAUL_ROAD: steepest grade of the finished road (0.1 = 10 %). */
  grade: number | null;
  /** Earthworks to grade the alignment, bank m³ moved (cut + fill). */
  earthworksM3: number | null;
  problems: string[];
  warnings: string[];
}

function pathLength(path: readonly { x: number; z: number }[]): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.z - path[i - 1]!.z);
  return d;
}

function nearestNode(sim: Sim, x: number, z: number, within: number): RoadNode | null {
  let best: RoadNode | null = null;
  let bd = within;
  for (const n of sim.state.roadNodes) {
    const d = Math.hypot(n.x - x, n.z - z);
    if (d <= bd) {
      bd = d;
      best = n;
    }
  }
  return best;
}

function onMap(sim: Sim, x: number, z: number): boolean {
  const t = sim.terrain.state;
  return x >= t.originX + 2 && z >= t.originZ + 2 && x <= t.originX + t.cols * t.cellSize - 2 && z <= t.originZ + t.rows * t.cellSize - 2;
}

function surfaceRightsProblem(sim: Sim, x: number, z: number): string | null {
  const { i, j } = sim.terrain.cellOf(x, z);
  const ok = sim.state.parcels.some((p) => p.surfaceRights && (p.status === "OWNED" || p.status === "LEASED") && rectContains(p.rect, i, j));
  return ok ? null : "The mine has no surface rights there";
}

export interface RoadPlan {
  from: { x: number; z: number };
  to: { x: number; z: number };
}

/** Snap road ends to existing nodes so the new road joins the network. */
export function snapRoad(sim: Sim, plan: RoadPlan): { from: { x: number; z: number }; to: { x: number; z: number }; startNode: RoadNode | null; endNode: RoadNode | null } {
  const snap = CONSTRUCTION.HAUL_ROAD.snapToNodeM;
  const startNode = nearestNode(sim, plan.from.x, plan.from.z, snap);
  const endNode = nearestNode(sim, plan.to.x, plan.to.z, snap);
  return {
    from: startNode ? { x: startNode.x, z: startNode.z } : plan.from,
    to: endNode && endNode !== startNode ? { x: endNode.x, z: endNode.z } : plan.to,
    startNode,
    endNode: endNode !== startNode ? endNode : null,
  };
}

export function estimateRoad(sim: Sim, plan: RoadPlan): ProjectEstimate {
  const cfg = CONSTRUCTION.HAUL_ROAD;
  const s = snapRoad(sim, plan);
  const length = Math.hypot(s.to.x - s.from.x, s.to.z - s.from.z);
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!onMap(sim, s.from.x, s.from.z) || !onMap(sim, s.to.x, s.to.z)) problems.push("The road must stay on the map");
  if (length < 12) problems.push("The road is too short (under 12 m)");
  for (const p of [s.from, s.to]) {
    const r = surfaceRightsProblem(sim, p.x, p.z);
    if (r && !problems.includes(r)) problems.push(r);
  }
  if (!s.startNode && !s.endNode) warnings.push("Neither end joins an existing road: trucks will drive off-road to reach it");
  const t = sim.terrain;
  const h0 = t.heightAt(s.from.x, s.from.z);
  const h1 = t.heightAt(s.to.x, s.to.z);
  const grade = length > 0 ? Math.abs(h1 - h0) / length : 0;
  if (grade > cfg.maxGrade) warnings.push(`Finished grade ${(grade * 100).toFixed(1)} % is steeper than ${(cfg.maxGrade * 100).toFixed(0)} %: loaded trucks will crawl`);
  // Earthworks: cut/fill to the straight profile along the alignment.
  let earth = 0;
  const steps = Math.max(1, Math.ceil(length / t.cellSize));
  for (let k = 0; k <= steps; k++) {
    const f = k / steps;
    const x = s.from.x + (s.to.x - s.from.x) * f;
    const z = s.from.z + (s.to.z - s.from.z) * f;
    earth += Math.abs(t.heightAt(x, z) - (h0 + (h1 - h0) * f)) * cfg.width * (length / steps);
  }
  for (const b of sim.state.blocks) {
    const mid = t.cellOf((s.from.x + s.to.x) / 2, (s.from.z + s.to.z) / 2);
    if (rectContains(b.rect, mid.i, mid.j)) warnings.push(`The road crosses ${b.name}: mining it later will cut the road`);
  }
  const cost = Math.round(length * cfg.costPerM + earth * 4.5);
  return { type: "HAUL_ROAD", length, cost, workMinutes: (length / cfg.metresPerHour) * 60 * (1 + earth / Math.max(1, length * cfg.width * 2)), grade, earthworksM3: earth, problems, warnings };
}

export function estimateConveyor(sim: Sim, from: { x: number; z: number }, to: { x: number; z: number }, capacityTph: number, stockpileId: string | null): ProjectEstimate {
  const cfg = CONSTRUCTION.CONVEYOR;
  const target = stockpileId ? sim.stockpile(stockpileId) : null;
  const end = target ? { x: target.x, z: target.z } : to;
  const length = Math.hypot(end.x - from.x, end.z - from.z);
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!cfg.capacityOptionsTph.includes(capacityTph)) problems.push(`Capacity must be one of ${cfg.capacityOptionsTph.join(", ")} t/h`);
  if (!onMap(sim, from.x, from.z) || !onMap(sim, end.x, end.z)) problems.push("The conveyor must stay on the map");
  if (length < 20) problems.push("The conveyor is too short (under 20 m)");
  if (length > cfg.maxLengthM) problems.push(`The conveyor is longer than ${cfg.maxLengthM} m`);
  if (stockpileId && !target) problems.push("Unknown stockpile");
  for (const p of [from, end]) {
    const r = surfaceRightsProblem(sim, p.x, p.z);
    if (r && !problems.includes(r)) problems.push(r);
  }
  const rise = sim.terrain.heightAt(end.x, end.z) - sim.terrain.heightAt(from.x, from.z);
  if (length > 0 && rise / length > 0.3) problems.push(`The belt would climb at ${((rise / length) * 100).toFixed(0)} %: conveyors handle at most 30 %`);
  if (!target) warnings.push(`A new ${(cfg.newStockpileCapacityT / 1000).toFixed(0)} kt stockpile will be built at the discharge end`);
  const capFactor = 1 + (capacityTph - 400) * cfg.costFactorPerTph;
  const cost = Math.round((cfg.fixedCost + length * cfg.costPerM) * capFactor + (target ? 0 : CONSTRUCTION.STOCKPILE.fixedCost + cfg.newStockpileCapacityT * CONSTRUCTION.STOCKPILE.costPerT));
  return { type: "CONVEYOR", length, cost, workMinutes: (cfg.hoursFixed + length * cfg.hoursPerM) * 60, grade: length > 0 ? rise / length : 0, earthworksM3: null, problems, warnings };
}

export function estimateStockpile(sim: Sim, at: { x: number; z: number }, capacityT: number): ProjectEstimate {
  const cfg = CONSTRUCTION.STOCKPILE;
  const problems: string[] = [];
  if (!cfg.capacityOptionsT.includes(capacityT)) problems.push(`Capacity must be one of ${cfg.capacityOptionsT.join(", ")} t`);
  if (!onMap(sim, at.x, at.z)) problems.push("The stockpile must be on the map");
  const r = surfaceRightsProblem(sim, at.x, at.z);
  if (r) problems.push(r);
  for (const s of sim.state.stockpiles) if (Math.hypot(s.x - at.x, s.z - at.z) < 40) problems.push(`Too close to ${s.name}`);
  return { type: "STOCKPILE", length: 0, cost: Math.round(cfg.fixedCost + capacityT * cfg.costPerT), workMinutes: (cfg.hoursFixed + (capacityT / 1000) * cfg.hoursPerKt) * 60, grade: null, earthworksM3: null, problems, warnings: [] };
}

function project(sim: Sim, type: ConstructionType, name: string, path: { x: number; z: number }[], e: ProjectEstimate): ConstructionProject {
  return {
    id: sim.nextId("project"),
    type,
    name,
    status: "PLANNED",
    path,
    startNodeId: null,
    endNodeId: null,
    progress: 0,
    cost: e.cost,
    spent: 0,
    workMinutes: e.workMinutes,
    capacityTph: null,
    stockpileId: null,
    capacityT: null,
    startElevation: null,
    endElevation: null,
    createdAt: sim.minute,
    completedAt: null,
  };
}

export function planRoadProject(sim: Sim, plan: RoadPlan): { project: ConstructionProject; estimate: ProjectEstimate } | { problems: string[] } {
  const e = estimateRoad(sim, plan);
  if (e.problems.length) return { problems: e.problems };
  if (!sim.canAfford(e.cost)) return { problems: [`Not enough cash or credit for the road ($${e.cost.toLocaleString()})`] };
  const s = snapRoad(sim, plan);
  const p = project(sim, "HAUL_ROAD", `Haul road ${sim.state.projects.filter((x) => x.type === "HAUL_ROAD").length + 1}`, [s.from, s.to], e);
  p.startNodeId = s.startNode?.id ?? null;
  p.endNodeId = s.endNode?.id ?? null;
  p.startElevation = sim.terrain.heightAt(s.from.x, s.from.z);
  p.endElevation = sim.terrain.heightAt(s.to.x, s.to.z);
  sim.state.projects.push(p);
  return { project: p, estimate: e };
}

export function planConveyorProject(sim: Sim, from: { x: number; z: number }, to: { x: number; z: number }, capacityTph: number, stockpileId: string | null): { project: ConstructionProject; estimate: ProjectEstimate } | { problems: string[] } {
  const e = estimateConveyor(sim, from, to, capacityTph, stockpileId);
  if (e.problems.length) return { problems: e.problems };
  if (!sim.canAfford(e.cost)) return { problems: [`Not enough cash or credit for the conveyor ($${e.cost.toLocaleString()})`] };
  const target = stockpileId ? sim.stockpile(stockpileId) : null;
  const end = target ? { x: target.x, z: target.z } : to;
  const p = project(sim, "CONVEYOR", `Conveyor ${sim.state.conveyors.length + sim.state.projects.filter((x) => x.type === "CONVEYOR" && x.status !== "COMPLETE").length + 1}`, [from, end], e);
  p.capacityTph = capacityTph;
  p.stockpileId = target?.id ?? null;
  sim.state.projects.push(p);
  return { project: p, estimate: e };
}

export function planStockpileProject(sim: Sim, at: { x: number; z: number }, capacityT: number): { project: ConstructionProject; estimate: ProjectEstimate } | { problems: string[] } {
  const e = estimateStockpile(sim, at, capacityT);
  if (e.problems.length) return { problems: e.problems };
  if (!sim.canAfford(e.cost)) return { problems: [`Not enough cash or credit for the stockpile ($${e.cost.toLocaleString()})`] };
  const p = project(sim, "STOCKPILE", `Coal stockpile ${sim.state.stockpiles.length + 1}`, [at], e);
  p.capacityT = capacityT;
  sim.state.projects.push(p);
  return { project: p, estimate: e };
}

/**
 * Do `minutes` of work (scaled by `rate`) on a project: pays for it pro rata and, for roads, grades
 * the stretch of alignment the progress has reached. Returns true when the project is finished.
 */
export function workOnProject(sim: Sim, p: ConstructionProject, minutes: number, rate: number): boolean {
  if (p.status === "COMPLETE" || p.status === "CANCELLED") return true;
  p.status = "IN_PROGRESS";
  const before = p.progress;
  p.progress = Math.min(1, p.progress + (minutes * rate) / Math.max(1, p.workMinutes));
  const pay = p.cost * (p.progress - before);
  if (pay > 0) {
    sim.spend(pay, "construction", `${p.name}: construction`);
    p.spent += pay;
  }
  if (p.type === "HAUL_ROAD") gradeAlignment(sim, p, before, p.progress);
  if (p.progress >= 1 - 1e-9) {
    completeProject(sim, p);
    return true;
  }
  return false;
}

/** Point along the alignment at fraction f. */
export function alongPath(p: ConstructionProject, f: number): { x: number; z: number } {
  const a = p.path[0]!;
  const b = p.path[p.path.length - 1]!;
  return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
}

/** Cut and fill the cells under the road between progress fractions f0 and f1 to the straight profile. */
function gradeAlignment(sim: Sim, p: ConstructionProject, f0: number, f1: number): void {
  const t = sim.terrain;
  const half = CONSTRUCTION.HAUL_ROAD.width / 2;
  const a = p.path[0]!;
  const b = p.path[p.path.length - 1]!;
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const ux = (b.x - a.x) / len;
  const uz = (b.z - a.z) / len;
  const h0 = p.startElevation ?? t.heightAt(a.x, a.z);
  const h1 = p.endElevation ?? t.heightAt(b.x, b.z);
  const s0 = f0 * len - t.cellSize;
  const s1 = f1 * len + t.cellSize;
  const pad = half + t.cellSize;
  const lo = t.cellOf(Math.min(a.x, b.x) - pad, Math.min(a.z, b.z) - pad);
  const hi = t.cellOf(Math.max(a.x, b.x) + pad, Math.max(a.z, b.z) + pad);
  for (let j = lo.j; j <= hi.j; j++) {
    for (let i = lo.i; i <= hi.i; i++) {
      const x = t.cellX(i) - a.x;
      const z = t.cellZ(j) - a.z;
      const along = x * ux + z * uz;
      const across = Math.abs(x * -uz + z * ux);
      if (along < s0 || along > s1 || along < -t.cellSize * 0.5 || along > len + t.cellSize * 0.5 || across > half + t.cellSize * 0.5) continue;
      const f = Math.max(0, Math.min(1, along / len));
      const target = h0 + (h1 - h0) * f;
      // Full grade under the running surface, a blended shoulder beyond it.
      const w = across <= half ? 1 : 1 - (across - half) / (t.cellSize * 0.5);
      const k = t.index(i, j);
      const cur = t.state.surface[k]!;
      const next = cur + (target - cur) * Math.max(0, Math.min(1, w));
      if (Math.abs(next - cur) < 1e-4) continue;
      const fill = Math.max(0, t.state.fill[k]! + (next - cur));
      t.state.surface[k] = next;
      t.state.fill[k] = fill;
      t.state.disturbed[k] = 1;
      t.markDirty(i, j);
    }
  }
}

function completeProject(sim: Sim, p: ConstructionProject): void {
  p.status = "COMPLETE";
  p.progress = 1;
  p.completedAt = sim.minute;
  if (p.type === "HAUL_ROAD") {
    const cfg = CONSTRUCTION.HAUL_ROAD;
    const node = (id: string | null, pt: { x: number; z: number }): string => {
      if (id && sim.state.roadNodes.some((n) => n.id === id)) return id;
      let nid = sim.nextId("node");
      while (sim.state.roadNodes.some((x) => x.id === nid)) nid = sim.nextId("node");
      const n: RoadNode = { id: nid, x: pt.x, z: pt.z };
      sim.state.roadNodes.push(n);
      return n.id;
    };
    const a = node(p.startNodeId, p.path[0]!);
    const b = node(p.endNodeId, p.path[p.path.length - 1]!);
    // Scenario roads carry their own ids ("road-1" …): skip any id already in use.
    let id = sim.nextId("road");
    while (sim.state.roadEdges.some((e) => e.id === id)) id = sim.nextId("road");
    const edge: RoadEdge = { id, a, b, condition: 100, speedLimitKmh: cfg.speedLimitKmh, width: cfg.width, traffic: 0 };
    sim.state.roadEdges.push(edge);
    rasterizeRoads(sim);
    sim.notify("good", `${p.name} is open`, `${Math.round(pathLength(p.path))} m of haul road joined the network. Trucks will use it from their next trip.`);
  } else if (p.type === "STOCKPILE") {
    const at = p.path[0]!;
    const s: Stockpile = { id: sim.nextId("stockpile"), name: p.name, x: at.x, z: at.z, materialType: "COAL_RAW", capacityT: p.capacityT ?? 10000, tonnes: 0, quality: null, inT: 0, outT: 0 };
    sim.state.stockpiles.push(s);
    sim.notify("good", `${p.name} is ready`, `${(s.capacityT / 1000).toFixed(0)} kt of coal storage.`);
  } else {
    const cfg = CONSTRUCTION.CONVEYOR;
    const from = p.path[0]!;
    const to = p.path[p.path.length - 1]!;
    let stockpileId = p.stockpileId;
    if (!stockpileId || !sim.stockpile(stockpileId)) {
      const s: Stockpile = { id: sim.nextId("stockpile"), name: `${p.name} stockpile`, x: to.x, z: to.z, materialType: "COAL_RAW", capacityT: cfg.newStockpileCapacityT, tonnes: 0, quality: null, inT: 0, outT: 0 };
      sim.state.stockpiles.push(s);
      stockpileId = s.id;
    }
    const conveyorId = sim.nextId("conveyor");
    const hopper: Hopper = { id: sim.nextId("hopper"), name: `${p.name} hopper`, x: from.x, z: from.z, capacityT: cfg.hopperCapacityT, tonnes: 0, quality: null, conveyorId };
    const tph = p.capacityTph ?? 400;
    const length = pathLength(p.path);
    const c: Conveyor = {
      id: conveyorId,
      name: p.name,
      hopperId: hopper.id,
      stockpileId,
      path: p.path.map((q) => ({ ...q })),
      length,
      capacityTph: tph,
      speed: cfg.speed,
      powerKw: Math.round(tph * cfg.kwPerTph + length * 0.15),
      state: "OFFLINE",
      enabled: true,
      condition: 100,
      operatingHours: 0,
      beltT: 0,
      slices: [],
      startTimer: 0,
      totalT: 0,
      breakdown: null,
    };
    sim.state.hoppers.push(hopper);
    sim.state.conveyors.push(c);
    sim.notify("good", `${p.name} commissioned`, `${Math.round(length)} m at ${tph} t/h into ${sim.stockpile(stockpileId)?.name ?? "a stockpile"}. Send coal trucks to ${hopper.name}.`);
  }
}

export function cancelProject(sim: Sim, id: string): string | null {
  const p = sim.state.projects.find((x) => x.id === id);
  if (!p) return "Unknown project";
  if (p.status === "COMPLETE") return "That project is already complete";
  p.status = "CANCELLED";
  return null;
}

export { pathLength };
