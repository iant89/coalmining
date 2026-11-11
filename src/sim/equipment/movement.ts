/**
 * Movement AI (spec §50, bottom layer): follows a route the layers above planned. Speed comes from
 * the machine's spec and upgrades, the leg's limit, grade, load, road condition, weather, operator
 * skill/fatigue and machine condition — so cycle times (spec §21) emerge rather than being set.
 */
import type { Sim } from "../sim.js";
import type { Employee, EquipmentInstance, Waypoint } from "../state.js";
import { planRoute } from "../logistics/navigation.js";
import { runEngine } from "./operation.js";
import { weatherEffects } from "../environment/weather.js";
import { workerPerformance } from "../workforce/workforce.js";

const KMH = 1 / 3.6;

export function setDestination(sim: Sim, eq: EquipmentInstance, x: number, z: number): void {
  const def = sim.def(eq);
  eq.route = planRoute(sim, eq.x, eq.z, x, z, Math.min(14, def.maxSpeedKmh));
  eq.routeIndex = 0;
  if (eq.route.length === 0) eq.route = null;
}

export function setDirect(eq: EquipmentInstance, x: number, z: number, limitKmh: number): void {
  eq.route = [{ x, z, limit: limitKmh * KMH, edgeId: null }];
  eq.routeIndex = 0;
}

export function arrived(eq: EquipmentInstance): boolean {
  return eq.route === null;
}

/** Speed on a leg toward `w`, m/s. */
export function legSpeed(sim: Sim, eq: EquipmentInstance, w: Waypoint, operator: Employee | null): number {
  const def = sim.def(eq);
  const loaded = !!eq.payload && eq.payload.tonnes > 1;
  let v = Math.min(def.maxSpeedKmh * KMH * sim.catalog.modifier(eq.upgrades, "speed"), w.limit);
  if (loaded) v *= def.loadedSpeedFactor;
  const dist = Math.max(1, Math.hypot(w.x - eq.x, w.z - eq.z));
  const grade = (sim.terrain.heightAt(w.x, w.z) - sim.terrain.heightAt(eq.x, eq.z)) / dist;
  const gradeability = sim.catalog.modifier(eq.upgrades, "gradeability");
  if (grade > 0) v /= 1 + (grade * (loaded ? 14 : 6)) / gradeability;
  else v /= 1 + -grade * (loaded ? 5 : 2.5);
  v *= weatherEffects(sim.state.weather.kind).speed;
  if (operator) v *= 0.82 + 0.25 * workerPerformance(operator, "driving");
  if (eq.condition < 40) v *= 0.85;
  return Math.max(0.8, v);
}

/**
 * Advance along the route for up to `budget` minutes; returns unused minutes. Fuel, hours and wear
 * are charged for the time spent moving.
 */
export function travel(sim: Sim, eq: EquipmentInstance, budget: number, operator: Employee | null): number {
  let left = budget;
  let spent = 0;
  while (eq.route && left > 1e-9) {
    const w = eq.route[eq.routeIndex];
    if (!w) {
      eq.route = null;
      break;
    }
    const dx = w.x - eq.x;
    const dz = w.z - eq.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) {
      eq.routeIndex++;
      if (eq.routeIndex >= eq.route.length) eq.route = null;
      continue;
    }
    const v = legSpeed(sim, eq, w, operator);
    eq.speed = v;
    eq.heading = Math.atan2(dx, dz);
    const need = d / v / 60;
    if (w.edgeId) {
      const edge = sim.state.roadEdges.find((e) => e.id === w.edgeId);
      if (edge) edge.traffic += (eq.payload ? 1.6 : 1) * sim.catalog.modifier(eq.upgrades, "roadWear") * Math.min(need, left);
    }
    if (need <= left) {
      eq.x = w.x;
      eq.z = w.z;
      left -= need;
      spent += need;
      eq.routeIndex++;
      if (eq.routeIndex >= eq.route.length) eq.route = null;
    } else {
      const f = (left * 60 * v) / d;
      eq.x += dx * f;
      eq.z += dz * f;
      spent += left;
      left = 0;
    }
  }
  if (spent > 0) runEngine(sim, eq, spent, eq.payload ? 0.85 : 0.55, operator?.skills.equipmentOperation ?? 0.5);
  if (!eq.route) eq.speed = 0;
  return left;
}
