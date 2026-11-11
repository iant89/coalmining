/**
 * Test fixtures: the shipped scenario, plus small hand-built worlds for single-system tests
 * (spec §77 debug scenarios). Everything is deterministic for a seed.
 */
import { defaultCatalog } from "../src/sim/equipment/catalog.js";
import { DEFAULT_SCENARIO, loadScenario, SCENARIOS } from "../src/sim/scenario.js";
import { MineSimulation } from "../src/sim/simulation.js";
import type { SimState } from "../src/sim/state.js";
import { TICK_SECONDS } from "../src/sim/core/clock.js";

export const catalog = defaultCatalog();

export function blackCreek(seed?: number): MineSimulation {
  return new MineSimulation(loadScenario(SCENARIOS[DEFAULT_SCENARIO]!, catalog, seed === undefined ? {} : { seed }), catalog);
}

export function equipmentOf(ms: MineSimulation, defId: string, n = 0) {
  const list = ms.state.equipment.filter((e) => e.defId === defId);
  const eq = list[n];
  if (!eq) throw new Error(`no ${defId} #${n}`);
  return eq;
}

/** Advance tick by tick until `pred` holds or `maxMinutes` pass; returns minutes elapsed. */
export function runUntil(ms: MineSimulation, pred: () => boolean, maxMinutes: number): number {
  const ticks = Math.ceil((maxMinutes * 60) / TICK_SECONDS);
  for (let n = 0; n <= ticks; n++) {
    if (pred()) return (n * TICK_SECONDS) / 60;
    ms.tick();
  }
  throw new Error(`condition not met within ${maxMinutes} simulated minutes`);
}

/** Stable digest of the parts of state that matter for determinism. */
export function digest(state: SimState): string {
  const t = state.terrain;
  let h = 0;
  for (let k = 0; k < t.surface.length; k++) h = (h * 31 + Math.round(t.surface[k]! * 1000)) >>> 0;
  const eq = state.equipment.map((e) => `${e.id}:${e.x.toFixed(3)},${e.z.toFixed(3)},${e.fuelL.toFixed(3)},${e.condition.toFixed(4)},${e.state},${e.payload?.tonnes.toFixed(3) ?? "-"}`).join("|");
  const tasks = state.tasks.map((x) => `${x.id}:${x.status}:${x.phase}:${x.materialAmount.toFixed(3)}`).join("|");
  return `${h}#${state.treasury.cash.toFixed(2)}#${state.clock.tick}#${state.rngState}#${eq}#${tasks}`;
}
