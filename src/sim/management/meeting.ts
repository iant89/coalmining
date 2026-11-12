/**
 * The morning meeting: at every shift start each foreman reports on the last day (tonnes hauled,
 * orders, breakdowns, people) and the player re-plans the crews' orders. The simulation only
 * records the meeting; the UI pauses the clock while it is open and `closeMeeting` ends it.
 */
import type { Sim } from "../sim.js";
import type { Crew, CrewReport, MorningMeeting } from "../state.js";
import { crewTonnes, orderLabel } from "./crews.js";

function crewReport(sim: Sim, crew: Crew): CrewReport {
  const foreman = sim.worker(crew.foremanId);
  const lines: CrewReport["lines"] = [];
  if (!foreman) lines.push({ severity: "critical", text: "No foreman: the crew takes no orders until one is assigned." });
  else if (foreman.employmentStatus !== "ACTIVE") lines.push({ severity: "critical", text: `${foreman.name} is ${foreman.employmentStatus === "ON_LEAVE" ? "on leave" : "gone"}: assign another foreman.` });
  const hauled = crewTonnes(sim, crew) - crew.tonnesAtMeeting;
  if (hauled > 0.5) lines.push({ severity: "good", text: `Hauled ${Math.round(hauled).toLocaleString()} t since the last meeting.` });
  const live = crew.orders.filter((o) => o.status !== "DONE");
  const doneSince = crew.orders.filter((o) => o.status === "DONE" && o.doneDay !== null && o.doneDay >= sim.day - 1);
  for (const o of doneSince) lines.push({ severity: "good", text: `Finished: ${orderLabel(sim, o)}.` });
  if (live.length === 0) lines.push({ severity: "warn", text: "No orders: the crew will stand idle. Give it something to do." });
  for (const o of live) {
    const sev = o.status === "STUCK" ? "critical" : o.status === "PENDING" ? "info" : "info";
    lines.push({ severity: sev, text: `${orderLabel(sim, o)}: ${o.status === "ACTIVE" ? "under way" : o.status.toLowerCase()}${o.note ? ` — ${o.note}` : ""}.` });
  }
  for (const id of crew.equipmentIds) {
    const e = sim.equipment(id);
    if (!e) continue;
    const def = sim.def(e);
    if (e.state === "BROKEN") lines.push({ severity: "warn", text: `${e.name} is broken down (${e.breakdown?.cause ?? "fault"}).` });
    else if (e.condition < 40) lines.push({ severity: "warn", text: `${e.name} is in poor shape (${e.condition.toFixed(0)} %).` });
    else if (e.hoursSinceService > def.maintenanceIntervalH) lines.push({ severity: "info", text: `${e.name} is overdue for service (${Math.round(e.hoursSinceService)} h).` });
    if (e.fuelL / def.fuelCapacityL < 0.2) lines.push({ severity: "info", text: `${e.name} is low on fuel.` });
  }
  for (const id of crew.workerIds) {
    const w = sim.worker(id);
    if (!w) continue;
    if (w.employmentStatus === "ON_LEAVE") lines.push({ severity: "info", text: `${w.name} is on leave.` });
    else if (w.fatigue > 70) lines.push({ severity: "warn", text: `${w.name} is worn out (fatigue ${Math.round(w.fatigue)} %).` });
  }
  return { crewId: crew.id, crewName: crew.name, foremanName: foreman?.name ?? null, lines };
}

/** Open the meeting: one report per crew, plus anything nobody is responsible for. */
export function holdMeeting(sim: Sim): MorningMeeting {
  const reports = sim.state.crews.map((c) => crewReport(sim, c));
  const inCrew = new Set(sim.state.crews.flatMap((c) => [...c.workerIds, ...(c.foremanId ? [c.foremanId] : [])]));
  const idleForemen = sim.state.workers.filter((w) => w.role === "FOREMAN" && w.employmentStatus === "ACTIVE" && !inCrew.has(w.id));
  const crewEq = new Set(sim.state.crews.flatMap((c) => c.equipmentIds));
  const loose = sim.state.equipment.filter((e) => !crewEq.has(e.id) && !["LUBE_TRUCK", "SERVICE_TRUCK"].includes(sim.def(e).category));
  const general: CrewReport["lines"] = [];
  for (const f of idleForemen) general.push({ severity: "info", text: `${f.name} (foreman) has no crew yet. Form one to take orders.` });
  if (loose.length > 0) general.push({ severity: "info", text: `Not in any crew: ${loose.map((e) => e.name).join(", ")}. Only your own orders use them.` });
  if (general.length > 0) reports.push({ crewId: "", crewName: "Whole mine", foremanName: null, lines: general });
  const meeting: MorningMeeting = { day: sim.day, minute: sim.clock.minute, pending: true, reports };
  sim.state.meeting = meeting;
  return meeting;
}

/** End the meeting: start the next reporting period and send the foremen out at once. */
export function endMeeting(sim: Sim): void {
  if (sim.state.meeting) sim.state.meeting.pending = false;
  for (const c of sim.state.crews) {
    c.tonnesAtMeeting = crewTonnes(sim, c);
    c.lastCheck = -1e6;
  }
}

/** True on the tick a new shift starts (the meeting time). */
export function isShiftStart(sim: Sim): boolean {
  return sim.clock.isHourBoundary && Math.round(sim.clock.hourOfDay) % 24 === sim.state.shift.startHour % 24;
}
