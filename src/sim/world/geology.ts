/**
 * The geological model (spec §12) has two halves that must never be confused:
 *
 *  - the TRUE geology (`GeologyState`): layer elevations and coal quality per cell, generated from the
 *    scenario. The simulation digs against it; the player never reads it directly.
 *  - the KNOWN geology: what drill samples and exposed faces have told the player. Every map overlay,
 *    reserve figure and drill design the player sees is derived from `estimateAt`, which only reads
 *    samples. Uncertainty is therefore real: a design based on two old holes can be wrong.
 */
import { valueNoise } from "../core/rng.js";
import { GEO_MATERIALS, type CoalQuality, type GeoMaterial } from "./materials.js";
import { type Terrain } from "./terrain.js";

export interface GeologyState {
  /** Elevation of the base of topsoil. */
  topsoilBase: Float32Array;
  /** Elevation of the sandstone → shale contact within the overburden. */
  shaleTop: Float32Array;
  /** Elevation of the seam roof / floor. Equal where the seam is absent (eroded). */
  seamTop: Float32Array;
  seamBottom: Float32Array;
  ash: Float32Array;
  sulfur: Float32Array;
  moisture: Float32Array;
  btu: Float32Array;
  /** Fraction of the coal in this cell lost to blast damage / dilution (0…1). */
  coalDamage: Float32Array;
}

export interface GeologyParams {
  seed: number;
  /** World x of the seam outcrop line; the seam is eroded east of it. */
  outcropX: number;
  /** Seam roof depth below original surface at the outcrop (m). */
  outcropDepth: number;
  /** Additional depth per metre west of the outcrop (the dip). */
  dipPerMetre: number;
  thicknessMin: number;
  thicknessMax: number;
  topsoilMin: number;
  topsoilMax: number;
  /** Base ash; weathered coal near the outcrop is dirtier. */
  ashBase: number;
  sulfurBase: number;
  btuBase: number;
}

export function createGeology(terrain: Terrain, p: GeologyParams): GeologyState {
  const n = terrain.cols * terrain.rows;
  const g: GeologyState = {
    topsoilBase: new Float32Array(n),
    shaleTop: new Float32Array(n),
    seamTop: new Float32Array(n),
    seamBottom: new Float32Array(n),
    ash: new Float32Array(n),
    sulfur: new Float32Array(n),
    moisture: new Float32Array(n),
    btu: new Float32Array(n),
    coalDamage: new Float32Array(n),
  };
  for (let j = 0; j < terrain.rows; j++) {
    for (let i = 0; i < terrain.cols; i++) {
      const k = terrain.index(i, j);
      const x = terrain.cellX(i);
      const z = terrain.cellZ(j);
      const surface = terrain.state.original[k]!;
      const topsoil = p.topsoilMin + (p.topsoilMax - p.topsoilMin) * valueNoise(p.seed + 11, x, z, 40, 2);
      const westOfOutcrop = p.outcropX - x;
      const roofDepth = p.outcropDepth + Math.max(0, westOfOutcrop) * p.dipPerMetre + (valueNoise(p.seed + 23, x, z, 70, 3) - 0.5) * 2.2;
      const thickness = p.thicknessMin + (p.thicknessMax - p.thicknessMin) * valueNoise(p.seed + 37, x, z, 90, 3);
      g.topsoilBase[k] = surface - topsoil;
      const seamTop = surface - Math.max(topsoil + 0.3, roofDepth);
      // East of the outcrop the seam has been eroded away (a soft edge, not a straight line).
      const eroded = westOfOutcrop + (valueNoise(p.seed + 41, x, z, 30, 2) - 0.5) * 18 < 0;
      g.seamTop[k] = seamTop;
      g.seamBottom[k] = eroded ? seamTop : seamTop - thickness;
      const overburden = surface - topsoil - seamTop;
      g.shaleTop[k] = seamTop + overburden * (0.35 + 0.3 * valueNoise(p.seed + 53, x, z, 60, 2));
      const weathering = Math.max(0, 1 - Math.max(0, westOfOutcrop) / 45);
      g.ash[k] = p.ashBase + 4.5 * valueNoise(p.seed + 61, x, z, 55, 3) + 6 * weathering;
      g.sulfur[k] = p.sulfurBase + 1.1 * valueNoise(p.seed + 67, x, z, 80, 3);
      g.moisture[k] = 6 + 3 * valueNoise(p.seed + 71, x, z, 50, 2) + 3 * weathering;
      g.btu[k] = p.btuBase + 700 * valueNoise(p.seed + 73, x, z, 65, 3) - 900 * weathering;
    }
  }
  return g;
}

/** Seam thickness actually present in a cell (m). */
export function seamThickness(g: GeologyState, k: number): number {
  return Math.max(0, g.seamTop[k]! - g.seamBottom[k]!);
}

export function qualityAt(g: GeologyState, k: number): CoalQuality {
  return { ash: g.ash[k]!, sulfur: g.sulfur[k]!, moisture: g.moisture[k]!, btu: g.btu[k]! };
}

/** In-situ material at elevation `y` in cell k (ignores fill; callers handle fill first). */
export function geoMaterialAt(g: GeologyState, k: number, y: number): GeoMaterial {
  if (y > g.topsoilBase[k]!) return "TOPSOIL";
  if (y > g.seamTop[k]!) return y > g.shaleTop[k]! ? "SANDSTONE" : "SHALE";
  if (y > g.seamBottom[k]!) return "COAL";
  return "UNDERCLAY";
}

/** The material exposed at the current surface of cell (i, j). */
export function surfaceMaterial(terrain: Terrain, g: GeologyState, i: number, j: number): GeoMaterial {
  const k = terrain.index(i, j);
  if (terrain.state.fill[k]! > 0.01) return terrain.state.fillIsTopsoil[k] ? "TOPSOIL" : "SPOIL";
  return geoMaterialAt(g, k, terrain.state.surface[k]! - 0.01);
}

/** Lower boundary of the layer containing elevation `y` in cell k (in-situ). */
export function layerBase(g: GeologyState, k: number, y: number): number {
  const m = geoMaterialAt(g, k, y);
  switch (m) {
    case "TOPSOIL":
      return g.topsoilBase[k]!;
    case "SANDSTONE":
      return Math.max(g.shaleTop[k]!, g.seamTop[k]!);
    case "SHALE":
      return g.seamTop[k]!;
    case "COAL":
      return g.seamBottom[k]!;
    default:
      return -1e9;
  }
}

export function hardnessAt(g: GeologyState, k: number, y: number): number {
  return GEO_MATERIALS[geoMaterialAt(g, k, y)].hardness;
}

// ---------------------------------------------------------------- known geology (exploration)

export type SampleKind = "CORE" | "BLAST_HOLE" | "LEGACY" | "EXPOSURE";
export type ConfidenceState = "UNKNOWN" | "ESTIMATED" | "HIGH_CONFIDENCE";

export interface GeoSample {
  id: string;
  kind: SampleKind;
  x: number;
  z: number;
  /** Total depth drilled (m). */
  depth: number;
  /** Depth to seam roof below the surface at drilling time, or null if the hole found no coal. */
  seamDepth: number | null;
  /** Seam thickness, or null if the hole stopped at the roof (blast holes) or found no coal. */
  thickness: number | null;
  /** Lab quality; null until analysed (cores) or never (blast holes). */
  quality: CoalQuality | null;
  /** Minute the lab result arrives (cores). */
  analysisDueMinute: number | null;
  /** 0…1: how much this sample is trusted (legacy logs are vague). */
  reliability: number;
  /** Surface elevation when drilled, so later digging does not change what the sample meant. */
  collarElevation: number;
  minute: number;
  /** Drilled rock layers from the log, top down: [material, fromDepth, toDepth]. */
  log: [GeoMaterial, number, number][];
}

export interface GeoEstimate {
  state: ConfidenceState;
  /** 0…1. */
  confidence: number;
  /** Estimated seam roof *elevation* (absolute), or null if unknown / no coal expected. */
  seamTopElevation: number | null;
  /** Estimated thickness, or null when unknown. */
  thickness: number | null;
  quality: CoalQuality | null;
  /** Number of samples within influence range. */
  samples: number;
}

const INFLUENCE_RADIUS = 70;
const CONFIDENCE_SCALE = 28;

/**
 * Inverse-distance estimate of the seam at (x, z) from samples only. `collarElevation - seamDepth`
 * gives each sample's roof elevation; thickness and quality average only the samples that measured
 * them. Confidence decays with distance to the nearest samples and grows with their number.
 */
export function estimateAt(samples: readonly GeoSample[], x: number, z: number): GeoEstimate {
  let wSum = 0;
  let roof = 0;
  let thW = 0;
  let th = 0;
  let qW = 0;
  const q = { ash: 0, sulfur: 0, moisture: 0, btu: 0 };
  let confidence = 0;
  let count = 0;
  let noCoalW = 0;
  for (const s of samples) {
    const d = Math.hypot(s.x - x, s.z - z);
    if (d > INFLUENCE_RADIUS) continue;
    count++;
    const w = s.reliability / (1 + (d / 8) ** 2);
    const c = s.reliability * Math.exp(-d / CONFIDENCE_SCALE);
    confidence = 1 - (1 - confidence) * (1 - c * 0.75);
    if (s.seamDepth === null) {
      noCoalW += w;
      continue;
    }
    wSum += w;
    roof += w * (s.collarElevation - s.seamDepth);
    if (s.thickness !== null) {
      thW += w;
      th += w * s.thickness;
    }
    if (s.quality) {
      qW += w;
      q.ash += w * s.quality.ash;
      q.sulfur += w * s.quality.sulfur;
      q.moisture += w * s.quality.moisture;
      q.btu += w * s.quality.btu;
    }
  }
  const state: ConfidenceState = confidence < 0.12 ? "UNKNOWN" : confidence > 0.7 && count >= 2 ? "HIGH_CONFIDENCE" : "ESTIMATED";
  if (state === "UNKNOWN" || wSum === 0 || noCoalW > wSum) {
    return { state, confidence, seamTopElevation: null, thickness: null, quality: null, samples: count };
  }
  return {
    state,
    confidence,
    seamTopElevation: roof / wSum,
    thickness: thW > 0 ? th / thW : null,
    quality: qW > 0 ? { ash: q.ash / qW, sulfur: q.sulfur / qW, moisture: q.moisture / qW, btu: q.btu / qW } : null,
    samples: count,
  };
}

/** Build a drill log through the true geology from the collar down to `depth` (or to `stopAtCoal`). */
export function drillLog(terrain: Terrain, g: GeologyState, i: number, j: number, depth: number): [GeoMaterial, number, number][] {
  const k = terrain.index(i, j);
  const collar = terrain.state.surface[k]!;
  const fill = terrain.state.fill[k]!;
  const out: [GeoMaterial, number, number][] = [];
  if (fill > 0.01) out.push([terrain.state.fillIsTopsoil[k] ? "TOPSOIL" : "SPOIL", 0, Math.min(depth, fill)]);
  let d = fill;
  let guard = 0;
  while (d < depth - 1e-4 && guard++ < 10) {
    const y = collar - d - 1e-4;
    const m = geoMaterialAt(g, k, y);
    const base = Math.max(layerBase(g, k, y), collar - depth);
    const to = collar - base;
    out.push([m, d, to]);
    d = to;
  }
  return out;
}
