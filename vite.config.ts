import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The game consumes Forge-Engine from its TypeScript sources in a sibling checkout (the same way the
 * engine's own demo does), so there is no engine build step to drift out of sync. Point
 * FORGE_ENGINE_DIR somewhere else to use a different checkout.
 */
const root = fileURLToPath(new URL(".", import.meta.url));
const engineDir = resolve(root, process.env.FORGE_ENGINE_DIR ?? "../Forge-Engine");
const engineEntry = resolve(engineDir, "engine/src/index.ts");
if (!existsSync(engineEntry)) {
  throw new Error(`Forge-Engine not found at ${engineDir}. Clone github.com/iant89/Forge-Engine next to this repo or set FORGE_ENGINE_DIR.`);
}

export default defineConfig({
  root,
  resolve: { alias: { "@forge/engine": engineEntry } },
  server: { host: "0.0.0.0", port: Number(process.env.PORT ?? 5180), strictPort: false, allowedHosts: true, fs: { allow: [root, engineDir] } },
  preview: { host: "0.0.0.0" },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
  worker: { format: "es" },
});
