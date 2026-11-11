/**
 * Weather (spec §40): an hourly Markov chain on the simulation RNG — deterministic for a seed,
 * varied across seeds. Effects are a table the other systems read; nothing else rolls weather dice.
 */
import type { Sim } from "../sim.js";
import type { WeatherKind } from "../state.js";

export interface WeatherEffect {
  label: string;
  /** Travel speed multiplier. */
  speed: number;
  /** Visibility, 0…1. */
  visibility: number;
  /** Road condition lost per hour from the weather alone. */
  roadDamage: number;
  rainMmPerHour: number;
  blastingAllowed: boolean;
  /** Added safety risk points. */
  risk: number;
}

const EFFECTS: Record<WeatherKind, WeatherEffect> = {
  SUNNY: { label: "Sunny", speed: 1, visibility: 1, roadDamage: -0.6, rainMmPerHour: 0, blastingAllowed: true, risk: 0 },
  CLOUDY: { label: "Cloudy", speed: 1, visibility: 0.95, roadDamage: -0.3, rainMmPerHour: 0, blastingAllowed: true, risk: 0 },
  WIND: { label: "Windy", speed: 0.97, visibility: 0.85, roadDamage: -0.4, rainMmPerHour: 0, blastingAllowed: true, risk: 3 },
  FOG: { label: "Fog", speed: 0.72, visibility: 0.35, roadDamage: 0, rainMmPerHour: 0, blastingAllowed: false, risk: 14 },
  RAIN: { label: "Rain", speed: 0.85, visibility: 0.7, roadDamage: 0.8, rainMmPerHour: 2.5, blastingAllowed: true, risk: 7 },
  HEAVY_RAIN: { label: "Heavy rain", speed: 0.66, visibility: 0.45, roadDamage: 2.2, rainMmPerHour: 9, blastingAllowed: false, risk: 16 },
};

const TRANSITIONS: Record<WeatherKind, [WeatherKind, number][]> = {
  SUNNY: [["SUNNY", 0.86], ["CLOUDY", 0.11], ["WIND", 0.03]],
  CLOUDY: [["CLOUDY", 0.7], ["SUNNY", 0.15], ["RAIN", 0.1], ["FOG", 0.03], ["WIND", 0.02]],
  WIND: [["WIND", 0.6], ["CLOUDY", 0.25], ["SUNNY", 0.15]],
  FOG: [["FOG", 0.6], ["CLOUDY", 0.3], ["SUNNY", 0.1]],
  RAIN: [["RAIN", 0.65], ["HEAVY_RAIN", 0.1], ["CLOUDY", 0.25]],
  HEAVY_RAIN: [["HEAVY_RAIN", 0.5], ["RAIN", 0.5]],
};

export function weatherEffects(kind: WeatherKind): WeatherEffect {
  return EFFECTS[kind];
}

export function setWeather(sim: Sim, kind: WeatherKind): void {
  if (sim.state.weather.kind === kind) return;
  sim.state.weather.kind = kind;
  sim.state.weather.sinceMinute = sim.minute;
  sim.bus.emit({ type: "WeatherChanged", weather: kind });
  if (kind === "HEAVY_RAIN" || kind === "FOG") {
    sim.notify("warn", `Weather: ${EFFECTS[kind].label}`, kind === "FOG" ? "Visibility is poor: haul speeds are down, blasting is suspended." : "Haul roads are softening; blasting is suspended until it eases.");
  }
}

/** Hourly weather and haul-road update. */
export function hourlyEnvironment(sim: Sim): void {
  const w = sim.state.weather;
  // Morning fog is likelier; roll against the transition row.
  const row = TRANSITIONS[w.kind];
  let roll = sim.rng.next();
  let next: WeatherKind = w.kind;
  for (const [k, p] of row) {
    if (roll < p) {
      next = k;
      break;
    }
    roll -= p;
  }
  setWeather(sim, next);
  const e = EFFECTS[w.kind];
  w.rain24h = Math.max(0, w.rain24h * (23 / 24) + e.rainMmPerHour);
  for (const edge of sim.state.roadEdges) {
    const trafficWear = edge.traffic * 0.035 * (1 + w.rain24h / 20);
    const drying = e.roadDamage < 0 && edge.condition < 85 ? -e.roadDamage : 0;
    edge.condition = Math.max(15, Math.min(100, edge.condition - trafficWear - Math.max(0, e.roadDamage) + drying));
    edge.traffic = 0;
  }
}

export function roadConditionLabel(c: number): string {
  if (c >= 90) return "EXCELLENT";
  if (c >= 75) return "GOOD";
  if (c >= 55) return "FAIR";
  if (c >= 35) return "POOR";
  return "DAMAGED";
}
