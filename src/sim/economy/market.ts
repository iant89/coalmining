/**
 * Coal sales (spec §26–27). Customers publish a daily price and a quality specification; the price
 * paid is adjusted for the delivered quality. Coal outside a customer's spec is refused with the
 * reason. Prices drift on a bounded random walk so scenarios stay controllable.
 */
import type { Sim } from "../sim.js";
import type { Customer, Stockpile } from "../state.js";
import type { CoalQuality } from "../world/materials.js";
import { takeFromStockpile } from "../logistics/stockpiles.js";

export interface SaleQuote {
  customerId: string;
  tonnes: number;
  pricePerT: number;
  revenue: number;
  royalty: number;
  problems: string[];
  adjustments: { label: string; perT: number }[];
}

export function qualityProblems(c: Customer, q: CoalQuality | null): string[] {
  if (!q) return ["No coal in the stockpile"];
  const out: string[] = [];
  if (q.ash > c.maxAsh) out.push(`Ash ${q.ash.toFixed(1)}% exceeds the ${c.maxAsh}% limit`);
  if (q.sulfur > c.maxSulfur) out.push(`Sulfur ${q.sulfur.toFixed(2)}% exceeds the ${c.maxSulfur}% limit`);
  if (q.btu < c.minBtu) out.push(`${Math.round(q.btu).toLocaleString()} BTU/lb is below the ${c.minBtu.toLocaleString()} minimum`);
  return out;
}

export function quoteSale(sim: Sim, c: Customer, s: Stockpile, tonnes: number): SaleQuote {
  const q = s.quality;
  const t = Math.max(0, Math.min(tonnes, s.tonnes, c.dailyDemandT - c.takenTodayT));
  const adjustments: { label: string; perT: number }[] = [];
  let price = c.price;
  if (q) {
    const btu = ((q.btu - 12000) / 100) * 0.55;
    if (Math.abs(btu) > 0.01) adjustments.push({ label: "Heat value", perT: btu });
    const ash = -Math.max(0, q.ash - 10) * 0.9;
    if (ash < -0.01) adjustments.push({ label: "Ash penalty", perT: ash });
    const sulfur = -Math.max(0, q.sulfur - 1.2) * 4;
    if (sulfur < -0.01) adjustments.push({ label: "Sulfur penalty", perT: sulfur });
    const moisture = -Math.max(0, q.moisture - 9) * 0.7;
    if (moisture < -0.01) adjustments.push({ label: "Moisture penalty", perT: moisture });
    for (const a of adjustments) price += a.perT;
  }
  price = Math.max(5, price);
  const problems = qualityProblems(c, q);
  if (c.takenTodayT >= c.dailyDemandT) problems.push(`${c.name} has taken its ${c.dailyDemandT.toLocaleString()} t for today`);
  if (s.tonnes < 1) problems.push(`${s.name} is empty`);
  const revenue = t * price;
  const royaltyRate = sim.state.parcels[0]?.royalty ?? 0;
  return { customerId: c.id, tonnes: t, pricePerT: price, revenue, royalty: revenue * royaltyRate, problems, adjustments };
}

export function sellCoal(sim: Sim, customerId: string, stockpileId: string, tonnes: number): { ok: boolean; quote: SaleQuote | null; error?: string } {
  const c = sim.customer(customerId);
  const s = sim.stockpile(stockpileId);
  if (!c || !s) return { ok: false, quote: null, error: "Unknown customer or stockpile" };
  const quote = quoteSale(sim, c, s, tonnes);
  if (quote.problems.length) return { ok: false, quote, error: quote.problems.join("; ") };
  if (quote.tonnes < 1) return { ok: false, quote, error: "Nothing to sell" };
  takeFromStockpile(s, quote.tonnes);
  c.takenTodayT += quote.tonnes;
  sim.earn(quote.revenue, "coal sales", `${Math.round(quote.tonnes).toLocaleString()} t to ${c.name} @ $${quote.pricePerT.toFixed(2)}/t`);
  if (quote.royalty > 0) sim.spend(quote.royalty, "royalties", `Royalty to ${sim.state.parcels[0]?.mineralOwner ?? "mineral owner"}`);
  sim.state.today.coalSoldT += quote.tonnes;
  sim.bus.emit({ type: "CoalSold", customerId: c.id, tonnes: quote.tonnes, revenue: quote.revenue });
  sim.notify("good", `Sold ${Math.round(quote.tonnes).toLocaleString()} t of coal`, `${c.name} paid $${Math.round(quote.revenue).toLocaleString()} ($${quote.pricePerT.toFixed(2)}/t).`);
  return { ok: true, quote };
}

/** Daily: drift prices, reset demand. */
export function dailyMarket(sim: Sim): void {
  for (const c of sim.state.customers) {
    const drift = sim.rng.gaussian() * 0.018 + (c.basePrice - c.price) / c.basePrice * 0.08;
    c.price = Math.max(c.basePrice * 0.85, Math.min(c.basePrice * 1.15, c.price * (1 + drift)));
    c.takenTodayT = 0;
  }
}
