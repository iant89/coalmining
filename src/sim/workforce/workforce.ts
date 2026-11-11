/**
 * Workforce (spec §10, §35): shifts, fatigue, qualification and payroll. Employees are persistent;
 * their skills and fatigue feed productivity, wear and safety risk everywhere else.
 */
import type { Sim } from "../sim.js";
import type { Employee, SkillKey, WorkerRole } from "../state.js";
import type { EquipmentDefinition } from "../equipment/catalog.js";
import { FIRST_NAMES, LAST_NAMES } from "./names.js";

export function isOnShift(sim: Sim, w: Employee): boolean {
  if (w.employmentStatus !== "ACTIVE") return false;
  const { startHour, lengthHours } = sim.state.shift;
  const h = sim.clock.hourOfDay;
  const end = startHour + lengthHours;
  return end <= 24 ? h >= startHour && h < end : h >= startHour || h < end - 24;
}

export function shiftLabel(sim: Sim): string {
  const { startHour, lengthHours } = sim.state.shift;
  const f = (h: number): string => `${String(Math.floor(h % 24)).padStart(2, "0")}:00`;
  return `${f(startHour)}–${f(startHour + lengthHours)}`;
}

export function hasCertification(sim: Sim, w: Employee, cert: string): boolean {
  return w.certifications.some((c) => c.type === cert && (c.expiresDay === null || c.expiresDay >= sim.day));
}

/** Why `w` may not do work needing `role`/`cert`, or null when qualified. */
export function qualificationProblem(sim: Sim, w: Employee, role: WorkerRole | null, cert: string | null): string | null {
  if (w.employmentStatus !== "ACTIVE") return `${w.name} is ${w.employmentStatus === "ON_LEAVE" ? "on leave" : "no longer employed"}`;
  if (role && w.role !== role && !(role === "OPERATOR" && w.role === "DRILL_OPERATOR")) return `${w.name} is a ${roleLabel(w.role)}, not a ${roleLabel(role)}`;
  if (cert) {
    const c = w.certifications.find((x) => x.type === cert);
    if (!c) return `${w.name} lacks the ${certLabel(cert)} certification`;
    if (c.expiresDay !== null && c.expiresDay < sim.day) return `${w.name}'s ${certLabel(cert)} certification expired on day ${c.expiresDay}`;
  }
  return null;
}

export function operatorProblem(sim: Sim, w: Employee, def: EquipmentDefinition): string | null {
  return qualificationProblem(sim, w, def.requiredRole, def.requiredCertification);
}

/** 0…1 effective performance on a skill once fatigue and morale are applied. */
export function workerPerformance(w: Employee, skill: SkillKey): number {
  const fatigue = 1 - 0.45 * Math.max(0, (w.fatigue - 45) / 55);
  const morale = 0.9 + 0.1 * (w.morale / 100);
  return Math.max(0, Math.min(1, w.skills[skill] * fatigue * morale));
}

export function roleLabel(r: WorkerRole): string {
  return r
    .toLowerCase()
    .split("_")
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join(" ");
}

export function certLabel(c: string): string {
  return c
    .toLowerCase()
    .split("_")
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join(" ");
}

/** Per-tick fatigue, hours and payroll. `busy` = worker ids operating or working a task this tick. */
export function tickWorkers(sim: Sim, busy: ReadonlySet<string>): void {
  const dt = sim.dt;
  for (const w of sim.state.workers) {
    if (w.employmentStatus === "TERMINATED") continue;
    const on = isOnShift(sim, w);
    if (on) {
      const working = busy.has(w.id);
      // Fatigue reaches ~100 after 16 h of operating, slower when idle on site.
      const before = w.fatigue;
      w.fatigue = Math.min(100, w.fatigue + (dt / 60) * (working ? 6.2 : 2.2) * (sim.clock.hourOfDay < 6 || sim.clock.hourOfDay >= 20 ? 1.35 : 1));
      if (before < 85 && w.fatigue >= 85) {
        sim.bus.emit({ type: "WorkerFatigued", workerId: w.id });
        sim.notify("warn", `${w.name} is exhausted`, "Fatigue above 85%: productivity is down and accident risk is up.", { kind: "worker", id: w.id });
      }
      w.hoursToday += dt / 60;
      w.totalHours += dt / 60;
      sim.state.today.workerHours += dt / 60;
      sim.accrue((w.wagePerHour * sim.state.laborBurden * dt) / 60, "payroll");
      if (!working && w.activity !== "repairing") w.activity = "idle";
    } else {
      w.fatigue = Math.max(0, w.fatigue - (dt / 60) * 9);
      w.activity = "off-shift";
    }
  }
}

export function newDayWorkforce(sim: Sim): void {
  for (const w of sim.state.workers) {
    w.hoursToday = 0;
    for (const c of w.certifications) {
      if (c.expiresDay === sim.day) sim.notify("warn", `${w.name}: ${certLabel(c.type)} certification expires today`, "Renew it through training before they are assigned restricted work.", { kind: "worker", id: w.id });
    }
  }
}

/** Deterministic applicant pool. */
export function generateCandidate(sim: Sim, role: WorkerRole = "OPERATOR"): Employee {
  const r = sim.rng;
  const experience = Math.round(r.range(0, 22));
  const base = Math.min(0.95, 0.35 + experience * 0.025 + r.range(-0.1, 0.1));
  const skills: Record<SkillKey, number> = {
    equipmentOperation: base,
    safety: Math.min(1, Math.max(0.2, base + r.range(-0.2, 0.2))),
    maintenance: role === "MECHANIC" ? Math.min(1, base + 0.2) : r.range(0.1, 0.5),
    mining: Math.min(1, base + r.range(-0.15, 0.1)),
    driving: Math.min(1, base + r.range(-0.1, 0.15)),
    drilling: r.range(0.1, 0.7),
    blasting: role === "BLASTER" ? Math.min(1, base + 0.15) : r.range(0, 0.4),
    leadership: r.range(0.1, 0.7),
  };
  const certPool = ["HAUL_TRUCK", "EXCAVATOR", "DOZER", "DRILL"];
  const certs = certPool.filter(() => r.chance(0.35 + experience * 0.02)).map((type) => ({ type, expiresDay: null as number | null }));
  if (certs.length === 0 && role === "OPERATOR") certs.push({ type: r.pick(certPool), expiresDay: null });
  if (role === "BLASTER" || (role === "OPERATOR" && r.chance(0.1))) certs.push({ type: "BLASTER", expiresDay: sim.day + r.int(60, 400) });
  return {
    id: sim.nextId("emp"),
    name: `${r.pick(FIRST_NAMES)} ${r.pick(LAST_NAMES)}`,
    age: 20 + experience + r.int(0, 15),
    role,
    skills,
    experienceYears: experience,
    safetyRating: skills.safety,
    reliability: r.range(0.6, 1),
    fatigue: 0,
    morale: r.range(60, 90),
    wagePerHour: Math.round(24 + experience * 0.9 + base * 10 + certs.length * 1.5),
    certifications: certs,
    assignedEquipmentId: null,
    employmentStatus: "ACTIVE",
    activity: "off-shift",
    hoursToday: 0,
    totalHours: 0,
    hiredDay: 0,
  };
}
