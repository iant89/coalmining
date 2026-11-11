/**
 * The simulation clock (spec §5).
 *
 * The simulation advances in fixed ticks of `TICK_SECONDS` simulated seconds; the renderer runs at
 * whatever frame rate it gets and interpolates between the previous and current tick. `SimClock`
 * turns real elapsed seconds into a whole number of ticks for the current speed, carrying the
 * remainder, so simulation results never depend on frame rate.
 *
 * Deliberate deviation from the spec's *recommended* one-minute tick: 1x here is real time, and a
 * one-minute tick would mean a minute of latency between a command and its first effect and haul
 * trucks jumping ~750 m per tick. Every task executor spends a time *budget* per tick (see
 * tasks/executors.ts), so cycle times are independent of the tick length; tests pin that.
 */
export const TICK_SECONDS = 5;
export const TICK_MINUTES = TICK_SECONDS / 60;
export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 24 * 60;
export const TICKS_PER_MINUTE = 60 / TICK_SECONDS;

/** Speed multipliers (simulated seconds per real second). 0 = paused. */
export const SPEEDS = [0, 1, 2, 5, 10, 25, 50, 100, 250] as const;
/** Developer-only fast-forward. */
export const DEBUG_SPEEDS = [1000] as const;

export interface ClockState {
  /** Ticks since the scenario epoch (day 1, 00:00). */
  tick: number;
  /** Current speed multiplier; 0 when paused. */
  speed: number;
  /** Fraction of a tick carried between frames, in [0, 1). */
  carry: number;
}

export class SimClock {
  constructor(public state: ClockState) {}

  static create(startHour: number): SimClock {
    return new SimClock({ tick: Math.round(startHour * 60 * TICKS_PER_MINUTE), speed: 1, carry: 0 });
  }

  /** Simulated minutes since the epoch (fractional). */
  get minute(): number {
    return this.state.tick * TICK_MINUTES;
  }
  /** 1-based day number. */
  get day(): number {
    return Math.floor(this.minute / MINUTES_PER_DAY) + 1;
  }
  get minuteOfDay(): number {
    return this.minute - (this.day - 1) * MINUTES_PER_DAY;
  }
  get hourOfDay(): number {
    return this.minuteOfDay / MINUTES_PER_HOUR;
  }
  get paused(): boolean {
    return this.state.speed === 0;
  }

  setSpeed(speed: number): void {
    this.state.speed = Math.max(0, speed);
    if (speed === 0) this.state.carry = 0;
  }

  /** Real seconds → ticks to run now. Capped so a background tab does not stall the page on return. */
  ticksFor(realSeconds: number, maxTicks = 400): number {
    if (this.state.speed === 0) return 0;
    const total = this.state.carry + (Math.max(0, realSeconds) * this.state.speed) / TICK_SECONDS;
    const ticks = Math.min(maxTicks, Math.floor(total));
    this.state.carry = ticks === maxTicks ? 0 : total - ticks;
    return ticks;
  }

  /** Progress through the next tick in [0, 1): what the renderer interpolates with. */
  get alpha(): number {
    return this.state.carry;
  }

  advance(): void {
    this.state.tick += 1;
  }

  /** True on the tick that crosses into a new simulated minute / hour / day. */
  get isMinuteBoundary(): boolean {
    return this.state.tick % TICKS_PER_MINUTE === 0;
  }
  get isHourBoundary(): boolean {
    return this.state.tick % (TICKS_PER_MINUTE * 60) === 0;
  }
  get isDayBoundary(): boolean {
    return this.state.tick % (TICKS_PER_MINUTE * MINUTES_PER_DAY) === 0;
  }

  format(): string {
    const m = Math.floor(this.minuteOfDay);
    return `Day ${this.day} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }
}

export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes)) return "—";
  if (minutes < 1) return `${Math.max(1, Math.round(minutes * 60))} s`;
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}
