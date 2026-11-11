/**
 * Route planning over the haul-road graph (spec §22, §49). A route is a list of waypoints, each
 * carrying the speed limit of the leg that ends there. Equipment may leave the road network to reach
 * a pit face or dump point; off-road legs are slow. The planner compares going direct against
 * joining the network at any of the few nearest nodes at each end, by travel time.
 */
import type { Sim } from "../sim.js";
import type { RoadEdge, Waypoint } from "../state.js";

export const OFFROAD_KMH = 14;
const KMH = 1 / 3.6;

interface Adjacent {
  to: string;
  edge: RoadEdge;
  length: number;
}

function roadSpeed(edge: RoadEdge): number {
  return edge.speedLimitKmh * KMH * (0.55 + 0.45 * (edge.condition / 100));
}

function adjacency(sim: Sim): Map<string, Adjacent[]> {
  const pos = new Map(sim.state.roadNodes.map((n) => [n.id, n]));
  const adj = new Map<string, Adjacent[]>();
  for (const e of sim.state.roadEdges) {
    const a = pos.get(e.a);
    const b = pos.get(e.b);
    if (!a || !b) continue;
    const length = Math.hypot(a.x - b.x, a.z - b.z);
    (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push({ to: e.b, edge: e, length });
    (adj.get(e.b) ?? adj.set(e.b, []).get(e.b)!).push({ to: e.a, edge: e, length });
  }
  return adj;
}

function nearestNodes(sim: Sim, x: number, z: number, k: number): { id: string; d: number }[] {
  return sim.state.roadNodes
    .map((n) => ({ id: n.id, d: Math.hypot(n.x - x, n.z - z) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, k);
}

/** Dijkstra by travel time from `start`; returns time and predecessor maps. */
function shortest(adj: Map<string, Adjacent[]>, start: string): { time: Map<string, number>; prev: Map<string, Adjacent & { from: string }> } {
  const time = new Map<string, number>([[start, 0]]);
  const prev = new Map<string, Adjacent & { from: string }>();
  const open = new Set<string>([start]);
  while (open.size) {
    let cur = "";
    let best = Infinity;
    for (const id of open) {
      const t = time.get(id)!;
      if (t < best) {
        best = t;
        cur = id;
      }
    }
    open.delete(cur);
    for (const a of adj.get(cur) ?? []) {
      const t = best + a.length / roadSpeed(a.edge);
      if (t < (time.get(a.to) ?? Infinity)) {
        time.set(a.to, t);
        prev.set(a.to, { ...a, from: cur });
        open.add(a.to);
      }
    }
  }
  return { time, prev };
}

export function planRoute(sim: Sim, fromX: number, fromZ: number, toX: number, toZ: number, maxOffroadKmh = OFFROAD_KMH): Waypoint[] {
  const off = maxOffroadKmh * KMH;
  const direct = Math.hypot(toX - fromX, toZ - fromZ);
  const directRoute: Waypoint[] = [{ x: toX, z: toZ, limit: off, edgeId: null }];
  if (direct < 1e-3) return [];
  if (sim.state.roadNodes.length < 2) return directRoute;

  const adj = adjacency(sim);
  const pos = new Map(sim.state.roadNodes.map((n) => [n.id, n]));
  let bestTime = direct / off;
  let best: Waypoint[] = directRoute;
  for (const s of nearestNodes(sim, fromX, fromZ, 3)) {
    const { time, prev } = shortest(adj, s.id);
    for (const e of nearestNodes(sim, toX, toZ, 3)) {
      const rt = time.get(e.id);
      if (rt === undefined) continue;
      const total = s.d / off + rt + e.d / off;
      if (total >= bestTime * 0.98) continue;
      // Rebuild the node chain e ← … ← s.
      const legs: Waypoint[] = [];
      let cur = e.id;
      while (cur !== s.id) {
        const p = prev.get(cur);
        if (!p) break;
        const n = pos.get(cur)!;
        legs.push({ x: n.x, z: n.z, limit: roadSpeed(p.edge), edgeId: p.edge.id });
        cur = p.from;
      }
      legs.reverse();
      const sn = pos.get(s.id)!;
      const route: Waypoint[] = [];
      if (s.d > 0.5) route.push({ x: sn.x, z: sn.z, limit: off, edgeId: null });
      route.push(...legs);
      route.push({ x: toX, z: toZ, limit: off, edgeId: null });
      bestTime = total;
      best = route;
    }
  }
  return best;
}

export function routeLength(fromX: number, fromZ: number, route: readonly Waypoint[]): number {
  let d = 0;
  let x = fromX;
  let z = fromZ;
  for (const w of route) {
    d += Math.hypot(w.x - x, w.z - z);
    x = w.x;
    z = w.z;
  }
  return d;
}

/** Rasterize road edges into the terrain road mask (for rendering and road-speed lookups). */
export function rasterizeRoads(sim: Sim): void {
  const t = sim.terrain;
  t.state.road.fill(0);
  const pos = new Map(sim.state.roadNodes.map((n) => [n.id, n]));
  for (const e of sim.state.roadEdges) {
    const a = pos.get(e.a);
    const b = pos.get(e.b);
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.ceil(len / (t.cellSize * 0.4));
    for (let s = 0; s <= steps; s++) {
      const x = a.x + ((b.x - a.x) * s) / steps;
      const z = a.z + ((b.z - a.z) * s) / steps;
      const half = e.width / 2;
      for (let dz = -half; dz <= half; dz += t.cellSize * 0.5) {
        for (let dx = -half; dx <= half; dx += t.cellSize * 0.5) {
          const { i, j } = t.cellOf(x + dx, z + dz);
          t.state.road[t.index(i, j)] = 1;
        }
      }
    }
  }
  t.markAllDirty();
}
