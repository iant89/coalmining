/**
 * Excavation (spec §18–19): converts terrain into material parcels, one bucket at a time. The
 * excavator works a block top-down — always the highest diggable cell — in bites no thicker than a
 * bench lift, so pits deepen evenly. Rules the player meets here:
 *
 *  - topsoil and placed spoil are free-digging; in-situ rock is diggable only above the blast floor;
 *  - overburden mode stops at the seam roof (coal is never sent to spoil);
 *  - coal mode digs only exposed coal, losing a mining-recovery fraction plus any blast damage, and
 *    blast-damaged coal is diluted with rock (higher ash, lower BTU).
 */
import type { Sim } from "../sim.js";
import type { ExcavateMode, MiningBlock } from "../state.js";
import { GEO_MATERIALS, mergeParcel, type CoalQuality, type GeoMaterial, type MaterialParcel } from "../world/materials.js";
import { geoMaterialAt, layerBase, qualityAt, seamThickness } from "../world/geology.js";
import { rectCells } from "../world/terrain.js";

export const MINING_RECOVERY = 0.95;
const BENCH_LIFT = 0.5;
/** Material thinner than this (m) is "dug to the line": shared by digging and block analysis. */
export const DIG_TOLERANCE = 0.02;
/** Unblasted rock this thin over the seam can be dug directly. */
export const THIN_PARTING_M = 0.35;

export type DigOutcome =
  | { kind: "ok"; parcel: MaterialParcel; cellK: number; coalLostT: number }
  | { kind: "done" }
  | { kind: "out-of-reach" }
  | { kind: "unblasted"; tonnes: number }
  | { kind: "coal-not-exposed" };

interface Candidate {
  i: number;
  j: number;
  k: number;
  surface: number;
}

function overburdenCandidates(sim: Sim, block: MiningBlock): { diggable: Candidate[]; blocked: number } {
  const t = sim.terrain;
  const g = sim.state.geology;
  const diggable: Candidate[] = [];
  let blocked = 0;
  for (const { i, j } of rectCells(block.rect)) {
    const k = t.index(i, j);
    const surface = t.state.surface[k]!;
    const fill = t.state.fill[k]!;
    const roof = g.seamTop[k]!;
    if (fill <= 0.01 && surface - roof <= DIG_TOLERANCE) continue;
    if (fill > 0.01) {
      diggable.push({ i, j, k, surface });
      continue;
    }
    const m = geoMaterialAt(g, k, surface - 0.01);
    // A thin rock parting left over the coal can be ripped by the bucket without blasting.
    const parting = surface - roof <= THIN_PARTING_M;
    if (!GEO_MATERIALS[m].needsBlasting || parting || surface > t.state.looseFloor[k]! + DIG_TOLERANCE) diggable.push({ i, j, k, surface });
    else blocked += (surface - roof) * t.cellArea * GEO_MATERIALS[m].bankDensity;
  }
  return { diggable, blocked };
}

function coalCandidates(sim: Sim, block: MiningBlock): { exposed: Candidate[]; buried: number } {
  const t = sim.terrain;
  const g = sim.state.geology;
  const exposed: Candidate[] = [];
  let buried = 0;
  for (const { i, j } of rectCells(block.rect)) {
    const k = t.index(i, j);
    if (seamThickness(g, k) < 0.05) continue;
    const surface = t.state.surface[k]!;
    if (surface <= g.seamBottom[k]! + DIG_TOLERANCE) continue;
    if (t.state.fill[k]! > 0.01 || surface > g.seamTop[k]! + DIG_TOLERANCE) buried++;
    else exposed.push({ i, j, k, surface });
  }
  return { exposed, buried };
}

/** Where the machine stands and how far its bucket reaches. */
export interface Reach {
  x: number;
  z: number;
  reach: number;
}

function within(sim: Sim, list: Candidate[], near: Reach | undefined): Candidate[] {
  if (!near) return list;
  const t = sim.terrain;
  return list.filter((c) => Math.hypot(t.cellX(c.i) - near.x, t.cellZ(c.j) - near.z) <= near.reach);
}

/** The cell the next bucket will come from (for positioning the excavator), or null. */
export function nextDigCell(sim: Sim, block: MiningBlock, mode: ExcavateMode, near?: Reach): number | null {
  const all = mode === "OVERBURDEN" ? overburdenCandidates(sim, block).diggable : coalCandidates(sim, block).exposed;
  const list = within(sim, all, near);
  let best: Candidate | null = null;
  for (const c of list) if (!best || c.surface > best.surface + 1e-4) best = c;
  return best ? best.k : null;
}

/**
 * Dig up to `bucketM3` loose cubic metres. `bucketM3` is the bucket's loose volume; mass follows
 * from each layer's bank density and swell.
 */
export function digBucket(sim: Sim, block: MiningBlock, mode: ExcavateMode, bucketM3: number, near?: Reach): DigOutcome {
  const t = sim.terrain;
  const g = sim.state.geology;
  let looseLeft = bucketM3;
  let parcel: MaterialParcel | null = null;
  let firstK = -1;
  let coalLost = 0;
  for (let guard = 0; guard < 16 && looseLeft > 0.05; guard++) {
    let cands: Candidate[];
    if (mode === "OVERBURDEN") {
      const { diggable, blocked } = overburdenCandidates(sim, block);
      if (diggable.length === 0) {
        if (parcel) break;
        return blocked > 0.5 ? { kind: "unblasted", tonnes: blocked } : { kind: "done" };
      }
      cands = within(sim, diggable, near);
      if (cands.length === 0) return parcel ? { kind: "ok", parcel, cellK: firstK, coalLostT: coalLost } : { kind: "out-of-reach" };
    } else {
      const { exposed, buried } = coalCandidates(sim, block);
      if (exposed.length === 0) {
        if (parcel) break;
        return buried > 0 ? { kind: "coal-not-exposed" } : { kind: "done" };
      }
      cands = within(sim, exposed, near);
      if (cands.length === 0) return parcel ? { kind: "ok", parcel, cellK: firstK, coalLostT: coalLost } : { kind: "out-of-reach" };
    }
    let c = cands[0]!;
    for (const x of cands) if (x.surface > c.surface + 1e-4) c = x;
    if (firstK < 0) firstK = c.k;
    const surface = t.state.surface[c.k]!;
    const fill = t.state.fill[c.k]!;
    let material: GeoMaterial;
    let limit: number;
    if (fill > 0.01) {
      material = t.state.fillIsTopsoil[c.k] ? "TOPSOIL" : "SPOIL";
      limit = surface - fill;
    } else {
      const y = surface - 0.005;
      material = geoMaterialAt(g, c.k, y);
      limit = Math.max(layerBase(g, c.k, y), mode === "OVERBURDEN" ? g.seamTop[c.k]! : g.seamBottom[c.k]!);
      if (GEO_MATERIALS[material].needsBlasting && mode === "OVERBURDEN" && surface - g.seamTop[c.k]! > THIN_PARTING_M) limit = Math.max(limit, t.state.looseFloor[c.k]!);
    }
    limit = Math.max(limit, surface - BENCH_LIFT);
    const info = GEO_MATERIALS[material];
    const maxDz = Math.max(0, surface - limit);
    const dz = Math.min(maxDz, looseLeft / (info.swell * t.cellArea));
    if (dz <= 1e-5) break;
    const bankTonnes = dz * t.cellArea * info.bankDensity;
    t.state.surface[c.k] = surface - dz;
    if (fill > 0.01) t.state.fill[c.k] = Math.max(0, fill - dz);
    t.state.disturbed[c.k] = 1;
    t.markDirty(c.i, c.j);
    looseLeft -= dz * info.swell * t.cellArea;
    let bite: MaterialParcel;
    if (mode === "COAL") {
      const damage = g.coalDamage[c.k]!;
      const recovered = bankTonnes * MINING_RECOVERY * (1 - damage * 0.6);
      coalLost += bankTonnes - recovered;
      const q: CoalQuality = qualityAt(g, c.k);
      // Damaged coal is mixed with broken roof rock.
      q.ash += damage * 22;
      q.btu *= 1 - damage * 0.18;
      bite = { type: "COAL_RAW", tonnes: recovered, quality: q };
    } else {
      bite = { type: info.yields === "TOPSOIL" ? "TOPSOIL" : "OVERBURDEN", tonnes: bankTonnes, quality: null };
    }
    parcel = mergeParcel(parcel, bite);
  }
  if (!parcel) return { kind: "done" };
  return { kind: "ok", parcel, cellK: firstK, coalLostT: coalLost };
}

/** What a dig in this block would meet right now, without digging. */
export function digStatus(sim: Sim, block: MiningBlock, mode: ExcavateMode): "ok" | "done" | "unblasted" | "coal-not-exposed" {
  if (mode === "OVERBURDEN") {
    const { diggable, blocked } = overburdenCandidates(sim, block);
    if (diggable.length) return "ok";
    return blocked > 0.5 ? "unblasted" : "done";
  }
  const { exposed, buried } = coalCandidates(sim, block);
  if (exposed.length) return "ok";
  return buried > 0 ? "coal-not-exposed" : "done";
}

export function unblastedTonnes(sim: Sim, block: MiningBlock): number {
  return overburdenCandidates(sim, block).blocked;
}
