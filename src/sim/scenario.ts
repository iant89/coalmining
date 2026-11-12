/**
 * Scenarios (spec §54) are data: map, geology, land, permits, infrastructure, fleet, workforce,
 * finances and customers. `loadScenario` turns a definition into a fresh `SimState`; nothing about
 * a particular mine is hard-coded in simulation code.
 */
import { valueNoise, Rng } from "./core/rng.js";
import { SimClock } from "./core/clock.js";
import { Terrain, type CellRect } from "./world/terrain.js";
import { createGeology, type GeologyParams, type GeoSample } from "./world/geology.js";
import { Sim } from "./sim.js";
import type { Catalog } from "./equipment/catalog.js";
import type {
  Customer,
  Employee,
  EquipmentInstance,
  Facility,
  Permit,
  PermitCategory,
  PermitStatus,
  SimState,
  SkillKey,
  WorkerRole,
} from "./state.js";
import { emptyDay } from "./simulation.js";
import { rasterizeRoads } from "./logistics/navigation.js";
import { SLICE_OBJECTIVES } from "./objectives.js";
import { generateCandidate } from "./workforce/workforce.js";
import blackCreek from "../data/scenarios/black_creek.json" with { type: "json" };

export const SAVE_VERSION = 2;

interface WorldRect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface ScenarioDefinition {
  id: string;
  name: string;
  mineName: string;
  description: string;
  seed: number;
  startHour: number;
  map: { cols: number; rows: number; cellSize: number; baseElevation: number; relief: number; reliefScale: number; slopeX: number };
  geology: Omit<GeologyParams, "seed">;
  legacySamples: { x: number; z: number; error: number; reliability: number; note: string }[];
  shift: SimState["shift"];
  cash: number;
  debt: number;
  creditLimit: number;
  fuelPricePerL: number;
  overheadPerDay: number;
  laborBurden: number;
  parcels: {
    id: string;
    name: string;
    area: WorldRect;
    surfaceOwner: string;
    mineralOwner: string;
    status: string;
    surfaceRights: boolean;
    mineralRights: boolean;
    royalty: number;
  }[];
  permits: {
    id: string;
    type: string;
    name: string;
    status: string;
    approvalDay: number | null;
    expirationDay: number | null;
    area: WorldRect | null;
    conditions: string[];
    renewalCost: number;
    reviewDays: number;
  }[];
  roads: { nodes: { id: string; x: number; z: number }[]; edges: { a: string; b: string; speedLimitKmh: number; width: number; condition: number }[] };
  facilities: Facility[];
  dumps: { id: string; name: string; accepts: "SPOIL" | "TOPSOIL"; area: WorldRect; maxHeight: number }[];
  stockpiles: { id: string; name: string; x: number; z: number; materialType: string; capacityT: number }[];
  blocks: { id: string; name: string; area: WorldRect }[];
  equipment: { defId: string; name: string; x: number; z: number; heading: number; condition: number; hours: number; hoursSinceService: number; fuelPct: number; operator: string | null }[];
  workers: {
    id: string;
    name: string;
    age: number;
    role: string;
    experienceYears: number;
    wagePerHour: number;
    skill: number;
    safety: number;
    certifications: (string | { type: string; expiresDay: number | null })[];
    note?: string;
  }[];
  customers: Omit<Customer, "price" | "takenTodayT">[];
}

export const SCENARIOS: Record<string, ScenarioDefinition> = {
  [blackCreek.id]: blackCreek as ScenarioDefinition,
};

export const DEFAULT_SCENARIO = blackCreek.id;

function toRect(t: Terrain, r: WorldRect): CellRect {
  const a = t.cellOf(r.x0 + 0.01, r.z0 + 0.01);
  const b = t.cellOf(r.x1 - 0.01, r.z1 - 0.01);
  return { i0: a.i, j0: a.j, i1: b.i, j1: b.j };
}

export function newEquipment(id: string, defId: string, name: string, x: number, z: number, heading: number, fuelL: number): EquipmentInstance {
  return {
    id,
    defId,
    name,
    state: "PARKED",
    condition: 100,
    operatingHours: 0,
    hoursSinceService: 0,
    fuelL,
    x,
    z,
    heading,
    prevX: x,
    prevZ: z,
    prevHeading: heading,
    speed: 0,
    route: null,
    routeIndex: 0,
    payload: null,
    currentTaskId: null,
    operatorId: null,
    upgrades: [],
    breakdown: null,
    evacuating: false,
    activity: "idle",
    stats: { workingMin: 0, idleMin: 0, downMin: 0, tonnesMoved: 0, loads: 0 },
    purchasedDay: 0,
  };
}

export function loadScenario(def: ScenarioDefinition, catalog: Catalog, overrides: { seed?: number } = {}): SimState {
  const seed = overrides.seed ?? def.seed;
  const m = def.map;
  const terrain = Terrain.create(m.cols, m.rows, m.cellSize, -(m.cols * m.cellSize) / 2, -(m.rows * m.cellSize) / 2);
  for (let j = 0; j < m.rows; j++) {
    for (let i = 0; i < m.cols; i++) {
      const x = terrain.cellX(i);
      const z = terrain.cellZ(j);
      const h = m.baseElevation + m.relief * (valueNoise(seed + 3, x, z, m.reliefScale, 4) - 0.5) * 2 + m.slopeX * x;
      const k = terrain.index(i, j);
      terrain.state.surface[k] = h;
      terrain.state.original[k] = h;
    }
  }
  const geology = createGeology(terrain, { ...def.geology, seed });
  const clock = SimClock.create(def.startHour);
  const rng = new Rng(seed ^ 0x9e3779b9);

  const state: SimState = {
    saveVersion: SAVE_VERSION,
    scenarioId: def.id,
    mineName: def.mineName,
    seed,
    clock: clock.state,
    rngState: rng.state,
    idCounters: {},
    terrain: terrain.state,
    geology,
    samples: [],
    seamDiscovered: false,
    blocks: def.blocks.map((b) => ({
      id: b.id,
      name: b.name,
      rect: toRect(terrain, b.area),
      state: "UNMINED",
      patternId: null,
      blastId: null,
      fragmentation: null,
      overburdenMovedT: 0,
      coalMinedT: 0,
      coalLostT: 0,
      topsoilSalvagedT: 0,
    })),
    drillPatterns: [],
    blasts: [],
    roadNodes: def.roads.nodes.map((n) => ({ ...n })),
    roadEdges: def.roads.edges.map((e, i) => ({ id: `road-${i + 1}`, a: e.a, b: e.b, condition: e.condition, speedLimitKmh: e.speedLimitKmh, width: e.width, traffic: 0 })),
    facilities: def.facilities.map((f) => ({ ...f })),
    dumps: def.dumps.map((d) => ({ id: d.id, name: d.name, rect: toRect(terrain, d.area), accepts: d.accepts, maxHeight: d.maxHeight, tonnes: 0 })),
    stockpiles: def.stockpiles.map((s) => ({ id: s.id, name: s.name, x: s.x, z: s.z, materialType: s.materialType as "COAL_RAW", capacityT: s.capacityT, tonnes: 0, quality: null, inT: 0, outT: 0 })),
    projects: [],
    hoppers: [],
    conveyors: [],
    equipment: [],
    workers: [],
    candidates: [],
    tasks: [],
    treasury: { cash: def.cash, debt: def.debt, creditLimit: def.creditLimit, ledger: [] },
    customers: def.customers.map((c) => ({ ...c, price: c.basePrice, takenTodayT: 0 })),
    fuelPricePerL: def.fuelPricePerL,
    overheadPerDay: def.overheadPerDay,
    laborBurden: def.laborBurden,
    parcels: def.parcels.map((p) => ({
      id: p.id,
      name: p.name,
      rect: toRect(terrain, p.area),
      surfaceOwner: p.surfaceOwner,
      mineralOwner: p.mineralOwner,
      status: p.status as "LEASED",
      surfaceRights: p.surfaceRights,
      mineralRights: p.mineralRights,
      royalty: p.royalty,
    })),
    permits: def.permits.map(
      (p): Permit => ({
        id: p.id,
        type: p.type as PermitCategory,
        name: p.name,
        status: p.status as PermitStatus,
        applicationDay: null,
        approvalDay: p.approvalDay,
        expirationDay: p.expirationDay,
        area: p.area ? toRect(terrain, p.area) : null,
        conditions: p.conditions,
        renewalCost: p.renewalCost,
        reviewDays: p.reviewDays,
      }),
    ),
    weather: { kind: "SUNNY", sinceMinute: 0, rain24h: 0 },
    shift: { ...def.shift },
    blastHold: null,
    incidents: [],
    notifications: [],
    today: emptyDay(clock.day),
    history: [],
    settings: { autoFuel: true, autoMaintenance: true, autoGrade: true, debug: false, coalDestination: null },
    objectives: SLICE_OBJECTIVES.map((o) => ({ id: o.id, title: o.title, done: false })),
  };

  const sim = new Sim(state, catalog);
  // Scenario-numbered roads: start generated road ids after them.
  state.idCounters.road = state.roadEdges.length;
  rasterizeRoads(sim);

  for (const w of def.workers) {
    const s = w.skill;
    const skills: Record<SkillKey, number> = {
      equipmentOperation: s,
      safety: w.safety,
      maintenance: w.role === "MECHANIC" ? s : s * 0.4,
      mining: s * 0.9,
      driving: Math.min(1, s + 0.05),
      drilling: w.certifications.some((c) => (typeof c === "string" ? c : c.type) === "DRILL") ? s : s * 0.3,
      blasting: w.certifications.some((c) => (typeof c === "string" ? c : c.type) === "BLASTER") ? s : 0.1,
      leadership: Math.min(1, w.experienceYears / 35),
    };
    const e: Employee = {
      id: w.id,
      name: w.name,
      age: w.age,
      role: w.role as WorkerRole,
      skills,
      experienceYears: w.experienceYears,
      safetyRating: w.safety,
      reliability: 0.85,
      fatigue: 5,
      morale: 72,
      wagePerHour: w.wagePerHour,
      certifications: w.certifications.map((c) => (typeof c === "string" ? { type: c, expiresDay: null } : { type: c.type, expiresDay: c.expiresDay })),
      assignedEquipmentId: null,
      employmentStatus: "ACTIVE",
      activity: "idle",
      hoursToday: 0,
      totalHours: 0,
      hiredDay: 0,
    };
    state.workers.push(e);
  }

  for (const e of def.equipment) {
    const d = catalog.def(e.defId);
    const eq = newEquipment(sim.nextId("eq"), e.defId, e.name, e.x, e.z, e.heading, d.fuelCapacityL * e.fuelPct);
    eq.condition = e.condition;
    eq.operatingHours = e.hours;
    eq.hoursSinceService = e.hoursSinceService;
    eq.operatorId = e.operator;
    state.equipment.push(eq);
    const w = state.workers.find((x) => x.id === e.operator);
    if (w) w.assignedEquipmentId = eq.id;
  }

  // Grandfather's notes: two old holes, measured against the true seam with an error he never knew.
  for (const s of def.legacySamples) {
    const { i, j } = terrain.cellOf(s.x, s.z);
    const k = terrain.index(i, j);
    const collar = terrain.state.surface[k]!;
    const roof = collar - geology.seamTop[k]! + rng.range(-s.error, s.error);
    const thick = geology.seamTop[k]! - geology.seamBottom[k]!;
    const sample: GeoSample = {
      id: sim.nextId("hole"),
      kind: "LEGACY",
      x: s.x,
      z: s.z,
      depth: roof + thick + 0.5,
      seamDepth: Math.max(0.5, roof),
      thickness: thick > 0.05 ? Math.max(0.3, thick + rng.range(-s.error, s.error) * 0.5) : null,
      quality: null,
      analysisDueMinute: null,
      reliability: s.reliability,
      collarElevation: collar,
      minute: 0,
      log: [],
    };
    state.samples.push(sample);
  }

  for (let n = 0; n < 4; n++) state.candidates.push(generateCandidate(sim, n === 3 ? "BLASTER" : "OPERATOR"));
  sim.sync();
  state.rngState = sim.rng.state;
  sim.notify("info", `Welcome to ${def.mineName}`, def.description);
  return state;
}
