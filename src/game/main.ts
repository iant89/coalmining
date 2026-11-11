/**
 * Black Creek — the browser game. Boots Forge-Engine, builds the 3D presentation of the mine and
 * drives the simulation from real time:
 *
 *   real dt ──► SimClock.ticksFor(speed) ──► MineSimulation.tick() × n   (authoritative state)
 *                                         └► views read state, interpolate by clock.alpha (spec §51)
 *
 * The game consumes Forge only through its package root (`@forge/engine`) and keeps every mining
 * rule in src/sim (spec §2).
 */
import { Camera, Color, DayNightCycle, Engine, Light, Scene, Vec3, type ISystem, type SystemContext } from "@forge/engine";
import { defaultCatalog } from "../sim/equipment/catalog.js";
import { DEFAULT_SCENARIO, loadScenario, SCENARIOS } from "../sim/scenario.js";
import { MineSimulation } from "../sim/simulation.js";
import { deserialize, serialize } from "../sim/save/save.js";
import type { WeatherKind } from "../sim/state.js";
import { TerrainView, type Overlay } from "./terrainView.js";
import { EquipmentView } from "./equipmentView.js";
import { WorldView } from "./worldView.js";
import { CameraRig, type CameraMode } from "./camera.js";
import { createModelKit, type ModelKit } from "./models.js";
import { project, rayTerrain, raySphere, screenRay } from "./picking.js";
import { GameUI } from "./ui/ui.js";
import type { GameApi, Selection } from "./ui/api.js";
import { blockAt } from "../sim/mining/blocks.js";

const catalog = defaultCatalog();
const params = new URLSearchParams(location.search);
const DEBUG = params.get("dev") === "1" || import.meta.env.DEV;
const AUTOSAVE_KEY = "black-creek:autosave";
/** Calendar day the scenario's day 1 falls on (early June: long days for the first shifts). */
const START_DAY_OF_YEAR = 156;
type Quality = "low" | "medium" | "high";
/** `?quality=low|medium|high`: low is for software rasterisers (CI, SwiftShader) and weak GPUs. */
const QUALITY: Quality = (["low", "medium", "high"] as const).find((q) => q === params.get("quality")) ?? "high";

class Game implements GameApi {
  ms!: MineSimulation;
  selection: Selection = null;
  readonly debug = DEBUG;
  private scene!: Scene;
  private terrain!: TerrainView;
  private equipment!: EquipmentView;
  private world!: WorldView;
  private rig!: CameraRig;
  private cycle!: DayNightCycle;
  private ui!: GameUI;
  private kit: ModelKit;
  private marker: { x: number; z: number } | null = null;
  private picking: { resolve: (p: { x: number; z: number } | null) => void } | null = null;
  private hoverBlock: string | null = null;
  private uiTimer = 0;
  private autosaveTimer = 0;
  private time = 0;
  private fps = 60;
  private tps = 0;
  private tickCount = 0;
  private tpsTimer = 0;
  private weatherShown: WeatherKind | null = null;

  constructor(
    private engine: Engine,
    private canvas: HTMLCanvasElement,
  ) {
    this.kit = createModelKit(engine);
  }

  start(ms: MineSimulation): void {
    this.ms = ms;
    this.buildScene();
    if (!this.ui) {
      this.ui = new GameUI(this);
      this.ui.bindSettings();
      this.bindInput();
    }
    this.selection = null;
    this.ui.render();
  }

  private buildScene(): void {
    const old = this.scene;
    this.terrain?.dispose();
    this.equipment?.dispose();
    this.world?.dispose();
    const scene = new Scene({ name: "black-creek" });
    this.scene = scene;
    scene.setSky({ sunIntensity: 20, turbidity: 2.6, aerialPerspective: false, quality: QUALITY === "high" ? "medium" : "low", multiScattering: QUALITY !== "low" });
    scene.setShadowSettings({ enabled: QUALITY !== "low", cascades: QUALITY === "high" ? 3 : 2, mapSize: QUALITY === "high" ? 2048 : 1024, distance: 420 });
    scene.settings.ssao.enabled = QUALITY === "high";
    scene.settings.depthPrepass = QUALITY !== "low";
    scene.settings.bloom.enabled = QUALITY !== "low";
    scene.settings.exposure = 1;
    const camEntity = scene.createTransformedEntity("camera", new Vec3(260, 420, -150));
    const camera = new Camera();
    camera.fovY = Math.PI / 4;
    camera.near = 0.5;
    camera.far = 2400;
    scene.world.addComponent(camEntity.id, camera);
    const sunEntity = scene.createTransformedEntity("sun", new Vec3(0, 400, 0));
    const sun = new Light();
    sun.kind = "directional";
    sun.castShadow = true;
    sun.cascades = QUALITY === "high" ? 3 : 2;
    sun.shadowNormalBias = 0.8;
    scene.world.addComponent(sunEntity.id, sun);
    // Eastern Kentucky, starting in early June; the sim clock drives the sun (spec §62).
    this.cycle = new DayNightCycle({ name: "sun", latitude: 37.4, longitude: -83.2, timeZone: -5, dayOfYear: START_DAY_OF_YEAR, timeOfDay: 6, timeScale: 0, sun, sunIntensity: 4.2, ambientScale: 0.7, driveAmbient: true, driveFog: true, driveSky: true });
    scene.add(this.cycle);

    const sim = this.ms.sim;
    this.terrain = new TerrainView(this.engine, scene, sim);
    this.equipment = new EquipmentView(scene, this.kit, sim);
    this.world = new WorldView(this.engine, scene, this.kit, sim);
    this.rig = new CameraRig(camEntity, camera, this.canvas, sim.terrain);
    this.rig.follow = () => (this.selection?.kind === "equipment" ? this.equipment.pose(this.selection.id) : null);
    // First view: the east ridge where the shallow blocks are, as an isometric overview.
    this.rig.centerOn(120, 10, 230);
    this.terrain.update(1000);
    this.weatherShown = null;

    const game = this;
    const system: ISystem = {
      name: "black-creek.game",
      order: 200,
      enabled: true,
      update(ctx: SystemContext) {
        game.frame(ctx.dt);
      },
    };
    scene.world.registerSystem(system);
    this.engine.setScene(scene);
    old?.dispose();
  }

  // ---------------------------------------------------------------- frame

  private frame(dtRaw: number): void {
    const dt = Math.min(0.1, Math.max(0, dtRaw));
    this.time += dt;
    this.fps += (1 / Math.max(1e-3, dtRaw) - this.fps) * 0.05;
    const clock = this.ms.sim.clock;
    const t0 = performance.now();
    const ticks = clock.ticksFor(dt);
    for (let i = 0; i < ticks; i++) {
      this.ms.tick();
      // Keep the frame responsive at extreme speeds: stop simulating after ~12 ms.
      if (performance.now() - t0 > 12 && i < ticks - 1) {
        clock.state.carry = 0;
        this.tickCount += i + 1;
        break;
      }
      if (i === ticks - 1) this.tickCount += ticks;
    }
    this.tpsTimer += dt;
    if (this.tpsTimer >= 1) {
      this.tps = this.tickCount / this.tpsTimer;
      this.tickCount = 0;
      this.tpsTimer = 0;
    }
    // Presentation.
    const doy = ((START_DAY_OF_YEAR + clock.day - 2) % 365) + 1;
    if (doy !== this.cycle.dayOfYear) this.cycle.setDate(doy);
    this.cycle.setTime(clock.hourOfDay).apply();
    this.applyWeather();
    this.terrain.update(4);
    this.equipment.update(dt, clock.alpha);
    this.rig.update(dt);
    this.world.update(
      {
        equipmentId: this.selection?.kind === "equipment" ? this.selection.id : null,
        blockId: this.selection?.kind === "block" ? this.selection.id : null,
        hoverBlockId: this.hoverBlock,
        point: this.marker ?? (this.selection?.kind === "point" ? { x: this.selection.x, z: this.selection.z } : null),
      },
      this.equipment,
      this.time,
    );
    this.renderLabels();
    this.uiTimer += dt;
    if (this.uiTimer > 0.25) {
      this.uiTimer = 0;
      this.ui.render();
      if (this.ms.state.samples.length !== this.lastSamples) {
        this.lastSamples = this.ms.state.samples.length;
        if (this.terrain.overlay === "GEOLOGY") this.terrain.refreshOverlay();
      }
    }
    this.autosaveTimer += dt;
    if (this.autosaveTimer > 60) {
      this.autosaveTimer = 0;
      this.save("autosave");
    }
  }
  private lastSamples = -1;

  private applyWeather(): void {
    const w = this.ms.state.weather.kind;
    if (w === this.weatherShown) return;
    this.weatherShown = w;
    const cover: Record<WeatherKind, number> = { SUNNY: 0.12, CLOUDY: 0.6, WIND: 0.3, FOG: 0.5, RAIN: 0.85, HEAVY_RAIN: 0.97 };
    this.scene.setClouds({ enabled: QUALITY !== "low", coverage: cover[w], density: w === "HEAVY_RAIN" ? 0.9 : 0.6 });
    this.scene.settings.surface.wetness = w === "RAIN" ? 0.5 : w === "HEAVY_RAIN" ? 0.9 : 0;
    if (w === "FOG") this.scene.setFog("exp2", { density: 0.009, color: new Color(0.7, 0.72, 0.74) });
    else if (w === "RAIN" || w === "HEAVY_RAIN") this.scene.setFog("exp2", { density: w === "HEAVY_RAIN" ? 0.0045 : 0.0022, color: new Color(0.5, 0.53, 0.56) });
    else this.scene.setFog("none");
  }

  /** HTML labels over blocks and machines, projected through the render camera. */
  private renderLabels(): void {
    const el = document.getElementById("labels")!;
    const sim = this.ms.sim;
    const parts: string[] = [];
    const cam = this.rig.camera;
    for (const b of sim.state.blocks) {
      const t = sim.terrain;
      const x = (t.cellX(b.rect.i0) + t.cellX(b.rect.i1)) / 2;
      const z = (t.cellZ(b.rect.j0) + t.cellZ(b.rect.j1)) / 2;
      const p = project(cam, this.canvas, x, t.heightAt(x, z) + 2, z);
      if (p && this.rig.distance < 520) parts.push(`<div class="lbl block ${this.selection?.kind === "block" && this.selection.id === b.id ? "sel" : ""}" style="transform:translate(${p.x.toFixed(0)}px,${p.y.toFixed(0)}px)">${b.id}</div>`);
    }
    for (const e of sim.state.equipment) {
      const pose = this.equipment.pose(e.id);
      if (!pose) continue;
      const sel = this.selection?.kind === "equipment" && this.selection.id === e.id;
      if (!sel && this.rig.distance > 260) continue;
      const p = project(cam, this.canvas, pose.x, pose.y + pose.height + 2, pose.z);
      if (!p) continue;
      const task = sim.task(e.currentTaskId);
      const warn = e.state === "BROKEN" || task?.status === "BLOCKED";
      parts.push(`<div class="lbl eq ${sel ? "sel" : ""} ${warn ? "warn" : ""}" style="transform:translate(${p.x.toFixed(0)}px,${p.y.toFixed(0)}px)">${e.name}${sel && task ? `<small>${task.note ?? task.blockedReason ?? task.label}</small>` : ""}</div>`);
    }
    const prompt = this.picking ? `<div class="pick-prompt">${this.pickPrompt}</div>` : "";
    el.innerHTML = parts.join("") + prompt;
  }
  private pickPrompt = "";

  // ---------------------------------------------------------------- input

  private bindInput(): void {
    this.canvas.addEventListener("click", (e) => {
      if (this.rig.dragged) return;
      this.click(e.clientX, e.clientY);
    });
    this.canvas.addEventListener("pointermove", (e) => {
      if (e.buttons) return;
      const ray = screenRay(this.rig.camera, this.canvas, e.clientX, e.clientY);
      const p = rayTerrain(ray, this.ms.sim.terrain);
      if (!p) {
        this.hoverBlock = null;
        return;
      }
      const { i, j } = this.ms.sim.terrain.cellOf(p.x, p.z);
      this.hoverBlock = blockAt(this.ms.sim, i, j)?.id ?? null;
      this.canvas.style.cursor = this.picking ? "crosshair" : this.hoverBlock ? "pointer" : "";
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.picking) {
        this.picking.resolve(null);
        this.picking = null;
      }
    });
  }

  private click(cx: number, cy: number): void {
    const sim = this.ms.sim;
    const ray = screenRay(this.rig.camera, this.canvas, cx, cy);
    const ground = rayTerrain(ray, sim.terrain);
    if (this.picking) {
      if (ground) {
        this.picking.resolve({ x: ground.x, z: ground.z });
        this.picking = null;
      }
      return;
    }
    // Machines first (nearest hit along the ray), then blocks, then bare ground.
    let best: { id: string; t: number } | null = null;
    for (const id of this.equipment.ids()) {
      const p = this.equipment.pose(id)!;
      const t = raySphere(ray, p.x, p.y + p.height * 0.45, p.z, Math.max(3.5, p.radius * 0.6));
      if (t !== null && (!best || t < best.t)) best = { id, t };
    }
    if (best) {
      this.select({ kind: "equipment", id: best.id });
      return;
    }
    if (!ground) {
      this.select(null);
      return;
    }
    const { i, j } = sim.terrain.cellOf(ground.x, ground.z);
    const b = blockAt(sim, i, j);
    this.select(b ? { kind: "block", id: b.id } : { kind: "point", x: ground.x, z: ground.z });
  }

  // ---------------------------------------------------------------- GameApi

  select(s: Selection, focus = false): void {
    this.selection = s;
    if (focus && s?.kind === "equipment") {
      const p = this.equipment.pose(s.id);
      if (p) this.rig.centerOn(p.x, p.z, Math.min(this.rig.distance, 120));
    } else if (focus && s?.kind === "block") {
      const b = this.ms.sim.block(s.id);
      if (b) {
        const t = this.ms.sim.terrain;
        this.rig.centerOn((t.cellX(b.rect.i0) + t.cellX(b.rect.i1)) / 2, (t.cellZ(b.rect.j0) + t.cellZ(b.rect.j1)) / 2, Math.min(this.rig.distance, 160));
      }
    }
    if (this.rig.mode === "FOLLOW" && s?.kind !== "equipment") this.rig.mode = "FREE";
    this.ui?.render();
  }

  setSpeed(speed: number): void {
    this.ms.sim.clock.setSpeed(speed);
  }
  speed(): number {
    return this.ms.sim.clock.state.speed;
  }
  setOverlay(o: Overlay): void {
    this.terrain.setOverlay(o);
  }
  overlay(): Overlay {
    return this.terrain.overlay;
  }
  setCameraMode(m: CameraMode): void {
    this.rig.setMode(m);
  }
  cameraMode(): CameraMode {
    return this.rig.mode;
  }
  pickPoint(prompt: string): Promise<{ x: number; z: number } | null> {
    this.picking?.resolve(null);
    this.pickPrompt = prompt;
    return new Promise((resolve) => {
      this.picking = { resolve };
    });
  }
  setMarker(p: { x: number; z: number } | null): void {
    this.marker = p;
  }
  terrainChanged(): void {
    this.terrain.refreshOverlay();
  }

  save(slot: string): string | null {
    try {
      localStorage.setItem(`black-creek:${slot}`, serialize(this.ms.sim.sync(), slot, new Date()));
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  load(slot: string): string | null {
    let json: string | null = null;
    try {
      json = localStorage.getItem(`black-creek:${slot}`);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    if (!json) return `Nothing saved in ${slot}`;
    return this.importSave(json);
  }

  exportSave(): string {
    return serialize(this.ms.sim.sync(), `day-${this.ms.sim.day}`, new Date());
  }

  importSave(json: string): string | null {
    try {
      const { state } = deserialize(json);
      const speed = this.speed();
      this.start(new MineSimulation(state, catalog));
      this.setSpeed(speed);
      this.ms.sim.notify("good", "Game loaded", `${state.mineName}, ${this.ms.sim.clock.format()}`);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  newGame(seed?: number): void {
    this.start(new MineSimulation(loadScenario(SCENARIOS[DEFAULT_SCENARIO]!, catalog, seed === undefined ? {} : { seed }), catalog));
  }

  /** Screen position (CSS px) of a ground point — for tests and tutorials. */
  screenPoint(x: number, z: number): { x: number; y: number } | null {
    return project(this.rig.camera, this.canvas, x, this.ms.sim.terrain.heightAt(x, z) + 0.5, z);
  }

  stats() {
    const st = this.engine.stats();
    return { fps: this.fps, ticksPerSecond: this.tps, drawCalls: st.drawCalls, chunksPending: this.terrain.pending, gpu: st.lastError ? `gpu error: ${st.lastError}` : `gpu errors ${st.gpuErrors}` };
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const status = document.getElementById("boot")!;
  if (!("gpu" in navigator)) {
    status.innerHTML = `<h1>Black Creek</h1><p>This game needs WebGPU (recent Chrome, Edge or Safari).</p>`;
    return;
  }
  let engine: Engine;
  try {
    engine = await Engine.create({ canvas, quality: "high", logLevel: "warn" });
  } catch (e) {
    status.innerHTML = `<h1>Black Creek</h1><p>Could not start the renderer: ${String(e)}</p>`;
    return;
  }
  const game = new Game(engine, canvas);
  let ms: MineSimulation | null = null;
  if (params.get("new") !== "1") {
    try {
      const saved = localStorage.getItem(AUTOSAVE_KEY);
      if (saved) ms = new MineSimulation(deserialize(saved).state, catalog);
    } catch {
      ms = null;
    }
  }
  const seed = params.get("seed");
  ms ??= new MineSimulation(loadScenario(SCENARIOS[DEFAULT_SCENARIO]!, catalog, seed ? { seed: Number(seed) } : {}), catalog);
  game.start(ms);
  if (params.get("speed")) game.setSpeed(Number(params.get("speed")));
  status.remove();
  engine.start();
  (window as unknown as { blackCreek: unknown }).blackCreek = { game, engine };
}

void main();
