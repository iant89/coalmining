/**
 * The terrain heightfield (spec §14): elevation at cell centres plus the per-cell state mining
 * changes. It is pure data in typed arrays so it serializes directly into a save and can be
 * re-meshed by the presentation layer one dirty chunk at a time (spec §14.2): every mutation goes
 * through `markDirty`, which bumps a per-chunk version the renderer compares against.
 */
export const CHUNK_CELLS = 16;
/** `looseFloor` value meaning "nothing blasted here". */
export const NO_LOOSE = 1e9;

export interface TerrainState {
  cols: number;
  rows: number;
  cellSize: number;
  originX: number;
  originZ: number;
  /** Current surface elevation (m) at each cell centre. */
  surface: Float32Array;
  /** Pre-mining surface, for disturbance and reclamation. */
  original: Float32Array;
  /** Thickness of placed material (spoil / topsoil pile) on top of the in-situ ground. */
  fill: Float32Array;
  /** Fill is topsoil (1) rather than spoil (0). */
  fillIsTopsoil: Uint8Array;
  /** In-situ rock above this elevation has been fragmented by a blast. `NO_LOOSE` when unblasted. */
  looseFloor: Float32Array;
  /** 0 untouched, 1 disturbed (vegetation removed). */
  disturbed: Uint8Array;
  /** Haul road surface under this cell. */
  road: Uint8Array;
  /** Per-chunk change counter. */
  chunkVersion: Uint32Array;
}

export class Terrain {
  constructor(public state: TerrainState) {}

  static create(cols: number, rows: number, cellSize: number, originX: number, originZ: number): Terrain {
    const n = cols * rows;
    const chunks = Math.ceil(cols / CHUNK_CELLS) * Math.ceil(rows / CHUNK_CELLS);
    return new Terrain({
      cols,
      rows,
      cellSize,
      originX,
      originZ,
      surface: new Float32Array(n),
      original: new Float32Array(n),
      fill: new Float32Array(n),
      fillIsTopsoil: new Uint8Array(n),
      looseFloor: new Float32Array(n).fill(NO_LOOSE),
      disturbed: new Uint8Array(n),
      road: new Uint8Array(n),
      chunkVersion: new Uint32Array(chunks),
    });
  }

  get cols(): number {
    return this.state.cols;
  }
  get rows(): number {
    return this.state.rows;
  }
  get cellSize(): number {
    return this.state.cellSize;
  }
  get cellArea(): number {
    return this.state.cellSize * this.state.cellSize;
  }
  get chunkCols(): number {
    return Math.ceil(this.state.cols / CHUNK_CELLS);
  }
  get chunkRows(): number {
    return Math.ceil(this.state.rows / CHUNK_CELLS);
  }
  get width(): number {
    return this.state.cols * this.state.cellSize;
  }
  get depth(): number {
    return this.state.rows * this.state.cellSize;
  }

  index(i: number, j: number): number {
    return j * this.state.cols + i;
  }
  inBounds(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < this.state.cols && j < this.state.rows;
  }
  /** World x of cell column `i`'s centre. */
  cellX(i: number): number {
    return this.state.originX + (i + 0.5) * this.state.cellSize;
  }
  cellZ(j: number): number {
    return this.state.originZ + (j + 0.5) * this.state.cellSize;
  }
  /** Cell containing world (x, z), clamped to the map. */
  cellOf(x: number, z: number): { i: number; j: number } {
    const i = Math.floor((x - this.state.originX) / this.state.cellSize);
    const j = Math.floor((z - this.state.originZ) / this.state.cellSize);
    return { i: Math.max(0, Math.min(this.state.cols - 1, i)), j: Math.max(0, Math.min(this.state.rows - 1, j)) };
  }

  surfaceAt(i: number, j: number): number {
    return this.state.surface[this.index(i, j)]!;
  }

  /** Bilinear surface height at world (x, z), between cell centres. */
  heightAt(x: number, z: number): number {
    const s = this.state;
    const fx = (x - s.originX) / s.cellSize - 0.5;
    const fz = (z - s.originZ) / s.cellSize - 0.5;
    const i0 = Math.max(0, Math.min(s.cols - 1, Math.floor(fx)));
    const j0 = Math.max(0, Math.min(s.rows - 1, Math.floor(fz)));
    const i1 = Math.min(s.cols - 1, i0 + 1);
    const j1 = Math.min(s.rows - 1, j0 + 1);
    const tx = Math.max(0, Math.min(1, fx - i0));
    const tz = Math.max(0, Math.min(1, fz - j0));
    const h00 = s.surface[j0 * s.cols + i0]!;
    const h10 = s.surface[j0 * s.cols + i1]!;
    const h01 = s.surface[j1 * s.cols + i0]!;
    const h11 = s.surface[j1 * s.cols + i1]!;
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  /** Bump the version of the chunk holding cell (i, j) and its neighbours' when on a chunk edge. */
  markDirty(i: number, j: number): void {
    const v = this.state.chunkVersion;
    const cc = this.chunkCols;
    const touch = (ci: number, cj: number): void => {
      if (ci < 0 || cj < 0 || ci >= cc || cj >= this.chunkRows) return;
      v[cj * cc + ci] = (v[cj * cc + ci]! + 1) >>> 0;
    };
    const ci = Math.floor(i / CHUNK_CELLS);
    const cj = Math.floor(j / CHUNK_CELLS);
    touch(ci, cj);
    // A vertex on a chunk boundary is shared by the neighbouring chunk's mesh.
    const li = i % CHUNK_CELLS;
    const lj = j % CHUNK_CELLS;
    if (li === 0) touch(ci - 1, cj);
    if (lj === 0) touch(ci, cj - 1);
    if (li === CHUNK_CELLS - 1) touch(ci + 1, cj);
    if (lj === CHUNK_CELLS - 1) touch(ci, cj + 1);
    if (li === 0 && lj === 0) touch(ci - 1, cj - 1);
  }

  /** Mark every chunk dirty (overlay change, load). */
  markAllDirty(): void {
    const v = this.state.chunkVersion;
    for (let k = 0; k < v.length; k++) v[k] = (v[k]! + 1) >>> 0;
  }

  /** Change the surface of a cell by `dz` (m), keeping fill bookkeeping consistent. */
  addFill(i: number, j: number, dz: number, topsoil: boolean): void {
    const k = this.index(i, j);
    this.state.surface[k] = this.state.surface[k]! + dz;
    this.state.fill[k] = this.state.fill[k]! + dz;
    this.state.fillIsTopsoil[k] = topsoil ? 1 : 0;
    this.state.disturbed[k] = 1;
    this.markDirty(i, j);
  }

  /** Total disturbed area, m². */
  disturbedArea(): number {
    let n = 0;
    for (let k = 0; k < this.state.disturbed.length; k++) n += this.state.disturbed[k]!;
    return n * this.cellArea;
  }
}

/** Cell rectangle, inclusive. */
export interface CellRect {
  i0: number;
  j0: number;
  i1: number;
  j1: number;
}

export function rectCells(r: CellRect): { i: number; j: number }[] {
  const out: { i: number; j: number }[] = [];
  for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) out.push({ i, j });
  return out;
}

export function rectContains(r: CellRect, i: number, j: number): boolean {
  return i >= r.i0 && i <= r.i1 && j >= r.j0 && j <= r.j1;
}

export function rectCellCount(r: CellRect): number {
  return (r.i1 - r.i0 + 1) * (r.j1 - r.j0 + 1);
}
