/**
 * Mining blocks (spec §15): the unit the player plans with. A block's state advances as tasks do
 * work on it; `analyzeBlock` reports what is physically left by reading the true terrain/geology,
 * which is what an excavator operator sees at the face. Reserve *estimates* use known geology only.
 */
import type { Sim } from "../sim.js";
import type { MiningBlock } from "../state.js";
import { GEO_MATERIALS } from "../world/materials.js";
import { estimateAt, seamThickness } from "../world/geology.js";
import { rectCellCount, rectCells } from "../world/terrain.js";
import { DIG_TOLERANCE } from "./excavation.js";

export interface BlockAnalysis {
  cells: number;
  areaM2: number;
  /** Overburden (incl. topsoil and spoil) still above the seam roof, tonnes. */
  overburdenT: number;
  /** Of which unblasted rock, tonnes. */
  unblastedRockT: number;
  topsoilT: number;
  /** Coal not yet mined (exposed or buried), tonnes in situ. */
  coalT: number;
  /** Coal exposed at the surface right now, tonnes in situ. */
  exposedCoalT: number;
  /** Cells with coal fully exposed (roof reached). */
  exposedCells: number;
  /** Cells that ever had coal. */
  coalCells: number;
  meanSurface: number;
}

export function analyzeBlock(sim: Sim, block: MiningBlock): BlockAnalysis {
  const t = sim.terrain;
  const g = sim.state.geology;
  const a: BlockAnalysis = { cells: 0, areaM2: 0, overburdenT: 0, unblastedRockT: 0, topsoilT: 0, coalT: 0, exposedCoalT: 0, exposedCells: 0, coalCells: 0, meanSurface: 0 };
  const area = t.cellArea;
  for (const { i, j } of rectCells(block.rect)) {
    const k = t.index(i, j);
    const surface = t.state.surface[k]!;
    const fill = t.state.fill[k]!;
    const insituTop = surface - fill;
    const roof = g.seamTop[k]!;
    const floor = g.seamBottom[k]!;
    a.cells++;
    a.meanSurface += surface;
    if (fill > 0.01) a.overburdenT += fill * area * GEO_MATERIALS.SPOIL.bankDensity;
    if (insituTop - roof > DIG_TOLERANCE) {
      const topsoil = Math.max(0, insituTop - Math.max(g.topsoilBase[k]!, roof));
      const rock = Math.max(0, Math.min(insituTop, g.topsoilBase[k]!) - roof);
      a.topsoilT += topsoil * area * GEO_MATERIALS.TOPSOIL.bankDensity;
      a.overburdenT += topsoil * area * GEO_MATERIALS.TOPSOIL.bankDensity + rock * area * GEO_MATERIALS.SANDSTONE.bankDensity;
      const loose = t.state.looseFloor[k]!;
      const unblasted = Math.max(0, Math.min(Math.min(insituTop, g.topsoilBase[k]!), loose) - roof);
      a.unblastedRockT += unblasted * area * GEO_MATERIALS.SANDSTONE.bankDensity;
    }
    if (seamThickness(g, k) > 0.05) a.coalCells++;
    const coalTop = Math.min(insituTop, roof);
    const coal = coalTop - floor > DIG_TOLERANCE ? coalTop - floor : 0;
    a.coalT += coal * area * GEO_MATERIALS.COAL.bankDensity;
    if (insituTop <= roof + DIG_TOLERANCE && fill <= 0.01 && coal > 0) {
      a.exposedCells++;
      a.exposedCoalT += coal * area * GEO_MATERIALS.COAL.bankDensity;
    }
  }
  a.areaM2 = a.cells * area;
  a.meanSurface /= Math.max(1, a.cells);
  return a;
}

export interface BlockEstimate {
  /** Fraction of the block's cells with any seam estimate. */
  coverage: number;
  meanConfidence: number;
  /** Estimated coal in place, tonnes (null when unknown). */
  coalT: number | null;
  /** Estimated overburden above the seam, bank m³. */
  overburdenM3: number | null;
  /** Estimated strip ratio, bank m³ overburden per tonne coal. */
  stripRatio: number | null;
  meanRoofDepth: number | null;
}

/** The player's estimate of a block from samples only. */
export function estimateBlock(sim: Sim, block: MiningBlock): BlockEstimate {
  const t = sim.terrain;
  let known = 0;
  let conf = 0;
  let coal = 0;
  let ob = 0;
  let depth = 0;
  for (const { i, j } of rectCells(block.rect)) {
    const k = t.index(i, j);
    const e = estimateAt(sim.state.samples, t.cellX(i), t.cellZ(j));
    conf += e.confidence;
    if (e.seamTopElevation === null) continue;
    known++;
    const surface = t.state.surface[k]!;
    const d = Math.max(0, surface - e.seamTopElevation);
    depth += d;
    ob += d * t.cellArea;
    coal += (e.thickness ?? 0) * t.cellArea * GEO_MATERIALS.COAL.bankDensity;
  }
  const n = rectCellCount(block.rect);
  if (known === 0) return { coverage: 0, meanConfidence: conf / n, coalT: null, overburdenM3: null, stripRatio: null, meanRoofDepth: null };
  return {
    coverage: known / n,
    meanConfidence: conf / n,
    coalT: coal > 0 ? coal * (n / known) : null,
    overburdenM3: ob * (n / known),
    stripRatio: coal > 0 ? ob / coal : null,
    meanRoofDepth: depth / known,
  };
}

/** Re-derive the state of blocks being mined from what is physically left. */
export function refreshBlockState(sim: Sim, block: MiningBlock): void {
  if (block.state === "COMPLETE" || block.state === "RECLAIMING" || block.state === "RECLAIMED") return;
  const a = analyzeBlock(sim, block);
  const overburdenGone = a.overburdenT < 1;
  if (overburdenGone && a.coalCells > 0 && a.coalT > 1) {
    if (block.state !== "COAL_EXPOSED" && block.state !== "COAL_MINING") {
      block.state = "COAL_EXPOSED";
      sim.bus.emit({ type: "CoalExposed", blockId: block.id });
      sim.notify("good", `Coal exposed in ${block.name}`, `${Math.round(a.coalT).toLocaleString()} t of coal uncovered. Assign the excavator to MINE COAL.`, { kind: "block", id: block.id });
    }
  } else if (overburdenGone && a.coalT <= 1) {
    block.state = "COMPLETE";
    sim.bus.emit({ type: "BlockComplete", blockId: block.id });
    sim.notify("good", `${block.name} mined out`, `${Math.round(block.coalMinedT).toLocaleString()} t of coal recovered (${Math.round(block.coalLostT).toLocaleString()} t lost).`, { kind: "block", id: block.id });
  }
}

export function blockCenter(sim: Sim, block: MiningBlock): { x: number; z: number } {
  const t = sim.terrain;
  return { x: (t.cellX(block.rect.i0) + t.cellX(block.rect.i1)) / 2, z: (t.cellZ(block.rect.j0) + t.cellZ(block.rect.j1)) / 2 };
}

export function blockAt(sim: Sim, i: number, j: number): MiningBlock | null {
  return sim.state.blocks.find((b) => i >= b.rect.i0 && i <= b.rect.i1 && j >= b.rect.j0 && j <= b.rect.j1) ?? null;
}
