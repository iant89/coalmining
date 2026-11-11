#!/usr/bin/env node
/**
 * Architecture gate (spec §2, §51): the simulation is authoritative and engine-free.
 *
 *  - src/sim/** imports nothing from @forge/engine, src/game/** or the DOM/WebGPU world;
 *  - src/sim/** never calls Math.random() or reads wall-clock time (determinism, spec §1.2/§40);
 *  - src/game/** reaches Forge only through the package root "@forge/engine" (no deep imports);
 *  - mining rules do not leak into the engine: nothing here edits ../Forge-Engine.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const files = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });

const problems = [];
const imports = (src) => [...src.matchAll(/^\s*(?:import|export)[^"'`]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);

for (const f of files(join(root, "src/sim"))) {
  const rel = relative(root, f);
  const src = readFileSync(f, "utf8");
  for (const spec of imports(src)) {
    if (spec.startsWith("@forge/")) problems.push(`${rel}: the simulation imports ${spec}`);
    if (spec.includes("/game/")) problems.push(`${rel}: the simulation imports presentation code (${spec})`);
  }
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  if (/Math\.random\s*\(/.test(code)) problems.push(`${rel}: Math.random() in simulation code (use sim.rng)`);
  if (/\b(Date\.now|performance\.now|new Date\s*\()/.test(code)) problems.push(`${rel}: wall-clock time in simulation code`);
  if (/\b(document|window|navigator|requestAnimationFrame)\b/.test(code)) problems.push(`${rel}: DOM/browser global in simulation code`);
}

for (const f of files(join(root, "src/game"))) {
  const rel = relative(root, f);
  for (const spec of imports(readFileSync(f, "utf8"))) {
    if (spec.startsWith("@forge/engine/") || spec.includes("Forge-Engine")) problems.push(`${rel}: deep engine import ${spec} (use the "@forge/engine" package root)`);
  }
}

if (problems.length) {
  console.error(`lint:arch FAILED\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("lint:arch OK — simulation is engine-free and deterministic; presentation uses the engine package root only.");
