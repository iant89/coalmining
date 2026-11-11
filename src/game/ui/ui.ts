/**
 * The DOM user interface: HUD (spec §44), context panels (spec §45), the bottom tab drawers,
 * dialogs (spec §46 task creation with validation before assignment) and the developer panel
 * (spec §78, debug mode only). Panels re-render a few times a second from simulation state; every
 * button routes through one delegated click handler to a command in src/sim/commands.ts.
 */
import type { GameApi, Selection } from "./api.js";
import { morph } from "./morph.js";
import { bar, clockOf, conditionClass, esc, label, money, pct, tonnes } from "./format.js";
import type { Sim } from "../../sim/sim.js";
import type { EquipmentInstance, ExcavateMode, Task, TaskPriority, TaskType, WeatherKind } from "../../sim/state.js";
import { SPEEDS, DEBUG_SPEEDS, formatDuration } from "../../sim/core/clock.js";
import { OVERLAYS } from "../terrainView.js";
import { TASK_CATEGORY, TASK_LABEL, TERMINAL, cancelTask, sortedTasks, validateTask, type TaskSpec } from "../../sim/tasks/service.js";
import * as cmd from "../../sim/commands.js";
import { analyzeBlock, estimateBlock, blockCenter } from "../../sim/mining/blocks.js";
import { designPattern, estimatePattern, DEFAULT_PATTERN, type PatternOptions } from "../../sim/mining/drilling.js";
import { designBlast } from "../../sim/mining/blasting.js";
import { conditionBand, fuelFraction, payloadCapacity } from "../../sim/equipment/operation.js";
import { equipmentRisk, mineSafetyIndex } from "../../sim/regulatory/safety.js";
import { certLabel, isOnShift, qualificationProblem, roleLabel, shiftLabel } from "../../sim/workforce/workforce.js";
import { quoteSale } from "../../sim/economy/market.js";
import { permitValid } from "../../sim/regulatory/permits.js";
import { weatherEffects, roadConditionLabel } from "../../sim/environment/weather.js";
import { MATERIAL_LABEL } from "../../sim/world/materials.js";
import { estimateAt } from "../../sim/world/geology.js";
import { dumpCapacityLeftT } from "../../sim/logistics/stockpiles.js";
import { SLICE_OBJECTIVES } from "../../sim/objectives.js";

type Tab = "MINE" | "EQUIPMENT" | "WORKERS" | "TASKS" | "LAND" | "PERMITS" | "FINANCE" | "PLANT" | "SAFETY" | "REPORTS" | "SETTINGS";
const TABS: Tab[] = ["MINE", "EQUIPMENT", "WORKERS", "TASKS", "LAND", "PERMITS", "FINANCE", "PLANT", "SAFETY", "REPORTS", "SETTINGS"];

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;

export class GameUI {
  private tab: Tab | null = null;
  private dialogOpen = false;
  private lastFeed = "";
  private feedOpen = true;

  constructor(private api: GameApi) {
    document.addEventListener("click", (e) => this.onClick(e));
    document.addEventListener("keydown", (e) => this.onKey(e));
    $("#tabs").innerHTML = TABS.map((t) => `<button data-act="tab" data-id="${t}">${t}</button>`).join("");
    if (api.debug) document.body.classList.add("debug");
    this.render();
  }

  private get sim(): Sim {
    return this.api.ms.sim;
  }

  // ---------------------------------------------------------------- render loop

  render(): void {
    this.renderHud();
    this.renderFeed();
    this.renderObjectives();
    const editing = document.activeElement && (document.activeElement as HTMLElement).closest("#drawer, #context") && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (!editing) {
      this.renderContext();
      this.renderDrawer();
    }
    if (this.api.debug) this.renderDev();
  }

  private renderHud(): void {
    const sim = this.sim;
    const s = sim.state;
    const today = s.today;
    const last = s.history[s.history.length - 1];
    const costs = (d: typeof today) => Object.values(d.expenses).reduce((a, b) => a + (b ?? 0), 0);
    const dayNet = last ? last.revenue - costs(last) : today.revenue - costs(today);
    const coal = s.stockpiles.reduce((a, p) => a + p.tonnes, 0);
    const prod = last ? last.coalMinedT : today.coalMinedT;
    const reserves = s.blocks.reduce((a, b) => a + (estimateBlock(sim, b).coalT ?? 0) * (b.state === "COMPLETE" ? 0 : 1), 0);
    const safety = mineSafetyIndex(sim);
    const w = weatherEffects(s.weather.kind);
    const sp = this.api.speed();
    const speeds = [...SPEEDS, ...(this.api.debug ? DEBUG_SPEEDS : [])];
    morph($("#hud"), `
      <div class="hud-row">
        <span class="mine">${esc(s.mineName.toUpperCase())}</span>
        <span class="clock">${esc(sim.clock.format())} · ${isOnShift(sim, s.workers[0]!) ? "shift on" : "off shift"}</span>
        <span class="cash ${s.treasury.cash < 0 ? "bad" : ""}">${money(s.treasury.cash)}</span>
        <span class="delta ${dayNet >= 0 ? "good" : "bad"}" title="Net of the last full day">${money(dayNet, true)}/day</span>
        <span class="weather" title="${esc(w.label)}: speed ×${w.speed.toFixed(2)}, visibility ${pct(w.visibility)}">${weatherIcon(s.weather.kind)} ${esc(w.label)}</span>
        <span class="speeds">${speeds.map((v) => `<button data-act="speed" data-id="${v}" class="${v === sp ? "on" : ""}">${v === 0 ? "❚❚" : `${v}×`}</button>`).join("")}</span>
      </div>
      <div class="hud-row sub">
        <span title="Coal in stockpiles">COAL ${tonnes(coal)}</span>
        <span title="Coal mined on the last full day">PRODUCTION ${tonnes(prod)}/day</span>
        <span title="Estimated coal in planned blocks, from known geology only">RESERVES ~${tonnes(reserves)}</span>
        <span class="${safety < 70 ? "bad" : safety < 85 ? "warn" : "good"}" title="Mine safety index">SAFETY ${safety}%</span>
        <span class="overlays">${OVERLAYS.map((o) => `<button data-act="overlay" data-id="${o}" class="${o === this.api.overlay() ? "on" : ""}">${o}</button>`).join("")}</span>
        <span class="cams">${(["ISOMETRIC", "FREE", "OVERVIEW", "FOLLOW"] as const).map((m) => `<button data-act="cam" data-id="${m}" class="${m === this.api.cameraMode() ? "on" : ""}">${m}</button>`).join("")}</span>
      </div>`);
  }

  private renderFeed(): void {
    const notes = this.sim.state.notifications.slice(-40).reverse();
    const key = `${notes[0]?.id ?? ""}|${this.feedOpen}`;
    if (key === this.lastFeed) return;
    this.lastFeed = key;
    $("#feed").innerHTML = `<div class="feed-head"><b>Notifications</b><button data-act="feed-toggle">${this.feedOpen ? "–" : "+"}</button></div>` + (this.feedOpen
      ? notes
          .map((n) => {
            const subj = n.subject ? `data-act="select-${n.subject.kind}" data-id="${esc(n.subject.id)}"` : "";
            return `<div class="note ${n.severity}" ${subj}><span class="t">${clockOf(n.minute)}</span> <b>${esc(n.title)}</b>${n.text ? `<div>${esc(n.text)}</div>` : ""}</div>`;
          })
          .join("")
      : "");
  }

  private renderObjectives(): void {
    const obj = this.sim.state.objectives;
    const next = obj.find((o) => !o.done);
    morph($("#objectives"), `<b>Chapter 1 · The Inheritance</b>` + obj.map((o) => `<div class="obj ${o.done ? "done" : o === next ? "next" : ""}">${o.done ? "✔" : o === next ? "▶" : "○"} ${esc(o.title)}</div>`).join("") + (next ? `<div class="hint">${esc(objectiveHint(next.id))}</div>` : `<div class="hint">The slice is complete — keep growing the mine.</div>`));
  }

  // ---------------------------------------------------------------- context panel (selection)

  private renderContext(): void {
    const sel = this.api.selection;
    const el = $("#context");
    if (!sel) {
      el.innerHTML = "";
      el.classList.remove("open");
      return;
    }
    el.classList.add("open");
    let html = "";
    if (sel.kind === "equipment") html = this.equipmentPanel(sel.id);
    else if (sel.kind === "block") html = this.blockPanel(sel.id);
    else if (sel.kind === "worker") html = this.workerPanel(sel.id);
    else if (sel.kind === "task") html = this.taskPanel(sel.id);
    else if (sel.kind === "point") html = this.pointPanel(sel.x, sel.z);
    morph(el, `<button class="close" data-act="deselect">✕</button>${html}`);
  }

  private equipmentPanel(id: string): string {
    const sim = this.sim;
    const eq = sim.equipment(id);
    if (!eq) return "<p>Gone.</p>";
    const def = sim.def(eq);
    const op = sim.worker(eq.operatorId);
    const task = sim.task(eq.currentTaskId);
    const risk = equipmentRisk(sim, eq);
    const cap = def.category === "HAUL_TRUCK" ? payloadCapacity(sim, eq, eq.payload?.type ?? "OVERBURDEN") : 0;
    const up = eq.upgrades.map((u) => sim.catalog.upgrades.get(u)?.name ?? u);
    return `
      <h2>${esc(eq.name)}</h2>
      <div class="muted">${esc(def.name)} · ${esc(label(eq.state))}${eq.evacuating ? " · <b class='warn'>holding for blast</b>" : ""}</div>
      <table class="kv">
        <tr><td>Condition</td><td>${bar(eq.condition / 100, conditionClass(eq.condition))} ${eq.condition.toFixed(0)}% <span class="muted">${conditionBand(eq.condition)}</span></td></tr>
        <tr><td>Fuel</td><td>${bar(fuelFraction(sim, eq), fuelFraction(sim, eq) < 0.2 ? "bad" : "")} ${pct(fuelFraction(sim, eq))} <span class="muted">${Math.round(eq.fuelL)} L</span></td></tr>
        <tr><td>Hours</td><td>${Math.round(eq.operatingHours).toLocaleString()} <span class="muted">${Math.round(eq.hoursSinceService)} h since service (every ${def.maintenanceIntervalH} h)</span></td></tr>
        <tr><td>Operator</td><td>${op ? `<a data-act="select-worker" data-id="${op.id}">${esc(op.name)}</a> <span class="muted">fatigue ${op.fatigue.toFixed(0)}%</span>` : "<span class='warn'>none</span>"}</td></tr>
        <tr><td>Task</td><td>${task ? `<a data-act="select-task" data-id="${task.id}">${esc(task.label)}</a><div class="muted">${esc(label(task.status))}${task.blockedReason ? ` — <span class="bad">${esc(task.blockedReason)}</span>` : task.note ? ` — ${esc(task.note)}` : ""}</div>` : "<span class='muted'>idle</span>"}</td></tr>
        ${def.category === "HAUL_TRUCK" ? `<tr><td>Payload</td><td>${eq.payload ? `${tonnes(eq.payload.tonnes)} ${esc(MATERIAL_LABEL[eq.payload.type].toLowerCase())}` : "empty"} <span class="muted">/ ${Math.round(cap)} t</span></td></tr>` : ""}
        ${eq.breakdown ? `<tr><td>Fault</td><td class="bad">${esc(eq.breakdown.cause)}</td></tr>` : ""}
        <tr><td>Risk</td><td><span class="risk ${risk.category}">${risk.category}</span> ${risk.score.toFixed(0)} <div class="muted">${risk.factors.slice(0, 3).map((f) => `${esc(f.label)} +${f.points}`).join(" · ") || "no significant factors"}</div></td></tr>
        <tr><td>Upgrades</td><td>${up.length ? up.map(esc).join(", ") : "<span class='muted'>standard</span>"}</td></tr>
        <tr><td>Totals</td><td class="muted">${tonnes(eq.stats.tonnesMoved)} moved · ${eq.stats.loads} loads · ${formatDuration(eq.stats.workingMin)} working · ${formatDuration(eq.stats.downMin)} down</td></tr>
      </table>
      <div class="buttons">
        <button data-act="eq-assign" data-id="${eq.id}" class="primary">ASSIGN TASK</button>
        <button data-act="eq-operator" data-id="${eq.id}">CHANGE OPERATOR</button>
        <button data-act="eq-fuel" data-id="${eq.id}">FUEL</button>
        <button data-act="eq-maint" data-id="${eq.id}">MAINTENANCE</button>
        <button data-act="eq-repair" data-id="${eq.id}" ${eq.state === "BROKEN" ? "class='warn'" : "disabled"}>REPAIR</button>
        <button data-act="eq-upgrade" data-id="${eq.id}">UPGRADE</button>
        <button data-act="eq-park" data-id="${eq.id}">PARK</button>
        <button data-act="eq-follow" data-id="${eq.id}">FOLLOW</button>
        ${task ? `<button data-act="task-cancel" data-id="${task.id}">STOP TASK</button>` : ""}
      </div>`;
  }

  private blockPanel(id: string): string {
    const sim = this.sim;
    const b = sim.block(id);
    if (!b) return "";
    const a = analyzeBlock(sim, b);
    const e = estimateBlock(sim, b);
    const pattern = sim.state.drillPatterns.find((p) => p.id === b.patternId);
    const blast = sim.state.blasts.find((x) => x.id === b.blastId);
    const active = sim.state.tasks.filter((t) => !TERMINAL.has(t.status) && (t.destination?.kind === "block" && t.destination.id === b.id));
    const stripped = a.topsoilT < 1;
    return `
      <h2>${esc(b.name)}</h2>
      <div class="muted">${esc(label(b.state))} · ${a.areaM2.toLocaleString()} m²</div>
      <h3>What the geology says <span class="muted">(confidence ${pct(e.meanConfidence)})</span></h3>
      <table class="kv">
        <tr><td>Seam roof</td><td>${e.meanRoofDepth !== null ? `~${e.meanRoofDepth.toFixed(1)} m deep` : "<span class='warn'>unknown — drill an exploration hole</span>"}</td></tr>
        <tr><td>Coal in place</td><td>${e.coalT !== null ? `~${tonnes(e.coalT)}` : "unknown"}</td></tr>
        <tr><td>Strip ratio</td><td>${e.stripRatio !== null ? `~${e.stripRatio.toFixed(2)} bcm/t` : "unknown"}</td></tr>
      </table>
      <h3>At the face</h3>
      <table class="kv">
        <tr><td>Topsoil</td><td>${tonnes(a.topsoilT)}${stripped ? " <span class='good'>stripped</span>" : ""}</td></tr>
        <tr><td>Overburden left</td><td>${tonnes(a.overburdenT)}${a.unblastedRockT > 1 ? ` <span class="warn">(${tonnes(a.unblastedRockT)} unblasted)</span>` : ""}</td></tr>
        <tr><td>Coal exposed</td><td>${tonnes(a.exposedCoalT)}</td></tr>
        <tr><td>Moved so far</td><td>${tonnes(b.overburdenMovedT)} overburden · ${tonnes(b.coalMinedT)} coal${b.coalLostT > 1 ? ` · <span class="warn">${tonnes(b.coalLostT)} lost</span>` : ""}</td></tr>
        ${pattern ? `<tr><td>Drill pattern</td><td>${pattern.holes.filter((h) => h.drilled).length}/${pattern.holes.length} holes · ${pattern.spacing}×${pattern.burden} m · ${pattern.depthMode === "TO_COAL" ? "to coal" : `${pattern.depth} m fixed`}</td></tr>` : ""}
        ${blast ? `<tr><td>Blast</td><td>${esc(label(blast.state))} · fragmentation ${pct(blast.fragmentation)}${blast.coalDamageEstimateT > 1 ? ` · <span class="warn">~${tonnes(blast.coalDamageEstimateT)} coal damage</span>` : ""}</td></tr>` : ""}
        ${b.fragmentation !== null ? `<tr><td>Fragmentation</td><td>${pct(b.fragmentation)}</td></tr>` : ""}
      </table>
      ${active.length ? `<h3>Work in progress</h3>${active.map((t) => `<div><a data-act="select-task" data-id="${t.id}">${esc(t.label)}</a> <span class="muted">${esc(label(t.status))} ${pct(t.progress)}</span>${t.blockedReason ? `<div class="bad">${esc(t.blockedReason)}</div>` : ""}</div>`).join("")}` : ""}
      <div class="buttons">
        <button class="primary" data-act="block-work" data-id="${b.id}" data-mode="OVERBURDEN" ${a.overburdenT < 1 ? "disabled" : ""} title="Drill, blast, excavate and haul — one order">REMOVE OVERBURDEN</button>
        <button class="primary" data-act="block-work" data-id="${b.id}" data-mode="COAL" ${a.coalT < 1 ? "disabled" : ""}>MINE COAL</button>
        <button data-act="block-strip" data-id="${b.id}" ${stripped ? "disabled" : ""}>STRIP TOPSOIL (dozer)</button>
        <button data-act="block-drill" data-id="${b.id}">DRILL PATTERN…</button>
        <button data-act="block-blast" data-id="${b.id}" ${pattern ? "" : "disabled"}>BLAST…</button>
        <button data-act="explore-here" data-id="${b.id}">EXPLORATION HOLE</button>
      </div>`;
  }

  private workerPanel(id: string): string {
    const sim = this.sim;
    const w = sim.worker(id);
    if (!w) return "";
    const eq = sim.equipment(w.assignedEquipmentId);
    const skills = Object.entries(w.skills)
      .map(([k, v]) => `<tr><td>${esc(label(k.replace(/([A-Z])/g, "_$1")))}</td><td>${bar(v)} ${pct(v)}</td></tr>`)
      .join("");
    return `
      <h2>${esc(w.name)}</h2>
      <div class="muted">${esc(roleLabel(w.role))} · age ${w.age} · ${w.experienceYears} yrs · $${w.wagePerHour}/h · ${esc(w.activity)}</div>
      <table class="kv">
        <tr><td>Fatigue</td><td>${bar(w.fatigue / 100, w.fatigue > 70 ? "bad" : w.fatigue > 45 ? "warn" : "good")} ${w.fatigue.toFixed(0)}%</td></tr>
        <tr><td>Morale</td><td>${bar(w.morale / 100)} ${w.morale.toFixed(0)}%</td></tr>
        <tr><td>Machine</td><td>${eq ? `<a data-act="select-equipment" data-id="${eq.id}">${esc(eq.name)}</a>` : "<span class='muted'>none</span>"}</td></tr>
        <tr><td>Certifications</td><td>${w.certifications.map((c) => `<span class="chip ${c.expiresDay !== null && c.expiresDay < sim.day ? "bad" : ""}">${esc(certLabel(c.type))}${c.expiresDay !== null ? ` (to day ${c.expiresDay})` : ""}</span>`).join(" ") || "<span class='muted'>none</span>"}</td></tr>
        <tr><td>Hours</td><td>${w.hoursToday.toFixed(1)} today · ${Math.round(w.totalHours)} total</td></tr>
      </table>
      <h3>Skills</h3><table class="kv">${skills}</table>
      <div class="buttons">
        ${["HAUL_TRUCK", "EXCAVATOR", "DOZER", "DRILL", "BLASTER"].map((c) => `<button data-act="train" data-id="${w.id}" data-cert="${c}">TRAIN ${esc(certLabel(c).toUpperCase())}</button>`).join("")}
        <button data-act="dismiss" data-id="${w.id}" class="warn">DISMISS</button>
      </div>`;
  }

  private taskPanel(id: string): string {
    const sim = this.sim;
    const t = sim.task(id);
    if (!t) return "";
    const eq = sim.equipment(t.assignedEquipmentId);
    const w = sim.worker(t.assignedWorkerId);
    return `
      <h2>${esc(t.label)}</h2>
      <div class="muted">${esc(t.id)} · ${esc(TASK_LABEL[t.type])} · priority ${esc(t.priority)}</div>
      <table class="kv">
        <tr><td>Status</td><td><span class="status ${t.status}">${esc(label(t.status))}</span> ${t.phase !== "start" ? `<span class="muted">(${esc(t.phase)})</span>` : ""}</td></tr>
        ${t.blockedReason ? `<tr><td>Blocked</td><td class="bad">${esc(t.blockedReason)}</td></tr>` : ""}
        ${t.note ? `<tr><td>Note</td><td>${esc(t.note)}</td></tr>` : ""}
        ${t.failureReason ? `<tr><td>Reason</td><td>${esc(t.failureReason)}</td></tr>` : ""}
        <tr><td>Progress</td><td>${bar(t.progress)} ${pct(t.progress)}${t.estimatedDuration !== null && !TERMINAL.has(t.status) ? ` <span class="muted">~${formatDuration(t.estimatedDuration)} left</span>` : ""}</td></tr>
        <tr><td>Equipment</td><td>${eq ? `<a data-act="select-equipment" data-id="${eq.id}">${esc(eq.name)}</a>` : t.requiredEquipmentCategory ? `any ${esc(label(t.requiredEquipmentCategory))}` : "—"}</td></tr>
        <tr><td>Worker</td><td>${w ? `<a data-act="select-worker" data-id="${w.id}">${esc(w.name)}</a>` : t.requiredCertification ? `needs ${esc(certLabel(t.requiredCertification))}` : "—"}</td></tr>
        ${t.materialAmount > 0 ? `<tr><td>Material</td><td>${tonnes(t.materialAmount)}${t.materialType ? ` ${esc(MATERIAL_LABEL[t.materialType].toLowerCase())}` : ""}</td></tr>` : ""}
        ${t.prerequisites.length ? `<tr><td>After</td><td>${t.prerequisites.map((p) => { const x = sim.task(p); return `<a data-act="select-task" data-id="${p}">${esc(x?.label ?? p)}</a> <span class="muted">${esc(label(x?.status ?? ""))}</span>`; }).join("<br>")}</td></tr>` : ""}
        <tr><td>Created</td><td>${clockOf(t.createdAt)}${t.startedAt !== null ? ` · started ${clockOf(t.startedAt)}` : ""}${t.completedAt !== null ? ` · ended ${clockOf(t.completedAt)}` : ""}</td></tr>
      </table>
      <div class="buttons">${!TERMINAL.has(t.status) ? `<button class="warn" data-act="task-cancel" data-id="${t.id}">CANCEL TASK</button>` : ""}</div>`;
  }

  private pointPanel(x: number, z: number): string {
    const sim = this.sim;
    const t = sim.terrain;
    const { i, j } = t.cellOf(x, z);
    const k = t.index(i, j);
    const e = estimateAt(sim.state.samples, x, z);
    return `
      <h2>Ground at ${x.toFixed(0)}, ${z.toFixed(0)}</h2>
      <table class="kv">
        <tr><td>Elevation</td><td>${t.state.surface[k].toFixed(1)} m <span class="muted">(${(t.state.surface[k] - t.state.original[k]).toFixed(1)} m vs original)</span></td></tr>
        <tr><td>Geology</td><td>${esc(label(e.state))} · confidence ${pct(e.confidence)}</td></tr>
        <tr><td>Seam roof</td><td>${e.seamTopElevation !== null ? `~${(t.state.surface[k] - e.seamTopElevation).toFixed(1)} m below` : "unknown"}</td></tr>
        <tr><td>Thickness</td><td>${e.thickness !== null ? `~${e.thickness.toFixed(2)} m` : "unknown"}</td></tr>
        ${e.quality ? `<tr><td>Quality</td><td>ash ${e.quality.ash.toFixed(1)}% · S ${e.quality.sulfur.toFixed(2)}% · ${Math.round(e.quality.btu).toLocaleString()} BTU/lb</td></tr>` : ""}
      </table>
      <div class="buttons"><button class="primary" data-act="explore-point" data-x="${x}" data-z="${z}">DRILL EXPLORATION HOLE HERE</button></div>`;
  }

  // ---------------------------------------------------------------- drawers

  private renderDrawer(): void {
    const el = $("#drawer");
    for (const b of Array.from(document.querySelectorAll("#tabs button"))) b.classList.toggle("on", (b as HTMLElement).dataset.id === this.tab);
    if (!this.tab) {
      el.classList.remove("open");
      el.innerHTML = "";
      return;
    }
    el.classList.add("open");
    const sim = this.sim;
    const s = sim.state;
    let html = "";
    switch (this.tab) {
      case "MINE": {
        html = `<h2>Mine plan</h2><table class="grid"><tr><th>Block</th><th>State</th><th>Est. coal</th><th>Strip ratio</th><th>Confidence</th><th>Overburden left</th><th>Coal mined</th><th></th></tr>${s.blocks
          .map((b) => {
            const e = estimateBlock(sim, b);
            const a = analyzeBlock(sim, b);
            return `<tr data-act="select-block" data-id="${b.id}" class="${this.api.selection?.kind === "block" && this.api.selection.id === b.id ? "sel" : ""}"><td>${esc(b.name)}</td><td>${esc(label(b.state))}</td><td>${e.coalT !== null ? tonnes(e.coalT) : "?"}</td><td>${e.stripRatio !== null ? e.stripRatio.toFixed(2) : "?"}</td><td>${pct(e.meanConfidence)}</td><td>${tonnes(a.overburdenT)}</td><td>${tonnes(b.coalMinedT)}</td><td><button data-act="select-block" data-id="${b.id}">OPEN</button></td></tr>`;
          })
          .join("")}</table>
          <h3>Stockpiles &amp; dumps</h3><table class="grid"><tr><th>Name</th><th>Holds</th><th>Room</th><th>Quality</th></tr>
          ${s.stockpiles.map((p) => `<tr><td>${esc(p.name)}</td><td>${tonnes(p.tonnes)}</td><td>${tonnes(p.capacityT - p.tonnes)}</td><td>${p.quality ? `ash ${p.quality.ash.toFixed(1)}% · S ${p.quality.sulfur.toFixed(2)}% · ${Math.round(p.quality.btu).toLocaleString()} BTU` : "—"}</td></tr>`).join("")}
          ${s.dumps.map((d) => `<tr><td>${esc(d.name)}</td><td>${tonnes(d.tonnes)}</td><td>${tonnes(dumpCapacityLeftT(sim, d))}</td><td class="muted">${esc(label(d.accepts))}</td></tr>`).join("")}</table>
          <div class="buttons"><button data-act="explore-pick" class="primary">DRILL EXPLORATION HOLE…</button><button data-act="overlay" data-id="GEOLOGY">SHOW GEOLOGY</button></div>
          <h3>Haul roads</h3><table class="grid"><tr><th>Road</th><th>Condition</th><th>Limit</th></tr>${s.roadEdges.map((r) => `<tr><td>${esc(r.a)} → ${esc(r.b)}</td><td>${bar(r.condition / 100, conditionClass(r.condition))} ${roadConditionLabel(r.condition)}</td><td>${r.speedLimitKmh} km/h</td></tr>`).join("")}</table>`;
        break;
      }
      case "EQUIPMENT": {
        html = `<h2>Fleet</h2><table class="grid"><tr><th>Unit</th><th>Model</th><th>State</th><th>Condition</th><th>Fuel</th><th>Operator</th><th>Task</th></tr>${s.equipment
          .map((e) => {
            const t = sim.task(e.currentTaskId);
            return `<tr data-act="select-equipment" data-id="${e.id}" class="${this.api.selection?.kind === "equipment" && this.api.selection.id === e.id ? "sel" : ""}"><td>${esc(e.name)}</td><td>${esc(sim.def(e).model)}</td><td>${esc(label(e.state))}</td><td>${bar(e.condition / 100, conditionClass(e.condition))} ${e.condition.toFixed(0)}%</td><td>${pct(fuelFraction(sim, e))}</td><td>${esc(sim.worker(e.operatorId)?.name ?? "—")}</td><td>${t ? esc(t.label) + (t.blockedReason ? ` <span class="bad">⚠</span>` : "") : "—"}</td></tr>`;
          })
          .join("")}</table>
          <h3>Buy equipment</h3><table class="grid"><tr><th>Model</th><th>Category</th><th>Key spec</th><th>Price</th><th></th></tr>${[...sim.catalog.equipment.values()]
            .map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(label(d.category))}</td><td>${d.payloadT ? `${d.payloadT} t payload` : d.bucketM3 ? `${d.bucketM3} m³ bucket` : d.penetrationMph ? `${d.penetrationMph} m/h` : d.stripRateM3h ? `${d.stripRateM3h} m³/h` : ""} · ${esc(d.requiredCertification ? certLabel(d.requiredCertification) : "")}</td><td>${money(d.purchasePrice)}</td><td><button data-act="buy" data-id="${d.id}" ${sim.canAfford(d.purchasePrice) ? "" : "disabled"}>BUY</button></td></tr>`)
            .join("")}</table>`;
        break;
      }
      case "WORKERS": {
        html = `<h2>Workforce <span class="muted">shift ${esc(shiftLabel(sim))}</span></h2><table class="grid"><tr><th>Name</th><th>Role</th><th>Certifications</th><th>Fatigue</th><th>Activity</th><th>Machine</th><th>Wage</th></tr>${s.workers
          .filter((w) => w.employmentStatus !== "TERMINATED")
          .map((w) => `<tr data-act="select-worker" data-id="${w.id}"><td>${esc(w.name)}</td><td>${esc(roleLabel(w.role))}</td><td>${w.certifications.map((c) => `<span class="chip ${c.expiresDay !== null && c.expiresDay < sim.day ? "bad" : ""}">${esc(certLabel(c.type))}</span>`).join(" ")}</td><td>${bar(w.fatigue / 100, w.fatigue > 70 ? "bad" : "")} ${w.fatigue.toFixed(0)}%</td><td>${esc(w.activity)}</td><td>${esc(sim.equipment(w.assignedEquipmentId)?.name ?? "—")}</td><td>$${w.wagePerHour}/h</td></tr>`)
          .join("")}</table>
          <h3>Applicants</h3><table class="grid"><tr><th>Name</th><th>Role</th><th>Experience</th><th>Skill</th><th>Certifications</th><th>Wage</th><th></th></tr>${s.candidates
            .map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(roleLabel(c.role))}</td><td>${c.experienceYears} yrs</td><td>${pct(c.skills.equipmentOperation)}</td><td>${c.certifications.map((x) => `<span class="chip">${esc(certLabel(x.type))}</span>`).join(" ")}</td><td>$${c.wagePerHour}/h</td><td><button data-act="hire" data-id="${c.id}">HIRE</button></td></tr>`)
            .join("")}</table>`;
        break;
      }
      case "TASKS": {
        const list = sortedTasks(sim);
        const done = s.tasks.filter((t) => TERMINAL.has(t.status)).slice(-12).reverse();
        const row = (t: Task) => `<tr data-act="select-task" data-id="${t.id}"><td>${esc(t.id)}</td><td>${esc(t.label)}</td><td><span class="status ${t.status}">${esc(label(t.status))}</span></td><td>${esc(sim.equipment(t.assignedEquipmentId)?.name ?? "—")}</td><td>${esc(sim.worker(t.assignedWorkerId)?.name ?? "—")}</td><td>${bar(t.progress)}</td><td class="${t.blockedReason ? "bad" : "muted"}">${esc(t.blockedReason ?? t.note ?? t.failureReason ?? "")}</td><td>${!TERMINAL.has(t.status) ? `<button data-act="task-cancel" data-id="${t.id}">CANCEL</button>` : ""}</td></tr>`;
        html = `<h2>Task queue</h2><table class="grid"><tr><th>ID</th><th>Task</th><th>Status</th><th>Machine</th><th>Worker</th><th>Progress</th><th>Detail</th><th></th></tr>${list.map(row).join("") || `<tr><td colspan="8" class="muted">No active tasks. Select a block and order REMOVE OVERBURDEN, or select a machine and ASSIGN TASK.</td></tr>`}</table>
          <h3>Recently finished</h3><table class="grid">${done.map(row).join("")}</table>`;
        break;
      }
      case "LAND": {
        html = `<h2>Land &amp; mineral rights</h2><table class="grid"><tr><th>Parcel</th><th>Status</th><th>Surface owner</th><th>Mineral owner</th><th>Royalty</th></tr>${s.parcels
          .map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(label(p.status))}</td><td>${esc(p.surfaceOwner)}</td><td>${esc(p.mineralOwner)}</td><td>${pct(p.royalty, 1)}</td></tr>`)
          .join("")}</table><p class="muted">Land acquisition and negotiation with neighbouring landowners arrive in development phase 11.</p>`;
        break;
      }
      case "PERMITS": {
        html = `<h2>Permits</h2><table class="grid"><tr><th>Permit</th><th>Type</th><th>Status</th><th>Expires</th><th>Conditions</th><th></th></tr>${s.permits
          .map((p) => {
            const valid = permitValid(sim, p);
            const soon = p.expirationDay !== null && p.expirationDay - sim.day <= 14;
            return `<tr><td>${esc(p.name)}</td><td>${esc(label(p.type))}</td><td class="${valid ? (soon ? "warn" : "good") : "bad"}">${esc(label(p.status))}</td><td>${p.expirationDay !== null ? `day ${p.expirationDay}${valid ? ` (${p.expirationDay - sim.day} d)` : ""}` : "—"}</td><td class="muted">${p.conditions.map(esc).join("; ")}</td><td><button data-act="renew" data-id="${p.id}">RENEW ${money(p.renewalCost)}</button></td></tr>`;
          })
          .join("")}</table>`;
        break;
      }
      case "FINANCE": {
        const t = s.today;
        const exp = Object.entries(t.expenses).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
        html = `<h2>Finance</h2><div class="cols"><div><table class="kv"><tr><td>Cash</td><td>${money(s.treasury.cash)}</td></tr><tr><td>Credit line</td><td>${money(s.treasury.creditLimit)}</td></tr><tr><td>Debt</td><td>${money(s.treasury.debt)}</td></tr><tr><td>Fuel price</td><td>$${s.fuelPricePerL.toFixed(2)}/L</td></tr></table>
          <h3>Today so far</h3><table class="kv"><tr><td>Revenue</td><td class="good">${money(t.revenue)}</td></tr>${exp.map(([k, v]) => `<tr><td>${esc(label(k))}</td><td>${money(-(v ?? 0))}</td></tr>`).join("")}</table>
          <div class="buttons"><button class="primary" data-act="sell-dialog">SELL COAL…</button></div></div>
          <div><h3>Ledger</h3><table class="grid small">${s.treasury.ledger.slice(-40).reverse().map((x) => `<tr><td class="muted">${clockOf(x.minute)}</td><td>${esc(x.memo)}</td><td class="${x.amount >= 0 ? "good" : ""}">${money(x.amount, true)}</td></tr>`).join("")}</table></div></div>
          <h3>Customers</h3><table class="grid"><tr><th>Customer</th><th>Price</th><th>Max ash</th><th>Max S</th><th>Min BTU</th><th>Taken today</th></tr>${s.customers.map((c) => `<tr><td>${esc(c.name)}</td><td>$${c.price.toFixed(2)}/t</td><td>${c.maxAsh}%</td><td>${c.maxSulfur}%</td><td>${c.minBtu.toLocaleString()}</td><td>${tonnes(c.takenTodayT)} / ${tonnes(c.dailyDemandT)}</td></tr>`).join("")}</table>`;
        break;
      }
      case "PLANT":
        html = `<h2>Preparation plant</h2><p class="muted">The first slice sells raw (run-of-mine) coal straight from the ROM stockpile. Crusher, screens, separators and loadout are development phase 09; conveyors are phase 08.</p>`;
        break;
      case "SAFETY": {
        const rows = s.equipment.map((e) => ({ e, r: equipmentRisk(sim, e) })).sort((a, b) => b.r.score - a.r.score);
        html = `<h2>Safety <span class="muted">index ${mineSafetyIndex(sim)}%</span></h2><table class="grid"><tr><th>Machine</th><th>Risk</th><th>Why</th></tr>${rows
          .map(({ e, r }) => `<tr data-act="select-equipment" data-id="${e.id}"><td>${esc(e.name)}</td><td><span class="risk ${r.category}">${r.category}</span> ${r.score.toFixed(0)}</td><td class="muted">${r.factors.map((f) => `${esc(f.label)} +${f.points}`).join(" · ") || "—"}</td></tr>`)
          .join("")}</table>
          <h3>Incident reports</h3>${s.incidents.length ? s.incidents.slice(-12).reverse().map((i) => `<div class="incident"><b>${esc(i.title)}</b> <span class="muted">${clockOf(i.minute)} · ${money(i.cost)}</span><div>${esc(i.description)}</div><div class="muted">Contributing: ${i.contributors.map(esc).join("; ") || "none identified"}</div></div>`).join("") : `<p class="muted">No incidents. Inspections, violations and the MSHA system arrive in phase 13.</p>`}`;
        break;
      }
      case "REPORTS": {
        const days = [...s.history.slice(-14), s.today];
        const maxT = Math.max(1, ...days.map((d) => d.overburdenT + d.coalMinedT));
        const w = 26;
        const svg = `<svg class="chart" viewBox="0 0 ${days.length * w + 40} 130" preserveAspectRatio="xMinYMid meet">${days
          .map((d, i) => {
            const ob = (d.overburdenT / maxT) * 100;
            const co = (d.coalMinedT / maxT) * 100;
            return `<rect x="${30 + i * w}" y="${110 - ob}" width="${w - 6}" height="${ob}" class="ob"><title>Day ${d.day}: ${Math.round(d.overburdenT)} t overburden</title></rect><rect x="${30 + i * w}" y="${110 - ob - co}" width="${w - 6}" height="${co}" class="coal"><title>Day ${d.day}: ${Math.round(d.coalMinedT)} t coal</title></rect><text x="${30 + i * w + (w - 6) / 2}" y="124" text-anchor="middle">${d.day}</text>`;
          })
          .join("")}<text x="0" y="12">${tonnes(maxT)}</text></svg>`;
        html = `<h2>Daily reports</h2><div class="legend"><span class="sw ob"></span> overburden <span class="sw coal"></span> coal mined</div>${svg}<table class="grid"><tr><th>Day</th><th>Overburden</th><th>Coal mined</th><th>Sold</th><th>Revenue</th><th>Costs</th><th>Fuel</th><th>Utilisation</th><th>Incidents</th></tr>${days
          .slice()
          .reverse()
          .map((d) => {
            const cost = Object.values(d.expenses).reduce((a, b) => a + (b ?? 0), 0);
            const util = d.equipmentWorkingMin / Math.max(1, d.equipmentWorkingMin + d.equipmentIdleMin + d.equipmentDownMin);
            return `<tr><td>${d.day}${d === s.today ? " (today)" : ""}</td><td>${tonnes(d.overburdenT)}</td><td>${tonnes(d.coalMinedT)}</td><td>${tonnes(d.coalSoldT)}</td><td>${money(d.revenue)}</td><td>${money(cost)}</td><td>${Math.round(d.fuelL).toLocaleString()} L</td><td>${pct(util)}</td><td>${d.incidents}</td></tr>`;
          })
          .join("")}</table>`;
        break;
      }
      case "SETTINGS": {
        html = `<h2>Settings</h2>
          <label class="toggle"><input type="checkbox" data-set="autoFuel" ${s.settings.autoFuel ? "checked" : ""}> Auto-refuel (trucks drive to the fuel station; a fuel truck serves excavators, drills and dozers)</label>
          <label class="toggle"><input type="checkbox" data-set="autoMaintenance" ${s.settings.autoMaintenance ? "checked" : ""}> Auto-file repairs when a machine breaks down</label>
          <h3>Save &amp; load</h3><div class="buttons">${[1, 2, 3].map((n) => `<button data-act="save" data-id="slot${n}">SAVE ${n}</button><button data-act="load" data-id="slot${n}">LOAD ${n}</button>`).join("")}</div>
          <div class="buttons"><button data-act="export">EXPORT SAVE FILE</button><button data-act="import">IMPORT SAVE FILE</button><button data-act="new" class="warn">NEW GAME</button></div>
          <h3>Controls</h3><p class="muted">Left-drag: pan · Right-drag / Alt+drag: orbit · Wheel: zoom · WASD/arrows: pan · Q/E: rotate · R/F: tilt · Space: pause · 1–9: speed · G: geology overlay · Esc: close · \`: developer panel (debug builds, ?dev=1)</p>`;
        break;
      }
    }
    morph(el, `<button class="close" data-act="tab" data-id="${this.tab}">✕</button>${html}`);
  }

  // ---------------------------------------------------------------- dialogs

  private openDialog(html: string, onInput?: (root: HTMLElement) => void): HTMLElement {
    const m = $("#modal");
    m.innerHTML = `<div class="dialog">${html}</div>`;
    m.classList.add("open");
    this.dialogOpen = true;
    const root = m.firstElementChild as HTMLElement;
    if (onInput) {
      root.addEventListener("input", () => onInput(root));
      root.addEventListener("change", () => onInput(root));
      onInput(root);
    }
    return root;
  }

  closeDialog(): void {
    const m = $("#modal");
    m.classList.remove("open");
    m.innerHTML = "";
    this.dialogOpen = false;
  }

  /** Spec §46: type, source, destination, operator, priority — with validation before ASSIGN. */
  private taskDialog(eq: EquipmentInstance, preset: Partial<TaskSpec> = {}): void {
    const sim = this.sim;
    const def = sim.def(eq);
    const types = (Object.keys(TASK_LABEL) as TaskType[]).filter((t) => {
      const cat = TASK_CATEGORY[t];
      if (t === "BLAST" || t === "REPAIR") return false;
      return cat === null || cat === def.category;
    });
    const excavations = sim.state.tasks.filter((t) => t.type === "EXCAVATE" && !TERMINAL.has(t.status));
    const operators = sim.state.workers.filter((w) => !qualificationProblem(sim, w, def.requiredRole, def.requiredCertification));
    let point: { x: number; z: number } | null = preset.destination?.kind === "point" ? { x: preset.destination.x, z: preset.destination.z } : null;
    const blocks = sim.state.blocks;
    const html = `
      <h2>Create task — ${esc(eq.name)}</h2>
      <div class="form">
        <label>Type <select name="type">${types.map((t) => `<option value="${t}" ${preset.type === t ? "selected" : ""}>${esc(TASK_LABEL[t])}</option>`).join("")}</select></label>
        <label class="f-mode">Dig <select name="mode"><option value="OVERBURDEN">Overburden</option><option value="COAL">Coal</option></select></label>
        <label class="f-source">Source <select name="source">${excavations.map((t) => `<option value="${t.id}">${esc(t.label)} (${esc(sim.equipment(t.assignedEquipmentId)?.name ?? "any excavator")})</option>`).join("") || `<option value="">— no excavation running —</option>`}</select></label>
        <label class="f-block">Block <select name="block">${blocks.map((b) => `<option value="${b.id}">${esc(b.name)} · ${esc(label(b.state))}</option>`).join("")}</select></label>
        <label class="f-point">Destination <span class="pt">${point ? `${point.x.toFixed(0)}, ${point.z.toFixed(0)}` : "not set"}</span> <button type="button" data-act="dlg-pick">PICK ON MAP</button></label>
        <label class="f-depth">Hole depth <input name="depth" type="number" min="5" max="${def.maxHoleDepthM ?? 40}" value="30"> m</label>
        <label>Operator <select name="operator"><option value="">Automatic (${esc(sim.worker(eq.operatorId)?.name ?? "best available")})</option>${operators.map((w) => `<option value="${w.id}">${esc(w.name)}${isOnShift(sim, w) ? "" : " (off shift)"}</option>`).join("")}</select></label>
        <label>Priority <select name="priority">${(["EMERGENCY", "CRITICAL", "HIGH", "NORMAL", "LOW"] as TaskPriority[]).map((p) => `<option ${p === "NORMAL" ? "selected" : ""}>${p}</option>`).join("")}</select></label>
      </div>
      <div class="validation"></div>
      <div class="buttons right"><button data-act="dlg-cancel">CANCEL</button><button class="primary" data-act="dlg-assign">ASSIGN</button></div>`;
    const read = (root: HTMLElement): TaskSpec => {
      const f = (n: string) => (root.querySelector(`[name=${n}]`) as HTMLInputElement | HTMLSelectElement | null)?.value ?? "";
      const type = f("type") as TaskType;
      const spec: TaskSpec = { type, equipmentId: eq.id, priority: f("priority") as TaskPriority, workerId: f("operator") || null };
      if (type === "HAUL") spec.source = f("source") ? { kind: "task", id: f("source") } : null;
      if (type === "EXCAVATE" || type === "STRIP_TOPSOIL" || type === "DRILL_PATTERN") spec.destination = { kind: "block", id: f("block") };
      if (type === "EXCAVATE") spec.params = { mode: f("mode") as ExcavateMode };
      if (type === "DRILL_PATTERN") {
        const b = sim.block(f("block"));
        const pattern = sim.state.drillPatterns.find((p) => p.id === b?.patternId && p.completedAt === null);
        spec.params = { patternId: pattern?.id ?? "" };
      }
      if (type === "MOVE" || type === "EXPLORE_DRILL") spec.destination = point ? { kind: "point", x: point.x, z: point.z } : null;
      if (type === "EXPLORE_DRILL") spec.params = { depth: Number(f("depth")) || 30 };
      return spec;
    };
    const refresh = (root: HTMLElement): void => {
      const spec = read(root);
      const show = (cls: string, on: boolean) => root.querySelector<HTMLElement>(cls)!.style.setProperty("display", on ? "" : "none");
      show(".f-mode", spec.type === "EXCAVATE");
      show(".f-source", spec.type === "HAUL");
      show(".f-block", spec.type === "EXCAVATE" || spec.type === "STRIP_TOPSOIL" || spec.type === "DRILL_PATTERN");
      show(".f-point", spec.type === "MOVE" || spec.type === "EXPLORE_DRILL");
      show(".f-depth", spec.type === "EXPLORE_DRILL");
      root.querySelector(".pt")!.textContent = point ? `${point.x.toFixed(0)}, ${point.z.toFixed(0)}` : "not set";
      const v = validateTask(sim, spec);
      if (spec.type === "DRILL_PATTERN" && !spec.params?.patternId) v.errors.unshift("This block has no undrilled pattern: use DRILL PATTERN… on the block first");
      root.querySelector(".validation")!.innerHTML =
        v.errors.map((e) => `<div class="bad">✖ ${esc(e)}</div>`).join("") + v.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("") || `<div class="good">✔ Ready to assign</div>`;
      (root.querySelector("[data-act=dlg-assign]") as HTMLButtonElement).disabled = v.errors.length > 0;
      this.api.setMarker(point);
    };
    const root = this.openDialog(html, refresh);
    this.dialogActions = {
      pick: async () => {
        $("#modal").classList.add("picking");
        const p = await this.api.pickPoint("Click the destination on the map (Esc to cancel)");
        $("#modal").classList.remove("picking");
        if (p) point = p;
        refresh(root);
      },
      assign: () => {
        const r = cmd.assignTask(sim, read(root));
        if (!r.ok) {
          root.querySelector(".validation")!.innerHTML = `<div class="bad">✖ ${esc(r.error)}</div>`;
          return;
        }
        this.api.setMarker(null);
        this.closeDialog();
        this.api.select({ kind: "equipment", id: eq.id });
      },
    };
  }

  private dialogActions: Record<string, () => void | Promise<void>> = {};

  private drillDialog(blockId: string): void {
    const sim = this.sim;
    const b = sim.block(blockId)!;
    const est = estimateBlock(sim, b);
    const html = `
      <h2>Drill pattern — ${esc(b.name)}</h2>
      <p class="muted">Estimated seam roof: ${est.meanRoofDepth !== null ? `~${est.meanRoofDepth.toFixed(1)} m (confidence ${pct(est.meanConfidence)})` : "unknown — the driller will look for coal down to the depth cap"}.</p>
      <div class="form">
        <label>Hole spacing <input name="spacing" type="number" min="3" max="10" step="0.5" value="${DEFAULT_PATTERN.spacing}"> m</label>
        <label>Burden <input name="burden" type="number" min="3" max="10" step="0.5" value="${DEFAULT_PATTERN.burden}"> m</label>
        <label>Depth <select name="mode"><option value="TO_COAL">Drill to coal (stop at the roof)</option><option value="FIXED">Fixed depth (with subdrill)</option></select></label>
        <label><span class="lbl-depth">Depth cap</span> <input name="depth" type="number" min="1" max="40" step="0.5" value="14"> m</label>
      </div>
      <div class="estimate"></div>
      <div class="buttons right"><button data-act="dlg-cancel">CANCEL</button><button class="primary" data-act="dlg-assign">DESIGN &amp; DRILL</button></div>`;
    const read = (root: HTMLElement): PatternOptions => {
      const f = (n: string) => (root.querySelector(`[name=${n}]`) as HTMLInputElement).value;
      return { spacing: Number(f("spacing")), burden: Number(f("burden")), depthMode: f("mode") as "TO_COAL" | "FIXED", depth: Number(f("depth")), subdrill: 0.6 };
    };
    const refresh = (root: HTMLElement): void => {
      const o = read(root);
      root.querySelector(".lbl-depth")!.textContent = o.depthMode === "TO_COAL" ? "Depth cap" : "Hole depth";
      // Preview on a pattern that is designed but not stored (designPattern only reads state,
      // apart from taking an id).
      const drill = sim.state.equipment.find((e) => sim.def(e).category === "DRILL") ?? null;
      {
        const p = designPattern(sim, b, o, "preview");
        const e = estimatePattern(sim, p, drill);
        const deep = o.depthMode === "FIXED" && est.meanRoofDepth !== null && o.depth + 0.6 > est.meanRoofDepth;
        const shallow = o.depthMode === "FIXED" && est.meanRoofDepth !== null && o.depth + 1.4 < est.meanRoofDepth;
        root.querySelector(".estimate")!.innerHTML = `<table class="kv"><tr><td>Holes</td><td>${e.holes}</td></tr><tr><td>Drilling</td><td>~${Math.round(e.totalMetres)} m · ~${formatDuration(e.minutes)}</td></tr><tr><td>Cost</td><td>~${money(e.cost)}</td></tr><tr><td>Rock volume</td><td>~${Math.round(e.rockVolumeM3).toLocaleString()} m³</td></tr></table>${deep ? `<div class="warn">⚠ Holes are likely to pass the estimated roof: blast damage will dilute coal.</div>` : ""}${shallow ? `<div class="warn">⚠ Holes stop well above the estimated roof: unblasted rock will be left.</div>` : ""}${o.depthMode === "TO_COAL" ? `<div class="muted">Drill-to-coal protects the seam; holes that find no coal stop at the cap.</div>` : ""}`;
      }
    };
    const root = this.openDialog(html, refresh);
    this.dialogActions = {
      assign: () => {
        const r = cmd.planDrillPattern(sim, b.id, read(root));
        if (!r.ok) {
          root.querySelector(".estimate")!.innerHTML = `<div class="bad">✖ ${esc(r.error)}</div>`;
          return;
        }
        const t = cmd.assignTask(sim, { type: "DRILL_PATTERN", destination: { kind: "block", id: b.id }, params: { patternId: r.value.pattern.id }, label: `Drill ${b.name}` });
        if (!t.ok) {
          root.querySelector(".estimate")!.innerHTML = `<div class="bad">✖ ${esc(t.error)}</div>`;
          return;
        }
        this.closeDialog();
      },
    };
  }

  private blastDialog(blockId: string): void {
    const sim = this.sim;
    const b = sim.block(blockId)!;
    const pattern = sim.state.drillPatterns.find((p) => p.id === b.patternId);
    if (!pattern) return;
    const html = `
      <h2>Blast design — ${esc(b.name)}</h2>
      <p class="muted">${pattern.holes.length} holes on a ${pattern.spacing} × ${pattern.burden} m pattern, ${pattern.holes.filter((h) => h.drilled).length} drilled. Charge level is an abstract game setting, not an explosives specification.</p>
      <div class="form"><label>Charge level <input name="charge" type="range" min="0.6" max="1.4" step="0.05" value="1"> <span class="cv"></span></label></div>
      <div class="estimate"></div>
      <div class="buttons right"><button data-act="dlg-cancel">CANCEL</button><button class="primary" data-act="dlg-assign">SCHEDULE BLAST</button></div>`;
    const charge = (root: HTMLElement) => Number((root.querySelector("[name=charge]") as HTMLInputElement).value);
    const refresh = (root: HTMLElement): void => {
      const cf = charge(root);
      root.querySelector(".cv")!.textContent = cf < 0.85 ? "light" : cf > 1.15 ? "heavy" : "standard";
      const d = designBlast(sim, b, pattern, cf, "preview");
      const r = (v: number) => `${bar(v, v > 0.66 ? "bad" : v > 0.4 ? "warn" : "good")} ${pct(v)}`;
      root.querySelector(".estimate")!.innerHTML = `<table class="kv"><tr><td>Rock broken</td><td>~${tonnes(d.estimatedTonnes)}</td></tr><tr><td>Fragmentation</td><td>${bar(d.fragmentation)} ${pct(d.fragmentation)} <span class="muted">(better = faster digging)</span></td></tr><tr><td>Vibration risk</td><td>${r(d.vibrationRisk)}</td></tr><tr><td>Airblast risk</td><td>${r(d.airblastRisk)}</td></tr><tr><td>Flyrock risk</td><td>${r(d.flyrockRisk)}</td></tr><tr><td>Coal damage</td><td>${d.coalDamageEstimateT > 1 ? `<span class="warn">~${tonnes(d.coalDamageEstimateT)}</span>` : "none expected"}</td></tr><tr><td>Explosives</td><td>${money(d.cost)}</td></tr></table><div class="muted">Fires only between ${sim.state.shift.blastStartHour}:00 and ${sim.state.shift.blastEndHour}:00, not in fog or heavy rain, after a 90 m exclusion zone is cleared.</div>`;
    };
    const root = this.openDialog(html, refresh);
    this.dialogActions = {
      assign: () => {
        const r = cmd.planBlast(sim, b.id, charge(root));
        if (!r.ok) return;
        const drillTask = sim.state.tasks.find((t) => t.type === "DRILL_PATTERN" && t.params.patternId === pattern.id && !TERMINAL.has(t.status));
        const t = cmd.assignTask(sim, { type: "BLAST", destination: { kind: "block", id: b.id }, params: { blastId: r.value.id }, prerequisites: drillTask ? [drillTask.id] : [], label: `Blast ${b.name}` });
        if (!t.ok) {
          root.querySelector(".estimate")!.insertAdjacentHTML("afterbegin", `<div class="bad">✖ ${esc(t.error)}</div>`);
          return;
        }
        this.closeDialog();
      },
    };
  }

  private sellDialog(): void {
    const sim = this.sim;
    const rom = sim.state.stockpiles[0];
    if (!rom) return;
    const html = `
      <h2>Sell coal — ${esc(rom.name)}</h2>
      <p class="muted">${tonnes(rom.tonnes)} in stock${rom.quality ? ` · ash ${rom.quality.ash.toFixed(1)}% · sulfur ${rom.quality.sulfur.toFixed(2)}% · ${Math.round(rom.quality.btu).toLocaleString()} BTU/lb · moisture ${rom.quality.moisture.toFixed(1)}%` : ""}</p>
      <div class="form"><label>Tonnes <input name="t" type="number" min="0" step="100" value="${Math.floor(rom.tonnes)}"></label></div>
      <div class="quotes"></div>
      <div class="buttons right"><button data-act="dlg-cancel">CLOSE</button></div>`;
    const refresh = (root: HTMLElement): void => {
      const t = Number((root.querySelector("[name=t]") as HTMLInputElement).value) || 0;
      root.querySelector(".quotes")!.innerHTML = `<table class="grid"><tr><th>Customer</th><th>Price</th><th>Adjustments</th><th>Takes</th><th>Revenue</th><th></th></tr>${sim.state.customers
        .map((c) => {
          const q = quoteSale(sim, c, rom, t);
          return `<tr><td>${esc(c.name)}<div class="muted">${esc(label(c.type))}</div></td><td>$${q.pricePerT.toFixed(2)}/t</td><td class="muted">${q.adjustments.map((a) => `${esc(a.label)} ${a.perT >= 0 ? "+" : ""}${a.perT.toFixed(2)}`).join("<br>") || "—"}</td><td>${tonnes(q.tonnes)}</td><td>${money(q.revenue)}<div class="muted">royalty ${money(q.royalty)}</div></td><td>${q.problems.length ? `<span class="bad">${q.problems.map(esc).join("<br>")}</span>` : `<button class="primary" data-act="dlg-sell" data-id="${c.id}">SELL</button>`}</td></tr>`;
        })
        .join("")}</table>`;
    };
    const root = this.openDialog(html, refresh);
    this.dialogActions = {};
    this.sellRoot = root;
    this.sellRefresh = refresh;
  }

  private sellRoot: HTMLElement | null = null;
  private sellRefresh: ((root: HTMLElement) => void) | null = null;

  private operatorDialog(eq: EquipmentInstance): void {
    const sim = this.sim;
    const def = sim.def(eq);
    const html = `<h2>Operator — ${esc(eq.name)}</h2><p class="muted">Needs: ${esc(roleLabel(def.requiredRole))}${def.requiredCertification ? ` with ${esc(certLabel(def.requiredCertification))} certification` : ""}.</p>
      <table class="grid">${sim.state.workers
        .filter((w) => w.employmentStatus === "ACTIVE")
        .map((w) => {
          const p = qualificationProblem(sim, w, def.requiredRole, def.requiredCertification);
          return `<tr><td>${esc(w.name)}</td><td class="muted">${esc(sim.equipment(w.assignedEquipmentId)?.name ?? "")}</td><td>${p ? `<span class="muted">${esc(p)}</span>` : `<button data-act="dlg-operator" data-id="${w.id}">ASSIGN</button>`}</td></tr>`;
        })
        .join("")}</table><div class="buttons right"><button data-act="dlg-cancel">CLOSE</button></div>`;
    this.openDialog(html);
    this.operatorFor = eq.id;
  }
  private operatorFor: string | null = null;

  private upgradeDialog(eq: EquipmentInstance): void {
    const sim = this.sim;
    const def = sim.def(eq);
    const html = `<h2>Upgrades — ${esc(eq.name)}</h2><table class="grid"><tr><th>Upgrade</th><th>Slot</th><th>Effect</th><th>Price</th><th></th></tr>${def.availableUpgrades
      .map((id) => {
        const u = sim.catalog.upgrade(id);
        const has = eq.upgrades.includes(id);
        return `<tr><td>${esc(u.name)}</td><td>${esc(label(u.slot))}</td><td class="muted">${esc(u.description)}</td><td>${money(u.price)}</td><td>${has ? "<span class='good'>fitted</span>" : `<button data-act="dlg-upgrade" data-id="${id}" ${sim.canAfford(u.price) && !eq.currentTaskId ? "" : "disabled"}>FIT</button>`}</td></tr>`;
      })
      .join("")}</table>${eq.currentTaskId ? `<p class="warn">Stop the machine's task to fit upgrades.</p>` : ""}<div class="upg-msg"></div><div class="buttons right"><button data-act="dlg-cancel">CLOSE</button></div>`;
    this.openDialog(html);
    this.upgradeFor = eq.id;
  }
  private upgradeFor: string | null = null;

  // ---------------------------------------------------------------- developer panel (spec §78)

  private renderDev(): void {
    const el = $("#dev");
    if (!el.classList.contains("open")) return;
    const st = this.api.stats();
    const s = this.sim.state;
    morph(el, `<b>DEVELOPER</b> <button data-act="dev-close">✕</button>
      <div class="muted">fps ${st.fps.toFixed(0)} · ${st.ticksPerSecond.toFixed(0)} ticks/s · tick ${s.clock.tick} · draws ${st.drawCalls} · chunks pending ${st.chunksPending} · ${esc(st.gpu)}</div>
      <div class="muted">equipment ${s.equipment.length} · workers ${s.workers.length} · tasks ${s.tasks.filter((t) => !TERMINAL.has(t.status)).length} active / ${s.tasks.length} · samples ${s.samples.length} · notes ${s.notifications.length}</div>
      <div class="dev-grid">
        <span>WORLD</span><button data-act="dev" data-id="reveal">reveal geology</button>${(["SUNNY", "RAIN", "HEAVY_RAIN", "FOG"] as WeatherKind[]).map((w) => `<button data-act="dev" data-id="weather" data-w="${w}">${w.toLowerCase()}</button>`).join("")}
        <span>EQUIPMENT</span>${[...this.sim.catalog.equipment.keys()].map((d) => `<button data-act="dev" data-id="spawn" data-def="${d}">+${esc(this.sim.catalog.def(d).model)}</button>`).join("")}
        <span>SELECTED</span><button data-act="dev" data-id="damage">damage 25%</button><button data-act="dev" data-id="breakdown">break down</button><button data-act="dev" data-id="repair">repair now</button><button data-act="dev" data-id="refuel">refuel</button>
        <span>WORKERS</span><button data-act="dev" data-id="rest">rest everyone</button>
        <span>ECONOMY</span><button data-act="dev" data-id="cash">+$1M</button><button data-act="dev" data-id="price">coal price +$20</button>
        <span>REGULATION</span><button data-act="dev" data-id="permits">approve all permits</button>
        <span>TIME</span><button data-act="dev" data-id="hour">+1 hour</button><button data-act="dev" data-id="day">+1 day</button><button data-act="dev" data-id="week">+7 days</button>
      </div>`);
  }

  // ---------------------------------------------------------------- input

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement | null)?.closest?.("input, select, textarea")) return;
    if (e.key === "Escape") {
      if (this.dialogOpen) this.closeDialog();
      else if (this.tab) this.tab = null;
      else this.api.select(null);
      this.render();
    } else if (e.key === " ") {
      e.preventDefault();
      if (this.api.speed() === 0) this.api.setSpeed(this.lastSpeed);
      else {
        this.lastSpeed = this.api.speed();
        this.api.setSpeed(0);
      }
    } else if (/^[1-9]$/.test(e.key)) {
      const v = SPEEDS[Number(e.key) - 1];
      if (v !== undefined) this.api.setSpeed(v);
    } else if (e.key === "g" || e.key === "G") {
      this.api.setOverlay(this.api.overlay() === "GEOLOGY" ? "NORMAL" : "GEOLOGY");
    } else if (e.key === "`" && this.api.debug) {
      $("#dev").classList.toggle("open");
    }
    this.renderHud();
  }
  private lastSpeed = 10;

  private async onClick(e: MouseEvent): Promise<void> {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!target) return;
    if (target.tagName === "TR" && (e.target as HTMLElement).closest("button")) return;
    const act = target.dataset.act!;
    const id = target.dataset.id ?? "";
    const sim = this.sim;
    const eq = sim.equipment(id);
    const fail = (r: { ok: boolean; error?: string }) => {
      if (!r.ok && r.error) sim.notify("warn", "Can't do that", r.error);
    };
    switch (act) {
      case "speed":
        if (Number(id) !== 0) this.lastSpeed = Number(id);
        this.api.setSpeed(Number(id));
        break;
      case "overlay":
        this.api.setOverlay(id as never);
        break;
      case "cam":
        this.api.setCameraMode(id as never);
        break;
      case "tab":
        this.tab = this.tab === id ? null : (id as Tab);
        break;
      case "feed-toggle":
        this.feedOpen = !this.feedOpen;
        this.lastFeed = "";
        break;
      case "deselect":
        this.api.select(null);
        break;
      case "select-equipment":
        this.api.select({ kind: "equipment", id }, true);
        break;
      case "select-block":
        this.api.select({ kind: "block", id }, true);
        break;
      case "select-worker":
        this.api.select({ kind: "worker", id });
        break;
      case "select-task": {
        this.api.select({ kind: "task", id });
        break;
      }
      case "select-stockpile":
        this.tab = "MINE";
        break;
      case "eq-assign":
        if (eq) this.taskDialog(eq);
        return;
      case "eq-operator":
        if (eq) this.operatorDialog(eq);
        return;
      case "eq-upgrade":
        if (eq) this.upgradeDialog(eq);
        return;
      case "eq-fuel":
        if (eq) fail(cmd.assignTask(sim, { type: "FUEL", equipmentId: eq.id, priority: "HIGH", label: `Refuel ${eq.name}` }));
        break;
      case "eq-maint":
        if (eq) fail(cmd.assignTask(sim, { type: "MAINTENANCE", equipmentId: eq.id, label: `Service ${eq.name}` }));
        break;
      case "eq-repair":
        if (eq) fail(cmd.assignTask(sim, { type: "REPAIR", equipmentId: eq.id, priority: "HIGH", label: `Repair ${eq.name}` }));
        break;
      case "eq-park":
        if (eq) fail(cmd.assignTask(sim, { type: "PARK", equipmentId: eq.id, label: `Park ${eq.name}` }));
        break;
      case "eq-follow":
        this.api.select({ kind: "equipment", id }, true);
        this.api.setCameraMode("FOLLOW");
        break;
      case "task-cancel":
        cancelTask(sim, id);
        break;
      case "block-work": {
        const r = cmd.orderBlockWork(sim, id, target.dataset.mode as ExcavateMode);
        fail(r);
        if (r.ok) sim.notify("info", `Orders issued for ${sim.block(id)?.name}`, r.value.map((t) => t.label).join(" → "));
        break;
      }
      case "block-strip":
        fail(cmd.assignTask(sim, { type: "STRIP_TOPSOIL", destination: { kind: "block", id }, label: `Strip topsoil: ${sim.block(id)?.name}` }));
        break;
      case "block-drill":
        this.drillDialog(id);
        return;
      case "block-blast":
        this.blastDialog(id);
        return;
      case "explore-here": {
        const b = sim.block(id);
        if (!b) break;
        const c = blockCenter(sim, b);
        fail(cmd.assignTask(sim, { type: "EXPLORE_DRILL", destination: { kind: "point", x: c.x, z: c.z }, params: { depth: 30 }, label: `Core hole in ${b.name}` }));
        break;
      }
      case "explore-pick": {
        const p = await this.api.pickPoint("Click where to drill the exploration hole (Esc to cancel)");
        if (p) fail(cmd.assignTask(sim, { type: "EXPLORE_DRILL", destination: { kind: "point", x: p.x, z: p.z }, params: { depth: 30 }, label: `Core hole at ${p.x.toFixed(0)}, ${p.z.toFixed(0)}` }));
        break;
      }
      case "explore-point":
        fail(cmd.assignTask(sim, { type: "EXPLORE_DRILL", destination: { kind: "point", x: Number(target.dataset.x), z: Number(target.dataset.z) }, params: { depth: 30 }, label: `Core hole at ${Number(target.dataset.x).toFixed(0)}, ${Number(target.dataset.z).toFixed(0)}` }));
        break;
      case "buy":
        fail(cmd.buyEquipment(sim, id));
        break;
      case "hire":
        fail(cmd.hireCandidate(sim, id));
        break;
      case "dismiss":
        fail(cmd.dismissWorker(sim, id));
        break;
      case "train":
        fail(cmd.trainCertification(sim, id, target.dataset.cert!));
        break;
      case "renew":
        fail(cmd.renewPermit(sim, id));
        break;
      case "sell-dialog":
        this.sellDialog();
        return;
      case "dlg-cancel":
        this.api.setMarker(null);
        this.closeDialog();
        return;
      case "dlg-pick":
        await this.dialogActions.pick?.();
        return;
      case "dlg-assign":
        await this.dialogActions.assign?.();
        return;
      case "dlg-sell": {
        const t = Number((this.sellRoot?.querySelector("[name=t]") as HTMLInputElement | null)?.value) || 0;
        fail(cmd.sell(sim, id, sim.state.stockpiles[0]!.id, t));
        if (this.sellRoot && this.sellRefresh) this.sellRefresh(this.sellRoot);
        return;
      }
      case "dlg-operator":
        if (this.operatorFor) fail(cmd.setOperator(sim, this.operatorFor, id));
        this.closeDialog();
        break;
      case "dlg-upgrade": {
        if (!this.upgradeFor) return;
        const r = cmd.buyUpgrade(sim, this.upgradeFor, id);
        const e2 = sim.equipment(this.upgradeFor);
        if (r.ok && e2) this.upgradeDialog(e2);
        else if (!r.ok) $(".upg-msg").innerHTML = `<div class="bad">${esc(r.error)}</div>`;
        return;
      }
      case "save": {
        const err = this.api.save(id);
        sim.notify(err ? "warn" : "good", err ? "Save failed" : `Saved to ${id}`, err ?? "");
        break;
      }
      case "load": {
        const err = this.api.load(id);
        if (err) sim.notify("warn", "Load failed", err);
        break;
      }
      case "export": {
        const blob = new Blob([this.api.exportSave()], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `black-creek-day${sim.day}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        break;
      }
      case "import": {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.onchange = async () => {
          const f = input.files?.[0];
          if (!f) return;
          const err = this.api.importSave(await f.text());
          if (err) this.sim.notify("warn", "Import failed", err);
        };
        input.click();
        break;
      }
      case "new":
        if (confirm("Start a new game? Unsaved progress is lost.")) this.api.newGame();
        break;
      case "dev-close":
        $("#dev").classList.remove("open");
        break;
      case "dev":
        this.devAction(id, target);
        break;
    }
    this.render();
  }

  /** Settings checkboxes. */
  bindSettings(): void {
    document.addEventListener("change", (e) => {
      const t = e.target as HTMLInputElement;
      const key = t.dataset?.set as keyof Sim["state"]["settings"] | undefined;
      if (!key) return;
      (this.sim.state.settings as Record<string, boolean>)[key] = t.checked;
    });
  }

  private devAction(id: string, el: HTMLElement): void {
    const sim = this.sim;
    const sel: Selection = this.api.selection;
    const eqId = sel?.kind === "equipment" ? sel.id : null;
    switch (id) {
      case "reveal":
        cmd.dev.revealGeology(sim);
        this.api.terrainChanged();
        break;
      case "weather":
        cmd.dev.setWeather(sim, el.dataset.w as WeatherKind);
        break;
      case "spawn":
        cmd.dev.spawnEquipment(sim, el.dataset.def!);
        break;
      case "damage":
        if (eqId) cmd.dev.damage(sim, eqId);
        break;
      case "breakdown":
        if (eqId) cmd.dev.breakdown(sim, eqId);
        break;
      case "repair":
        if (eqId) cmd.dev.repairNow(sim, eqId);
        break;
      case "refuel":
        if (eqId) cmd.dev.refuel(sim, eqId);
        break;
      case "rest":
        cmd.dev.restWorkers(sim);
        break;
      case "cash":
        cmd.dev.addCash(sim, 1_000_000);
        break;
      case "price":
        for (const c of sim.state.customers) cmd.dev.setPrice(sim, c.id, c.price + 20);
        break;
      case "permits":
        cmd.dev.approvePermits(sim);
        break;
      case "hour":
        this.api.ms.advanceMinutes(60);
        break;
      case "day":
        this.api.ms.advanceMinutes(24 * 60);
        break;
      case "week":
        this.api.ms.advanceMinutes(7 * 24 * 60);
        break;
    }
  }
}

function weatherIcon(k: WeatherKind): string {
  return { SUNNY: "☀", CLOUDY: "☁", RAIN: "🌧", HEAVY_RAIN: "⛈", FOG: "🌫", WIND: "💨" }[k];
}

function objectiveHint(id: string): string {
  const def = SLICE_OBJECTIVES.find((o) => o.id === id);
  const hints: Record<string, string> = {
    explore: "Open the MINE tab and press DRILL EXPLORATION HOLE, or click the ground east of the creek and drill there. Your grandfather's two old holes are the purple posts.",
    seam: "Wait for the core to reach the seam — the GEOLOGY overlay (G) shows what is known.",
    drill: "Select Block A2 and press REMOVE OVERBURDEN: it drills, blasts, digs and hauls in one order.",
    blast: "The blaster fires once the pattern is drilled, between 08:00 and 17:00, after the 90 m zone is clear.",
    overburden: "Trucks queue at the excavator and tip at the east spoil dump. Speed up time with the buttons at the top.",
    expose: "When the overburden is gone the block turns blue: coal exposed.",
    mine: "Select the block and press MINE COAL. Coal goes to the ROM stockpile.",
    sell: "FINANCE → SELL COAL. Weathered coal near the outcrop is dirty: only the power station will take it.",
    buy: "EQUIPMENT → Buy equipment. Another truck shortens the excavator's waits.",
  };
  return hints[id] ?? def?.title ?? "";
}
