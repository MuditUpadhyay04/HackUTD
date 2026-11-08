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
export const isLive = (snapshot: Snapshot) => snapshot.nowUnix >= (snapshot.dataset?.nowUnix ?? snapshot.nowUnix);

// ---------------------------------------------------------------------------
// Projection (what-if zone after snapshot.nowUnix; hard rule 6: never recorded telemetry, never committed as a run)

/** Incident or plan ids acknowledged in this run (the store's `approved`). */
export type Approved = readonly string[] | ReadonlySet<string>;
const NO_APPROVAL: readonly string[] = [];
const hasId = (approved: Approved, id: string | undefined) =>
  id != null && (Array.isArray(approved) ? (approved as readonly string[]).includes(id) : (approved as ReadonlySet<string>).has(id));

/** The projection never runs further than this past nowUnix. */
export const PROJECTION_CAP_SECONDS = 48 * 3600;

type Curve = PlanOption["levelCurve"];
const curveEndMin = (c: Curve | undefined) => (c ?? []).reduce((m, p) => (Number.isFinite(p.min) ? Math.max(m, p.min) : m), 0);

const projectionCache = new WeakMap<Snapshot, number | null>();
/**
 * Last second the playhead may reach past nowUnix, or null when there is no projection. Needs a live snapshot (run at
 * the dataset end) and at least one ongoing pump failure. It is the latest of each ongoing failure's repairEndsUnix,
 * its truck assignments' toUnix and nowUnix + the last level curve minute of its plans, capped at nowUnix + 48 h.
 */
export function projectionEnd(snapshot: Snapshot): number | null {
  if (projectionCache.has(snapshot)) return projectionCache.get(snapshot) ?? null;
  let result: number | null = null;
  if (isLive(snapshot)) {
    const now = snapshot.nowUnix;
    const failures = (snapshot.alerts ?? []).filter((i) => i.category === "pump_failure" && i.status === "ongoing" && isActiveAt(i, now));
    if (failures.length > 0) {
      let end = now;
      const take = (x: number | undefined) => { if (x != null && Number.isFinite(x)) end = Math.max(end, x); };
      for (const inc of failures) {
        take(inc.repairEndsUnix);
        for (const f of snapshot.fleets ?? []) for (const a of f.assignments) if (a.incidentId === inc.id) take(a.toUnix);
        for (const o of [inc.plan, ...(inc.options ?? [])]) if (o) take(now + curveEndMin(o.levelCurve) * 60);
      }
      end = Math.min(end, now + PROJECTION_CAP_SECONDS);
      result = end > now ? end : null;
    }
  }
  projectionCache.set(snapshot, result);
  return result;
}

/** True when t is past the last reading of a live snapshot that has a projection (labelled PROJECTED everywhere). */
export function isProjected(snapshot: Snapshot, t: number): boolean {
  return t > snapshot.nowUnix && projectionEnd(snapshot) != null;
}

export type Following = "approved" | "do_nothing" | "unknown";
export interface Followed { following: Following; curve: Curve | null }

/** Plan ids that mean "acknowledged": the incident id, the plan's systemPlanId (API) or id. */
export function isPlanApproved(incident: Incident, approved: Approved): boolean {
  const plan = incident.plan as (PlanOption & { id?: string; systemPlanId?: string }) | undefined;
  return hasId(approved, incident.id) || hasId(approved, plan?.systemPlanId) || hasId(approved, plan?.id);
}

/**
 * The level curve a failing facility follows past nowUnix: the recommended plan once approved, otherwise the
 * do_nothing option. No usable curve => "unknown" (the level is held and flagged, never invented).
 */
export function followedCurve(incident: Incident, approved: Approved = NO_APPROVAL): Followed {
  const usable = (o: PlanOption | undefined): Curve | null => (o && o.levelCurve && o.levelCurve.length > 0 ? [...o.levelCurve].sort((a, b) => a.min - b.min) : null);
  if (isPlanApproved(incident, approved)) {
    const c = usable(incident.plan);
    return c ? { following: "approved", curve: c } : { following: "unknown", curve: null };
  }
  const idle = incident.options?.find((o) => o.kind === "do_nothing") ?? (incident.plan?.kind === "do_nothing" ? incident.plan : undefined);
  const c = usable(idle);
  return c ? { following: "do_nothing", curve: c } : { following: "unknown", curve: null };
}

/** Linear level at `min` minutes from nowUnix; clamped to the curve's first and last points. */
export function curveLevelAt(curve: Curve, min: number): number {
  if (min <= curve[0].min) return curve[0].pct;
  const last = curve[curve.length - 1];
  if (min >= last.min) return last.pct;
  let i = 0;
  while (i + 1 < curve.length && curve[i + 1].min <= min) i++;
  const a = curve[i], b = curve[i + 1];
  return b.min === a.min ? b.pct : a.pct + ((b.pct - a.pct) * (min - a.min)) / (b.min - a.min);
}

/** Minutes from nowUnix at which the curve first reaches `limitPct`, or null when it never does. */
export function curveTripMin(curve: Curve, limitPct: number): number | null {
  for (let i = 0; i < curve.length; i++) {
    if (curve[i].pct < limitPct) continue;
    if (i === 0) return Math.max(0, curve[0].min);
    const a = curve[i - 1], b = curve[i];
    return a.min + ((limitPct - a.pct) * (b.min - a.min)) / (b.pct - a.pct);
  }
  return null;
}

export interface SystemFollowing { systemId: string; following: Following }
/** Per system with an ongoing pump failure, what the projection follows (approved only when every failure is approved). */
export function projectionFollowing(snapshot: Snapshot, approved: Approved = NO_APPROVAL): SystemFollowing[] {
  const out = new Map<string, Following>();
  for (const inc of incidentsAt(snapshot, snapshot.nowUnix)) {
    if (inc.category !== "pump_failure" || inc.status !== "ongoing") continue;
    const f = followedCurve(inc, approved).following;
    const prev = out.get(inc.systemId);
    if (prev == null) out.set(inc.systemId, f);
    else if (prev !== f) out.set(inc.systemId, prev === "unknown" || f === "unknown" ? "unknown" : "do_nothing");
  }
  return [...out].map(([systemId, following]) => ({ systemId, following }));
}

/** "+2H 10M" (rounded to the minute) for the projected clock. */
export function projectedOffsetText(snapshot: Snapshot, t: number): string {
  const total = Math.max(0, Math.round((t - snapshot.nowUnix) / 60));
  const h = Math.floor(total / 60), m = total % 60;
  return h > 0 ? `+${h}H ${m}M` : `+${m}M`;
}

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
  /** none: not a pump failure or not started yet. unknown: no estimate. counting: shutdown ahead. shut: limit reached. not_filling: tank not rising. averted: (projected only) the followed level curve never reaches the limit. */
  kind: "none" | "unknown" | "counting" | "shut" | "not_filling" | "averted";
  /** Remaining hours from t (shifted from snapshot.nowUnix), null when unknown. */
  remainingHours: { p10: number; p50: number; p90: number } | null;
  /** Absolute predicted shutdown time per percentile, null when unknown. */
  shutdownUnix: { p10: number; p50: number; p90: number } | null;
}

/**
 * Predicted shutdown is fixed at snapshot.nowUnix + hoursToLimit; the remaining time shifts with t.
 * Past nowUnix (projection) it follows the same level curve the facility follows: shutdown is where that curve first
 * reaches limits.shutdownPct (p10, p50 and p90 collapse to that one projected time).
 */
export function countdownAt(incident: Incident, snapshot: Snapshot, t: number, approved: Approved = NO_APPROVAL): Countdown {
  const none: Countdown = { kind: "none", remainingHours: null, shutdownUnix: null };
  if (incident.category !== "pump_failure" || t < incident.onsetUnix) return none;
  if (isProjected(snapshot, t)) {
    const { curve } = followedCurve(incident, approved);
    if (!curve) return { kind: "unknown", remainingHours: null, shutdownUnix: null };
    const min = curveTripMin(curve, snapshot.limits.shutdownPct);
    if (min == null) return { kind: "averted", remainingHours: null, shutdownUnix: null };
    const at = snapshot.nowUnix + min * 60;
    const r = (at - t) / 3600;
    const shutdownUnix = { p10: at, p50: at, p90: at };
    return r <= 0 ? { kind: "shut", remainingHours: { p10: r, p50: r, p90: r }, shutdownUnix } : { kind: "counting", remainingHours: { p10: r, p50: r, p90: r }, shutdownUnix };
  }
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
  /** True past snapshot.nowUnix: a what-if projection, not recorded telemetry. */
  projected: boolean;
  /** Projected pump failure only: which level curve the tank follows. */
  following: Following | null;
}

const STEP = 300;
/**
 * Status at t. Incidents win over missing data (the detector knows something is wrong); otherwise any missing key
 * channel (level or pump flow) is "nodata", never flowing/idle (hard rule 9).
 * Quality: within one step of snapshot.nowUnix it is the snapshot's own data quality; earlier it is derived from
 * the sampled series (level or pump flow null => DROPPED, else VALID), because per-step quality is not in the snapshot.
 */
export function facilityAt(snapshot: Snapshot, facility: FacilityState, t: number, approved: Approved = NO_APPROVAL): FacilityAt {
  // Past nowUnix every channel holds its last known value (never new flows); only a failing tank follows a curve.
  const projected = isProjected(snapshot, t);
  const ts = projected ? snapshot.nowUnix : t;
  let levelPct = sampleSeries(facility.series.level, ts, "linear");
  const inflowBpd = sampleSeries(facility.series.inflow, ts, "step");
  const pumpFlowBpd = sampleSeries(facility.series.pumpFlow, ts, "step");
  const receiveFlowBpd = sampleSeries(facility.series.receiveFlow, ts, "step");
  const activeIncidents = incidentsAt(snapshot, t).filter((i) => i.facilityId === facility.id);
  const quality: Quality = projected || (t >= snapshot.nowUnix - STEP && t <= snapshot.nowUnix + STEP)
    ? facility.dataQuality.quality
    : levelPct == null || pumpFlowBpd == null ? "DROPPED" : "VALID";
  const has = (c: Incident["category"]) => activeIncidents.some((i) => i.category === c);
  let following: Following | null = null;
  let tripped = false;
  const failing = projected ? activeIncidents.find((i) => i.category === "pump_failure") : undefined;
  if (failing) {
    const f = followedCurve(failing, approved);
    following = f.following;
    if (f.curve) {
      const min = (t - snapshot.nowUnix) / 60;
      levelPct = curveLevelAt(f.curve, min);
      const trip = curveTripMin(f.curve, snapshot.limits.shutdownPct);
      tripped = trip != null && min >= trip;
    }
  }
  let status: FacilityStatus;
  if (has("facility_shut_in") || tripped || (has("pump_failure") && levelPct != null && levelPct >= snapshot.limits.shutdownPct)) status = "shut";
  else if (has("pump_failure")) status = "down";
  else if (has("pipeline_leak")) status = "leak";
  else if (has("pump_degradation")) status = "worn";
  else if (levelPct == null || pumpFlowBpd == null || quality === "INVALID" || quality === "DROPPED") status = "nodata";
  else status = pumpFlowBpd > 0 ? "flowing" : "idle";
  return { levelPct, inflowBpd, pumpFlowBpd, receiveFlowBpd, status, quality, activeIncidents, projected, following };
}

const SEVERITY: Record<FacilityStatus, number> = { shut: 5, down: 4, leak: 3, worn: 3, nodata: 2, idle: 1, flowing: 0 };
/** Worst facility status in a system at t (for the rail glyph). */
export function systemStatusAt(snapshot: Snapshot, system: SystemState, t: number, approved: Approved = NO_APPROVAL): FacilityStatus {
  let worst: FacilityStatus = "flowing";
  let any = false;
  for (const f of system.facilities) {
    const s = facilityAt(snapshot, f, t, approved).status;
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
export function truckPositions(snapshot: Snapshot, systemId: string, t: number, approved: Approved): TruckPosition[] {
  const fleet: FleetState | undefined = snapshot.fleets.find((f) => f.systemId === systemId);
  const system = snapshot.systems.find((s) => s.id === systemId);
  const size = fleet?.size ?? system?.fleetSize ?? 0;
  const all = [...snapshot.alerts, ...snapshot.history];
  const out: TruckPosition[] = [];
  for (let truck = 1; truck <= size; truck++) {
    const mine = (fleet?.assignments ?? []).filter((a) => a.truck === truck);
    const a = mine.find((x) => t >= x.fromUnix && t <= x.toUnix);
    if (!a) { out.push({ truck, incidentId: null, facilityId: null, phase: "yard", progress: 0, planned: false }); continue; }
    const inc = all.find((i) => i.id === a.incidentId);
    const plan: PlanOption | undefined = inc?.plan;
    const planned = !(hasId(approved, a.incidentId) || (inc != null && isPlanApproved(inc, approved)));
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
  /** True for a projected (what-if) value: the ticker styles it amber on dither. */
  projected?: boolean;
}

/** The KV strip from brief 2.1, evaluated at t. Unknowns are null. */
export function tickerAt(snapshot: Snapshot, t: number, approved: Approved = NO_APPROVAL): TickerItem[] {
  const incidents = incidentsAt(snapshot, t);
  const failures = incidents.filter((i) => i.category === "pump_failure");
  const inspect = incidents.filter((i) => i.category === "pipeline_leak" || i.category === "pump_degradation");

  const countdowns = failures.map((i) => countdownAt(i, snapshot, t, approved));
  const shutdowns = countdowns.filter((c) => c.kind === "counting" || c.kind === "shut");
  const knownEtas = shutdowns.map((c) => c.shutdownUnix?.p50).filter((x): x is number => x != null);
  const firstShutdown: TickerItem["value"] = failures.length === 0 || (knownEtas.length === 0 && countdowns.every((c) => c.kind === "averted")) ? "NONE" : knownEtas.length > 0 ? Math.min(...knownEtas) : null;

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
  for (const s of snapshot.systems) for (const f of s.facilities) if (facilityAt(snapshot, f, t, approved).status === "nodata") noData++;

  const b = snapshot.board;
  const board: TickerItem["value"] = b == null ? (b === null ? "UNAVAILABLE" : "LOCAL") :
    b.provenance === "fpga" ? (b.weightsVersion != null ? `FPGA v${b.weightsVersion}` : "FPGA") :
    b.provenance === "software" ? "SOFTWARE, NOT BIT-EXACT" : "UNAVAILABLE";
  const latched = b ? b.facilities.filter((f) => f.alarm !== "none" && f.alarmState === "raised").length : null;

  return [
    isProjected(snapshot, t)
      ? { key: "now", label: "NOW", value: `PROJECTED ${projectedOffsetText(snapshot, t)}`, unit: "text", projected: true }
      : { key: "now", label: "NOW", value: t, unit: "datetime" },
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
