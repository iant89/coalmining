/** Monotonic, human-readable ids ("task-12", "eq-3"). The counters are part of the saved state. */
export class IdGenerator {
  counters: Record<string, number> = {};

  next(prefix: string): string {
    const n = (this.counters[prefix] ?? 0) + 1;
    this.counters[prefix] = n;
    return `${prefix}-${n}`;
  }
}
