/**
 * Tutorial objectives for the first vertical slice (spec §69 workflow). Each objective is a
 * predicate over simulation state — story progress always comes from the simulation (spec §42).
 */
import type { Sim } from "./sim.js";

export interface ObjectiveDef {
  id: string;
  title: string;
  done: (sim: Sim) => boolean;
}

export const SLICE_OBJECTIVES: ObjectiveDef[] = [
  { id: "explore", title: "Drill for coal (a core hole or blast holes)", done: (s) => s.state.samples.some((x) => x.kind === "CORE" || x.kind === "BLAST_HOLE") },
  { id: "seam", title: "Confirm the coal seam", done: (s) => s.state.seamDiscovered },
  { id: "drill", title: "Drill a blast pattern on a block", done: (s) => s.state.drillPatterns.some((p) => p.completedAt !== null) },
  { id: "blast", title: "Fire a blast", done: (s) => s.state.blasts.some((b) => b.state === "COMPLETED") },
  { id: "overburden", title: "Remove overburden (move 2,000 t to spoil)", done: (s) => s.state.blocks.reduce((a, b) => a + b.overburdenMovedT, 0) >= 2000 },
  { id: "expose", title: "Expose coal in a block", done: (s) => s.state.blocks.some((b) => b.state === "COAL_EXPOSED" || b.state === "COAL_MINING" || b.state === "COMPLETE") },
  { id: "mine", title: "Mine and haul 500 t of coal to the ROM stockpile", done: (s) => s.state.stockpiles.reduce((a, p) => a + p.inT, 0) >= 500 },
  { id: "sell", title: "Sell coal", done: (s) => s.state.history.some((d) => d.coalSoldT > 0) || s.state.today.coalSoldT > 0 },
  { id: "buy", title: "Buy more equipment", done: (s) => s.state.equipment.some((e) => e.purchasedDay > 0) },
];

export function updateObjectives(sim: Sim): void {
  for (const o of sim.state.objectives) {
    if (o.done) continue;
    const def = SLICE_OBJECTIVES.find((d) => d.id === o.id);
    if (def?.done(sim)) {
      o.done = true;
      sim.notify("good", `Objective complete: ${o.title}`, "");
    }
  }
}
