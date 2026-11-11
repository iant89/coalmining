/**
 * Material as a first-class quantity (spec §20, §59). Material is never a particle: it is a tonnage
 * with a type and (for coal) a quality, moved between terrain, equipment, stockpiles and buyers.
 */
export type MaterialType = "TOPSOIL" | "OVERBURDEN" | "COAL_RAW" | "COAL_CLEAN" | "REFUSE" | "SPOIL";

/** In-situ geological material (spec §12). */
export type GeoMaterial = "TOPSOIL" | "SANDSTONE" | "SHALE" | "COAL" | "UNDERCLAY" | "SPOIL";

export interface CoalQuality {
  /** Ash, percent by mass. */
  ash: number;
  /** Sulfur, percent by mass. */
  sulfur: number;
  /** Total moisture, percent. */
  moisture: number;
  /** Gross calorific value, BTU/lb. */
  btu: number;
}

export interface MaterialParcel {
  type: MaterialType;
  tonnes: number;
  /** Only for coal. */
  quality: CoalQuality | null;
}

export interface GeoMaterialInfo {
  /** Bank (in-situ) density, t/m³. */
  bankDensity: number;
  /** Swell: loose volume / bank volume. */
  swell: number;
  /** 0 (soft) … 1 (very hard): drives drill penetration and unblasted dig resistance. */
  hardness: number;
  /** Must be fragmented by blasting before an excavator can dig it. */
  needsBlasting: boolean;
  /** What digging it produces. */
  yields: MaterialType;
  label: string;
}

export const GEO_MATERIALS: Record<GeoMaterial, GeoMaterialInfo> = {
  TOPSOIL: { bankDensity: 1.6, swell: 1.25, hardness: 0.05, needsBlasting: false, yields: "TOPSOIL", label: "Topsoil" },
  SANDSTONE: { bankDensity: 2.35, swell: 1.35, hardness: 0.75, needsBlasting: true, yields: "OVERBURDEN", label: "Sandstone" },
  SHALE: { bankDensity: 2.45, swell: 1.3, hardness: 0.5, needsBlasting: true, yields: "OVERBURDEN", label: "Shale" },
  COAL: { bankDensity: 1.35, swell: 1.3, hardness: 0.3, needsBlasting: false, yields: "COAL_RAW", label: "Coal" },
  UNDERCLAY: { bankDensity: 2.2, swell: 1.25, hardness: 0.4, needsBlasting: true, yields: "OVERBURDEN", label: "Underclay (seam floor)" },
  SPOIL: { bankDensity: 1.9, swell: 1.05, hardness: 0.1, needsBlasting: false, yields: "SPOIL", label: "Placed spoil" },
};

/** Density of material once placed in a dump or pile (t/m³ of placed volume). */
export const PLACED_DENSITY: Record<MaterialType, number> = {
  TOPSOIL: 1.35,
  OVERBURDEN: 1.9,
  SPOIL: 1.9,
  COAL_RAW: 0.95,
  COAL_CLEAN: 0.9,
  REFUSE: 1.6,
};

/** Loose density in a bucket or truck body (t/m³). */
export function looseDensity(m: GeoMaterial): number {
  const info = GEO_MATERIALS[m];
  return info.bankDensity / info.swell;
}

export function isCoal(type: MaterialType): boolean {
  return type === "COAL_RAW" || type === "COAL_CLEAN";
}

/** Where a haul destination accepts this material: overburden-like material goes to spoil. */
export function haulClass(type: MaterialType): "SPOIL" | "COAL" | "TOPSOIL" {
  if (isCoal(type)) return "COAL";
  if (type === "TOPSOIL") return "TOPSOIL";
  return "SPOIL";
}

/** Mass-weighted blend of two coal qualities. */
export function blendQuality(a: CoalQuality | null, aT: number, b: CoalQuality | null, bT: number): CoalQuality | null {
  if (!a || aT <= 0) return b ? { ...b } : null;
  if (!b || bT <= 0) return { ...a };
  const t = aT + bT;
  return {
    ash: (a.ash * aT + b.ash * bT) / t,
    sulfur: (a.sulfur * aT + b.sulfur * bT) / t,
    moisture: (a.moisture * aT + b.moisture * bT) / t,
    btu: (a.btu * aT + b.btu * bT) / t,
  };
}

/** Add `parcel` into `into` (same type family); returns the merged parcel. */
export function mergeParcel(into: MaterialParcel | null, parcel: MaterialParcel): MaterialParcel {
  if (!into || into.tonnes <= 0) return { type: parcel.type, tonnes: parcel.tonnes, quality: parcel.quality ? { ...parcel.quality } : null };
  // Mixed loads keep the "worst" type for routing: coal contaminated with rock is still overburden.
  const type = into.type === parcel.type ? into.type : isCoal(into.type) && isCoal(parcel.type) ? "COAL_RAW" : "OVERBURDEN";
  return { type, tonnes: into.tonnes + parcel.tonnes, quality: blendQuality(into.quality, into.tonnes, parcel.quality, parcel.tonnes) };
}

export const MATERIAL_LABEL: Record<MaterialType, string> = {
  TOPSOIL: "Topsoil",
  OVERBURDEN: "Overburden",
  COAL_RAW: "Raw coal",
  COAL_CLEAN: "Clean coal",
  REFUSE: "Refuse",
  SPOIL: "Spoil",
};
