/**
 * Safety (spec §34, §36): risk is computed from operating conditions, never rolled. Every risk score
 * comes with the factors that produced it so the player can see WHY. Incidents draw from the RNG at
 * a rate the score sets, and their report lists the same contributors.
 */
import type { Sim } from "../sim.js";
import type { Employee, EquipmentInstance } from "../state.js";
import { weatherEffects } from "../environment/weather.js";

export type RiskCategory = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

export interface RiskAssessment {
  score: number;
  category: RiskCategory;
  factors: { label: string; points: number }[];
}

export function riskCategory(score: number): RiskCategory {
  if (score < 20) return "LOW";
  if (score < 40) return "MODERATE";
  if (score < 65) return "HIGH";
  return "CRITICAL";
}

export function equipmentRisk(sim: Sim, eq: EquipmentInstance): RiskAssessment {
  const factors: { label: string; points: number }[] = [];
  const add = (label: string, points: number): void => {
    if (points >= 0.5) factors.push({ label, points: Math.round(points) });
  };
  const def = sim.def(eq);
  const op: Employee | null = sim.worker(eq.operatorId);
  add(`Machine condition ${eq.condition.toFixed(0)}%`, eq.condition < 65 ? (65 - eq.condition) * 0.45 : 0);
  add("Service overdue", eq.hoursSinceService > def.maintenanceIntervalH ? 8 + Math.min(10, (eq.hoursSinceService - def.maintenanceIntervalH) / 25) : 0);
  if (op) {
    add(`Operator fatigue ${op.fatigue.toFixed(0)}%`, op.fatigue > 45 ? (op.fatigue - 45) * 0.55 : 0);
    add(`Operator skill (${Math.round(op.skills.equipmentOperation * 100)}%)`, (1 - op.skills.equipmentOperation) * 14);
    add("Operator safety record", (1 - op.safetyRating) * 8);
  }
  const w = weatherEffects(sim.state.weather.kind);
  add(`Weather: ${w.label}`, w.risk);
  const h = sim.clock.hourOfDay;
  add("Night work without pit lighting", h < 6 || h >= 19.5 ? 14 : 0);
  if (def.category === "HAUL_TRUCK") {
    const worst = Math.min(100, ...sim.state.roadEdges.map((e) => e.condition));
    add(`Haul road condition ${worst.toFixed(0)}%`, worst < 60 ? (60 - worst) * 0.35 : 0);
    if (eq.payload && eq.payload.tonnes > (def.payloadT ?? Infinity) * 1.05) add("Overloaded", 12);
  }
  factors.sort((a, b) => b.points - a.points);
  const score = Math.min(100, factors.reduce((s, f) => s + f.points, 0));
  return { score, category: riskCategory(score), factors };
}

/** Mine safety index 0…100 (higher is safer) over machines that are working. */
export function mineSafetyIndex(sim: Sim): number {
  const active = sim.state.equipment.filter((e) => e.currentTaskId && e.state !== "BROKEN");
  if (active.length === 0) return 100;
  const mean = active.reduce((s, e) => s + equipmentRisk(sim, e).score, 0) / active.length;
  return Math.max(0, Math.round(100 - mean));
}

/** Per-minute incident check for machines doing work. */
export function minuteSafety(sim: Sim): void {
  for (const eq of sim.state.equipment) {
    if (!eq.currentTaskId || eq.state === "BROKEN" || eq.activity === "idle") continue;
    const risk = equipmentRisk(sim, eq);
    const hazard = 1.2e-6 * Math.exp(risk.score / 13);
    if (!sim.rng.chance(hazard)) continue;
    const severe = risk.score > 55 && sim.rng.chance(0.4);
    const damage = severe ? sim.rng.range(15, 30) : sim.rng.range(4, 12);
    eq.condition = Math.max(1, eq.condition - damage);
    const cost = Math.round((severe ? 18000 : 4000) + damage * 600);
    sim.spend(cost, "repairs", `Incident damage: ${eq.name}`);
    const op = sim.worker(eq.operatorId);
    const title = severe ? `${eq.name}: collision / rollover incident` : `${eq.name}: minor incident`;
    const contributors = risk.factors.slice(0, 4).map((f) => `${f.label} (+${f.points})`);
    sim.state.incidents.push({
      id: sim.nextId("incident"),
      minute: sim.minute,
      equipmentId: eq.id,
      workerId: op?.id ?? null,
      title,
      description: `${eq.name} lost ${damage.toFixed(0)}% condition. Risk at the time: ${risk.score.toFixed(0)} (${risk.category}).`,
      contributors,
      cost,
    });
    sim.state.today.incidents++;
    if (severe && op) {
      op.morale = Math.max(0, op.morale - 15);
      op.fatigue = 100;
    }
    sim.notify(severe ? "critical" : "warn", title, `Contributing: ${contributors.join("; ") || "none identified"}. Cost $${cost.toLocaleString()}.`, { kind: "equipment", id: eq.id });
  }
}
