/**
 * All mutable simulation state, as plain data (spec §55). Services are functions over `SimState`;
 * nothing here references the renderer, and everything here round-trips through the save format.
 * Engine entities (meshes, transforms) live in src/game and are rebuilt from this state.
 */
import type { ClockState } from "./core/clock.js";
import type { CoalQuality, MaterialParcel, MaterialType } from "./world/materials.js";
import type { CellRect, TerrainState } from "./world/terrain.js";
import type { GeoSample, GeologyState } from "./world/geology.js";

// ------------------------------------------------------------------ equipment

export type EquipmentCategory = "EXCAVATOR" | "HAUL_TRUCK" | "DRILL" | "DOZER" | "LOADER" | "WATER_TRUCK" | "GRADER" | "SERVICE_TRUCK" | "LUBE_TRUCK";

export type EquipmentStateName =
  | "PARKED"
  | "AVAILABLE"
  | "ASSIGNED"
  | "TRAVELING"
  | "WAITING"
  | "LOADING"
  | "HAULING"
  | "UNLOADING"
  | "WORKING"
  | "FUELING"
  | "MAINTENANCE"
  | "BROKEN"
  | "DISABLED";

export interface Waypoint {
  x: number;
  z: number;
  /** Speed limit on the leg that ends here, m/s. */
  limit: number;
  /** Road edge this leg runs on, or null off-road. */
  edgeId: string | null;
}

export interface EquipmentInstance {
  id: string;
  defId: string;
  name: string;
  state: EquipmentStateName;
  /** 0…100 (spec §9). */
  condition: number;
  operatingHours: number;
  hoursSinceService: number;
  fuelL: number;
  x: number;
  z: number;
  heading: number;
  /** Pose at the start of the current tick, for render interpolation. */
  prevX: number;
  prevZ: number;
  prevHeading: number;
  /** Current speed, m/s (presentation reads it for wheel spin and dust). */
  speed: number;
  route: Waypoint[] | null;
  routeIndex: number;
  payload: MaterialParcel | null;
  currentTaskId: string | null;
  /** Persistent operator assignment (spec §10 assignedEquipment ↔ currentOperator). */
  operatorId: string | null;
  upgrades: string[];
  breakdown: { cause: string; minute: number } | null;
  /** Moving out of (or holding outside) a blast exclusion zone; the task executor is suspended. */
  evacuating: boolean;
  /** A lube or service truck is working on this machine: its own task waits. */
  serviceHold: { by: string; reason: string } | null;
  /** Lube trucks: diesel carried for refuelling other machines, L. */
  cargoFuelL: number;
  /** Operating hours since the lube truck last greased it; dry pins and bushings wear faster. */
  hoursSinceGrease: number;
  /** Presentation hints written by executors: what the machine is visibly doing. */
  activity: "idle" | "drive" | "dig" | "swing" | "dump" | "drill" | "push" | "fuel" | "service" | "broken";
  stats: { workingMin: number; idleMin: number; downMin: number; tonnesMoved: number; loads: number };
  purchasedDay: number;
}

// ------------------------------------------------------------------ workforce

export type WorkerRole =
  | "OPERATOR"
  | "DRILL_OPERATOR"
  | "BLASTER"
  | "MECHANIC"
  | "ELECTRICIAN"
  | "PLANT_OPERATOR"
  | "SURVEYOR"
  | "SAFETY_MANAGER"
  | "FOREMAN"
  | "DISPATCHER";

export type SkillKey = "equipmentOperation" | "safety" | "maintenance" | "mining" | "driving" | "drilling" | "blasting" | "leadership";

export interface Certification {
  type: string;
  /** Day the certification lapses, or null for no expiry. */
  expiresDay: number | null;
}

export interface Employee {
  id: string;
  name: string;
  age: number;
  role: WorkerRole;
  /** 0…1 per skill. */
  skills: Record<SkillKey, number>;
  experienceYears: number;
  /** 0…1. */
  safetyRating: number;
  reliability: number;
  /** 0…100. */
  fatigue: number;
  /** 0…100. */
  morale: number;
  wagePerHour: number;
  certifications: Certification[];
  assignedEquipmentId: string | null;
  employmentStatus: "ACTIVE" | "ON_LEAVE" | "TERMINATED";
  /** What the worker is doing right now, derived each tick. */
  activity: "off-shift" | "idle" | "operating" | "blasting" | "repairing";
  hoursToday: number;
  totalHours: number;
  hiredDay: number;
}

// ------------------------------------------------------------------ tasks

export type TaskType =
  | "MOVE"
  | "PARK"
  | "EXPLORE_DRILL"
  | "DRILL_PATTERN"
  | "BLAST"
  | "STRIP_TOPSOIL"
  | "EXCAVATE"
  | "HAUL"
  | "FUEL"
  | "MAINTENANCE"
  | "REPAIR"
  | "CONSTRUCT"
  | "GRADE_ROAD"
  | "FIELD_FUEL"
  | "SERVICE_CALL";

export type TaskStatus =
  | "CREATED"
  | "VALIDATING"
  | "QUEUED"
  | "ASSIGNED"
  | "TRAVELING"
  | "EXECUTING"
  | "BLOCKED"
  | "RESOLVING"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

export type TaskPriority = "EMERGENCY" | "CRITICAL" | "HIGH" | "NORMAL" | "LOW";

export type TaskTarget =
  | { kind: "point"; x: number; z: number }
  | { kind: "block"; id: string }
  | { kind: "task"; id: string }
  | { kind: "stockpile"; id: string }
  | { kind: "dump"; id: string }
  | { kind: "facility"; id: string }
  | { kind: "equipment"; id: string }
  | { kind: "road"; id: string }
  | { kind: "project"; id: string }
  | { kind: "conveyor"; id: string }
  | { kind: "hopper"; id: string };

export type ExcavateMode = "OVERBURDEN" | "COAL";

export interface TaskParams {
  /** EXCAVATE: what to dig. */
  mode?: ExcavateMode;
  /** HAUL: where each haul class goes. */
  spoilDumpId?: string;
  coalStockpileId?: string;
  /** HAUL: deliver coal to this conveyor hopper instead of a stockpile. */
  coalHopperId?: string;
  topsoilDumpId?: string;
  /** DRILL_PATTERN / BLAST: the pattern / blast record. */
  patternId?: string;
  blastId?: string;
  /** EXPLORE_DRILL: target depth. */
  depth?: number;
  /** SERVICE_CALL: what the mechanic does on arrival. */
  service?: "REPAIR" | "PM";
}

export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  label: string;
  source: TaskTarget | null;
  destination: TaskTarget | null;
  requiredEquipmentCategory: EquipmentCategory | null;
  assignedEquipmentId: string | null;
  /** The player picked this machine; dispatch must not swap it. */
  equipmentLocked: boolean;
  requiredWorkerRole: WorkerRole | null;
  requiredCertification: string | null;
  assignedWorkerId: string | null;
  workerLocked: boolean;
  prerequisites: string[];
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  /** Minutes, refreshed by the executor. */
  estimatedDuration: number | null;
  progress: number;
  materialType: MaterialType | null;
  /** Target tonnes (EXCAVATE) or tonnes moved so far (HAUL), see executors. */
  materialAmount: number;
  failureReason: string | null;
  blockedReason: string | null;
  /** Last block reason the player was told about (suppresses repeats while a block persists). */
  lastBlockReason: string | null;
  /** Non-blocking status line for the UI ("Waiting for haul truck"). */
  note: string | null;
  /** Status to return to when a block resolves. */
  resumeStatus: TaskStatus | null;
  params: TaskParams;
  /** Executor sub-state ("to-loader", "wait-load", "dig", …) and its timer (minutes). */
  phase: string;
  phaseTimer: number;
  /** Executor scratch values that must survive a save (target cell index, hole index …). */
  scratch: Record<string, number>;
  /** The crew whose foreman issued this task: only that crew's machines and people work it. */
  crewId: string | null;
}

// ------------------------------------------------------------------ mining

export type BlockState =
  | "UNMINED"
  | "PREPARING"
  | "DRILLING"
  | "BLAST_READY"
  | "BLASTED"
  | "EXCAVATING"
  | "COAL_EXPOSED"
  | "COAL_MINING"
  | "COMPLETE"
  | "RECLAIMING"
  | "RECLAIMED";

export interface MiningBlock {
  id: string;
  name: string;
  rect: CellRect;
  state: BlockState;
  patternId: string | null;
  blastId: string | null;
  /** Fragmentation of the last blast (0 poor … 1 excellent), or null if never blasted. */
  fragmentation: number | null;
  overburdenMovedT: number;
  coalMinedT: number;
  coalLostT: number;
  topsoilSalvagedT: number;
}

export type DrillDepthMode = "FIXED" | "TO_COAL";

export interface DrillHole {
  x: number;
  z: number;
  i: number;
  j: number;
  designDepth: number;
  drilled: boolean;
  /** Actual depth reached. */
  depth: number;
  /** In-situ ground elevation at the collar when drilled. */
  collar: number;
  /** Depth at which the driller logged coal, if the hole hit it. */
  coalAt: number | null;
}

export interface DrillPattern {
  id: string;
  blockId: string;
  spacing: number;
  burden: number;
  depthMode: DrillDepthMode;
  /** FIXED: hole depth; TO_COAL: standoff above the estimated roof. */
  depth: number;
  subdrill: number;
  holes: DrillHole[];
  createdAt: number;
  completedAt: number | null;
}

export type BlastState = "PLANNED" | "REVIEW" | "APPROVED" | "READY" | "EXECUTING" | "COMPLETED" | "FAILED";

export interface Blast {
  id: string;
  blockId: string;
  patternId: string;
  /** Abstract charge level, 0.6 (light) … 1.4 (heavy). Not an engineering quantity (spec §17). */
  chargeFactor: number;
  holeCount: number;
  estimatedVolumeM3: number;
  estimatedTonnes: number;
  /** 0…1. */
  fragmentation: number;
  vibrationRisk: number;
  airblastRisk: number;
  flyrockRisk: number;
  /** Estimated coal tonnes damaged by holes that went into the seam. */
  coalDamageEstimateT: number;
  cost: number;
  state: BlastState;
  executedAt: number | null;
}

// ------------------------------------------------------------------ logistics / infrastructure

export interface RoadNode {
  id: string;
  x: number;
  z: number;
}

export interface RoadEdge {
  id: string;
  a: string;
  b: string;
  /** 0…100. */
  condition: number;
  speedLimitKmh: number;
  width: number;
  traffic: number;
}

export type FacilityType = "OFFICE" | "SHOP" | "FUEL" | "PARKING" | "LOADOUT";

export interface Facility {
  id: string;
  type: FacilityType;
  name: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  rotation: number;
}

export interface DumpArea {
  id: string;
  name: string;
  rect: CellRect;
  accepts: "SPOIL" | "TOPSOIL";
  /** Max placed height above the pre-mining surface. */
  maxHeight: number;
  /** Placed tonnes so far. */
  tonnes: number;
}

export interface Stockpile {
  id: string;
  name: string;
  x: number;
  z: number;
  materialType: MaterialType;
  capacityT: number;
  tonnes: number;
  quality: CoalQuality | null;
  inT: number;
  outT: number;
}

// ------------------------------------------------------------------ construction & conveyors

export type ConstructionType = "HAUL_ROAD" | "CONVEYOR" | "STOCKPILE";
export type ProjectStatus = "PLANNED" | "IN_PROGRESS" | "COMPLETE" | "CANCELLED";

export interface ConstructionProject {
  id: string;
  type: ConstructionType;
  name: string;
  status: ProjectStatus;
  /** HAUL_ROAD: [start, end]; CONVEYOR: [hopper, discharge]; STOCKPILE: [site]. */
  path: { x: number; z: number }[];
  /** HAUL_ROAD: existing road node the road starts / ends at, if it snapped to one. */
  startNodeId: string | null;
  endNodeId: string | null;
  /** 0…1 of the work done. */
  progress: number;
  /** Total cost, and what has been spent so far (paid as the work is done). */
  cost: number;
  spent: number;
  /** Work-minutes the project needs at nominal rate. */
  workMinutes: number;
  /** CONVEYOR: belt capacity (t/h) and the stockpile it feeds (null = build a new one at the end). */
  capacityTph: number | null;
  stockpileId: string | null;
  /** STOCKPILE: capacity (t). */
  capacityT: number | null;
  /** HAUL_ROAD: elevation profile ends, fixed at planning time so the graded road is what was shown. */
  startElevation: number | null;
  endElevation: number | null;
  createdAt: number;
  completedAt: number | null;
}

export interface Hopper {
  id: string;
  name: string;
  x: number;
  z: number;
  capacityT: number;
  tonnes: number;
  quality: CoalQuality | null;
  conveyorId: string;
}

export type ConveyorState = "OFFLINE" | "STARTING" | "RUNNING" | "JAMMED" | "MAINTENANCE" | "DAMAGED";

export interface Conveyor {
  id: string;
  name: string;
  hopperId: string;
  stockpileId: string;
  path: { x: number; z: number }[];
  length: number;
  /** Rated throughput, t/h. */
  capacityTph: number;
  /** Belt speed, m/s. */
  speed: number;
  powerKw: number;
  state: ConveyorState;
  /** The player switched it on; OFFLINE when false. */
  enabled: boolean;
  /** 0…100. */
  condition: number;
  operatingHours: number;
  /** Material on the belt in transit (sum of `slices`). */
  beltT: number;
  /** Plug flow: each tick's load rides the belt as one slice and discharges at `arriveAt` (minute). */
  slices: { tonnes: number; quality: CoalQuality | null; arriveAt: number }[];
  /** Minutes left in a start-up sequence. */
  startTimer: number;
  totalT: number;
  breakdown: { cause: string; minute: number } | null;
}

// ------------------------------------------------------------------ management (crews, foremen, meeting)

export type CrewOrderType = "REMOVE_OVERBURDEN" | "MINE_COAL" | "STRIP_TOPSOIL" | "EXPLORE_BLOCK" | "MAINTAIN_ROADS";

export interface CrewOrder {
  id: string;
  type: CrewOrderType;
  blockId: string | null;
  status: "PENDING" | "ACTIVE" | "DONE" | "STUCK";
  /** The foreman's latest word on it ("Waiting for the blast", "Excavator broken down"). */
  note: string | null;
  /** Tasks the foreman issued for this order. */
  taskIds: string[];
  /** Times the foreman has issued work for it without finishing (gives up as STUCK after a few). */
  attempts: number;
  issuedDay: number;
  doneDay: number | null;
}

/** A crew led by a foreman: the unit the player manages instead of individual machines. */
export interface Crew {
  id: string;
  name: string;
  foremanId: string | null;
  equipmentIds: string[];
  workerIds: string[];
  /** In priority order; standing orders (MAINTAIN_ROADS) never finish. */
  orders: CrewOrder[];
  /** Minute the foreman last looked over the work. */
  lastCheck: number;
  /** Tonnes moved by the crew's machines at the last meeting (for the daily report). */
  tonnesAtMeeting: number;
}

export interface CrewReport {
  crewId: string;
  crewName: string;
  foremanName: string | null;
  lines: { severity: "info" | "good" | "warn" | "critical"; text: string }[];
}

/** The morning meeting held at each shift start (the UI pauses for it). */
export interface MorningMeeting {
  day: number;
  minute: number;
  pending: boolean;
  reports: CrewReport[];
}

// ------------------------------------------------------------------ economy

export type ExpenseCategory =
  | "payroll"
  | "fuel"
  | "maintenance"
  | "repairs"
  | "explosives"
  | "drilling"
  | "operating"
  | "royalties"
  | "permits"
  | "equipment"
  | "upgrades"
  | "exploration"
  | "land"
  | "loans"
  | "fines"
  | "overhead"
  | "construction"
  | "electricity";
export type IncomeCategory = "coal sales" | "asset sales" | "other";

export interface Transaction {
  id: string;
  minute: number;
  amount: number;
  category: ExpenseCategory | IncomeCategory;
  memo: string;
}

export interface Treasury {
  cash: number;
  debt: number;
  creditLimit: number;
  ledger: Transaction[];
}

export interface Customer {
  id: string;
  name: string;
  type: "POWER_PLANT" | "INDUSTRIAL" | "PREMIUM";
  basePrice: number;
  /** Today's price per tonne before quality adjustment. */
  price: number;
  maxAsh: number;
  maxSulfur: number;
  minBtu: number;
  /** Tonnes the customer will take per day. */
  dailyDemandT: number;
  takenTodayT: number;
}

// ------------------------------------------------------------------ land / regulatory

export interface Parcel {
  id: string;
  name: string;
  rect: CellRect;
  surfaceOwner: string;
  mineralOwner: string;
  status: "UNKNOWN" | "OWNED" | "AVAILABLE" | "NEGOTIATING" | "LEASED" | "RESTRICTED";
  surfaceRights: boolean;
  mineralRights: boolean;
  /** Royalty on coal sold, fraction of revenue. */
  royalty: number;
}

export type PermitCategory =
  | "EXPLORATION"
  | "LAND_DISTURBANCE"
  | "SURFACE_MINING"
  | "BLASTING"
  | "PROCESSING"
  | "CONVEYOR"
  | "WATER"
  | "ROAD"
  | "EXPANSION"
  | "RECLAMATION";

export type PermitStatus =
  | "NOT_REQUIRED"
  | "REQUIRED"
  | "APPLICATION"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "CONDITIONALLY_APPROVED"
  | "DENIED"
  | "EXPIRED"
  | "SUSPENDED"
  | "REVOKED";

export interface Permit {
  id: string;
  type: PermitCategory;
  name: string;
  status: PermitStatus;
  applicationDay: number | null;
  approvalDay: number | null;
  expirationDay: number | null;
  /** Area the permit covers (null = whole mine). */
  area: CellRect | null;
  conditions: string[];
  renewalCost: number;
  reviewDays: number;
}

// ------------------------------------------------------------------ environment / safety / feed

export type WeatherKind = "SUNNY" | "CLOUDY" | "RAIN" | "HEAVY_RAIN" | "FOG" | "WIND";

export interface WeatherState {
  kind: WeatherKind;
  sinceMinute: number;
  /** Rain in the last 24 h, mm (drives road softening). */
  rain24h: number;
}

export interface Incident {
  id: string;
  minute: number;
  equipmentId: string | null;
  workerId: string | null;
  title: string;
  description: string;
  contributors: string[];
  cost: number;
}

export interface Notification {
  id: string;
  minute: number;
  severity: "info" | "good" | "warn" | "critical";
  title: string;
  text: string;
  subject: { kind: "equipment" | "task" | "block" | "worker" | "stockpile"; id: string } | null;
}

export interface DayStats {
  day: number;
  overburdenT: number;
  topsoilT: number;
  coalMinedT: number;
  coalSoldT: number;
  revenue: number;
  expenses: Partial<Record<ExpenseCategory, number>>;
  fuelL: number;
  equipmentWorkingMin: number;
  equipmentIdleMin: number;
  equipmentDownMin: number;
  workerHours: number;
  incidents: number;
  drilledM: number;
  blasts: number;
}

export interface ShiftConfig {
  startHour: number;
  lengthHours: number;
  /** Blasting window (local hours). */
  blastStartHour: number;
  blastEndHour: number;
}

export interface SimState {
  saveVersion: number;
  scenarioId: string;
  mineName: string;
  seed: number;
  clock: ClockState;
  rngState: number;
  idCounters: Record<string, number>;
  terrain: TerrainState;
  geology: GeologyState;
  samples: GeoSample[];
  seamDiscovered: boolean;
  blocks: MiningBlock[];
  drillPatterns: DrillPattern[];
  blasts: Blast[];
  roadNodes: RoadNode[];
  roadEdges: RoadEdge[];
  facilities: Facility[];
  dumps: DumpArea[];
  stockpiles: Stockpile[];
  projects: ConstructionProject[];
  hoppers: Hopper[];
  conveyors: Conveyor[];
  crews: Crew[];
  meeting: MorningMeeting | null;
  equipment: EquipmentInstance[];
  workers: Employee[];
  candidates: Employee[];
  tasks: Task[];
  treasury: Treasury;
  customers: Customer[];
  fuelPricePerL: number;
  /** Insurance, admin, utilities, reclamation bond premium: charged hourly. */
  overheadPerDay: number;
  /** Benefits and payroll taxes on top of wages. */
  laborBurden: number;
  parcels: Parcel[];
  permits: Permit[];
  weather: WeatherState;
  shift: ShiftConfig;
  /** Active blast exclusion zone, while a blast is being cleared and fired. */
  blastHold: { taskId: string; blockId: string; x: number; z: number; radius: number } | null;
  incidents: Incident[];
  notifications: Notification[];
  today: DayStats;
  history: DayStats[];
  /** Behaviour switches. */
  settings: {
    autoFuel: boolean;
    autoMaintenance: boolean;
    /** Idle graders keep haul roads above the maintenance threshold (spec §11.2 MAINTAIN_ROAD). */
    autoGrade: boolean;
    debug: boolean;
    /** Where coal orders send coal: a stockpile id or a hopper id (null = first coal stockpile). */
    coalDestination: string | null;
    /** Hold a meeting with the foremen at every shift start. */
    morningMeeting: boolean;
  };
  /** Story / tutorial objective progress (spec §42 grows from here). */
  objectives: { id: string; title: string; done: boolean }[];
}
