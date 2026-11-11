export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function money(v: number, signed = false): string {
  const s = Math.round(Math.abs(v)).toLocaleString("en-US");
  const sign = v < 0 ? "−" : signed ? "+" : "";
  return `${sign}$${s}`;
}

export function tonnes(v: number): string {
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M t`;
  return `${Math.round(v).toLocaleString("en-US")} t`;
}

export function pct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`;
}

export function label(s: string): string {
  return s
    .toLowerCase()
    .split("_")
    .map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function bar(v: number, cls = ""): string {
  const p = Math.max(0, Math.min(1, v));
  return `<span class="bar ${cls}"><span style="width:${(p * 100).toFixed(1)}%"></span></span>`;
}

export function conditionClass(c: number): string {
  return c >= 75 ? "good" : c >= 55 ? "ok" : c >= 35 ? "warn" : "bad";
}

export function clockOf(minute: number): string {
  const day = Math.floor(minute / 1440) + 1;
  const m = Math.floor(minute % 1440);
  return `D${day} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
