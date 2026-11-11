/**
 * Camera (spec §48): an orbit/pan/zoom rig over the mine with FREE, ISOMETRIC, OVERVIEW and FOLLOW
 * modes. Mouse: left-drag pans, right-drag (or Alt+left) orbits, wheel zooms. Keys: WASD/arrows pan,
 * Q/E rotate, R/F tilt. Touch: one finger pans, two fingers pinch-zoom and twist.
 */
import { Vec3, type Entity, type Camera } from "@forge/engine";
import type { Terrain } from "../sim/world/terrain.js";

export type CameraMode = "FREE" | "ISOMETRIC" | "OVERVIEW" | "FOLLOW";

export class CameraRig {
  target = new Vec3(110, 300, 0);
  distance = 190;
  yaw = 2.35;
  pitch = 0.62;
  mode: CameraMode = "ISOMETRIC";
  /** Follow target supplier (selected machine). */
  follow: (() => { x: number; y: number; z: number } | null) | null = null;
  private keys = new Set<string>();
  private drag: { button: number; x: number; y: number; moved: boolean } | null = null;
  private pinch: { d: number; a: number } | null = null;
  /** Set by the last pointer gesture: true when it was a drag, so the click handler ignores it. */
  dragged = false;

  constructor(
    private entity: Entity,
    readonly camera: Camera,
    canvas: HTMLCanvasElement,
    private terrain: Terrain,
  ) {
    const t = terrain;
    this.bounds = { x0: t.state.originX, z0: t.state.originZ, x1: t.state.originX + t.width, z1: t.state.originZ + t.depth };
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      this.drag = { button: e.altKey ? 2 : e.button, x: e.clientX, y: e.clientY, moved: false };
      this.dragged = false;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.drag || e.pointerType === "touch") return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      if (!this.drag.moved && Math.hypot(dx, dy) < 4) return;
      this.drag.moved = true;
      this.dragged = true;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      if (this.drag.button === 2) this.orbit(dx, dy);
      else this.panScreen(dx, dy);
    });
    const end = (e: PointerEvent): void => {
      if (this.drag && canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      this.drag = null;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoom(Math.exp(e.deltaY * 0.0012));
      },
      { passive: false },
    );
    canvas.addEventListener("touchstart", (e) => this.touch(e, true), { passive: false });
    canvas.addEventListener("touchmove", (e) => this.touch(e, false), { passive: false });
    canvas.addEventListener("touchend", () => {
      this.pinch = null;
      this.lastTouch = null;
    });
    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement | null)?.closest?.("input, select, textarea")) return;
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => this.keys.clear());
  }

  private bounds: { x0: number; z0: number; x1: number; z1: number };
  private lastTouch: { x: number; y: number } | null = null;

  private touch(e: TouchEvent, start: boolean): void {
    e.preventDefault();
    if (e.touches.length === 1) {
      const t = e.touches[0]!;
      if (!start && this.lastTouch) {
        const dx = t.clientX - this.lastTouch.x;
        const dy = t.clientY - this.lastTouch.y;
        if (Math.hypot(dx, dy) > 1) this.dragged = true;
        this.panScreen(dx, dy);
      } else this.dragged = false;
      this.lastTouch = { x: t.clientX, y: t.clientY };
      this.pinch = null;
    } else if (e.touches.length >= 2) {
      const a = e.touches[0]!;
      const b = e.touches[1]!;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const ang = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
      if (this.pinch) {
        this.zoom(this.pinch.d / Math.max(1, d));
        this.yaw -= ang - this.pinch.a;
      }
      this.pinch = { d, a: ang };
      this.dragged = true;
      this.lastTouch = null;
    }
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    if (mode === "ISOMETRIC") {
      this.yaw = Math.round((this.yaw - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2) + Math.PI / 4;
      this.pitch = 0.62;
    } else if (mode === "OVERVIEW") {
      this.target.set(40, this.target.y, 0);
      this.distance = 520;
      this.pitch = 1.1;
    } else if (mode === "FOLLOW") {
      this.distance = Math.min(this.distance, 70);
      this.pitch = Math.max(this.pitch, 0.45);
    }
  }

  centerOn(x: number, z: number, distance?: number): void {
    this.target.set(x, this.terrain.heightAt(x, z), z);
    if (distance) this.distance = distance;
  }

  private orbit(dx: number, dy: number): void {
    this.yaw -= dx * 0.006;
    this.pitch = Math.max(0.12, Math.min(1.45, this.pitch + dy * 0.005));
    if (this.mode === "ISOMETRIC") this.mode = "FREE";
  }

  private panScreen(dx: number, dy: number): void {
    if (this.mode === "FOLLOW") this.mode = "FREE";
    const s = this.distance * 0.0016;
    // Screen right / screen up projected onto the ground plane.
    const rx = -Math.cos(this.yaw);
    const rz = Math.sin(this.yaw);
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    this.target.x += (-dx * rx + dy * fx) * s;
    this.target.z += (-dx * rz + dy * fz) * s;
    this.clampTarget();
  }

  private zoom(f: number): void {
    this.distance = Math.max(14, Math.min(700, this.distance * f));
  }

  private clampTarget(): void {
    const b = this.bounds;
    this.target.x = Math.max(b.x0, Math.min(b.x1, this.target.x));
    this.target.z = Math.max(b.z0, Math.min(b.z1, this.target.z));
  }

  update(dt: number): void {
    const k = this.keys;
    const pan = this.distance * 0.9 * dt;
    let dx = 0;
    let dy = 0;
    if (k.has("w") || k.has("arrowup")) dy += 1;
    if (k.has("s") || k.has("arrowdown")) dy -= 1;
    if (k.has("a") || k.has("arrowleft")) dx -= 1;
    if (k.has("d") || k.has("arrowright")) dx += 1;
    if (dx || dy) this.panScreen(-dx * pan / (this.distance * 0.0016), dy * pan / (this.distance * 0.0016));
    if (k.has("q")) this.yaw += 1.2 * dt;
    if (k.has("e")) this.yaw -= 1.2 * dt;
    if (k.has("r")) this.pitch = Math.min(1.45, this.pitch + 0.8 * dt);
    if (k.has("f")) this.pitch = Math.max(0.12, this.pitch - 0.8 * dt);
    if (this.mode === "FOLLOW" && this.follow) {
      const p = this.follow();
      if (p) {
        const f = 1 - Math.exp(-6 * dt);
        this.target.x += (p.x - this.target.x) * f;
        this.target.z += (p.z - this.target.z) * f;
      }
    }
    // Keep the target on the ground and the eye above it.
    const ground = this.terrain.heightAt(this.target.x, this.target.z);
    this.target.y += (ground - this.target.y) * (1 - Math.exp(-8 * dt));
    const cp = Math.cos(this.pitch);
    const eye = new Vec3(
      this.target.x + Math.sin(this.yaw) * cp * this.distance,
      this.target.y + Math.sin(this.pitch) * this.distance,
      this.target.z + Math.cos(this.yaw) * cp * this.distance,
    );
    const floor = this.terrain.heightAt(eye.x, eye.z) + 3;
    if (eye.y < floor) eye.y = floor;
    this.entity.transform.position = eye;
    this.entity.transform.lookAt(this.target);
    this.camera.far = Math.max(1200, this.distance * 4);
    this.camera.near = Math.max(0.3, this.distance * 0.004);
  }
}
