/**
 * Stockpiles and dump areas (spec §24). Dumps are terrain: a load raises the lowest cells of the
 * dump footprint, so spoil piles grow visibly and the terrain mesh changes. Stockpiles are quantity
 * + blended quality; overflow is an operational problem, never silently discarded.
 */
import type { Sim } from "../sim.js";
import type { DumpArea, Stockpile } from "../state.js";
import { blendQuality, PLACED_DENSITY, type MaterialParcel } from "../world/materials.js";
import { rectCells } from "../world/terrain.js";

/**
 * Where the next truck should tip: dumps are built from the edge nearest the pit outward, and a
 * cell is only passed over once it has been built up, so piles advance instead of scattering.
 */
export function dumpPoint(sim: Sim, dump: DumpArea, from?: { x: number; z: number }): { x: number; z: number; k: number } | null {
  const t = sim.terrain;
  const fx = from?.x ?? t.cellX(dump.rect.i0);
  const fz = from?.z ?? t.cellZ(dump.rect.j0);
  let best: { x: number; z: number; k: number } | null = null;
  let bestScore = Infinity;
  for (const { i, j } of rectCells(dump.rect)) {
    const k = t.index(i, j);
    const room = t.state.original[k]! + dump.maxHeight - t.state.surface[k]!;
    if (room < 0.4) continue;
    const placed = t.state.surface[k]! - t.state.original[k]!;
    const score = Math.hypot(t.cellX(i) - fx, t.cellZ(j) - fz) - placed * 3;
    if (score < bestScore) {
      bestScore = score;
      best = { x: t.cellX(i), z: t.cellZ(j), k };
    }
  }
  return best;
}

export function dumpCapacityLeftT(sim: Sim, dump: DumpArea): number {
  const t = sim.terrain;
  let m3 = 0;
  for (const { i, j } of rectCells(dump.rect)) {
    const k = t.index(i, j);
    m3 += Math.max(0, t.state.original[k]! + dump.maxHeight - t.state.surface[k]!) * t.cellArea;
  }
  return m3 * PLACED_DENSITY[dump.accepts === "TOPSOIL" ? "TOPSOIL" : "SPOIL"];
}

/**
 * Place a parcel around (x, z) in the dump: fills the lowest cells within a few metres first, then
 * spreads, so material builds a pile at the tipping point rather than teleporting across the dump.
 * Returns tonnes that did not fit.
 */
export function placeInDump(sim: Sim, dump: DumpArea, parcel: MaterialParcel, x: number, z: number): number {
  const t = sim.terrain;
  const topsoil = dump.accepts === "TOPSOIL";
  const density = PLACED_DENSITY[topsoil ? "TOPSOIL" : "SPOIL"];
  let m3 = parcel.tonnes / density;
  const cells = rectCells(dump.rect)
    .map(({ i, j }) => ({ i, j, k: t.index(i, j), d: Math.hypot(t.cellX(i) - x, t.cellZ(j) - z) }))
    .sort((a, b) => a.d - b.d);
  let guard = 0;
  while (m3 > 1e-3 && guard++ < 64) {
    // Candidates: nearest cells with room; lowest of the closest few gets the next lift.
    let pick: { i: number; j: number; k: number } | null = null;
    let pickH = Infinity;
    let seen = 0;
    for (const c of cells) {
      const room = t.state.original[c.k]! + dump.maxHeight - t.state.surface[c.k]!;
      if (room < 0.02) continue;
      const h = t.state.surface[c.k]! + c.d * 0.04;
      if (h < pickH) {
        pickH = h;
        pick = c;
      }
      if (++seen >= 9) break;
    }
    if (!pick) break;
    const room = t.state.original[pick.k]! + dump.maxHeight - t.state.surface[pick.k]!;
    const dz = Math.min(room, 0.6, m3 / t.cellArea);
    t.addFill(pick.i, pick.j, dz, topsoil);
    m3 -= dz * t.cellArea;
  }
  const placed = parcel.tonnes - m3 * density;
  dump.tonnes += placed;
  return Math.max(0, m3 * density);
}

export function stockpileRoomT(s: Stockpile): number {
  return Math.max(0, s.capacityT - s.tonnes);
}

/** Add to a stockpile; returns tonnes that did not fit. */
export function addToStockpile(sim: Sim, s: Stockpile, parcel: MaterialParcel): number {
  const fit = Math.min(parcel.tonnes, stockpileRoomT(s));
  s.quality = blendQuality(s.quality, s.tonnes, parcel.quality, fit);
  s.tonnes += fit;
  s.inT += fit;
  if (s.tonnes >= s.capacityT - 0.5) {
    sim.bus.emit({ type: "StockpileFull", stockpileId: s.id });
    sim.notify("warn", `${s.name} is full`, `${Math.round(s.tonnes).toLocaleString()} t of ${Math.round(s.capacityT).toLocaleString()} t. Sell coal or haul trucks will queue.`, { kind: "stockpile", id: s.id });
  }
  return parcel.tonnes - fit;
}

export function takeFromStockpile(s: Stockpile, tonnes: number): MaterialParcel {
  const t = Math.min(tonnes, s.tonnes);
  s.tonnes -= t;
  s.outT += t;
  const q = s.quality ? { ...s.quality } : null;
  if (s.tonnes < 0.01) s.quality = null;
  return { type: s.materialType, tonnes: t, quality: q };
}
