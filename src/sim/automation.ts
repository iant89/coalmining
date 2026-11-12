/**
 * Dispatch automation that reacts to domain events (spec §75). With "auto maintenance" on, a
 * breakdown files a high-priority repair for whoever is qualified; the player can still do it by
 * hand. Kept separate from the task system so the coupling is one-way: events in, tasks out.
 */
import type { Sim } from "./sim.js";
import type { EquipmentInstance } from "./state.js";
import { createTask, TERMINAL } from "./tasks/service.js";
import { GREASE_INTERVAL_H } from "./equipment/operation.js";

/** Lube trucks top up machines below this fuel fraction (or overdue for grease). */
export const LUBE_FUEL_THRESHOLD = 0.35;

/** Below this condition, idle graders are sent out when auto-grading is on. */
export const ROAD_MAINTENANCE_THRESHOLD = 70;

/**
 * Hourly dispatch for standing objectives (spec §11.2 MAINTAIN_ROAD): an idle grader takes the
 * worst haul road below the threshold that nobody is already grading.
 */
export function autoDispatch(sim: Sim): void {
  if (!sim.state.settings.autoGrade) return;
  // Graders in a crew are the foreman's to send.
  const inCrew = new Set(sim.state.crews.flatMap((c) => c.equipmentIds));
  const graders = sim.state.equipment.filter((e) => sim.def(e).category === "GRADER" && !inCrew.has(e.id) && !e.currentTaskId && e.state !== "BROKEN" && e.condition > 0);
  if (graders.length === 0) return;
  const taken = new Set(sim.state.tasks.filter((t) => t.type === "GRADE_ROAD" && !TERMINAL.has(t.status) && t.destination?.kind === "road").map((t) => (t.destination as { id: string }).id));
  const worst = sim.state.roadEdges.filter((e) => e.condition < ROAD_MAINTENANCE_THRESHOLD && !taken.has(e.id)).sort((a, b) => a.condition - b.condition);
  for (const g of graders) {
    const road = worst.shift();
    if (!road) break;
    createTask(sim, { type: "GRADE_ROAD", equipmentId: g.id, destination: { kind: "road", id: road.id }, priority: "LOW", label: `Grade road ${road.a} → ${road.b}` });
  }
}

function fit(e: EquipmentInstance): boolean {
  return !e.currentTaskId && e.state !== "BROKEN" && e.state !== "DISABLED" && e.condition > 0;
}

function targeted(sim: Sim, type: "FIELD_FUEL" | "SERVICE_CALL"): Set<string> {
  return new Set(sim.state.tasks.filter((t) => t.type === type && !TERMINAL.has(t.status) && t.destination?.kind === "equipment").map((t) => (t.destination as { id: string }).id));
}

/** A working service truck the mechanic can take out (null: repairs are done the old way). */
export function hasServiceTruck(sim: Sim, exceptId?: string): boolean {
  return sim.state.equipment.some((e) => sim.def(e).category === "SERVICE_TRUCK" && e.id !== exceptId && e.state !== "BROKEN" && e.condition > 0);
}

/**
 * Every ten minutes: idle lube trucks go to the machine most in need of diesel or grease, and
 * idle service trucks take preventive maintenance out to machines that are overdue.
 */
export function supportDispatch(sim: Sim): void {
  const eqs = sim.state.equipment;
  if (sim.state.settings.autoFuel) {
    const lubes = eqs.filter((e) => sim.def(e).category === "LUBE_TRUCK" && fit(e));
    if (lubes.length > 0) {
      const taken = targeted(sim, "FIELD_FUEL");
      const needy = eqs
        .filter((e) => sim.def(e).category !== "LUBE_TRUCK" && !taken.has(e.id) && !e.serviceHold && (e.fuelL / sim.def(e).fuelCapacityL < LUBE_FUEL_THRESHOLD || e.hoursSinceGrease > GREASE_INTERVAL_H))
        .sort((a, b) => a.fuelL / sim.def(a).fuelCapacityL - b.fuelL / sim.def(b).fuelCapacityL);
      for (const lube of lubes) {
        if (needy.length === 0) break;
        // Nearest among the three thirstiest, so one truck does not criss-cross the pit.
        const short = needy.slice(0, 3).sort((a, b) => Math.hypot(a.x - lube.x, a.z - lube.z) - Math.hypot(b.x - lube.x, b.z - lube.z));
        const target = short[0]!;
        needy.splice(needy.indexOf(target), 1);
        createTask(sim, { type: "FIELD_FUEL", equipmentId: lube.id, destination: { kind: "equipment", id: target.id }, priority: "NORMAL", label: `Refuel & grease ${target.name}` });
      }
    }
  }
  if (sim.state.settings.autoMaintenance) {
    const trucks = eqs.filter((e) => sim.def(e).category === "SERVICE_TRUCK" && fit(e));
    if (trucks.length > 0) {
      const taken = targeted(sim, "SERVICE_CALL");
      const inShop = new Set(sim.state.tasks.filter((t) => (t.type === "MAINTENANCE" || t.type === "REPAIR") && !TERMINAL.has(t.status)).map((t) => t.assignedEquipmentId));
      const overdue = eqs
        .filter((e) => sim.def(e).category !== "SERVICE_TRUCK" && e.state !== "BROKEN" && !taken.has(e.id) && !inShop.has(e.id) && !e.serviceHold && e.hoursSinceService > sim.def(e).maintenanceIntervalH)
        .sort((a, b) => b.hoursSinceService / sim.def(b).maintenanceIntervalH - a.hoursSinceService / sim.def(a).maintenanceIntervalH);
      for (const truck of trucks) {
        const target = overdue.shift();
        if (!target) break;
        createTask(sim, { type: "SERVICE_CALL", equipmentId: truck.id, destination: { kind: "equipment", id: target.id }, params: { service: "PM" }, priority: "NORMAL", label: `Field service ${target.name}` });
      }
    }
  }
}

export function wireAutomation(sim: Sim): void {
  sim.bus.on("EquipmentBreakdown", (e) => {
    if (!sim.state.settings.autoMaintenance) return;
    const already = sim.state.tasks.some(
      (t) => !TERMINAL.has(t.status) && ((t.type === "REPAIR" && t.assignedEquipmentId === e.equipmentId) || (t.type === "SERVICE_CALL" && t.destination?.kind === "equipment" && t.destination.id === e.equipmentId)),
    );
    if (already) return;
    const name = sim.equipment(e.equipmentId)?.name ?? "";
    // With a service truck the mechanic drives out to the machine; otherwise they walk the job.
    if (hasServiceTruck(sim, e.equipmentId)) {
      const r = createTask(sim, { type: "SERVICE_CALL", destination: { kind: "equipment", id: e.equipmentId }, params: { service: "REPAIR" }, priority: "HIGH", label: `Field repair ${name}`.trim() });
      if (r.ok) return;
    }
    createTask(sim, { type: "REPAIR", equipmentId: e.equipmentId, priority: "HIGH", label: `Repair ${name}`.trim() });
  });
}
