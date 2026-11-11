/**
 * Picking and projection through the camera's own view-projection matrix, so what the player
 * clicks is exactly what the renderer drew (no second, possibly mirrored, camera model).
 */
import { Mat4, Vec3, type Camera } from "@forge/engine";
import type { Terrain } from "../sim/world/terrain.js";

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

export function screenRay(camera: Camera, canvas: HTMLCanvasElement, clientX: number, clientY: number): Ray {
  const rect = canvas.getBoundingClientRect();
  const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
  const inv = new Mat4(camera.viewProjection.elements());
  inv.invert();
  const a = inv.transformPoint(new Vec3(nx, ny, 0), new Vec3());
  const b = inv.transformPoint(new Vec3(nx, ny, 1), new Vec3());
  const d = new Vec3(b.x - a.x, b.y - a.y, b.z - a.z);
  const len = Math.hypot(d.x, d.y, d.z) || 1;
  return { origin: a, dir: new Vec3(d.x / len, d.y / len, d.z / len) };
}

/** Screen position of a world point, or null when it is behind the camera. */
export function project(camera: Camera, canvas: HTMLCanvasElement, x: number, y: number, z: number): { x: number; y: number } | null {
  const m = camera.viewProjection.elements();
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (w <= 0.01) return null;
  const p = camera.viewProjection.transformPoint(new Vec3(x, y, z), new Vec3());
  if (p.x < -1.2 || p.x > 1.2 || p.y < -1.2 || p.y > 1.2) return null;
  const rect = canvas.getBoundingClientRect();
  return { x: (p.x * 0.5 + 0.5) * rect.width, y: (0.5 - p.y * 0.5) * rect.height };
}

/** First intersection of the ray with the heightfield, or null. */
export function rayTerrain(ray: Ray, terrain: Terrain, maxDist = 2500): Vec3 | null {
  let prevT = 0;
  const step = 2;
  const at = (t: number): Vec3 => new Vec3(ray.origin.x + ray.dir.x * t, ray.origin.y + ray.dir.y * t, ray.origin.z + ray.dir.z * t);
  const above = (p: Vec3): number => p.y - terrain.heightAt(p.x, p.z);
  // Skip ahead to the terrain's vertical band quickly.
  for (let t = step; t < maxDist; t += step) {
    const p = at(t);
    if (above(p) <= 0) {
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 20; k++) {
        const mid = (lo + hi) / 2;
        if (above(at(mid)) > 0) lo = mid;
        else hi = mid;
      }
      return at(hi);
    }
    prevT = t;
  }
  return null;
}

/** Distance along the ray to the closest approach to a sphere, if it hits. */
export function raySphere(ray: Ray, cx: number, cy: number, cz: number, r: number): number | null {
  const ox = cx - ray.origin.x;
  const oy = cy - ray.origin.y;
  const oz = cz - ray.origin.z;
  const t = ox * ray.dir.x + oy * ray.dir.y + oz * ray.dir.z;
  if (t < 0) return null;
  const px = ray.origin.x + ray.dir.x * t - cx;
  const py = ray.origin.y + ray.dir.y * t - cy;
  const pz = ray.origin.z + ray.dir.z * t - cz;
  return px * px + py * py + pz * pz <= r * r ? t : null;
}
