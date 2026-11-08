// Pure derivation of everything the v4 UI shows at playhead time `t`. No React, no I/O, no cost logic:
// every number comes from the Snapshot the API returned (presentation only, global_plan section 3).
// Missing data stays null/"nodata" and is never rendered as 0 or healthy (hard rule 9).
import type { FacilityState, FleetState, Incident, PlanOption, Quality, Series, Snapshot, SystemState } from "@/lib/engine/types";
import { hhmm, stamp } from "./format";

export type { Snapshot, Incident, FacilityState, SystemState };

// ---------------------------------------------------------------------------
// Window

export interface TimeWindow { start: number; end: number }

/** [earliest series timestamp, snapshot.nowUnix]. Anything outside must be loaded via commitAt (never invented). */
export function localWindow(snapshot: Snapshot): TimeWindow {
  let start = Infinity;
  for (const s of snapshot.systems) for (const f of s.facilities) {
    for (const series of [f.series.level, f.series.inflow, f.series.pumpFlow, f.series.receiveFlow]) {
      if (series.t.length > 0 && series.t[0] < start) start = series.t[0];
    }
  }
  if (!Number.isFinite(start) || start > snapshot.nowUnix) start = snapshot.nowUnix;
  return { start, end: snapshot.nowUnix };
}

export const inWindow = (w: TimeWindow, t: number) => t >= w.start && t <= w.end;
/** True when the run is already at the dataset's last timestamp. */
export const isLive = (snapshot: Snapshot) => snapshot.nowUnix >= snapshot.dataset.nowUnix;

// ---------------------------------------------------------------------------
// Series sampling

const gapCache = new WeakMap<Series, number>();
/** Longest hold we trust: 2.5x the median spacing (min 15 min). Beyond it the value is "missing", not carried. */
function maxGap(series: Series): number {
  const cached = gapCache.get(series);
  if (cached != null) return cached;
  const d: number[] = [];
  for (let i = 1; i < series.t.length; i++) d.push(series.t[i] - series.t[i - 1]);
  d.sort((a, b) => a - b);
  const med = d.length ? d[Math.floor(d.length / 2)] : 300;
  const g = Math.max(900, med * 2.5);
  gapCache.set(series, g);
  return g;
}

/** Index of the last sample with t[i] <= t, or -1. */
function floorIndex(ts: number[], t: number): number {
  let lo = 0, hi = ts.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Value of a series at time t.
 * step: last sample at or before t. linear: interpolates between neighbours, only when both are present.
 * Returns null before the first sample, after a gap longer than maxGap, and wherever the sample is null.
 */
export function sampleSeries(series: Series, t: number, mode: "step" | "linear" = "step"): number | null {
  const n = series.t.length;
  if (n === 0 || !Number.isFinite(t)) return null;
  const i = floorIndex(series.t, t);
  if (i < 0) return null;
  const v0 = series.v[i];
  if (v0 == null || !Number.isFinite(v0)) return null;
  const gap = maxGap(series);
  if (t - series.t[i] > gap) return null;
  if (mode === "step" || series.t[i] === t || i === n - 1) return v0;
  const v1 = series.v[i + 1];
  if (v1 == null || !Number.isFinite(v1)) return null;
  const span = series.t[i + 1] - series.t[i];
  if (span <= 0 || span > gap) return v0;
  return v0 + ((v1 - v0) * (t - series.t[i])) / span;
}

// ---------------------------------------------------------------------------
// Incidents

export const isActiveAt = (inc: Incident, t: number) => inc.onsetUnix <= t && (inc.endUnix == null || t < inc.endUnix);

/** Engine type plus the optional countdown block the API sends (see @hackutd/contracts). */
type IncidentX = Incident & { countdown?: { status: string; hours: { p10: number; p50: number; p90: number } | null } };

export interface Countdown {
  /** none: not a pump failure or not started yet. unknown: no estimate. counting: shutdown ahead. shut: limit reached. not_filling: tank not rising. */
  kind: "none" | "unknown" | "counting" | "shut" | "not_filling";
  /** Remaining hours from t (shifted from snapshot.nowUnix), null when unknown. */
  remainingHours: { p10: number; p50: number; p90: number } | null;
  /** Absolute predicted shutdown time per percentile, null when unknown. */
  shutdownUnix: { p10: number; p50: number; p90: number } | null;
}

/** Predicted shutdown is fixed at snapshot.nowUnix + hoursToLimit; the remaining time shifts with t. */
export function countdownAt(incident: Incident, snapshot: Snapshot, t: number): Countdown {
  const none: Countdown = { kind: "none", remainingHours: null, shutdownUnix: null };
  if (incident.category !== "pump_failure" || t < incident.onsetUnix) return none;
  const x = incident as IncidentX;
  const status = x.countdown?.status;
  if (status === "at_limit") return { kind: "shut", remainingHours: null, shutdownUnix: null };
  if (status === "not_filling") return { kind: "not_filling", remainingHours: null, shutdownUnix: null };
  const h = incident.hoursToLimit ?? x.countdown?.hours ?? null;
  if (!h || !Number.isFinite(h.p10) || !Number.isFinite(h.p50) || !Number.isFinite(h.p90)) return { kind: "unknown", remainingHours: null, shutdownUnix: null };
  const base = snapshot.nowUnix;
  const shutdownUnix = { p10: base + h.p10 * 3600, p50: base + h.p50 * 3600, p90: base + h.p90 * 3600 };
  const remaining = { p10: (shutdownUnix.p10 - t) / 3600, p50: (shutdownUnix.p50 - t) / 3600, p90: (shutdownUnix.p90 - t) / 3600 };
  if (remaining.p50 <= 0) return { kind: "shut", remainingHours: remaining, shutdownUnix };
  return { kind: "counting", remainingHours: remaining, shutdownUnix };
}

const CATEGORY_RANK: Record<Incident["category"], number> = { pump_failure: 0, pipeline_leak: 1, pump_degradation: 2, facility_shut_in: 3 };

/**
 * Alerts + history active at t, ordered per hard rule 7: pump failures first, soonest shutdown first (p50, unknown
 * last), ties to the higher lost revenue per hour; then leaks, worn pumps and the rest, newest onset first.
 */
export function incidentsAt(snapshot: Snapshot, t: number): Incident[] {
  const seen = new Set<string>();
  const out: Incident[] = [];
  for (const inc of [...snapshot.alerts, ...snapshot.history]) {
    if (seen.has(inc.id) || !isActiveAt(inc, t)) continue;
    seen.add(inc.id);
    out.push(inc);
  }
  const eta = (i: Incident) => countdownAt(i, snapshot, t).shutdownUnix?.p50 ?? Infinity;
  return out.sort((a, b) => {
    const ra = CATEGORY_RANK[a.category], rb = CATEGORY_RANK[b.category];
    if (ra !== rb) return ra - rb;
    if (a.category === "pump_failure") {
      const ea = eta(a), eb = eta(b);
      if (ea !== eb) return ea < eb ? -1 : 1;
      return (b.lostRevenuePerHour ?? 0) - (a.lostRevenuePerHour ?? 0);
    }
    return b.onsetUnix - a.onsetUnix;
  });
}

// ---------------------------------------------------------------------------
// Facilities

export type FacilityStatus = "flowing" | "idle" | "down" | "leak" | "worn" | "shut" | "nodata";

export interface FacilityAt {
  levelPct: number | null;
  inflowBpd: number | null;
  pumpFlowBpd: number | null;
  receiveFlowBpd: number | null;
  status: FacilityStatus;
  quality: Quality;
  activeIncidents: Incident[];
}

const STEP = 300;
/**
 * Status at t. Incidents win over missing data (the detector knows something is wrong); otherwise any missing key
 * channel (level or pump flow) is "nodata", never flowing/idle (hard rule 9).
 * Quality: within one step of snapshot.nowUnix it is the snapshot's own data quality; earlier it is derived from
 * the sampled series (level or pump flow null => DROPPED, else VALID), because per-step quality is not in the snapshot.
 */
export function facilityAt(snapshot: Snapshot, facility: FacilityState, t: number): FacilityAt {
  const levelPct = sampleSeries(facility.series.level, t, "linear");
  const inflowBpd = sampleSeries(facility.series.inflow, t, "step");
  const pumpFlowBpd = sampleSeries(facility.series.pumpFlow, t, "step");
  const receiveFlowBpd = sampleSeries(facility.series.receiveFlow, t, "step");
  const activeIncidents = incidentsAt(snapshot, t).filter((i) => i.facilityId === facility.id);
  const quality: Quality = t >= snapshot.nowUnix - STEP && t <= snapshot.nowUnix + STEP
    ? facility.dataQuality.quality
    : levelPct == null || pumpFlowBpd == null ? "DROPPED" : "VALID";
  const has = (c: Incident["category"]) => activeIncidents.some((i) => i.category === c);
  let status: FacilityStatus;
  if (has("facility_shut_in") || (has("pump_failure") && levelPct != null && levelPct >= snapshot.limits.shutdownPct)) status = "shut";
  else if (has("pump_failure")) status = "down";
  else if (has("pipeline_leak")) status = "leak";
  else if (has("pump_degradation")) status = "worn";
  else if (levelPct == null || pumpFlowBpd == null || quality === "INVALID" || quality === "DROPPED") status = "nodata";
  else status = pumpFlowBpd > 0 ? "flowing" : "idle";
  return { levelPct, inflowBpd, pumpFlowBpd, receiveFlowBpd, status, quality, activeIncidents };
}

const SEVERITY: Record<FacilityStatus, number> = { shut: 5, down: 4, leak: 3, worn: 3, nodata: 2, idle: 1, flowing: 0 };
/** Worst facility status in a system at t (for the rail glyph). */
export function systemStatusAt(snapshot: Snapshot, system: SystemState, t: number): FacilityStatus {
  let worst: FacilityStatus = "flowing";
  let any = false;
  for (const f of system.facilities) {
    const s = facilityAt(snapshot, f, t).status;
    if (!any || SEVERITY[s] > SEVERITY[worst]) worst = s;
    any = true;
  }
  return any ? worst : "nodata";
}

// ---------------------------------------------------------------------------
// Trucks

export type TruckPhase = "yard" | "outbound" | "unloading" | "returning";
export interface TruckPosition {
  truck: number;
  incidentId: string | null;
  facilityId: string | null;
  phase: TruckPhase;
  /** 0 at the yard, 1 at the facility stop (outbound rises, returning falls, unloading is 1). */
  progress: number;
  /** Ghost until the plan is acknowledged (approved). Idle yard trucks are not planned. */
  planned: boolean;
}

/** Share of the post-arrival window spent unloading before the drive back. Assumption (the snapshot has no unload time). */
export const UNLOAD_SHARE = 0.4;

/**
 * Truck positions for one system at t, a pure function of the schedule. Assumptions (documented, not data):
 *  - one-way drive time T = first arrival - call time (the plan's response time); never longer than the gap to the
 *    previous arrival, so back-to-back trips shorten the leg instead of overlapping;
 *  - after arriving, the truck unloads for UNLOAD_SHARE of the time until it must leave for its next trip (or until
 *    toUnix for the last trip), then drives back to the yard;
 *  - arrivals come from the assignment's tripsArrivalUnix; if empty, from plan.truckArrivalsMin (minutes from the
 *    call) split round-robin across the incident's assigned trucks;
 *  - outside [fromUnix, toUnix] a truck is parked at the yard;
 *  - `approved` holds acknowledged incident ids or plan ids; anything else is a ghost (planned: true).
 * Every truck 1..fleet.size is returned; trucks with no assignment active at t are idle at the yard.
 */
export function truckPositions(snapshot: Snapshot, systemId: string, t: number, approved: readonly string[] | ReadonlySet<string>): TruckPosition[] {
  const fleet: FleetState | undefined = snapshot.fleets.find((f) => f.systemId === systemId);
  const system = snapshot.systems.find((s) => s.id === systemId);
  const size = fleet?.size ?? system?.fleetSize ?? 0;
  const isApproved = (id: string | undefined) => id != null && (Array.isArray(approved) ? approved.includes(id) : (approved as ReadonlySet<string>).has(id));
  const all = [...snapshot.alerts, ...snapshot.history];
  const out: TruckPosition[] = [];
  for (let truck = 1; truck <= size; truck++) {
    const mine = (fleet?.assignments ?? []).filter((a) => a.truck === truck);
    const a = mine.find((x) => t >= x.fromUnix && t <= x.toUnix);
    if (!a) { out.push({ truck, incidentId: null, facilityId: null, phase: "yard", progress: 0, planned: false }); continue; }
    const inc = all.find((i) => i.id === a.incidentId);
    const plan: PlanOption | undefined = inc?.plan;
    const planned = !(isApproved(a.incidentId) || isApproved((plan as { id?: string } | undefined)?.id));
    let arrivals = [...a.tripsArrivalUnix].sort((x, y) => x - y);
    if (arrivals.length === 0 && plan && plan.truckArrivalsMin.length > 0) {
      const mates = fleet!.assignments.filter((x) => x.incidentId === a.incidentId).map((x) => x.truck).sort((x, y) => x - y);
      const idx = Math.max(0, mates.indexOf(truck));
      arrivals = [...plan.truckArrivalsMin].sort((x, y) => x - y).filter((_, i) => i % Math.max(1, mates.length) === idx).map((m) => a.fromUnix + m * 60);
    }
    const base = { truck, incidentId: a.incidentId, facilityId: a.facilityId, planned };
    if (arrivals.length === 0) { out.push({ ...base, phase: "yard", progress: 0 }); continue; }
    const T = Math.max(0, arrivals[0] - a.fromUnix);
    // Leg k: outbound [arr-Tk, arr], then unload+return window until the next outbound start (or toUnix).
    let pos: Pick<TruckPosition, "phase" | "progress"> = { phase: "yard", progress: 0 };
    let prevEnd = a.fromUnix;
    for (let k = 0; k < arrivals.length; k++) {
      const arr = arrivals[k];
      const Tk = Math.min(T, Math.max(0, arr - prevEnd));
      const outStart = arr - Tk;
      const next = k + 1 < arrivals.length ? arrivals[k + 1] - Math.min(T, Math.max(0, arrivals[k + 1] - arr)) : Math.max(a.toUnix, arr);
      if (t < outStart) break; // parked until this trip's departure
      if (t < arr) { pos = { phase: "outbound", progress: Tk > 0 ? (t - outStart) / Tk : 1 }; break; }
      const unloadEnd = arr + (next - arr) * UNLOAD_SHARE;
      if (t < unloadEnd) { pos = { phase: "unloading", progress: 1 }; break; }
      if (t < next) { pos = { phase: "returning", progress: 1 - (t - unloadEnd) / Math.max(1, next - unloadEnd) }; break; }
      prevEnd = arr;
    }
    out.push({ ...base, ...pos });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ticker

export interface TickerItem {
  key: string;
  label: string;
  /** null = UNKNOWN (render in a dithered cell, never 0 or $0). */
  value: string | number | null;
  unit: "text" | "count" | "usd" | "clock" | "datetime";
}

/** The KV strip from brief 2.1, evaluated at t. Unknowns are null. */
export function tickerAt(snapshot: Snapshot, t: number): TickerItem[] {
  const incidents = incidentsAt(snapshot, t);
  const failures = incidents.filter((i) => i.category === "pump_failure");
  const inspect = incidents.filter((i) => i.category === "pipeline_leak" || i.category === "pump_degradation");

  const shutdowns = failures.map((i) => countdownAt(i, snapshot, t)).filter((c) => c.kind === "counting" || c.kind === "shut");
  const knownEtas = shutdowns.map((c) => c.shutdownUnix?.p50).filter((x): x is number => x != null);
  const firstShutdown: TickerItem["value"] = failures.length === 0 ? "NONE" : knownEtas.length > 0 ? Math.min(...knownEtas) : null;

  const planCosts = failures.map((i) => i.plan?.cost);
  const plan = failures.length === 0 ? 0 : planCosts.every((c): c is number => c != null) ? planCosts.reduce((s, c) => s + c, 0) : null;
  const idleCosts = failures.map((i) => i.options?.find((o) => o.kind === "do_nothing")?.cost);
  const ifNobody = failures.length === 0 ? 0 : idleCosts.every((c): c is number => c != null) ? idleCosts.reduce((s, c) => s + c, 0) : null;

  let size = 0, free = 0;
  for (const f of snapshot.fleets) {
    size += f.size;
    const busy = new Set(f.assignments.filter((a) => t >= a.fromUnix && t <= a.toUnix).map((a) => a.truck));
    free += f.size - busy.size;
  }

  let noData = 0;
  for (const s of snapshot.systems) for (const f of s.facilities) if (facilityAt(snapshot, f, t).status === "nodata") noData++;

  const b = snapshot.board;
  const board: TickerItem["value"] = b == null ? (b === null ? "BOARD UNAVAILABLE" : "LOCAL") :
    b.provenance === "fpga" ? (b.weightsVersion != null ? `FPGA v${b.weightsVersion}` : "FPGA") :
    b.provenance === "software" ? "SOFTWARE, NOT BIT-EXACT" : "BOARD UNAVAILABLE";
  const latched = b ? b.facilities.filter((f) => f.alarm !== "none" && f.alarmState === "raised").length : null;

  return [
    { key: "now", label: "NOW", value: t, unit: "datetime" },
    { key: "pumpsDown", label: "PUMPS DOWN", value: failures.length, unit: "count" },
    { key: "firstShutdown", label: "FIRST SHUTDOWN", value: firstShutdown, unit: typeof firstShutdown === "number" ? "clock" : "text" },
    { key: "plan", label: "PLAN", value: plan, unit: "usd" },
    { key: "ifNobodyActs", label: "IF NOBODY ACTS", value: ifNobody, unit: "usd" },
    { key: "trucksFree", label: "TRUCKS FREE", value: snapshot.fleets.length === 0 ? null : `${free}/${size}`, unit: "text" },
    { key: "inspect", label: "INSPECT", value: inspect.length, unit: "count" },
    { key: "noData", label: "NO DATA", value: noData, unit: "count" },
    { key: "board", label: "BOARD", value: board, unit: "text" },
    { key: "alarms", label: "ALARMS LATCHED", value: latched, unit: "count" },
  ];
}

/** Text for a TickerItem value ("UNKNOWN" for null). */
export function tickerText(item: TickerItem): string {
  if (item.value == null) return "UNKNOWN";
  if (typeof item.value === "string") return item.value;
  if (item.unit === "datetime") return stamp(item.value);
  if (item.unit === "clock") return hhmm(item.value);
  if (item.unit === "usd") return `$${Math.round(item.value).toLocaleString("en-US")}`;
  return String(item.value);
}

// ---------------------------------------------------------------------------
// Colors

/** Neon line identity by facility order within a system (brief section 3). Never red, amber or magenta. */
export function lineColor(index: number): string {
  const i = ((Math.trunc(index) % 8) + 8) % 8;
  return `var(--n${i + 1})`;
}
