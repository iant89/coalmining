/**
 * Procedural models for equipment and buildings, assembled from Forge primitives (spec §79 lists a
 * 3D model per machine as content; until there are authored GLBs these stand in). A model is a
 * small entity hierarchy with named pivots the equipment view animates: a truck's bed, an
 * excavator's house/boom/stick, a drill's mast, a dozer's blade.
 *
 * Every model's local frame: +Z forward, +Y up, origin on the ground at the machine's centre.
 */
import { Color, Material, Quat, Renderable, Vec3, createBox, createCylinder, type Engine, type Entity, type Geometry, type Scene } from "@forge/engine";

export interface ModelKit {
  box: Geometry;
  cylinder: Geometry;
  cone: Geometry;
  material(hex: string | number, roughness?: number, metallic?: number): Material;
  dispose(): void;
}

export function createModelKit(engine: Engine): ModelKit {
  const box = createBox(engine.gpu, { width: 1, height: 1, depth: 1 });
  const cylinder = createCylinder(engine.gpu, { radiusTop: 0.5, radiusBottom: 0.5, height: 1, radialSegments: 16 });
  const cone = createCylinder(engine.gpu, { radiusTop: 0.04, radiusBottom: 1, height: 1, radialSegments: 24 });
  const cache = new Map<string, Material>();
  return {
    box,
    cylinder,
    cone,
    material(hex, roughness = 0.6, metallic = 0.1) {
      const key = `${hex}|${roughness}|${metallic}`;
      let m = cache.get(key);
      if (!m) {
        const c = typeof hex === "number" ? hex : parseInt(hex.replace("#", ""), 16);
        m = new Material({ label: `mat-${key}`, color: Color.fromSrgbHex(c), roughness, metallic });
        cache.set(key, m);
      }
      return m;
    },
    dispose() {
      box.dispose();
      cylinder.dispose();
      cone.dispose();
    },
  };
}

const UP = new Vec3(0, 1, 0);
const RIGHT = new Vec3(1, 0, 0);
const FWD = new Vec3(0, 0, 1);

export interface PartOptions {
  pos: [number, number, number];
  size: [number, number, number];
  color: string | number;
  geometry?: "box" | "cylinder" | "cone";
  /** Euler-ish: rotations applied X then Y then Z (radians). */
  rot?: [number, number, number];
  roughness?: number;
  metallic?: number;
  shadow?: boolean;
}

/**
 * `createTransformedEntity`, with the position also written through the transform handle.
 *
 * Models are built inside the game's system pass, where Forge queues the Transform component and
 * keeps the pose on the component until the pass ends. A handle write in between (a part's scale or
 * rotation) allocates the transform at the origin and, when the queue flushes, that origin pose
 * wins: the entity renders at (0, 0, 0) and is culled. Writing the position through the handle
 * first makes the pose live in the transform store from the start. (Forge-Engine bug; this stays
 * correct after the engine fix.)
 */
export function placed(scene: Scene, name: string, pos: Vec3): Entity {
  const e = scene.createTransformedEntity(name, pos);
  e.transform.position = new Vec3(pos.x, pos.y, pos.z);
  return e;
}

export function rotationXYZ(x: number, y: number, z: number): Quat {
  const qx = Quat.fromAxisAngle(RIGHT, x);
  const qy = Quat.fromAxisAngle(UP, y);
  const qz = Quat.fromAxisAngle(FWD, z);
  return qz.multiply(qy).multiply(qx).normalize();
}

export function yaw(angle: number): Quat {
  return Quat.fromAxisAngle(UP, angle);
}

export function pitch(angle: number): Quat {
  return Quat.fromAxisAngle(RIGHT, angle);
}

/** An empty pivot entity under `parent`. */
export function pivot(scene: Scene, parent: Entity, name: string, pos: [number, number, number]): Entity {
  const e = placed(scene, name, new Vec3(pos[0], pos[1], pos[2]));
  parent.addChild(e);
  return e;
}

/**
 * Renderables by entity id. Kept by reference rather than looked up with `entity.get(Renderable)`
 * because parts are often created inside a system pass (the game runs as an engine system), where
 * Forge journals component additions until the pass ends — a lookup straight after creation sees
 * nothing yet.
 */
const RENDERABLES = new Map<number, Renderable>();

export function renderableOf(e: Entity): Renderable | undefined {
  return RENDERABLES.get(e.id);
}

export function forgetRenderables(e: Entity): void {
  RENDERABLES.delete(e.id);
  for (const c of e.children) forgetRenderables(c);
}

export function part(scene: Scene, kit: ModelKit, parent: Entity, name: string, o: PartOptions): Entity {
  const e = placed(scene, name, new Vec3(o.pos[0], o.pos[1], o.pos[2]));
  parent.addChild(e);
  e.transform.scale = new Vec3(o.size[0], o.size[1], o.size[2]);
  if (o.rot) e.transform.rotation = rotationXYZ(o.rot[0], o.rot[1], o.rot[2]);
  const r = new Renderable();
  r.geometry = o.geometry === "cylinder" ? kit.cylinder : o.geometry === "cone" ? kit.cone : kit.box;
  r.material = kit.material(o.color, o.roughness ?? 0.6, o.metallic ?? 0.1);
  r.castShadow = o.shadow ?? true;
  scene.world.addComponent(e.id, r);
  RENDERABLES.set(e.id, r);
  return e;
}

/** Wheels: cylinders lying on their side (axis along X). */
function wheel(scene: Scene, kit: ModelKit, parent: Entity, name: string, x: number, z: number, r: number, w: number): Entity {
  return part(scene, kit, parent, name, { pos: [x, r, z], size: [r * 2, w, r * 2], color: 0x1d1d1f, geometry: "cylinder", rot: [0, 0, Math.PI / 2], roughness: 0.95 });
}

export interface EquipmentModel {
  root: Entity;
  /** Named animation pivots. */
  pivots: Record<string, Entity>;
  /** Parts whose visibility follows state (load in the bed, …). */
  parts: Record<string, Entity>;
  /** Bounding radius for picking. */
  radius: number;
  height: number;
}

const DARK = 0x2a2b2e;
const GLASS = 0x8fb3c9;
const STEEL = 0x6d7178;

export function buildHaulTruck(scene: Scene, kit: ModelKit, name: string, color: string, size: { length: number; width: number; height: number }): EquipmentModel {
  const root = placed(scene, name, new Vec3(0, 0, 0));
  const L = size.length;
  const W = size.width;
  const r = 0.95 * (W / 4.6);
  part(scene, kit, root, `${name}.chassis`, { pos: [0, r * 1.25, 0], size: [W * 0.55, 0.8, L * 0.92], color: DARK });
  // Front: engine and deck with the cab on the left.
  part(scene, kit, root, `${name}.hood`, { pos: [0, r * 1.25 + 0.9, L * 0.36], size: [W * 0.62, 1.2, L * 0.2], color });
  part(scene, kit, root, `${name}.deck`, { pos: [0, r * 1.25 + 1.55, L * 0.38], size: [W * 0.98, 0.15, L * 0.18], color: DARK });
  part(scene, kit, root, `${name}.cab`, { pos: [-W * 0.27, r * 1.25 + 2.35, L * 0.38], size: [W * 0.38, 1.45, L * 0.15], color });
  part(scene, kit, root, `${name}.glass`, { pos: [-W * 0.27, r * 1.25 + 2.45, L * 0.457], size: [W * 0.34, 0.8, 0.05], color: GLASS, roughness: 0.15, metallic: 0.3 });
  part(scene, kit, root, `${name}.grille`, { pos: [0, r * 1.25 + 0.8, L * 0.465], size: [W * 0.5, 0.9, 0.08], color: 0x3b3b3b });
  // Body on a pivot at the rear hinge so it can tip.
  const bedPivot = pivot(scene, root, `${name}.bedPivot`, [0, r * 1.25 + 0.55, -L * 0.42]);
  part(scene, kit, bedPivot, `${name}.bedFloor`, { pos: [0, 0.1, L * 0.33], size: [W * 0.94, 0.25, L * 0.7], color });
  part(scene, kit, bedPivot, `${name}.bedL`, { pos: [-W * 0.46, 0.85, L * 0.33], size: [0.12, 1.6, L * 0.7], color });
  part(scene, kit, bedPivot, `${name}.bedR`, { pos: [W * 0.46, 0.85, L * 0.33], size: [0.12, 1.6, L * 0.7], color });
  part(scene, kit, bedPivot, `${name}.bedFront`, { pos: [0, 1.25, L * 0.68], size: [W * 0.94, 2.4, 0.15], color });
  part(scene, kit, bedPivot, `${name}.canopy`, { pos: [0, 2.45, L * 0.78], size: [W * 0.94, 0.12, L * 0.2], color });
  const load = part(scene, kit, bedPivot, `${name}.load`, { pos: [0, 0.75, L * 0.33], size: [W * 0.86, 1.2, L * 0.62], color: 0x7a6a58, roughness: 1 });
  wheel(scene, kit, root, `${name}.wFL`, -W * 0.4, L * 0.33, r, 0.8);
  wheel(scene, kit, root, `${name}.wFR`, W * 0.4, L * 0.33, r, 0.8);
  wheel(scene, kit, root, `${name}.wRL`, -W * 0.36, -L * 0.25, r, 1.5);
  wheel(scene, kit, root, `${name}.wRR`, W * 0.36, -L * 0.25, r, 1.5);
  return { root, pivots: { bed: bedPivot }, parts: { load }, radius: L * 0.55, height: size.height };
}

export function buildExcavator(scene: Scene, kit: ModelKit, name: string, color: string, size: { length: number; width: number; height: number }): EquipmentModel {
  const root = placed(scene, name, new Vec3(0, 0, 0));
  const W = size.width;
  part(scene, kit, root, `${name}.trackL`, { pos: [-W * 0.38, 0.55, 0], size: [0.9, 1.1, 5.4], color: 0x242424, roughness: 0.95 });
  part(scene, kit, root, `${name}.trackR`, { pos: [W * 0.38, 0.55, 0], size: [0.9, 1.1, 5.4], color: 0x242424, roughness: 0.95 });
  part(scene, kit, root, `${name}.carbody`, { pos: [0, 1.1, 0], size: [W * 0.5, 0.6, 2.4], color: DARK });
  const house = pivot(scene, root, `${name}.house`, [0, 1.5, 0]);
  part(scene, kit, house, `${name}.upper`, { pos: [0, 0.75, -0.4], size: [W * 0.78, 1.5, 4.2], color });
  part(scene, kit, house, `${name}.counterweight`, { pos: [0, 0.8, -2.6], size: [W * 0.78, 1.3, 0.8], color: DARK });
  part(scene, kit, house, `${name}.cab`, { pos: [-W * 0.24, 2.05, 1.05], size: [1.3, 1.6, 1.7], color });
  part(scene, kit, house, `${name}.glass`, { pos: [-W * 0.24, 2.15, 1.91], size: [1.1, 1.0, 0.05], color: GLASS, roughness: 0.15, metallic: 0.3 });
  const boom = pivot(scene, house, `${name}.boom`, [W * 0.12, 1.4, 1.2]);
  part(scene, kit, boom, `${name}.boomArm`, { pos: [0, 0, 2.9], size: [0.75, 0.9, 6.0], color });
  const stick = pivot(scene, boom, `${name}.stick`, [0, 0.1, 5.8]);
  part(scene, kit, stick, `${name}.stickArm`, { pos: [0, -1.6, 0], size: [0.55, 3.4, 0.6], color });
  const bucket = pivot(scene, stick, `${name}.bucket`, [0, -3.3, 0]);
  part(scene, kit, bucket, `${name}.bucketBody`, { pos: [0, -0.4, 0.45], size: [1.7, 1.1, 1.2], color: STEEL, metallic: 0.5, roughness: 0.4 });
  return { root, pivots: { house, boom, stick, bucket }, parts: {}, radius: 7, height: size.height };
}

export function buildDrill(scene: Scene, kit: ModelKit, name: string, color: string, size: { length: number; width: number; height: number }): EquipmentModel {
  const root = placed(scene, name, new Vec3(0, 0, 0));
  const W = size.width;
  part(scene, kit, root, `${name}.trackL`, { pos: [-W * 0.36, 0.5, 0], size: [0.8, 1.0, 5.6], color: 0x242424, roughness: 0.95 });
  part(scene, kit, root, `${name}.trackR`, { pos: [W * 0.36, 0.5, 0], size: [0.8, 1.0, 5.6], color: 0x242424, roughness: 0.95 });
  part(scene, kit, root, `${name}.deck`, { pos: [0, 1.35, -0.2], size: [W * 0.92, 0.7, 7.0], color });
  part(scene, kit, root, `${name}.engine`, { pos: [0, 2.3, -2.2], size: [W * 0.8, 1.3, 2.4], color });
  part(scene, kit, root, `${name}.cab`, { pos: [W * 0.28, 2.4, 1.6], size: [1.2, 1.5, 1.6], color });
  part(scene, kit, root, `${name}.glass`, { pos: [W * 0.28, 2.5, 2.42], size: [1.0, 0.9, 0.05], color: GLASS, roughness: 0.15, metallic: 0.3 });
  const mast = pivot(scene, root, `${name}.mast`, [-0.3, 1.7, 3.0]);
  part(scene, kit, mast, `${name}.mastBody`, { pos: [0, 4.6, 0], size: [0.7, 9.2, 0.7], color: 0xb94d22 });
  const rod = part(scene, kit, mast, `${name}.rod`, { pos: [0, 4.0, 0.42], size: [0.18, 8.0, 0.18], color: STEEL, geometry: "cylinder", metallic: 0.7, roughness: 0.3 });
  return { root, pivots: { mast }, parts: { rod }, radius: 5.5, height: size.height };
}

export function buildDozer(scene: Scene, kit: ModelKit, name: string, color: string, size: { length: number; width: number; height: number }): EquipmentModel {
  const root = placed(scene, name, new Vec3(0, 0, 0));
  const W = size.width;
  part(scene, kit, root, `${name}.trackL`, { pos: [-W * 0.36, 0.55, -0.3], size: [0.75, 1.1, 4.0], color: 0x242424, roughness: 0.95 });
  part(scene, kit, root, `${name}.trackR`, { pos: [W * 0.36, 0.55, -0.3], size: [0.75, 1.1, 4.0], color: 0x242424, roughness: 0.95 });
  part(scene, kit, root, `${name}.body`, { pos: [0, 1.5, 0.2], size: [W * 0.5, 1.4, 3.2], color });
  part(scene, kit, root, `${name}.cab`, { pos: [0, 2.85, -0.9], size: [1.6, 1.4, 1.5], color });
  part(scene, kit, root, `${name}.glass`, { pos: [0, 2.95, -0.13], size: [1.4, 0.9, 0.05], color: GLASS, roughness: 0.15, metallic: 0.3 });
  const blade = pivot(scene, root, `${name}.blade`, [0, 0.2, 2.6]);
  part(scene, kit, blade, `${name}.bladeBody`, { pos: [0, 0.75, 0], size: [W * 1.02, 1.5, 0.35], color, metallic: 0.3 });
  part(scene, kit, root, `${name}.ripper`, { pos: [0, 0.8, -2.6], size: [0.25, 1.4, 0.4], color: STEEL });
  return { root, pivots: { blade }, parts: {}, radius: 4.5, height: size.height };
}

export function buildGrader(scene: Scene, kit: ModelKit, name: string, color: string, size: { length: number; width: number; height: number }): EquipmentModel {
  const root = placed(scene, name, new Vec3(0, 0, 0));
  const L = size.length;
  const W = size.width;
  // Long front frame over the front axle, tandem rear axles under the engine and cab.
  part(scene, kit, root, `${name}.frame`, { pos: [0, 1.25, L * 0.12], size: [0.55, 0.5, L * 0.72], color });
  part(scene, kit, root, `${name}.engine`, { pos: [0, 1.5, -L * 0.33], size: [W * 0.9, 1.3, L * 0.28], color });
  part(scene, kit, root, `${name}.cab`, { pos: [0, 2.5, -L * 0.1], size: [W * 0.85, 1.5, 1.6], color });
  part(scene, kit, root, `${name}.glass`, { pos: [0, 2.6, -L * 0.1 + 0.81], size: [W * 0.75, 0.9, 0.05], color: GLASS, roughness: 0.15, metallic: 0.3 });
  const blade = pivot(scene, root, `${name}.blade`, [0, 0.55, L * 0.05]);
  part(scene, kit, blade, `${name}.moldboard`, { pos: [0, 0, 0], size: [W * 1.45, 0.65, 0.25], color: STEEL, metallic: 0.5, roughness: 0.4, rot: [0, 0.45, 0] });
  wheel(scene, kit, root, `${name}.wF1`, -W * 0.42, L * 0.42, 0.75, 0.5);
  wheel(scene, kit, root, `${name}.wF2`, W * 0.42, L * 0.42, 0.75, 0.5);
  for (const z of [-L * 0.25, -L * 0.42]) {
    wheel(scene, kit, root, `${name}.wRL${z}`, -W * 0.42, z, 0.75, 0.5);
    wheel(scene, kit, root, `${name}.wRR${z}`, W * 0.42, z, 0.75, 0.5);
  }
  return { root, pivots: { blade }, parts: {}, radius: L * 0.55, height: size.height };
}

/** Two-axle road-truck chassis and cab shared by the lube and service trucks. */
function utilityChassis(scene: Scene, kit: ModelKit, root: Entity, name: string, color: PartOptions["color"], L: number, W: number): number {
  const r = 0.55;
  const deck = r * 2 + 0.25;
  part(scene, kit, root, `${name}.chassis`, { pos: [0, r + 0.35, 0], size: [W * 0.7, 0.4, L * 0.95], color: DARK });
  part(scene, kit, root, `${name}.cab`, { pos: [0, deck + 0.85, L * 0.36], size: [W * 0.92, 1.7, L * 0.2], color });
  part(scene, kit, root, `${name}.glass`, { pos: [0, deck + 1.15, L * 0.461], size: [W * 0.8, 0.7, 0.05], color: GLASS, roughness: 0.15, metallic: 0.3 });
  part(scene, kit, root, `${name}.bumper`, { pos: [0, r + 0.3, L * 0.48], size: [W * 0.95, 0.35, 0.2], color: STEEL, metallic: 0.5 });
  // Amber beacon on the cab roof.
  part(scene, kit, root, `${name}.beacon`, { pos: [0, deck + 1.8, L * 0.36], size: [0.25, 0.2, 0.25], color: 0xf2a516, geometry: "cylinder", shadow: false });
  for (const [z, tag] of [[L * 0.33, "F"], [-L * 0.22, "R1"], [-L * 0.36, "R2"]] as const) {
    wheel(scene, kit, root, `${name}.w${tag}L`, -W * 0.42, z, r, 0.45);
    wheel(scene, kit, root, `${name}.w${tag}R`, W * 0.42, z, r, 0.45);
  }
  return deck;
}

/** Lube truck: a diesel tank behind the cab and a hose-reel cabinet at the back. */
export function buildLubeTruck(scene: Scene, kit: ModelKit, name: string, color: string, size: { length: number; width: number; height: number }): EquipmentModel {
  const root = placed(scene, name, new Vec3(0, 0, 0));
  const L = size.length;
  const W = size.width;
  const deck = utilityChassis(scene, kit, root, name, 0xe8e2d0, L, W);
  const d = Math.min(W * 0.85, size.height - deck - 0.1);
  part(scene, kit, root, `${name}.tank`, { pos: [0, deck + d / 2, -L * 0.04], size: [d, L * 0.5, d], color, geometry: "cylinder", rot: [Math.PI / 2, 0, 0], metallic: 0.4, roughness: 0.35 });
  part(scene, kit, root, `${name}.band1`, { pos: [0, deck + d / 2, L * 0.12], size: [d * 1.04, 0.12, d * 1.04], color: 0x1f5f9f, geometry: "cylinder", rot: [Math.PI / 2, 0, 0] });
  part(scene, kit, root, `${name}.band2`, { pos: [0, deck + d / 2, -L * 0.2], size: [d * 1.04, 0.12, d * 1.04], color: 0x1f5f9f, geometry: "cylinder", rot: [Math.PI / 2, 0, 0] });
  part(scene, kit, root, `${name}.reels`, { pos: [0, deck + 0.7, -L * 0.42], size: [W * 0.95, 1.4, L * 0.14], color: STEEL, metallic: 0.4 });
  const hose = pivot(scene, root, `${name}.hose`, [W * 0.48, deck + 0.6, -L * 0.42]);
  const nozzle = part(scene, kit, hose, `${name}.hoseLine`, { pos: [0.9, 0, 0], size: [1.8, 0.1, 0.1], color: 0x161616, shadow: false });
  return { root, pivots: { hose }, parts: { nozzle }, radius: L * 0.55, height: size.height };
}

/** Service (mechanic's) truck: tool boxes along both sides and a knuckle crane at the back. */
export function buildServiceTruck(scene: Scene, kit: ModelKit, name: string, color: string, size: { length: number; width: number; height: number }): EquipmentModel {
  const root = placed(scene, name, new Vec3(0, 0, 0));
  const L = size.length;
  const W = size.width;
  const deck = utilityChassis(scene, kit, root, name, color, L, W);
  part(scene, kit, root, `${name}.bed`, { pos: [0, deck + 0.05, -L * 0.1], size: [W * 0.6, 0.1, L * 0.62], color: DARK });
  for (const side of [-1, 1]) {
    part(scene, kit, root, `${name}.box${side}`, { pos: [side * W * 0.36, deck + 0.6, -L * 0.1], size: [W * 0.28, 1.2, L * 0.62], color });
    for (let n = 0; n < 3; n++) part(scene, kit, root, `${name}.door${side}${n}`, { pos: [side * W * 0.501, deck + 0.6, -L * 0.1 + (n - 1) * L * 0.2], size: [0.04, 0.95, L * 0.17], color: 0xd8d8d8, metallic: 0.6, roughness: 0.3, shadow: false });
  }
  const crane = pivot(scene, root, `${name}.crane`, [W * 0.25, deck + 1.2, -L * 0.38]);
  part(scene, kit, crane, `${name}.post`, { pos: [0, 0.35, 0], size: [0.45, 0.7, 0.45], color: 0xf2c014, geometry: "cylinder" });
  const boom = pivot(scene, crane, `${name}.boom`, [0, 0.7, 0]);
  part(scene, kit, boom, `${name}.boomArm`, { pos: [0, 0, 1.6], size: [0.3, 0.3, 3.2], color: 0xf2c014 });
  part(scene, kit, boom, `${name}.hook`, { pos: [0, -0.5, 3.1], size: [0.05, 1.0, 0.05], color: DARK, shadow: false });
  return { root, pivots: { crane, boom }, parts: {}, radius: L * 0.55, height: size.height };
}

/**
 * An overland conveyor between two ground points: a truck hopper, a run of trussed frame sections on
 * supports, the belt (with a load strip the view scales with the material on it) and a drive head
 * over the discharge. Returns the belt-load part so the view can show what the belt carries.
 */
export function buildConveyor(scene: Scene, kit: ModelKit, id: string, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): { root: Entity; load: Entity; parts: Entity[] } {
  const root = placed(scene, `conveyor-${id}`, new Vec3(0, 0, 0));
  const parts: Entity[] = [];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  const yawA = Math.atan2(dx, dz);
  // The belt starts low at the hopper and rises to discharge over the pile.
  const y0 = a.y + 2.2;
  const y1 = b.y + 9;
  const slope = Math.atan2(y1 - y0, len);
  const run = Math.hypot(len, y1 - y0);
  const mid = { x: (a.x + b.x) / 2, y: (y0 + y1) / 2, z: (a.z + b.z) / 2 };
  const beam = pivot(scene, root, `conveyor-${id}.beam`, [mid.x, mid.y, mid.z]);
  beam.transform.rotation = rotationXYZ(-slope, yawA, 0);
  parts.push(part(scene, kit, beam, `conveyor-${id}.frame`, { pos: [0, -0.25, 0], size: [1.6, 0.5, run], color: 0x7d858c, metallic: 0.5, roughness: 0.5 }));
  parts.push(part(scene, kit, beam, `conveyor-${id}.belt`, { pos: [0, 0.03, 0], size: [1.2, 0.06, run], color: 0x1b1b1d, roughness: 0.9 }));
  const load = part(scene, kit, beam, `conveyor-${id}.load`, { pos: [0, 0.15, 0], size: [0.9, 0.18, run], color: 0x101010, roughness: 0.8, shadow: false });
  parts.push(part(scene, kit, beam, `conveyor-${id}.cover`, { pos: [0, 0.9, 0], size: [1.8, 0.08, run], color: 0x9aa3ab, metallic: 0.4, roughness: 0.5 }));
  // Supports every ~14 m, from the ground up to the belt.
  const n = Math.max(1, Math.floor(len / 14));
  for (let k = 1; k <= n; k++) {
    const f = k / (n + 1);
    const x = a.x + dx * f;
    const z = a.z + dz * f;
    const gy = a.y + (b.y - a.y) * f;
    const top = y0 + (y1 - y0) * f - 0.5;
    const h = Math.max(0.5, top - gy);
    parts.push(part(scene, kit, root, `conveyor-${id}.leg${k}`, { pos: [x, gy + h / 2, z], size: [0.25, h, 0.25], color: 0x6a7076, metallic: 0.5 }));
  }
  // Hopper: a steel box on legs the trucks back up to.
  parts.push(part(scene, kit, root, `conveyor-${id}.hopper`, { pos: [a.x, a.y + 3.2, a.z], size: [5.5, 2.6, 5.5], color: 0x8a6f3a, metallic: 0.4, roughness: 0.6, rot: [0, yawA, 0] }));
  parts.push(part(scene, kit, root, `conveyor-${id}.hopperBase`, { pos: [a.x, a.y + 1, a.z], size: [3, 2, 3], color: 0x5c636a, rot: [0, yawA, 0] }));
  // Drive head over the discharge point.
  parts.push(part(scene, kit, root, `conveyor-${id}.head`, { pos: [b.x, y1 + 0.3, b.z], size: [2.4, 1.6, 2.4], color: 0x3e5f8a, rot: [0, yawA, 0] }));
  parts.push(part(scene, kit, root, `conveyor-${id}.tower`, { pos: [b.x, (b.y + y1) / 2, b.z], size: [0.4, y1 - b.y, 0.4], color: 0x6a7076, metallic: 0.5 }));
  return { root, load, parts };
}

export function buildFacility(scene: Scene, kit: ModelKit, f: { id: string; type: string; x: number; z: number; width: number; depth: number; height: number; rotation: number }, ground: number): Entity {
  const root = placed(scene, `fac-${f.id}`, new Vec3(f.x, ground, f.z));
  root.transform.rotation = yaw(f.rotation);
  const { width: w, depth: d, height: h } = f;
  switch (f.type) {
    case "OFFICE":
      part(scene, kit, root, `${f.id}.walls`, { pos: [0, h / 2, 0], size: [w, h, d], color: 0xd8d2c4, roughness: 0.85 });
      part(scene, kit, root, `${f.id}.roof`, { pos: [0, h + 0.2, 0], size: [w + 0.8, 0.4, d + 0.8], color: 0x5b3a2e });
      part(scene, kit, root, `${f.id}.door`, { pos: [0, 1.1, d / 2 + 0.03], size: [1.2, 2.2, 0.06], color: 0x3a4a5a });
      for (const x of [-w / 3, w / 3]) part(scene, kit, root, `${f.id}.win${x}`, { pos: [x, 2.3, d / 2 + 0.03], size: [2.2, 1.2, 0.06], color: GLASS, roughness: 0.1, metallic: 0.3 });
      break;
    case "SHOP":
      part(scene, kit, root, `${f.id}.walls`, { pos: [0, h / 2, 0], size: [w, h, d], color: 0x8a949c, metallic: 0.4, roughness: 0.5 });
      part(scene, kit, root, `${f.id}.roof`, { pos: [0, h + 0.15, 0], size: [w + 0.4, 0.3, d + 0.4], color: 0x5d666e, metallic: 0.5 });
      for (const x of [-w / 4, w / 4]) part(scene, kit, root, `${f.id}.bay${x}`, { pos: [x, h * 0.38, -d / 2 - 0.03], size: [w * 0.32, h * 0.72, 0.06], color: 0x3e4248 });
      break;
    case "FUEL":
      part(scene, kit, root, `${f.id}.tank`, { pos: [0, 1.6, 0], size: [2.6, w, 2.6], color: 0xc9c2b0, geometry: "cylinder", rot: [0, 0, Math.PI / 2], metallic: 0.4, roughness: 0.4 });
      part(scene, kit, root, `${f.id}.saddle`, { pos: [0, 0.3, 0], size: [w * 0.8, 0.6, 2.2], color: 0x555555 });
      part(scene, kit, root, `${f.id}.pump`, { pos: [0, 1.0, d / 2 + 1.5], size: [0.8, 2.0, 0.6], color: 0xb02a2a });
      part(scene, kit, root, `${f.id}.canopy`, { pos: [0, 4.2, d / 2 + 1.5], size: [6, 0.25, 4], color: 0xeeeeee });
      for (const x of [-2.6, 2.6]) part(scene, kit, root, `${f.id}.post${x}`, { pos: [x, 2.1, d / 2 + 1.5], size: [0.2, 4.2, 0.2], color: 0x777777 });
      break;
    case "PARKING":
      part(scene, kit, root, `${f.id}.slab`, { pos: [0, 0.06, 0], size: [w, 0.12, d], color: 0x8b8680, roughness: 0.95, shadow: false });
      break;
    default:
      part(scene, kit, root, `${f.id}.box`, { pos: [0, h / 2, 0], size: [w, h, d], color: 0x999999 });
  }
  return root;
}
