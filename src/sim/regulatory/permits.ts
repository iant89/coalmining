/**
 * Permits and land rights (spec §28, §30) as task preconditions. In the vertical slice the mine
 * inherits its permits; they can expire and be renewed, and every restricted task checks them.
 */
import type { Sim } from "../sim.js";
import type { Permit, PermitCategory } from "../state.js";
import { rectContains, type CellRect } from "../world/terrain.js";

export function permitValid(sim: Sim, p: Permit): boolean {
  if (p.status !== "APPROVED" && p.status !== "CONDITIONALLY_APPROVED") return false;
  return p.expirationDay === null || p.expirationDay >= sim.day;
}

/** Why work of `type` at `rect` is not permitted, or null. */
export function permitProblem(sim: Sim, type: PermitCategory, rect: CellRect | null): string | null {
  const permits = sim.state.permits.filter((p) => p.type === type);
  if (permits.length === 0) return `No ${label(type)} permit`;
  const valid = permits.filter((p) => permitValid(sim, p));
  if (valid.length === 0) {
    const p = permits[0]!;
    return p.status === "APPROVED" && p.expirationDay !== null ? `${p.name} expired on day ${p.expirationDay}` : `${p.name} is ${p.status.toLowerCase().replace(/_/g, " ")}`;
  }
  if (rect && !valid.some((p) => !p.area || (rectContains(p.area, rect.i0, rect.j0) && rectContains(p.area, rect.i1, rect.j1)))) {
    return `Outside the area covered by the ${label(type)} permit`;
  }
  return null;
}

export function mineralRightsProblem(sim: Sim, rect: CellRect): string | null {
  const ok = sim.state.parcels.some(
    (p) => p.mineralRights && (p.status === "OWNED" || p.status === "LEASED") && rectContains(p.rect, rect.i0, rect.j0) && rectContains(p.rect, rect.i1, rect.j1),
  );
  return ok ? null : "The mine holds no mineral rights here";
}

/** Daily permit lifecycle: expiry and review completion. */
export function dailyPermits(sim: Sim): void {
  for (const p of sim.state.permits) {
    if ((p.status === "APPROVED" || p.status === "CONDITIONALLY_APPROVED") && p.expirationDay !== null) {
      if (p.expirationDay === sim.day + 7) sim.notify("warn", `${p.name} expires in 7 days`, `Renew it from the PERMITS tab (review takes ${p.reviewDays} days).`);
      if (p.expirationDay < sim.day) {
        p.status = "EXPIRED";
        sim.bus.emit({ type: "PermitExpired", permitId: p.id });
        sim.notify("critical", `${p.name} has expired`, "Work that needs this permit is blocked until it is renewed.");
      }
    }
    if (p.status === "UNDER_REVIEW" && p.applicationDay !== null && sim.day >= p.applicationDay + p.reviewDays) {
      p.status = "APPROVED";
      p.approvalDay = sim.day;
      p.expirationDay = sim.day + 365;
      sim.notify("good", `${p.name} approved`, `Valid until day ${p.expirationDay}.`);
    }
  }
}

/**
 * Renew a permit. A permit that is still valid is extended by a year on payment (routine renewal);
 * one that has lapsed or was never granted goes under review for `reviewDays`.
 */
export function applyForRenewal(sim: Sim, permitId: string): string | null {
  const p = sim.state.permits.find((x) => x.id === permitId);
  if (!p) return "Unknown permit";
  if (p.status === "UNDER_REVIEW" || p.status === "APPLICATION") return "Already under review";
  if (p.status === "REVOKED" || p.status === "DENIED") return `${p.name} was ${p.status.toLowerCase()}; a new application is needed`;
  if (!sim.canAfford(p.renewalCost)) return "Not enough cash or credit";
  sim.spend(p.renewalCost, "permits", `Renewal: ${p.name}`);
  p.applicationDay = sim.day;
  if (permitValid(sim, p)) {
    p.expirationDay = (p.expirationDay ?? sim.day) + 365;
    sim.notify("good", `${p.name} renewed`, `Valid until day ${p.expirationDay}.`);
  } else {
    p.status = "UNDER_REVIEW";
    sim.notify("info", `${p.name}: renewal under review`, `The regulator expects to decide in ${p.reviewDays} days.`);
  }
  return null;
}

function label(t: PermitCategory): string {
  return t.toLowerCase().replace(/_/g, " ");
}
