/**
 * `Sim` is the simulation context every service receives: the plain `SimState`, the static content
 * catalog, the domain event bus and the deterministic RNG. It holds no game rules itself beyond
 * lookups and the money/notification plumbing every service shares.
 */
import { DomainEventBus } from "./core/events.js";
import { Rng } from "./core/rng.js";
import { SimClock, TICK_MINUTES } from "./core/clock.js";
import { Terrain } from "./world/terrain.js";
import type { Catalog, EquipmentDefinition } from "./equipment/catalog.js";
import type {
  Customer,
  DumpArea,
  Employee,
  EquipmentInstance,
  ExpenseCategory,
  Facility,
  FacilityType,
  IncomeCategory,
  MiningBlock,
  Notification,
  SimState,
  Stockpile,
  Task,
} from "./state.js";

const LEDGER_LIMIT = 600;
const NOTIFICATION_LIMIT = 200;

export class Sim {
  readonly bus = new DomainEventBus();
  readonly rng: Rng;
  readonly clock: SimClock;
  readonly terrain: Terrain;
  /** Continuous costs accrued this hour, booked to the ledger as one line per category. */
  private accrued: Partial<Record<ExpenseCategory, number>> = {};

  constructor(
    public readonly state: SimState,
    public readonly catalog: Catalog,
  ) {
    this.rng = new Rng(state.rngState);
    this.clock = new SimClock(state.clock);
    this.terrain = new Terrain(state.terrain);
  }

  /** Copy object-held state (RNG) back into `state` before serializing. */
  sync(): SimState {
    this.state.rngState = this.rng.state;
    return this.state;
  }

  get minute(): number {
    return this.clock.minute;
  }
  get day(): number {
    return this.clock.day;
  }
  get dt(): number {
    return TICK_MINUTES;
  }

  nextId(prefix: string): string {
    const n = (this.state.idCounters[prefix] ?? 0) + 1;
    this.state.idCounters[prefix] = n;
    return `${prefix}-${n}`;
  }

  // ---------------------------------------------------------------- lookups

  equipment(id: string | null | undefined): EquipmentInstance | null {
    if (!id) return null;
    return this.state.equipment.find((e) => e.id === id) ?? null;
  }
  def(eq: EquipmentInstance): EquipmentDefinition {
    return this.catalog.def(eq.defId);
  }
  worker(id: string | null | undefined): Employee | null {
    if (!id) return null;
    return this.state.workers.find((w) => w.id === id) ?? null;
  }
  task(id: string | null | undefined): Task | null {
    if (!id) return null;
    return this.state.tasks.find((t) => t.id === id) ?? null;
  }
  block(id: string | null | undefined): MiningBlock | null {
    if (!id) return null;
    return this.state.blocks.find((b) => b.id === id) ?? null;
  }
  dump(id: string | null | undefined): DumpArea | null {
    if (!id) return null;
    return this.state.dumps.find((d) => d.id === id) ?? null;
  }
  stockpile(id: string | null | undefined): Stockpile | null {
    if (!id) return null;
    return this.state.stockpiles.find((s) => s.id === id) ?? null;
  }
  customer(id: string): Customer | null {
    return this.state.customers.find((c) => c.id === id) ?? null;
  }
  facility(id: string | null | undefined): Facility | null {
    if (!id) return null;
    return this.state.facilities.find((f) => f.id === id) ?? null;
  }
  facilityOfType(type: FacilityType, nearX = 0, nearZ = 0): Facility | null {
    let best: Facility | null = null;
    let bestD = Infinity;
    for (const f of this.state.facilities) {
      if (f.type !== type) continue;
      const d = Math.hypot(f.x - nearX, f.z - nearZ);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- money

  /** One-off expense or income (negative amount = income). */
  spend(amount: number, category: ExpenseCategory, memo: string): void {
    this.state.treasury.cash -= amount;
    this.state.today.expenses[category] = (this.state.today.expenses[category] ?? 0) + amount;
    this.post(-amount, category, memo);
  }

  earn(amount: number, category: IncomeCategory, memo: string): void {
    this.state.treasury.cash += amount;
    this.state.today.revenue += amount;
    this.post(amount, category, memo);
  }

  /** Continuous expense (payroll, fuel burn …): cash moves now, the ledger line is hourly. */
  accrue(amount: number, category: ExpenseCategory): void {
    if (amount === 0) return;
    this.state.treasury.cash -= amount;
    this.state.today.expenses[category] = (this.state.today.expenses[category] ?? 0) + amount;
    this.accrued[category] = (this.accrued[category] ?? 0) + amount;
  }

  /** Book accrued continuous costs to the ledger (called on the hour). */
  flushAccruals(): void {
    for (const [cat, amount] of Object.entries(this.accrued)) {
      if (amount && Math.abs(amount) >= 0.005) this.post(-amount, cat as ExpenseCategory, `${cat} (hourly)`);
    }
    this.accrued = {};
  }

  private post(amount: number, category: ExpenseCategory | IncomeCategory, memo: string): void {
    const ledger = this.state.treasury.ledger;
    ledger.push({ id: this.nextId("tx"), minute: this.minute, amount, category, memo });
    if (ledger.length > LEDGER_LIMIT) ledger.splice(0, ledger.length - LEDGER_LIMIT);
  }

  canAfford(amount: number): boolean {
    return this.state.treasury.cash + this.state.treasury.creditLimit >= amount;
  }

  // ---------------------------------------------------------------- notifications

  notify(severity: Notification["severity"], title: string, text: string, subject: Notification["subject"] = null): void {
    const list = this.state.notifications;
    // Collapse identical repeats inside ten minutes (a blocked task re-reporting the same reason).
    const last = list[list.length - 1];
    if (last && last.title === title && last.text === text && this.minute - last.minute < 10) return;
    list.push({ id: this.nextId("note"), minute: this.minute, severity, title, text, subject });
    if (list.length > NOTIFICATION_LIMIT) list.splice(0, list.length - NOTIFICATION_LIMIT);
  }
}
