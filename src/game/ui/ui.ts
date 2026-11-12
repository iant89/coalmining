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
import type { CoalQuality } from "../../sim/world/materials.js";
import { permitValid } from "../../sim/regulatory/permits.js";
import { weatherEffects, roadConditionLabel } from "../../sim/environment/weather.js";
import { MATERIAL_LABEL } from "../../sim/world/materials.js";
import { estimateAt } from "../../sim/world/geology.js";
import { dumpCapacityLeftT } from "../../sim/logistics/stockpiles.js";
import { SLICE_OBJECTIVES } from "../../sim/objectives.js";
import { CONSTRUCTION, estimateConveyor, estimateRoad, estimateStockpile, snapRoad, type ProjectEstimate } from "../../sim/logistics/construction.js";
import { hopperOf, transitMinutes } from "../../sim/logistics/conveyors.js";
import { ROAD_MAINTENANCE_THRESHOLD } from "../../sim/automation.js";
import { BLOCK_ORDERS, checkInterval, crewOfEquipment, crewOfWorker, crewTonnes, ORDER_LABEL, orderLabel } from "../../sim/management/crews.js";
import type { Crew, CrewOrderType, PrepPlant } from "../../sim/state.js";
import { PLANT, plantCapacityTph, plantEfficiency, plantNeedsRepair, plantPowerKw, wash } from "../../sim/processing/plant.js";
import { committedT, qualityProblems } from "../../sim/economy/market.js";
import { estimatePlantRefurbish } from "../../sim/logistics/construction.js";

type Tab = "MINE" | "CREWS" | "EQUIPMENT" | "WORKERS" | "TASKS" | "LAND" | "PERMITS" | "FINANCE" | "PLANT" | "SAFETY" | "REPORTS" | "SETTINGS";
const TABS: Tab[] = ["MINE", "CREWS", "EQUIPMENT", "WORKERS", "TASKS", "LAND", "PERMITS", "FINANCE", "PLANT", "SAFETY", "REPORTS", "SETTINGS"];

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => root.querySelector(sel) as T;

export class GameUI {
  private tab: Tab | null = null;
  private dialogOpen = false;
  private lastFeed = "";
  /** The morning meeting dialog is open (it is re-rendered in place as orders change). */
  private meetingOpen = false;
  private speedBeforeMeeting = 1;
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
    this.renderMeeting();
  }

  // ---------------------------------------------------------------- morning meeting

  private renderMeeting(): void {
    const m = this.sim.state.meeting;
    if (this.meetingOpen) {
      const root = document.querySelector<HTMLElement>("#modal .dialog.meeting");
      const editing = document.activeElement?.closest("#modal") && /INPUT|SELECT/.test(document.activeElement.tagName);
      if (root && !editing) morph(root, this.meetingHtml());
      return;
    }
    if (!m?.pending || this.dialogOpen) return;
    // Everything stops for the meeting; START THE DAY restores the speed.
    const sp = this.api.speed();
    this.speedBeforeMeeting = sp > 0 ? sp : this.lastSpeed || 1;
    this.api.setSpeed(0);
    this.openDialog(this.meetingHtml());
    $("#modal .dialog").classList.add("meeting");
    this.meetingOpen = true;
  }

  private meetingHtml(): string {
    const sim = this.sim;
    const m = sim.state.meeting;
    if (!m) return "";
    const reports = m.reports
      .map((r) => `<div class="report"><b>${esc(r.crewName)}</b>${r.foremanName ? ` <span class="muted">— ${esc(r.foremanName)} reports</span>` : ""}${r.lines.map((l) => `<div class="line ${l.severity}">${esc(l.text)}</div>`).join("") || `<div class="line muted">Nothing to report.</div>`}</div>`)
      .join("");
    return `<h2>Morning meeting <span class="muted">day ${m.day}, ${esc(clockOf(m.minute).replace(/^D\d+ /, ""))}</span></h2>
      <p class="muted">The foremen report on the last shift. Give each crew its orders in priority order; the foreman assigns the machines and people and follows the work up through the day.</p>
      <div class="reports">${reports}</div>
      ${this.crewsHtml(true)}
      <div class="buttons right"><label class="toggle inline"><input type="checkbox" data-set="morningMeeting" ${sim.state.settings.morningMeeting ? "checked" : ""}> Meet every morning</label><button class="primary" data-act="meeting-start">START THE DAY</button></div>`;
  }

  private endMeetingDialog(): void {
    this.closeDialog();
  }

  /** Crew cards: foreman, members, orders and the controls to change them (CREWS tab and meeting). */
  private crewsHtml(inMeeting: boolean): string {
    const sim = this.sim;
    const s = sim.state;
    const blocks = s.blocks.filter((b) => b.state !== "COMPLETE" && b.state !== "RECLAIMED");
    const orderTypes = Object.keys(ORDER_LABEL) as CrewOrderType[];
    const statusClass = { PENDING: "muted", ACTIVE: "good", DONE: "muted", STUCK: "bad" } as const;
    const card = (c: Crew): string => {
      const f = sim.worker(c.foremanId);
      const eqs = c.equipmentIds.map((id) => sim.equipment(id)).filter((e): e is EquipmentInstance => !!e);
      const people = c.workerIds.map((id) => sim.worker(id)).filter((w) => !!w);
      const otherEq = s.equipment.filter((e) => !c.equipmentIds.includes(e.id));
      const otherPeople = s.workers.filter((w) => w.employmentStatus !== "TERMINATED" && w.role !== "FOREMAN" && !c.workerIds.includes(w.id));
      const orders = c.orders
        .map((o, i) => `<tr><td>${i + 1}</td><td>${esc(orderLabel(sim, o))}</td><td class="${statusClass[o.status]}">${esc(label(o.status))}</td><td class="muted">${esc(o.note ?? "")}</td><td class="nowrap">${o.status !== "DONE" ? `<button data-act="crew-order-up" data-crew="${c.id}" data-id="${o.id}" ${i === 0 ? "disabled" : ""} title="Higher priority">▲</button><button data-act="crew-order-down" data-crew="${c.id}" data-id="${o.id}" ${i === c.orders.length - 1 ? "disabled" : ""} title="Lower priority">▼</button>` : ""}<button data-act="crew-order-remove" data-crew="${c.id}" data-id="${o.id}" title="Withdraw the order">✕</button></td></tr>`)
        .join("");
      return `<div class="crew" data-crew-card="${c.id}">
        <h3>${esc(c.name)} <span class="muted">${f ? `foreman <a data-act="select-worker" data-id="${f.id}">${esc(f.name)}</a> · rounds every ${Math.round(checkInterval(f.skills.leadership))} min` : "<span class='bad'>no foreman</span>"} · ${tonnes(crewTonnes(sim, c) - c.tonnesAtMeeting)} hauled since the meeting</span></h3>
        <table class="grid small"><tr><th>#</th><th>Order</th><th>Status</th><th>Foreman's note</th><th></th></tr>${orders || `<tr><td colspan="5" class="muted">No orders: the crew stands idle.</td></tr>`}</table>
        <div class="buttons add-order">
          <select data-order-type="${c.id}">${orderTypes.map((t) => `<option value="${t}">${esc(ORDER_LABEL[t])}</option>`).join("")}</select>
          <select data-order-block="${c.id}">${blocks.map((b) => `<option value="${b.id}">${esc(b.name)} · ${esc(label(b.state))}</option>`).join("")}</select>
          <button class="primary" data-act="crew-add-order" data-crew="${c.id}">ADD ORDER</button>
          ${c.orders.some((o) => o.status === "DONE") ? `<button data-act="crew-clear-done" data-crew="${c.id}">CLEAR FINISHED</button>` : ""}
        </div>
        <div class="members"><b>Machines</b> ${eqs.map((e) => `<span class="chip ${e.state === "BROKEN" ? "bad" : ""}">${esc(e.name)}<button data-act="crew-remove-eq" data-crew="${c.id}" data-id="${e.id}" title="Take out of the crew">✕</button></span>`).join(" ") || `<span class="muted">none</span>`}
          <select data-crew-add-eq="${c.id}"><option value="">add machine…</option>${otherEq.map((e) => `<option value="${e.id}">${esc(e.name)}${crewOfEquipment(sim, e.id) ? ` (${esc(crewOfEquipment(sim, e.id)!.name)})` : ""}</option>`).join("")}</select></div>
        <div class="members"><b>People</b> ${people.map((w) => `<span class="chip">${esc(w!.name)}<button data-act="crew-remove-worker" data-crew="${c.id}" data-id="${w!.id}" title="Take out of the crew">✕</button></span>`).join(" ") || `<span class="muted">none</span>`}
          <select data-crew-add-worker="${c.id}"><option value="">add person…</option>${otherPeople.map((w) => `<option value="${w.id}">${esc(w.name)} · ${esc(roleLabel(w.role))}${crewOfWorker(sim, w.id) ? ` (${esc(crewOfWorker(sim, w.id)!.name)})` : ""}</option>`).join("")}</select></div>
      </div>`;
    };
    const freeForemen = s.workers.filter((w) => w.role === "FOREMAN" && w.employmentStatus === "ACTIVE" && !s.crews.some((c) => c.foremanId === w.id));
    return `${inMeeting ? "" : `<h2>Crews <span class="muted">${s.settings.morningMeeting ? `morning meeting at ${String(s.shift.startHour).padStart(2, "0")}:00` : "morning meetings off"}</span></h2>
      <p class="muted">Each crew's foreman turns its orders into tasks, staffs them from the crew only and chases what stalls. Your own orders (from blocks and machines) can still use anything.</p>`}
      ${s.crews.map(card).join("") || `<p class="muted">No crews. Hire a foreman from the applicant pool (WORKERS) and form one.</p>`}
      ${freeForemen.length ? `<div class="buttons">${freeForemen.map((w) => `<button data-act="crew-form" data-id="${w.id}">FORM A CREW UNDER ${esc(w.name.toUpperCase())}</button>`).join("")}</div>` : ""}
      ${inMeeting ? "" : `<div class="buttons"><button data-act="meeting-call">CALL A MEETING NOW</button></div>`}`;
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
        ${eq.serviceHold ? `<tr><td>Service</td><td class="good">${esc(eq.serviceHold.reason)}</td></tr>` : ""}
        ${def.category === "LUBE_TRUCK" ? `<tr><td>Diesel tank</td><td>${bar(eq.cargoFuelL / (def.cargoFuelL ?? 1))} ${Math.round(eq.cargoFuelL).toLocaleString()} / ${(def.cargoFuelL ?? 0).toLocaleString()} L</td></tr>` : `<tr><td>Grease</td><td class="${eq.hoursSinceGrease > 60 ? "warn" : "muted"}">${Math.round(eq.hoursSinceGrease)} h since greased${eq.hoursSinceGrease > 60 ? " — dry pins wear faster" : ""}</td></tr>`}
        <tr><td>Crew</td><td>${esc(crewOfEquipment(sim, eq.id)?.name ?? (def.category === "LUBE_TRUCK" || def.category === "SERVICE_TRUCK" ? "mine support" : "none — only your orders use it"))}</td></tr>
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
          ${this.logisticsHtml()}`;
        break;
      }
      case "CREWS":
        html = this.crewsHtml(false);
        break;
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
        html = this.plantHtml();
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
          <label class="toggle"><input type="checkbox" data-set="autoFuel" ${s.settings.autoFuel ? "checked" : ""}> Auto-refuel (trucks drive to the fuel station; lube trucks refuel and grease machines in the field)</label>
          <label class="toggle"><input type="checkbox" data-set="autoMaintenance" ${s.settings.autoMaintenance ? "checked" : ""}> Auto-maintenance: file repairs on breakdown (service trucks drive the mechanic out) and field-service overdue machines</label>
          <label class="toggle"><input type="checkbox" data-set="morningMeeting" ${s.settings.morningMeeting ? "checked" : ""}> Morning meeting with the foremen at every shift start (the game pauses for it)</label>
          <label class="toggle"><input type="checkbox" data-set="autoGrade" ${s.settings.autoGrade ? "checked" : ""}> Auto-grade haul roads: idle graders take the worst road below ${ROAD_MAINTENANCE_THRESHOLD}%</label>
          <h3>Save &amp; load</h3><div class="buttons">${[1, 2, 3].map((n) => `<button data-act="save" data-id="slot${n}">SAVE ${n}</button><button data-act="load" data-id="slot${n}">LOAD ${n}</button>`).join("")}</div>
          <div class="buttons"><button data-act="export">EXPORT SAVE FILE</button><button data-act="import">IMPORT SAVE FILE</button><button data-act="new" class="warn">NEW GAME</button></div>
          <h3>Controls</h3><p class="muted">Left-drag: pan · Right-drag / Alt+drag: orbit · Wheel: zoom · WASD/arrows: pan · Q/E: rotate · R/F: tilt · Space: pause · 1–9: speed · G: geology overlay · Esc: close · \`: developer panel (debug builds, ?dev=1)</p>`;
        break;
      }
    }
    morph(el, `<button class="close" data-act="tab" data-id="${this.tab}">✕</button>${html}`);
  }

  /** PLANT tab, development phase 09: the preparation plant flowsheet, its controls and the loadout. */
  private plantHtml(): string {
    const sim = this.sim;
    const s = sim.state;
    const p = s.plant;
    if (!p) return `<h2>Preparation plant</h2><p class="muted">This mine has no preparation plant. Coal is sold raw from the stockpiles.</p>${this.loadoutHtml()}`;
    const feed = sim.stockpile(p.feedStockpileId);
    const clean = sim.stockpile(p.cleanStockpileId);
    const dump = sim.dump(p.refuseDumpId);
    const statusClass = p.status === "RUNNING" ? "good" : p.status === "STARTING" ? "warn" : p.status === "BROKEN" ? "bad" : "muted";
    const head = `<h2>${esc(p.name)} <span class="status-chip ${statusClass}">${esc(label(p.status))}</span></h2>${p.stopReason && p.status !== "RUNNING" ? `<p class="${p.status === "BROKEN" ? "bad" : "muted"}">${esc(p.stopReason)}</p>` : ""}`;
    if (p.status === "MOTHBALLED" || p.status === "REFURBISHING") {
      const e = estimatePlantRefurbish(sim);
      const proj = s.projects.find((x) => x.type === "PLANT_REFURBISH" && x.status !== "COMPLETE" && x.status !== "CANCELLED");
      return `${head}<p>Your grandfather's wash plant: a reclaim feeder, rotary breaker, desliming screen and a dense-medium cyclone. Washing takes the rock out of the coal — lower ash and sulfur, more heat — and opens the industrial and premium buyers that will not take raw coal.</p>
        ${proj ? `<p>Contractors at work: ${bar(proj.progress)} ${pct(proj.progress)} · ${money(proj.spent)} of ${money(proj.cost)} spent (they work the day shift).</p>` : `<div class="buttons"><button class="primary" data-act="plant-refurbish" ${e.problems.length || !sim.canAfford(e.cost) ? "disabled" : ""}>REFURBISH THE PLANT — ${money(e.cost)}, ~${Math.round(e.workMinutes / 60)} crew-hours</button></div>`}
        ${this.loadoutHtml()}`;
    }
    const eff = plantEfficiency(sim, p);
    const preview = feed?.quality ? wash(feed.quality, p.cutDensity, eff) : null;
    const unitBox = (u: PrepPlant["units"][number]): string => `<div class="unit ${u.breakdown ? "broken" : ""}"><b>${esc(u.name)}</b><div class="muted">${esc(label(u.kind))} · ${u.capacityTph} t/h · ${u.powerKw} kW</div><div>${bar(u.condition / 100, conditionClass(u.condition))} ${u.condition.toFixed(0)}%</div>${u.breakdown ? `<div class="bad">${esc(u.breakdown.cause)}</div>` : ""}</div>`;
    const arrow = `<div class="arrow">→</div>`;
    const flow = `<div class="flowsheet">
        <div class="unit pile"><b>Feed</b><div class="muted">${esc(feed?.name ?? "—")}</div><div>${tonnes(feed?.tonnes ?? 0)}</div>${feed?.quality ? `<div class="muted">ash ${feed.quality.ash.toFixed(1)}%</div>` : ""}</div>${arrow}
        ${p.units.map(unitBox).join(arrow)}${arrow}
        <div class="outs"><div class="unit pile good"><b>Clean coal</b><div class="muted">${esc(clean?.name ?? "—")}</div><div>${tonnes(clean?.tonnes ?? 0)} / ${tonnes(clean?.capacityT ?? 0)}</div>${clean?.quality ? `<div class="muted">ash ${clean.quality.ash.toFixed(1)}%</div>` : ""}</div>
        <div class="unit pile"><b>Refuse</b><div class="muted">${esc(dump?.name ?? "—")}</div><div>${tonnes(dump?.tonnes ?? 0)}</div></div></div>
      </div>`;
    const operators = s.workers.filter((w) => w.role === "PLANT_OPERATOR" && w.employmentStatus !== "TERMINATED");
    const op = sim.worker(p.operatorId);
    const raw = s.stockpiles.filter((x) => x.materialType === "COAL_RAW");
    const accepts = (q: CoalQuality | null): string => (q ? s.customers.map((c) => `<span class="chip ${qualityProblems(c, q).length ? "muted" : "good"}" title="${esc(qualityProblems(c, q).join("; ") || "Meets the spec")}">${esc(label(c.type))} ${qualityProblems(c, q).length ? "✗" : "✓"}</span>`).join(" ") : "");
    const qline = (q: CoalQuality): string => `ash ${q.ash.toFixed(1)}% · S ${q.sulfur.toFixed(2)}% · ${Math.round(q.btu).toLocaleString()} BTU · moisture ${q.moisture.toFixed(1)}%`;
    const t = s.today;
    return `${head}${flow}
      <div class="cols"><div>
        <h3>Controls</h3>
        <div class="buttons"><button class="${p.enabled ? "warn" : "primary"}" data-act="plant-toggle">${p.enabled ? "SWITCH OFF" : "SWITCH ON"}</button>${plantNeedsRepair(p) ? `<button class="warn" data-act="plant-repair">SEND A MECHANIC</button>` : ""}</div>
        <table class="kv">
          <tr><td>Operator</td><td><select data-plant-set="operator"><option value="">— none —</option>${operators.map((w) => `<option value="${w.id}" ${w.id === p.operatorId ? "selected" : ""}>${esc(w.name)}</option>`).join("")}</select>${operators.length ? "" : ` <span class="warn">hire a plant operator (WORKERS)</span>`}${op ? ` <span class="muted">${isOnShift(sim, op) ? "on shift" : "off shift"}</span>` : ""}</td></tr>
          <tr><td>Feed from</td><td><select data-plant-set="feed">${raw.map((x) => `<option value="${x.id}" ${x.id === p.feedStockpileId ? "selected" : ""}>${esc(x.name)} (${tonnes(x.tonnes)})</option>`).join("")}</select></td></tr>
          <tr><td>Feed rate</td><td><input type="number" data-plant-set="rate" min="20" max="400" step="10" value="${Math.round(p.feedRateTph)}"> t/h <span class="muted">plant capacity ${Math.round(plantCapacityTph(p))} t/h</span></td></tr>
          <tr><td>Cut density</td><td><input type="range" data-plant-set="cut" min="${PLANT.cutDensity.min}" max="${PLANT.cutDensity.max}" step="0.05" value="${p.cutDensity}"> <b>${p.cutDensity.toFixed(2)}</b> g/cm³ <div class="muted">Lower: cleaner coal, less of it. Higher: more tonnes, more ash.</div></td></tr>
          <tr><td>Separation</td><td>${pct(eff)} efficient <span class="muted">(cyclone and screen condition, operator skill)</span></td></tr>
        </table>
        ${preview ? `<h3>At this setting</h3><table class="kv"><tr><td>Yield</td><td>${pct(preview.yield)} clean coal, ${pct(1 - preview.yield)} refuse</td></tr><tr><td>Clean coal</td><td>${qline(preview.clean)}</td></tr><tr><td>Raw feed</td><td class="muted">${qline(feed!.quality!)}</td></tr><tr><td>Buyers</td><td>${accepts(preview.clean)} <div class="muted">raw: ${accepts(feed!.quality)}</div></td></tr></table>` : `<p class="muted">The feed stockpile is empty: no preview.</p>`}
      </div><div>
        <h3>Today</h3><table class="kv">
          <tr><td>Running</td><td>${p.status === "RUNNING" ? `${Math.round(p.rateTph)} t/h · ${Math.round(plantPowerKw(p, p.rateTph / Math.max(1, plantCapacityTph(p))))} kW` : "—"}</td></tr>
          <tr><td>Washed</td><td>${tonnes(t.plantFeedT)} raw → ${tonnes(t.cleanCoalT)} clean + ${tonnes(t.refuseT)} refuse${t.plantFeedT > 1 ? ` <span class="muted">(yield ${pct(t.cleanCoalT / t.plantFeedT)})</span>` : ""}</td></tr>
          ${p.lastProduct ? `<tr><td>Last product</td><td>${qline(p.lastProduct)}</td></tr>` : ""}
          <tr><td>Since start</td><td class="muted">${tonnes(p.totalFeedT)} washed · ${tonnes(p.totalCleanT)} clean · ${tonnes(p.totalRefuseT)} refuse</td></tr>
          <tr><td>Costs</td><td class="muted">power $${CONSTRUCTION.electricityPerKWh.toFixed(2)}/kWh · magnetite &amp; reagents $${PLANT.reagentCostPerT.toFixed(2)}/t</td></tr>
        </table>
        ${this.loadoutHtml()}
      </div></div>`;
  }

  private loadoutHtml(): string {
    const sim = this.sim;
    const lo = sim.state.loadout;
    if (!lo) return "";
    const rows = lo.shipments.map((sh, n) => `<tr><td>${n === 0 ? "loading" : "waiting"}</td><td>${esc(sim.customer(sh.customerId)?.name ?? "")}</td><td>${esc(sim.stockpile(sh.stockpileId)?.name ?? "")}</td><td>${bar(sh.loadedT / sh.tonnes)} ${tonnes(sh.loadedT)} / ${tonnes(sh.tonnes)}</td><td>$${sh.pricePerT.toFixed(2)}/t</td></tr>`).join("");
    return `<h3>Loadout <span class="muted">${lo.rateTph} t/h, around the clock</span></h3><table class="grid small">${rows || `<tr><td class="muted">No shipments waiting. Sales (FINANCE → SELL COAL) are loaded here and paid when the last truck leaves.</td></tr>`}</table>`;
  }

  /** MINE tab, development phase 08: construction, coal routing, conveyors and haul roads. */
  private logisticsHtml(): string {
    const sim = this.sim;
    const s = sim.state;
    const active = s.projects.filter((p) => p.status === "PLANNED" || p.status === "IN_PROGRESS");
    const recent = s.projects.filter((p) => p.status === "COMPLETE").slice(-3).reverse();
    const dest = s.settings.coalDestination;
    const destOptions = [
      `<option value="" ${dest === null ? "selected" : ""}>${esc(s.stockpiles[0]?.name ?? "default stockpile")} (default)</option>`,
      ...s.stockpiles.slice(1).map((p) => `<option value="${p.id}" ${dest === p.id ? "selected" : ""}>${esc(p.name)}</option>`),
      ...s.hoppers.map((h) => `<option value="${h.id}" ${dest === h.id ? "selected" : ""}>${esc(h.name)} → conveyor</option>`),
    ].join("");
    const grading = new Set(s.tasks.filter((t) => t.type === "GRADE_ROAD" && !TERMINAL.has(t.status) && t.destination?.kind === "road").map((t) => (t.destination as { id: string }).id));
    const hasGrader = s.equipment.some((e) => sim.def(e).category === "GRADER");
    return `
      <h3>Construction</h3>
      <div class="buttons"><button class="primary" data-act="build-road">BUILD HAUL ROAD…</button><button class="primary" data-act="build-conveyor">BUILD CONVEYOR…</button><button data-act="build-stockpile">BUILD STOCKPILE…</button></div>
      ${active.length || recent.length ? `<table class="grid"><tr><th>Project</th><th>Status</th><th>Progress</th><th>Cost</th><th></th></tr>${[...active, ...recent]
        .map((p) => `<tr><td>${esc(p.name)} <span class="muted">${esc(label(p.type))}</span></td><td>${esc(label(p.status))}</td><td>${bar(p.progress)} ${pct(p.progress)}</td><td>${money(p.spent)} / ${money(p.cost)}</td><td>${p.status === "COMPLETE" ? "" : `<button data-act="project-cancel" data-id="${p.id}">CANCEL</button>`}</td></tr>`)
        .join("")}</table>` : ""}
      <h3>Coal routing</h3>
      <label class="toggle">MINE COAL orders deliver to <select data-coal-dest="1">${destOptions}</select></label>
      ${s.conveyors.length ? `<h3>Conveyors</h3><table class="grid"><tr><th>Conveyor</th><th>State</th><th>Hopper</th><th>On belt</th><th>Delivered</th><th>Condition</th><th></th></tr>${s.conveyors
        .map((c) => {
          const h = hopperOf(sim, c);
          return `<tr><td>${esc(c.name)} <span class="muted">${Math.round(c.length)} m · ${c.capacityTph} t/h · ${transitMinutes(c).toFixed(1)} min</span></td><td class="${c.state === "DAMAGED" || c.state === "JAMMED" ? "bad" : c.state === "RUNNING" ? "good" : "muted"}">${esc(label(c.state))}${c.breakdown ? `<div class="muted">${esc(c.breakdown.cause)}</div>` : ""}</td><td>${h ? `${bar(h.tonnes / h.capacityT, h.tonnes > h.capacityT * 0.9 ? "warn" : "")} ${Math.round(h.tonnes)} t` : "—"}</td><td>${tonnes(c.beltT)}</td><td>${tonnes(c.totalT)}</td><td>${bar(c.condition / 100, conditionClass(c.condition))} ${c.condition.toFixed(0)}%</td><td><button data-act="conveyor-toggle" data-id="${c.id}">${c.enabled ? "SWITCH OFF" : "SWITCH ON"}</button>${c.state === "DAMAGED" || c.condition < 60 ? `<button class="warn" data-act="conveyor-repair" data-id="${c.id}">REPAIR</button>` : ""}</td></tr>`;
        })
        .join("")}</table>` : ""}
      <h3>Haul roads <span class="muted">${s.settings.autoGrade ? (hasGrader ? `graders keep roads above ${ROAD_MAINTENANCE_THRESHOLD}%` : "buy a grader to maintain roads") : "auto-grading off"}</span></h3>
      <table class="grid"><tr><th>Road</th><th>Condition</th><th>Limit</th><th></th></tr>${s.roadEdges
        .map((r) => `<tr><td>${esc(r.a)} → ${esc(r.b)}</td><td>${bar(r.condition / 100, conditionClass(r.condition))} ${roadConditionLabel(r.condition)}</td><td>${r.speedLimitKmh} km/h</td><td>${grading.has(r.id) ? `<span class="muted">grading…</span>` : `<button data-act="grade-road" data-id="${r.id}" ${hasGrader ? "" : "disabled"}>GRADE</button>`}</td></tr>`)
        .join("")}</table>`;
  }

  private estimateHtml(e: ProjectEstimate, extra: string[] = []): string {
    const rows = [
      e.length > 0 ? `<tr><td>Length</td><td>${Math.round(e.length)} m</td></tr>` : "",
      e.grade !== null && e.type === "HAUL_ROAD" ? `<tr><td>Finished grade</td><td>${(e.grade * 100).toFixed(1)} %</td></tr>` : "",
      e.grade !== null && e.type === "CONVEYOR" ? `<tr><td>Belt incline</td><td>${(e.grade * 100).toFixed(1)} %</td></tr>` : "",
      e.earthworksM3 !== null ? `<tr><td>Earthworks</td><td>~${Math.round(e.earthworksM3).toLocaleString()} m³ cut and fill</td></tr>` : "",
      ...extra,
      `<tr><td>Cost</td><td>${money(e.cost)} <span class="muted">(paid as the work is done)</span></td></tr>`,
      `<tr><td>Work</td><td>~${formatDuration(e.workMinutes)}</td></tr>`,
    ].join("");
    return `<table class="kv">${rows}</table>${e.problems.map((p) => `<div class="bad">✖ ${esc(p)}</div>`).join("")}${e.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join("")}`;
  }

  private async roadDialog(): Promise<void> {
    const sim = this.sim;
    const from = await this.api.pickPoint("Click where the road starts (near an existing road joins it) — Esc to cancel");
    if (!from) return;
    this.api.setMarker(from);
    const to = await this.api.pickPoint("Click where the road ends — Esc to cancel");
    this.api.setMarker(null);
    if (!to) return;
    const dozers = sim.state.equipment.filter((e) => sim.def(e).category === "DOZER");
    const snap = snapRoad(sim, { from, to });
    const html = `
      <h2>Build a haul road</h2>
      <p class="muted">${snap.startNode ? `Starts at road junction ${esc(snap.startNode.id)}` : "Starts off the network"} · ${snap.endNode ? `ends at junction ${esc(snap.endNode.id)}` : "ends off the network"}. A dozer grades it to a straight profile between its ends; trucks can use it once it is finished.</p>
      <div class="form"><label>Dozer <select name="dozer"><option value="">Any free dozer</option>${dozers.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select></label></div>
      <div class="estimate">${this.estimateHtml(estimateRoad(sim, { from, to }), [`<tr><td>Width</td><td>${CONSTRUCTION.HAUL_ROAD.width} m, ${CONSTRUCTION.HAUL_ROAD.speedLimitKmh} km/h</td></tr>`])}</div>
      <div class="buttons right"><button data-act="dlg-cancel">CANCEL</button><button class="primary" data-act="dlg-assign" ${estimateRoad(sim, { from, to }).problems.length ? "disabled" : ""}>BUILD</button></div>`;
    const root = this.openDialog(html);
    this.dialogActions = {
      assign: () => {
        const dozer = (root.querySelector("[name=dozer]") as HTMLSelectElement).value || null;
        const r = cmd.buildRoad(sim, from, to, dozer);
        if (!r.ok) {
          root.querySelector(".estimate")!.insertAdjacentHTML("afterbegin", `<div class="bad">✖ ${esc(r.error)}</div>`);
          return;
        }
        this.closeDialog();
      },
    };
  }

  private async conveyorDialog(): Promise<void> {
    const sim = this.sim;
    const from = await this.api.pickPoint("Click where trucks will tip into the hopper (near the pit) — Esc to cancel");
    if (!from) return;
    this.api.setMarker(from);
    const cfg = CONSTRUCTION.CONVEYOR;
    let to: { x: number; z: number } = { x: from.x, z: from.z };
    const html = `
      <h2>Build a conveyor</h2>
      <p class="muted">A ${cfg.hopperCapacityT} t truck hopper and an overland belt. Trucks tip coal into the hopper; the belt carries it to the stockpile at no more than its rated capacity, and trucks queue when the hopper is full.</p>
      <div class="form">
        <label>Capacity <select name="tph">${cfg.capacityOptionsTph.map((v) => `<option value="${v}">${v} t/h</option>`).join("")}</select></label>
        <label>Discharges into <select name="dest">${sim.state.stockpiles.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}<option value="">A new stockpile (pick on the map)</option></select></label>
        <label class="f-pick" style="display:none">New stockpile site <span class="pt">not set</span> <button type="button" data-act="dlg-pick">PICK ON MAP</button></label>
      </div>
      <div class="estimate"></div>
      <div class="buttons right"><button data-act="dlg-cancel">CANCEL</button><button class="primary" data-act="dlg-assign">BUILD</button></div>`;
    const read = (root: HTMLElement) => ({
      tph: Number((root.querySelector("[name=tph]") as HTMLSelectElement).value),
      dest: (root.querySelector("[name=dest]") as HTMLSelectElement).value || null,
    });
    const refresh = (root: HTMLElement): void => {
      const o = read(root);
      root.querySelector<HTMLElement>(".f-pick")!.style.display = o.dest ? "none" : "";
      root.querySelector(".pt")!.textContent = o.dest ? "" : `${to.x.toFixed(0)}, ${to.z.toFixed(0)}`;
      const e = estimateConveyor(sim, from, to, o.tph, o.dest);
      root.querySelector(".estimate")!.innerHTML = this.estimateHtml(e, [`<tr><td>Power</td><td>~${Math.round(o.tph * cfg.kwPerTph + e.length * 0.15)} kW while running</td></tr>`]);
      (root.querySelector("[data-act=dlg-assign]") as HTMLButtonElement).disabled = e.problems.length > 0;
    };
    const root = this.openDialog(html, refresh);
    this.dialogActions = {
      pick: async () => {
        $("#modal").classList.add("picking");
        const p = await this.api.pickPoint("Click the new stockpile's site — Esc to cancel");
        $("#modal").classList.remove("picking");
        if (p) to = p;
        refresh(root);
      },
      assign: () => {
        const o = read(root);
        const r = cmd.buildConveyor(sim, from, to, o.tph, o.dest);
        if (!r.ok) {
          root.querySelector(".estimate")!.insertAdjacentHTML("afterbegin", `<div class="bad">✖ ${esc(r.error)}</div>`);
          return;
        }
        this.api.setMarker(null);
        this.closeDialog();
      },
    };
  }

  private async stockpileDialog(): Promise<void> {
    const sim = this.sim;
    const at = await this.api.pickPoint("Click the stockpile site — Esc to cancel");
    if (!at) return;
    this.api.setMarker(at);
    const html = `
      <h2>Build a coal stockpile</h2>
      <div class="form"><label>Capacity <select name="cap">${CONSTRUCTION.STOCKPILE.capacityOptionsT.map((v) => `<option value="${v}" ${v === 10000 ? "selected" : ""}>${(v / 1000).toFixed(0)} kt</option>`).join("")}</select></label></div>
      <div class="estimate"></div>
      <div class="buttons right"><button data-act="dlg-cancel">CANCEL</button><button class="primary" data-act="dlg-assign">BUILD</button></div>`;
    const cap = (root: HTMLElement) => Number((root.querySelector("[name=cap]") as HTMLSelectElement).value);
    const refresh = (root: HTMLElement): void => {
      const e = estimateStockpile(sim, at, cap(root));
      root.querySelector(".estimate")!.innerHTML = this.estimateHtml(e);
      (root.querySelector("[data-act=dlg-assign]") as HTMLButtonElement).disabled = e.problems.length > 0;
    };
    const root = this.openDialog(html, refresh);
    this.dialogActions = {
      assign: () => {
        const r = cmd.buildStockpile(sim, at, cap(root));
        if (!r.ok) {
          root.querySelector(".estimate")!.insertAdjacentHTML("afterbegin", `<div class="bad">✖ ${esc(r.error)}</div>`);
          return;
        }
        this.api.setMarker(null);
        this.closeDialog();
      },
    };
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
    // Closing the meeting any way (Esc, ✕) starts the day.
    if (this.meetingOpen) {
      this.meetingOpen = false;
      cmd.closeMeeting(this.sim);
      this.api.setSpeed(this.speedBeforeMeeting || 1);
    }
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
    const piles = sim.state.stockpiles.filter((x) => x.materialType === "COAL_RAW" || x.materialType === "COAL_CLEAN");
    if (!piles.length) return;
    // Default to the fullest clean coal pile, else the first raw pile.
    const best = piles.filter((x) => x.materialType === "COAL_CLEAN" && x.tonnes > 1).sort((a, b) => b.tonnes - a.tonnes)[0] ?? piles[0]!;
    const html = `
      <h2>Sell coal</h2>
      <div class="form"><label>From <select name="pile">${piles.map((x) => `<option value="${x.id}" ${x === best ? "selected" : ""}>${esc(x.name)} (${tonnes(x.tonnes)})</option>`).join("")}</select></label>
      <label>Tonnes <input name="t" type="number" min="0" step="100" value="${Math.floor(Math.max(0, best.tonnes - committedT(sim, best.id)))}"></label></div>
      <p class="muted pile-info"></p>
      <div class="quotes"></div>
      <p class="muted">${sim.state.loadout ? `Sales are loaded out at ${sim.state.loadout.rateTph} t/h and paid when loading finishes (PLANT tab shows the queue).` : "Sales are paid at once."}</p>
      <div class="buttons right"><button data-act="dlg-cancel">CLOSE</button></div>`;
    const refresh = (root: HTMLElement): void => {
      const t = Number((root.querySelector("[name=t]") as HTMLInputElement).value) || 0;
      const rom = sim.stockpile((root.querySelector("[name=pile]") as HTMLSelectElement).value) ?? best;
      this.sellPile = rom.id;
      const free = Math.max(0, rom.tonnes - committedT(sim, rom.id));
      morph(root.querySelector(".pile-info")!, `${tonnes(rom.tonnes)} in ${esc(rom.name)}${free < rom.tonnes - 1 ? ` (${tonnes(free)} not yet sold)` : ""}${rom.quality ? ` · ash ${rom.quality.ash.toFixed(1)}% · sulfur ${rom.quality.sulfur.toFixed(2)}% · ${Math.round(rom.quality.btu).toLocaleString()} BTU/lb · moisture ${rom.quality.moisture.toFixed(1)}%` : ""}`);
      // Patched, not replaced: the input's change event fires on the mousedown that clicks SELL.
      morph(root.querySelector(".quotes")!, `<table class="grid"><tr><th>Customer</th><th>Price</th><th>Adjustments</th><th>Takes</th><th>Revenue</th><th></th></tr>${sim.state.customers
        .map((c) => {
          const q = quoteSale(sim, c, rom, t);
          return `<tr><td>${esc(c.name)}<div class="muted">${esc(label(c.type))}</div></td><td>$${q.pricePerT.toFixed(2)}/t</td><td class="muted">${q.adjustments.map((a) => `${esc(a.label)} ${a.perT >= 0 ? "+" : ""}${a.perT.toFixed(2)}`).join("<br>") || "—"}</td><td>${tonnes(q.tonnes)}</td><td>${money(q.revenue)}<div class="muted">royalty ${money(q.royalty)}</div></td><td>${q.problems.length ? `<span class="bad">${q.problems.map(esc).join("<br>")}</span>` : `<button class="primary" data-act="dlg-sell" data-id="${c.id}">SELL</button>`}</td></tr>`;
        })
        .join("")}</table>`);
    };
    const root = this.openDialog(html, refresh);
    this.dialogActions = {};
    this.sellRoot = root;
    this.sellRefresh = refresh;
  }

  private sellRoot: HTMLElement | null = null;
  private sellPile: string | null = null;
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
      case "plant-refurbish":
        fail(cmd.refurbishPlant(sim));
        break;
      case "plant-toggle":
        fail(cmd.setPlantEnabled(sim, !sim.state.plant?.enabled));
        break;
      case "plant-repair":
        fail(cmd.repairPlantTask(sim));
        break;
      case "select-plant":
        this.tab = "PLANT";
        break;
      case "meeting-start":
        this.endMeetingDialog();
        break;
      case "meeting-call":
        fail(cmd.callMeeting(sim));
        break;
      case "crew-form":
        fail(cmd.createCrew(sim, id));
        break;
      case "crew-add-order": {
        const crew = target.dataset.crew!;
        const scope = target.closest(".crew") ?? document;
        const type = (scope.querySelector(`[data-order-type="${crew}"]`) as HTMLSelectElement).value as CrewOrderType;
        const block = (scope.querySelector(`[data-order-block="${crew}"]`) as HTMLSelectElement | null)?.value ?? null;
        fail(cmd.addCrewOrder(sim, crew, type, BLOCK_ORDERS.has(type) ? block : null));
        break;
      }
      case "crew-order-up":
      case "crew-order-down":
        fail(cmd.moveCrewOrder(sim, target.dataset.crew!, id, act === "crew-order-up" ? -1 : 1));
        break;
      case "crew-order-remove":
        fail(cmd.removeCrewOrder(sim, target.dataset.crew!, id));
        break;
      case "crew-clear-done":
        fail(cmd.clearDoneOrders(sim, target.dataset.crew!));
        break;
      case "crew-remove-eq":
        fail(cmd.assignToCrew(sim, null, { equipmentId: id }));
        break;
      case "crew-remove-worker":
        fail(cmd.assignToCrew(sim, null, { workerId: id }));
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
      case "build-road":
        await this.roadDialog();
        return;
      case "build-conveyor":
        await this.conveyorDialog();
        return;
      case "build-stockpile":
        await this.stockpileDialog();
        return;
      case "project-cancel":
        fail(cmd.cancelConstruction(sim, id));
        break;
      case "conveyor-toggle": {
        const c = sim.state.conveyors.find((x) => x.id === id);
        if (c) fail(cmd.switchConveyor(sim, id, !c.enabled));
        break;
      }
      case "conveyor-repair":
        fail(cmd.repairConveyorTask(sim, id));
        break;
      case "grade-road":
        fail(cmd.gradeRoad(sim, id));
        break;
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
        fail(cmd.sell(sim, id, this.sellPile ?? sim.state.stockpiles[0]!.id, t));
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
      const sel = e.target as HTMLSelectElement;
      if (sel.dataset?.plantSet) {
        const v = sel.value;
        const k = sel.dataset.plantSet;
        const r =
          k === "operator" ? cmd.setPlantOperator(this.sim, v || null)
          : k === "feed" ? cmd.setPlantSettings(this.sim, { feedStockpileId: v })
          : k === "rate" ? cmd.setPlantSettings(this.sim, { feedRateTph: Number(v) })
          : cmd.setPlantSettings(this.sim, { cutDensity: Number(v) });
        if (!r.ok) this.sim.notify("warn", "Can't do that", r.error);
        sel.blur();
        return;
      }
      if (sel.dataset?.crewAddEq || sel.dataset?.crewAddWorker) {
        if (!sel.value) return;
        const crew = (sel.dataset.crewAddEq ?? sel.dataset.crewAddWorker)!;
        const r = cmd.assignToCrew(this.sim, crew, sel.dataset.crewAddEq ? { equipmentId: sel.value } : { workerId: sel.value });
        if (!r.ok) this.sim.notify("warn", "Can't do that", r.error);
        sel.blur();
        return;
      }
      if (sel.dataset?.coalDest) {
        const r = cmd.setCoalDestination(this.sim, sel.value || null);
        if (!r.ok) this.sim.notify("warn", "Can't do that", r.error);
        return;
      }
      const t = e.target as HTMLInputElement;
      const key = t.dataset?.set;
      const settings = this.sim.state.settings;
      // Only the boolean switches are checkboxes.
      if (key === "autoFuel" || key === "autoMaintenance" || key === "autoGrade" || key === "morningMeeting") settings[key] = t.checked;
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
