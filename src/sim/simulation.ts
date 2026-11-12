/**
 * The simulation pipeline (spec §5.1). `MineSimulation.tick()` advances one fixed tick through every
 * system in a fixed order; hourly and daily systems run on the boundary ticks. Everything the player
 * does goes through `commands.ts`, so the same scenario + seed + command list replays identically.
 */
import { Sim } from "./sim.js";
import { TICK_SECONDS } from "./core/clock.js";
import type { Catalog } from "./equipment/catalog.js";
import type { DayStats, SimState } from "./state.js";
import { hourlyEnvironment } from "./environment/weather.js";
import { tickTasks } from "./tasks/service.js";
import { blastClearance } from "./tasks/executors.js";
import { minuteSafety } from "./regulatory/safety.js";
import { dailyPermits } from "./regulatory/permits.js";
import { dailyMarket } from "./economy/market.js";
import { processLab } from "./mining/exploration.js";
import { newDayWorkforce } from "./workforce/workforce.js";
import { updateObjectives } from "./objectives.js";
import { autoDispatch, wireAutomation } from "./automation.js";
import { tickConveyors } from "./logistics/conveyors.js";

export function emptyDay(day: number): DayStats {
  return {
    day,
    overburdenT: 0,
    topsoilT: 0,
    coalMinedT: 0,
    coalSoldT: 0,
    revenue: 0,
    expenses: {},
    fuelL: 0,
    equipmentWorkingMin: 0,
    equipmentIdleMin: 0,
    equipmentDownMin: 0,
    workerHours: 0,
    incidents: 0,
    drilledM: 0,
    blasts: 0,
  };
}

export class MineSimulation {
  readonly sim: Sim;

  constructor(state: SimState, catalog: Catalog) {
    this.sim = new Sim(state, catalog);
    wireAutomation(this.sim);
  }

  get state(): SimState {
    return this.sim.state;
  }

  tick(): void {
    const sim = this.sim;
    // 01. Clock — and remember where everything was, for render interpolation.
    for (const e of sim.state.equipment) {
      e.prevX = e.x;
      e.prevZ = e.z;
      e.prevHeading = e.heading;
    }
    sim.clock.advance();
    const hour = sim.clock.isHourBoundary;
    const minute = sim.clock.isMinuteBoundary;
    // 02–03. Weather, roads, environment.
    if (hour) hourlyEnvironment(sim);
    // Blast exclusion zone clearance runs ahead of task work.
    blastClearance(sim);
    // 04–11. Workers, equipment, tasks, mining, logistics (executors drive all of these).
    tickTasks(sim);
    // 09. Conveyors.
    tickConveyors(sim);
    for (const e of sim.state.equipment) {
      if (e.state === "BROKEN") {
        e.stats.downMin += sim.dt;
        sim.state.today.equipmentDownMin += sim.dt;
      }
    }
    // 12–13. Safety, regulatory.
    if (minute) {
      minuteSafety(sim);
      processLab(sim);
      updateObjectives(sim);
    }
    // 14–18. Economy, contracts, events, notifications, statistics.
    if (minute) sim.accrue(sim.state.overheadPerDay / (24 * 60), "overhead");
    if (hour) {
      autoDispatch(sim);
      sim.flushAccruals();
    }
    if (sim.clock.isDayBoundary) this.endOfDay();
  }

  private endOfDay(): void {
    const sim = this.sim;
    const finished = sim.state.today;
    sim.state.history.push(finished);
    if (sim.state.history.length > 365) sim.state.history.shift();
    sim.bus.emit({ type: "DayEnded", day: finished.day });
    sim.state.today = emptyDay(sim.day);
    dailyMarket(sim);
    dailyPermits(sim);
    newDayWorkforce(sim);
    const spent = Object.values(finished.expenses).reduce((a, b) => a + (b ?? 0), 0);
    sim.notify(
      finished.revenue - spent >= 0 ? "good" : "info",
      `Day ${finished.day} report`,
      `Overburden ${Math.round(finished.overburdenT).toLocaleString()} t · coal mined ${Math.round(finished.coalMinedT).toLocaleString()} t · sold ${Math.round(finished.coalSoldT).toLocaleString()} t · revenue $${Math.round(finished.revenue).toLocaleString()} · costs $${Math.round(spent).toLocaleString()}`,
    );
  }

  /** Run `n` ticks (tests, fast-forward, developer "advance time"). */
  step(n: number): void {
    for (let i = 0; i < n; i++) this.tick();
  }

  /** Run simulated minutes. */
  advanceMinutes(minutes: number): void {
    this.step(Math.round((minutes * 60) / TICK_SECONDS));
  }
}
