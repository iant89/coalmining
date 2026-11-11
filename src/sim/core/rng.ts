/**
 * Deterministic, serializable PRNG (mulberry32). Every random decision in the simulation draws from
 * an `Rng` owned by the simulation state, so a save file plus the same commands replays the same mine.
 * Never use `Math.random()` inside `src/sim` (tools/lint-arch.mjs enforces it).
 */
export class Rng {
  constructor(public state: number) {
    this.state = state >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick: empty list");
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))]!;
  }

  /** Approximately normal (Irwin–Hall, 4 samples), mean 0, sd ~1. */
  gaussian(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * Math.sqrt(3);
  }
}

/** Stateless hash noise: same (seed, x, y) always gives the same value in [0, 1). */
export function hash2(seed: number, x: number, y: number): number {
  let h = (seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1) at frequency 1/scale, `octaves` layers. */
export function valueNoise(seed: number, x: number, y: number, scale: number, octaves = 3): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1 / scale;
  for (let o = 0; o < octaves; o++) {
    const fx = x * freq;
    const fy = y * freq;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const s = seed + o * 1013;
    const a = hash2(s, ix, iy);
    const b = hash2(s, ix + 1, iy);
    const c = hash2(s, ix, iy + 1);
    const d = hash2(s, ix + 1, iy + 1);
    sum += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}
