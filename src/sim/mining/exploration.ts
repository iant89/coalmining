/**
 * Exploration (spec §13): core holes measure the seam exactly where they are drilled, and the lab
 * reports quality some hours later. Blast holes that hit coal also log the roof depth. Together they
 * are the only way the player's geological picture improves.
 */
import type { Sim } from "../sim.js";
import { drillLog, qualityAt, seamThickness, type GeoSample } from "../world/geology.js";

export const LAB_HOURS = 8;
export const CORE_COST_PER_M = 32;

export function recordCoreSample(sim: Sim, x: number, z: number, depth: number): GeoSample {
  const t = sim.terrain;
  const g = sim.state.geology;
  const { i, j } = t.cellOf(x, z);
  const k = t.index(i, j);
  const collar = t.state.surface[k]!;
  const roofDepth = collar - g.seamTop[k]!;
  const thick = seamThickness(g, k);
  const hit = thick > 0.05 && roofDepth >= 0 && roofDepth + thick <= depth;
  const partial = thick > 0.05 && roofDepth >= 0 && roofDepth < depth && !hit;
  const sample: GeoSample = {
    id: sim.nextId("hole"),
    kind: "CORE",
    x,
    z,
    depth,
    seamDepth: hit || partial ? roofDepth : null,
    thickness: hit ? thick : null,
    quality: null,
    analysisDueMinute: hit || partial ? sim.minute + LAB_HOURS * 60 : null,
    reliability: 1,
    collarElevation: collar,
    minute: sim.minute,
    log: drillLog(t, g, i, j, depth),
  };
  sim.state.samples.push(sample);
  sim.bus.emit({ type: "SampleRecorded", sampleId: sample.id, foundCoal: sample.seamDepth !== null });
  if (sample.seamDepth !== null) {
    sim.notify(
      "good",
      `Core ${sample.id}: coal at ${sample.seamDepth.toFixed(1)} m`,
      sample.thickness !== null ? `Seam ${sample.thickness.toFixed(2)} m thick. Lab quality results in ${LAB_HOURS} h.` : `Hole ended inside the seam at ${depth} m: drill deeper to measure its thickness.`,
    );
    discoverSeam(sim);
  } else {
    sim.notify("info", `Core ${sample.id}: no coal to ${depth} m`, "The seam is absent or deeper here.");
  }
  return sample;
}

export function discoverSeam(sim: Sim): void {
  if (sim.state.seamDiscovered) return;
  sim.state.seamDiscovered = true;
  sim.bus.emit({ type: "CoalSeamDiscovered", seamId: "seam-1" });
  sim.notify("good", "Black Creek seam confirmed", "Drilling has confirmed the seam your grandfather mined. Use the GEOLOGY overlay to see what is known.");
}

/** Release lab results that are due (called each minute). */
export function processLab(sim: Sim): void {
  const t = sim.terrain;
  for (const s of sim.state.samples) {
    if (s.analysisDueMinute === null || s.analysisDueMinute > sim.minute) continue;
    s.analysisDueMinute = null;
    const { i, j } = t.cellOf(s.x, s.z);
    s.quality = qualityAt(sim.state.geology, t.index(i, j));
    sim.notify("info", `Lab results for ${s.id}`, `Ash ${s.quality.ash.toFixed(1)}%, sulfur ${s.quality.sulfur.toFixed(2)}%, ${Math.round(s.quality.btu).toLocaleString()} BTU/lb, moisture ${s.quality.moisture.toFixed(1)}%.`);
  }
}

/** Developer command: core holes on a grid over the whole map (spec §56 "reveal geology"). */
export function revealGeology(sim: Sim, spacing = 40): number {
  const t = sim.terrain;
  let n = 0;
  for (let z = t.state.originZ + spacing / 2; z < t.state.originZ + t.depth; z += spacing) {
    for (let x = t.state.originX + spacing / 2; x < t.state.originX + t.width; x += spacing) {
      const s = recordCoreSample(sim, x, z, 45);
      s.analysisDueMinute = sim.minute;
      n++;
    }
  }
  processLab(sim);
  return n;
}
