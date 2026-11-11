/**
 * Terrain presentation (spec §14.2, §47). One mesh + one small colour texture per 16×16-cell chunk;
 * a chunk is rebuilt only when its simulation version changed, and at most a few per frame, so a
 * bucket of dirt never re-meshes the map. Overlays recolour the same meshes — they are views of the
 * one simulation world, never separate worlds.
 */
import { Geometry, Material, Renderable, Texture, Vec3, type Engine, type Entity, type Scene } from "@forge/engine";
import type { Sim } from "../sim/sim.js";
import { CHUNK_CELLS, NO_LOOSE } from "../sim/world/terrain.js";
import { estimateAt, surfaceMaterial } from "../sim/world/geology.js";
import { blockAt } from "../sim/mining/blocks.js";
import { permitValid } from "../sim/regulatory/permits.js";
import { rectContains } from "../sim/world/terrain.js";

export type Overlay = "NORMAL" | "GEOLOGY" | "ELEVATION" | "MINING" | "PERMITS";
export const OVERLAYS: Overlay[] = ["NORMAL", "GEOLOGY", "ELEVATION", "MINING", "PERMITS"];

/** Texels per cell side. */
const TPC = 4;

interface ChunkView {
  ci: number;
  cj: number;
  entity: Entity;
  geometry: Geometry | null;
  texture: Texture | null;
  material: Material;
  /** Held by reference: see models.ts on journaled component additions. */
  renderable: Renderable;
  version: number;
  overlayVersion: number;
}

type RGB = [number, number, number];

const MAT_RGB: Record<string, RGB> = {
  GRASS: [92, 116, 58],
  GRASS2: [76, 100, 48],
  TOPSOIL: [110, 82, 54],
  SANDSTONE: [170, 148, 108],
  SHALE: [112, 108, 102],
  RUBBLE: [128, 112, 94],
  COAL: [24, 24, 26],
  UNDERCLAY: [140, 130, 114],
  SPOIL: [138, 124, 104],
  TOPSOIL_PILE: [96, 70, 46],
  ROAD: [150, 140, 124],
};

function hashNoise(x: number, z: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function lerp3(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function ramp(stops: [number, RGB][], v: number): RGB {
  if (v <= stops[0]![0]) return stops[0]![1];
  for (let i = 1; i < stops.length; i++) {
    const [p, c] = stops[i]!;
    const [p0, c0] = stops[i - 1]!;
    if (v <= p) return lerp3(c0, c, (v - p0) / (p - p0));
  }
  return stops[stops.length - 1]![1];
}

export class TerrainView {
  readonly root: Entity;
  private chunks: ChunkView[] = [];
  overlay: Overlay = "NORMAL";
  /** Bumped when the overlay or what it shows changes (forces recolour without re-meshing). */
  private overlayVersion = 0;
  private elevationRange: [number, number] = [0, 1];

  constructor(
    private engine: Engine,
    scene: Scene,
    private sim: Sim,
  ) {
    this.root = scene.createTransformedEntity("terrain", new Vec3(0, 0, 0));
    const t = sim.terrain;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < t.state.original.length; k++) {
      lo = Math.min(lo, t.state.original[k]!);
      hi = Math.max(hi, t.state.original[k]!);
    }
    this.elevationRange = [lo - 25, hi + 12];
    for (let cj = 0; cj < t.chunkRows; cj++) {
      for (let ci = 0; ci < t.chunkCols; ci++) {
        const entity = scene.createTransformedEntity(`chunk-${ci}-${cj}`, new Vec3(0, 0, 0));
        this.root.addChild(entity);
        const material = new Material({ label: `terrain-${ci}-${cj}`, color: 0xffffff, roughness: 0.95, metallic: 0 });
        const r = new Renderable();
        r.material = material;
        r.castShadow = true;
        r.receiveShadow = true;
        scene.world.addComponent(entity.id, r);
        this.chunks.push({ ci, cj, entity, geometry: null, texture: null, material, renderable: r, version: -1, overlayVersion: -1 });
      }
    }
  }

  setOverlay(o: Overlay): void {
    if (o === this.overlay) return;
    this.overlay = o;
    this.overlayVersion++;
  }

  /** Recolour everything (e.g. new samples changed what the geology overlay knows). */
  refreshOverlay(): void {
    this.overlayVersion++;
  }

  /** Rebuild up to `budget` stale chunks; returns how many were rebuilt. */
  update(budget = 6): number {
    const v = this.sim.terrain.state.chunkVersion;
    let n = 0;
    for (const c of this.chunks) {
      const ver = v[c.cj * this.sim.terrain.chunkCols + c.ci]!;
      if (c.version === ver && c.overlayVersion === this.overlayVersion) continue;
      this.rebuild(c, c.version !== ver);
      c.version = ver;
      c.overlayVersion = this.overlayVersion;
      if (++n >= budget) break;
    }
    return n;
  }

  get pending(): number {
    const v = this.sim.terrain.state.chunkVersion;
    return this.chunks.filter((c) => c.version !== v[c.cj * this.sim.terrain.chunkCols + c.ci] || c.overlayVersion !== this.overlayVersion).length;
  }

  private rebuild(c: ChunkView, mesh: boolean): void {
    const t = this.sim.terrain;
    const i0 = c.ci * CHUNK_CELLS;
    const j0 = c.cj * CHUNK_CELLS;
    // One vertex per cell centre, plus the next chunk's first row/column to close the seam.
    const nx = Math.min(CHUNK_CELLS + 1, t.cols - i0);
    const nz = Math.min(CHUNK_CELLS + 1, t.rows - j0);
    if (nx < 2 || nz < 2) return;
    if (mesh || !c.geometry) {
      const positions = new Float32Array(nx * nz * 3);
      const normals = new Float32Array(nx * nz * 3);
      const uvs = new Float32Array(nx * nz * 2);
      const h = (i: number, j: number): number => t.surfaceAt(Math.max(0, Math.min(t.cols - 1, i)), Math.max(0, Math.min(t.rows - 1, j)));
      for (let b = 0; b < nz; b++) {
        for (let a = 0; a < nx; a++) {
          const i = i0 + a;
          const j = j0 + b;
          const o = b * nx + a;
          positions[o * 3] = t.cellX(i);
          positions[o * 3 + 1] = h(i, j);
          positions[o * 3 + 2] = t.cellZ(j);
          const dx = (h(i + 1, j) - h(i - 1, j)) / (2 * t.cellSize);
          const dz = (h(i, j + 1) - h(i, j - 1)) / (2 * t.cellSize);
          const len = Math.hypot(dx, 1, dz);
          normals[o * 3] = -dx / len;
          normals[o * 3 + 1] = 1 / len;
          normals[o * 3 + 2] = -dz / len;
          uvs[o * 2] = (a * TPC + TPC / 2) / ((CHUNK_CELLS + 1) * TPC);
          uvs[o * 2 + 1] = (b * TPC + TPC / 2) / ((CHUNK_CELLS + 1) * TPC);
        }
      }
      const indices = new Uint32Array((nx - 1) * (nz - 1) * 6);
      let q = 0;
      for (let b = 0; b < nz - 1; b++) {
        for (let a = 0; a < nx - 1; a++) {
          const v00 = b * nx + a;
          const v10 = v00 + 1;
          const v01 = v00 + nx;
          const v11 = v01 + 1;
          // Clockwise on screen when seen from above (the engine's front-face convention).
          indices[q++] = v00;
          indices[q++] = v01;
          indices[q++] = v10;
          indices[q++] = v10;
          indices[q++] = v01;
          indices[q++] = v11;
        }
      }
      if (c.geometry) c.geometry.updateFrom({ positions, normals, uvs, indices, label: `terrain-${c.ci}-${c.cj}` });
      else {
        c.geometry = Geometry.create(this.engine.gpu, { positions, normals, uvs, indices, label: `terrain-${c.ci}-${c.cj}` });
        c.renderable.geometry = c.geometry;
      }
    }
    // Colour texture: TPC texels per cell, colours blended between cell centres with fine noise.
    const size = (CHUNK_CELLS + 1) * TPC;
    const cellRgb: RGB[] = [];
    for (let b = 0; b < CHUNK_CELLS + 1; b++) {
      for (let a = 0; a < CHUNK_CELLS + 1; a++) {
        const i = Math.min(t.cols - 1, i0 + a);
        const j = Math.min(t.rows - 1, j0 + b);
        cellRgb.push(this.cellColor(i, j));
      }
    }
    const px = new Uint8Array(size * size * 4);
    const N = CHUNK_CELLS + 1;
    for (let y = 0; y < size; y++) {
      const fy = Math.max(0, Math.min(N - 1.001, (y + 0.5) / TPC - 0.5));
      const b = Math.floor(fy);
      const ty = fy - b;
      for (let x = 0; x < size; x++) {
        const fx = Math.max(0, Math.min(N - 1.001, (x + 0.5) / TPC - 0.5));
        const a = Math.floor(fx);
        const tx = fx - a;
        const c00 = cellRgb[b * N + a]!;
        const c10 = cellRgb[b * N + Math.min(N - 1, a + 1)]!;
        const c01 = cellRgb[Math.min(N - 1, b + 1) * N + a]!;
        const c11 = cellRgb[Math.min(N - 1, b + 1) * N + Math.min(N - 1, a + 1)]!;
        const n = this.overlay === "NORMAL" ? 0.86 + 0.28 * hashNoise(i0 * TPC + x, j0 * TPC + y) : 1;
        const o = (y * size + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const v = (c00[ch]! * (1 - tx) + c10[ch]! * tx) * (1 - ty) + (c01[ch]! * (1 - tx) + c11[ch]! * tx) * ty;
          px[o + ch] = Math.max(0, Math.min(255, v * n));
        }
        px[o + 3] = 255;
      }
    }
    const old = c.texture;
    c.texture = Texture.fromRgba8(this.engine.gpu, size, size, px, { label: `terrain-tex-${c.ci}-${c.cj}`, srgb: true, mipmaps: true });
    // setMaps drops the cached bind group so the next draw binds the new texture.
    c.material.setMaps({ albedo: c.texture });
    old?.dispose();
  }

  private cellColor(i: number, j: number): RGB {
    const t = this.sim.terrain;
    const k = t.index(i, j);
    const s = t.state;
    switch (this.overlay) {
      case "ELEVATION": {
        const [lo, hi] = this.elevationRange;
        const v = (s.surface[k]! - lo) / (hi - lo);
        const c = ramp(
          [
            [0, [30, 40, 120]],
            [0.35, [40, 140, 160]],
            [0.6, [90, 170, 80]],
            [0.8, [210, 190, 90]],
            [1, [240, 240, 240]],
          ],
          v,
        );
        // Contour bands every 2 m.
        const band = (s.surface[k]! / 2) % 1;
        return band < 0.08 ? lerp3(c, [20, 20, 20], 0.4) : c;
      }
      case "GEOLOGY": {
        const e = estimateAt(this.sim.state.samples, t.cellX(i), t.cellZ(j));
        if (e.state === "UNKNOWN") return [72, 72, 78];
        if (e.seamTopElevation === null) return [120, 90, 90];
        const depth = s.surface[k]! - e.seamTopElevation;
        const c = ramp(
          [
            [0, [20, 20, 20]],
            [3, [40, 120, 200]],
            [8, [60, 190, 120]],
            [15, [230, 200, 60]],
            [25, [210, 70, 50]],
          ],
          depth,
        );
        // Low confidence washes the colour toward grey.
        return lerp3([90, 90, 96], c, Math.min(1, 0.25 + e.confidence));
      }
      case "MINING": {
        const b = blockAt(this.sim, i, j);
        const base = this.naturalColor(i, j);
        if (!b) return lerp3(base, [60, 60, 60], 0.5);
        const tint: Record<string, RGB> = {
          UNMINED: [120, 120, 140],
          PREPARING: [150, 120, 80],
          DRILLING: [230, 160, 40],
          BLAST_READY: [240, 90, 40],
          BLASTED: [200, 60, 60],
          EXCAVATING: [220, 200, 60],
          COAL_EXPOSED: [40, 40, 40],
          COAL_MINING: [60, 60, 110],
          COMPLETE: [80, 160, 90],
        };
        return lerp3(base, tint[b.state] ?? [128, 128, 128], 0.55);
      }
      case "PERMITS": {
        const base = this.naturalColor(i, j);
        const mining = this.sim.state.permits.find((p) => p.type === "SURFACE_MINING");
        const inside = mining && (!mining.area || rectContains(mining.area, i, j));
        if (!inside) return lerp3(base, [90, 60, 90], 0.45);
        return lerp3(base, mining && permitValid(this.sim, mining) ? [60, 170, 90] : [200, 60, 60], 0.35);
      }
      default:
        return this.naturalColor(i, j);
    }
  }

  private naturalColor(i: number, j: number): RGB {
    const t = this.sim.terrain;
    const k = t.index(i, j);
    const s = t.state;
    if (s.road[k]) return MAT_RGB.ROAD!;
    const m = surfaceMaterial(t, this.sim.state.geology, i, j);
    if (m === "TOPSOIL") {
      if (s.fill[k]! > 0.01) return MAT_RGB.TOPSOIL_PILE!;
      if (!s.disturbed[k]) return lerp3(MAT_RGB.GRASS!, MAT_RGB.GRASS2!, hashNoise(i * 7, j * 13));
      return MAT_RGB.TOPSOIL!;
    }
    if (m === "SPOIL") return lerp3(MAT_RGB.SPOIL!, [118, 106, 90], hashNoise(i, j));
    if (m === "COAL") return MAT_RGB.COAL!;
    if (m === "UNDERCLAY") return MAT_RGB.UNDERCLAY!;
    const base = m === "SANDSTONE" ? MAT_RGB.SANDSTONE! : MAT_RGB.SHALE!;
    // Blasted rock reads as rubble.
    if (s.looseFloor[k]! < NO_LOOSE && s.surface[k]! > s.looseFloor[k]! + 0.02) return lerp3(base, MAT_RGB.RUBBLE!, 0.55);
    return base;
  }

  dispose(): void {
    for (const c of this.chunks) {
      c.geometry?.dispose();
      c.texture?.dispose();
    }
  }
}
