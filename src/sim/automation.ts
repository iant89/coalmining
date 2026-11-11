/**
 * Dispatch automation that reacts to domain events (spec §75). With "auto maintenance" on, a
 * breakdown files a high-priority repair for whoever is qualified; the player can still do it by
 * hand. Kept separate from the task system so the coupling is one-way: events in, tasks out.
 */
import type { Sim } from "./sim.js";
import { createTask, TERMINAL } from "./tasks/service.js";

export function wireAutomation(sim: Sim): void {
  sim.bus.on("EquipmentBreakdown", (e) => {
    if (!sim.state.settings.autoMaintenance) return;
    const already = sim.state.tasks.some((t) => t.type === "REPAIR" && t.assignedEquipmentId === e.equipmentId && !TERMINAL.has(t.status));
    if (already) return;
    createTask(sim, { type: "REPAIR", equipmentId: e.equipmentId, priority: "HIGH", label: `Repair ${sim.equipment(e.equipmentId)?.name ?? ""}`.trim() });
  });
}
