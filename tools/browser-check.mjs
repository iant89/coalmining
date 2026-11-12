#!/usr/bin/env node
/**
 * Real-WebGPU smoke test of the game: serves it with Vite, opens it in headless Chromium on
 * SwiftShader (the browser Forge-Engine's `npm run setup` provisions), and plays the first-slice
 * loop through the real UI — click a block on the map, order REMOVE OVERBURDEN, fast-forward,
 * order MINE COAL — taking screenshots along the way (tools/shot-*.png, git-ignored).
 *
 * Exit codes: 0 pass, 1 fail, 2 not run (no browser / no WebGPU adapter). A green `npm run verify`
 * says nothing about this gate; run it and look at the screenshots.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.CHECK_PORT ?? 5191);
const URL = `http://127.0.0.1:${PORT}/?new=1&dev=1&quality=${process.env.CHECK_QUALITY ?? "low"}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vite = spawn(process.execPath, [join(root, "node_modules/vite/bin/vite.js"), "--config", "vite.config.ts", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let viteLog = "";
vite.stdout.on("data", (d) => (viteLog += d));
vite.stderr.on("data", (d) => (viteLog += d));
const stop = (code) => {
  vite.kill("SIGKILL");
  process.exit(code);
};

for (let i = 0; ; i++) {
  try {
    if ((await fetch(URL)).ok) break;
  } catch {}
  if (i > 80) {
    console.error(`vite did not start:\n${viteLog}`);
    stop(1);
  }
  await sleep(250);
}

// Same browser and Vulkan environment as Forge-Engine's browser gate (scripts/setup-deps.sh there).
const env = { ...process.env };
const envFile = "/tmp/forge-gpu-env.sh";
if (existsSync(envFile)) {
  for (const m of readFileSync(envFile, "utf8").matchAll(/^export (\w+)='([^']*)'/gm)) env[m[1]] = m[2];
}
const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? (existsSync("/tmp/chromium") ? "/tmp/chromium" : undefined);
const { chromium } = await import("playwright-core");
let browser;
try {
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    env,
    ignoreDefaultArgs: ["--headless"],
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--headless=new", "--enable-unsafe-webgpu", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--enable-features=Vulkan"],
    timeout: 90000,
  });
} catch (e) {
  console.error(`browser-check NOT RUN — no launchable browser (${String(e).split("\n")[0]}). Run \`npm run setup\` in Forge-Engine first.`);
  stop(2);
}

const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
page.setDefaultTimeout(120000);
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});
const problems = [];
const check = (ok, msg) => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`);
  if (!ok) problems.push(msg);
};
const shot = async (name) => {
  const path = join(root, "tools", `shot-${name}.png`);
  await frames(2);
  await page.screenshot({ path, timeout: 180000 });
  console.log(`  shot ${path}`);
};

await page.goto(URL);
const hasAdapter = await page.evaluate(async () => !!(navigator.gpu && (await navigator.gpu.requestAdapter())));
if (!hasAdapter) {
  console.error("browser-check NOT RUN — Chromium has no WebGPU adapter here");
  await browser.close();
  stop(2);
}
await page.waitForFunction(() => window.blackCreek, null, { timeout: 60000 });
const g = (fn, arg) => page.evaluate(fn, arg);
/** Software rasterisers draw a frame every second or two: wait in frames, not milliseconds. */
async function frames(n) {
  const start = await g(() => window.blackCreek.engine.stats().frame);
  await page.waitForFunction((t) => window.blackCreek.engine.stats().frame >= t, start + n, { timeout: 180000, polling: 250 });
}
await shot("1-start");

const stats = await g(() => window.blackCreek.engine.stats());
check(stats.gpuErrors === 0, `no GPU errors at start (${stats.gpuErrors}${stats.lastError ? `: ${stats.lastError}` : ""})`);
check(stats.drawCalls > 20, `scene draws (${stats.drawCalls} draw calls, ${stats.triangles} triangles)`);
check((await page.locator("#hud .mine").textContent())?.includes("BLACK CREEK"), "HUD shows the mine name");

// Click Block A2 on the map, through the real picking path.
const a2 = await g(() => {
  const { game } = window.blackCreek;
  const b = game.ms.sim.block("A2");
  const t = game.ms.sim.terrain;
  const x = (t.cellX(b.rect.i0) + t.cellX(b.rect.i1)) / 2;
  const z = (t.cellZ(b.rect.j0) + t.cellZ(b.rect.j1)) / 2;
  game.rig.centerOn(x, z, 150);
  return { x, z };
});
await frames(3);
const screen = await g(({ x, z }) => window.blackCreek.game.screenPoint(x, z), a2);
check(!!screen, `Block A2 projects on screen (${screen ? `${screen.x.toFixed(0)}, ${screen.y.toFixed(0)}` : "off screen"})`);
if (screen) await page.mouse.click(screen.x, screen.y);
await frames(1);
const sel = await g(() => window.blackCreek.game.selection);
check(sel?.kind === "block" && sel.id === "A2", `clicking the map selects Block A2 (got ${JSON.stringify(sel)})`);

await page.locator("#context button", { hasText: "REMOVE OVERBURDEN" }).click();
await sleep(500);
const tasks = await g(() => window.blackCreek.game.ms.state.tasks.map((t) => t.type));
check(tasks.includes("DRILL_PATTERN") && tasks.includes("BLAST") && tasks.includes("EXCAVATE") && tasks.filter((t) => t === "HAUL").length === 2, `REMOVE OVERBURDEN issues drill → blast → excavate + 2 hauls (${tasks.join(", ")})`);

// Fast-forward through drilling and blasting, then watch hauling at speed.
await g(() => window.blackCreek.game.ms.advanceMinutes(10 * 60 + 20));
await page.locator("#hud button[data-act=speed][data-id=\"50\"]").click();
await frames(6);
const mid = await g(() => {
  const s = window.blackCreek.game.ms.state;
  return { blast: s.blasts[0]?.state, moved: s.blocks.find((b) => b.id === "A2").overburdenMovedT, loads: s.equipment.filter((e) => e.defId.startsWith("ridgeline_rh")).reduce((a, e) => a + e.stats.loads, 0) };
});
check(mid.blast === "COMPLETED", `the blast fired (${mid.blast})`);
check(mid.moved > 0, `overburden is moving (${Math.round(mid.moved)} t, ${mid.loads} truckloads)`);
// Select the excavator so the screenshot shows its panel and ring.
await g(() => {
  const { game } = window.blackCreek;
  const ex = game.ms.state.equipment.find((e) => e.defId === "hartmann_hx350");
  game.select({ kind: "equipment", id: ex.id }, true);
  game.rig.distance = 95;
});
await frames(4);
await shot("2-hauling");

// Finish the overburden headlessly, then order coal through the UI.
await g(() => {
  const { game } = window.blackCreek;
  for (let h = 0; h < 30 && game.ms.sim.block("A2").state !== "COAL_EXPOSED"; h++) game.ms.advanceMinutes(60);
  game.select({ kind: "block", id: "A2" }, true);
});
await frames(4);
const exposed = await g(() => window.blackCreek.game.ms.sim.block("A2").state);
check(exposed === "COAL_EXPOSED", `coal exposed in A2 (${exposed})`);
await shot("3-coal-exposed");
await page.locator("#context button", { hasText: "MINE COAL" }).click();
await g(() => {
  const { game } = window.blackCreek;
  for (let h = 0; h < 30 && game.ms.sim.block("A2").state !== "COMPLETE"; h++) game.ms.advanceMinutes(60);
});
const rom = await g(() => window.blackCreek.game.ms.state.stockpiles[0].tonnes);
check(rom > 500, `coal reached the ROM stockpile (${Math.round(rom)} t)`);

// Sell through the dialog.
await page.locator("#tabs button", { hasText: "FINANCE" }).click();
await page.locator("#drawer button", { hasText: "SELL COAL" }).click();
const cashBefore = await g(() => window.blackCreek.game.ms.state.treasury.cash);
await page.locator("#modal button[data-id=cust-power]").click();
await sleep(300);
const cashAfter = await g(() => window.blackCreek.game.ms.state.treasury.cash);
check(cashAfter > cashBefore + 10000, `selling coal to the power station brings in cash (${Math.round(cashAfter - cashBefore)})`);
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");

// Development phase 08: build a haul road and a conveyor through the UI, buy a grader.
{
  await g(() => {
    const { game } = window.blackCreek;
    game.select(null);
    game.ms.state.treasury.cash += 3_000_000;
    game.rig.centerOn(110, 50, 230);
  });
  await frames(3);
  const clickGround = async (x, z) => {
    const p = await g(({ x, z }) => window.blackCreek.game.screenPoint(x, z), { x, z });
    if (!p) throw new Error(`ground point ${x},${z} is off screen`);
    await page.mouse.click(p.x, p.y);
    await frames(1);
  };
  await page.locator("#tabs button", { hasText: "MINE" }).click();
  await page.locator("#drawer button", { hasText: "BUILD HAUL ROAD" }).click();
  await clickGround(112, 108);
  await clickGround(80, 0);
  await page.locator("#modal button[data-act=dlg-assign]").click();
  const roadTask = await g(() => window.blackCreek.game.ms.state.tasks.find((t) => t.type === "CONSTRUCT")?.status);
  check(!!roadTask, `BUILD HAUL ROAD (two map clicks) creates a construction task (${roadTask})`);
  await page.locator("#drawer button", { hasText: "BUILD CONVEYOR" }).click();
  await clickGround(158, 40);
  await page.locator("#modal select[name=dest]").selectOption("rom-1");
  await page.locator("#modal button[data-act=dlg-assign]").click();
  const projects = await g(() => window.blackCreek.game.ms.state.projects.map((p) => p.type));
  check(projects.includes("HAUL_ROAD") && projects.includes("CONVEYOR"), `road and conveyor projects planned (${projects.join(", ")})`);
  await page.locator("#tabs button", { hasText: "MINE" }).click();
  await page.locator("#tabs button", { hasText: "EQUIPMENT" }).click();
  await page.locator("#drawer tr", { hasText: "Motor Grader" }).locator("button").click();
  await page.locator("#tabs button", { hasText: "EQUIPMENT" }).click();
  await g(() => {
    const { game } = window.blackCreek;
    for (let h = 0; h < 96 && game.ms.state.projects.some((p) => p.status !== "COMPLETE"); h++) game.ms.advanceMinutes(60);
  });
  const built = await g(() => {
    const s = window.blackCreek.game.ms.state;
    return { roads: s.roadEdges.length, conveyors: s.conveyors.length, hoppers: s.hoppers.length, graders: s.equipment.filter((e) => e.defId === "ironback_gr14").length };
  });
  check(built.roads === 7 && built.conveyors === 1 && built.hoppers === 1 && built.graders === 1, `road, conveyor and grader in service (${JSON.stringify(built)})`);
  await g(() => {
    const { game } = window.blackCreek;
    game.rig.centerOn(140, 80, 140);
    game.rig.yaw = 2.0;
  });
  await frames(6);
  const st8 = await g(() => window.blackCreek.engine.stats());
  check(st8.gpuErrors === 0, `no GPU errors with conveyors and new roads (${st8.gpuErrors})`);
  await shot("6-logistics");
}

// Geology overlay and a wide view.
await g(() => {
  const { game } = window.blackCreek;
  game.select(null);
  game.setOverlay("GEOLOGY");
  game.rig.centerOn(60, 0, 420);
});
await frames(8);
await shot("4-geology");
await g(() => window.blackCreek.game.setOverlay("NORMAL"));

// Save → load round trip in the browser.
const saved = await g(() => window.blackCreek.game.save("check"));
const loaded = await g(() => window.blackCreek.game.load("check"));
check(saved === null && loaded === null, `save/load in the browser (${saved ?? ""} ${loaded ?? ""})`);
await frames(8);
const end = await g(() => window.blackCreek.engine.stats());
check(end.gpuErrors === 0, `no GPU errors at the end (${end.gpuErrors}${end.lastError ? `: ${end.lastError}` : ""})`);
check(errors.length === 0, `no page errors (${errors.slice(0, 5).join(" | ")})`);
await shot("5-end");

// Phones and the Claude app: a tap must select a machine (touch handlers suppress the browser's
// synthetic click, so the camera rig reports taps itself).
{
  const { devices } = await import("playwright-core");
  const ctx = await browser.newContext({ ...devices["Pixel 7"] });
  const phone = await ctx.newPage();
  phone.setDefaultTimeout(120000);
  await phone.goto(URL);
  await phone.waitForFunction(() => window.blackCreek, null, { timeout: 60000 });
  const pf = async (n) => {
    const t0 = await phone.evaluate(() => window.blackCreek.engine.stats().frame);
    await phone.waitForFunction((t) => window.blackCreek.engine.stats().frame >= t, t0 + n, { timeout: 180000, polling: 250 });
  };
  await phone.evaluate(() => window.blackCreek.game.rig.centerOn(0, 104, 230));
  await pf(4);
  const target = await phone.evaluate(() => {
    const { game } = window.blackCreek;
    const e = game.ms.state.equipment.find((x) => x.name === "RH60 #1");
    const p = game.equipment.pose(e.id);
    return { id: e.id, s: game.screenPoint(p.x, p.z) };
  });
  if (target.s) await phone.touchscreen.tap(target.s.x, target.s.y);
  await pf(1);
  const tapped = await phone.evaluate(() => window.blackCreek.game.selection);
  check(tapped?.kind === "equipment" && tapped.id === target.id, `a tap on a phone selects RH60 #1 at the default zoom (got ${JSON.stringify(tapped)})`);
  await ctx.close();
}

await browser.close();
console.log(problems.length ? `browser-check FAILED (${problems.length})` : "browser-check PASSED");
stop(problems.length ? 1 : 0);
