/**
 * Dispatch automation that reacts to domain events (spec §75). With "auto maintenance" on, a
 * breakdown files a high-priority repair for whoever is qualified; the player can still do it by
 * hand. Kept separate from the task system so the coupling is one-way: events in, tasks out.
 */
import type { Sim } from "./sim.js";
import { createTask, TERMINAL } from "./tasks/service.js";

/** Below this condition, idle graders are sent out when auto-grading is on. */
export const ROAD_MAINTENANCE_THRESHOLD = 70;

/**
 * Hourly dispatch for standing objectives (spec §11.2 MAINTAIN_ROAD): an idle grader takes the
 * worst haul road below the threshold that nobody is already grading.
 */
export function autoDispatch(sim: Sim): void {
  if (!sim.state.settings.autoGrade) return;
  const graders = sim.state.equipment.filter((e) => sim.def(e).category === "GRADER" && !e.currentTaskId && e.state !== "BROKEN" && e.condition > 0);
  if (graders.length === 0) return;
  const taken = new Set(sim.state.tasks.filter((t) => t.type === "GRADE_ROAD" && !TERMINAL.has(t.status) && t.destination?.kind === "road").map((t) => (t.destination as { id: string }).id));
  const worst = sim.state.roadEdges.filter((e) => e.condition < ROAD_MAINTENANCE_THRESHOLD && !taken.has(e.id)).sort((a, b) => a.condition - b.condition);
  for (const g of graders) {
    const road = worst.shift();
    if (!road) break;
    createTask(sim, { type: "GRADE_ROAD", equipmentId: g.id, destination: { kind: "road", id: road.id }, priority: "LOW", label: `Grade road ${road.a} → ${road.b}` });
  }
}

export function wireAutomation(sim: Sim): void {
  sim.bus.on("EquipmentBreakdown", (e) => {
    if (!sim.state.settings.autoMaintenance) return;
    const already = sim.state.tasks.some((t) => t.type === "REPAIR" && t.assignedEquipmentId === e.equipmentId && !TERMINAL.has(t.status));
    if (already) return;
    createTask(sim, { type: "REPAIR", equipmentId: e.equipmentId, priority: "HIGH", label: `Repair ${sim.equipment(e.equipmentId)?.name ?? ""}`.trim() });
  });
}
