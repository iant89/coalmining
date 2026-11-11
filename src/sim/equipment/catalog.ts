/**
 * Data-driven equipment (spec §52): every machine's specification comes from a JSON definition in
 * src/data/equipment. Adding a machine is adding a file and listing it here; no simulation code
 * changes. Upgrades (spec §8) are data too and act only through named stat multipliers.
 */
import type { EquipmentCategory, WorkerRole } from "../state.js";
import rh60 from "../../data/equipment/ridgeline_rh60.json" with { type: "json" };
import rh90 from "../../data/equipment/ridgeline_rh90.json" with { type: "json" };
import hx350 from "../../data/equipment/hartmann_hx350.json" with { type: "json" };
import pd45 from "../../data/equipment/penrose_pd45.json" with { type: "json" };
import dz9 from "../../data/equipment/ironback_dz9.json" with { type: "json" };
import upgradesJson from "../../data/equipment/upgrades.json" with { type: "json" };

export interface EquipmentDefinition {
  id: string;
  manufacturer: string;
  model: string;
  name: string;
  category: EquipmentCategory;
  tier: number;
  purchasePrice: number;
  horsepower: number;
  fuelCapacityL: number;
  fuelBurnLph: { idle: number; working: number };
  maxSpeedKmh: number;
  loadedSpeedFactor: number;
  operatingCostPerHour: number;
  maintenanceIntervalH: number;
  maintenanceCost: number;
  maintenanceHours: number;
  expectedLifetimeH: number;
  /** Condition points lost per operating hour under nominal conditions. */
  wearPerHour: number;
  requiredRole: WorkerRole;
  requiredCertification: string | null;
  payloadT?: number;
  bodyM3?: number;
  dumpMinutes?: number;
  bucketM3?: number;
  cycleSeconds?: number;
  penetrationMph?: number;
  coreMph?: number;
  maxHoleDepthM?: number;
  holeSetupMin?: number;
  stripRateM3h?: number;
  availableUpgrades: string[];
  size: { length: number; width: number; height: number };
  color: string;
}

export type UpgradeStat =
  | "fuelBurn"
  | "speed"
  | "gradeability"
  | "wear"
  | "payload"
  | "coalPayload"
  | "roadWear"
  | "breakdownHazard"
  | "roughDig"
  | "bucket";

export interface UpgradeDefinition {
  id: string;
  slot: "ENGINE" | "BODY" | "TIRES" | "ELECTRONICS" | "AUTOMATION";
  name: string;
  description: string;
  price: number;
  categories: EquipmentCategory[];
  modifiers: Partial<Record<UpgradeStat, number>>;
}

export class Catalog {
  readonly equipment = new Map<string, EquipmentDefinition>();
  readonly upgrades = new Map<string, UpgradeDefinition>();

  constructor(defs: EquipmentDefinition[], upgrades: UpgradeDefinition[]) {
    for (const d of defs) {
      if (this.equipment.has(d.id)) throw new Error(`duplicate equipment definition ${d.id}`);
      this.equipment.set(d.id, d);
    }
    for (const u of upgrades) this.upgrades.set(u.id, u);
    for (const d of defs) {
      for (const u of d.availableUpgrades) if (!this.upgrades.has(u)) throw new Error(`${d.id}: unknown upgrade ${u}`);
    }
  }

  def(id: string): EquipmentDefinition {
    const d = this.equipment.get(id);
    if (!d) throw new Error(`unknown equipment definition "${id}"`);
    return d;
  }

  upgrade(id: string): UpgradeDefinition {
    const u = this.upgrades.get(id);
    if (!u) throw new Error(`unknown upgrade "${id}"`);
    return u;
  }

  /** Product of every installed upgrade's multiplier for `stat` (1 when none apply). */
  modifier(upgrades: readonly string[], stat: UpgradeStat): number {
    let m = 1;
    for (const id of upgrades) m *= this.upgrades.get(id)?.modifiers[stat] ?? 1;
    return m;
  }
}

export function defaultCatalog(): Catalog {
  return new Catalog(
    [rh60, rh90, hx350, pd45, dz9] as EquipmentDefinition[],
    upgradesJson as UpgradeDefinition[],
  );
}
