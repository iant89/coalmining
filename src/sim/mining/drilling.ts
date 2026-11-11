/**
 * Blast-hole drilling (spec §16). A pattern is data: hole positions and depths over a block; only
 * the renderer decides whether to draw holes. In TO_COAL mode the driller stops the moment cuttings
 * turn black, which protects the seam but leaves unblasted rock if the seam is deeper than the
 * hole's design limit. In FIXED mode every hole goes to depth, and holes that pass the roof damage
 * coal when fired. Either way the holes tell the player where the roof really is.
 */
import type { Sim } from "../sim.js";
import type { DrillDepthMode, DrillHole, DrillPattern, EquipmentInstance, MiningBlock } from "../state.js";
import { estimateAt, hardnessAt, seamThickness, type GeoSample } from "../world/geology.js";
import { discoverSeam } from "./exploration.js";

export const DRILL_COST_PER_M = 9;

export interface PatternOptions {
  spacing: number;
  burden: number;
  depthMode: DrillDepthMode;
  /** FIXED: hole depth (m). TO_COAL: depth cap if no coal is met (m). */
  depth: number;
  subdrill?: number;
}

export const DEFAULT_PATTERN: PatternOptions = { spacing: 6, burden: 6, depthMode: "TO_COAL", depth: 14, subdrill: 0.6 };

/** `id` defaults to a fresh simulation id; UI previews pass a fixed one so they never touch state. */
export function designPattern(sim: Sim, block: MiningBlock, opts: PatternOptions, id?: string): DrillPattern {
  const t = sim.terrain;
  const x0 = t.cellX(block.rect.i0) - t.cellSize / 2;
  const x1 = t.cellX(block.rect.i1) + t.cellSize / 2;
  const z0 = t.cellZ(block.rect.j0) - t.cellSize / 2;
  const z1 = t.cellZ(block.rect.j1) + t.cellSize / 2;
  const holes: DrillHole[] = [];
  const nx = Math.max(1, Math.round((x1 - x0) / opts.spacing));
  const nz = Math.max(1, Math.round((z1 - z0) / opts.burden));
  for (let b = 0; b < nz; b++) {
    for (let s = 0; s < nx; s++) {
      // Staggered rows: every other row offset by half a spacing (clamped inside the block).
      const off = b % 2 ? 0.5 : 0;
      const x = Math.min(x1 - 0.5, x0 + ((s + 0.5 + off * 0.5) * (x1 - x0)) / nx);
      const z = z0 + ((b + 0.5) * (z1 - z0)) / nz;
      const { i, j } = t.cellOf(x, z);
      const surface = t.surfaceAt(i, j);
      let designDepth = opts.depth;
      if (opts.depthMode === "TO_COAL") {
        // The expected depth (for time and cost estimates) is the estimated roof; the driller will
        // actually stop wherever the coal really is, or at the cap.
        const e = estimateAt(sim.state.samples, x, z);
        if (e.seamTopElevation !== null) designDepth = Math.min(opts.depth, Math.max(1, surface - e.seamTopElevation));
      }
      holes.push({ x, z, i, j, designDepth, drilled: false, depth: 0, collar: surface, coalAt: null });
    }
  }
  const pattern: DrillPattern = {
    id: id ?? sim.nextId("pattern"),
    blockId: block.id,
    spacing: opts.spacing,
    burden: opts.burden,
    depthMode: opts.depthMode,
    depth: opts.depth,
    subdrill: opts.depthMode === "FIXED" ? opts.subdrill ?? 0.6 : 0,
    holes,
    createdAt: sim.minute,
    completedAt: null,
  };
  return pattern;
}

export interface PatternEstimate {
  holes: number;
  totalMetres: number;
  /** Drilling time for one drill at nominal penetration, minutes. */
  minutes: number;
  cost: number;
  rockVolumeM3: number;
}

export function estimatePattern(sim: Sim, pattern: DrillPattern, drill: EquipmentInstance | null): PatternEstimate {
  const def = drill ? sim.def(drill) : null;
  const rate = def?.penetrationMph ?? 26;
  const setup = def?.holeSetupMin ?? 1.5;
  let metres = 0;
  for (const h of pattern.holes) metres += h.designDepth + pattern.subdrill;
  return {
    holes: pattern.holes.length,
    totalMetres: metres,
    minutes: (metres / rate) * 60 + pattern.holes.length * (setup + 1),
    cost: metres * DRILL_COST_PER_M,
    rockVolumeM3: pattern.holes.reduce((v, h) => v + h.designDepth * pattern.spacing * pattern.burden, 0),
  };
}

/** Minutes to drill `hole` with `drill` (penetration slows in hard rock). */
export function holeMinutes(sim: Sim, drill: EquipmentInstance, pattern: DrillPattern, hole: DrillHole, skill: number): number {
  const def = sim.def(drill);
  const k = sim.terrain.index(hole.i, hole.j);
  const surface = sim.terrain.state.surface[k]!;
  const hardness = hardnessAt(sim.state.geology, k, surface - Math.min(hole.designDepth, 6) / 2);
  const rate = (def.penetrationMph ?? 26) * (1.35 - 0.7 * hardness) * (0.8 + 0.35 * skill) * (drill.condition < 40 ? 0.85 : 1);
  return ((hole.designDepth + pattern.subdrill) / Math.max(4, rate)) * 60 + (def.holeSetupMin ?? 1.5);
}

/** Finish one hole against the true geology; logs coal if met. */
export function completeHole(sim: Sim, pattern: DrillPattern, hole: DrillHole): void {
  const t = sim.terrain;
  const g = sim.state.geology;
  const k = t.index(hole.i, hole.j);
  const collar = t.state.surface[k]!;
  const roofDepth = collar - t.state.fill[k]! >= g.seamTop[k]! && seamThickness(g, k) > 0.05 ? collar - g.seamTop[k]! : null;
  // TO_COAL holes keep going until the cuttings turn black, up to the pattern's depth cap.
  const full = pattern.depthMode === "TO_COAL" ? pattern.depth : hole.designDepth + pattern.subdrill;
  if (roofDepth !== null && roofDepth <= full) {
    hole.coalAt = roofDepth;
    hole.depth = pattern.depthMode === "TO_COAL" ? roofDepth : full;
  } else {
    hole.depth = full;
  }
  hole.drilled = true;
  hole.collar = collar - t.state.fill[k]!;
  sim.state.today.drilledM += hole.depth;
  sim.spend(hole.depth * DRILL_COST_PER_M, "drilling", `Blast hole ${hole.depth.toFixed(1)} m`);
  if (hole.coalAt !== null) {
    const sample: GeoSample = {
      id: sim.nextId("hole"),
      kind: "BLAST_HOLE",
      x: hole.x,
      z: hole.z,
      depth: hole.depth,
      seamDepth: hole.coalAt,
      thickness: null,
      quality: null,
      analysisDueMinute: null,
      reliability: 0.85,
      collarElevation: collar,
      minute: sim.minute,
      log: [],
    };
    sim.state.samples.push(sample);
    discoverSeam(sim);
  }
}

export function patternProgress(p: DrillPattern): number {
  if (p.holes.length === 0) return 1;
  return p.holes.filter((h) => h.drilled).length / p.holes.length;
}
