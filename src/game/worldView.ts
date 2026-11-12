/**
 * Everything in the world that is not terrain or a machine: buildings, the ROM stockpile cone,
 * and the line overlays drawn every frame through the renderer's debug-line pass — block outlines,
 * drill holes, exploration holes, dump footprints, routes, the blast exclusion ring and the
 * selection ring. Lines are cheap, always on top of the terrain, and need no meshes.
 */
import { Vec3, type Engine, type Entity, type Scene } from "@forge/engine";
import type { Sim } from "../sim/sim.js";
import type { CellRect } from "../sim/world/terrain.js";
import { buildConveyor, buildFacility, forgetRenderables, part, placed, renderableOf, type ModelKit } from "./models.js";
import { alongPath } from "../sim/logistics/construction.js";
import type { EquipmentView } from "./equipmentView.js";

/**
 * Forge debug-line colours are 0xAARRGGBB; an alpha byte below 128 means *emissive radiance* in
 * eighths (see Renderer.drawEmissiveLine), so ordinary colours keep alpha ≥ 128.
 */
export function rgba(r: number, g: number, b: number, a = 255): number {
  return ((Math.max(128, a) << 24) | (r << 16) | (g << 8) | b) >>> 0;
}

const BLOCK_COLOR: Record<string, number> = {
  UNMINED: rgba(210, 210, 230),
  PREPARING: rgba(200, 150, 90),
  DRILLING: rgba(255, 180, 40),
  BLAST_READY: rgba(255, 110, 40),
  BLASTED: rgba(255, 70, 70),
  EXCAVATING: rgba(255, 230, 80),
  COAL_EXPOSED: rgba(120, 200, 255),
  COAL_MINING: rgba(150, 150, 255),
  COMPLETE: rgba(110, 220, 120),
};

export interface Highlight {
  equipmentId: string | null;
  blockId: string | null;
  hoverBlockId: string | null;
  /** Pending destination point (task dialog picking). */
  point: { x: number; z: number } | null;
}

export class WorldView {
  private stockpiles = new Map<string, { root: Entity; cone: Entity }>();
  private conveyors = new Map<string, { root: Entity; load: Entity; run: number }>();
  private facilities: Entity[] = [];
  readonly lines = { blocks: true, holes: true, samples: true, routes: true, dumps: true };

  constructor(
    private engine: Engine,
    private scene: Scene,
    private kit: ModelKit,
    private sim: Sim,
  ) {
    const t = sim.terrain;
    for (const f of sim.state.facilities) this.facilities.push(buildFacility(scene, kit, f, t.heightAt(f.x, f.z)));
  }

  private line(ax: number, az: number, bx: number, bz: number, color: number, lift = 0.4, glow = 0): void {
    const t = this.sim.terrain;
    const len = Math.hypot(bx - ax, bz - az);
    // Short segments so the line follows the ground between mesh vertices (cells are 4 m).
    const n = Math.max(1, Math.ceil(len / 3));
    let px = ax;
    let pz = az;
    let py = t.heightAt(ax, az) + lift;
    for (let s = 1; s <= n; s++) {
      const x = ax + ((bx - ax) * s) / n;
      const z = az + ((bz - az) * s) / n;
      const y = t.heightAt(x, z) + lift;
      if (glow > 0) this.engine.renderer.drawEmissiveLine(new Vec3(px, py, pz), new Vec3(x, y, z), color & 0xffffff, glow);
      else this.engine.renderer.drawLine(new Vec3(px, py, pz), new Vec3(x, y, z), color);
      px = x;
      py = y;
      pz = z;
    }
  }

  private rect(r: CellRect, color: number, lift = 0.4, glow = 0): void {
    const t = this.sim.terrain;
    const x0 = t.cellX(r.i0) - t.cellSize / 2;
    const x1 = t.cellX(r.i1) + t.cellSize / 2;
    const z0 = t.cellZ(r.j0) - t.cellSize / 2;
    const z1 = t.cellZ(r.j1) + t.cellSize / 2;
    this.line(x0, z0, x1, z0, color, lift, glow);
    this.line(x1, z0, x1, z1, color, lift, glow);
    this.line(x1, z1, x0, z1, color, lift, glow);
    this.line(x0, z1, x0, z0, color, lift, glow);
  }

  private circle(x: number, z: number, r: number, color: number, segments = 48, lift = 0.6, glow = 0): void {
    for (let s = 0; s < segments; s++) {
      const a0 = (s / segments) * Math.PI * 2;
      const a1 = ((s + 1) / segments) * Math.PI * 2;
      this.line(x + Math.cos(a0) * r, z + Math.sin(a0) * r, x + Math.cos(a1) * r, z + Math.sin(a1) * r, color, lift, glow);
    }
  }

  private post(x: number, z: number, h: number, color: number): void {
    const y = this.sim.terrain.heightAt(x, z);
    this.engine.renderer.drawLine(new Vec3(x, y, z), new Vec3(x, y + h, z), color);
  }

  update(highlight: Highlight, equipment: EquipmentView, time: number): void {
    const sim = this.sim;
    const t = sim.terrain;
    // ROM stockpile: a cone at the angle of repose whose volume is the stockpile's tonnage.
    for (const s of sim.state.stockpiles) {
      let e = this.stockpiles.get(s.id);
      if (!e) {
        const root = placed(this.scene, `stockpile-${s.id}`, new Vec3(s.x, t.heightAt(s.x, s.z), s.z));
        const cone = part(this.scene, this.kit, root, `stockpile-${s.id}.cone`, { pos: [0, 0.5, 0], size: [1, 1, 1], color: 0x161616, geometry: "cone", roughness: 0.75 });
        e = { root, cone };
        this.stockpiles.set(s.id, e);
      }
      const v = Math.max(0, s.tonnes) / 0.95;
      const R = Math.cbrt(v / (Math.PI * 0.25)) || 0;
      const vis = R > 0.6;
      e.root.transform.scale = vis ? new Vec3(R, R * 0.75, R) : new Vec3(0.01, 0.01, 0.01);
      const r = renderableOf(e.cone);
      if (r) r.visible = vis;
      // Footprint marker so the empty pile is still findable.
      if (this.lines.dumps) this.circle(s.x, s.z, Math.max(10, R + 2), rgba(70, 70, 70), 24, 0.3);
    }

    // Conveyors: built once when commissioned; the load strip shows what the belt is carrying.
    for (const c of sim.state.conveyors) {
      let v = this.conveyors.get(c.id);
      if (!v) {
        const a = c.path[0]!;
        const b = c.path[c.path.length - 1]!;
        const m = buildConveyor(this.scene, this.kit, c.id, { x: a.x, y: t.heightAt(a.x, a.z), z: a.z }, { x: b.x, y: t.heightAt(b.x, b.z), z: b.z });
        v = { root: m.root, load: m.load, run: c.length };
        this.conveyors.set(c.id, v);
      }
      const r = renderableOf(v.load);
      if (r) r.visible = c.beltT > 0.5;
      const color = c.state === "DAMAGED" ? rgba(255, 70, 60) : c.state === "JAMMED" ? rgba(255, 170, 40) : c.state === "RUNNING" ? rgba(110, 220, 120) : rgba(150, 150, 150);
      const a = c.path[0]!;
      this.circle(a.x, a.z, 5, color, 16, 0.4);
    }

    // Construction in progress: the finished part solid, the rest as a planned line.
    for (const p of sim.state.projects) {
      if (p.status !== "PLANNED" && p.status !== "IN_PROGRESS") continue;
      const a = p.path[0]!;
      const b = p.path[p.path.length - 1]!;
      if (p.type === "STOCKPILE") {
        this.circle(a.x, a.z, 18, rgba(120, 200, 255), 32, 0.5, p.progress > 0 ? 2 : 0);
        continue;
      }
      const at = alongPath(p, p.progress);
      if (p.progress > 0) this.line(a.x, a.z, at.x, at.z, rgba(255, 210, 90), 0.9, 2.5);
      this.line(at.x, at.z, b.x, b.z, rgba(120, 200, 255), 0.9, 1.2);
      const half = p.type === "HAUL_ROAD" ? 5 : 1.2;
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = (-(b.z - a.z) / len) * half;
      const nz = ((b.x - a.x) / len) * half;
      this.line(a.x + nx, a.z + nz, b.x + nx, b.z + nz, rgba(120, 200, 255, 200), 0.5);
      this.line(a.x - nx, a.z - nz, b.x - nx, b.z - nz, rgba(120, 200, 255, 200), 0.5);
    }

    if (this.lines.dumps) {
      for (const d of sim.state.dumps) this.rect(d.rect, d.accepts === "TOPSOIL" ? rgba(150, 110, 70) : rgba(170, 160, 140), 0.3);
    }

    if (this.lines.blocks) {
      for (const b of sim.state.blocks) {
        const selected = b.id === highlight.blockId;
        const hover = b.id === highlight.hoverBlockId;
        const c = BLOCK_COLOR[b.state] ?? rgba(255, 255, 255);
        if (selected || hover) this.rect(b.rect, c, 0.9, selected ? 3 : 1.5);
        else this.rect(b.rect, (c & 0x00ffffff) | (190 << 24), 0.6);
      }
    }

    if (this.lines.holes) {
      for (const p of sim.state.drillPatterns) {
        const showAll = p.blockId === highlight.blockId;
        if (!showAll && p.completedAt !== null && sim.block(p.blockId)?.state !== "BLAST_READY") continue;
        for (const h of p.holes) {
          const c = !h.drilled ? rgba(230, 230, 230) : h.coalAt !== null ? rgba(40, 40, 40) : rgba(255, 150, 40);
          this.post(h.x, h.z, h.drilled ? 1.4 : 0.8, c);
        }
      }
    }

    if (this.lines.samples) {
      for (const s of sim.state.samples) {
        if (s.kind === "BLAST_HOLE") continue;
        const c = s.seamDepth === null ? rgba(255, 90, 90) : s.kind === "LEGACY" ? rgba(200, 170, 255) : rgba(90, 200, 255);
        this.post(s.x, s.z, 7, c);
        this.circle(s.x, s.z, 1.5, c, 8, 0.4);
      }
    }

    // Blast exclusion zone.
    const hold = sim.state.blastHold;
    if (hold) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 6);
      this.circle(hold.x, hold.z, hold.radius, rgba(255, Math.round(60 + 60 * pulse), 40), 72, 1, 4);
    }

    // Selected machine: ring and the route it is following.
    const eq = sim.equipment(highlight.equipmentId);
    if (eq) {
      const p = equipment.pose(eq.id);
      if (p) this.circle(p.x, p.z, p.radius * 0.9, rgba(255, 220, 60), 32, 0.6, 3);
      if (this.lines.routes && eq.route) {
        let x = eq.x;
        let z = eq.z;
        for (let i = eq.routeIndex; i < eq.route.length; i++) {
          const w = eq.route[i]!;
          this.line(x, z, w.x, w.z, w.edgeId ? rgba(80, 220, 255) : rgba(120, 255, 200), 0.8);
          x = w.x;
          z = w.z;
        }
      }
    }
    if (highlight.point) {
      this.circle(highlight.point.x, highlight.point.z, 3, rgba(120, 255, 200), 16, 0.6);
      this.post(highlight.point.x, highlight.point.z, 8, rgba(120, 255, 200));
    }
  }

  dispose(): void {
    for (const e of this.facilities) e.destroy();
    for (const e of this.stockpiles.values()) e.root.destroy();
    for (const c of this.conveyors.values()) {
      forgetRenderables(c.root);
      c.root.destroy();
    }
  }
}

