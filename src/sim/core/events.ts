/**
 * Domain events (spec §74–75). Services publish what happened; other services, the notification
 * feed and the UI subscribe. The bus is synchronous and deterministic: handlers run in subscription
 * order inside the tick that raised the event.
 */
export type DomainEvent =
  | { type: "TaskCreated"; taskId: string }
  | { type: "TaskAssigned"; taskId: string; equipmentId: string | null; workerId: string | null }
  | { type: "TaskStarted"; taskId: string }
  | { type: "TaskBlocked"; taskId: string; reason: string }
  | { type: "TaskUnblocked"; taskId: string }
  | { type: "TaskCompleted"; taskId: string }
  | { type: "TaskCancelled"; taskId: string }
  | { type: "TaskFailed"; taskId: string; reason: string }
  | { type: "DrillStarted"; taskId: string; blockId: string | null }
  | { type: "DrillCompleted"; taskId: string; blockId: string | null }
  | { type: "SampleRecorded"; sampleId: string; foundCoal: boolean }
  | { type: "CoalSeamDiscovered"; seamId: string }
  | { type: "BlastExecuted"; blastId: string; blockId: string }
  | { type: "MaterialLoaded"; equipmentId: string; material: string; tonnes: number }
  | { type: "MaterialDumped"; equipmentId: string; material: string; tonnes: number; destination: string }
  | { type: "CoalExposed"; blockId: string }
  | { type: "BlockComplete"; blockId: string }
  | { type: "EquipmentBreakdown"; equipmentId: string; cause: string }
  | { type: "EquipmentRepaired"; equipmentId: string }
  | { type: "EquipmentPurchased"; equipmentId: string }
  | { type: "LowFuel"; equipmentId: string }
  | { type: "WorkerHired"; workerId: string }
  | { type: "WorkerFatigued"; workerId: string }
  | { type: "ShiftChange"; onShift: boolean }
  | { type: "CoalSold"; customerId: string; tonnes: number; revenue: number }
  | { type: "StockpileFull"; stockpileId: string }
  | { type: "WeatherChanged"; weather: string }
  | { type: "PermitExpired"; permitId: string }
  | { type: "DayEnded"; day: number };

export type DomainEventType = DomainEvent["type"];
type Handler<T extends DomainEventType> = (event: Extract<DomainEvent, { type: T }>) => void;

export class DomainEventBus {
  private handlers = new Map<string, ((event: DomainEvent) => void)[]>();
  private anyHandlers: ((event: DomainEvent) => void)[] = [];
  /** Count per type, for the debug panel. */
  readonly counts: Record<string, number> = {};

  on<T extends DomainEventType>(type: T, handler: Handler<T>): () => void {
    const list = this.handlers.get(type) ?? [];
    const h = handler as (event: DomainEvent) => void;
    list.push(h);
    this.handlers.set(type, list);
    return () => {
      const i = list.indexOf(h);
      if (i >= 0) list.splice(i, 1);
    };
  }

  onAny(handler: (event: DomainEvent) => void): () => void {
    this.anyHandlers.push(handler);
    return () => {
      const i = this.anyHandlers.indexOf(handler);
      if (i >= 0) this.anyHandlers.splice(i, 1);
    };
  }

  emit(event: DomainEvent): void {
    this.counts[event.type] = (this.counts[event.type] ?? 0) + 1;
    for (const h of this.handlers.get(event.type) ?? []) h(event);
    for (const h of this.anyHandlers) h(event);
  }
}
