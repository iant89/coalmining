import type { Sim } from "../sim.js";
import { geoMaterialAt } from "../world/geology.js";
import { GEO_MATERIALS } from "../world/materials.js";

export { haulClass, MATERIAL_LABEL, mergeParcel } from "../world/materials.js";

/** Is the in-situ material at the surface of cell k rock that needed blasting? */
export function surfaceMaterialIsRock(sim: Sim, k: number): boolean {
  const t = sim.terrain.state;
  if (t.fill[k]! > 0.01) return false;
  return GEO_MATERIALS[geoMaterialAt(sim.state.geology, k, t.surface[k]! - 0.01)].needsBlasting;
}
