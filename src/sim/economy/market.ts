/**
 * Coal sales (spec §26–27). Customers publish a daily price and a quality specification; the price
 * paid is adjusted for the delivered quality. Coal outside a customer's spec is refused with the
 * reason. Prices drift on a bounded random walk so scenarios stay controllable.
 */
import type { Sim } from "../sim.js";
import type { Customer, Shipment, Stockpile } from "../state.js";
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

/** Tonnes already sold from a stockpile and waiting at the loadout. */
export function committedT(sim: Sim, stockpileId: string): number {
  return (sim.state.loadout?.shipments ?? []).filter((x) => x.stockpileId === stockpileId).reduce((a, x) => a + x.tonnes - x.loadedT, 0);
}

export function quoteSale(sim: Sim, c: Customer, s: Stockpile, tonnes: number): SaleQuote {
  const q = s.quality;
  const free = Math.max(0, s.tonnes - committedT(sim, s.id));
  const t = Math.max(0, Math.min(tonnes, free, c.dailyDemandT - c.takenTodayT));
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
  else if (free < 1) problems.push(`Everything in ${s.name} is already sold and waiting at the loadout`);
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
  c.takenTodayT += quote.tonnes;
  // With a loadout the sale is loaded out at its rate and paid when the last truck leaves.
  const lo = sim.state.loadout;
  if (lo) {
    const sh: Shipment = { id: sim.nextId("ship"), customerId: c.id, stockpileId: s.id, tonnes: quote.tonnes, loadedT: 0, pricePerT: quote.pricePerT, royaltyRate: quote.revenue > 0 ? quote.royalty / quote.revenue : 0, createdMinute: sim.minute };
    lo.shipments.push(sh);
    const ahead = lo.shipments.reduce((a, x) => a + x.tonnes - x.loadedT, 0);
    sim.notify("info", `Sale agreed: ${Math.round(quote.tonnes).toLocaleString()} t to ${c.name}`, `$${quote.pricePerT.toFixed(2)}/t. Loading at ${lo.rateTph} t/h; done in about ${(ahead / lo.rateTph).toFixed(1)} h.`);
    return { ok: true, quote };
  }
  takeFromStockpile(s, quote.tonnes);
  sim.earn(quote.revenue, "coal sales", `${Math.round(quote.tonnes).toLocaleString()} t to ${c.name} @ $${quote.pricePerT.toFixed(2)}/t`);
  if (quote.royalty > 0) sim.spend(quote.royalty, "royalties", `Royalty to ${sim.state.parcels[0]?.mineralOwner ?? "mineral owner"}`);
  sim.state.today.coalSoldT += quote.tonnes;
  sim.bus.emit({ type: "CoalSold", customerId: c.id, tonnes: quote.tonnes, revenue: quote.revenue });
  sim.notify("good", `Sold ${Math.round(quote.tonnes).toLocaleString()} t of coal`, `${c.name} paid $${Math.round(quote.revenue).toLocaleString()} ($${quote.pricePerT.toFixed(2)}/t).`);
  return { ok: true, quote };
}

function completeShipment(sim: Sim, sh: Shipment): void {
  const c = sim.customer(sh.customerId);
  const revenue = sh.loadedT * sh.pricePerT;
  const name = c?.name ?? "the customer";
  if (sh.loadedT > 0.5) {
    sim.earn(revenue, "coal sales", `${Math.round(sh.loadedT).toLocaleString()} t to ${name} @ $${sh.pricePerT.toFixed(2)}/t`);
    if (sh.royaltyRate > 0) sim.spend(revenue * sh.royaltyRate, "royalties", `Royalty to ${sim.state.parcels[0]?.mineralOwner ?? "mineral owner"}`);
    sim.state.today.coalSoldT += sh.loadedT;
    sim.bus.emit({ type: "CoalSold", customerId: sh.customerId, tonnes: sh.loadedT, revenue });
  }
  const short = sh.tonnes - sh.loadedT;
  if (short > 0.5) {
    if (c) c.takenTodayT = Math.max(0, c.takenTodayT - short);
    sim.notify("warn", `Shipment to ${name} short by ${Math.round(short).toLocaleString()} t`, `${sim.stockpile(sh.stockpileId)?.name ?? "The stockpile"} ran out while loading (the plant may have reclaimed it). Paid for ${Math.round(sh.loadedT).toLocaleString()} t: $${Math.round(revenue).toLocaleString()}.`);
  } else {
    sim.notify("good", `Shipped ${Math.round(sh.loadedT).toLocaleString()} t to ${name}`, `Paid $${Math.round(revenue).toLocaleString()} ($${sh.pricePerT.toFixed(2)}/t).`);
  }
}

/** Pipeline step 11: the loadout fills the waiting customer trucks, first come first served. */
export function tickLoadout(sim: Sim): void {
  const lo = sim.state.loadout;
  if (!lo) return;
  let budget = (lo.rateTph * sim.dt) / 60;
  while (budget > 1e-9 && lo.shipments.length > 0) {
    const sh = lo.shipments[0]!;
    const pile = sim.stockpile(sh.stockpileId);
    const take = Math.min(budget, sh.tonnes - sh.loadedT, pile?.tonnes ?? 0);
    if (pile && take > 0) takeFromStockpile(pile, take);
    sh.loadedT += Math.max(0, take);
    budget -= Math.max(0, take);
    const empty = !pile || pile.tonnes < 0.01;
    if (sh.loadedT >= sh.tonnes - 1e-6 || empty) {
      completeShipment(sim, sh);
      lo.shipments.shift();
      continue;
    }
    break;
  }
}

/** Daily: drift prices, reset demand. */
export function dailyMarket(sim: Sim): void {
  for (const c of sim.state.customers) {
    const drift = sim.rng.gaussian() * 0.018 + (c.basePrice - c.price) / c.basePrice * 0.08;
    c.price = Math.max(c.basePrice * 0.85, Math.min(c.basePrice * 1.15, c.price * (1 + drift)));
    c.takenTodayT = 0;
  }
}
