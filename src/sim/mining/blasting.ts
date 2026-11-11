/**
 * Blasting (spec §17), deliberately abstract: the player chooses a pattern and a charge *level*; the
 * game derives fragmentation, vibration/airblast/flyrock risk and coal damage from them. Nothing here
 * is, or should become, real explosives engineering guidance.
 */
import type { Sim } from "../sim.js";
import type { Blast, DrillPattern, MiningBlock } from "../state.js";
import { estimateAt, hardnessAt, seamThickness } from "../world/geology.js";
import { GEO_MATERIALS } from "../world/materials.js";
import { blockCenter } from "./blocks.js";

export const BLAST_EXCLUSION_M = 90;
/** Rock broken below the hole bottom (m). */
export const BOTTOM_BREAK_M = 0.8;

/** `id` defaults to a fresh simulation id; UI previews pass a fixed one so they never touch state. */
export function designBlast(sim: Sim, block: MiningBlock, pattern: DrillPattern, chargeFactor: number, id?: string): Blast {
  const t = sim.terrain;
  const cf = Math.max(0.6, Math.min(1.4, chargeFactor));
  let volume = 0;
  let hardness = 0;
  let coalDamage = 0;
  for (const h of pattern.holes) {
    const depth = h.drilled ? h.depth : h.designDepth;
    const k = t.index(h.i, h.j);
    const surface = t.state.surface[k]!;
    volume += depth * pattern.spacing * pattern.burden;
    hardness += hardnessAt(sim.state.geology, k, surface - depth / 2);
    // Estimated damage uses what the player knows: logged coal or the seam estimate.
    const est = estimateAt(sim.state.samples, h.x, h.z);
    const roofDepth = h.coalAt ?? (est.seamTopElevation !== null ? surface - est.seamTopElevation : null);
    const into = roofDepth === null ? 0 : depth + pattern.subdrill - roofDepth;
    if (into > 0) coalDamage += Math.min(1, into / 2.4) * 0.35 * cf * pattern.spacing * pattern.burden * 2.4 * GEO_MATERIALS.COAL.bankDensity;
  }
  hardness /= Math.max(1, pattern.holes.length);
  const spacingPenalty = Math.max(0, (pattern.spacing * pattern.burden - 30) / 30) * 0.25;
  const fragmentation = clamp01(0.2 + 0.6 * ((cf - 0.6) / 0.8) + 0.25 * (1 - hardness) - spacingPenalty);
  // Distance to the nearest building drives vibration and airblast concern.
  const c = blockCenter(sim, block);
  let nearest = Infinity;
  for (const f of sim.state.facilities) nearest = Math.min(nearest, Math.hypot(f.x - c.x, f.z - c.z));
  const proximity = clamp01(1 - (nearest - 60) / 260);
  const meanDepth = volume / Math.max(1, pattern.holes.length * pattern.spacing * pattern.burden);
  return {
    id: id ?? sim.nextId("blast"),
    blockId: block.id,
    patternId: pattern.id,
    chargeFactor: cf,
    holeCount: pattern.holes.length,
    estimatedVolumeM3: volume,
    estimatedTonnes: volume * 2.4,
    fragmentation,
    vibrationRisk: clamp01(0.15 + 0.45 * proximity + 0.3 * (cf - 0.6) + 0.02 * meanDepth),
    airblastRisk: clamp01(0.1 + 0.35 * proximity + 0.35 * (cf - 0.6)),
    flyrockRisk: clamp01(0.08 + 0.5 * (cf - 0.6) + (meanDepth < 2.5 ? 0.2 : 0)),
    coalDamageEstimateT: coalDamage,
    cost: Math.round(pattern.holes.reduce((s, h) => s + 60 + 34 * cf * (h.drilled ? h.depth : h.designDepth), 0)),
    state: "PLANNED",
    executedAt: null,
  };
}

/** Fire the blast against the true geology. */
export function executeBlast(sim: Sim, blast: Blast, pattern: DrillPattern, block: MiningBlock): void {
  const t = sim.terrain;
  const g = sim.state.geology;
  const drilled = pattern.holes.filter((h) => h.drilled);
  const reach = Math.max(pattern.spacing, pattern.burden) * 0.75 + t.cellSize * 0.5;
  for (let j = block.rect.j0; j <= block.rect.j1; j++) {
    for (let i = block.rect.i0; i <= block.rect.i1; i++) {
      const x = t.cellX(i);
      const z = t.cellZ(j);
      let best = null as (typeof drilled)[number] | null;
      let bestD = Infinity;
      for (const h of drilled) {
        const d = Math.hypot(h.x - x, h.z - z);
        if (d < bestD) {
          bestD = d;
          best = h;
        }
      }
      if (!best || bestD > reach) continue;
      const k = t.index(i, j);
      const roof = g.seamTop[k]!;
      const thick = seamThickness(g, k);
      // The broken zone is set by the hole bottom's absolute elevation, plus a little fracture
      // below it. Drill-to-coal holes stop at the roof, and their fracture zone stops at the softer
      // coal; only fixed-depth holes that pass the roof (and their subdrill) damage the seam.
      const holeFloor = best.collar - best.depth - pattern.subdrill;
      const floor = pattern.depthMode === "TO_COAL" || holeFloor >= roof ? Math.max(roof, holeFloor - BOTTOM_BREAK_M) : holeFloor;
      t.state.looseFloor[k] = Math.min(t.state.looseFloor[k]!, floor);
      t.state.disturbed[k] = 1;
      if (floor < roof && thick > 0.05) {
        const dmg = Math.min(1, (roof - floor) / thick) * 0.35 * blast.chargeFactor;
        g.coalDamage[k] = Math.min(0.9, Math.max(g.coalDamage[k]!, dmg));
      }
      t.markDirty(i, j);
    }
  }
  blast.state = "COMPLETED";
  blast.executedAt = sim.minute;
  block.fragmentation = blast.fragmentation;
  block.state = "BLASTED";
  sim.state.today.blasts++;
  sim.spend(blast.cost, "explosives", `Blast ${blast.id} (${blast.holeCount} holes) in ${block.name}`);
  sim.bus.emit({ type: "BlastExecuted", blastId: blast.id, blockId: block.id });
  const frag = blast.fragmentation > 0.7 ? "good" : blast.fragmentation > 0.45 ? "fair" : "poor";
  sim.notify("good", `Blast fired in ${block.name}`, `${blast.holeCount} holes, ${Math.round(blast.estimatedTonnes).toLocaleString()} t broken. Fragmentation ${frag} (${Math.round(blast.fragmentation * 100)}%). The block is ready to dig.`, { kind: "block", id: block.id });
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
