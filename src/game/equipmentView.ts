/**
 * Equipment presentation (spec §51): reads `EquipmentInstance` and draws it. Pose is interpolated
 * between the previous and current tick; the machine tilts with the ground under it; pivots animate
 * from the simulation's `activity` hint (dig, dump, drill, push). Nothing here writes to the sim.
 */
import { Color, Material, Quat, Vec3, type Entity, type Scene } from "@forge/engine";
import type { Sim } from "../sim/sim.js";
import type { EquipmentInstance } from "../sim/state.js";
import { buildDozer, buildDrill, buildExcavator, buildHaulTruck, forgetRenderables, pitch, renderableOf, yaw, type EquipmentModel, type ModelKit } from "./models.js";

interface View {
  eq: EquipmentInstance;
  model: EquipmentModel;
  loadMaterial: Material | null;
  /** Presentation-only animation clocks. */
  activitySince: number;
  lastActivity: string;
  bedTilt: number;
  mastTilt: number;
  houseYaw: number;
  trackHeading: number;
  /** Interpolated world pose this frame. */
  x: number;
  y: number;
  z: number;
  heading: number;
}

const LOAD_COLOR: Record<string, number> = { OVERBURDEN: 0x8a7760, SPOIL: 0x8a7760, TOPSOIL: 0x5e452e, COAL_RAW: 0x141414, COAL_CLEAN: 0x101010, REFUSE: 0x555555 };

function angleLerp(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function approach(v: number, target: number, rate: number, dt: number): number {
  const k = 1 - Math.exp(-rate * dt);
  return v + (target - v) * k;
}

export class EquipmentView {
  private views = new Map<string, View>();
  private time = 0;

  constructor(
    private scene: Scene,
    private kit: ModelKit,
    private sim: Sim,
  ) {}

  /** World pose of a machine as drawn this frame (for labels, picking, follow camera). */
  pose(id: string): { x: number; y: number; z: number; heading: number; radius: number; height: number } | null {
    const v = this.views.get(id);
    return v ? { x: v.x, y: v.y, z: v.z, heading: v.heading, radius: v.model.radius, height: v.model.height } : null;
  }

  ids(): string[] {
    return [...this.views.keys()];
  }

  private create(eq: EquipmentInstance): View {
    const def = this.sim.def(eq);
    const builders = { HAUL_TRUCK: buildHaulTruck, EXCAVATOR: buildExcavator, DRILL: buildDrill, DOZER: buildDozer } as const;
    const build = builders[def.category as keyof typeof builders] ?? buildHaulTruck;
    const model = build(this.scene, this.kit, `eq-${eq.id}`, def.color, def.size);
    let loadMaterial: Material | null = null;
    const load = model.parts.load;
    if (load) {
      // Each truck's load gets its own material so it can show what it carries.
      loadMaterial = new Material({ label: `load-${eq.id}`, color: 0x8a7760, roughness: 1, metallic: 0 });
      renderableOf(load)!.material = loadMaterial;
    }
    return { eq, model, loadMaterial, activitySince: 0, lastActivity: "", bedTilt: 0, mastTilt: 0, houseYaw: 0, trackHeading: eq.heading, x: eq.x, y: 0, z: eq.z, heading: eq.heading };
  }

  update(dt: number, alpha: number): void {
    this.time += dt;
    const seen = new Set<string>();
    for (const eq of this.sim.state.equipment) {
      seen.add(eq.id);
      let v = this.views.get(eq.id);
      if (!v) {
        v = this.create(eq);
        this.views.set(eq.id, v);
      }
      v.eq = eq;
      this.pose1(v, dt, alpha);
    }
    for (const [id, v] of this.views) {
      if (!seen.has(id)) {
        forgetRenderables(v.model.root);
        v.model.root.destroy();
        this.views.delete(id);
      }
    }
  }

  private pose1(v: View, dt: number, alpha: number): void {
    const eq = v.eq;
    const t = this.sim.terrain;
    const a = Math.max(0, Math.min(1, alpha));
    v.x = eq.prevX + (eq.x - eq.prevX) * a;
    v.z = eq.prevZ + (eq.z - eq.prevZ) * a;
    const def = this.sim.def(eq);
    const cat = def.category;
    if (eq.activity !== v.lastActivity) {
      v.lastActivity = eq.activity;
      v.activitySince = this.time;
    }
    const since = this.time - v.activitySince;
    // Tracked machines keep their tracks still while the upper works; trucks always face travel.
    const driving = eq.activity === "drive" || eq.speed > 0.05;
    const targetHeading = angleLerp(eq.prevHeading, eq.heading, a);
    if (cat === "EXCAVATOR") {
      if (driving) v.trackHeading = targetHeading;
      v.heading = v.trackHeading;
    } else {
      v.heading = approach(v.heading, v.heading + angleDelta(v.heading, targetHeading), 10, dt);
    }
    // Sit on the ground: height at the centre, pitch and roll from the ground under the footprint.
    const L = def.size.length * 0.4;
    const W = def.size.width * 0.4;
    const sx = Math.sin(v.heading);
    const cz = Math.cos(v.heading);
    const hF = t.heightAt(v.x + sx * L, v.z + cz * L);
    const hB = t.heightAt(v.x - sx * L, v.z - cz * L);
    const hR = t.heightAt(v.x + cz * W, v.z - sx * W);
    const hL = t.heightAt(v.x - cz * W, v.z + sx * W);
    v.y = (hF + hB + hR + hL) / 4;
    const p = Math.atan2(hB - hF, 2 * L);
    const r = Math.atan2(hL - hR, 2 * W);
    const root = v.model.root;
    root.transform.position = new Vec3(v.x, v.y, v.z);
    root.transform.rotation = yaw(v.heading).multiply(pitch(p)).multiply(Quat.fromAxisAngle(new Vec3(0, 0, 1), r)).normalize();

    const pv = v.model.pivots;
    if (cat === "HAUL_TRUCK" && pv.bed) {
      const target = eq.activity === "dump" ? -0.95 : 0;
      v.bedTilt = approach(v.bedTilt, target, eq.activity === "dump" ? 1.6 : 2.5, dt);
      pv.bed.transform.rotation = pitch(v.bedTilt);
      const load = v.model.parts.load;
      if (load) {
        const tonnes = eq.payload?.tonnes ?? 0;
        const cap = def.payloadT ?? 60;
        const f = Math.min(1.05, tonnes / cap);
        const r2 = renderableOf(load);
        if (r2) r2.visible = f > 0.02 && v.bedTilt > -0.5;
        load.transform.scale = new Vec3(def.size.width * 0.86, Math.max(0.05, 1.3 * f), def.size.length * 0.62);
        load.transform.position = new Vec3(0, 0.2 + 0.65 * f, def.size.length * 0.33);
        if (eq.payload && v.loadMaterial) v.loadMaterial.setColor(Color.fromSrgbHex(LOAD_COLOR[eq.payload.type] ?? 0x8a7760));
      }
    } else if (cat === "EXCAVATOR" && pv.house && pv.boom && pv.stick && pv.bucket) {
      // Swing between the face and the truck: the sim points `heading` at the truck being loaded.
      let houseTarget = 0;
      let boom = -0.25;
      let stick = 0.35;
      let bucket = 0.2;
      if (eq.activity === "dig") {
        const cycle = (def.cycleSeconds ?? 30) / 6; // presentation runs the cycle faster than real time
        const ph = (since % cycle) / cycle;
        const toTruck = angleDelta(v.trackHeading, eq.heading);
        const toFace = toTruck + Math.PI * 0.75;
        // 0–0.35 dig, 0.35–0.55 swing to truck, 0.55–0.7 dump, 0.7–1 swing back.
        const swing = ph < 0.35 ? 0 : ph < 0.55 ? (ph - 0.35) / 0.2 : ph < 0.7 ? 1 : 1 - (ph - 0.7) / 0.3;
        houseTarget = toFace + (toTruck - toFace) * smooth(swing);
        boom = ph < 0.35 ? 0.15 - 0.3 * (ph / 0.35) : -0.35;
        stick = ph < 0.35 ? 0.9 - 0.8 * (ph / 0.35) : 0.5;
        bucket = ph < 0.35 ? -0.4 : ph < 0.7 && ph > 0.55 ? 1.4 : 0.1;
      }
      v.houseYaw = approach(v.houseYaw, houseTarget, eq.activity === "dig" ? 9 : 2, dt);
      pv.house.transform.rotation = yaw(v.houseYaw);
      pv.boom.transform.rotation = pitch(boom);
      pv.stick.transform.rotation = pitch(stick);
      pv.bucket.transform.rotation = pitch(bucket);
    } else if (cat === "DRILL" && pv.mast) {
      const up = eq.activity === "drill" || (eq.currentTaskId !== null && !driving && eq.activity !== "drive");
      v.mastTilt = approach(v.mastTilt, up ? 0 : -1.3, 1.5, dt);
      pv.mast.transform.rotation = pitch(v.mastTilt);
      const rod = v.model.parts.rod;
      if (rod) {
        const depth = eq.activity === "drill" ? (since * 0.6) % 4 : 0;
        rod.transform.position = new Vec3(0, 4.0 - depth, 0.42);
        rod.transform.rotation = yaw(eq.activity === "drill" ? this.time * 8 : 0);
      }
    } else if (cat === "DOZER" && pv.blade) {
      const bob = eq.activity === "push" ? Math.sin(this.time * 3) * 0.08 - 0.05 : 0.15;
      pv.blade.transform.position = new Vec3(0, 0.2 + bob, 2.6);
    }
  }

  dispose(): void {
    for (const v of this.views.values()) v.model.root.destroy();
    this.views.clear();
  }
}

function angleDelta(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function smooth(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

export type { Entity };
