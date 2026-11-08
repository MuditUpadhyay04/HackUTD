// Build the full console Snapshot at "now" (or any earlier moment, for time travel).
import type { DataQuality, FacilityHealth, FacilityState, FleetState, Incident, PlanOption, Quality, Series, Snapshot, SystemState, TruckAssignment, WellState } from "./types";
import { datasetInfo, loadDataset, Q_VALID, Q_HELD, Q_INVALID, type LoadedDataset } from "./datasets";
import { facilityContexts, lastFinite, when, type FacilityCtx } from "./model";
import { detect, type RawEvent } from "./detect";
import { allocateFleet, estimateTank, hoursToLimit, planOptions, truckBusyUntilMin, type TankJob, type Trucking } from "./plan";

const facCache = new WeakMap<LoadedDataset, FacilityCtx[]>();
function facsOf(ds: LoadedDataset): FacilityCtx[] {
  let f = facCache.get(ds);
  if (!f) {
    f = facilityContexts(ds);
    facCache.set(ds, f);
  }
  return f;
}

const snapCache = new Map<string, Snapshot>();
const SNAP_CACHE_MAX = 48;
const LEVEL_WIN = 72; // steps of readings used to pin the tank level during a failure

function stepOf(ds: LoadedDataset, atUnix?: number): number {
  if (atUnix === undefined || !Number.isFinite(atUnix)) return ds.n - 1;
  return Math.max(0, Math.min(ds.n - 1, Math.floor((atUnix - ds.t0) / ds.dt)));
}

function shutdownPct(ds: LoadedDataset): number {
  return ds.network.defaults.tank_limits_pct.shutdown;
}

function trucking(ds: LoadedDataset): Trucking {
  return { capacityBbl: ds.ops.emergency_trucking.truck_capacity_bbl, costPerTrip: ds.ops.emergency_trucking.cost_per_trip };
}

function repairMin(ds: LoadedDataset): number {
  return ds.ops.expected_repair_hours.pump_failure * 60;
}

function median(xs: number[]): number | undefined {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : undefined;
}

/**
 * Truck times for a facility. If ops.json leaves them out, use the median of the same system's
 * facilities (then of every facility), and flag it so the operator sees the plan rests on an estimate.
 */
function facOps(ds: LoadedDataset, fc: FacilityCtx) {
  const s = ds.ops.systems[fc.sys.id];
  const f = s?.facilities?.[fc.fac.id];
  const sys = Object.values(s?.facilities ?? {});
  const all = Object.values(ds.ops.systems ?? {}).flatMap((x) => Object.values(x?.facilities ?? {}));
  const pick = (k: "response_min" | "cycle_min", fallback: number) =>
    f?.[k] ?? median(sys.map((x) => x[k])) ?? median(all.map((x) => x[k])) ?? fallback;
  return {
    fleet: s?.emergency_fleet_size ?? 0,
    responseMin: pick("response_min", 60),
    cycleMin: pick("cycle_min", 240),
    estimated: f?.response_min == null || f?.cycle_min == null,
    noSystem: !s,
  };
}

export function incidentId(e: { assetId: string }, onsetUnix: number): string {
  return `${e.assetId}@${onsetUnix}`;
}

/**
 * Build a planning job for a pump failure.
 *  at      : step the plan starts at
 *  winFrom/winTo : readings used to estimate the level at `at`
 */
function makeJob(ds: LoadedDataset, e: RawEvent, at: number, winFrom: number, winTo: number): { job: TankJob; est: ReturnType<typeof estimateTank> } {
  const sd = shutdownPct(ds);
  const est = estimateTank(ds, e.fc, e.onsetIdx, at, winFrom, winTo, sd);
  const startUnix = ds.t0 + at * ds.dt;
  const repairEnd = ds.t0 + e.onsetIdx * ds.dt + repairMin(ds) * 60;
  const o = facOps(ds, e.fc);
  const job: TankJob = {
    key: incidentId(e, ds.t0 + e.onsetIdx * ds.dt),
    fc: e.fc,
    startUnix,
    levelPct: est.planLevelPct,
    capacityBbl: e.fc.fac.tank.capacity_bbl,
    shutdownPct: sd,
    wells: est.wells,
    horizonMin: Math.max(0, (repairEnd - startUnix) / 60),
    responseMin: o.responseMin,
    cycleMin: o.cycleMin,
    tripped: est.tripped,
  };
  return { job, est };
}

export interface OnsetPlan {
  incidentId: string;
  event: RawEvent;
  job: TankJob;
  plan: PlanOption;
  options: PlanOption[];
  freeTrucks: number;
}

/**
 * "At onset" planning (how full_week reference actions are defined): each failure is planned at its
 * own onset, in onset order, with trucks still busy on earlier plans in the same system unavailable.
 * Level at onset is estimated from the first hour of readings after onset (hindsight, for review).
 */
export function plansAtOnset(ds: LoadedDataset, events: RawEvent[], N: number): OnsetPlan[] {
  const tk = trucking(ds);
  const busy = new Map<string, number[]>(); // system -> busy-until unix per truck
  const out: OnsetPlan[] = [];
  for (const e of events.filter((x) => x.category === "pump_failure").sort((a, b) => a.onsetIdx - b.onsetIdx)) {
    const { job } = makeJob(ds, e, e.onsetIdx, e.onsetIdx, Math.min(N, e.onsetIdx + LEVEL_WIN));
    const o = facOps(ds, e.fc);
    const b = busy.get(e.fc.sys.id) ?? [];
    const free = Math.max(0, o.fleet - b.filter((u) => u > job.startUnix).length);
    const { plan, options } = planOptions(job, tk, free);
    if (plan.trucks > 0) {
      const until = job.startUnix + truckBusyUntilMin(job, plan) * 60;
      const nb = b.filter((u) => u > job.startUnix);
      for (let k = 0; k < plan.trucks; k++) nb.push(until);
      busy.set(e.fc.sys.id, nb);
    }
    out.push({ incidentId: job.key, event: e, job, plan, options, freeTrucks: free });
  }
  return out;
}

function downsample(ds: LoadedDataset, arr: Float64Array, from: number, to: number, maxPts = 200): Series {
  const len = to - from + 1;
  const stride = Math.max(1, Math.ceil(len / maxPts));
  const t: number[] = [];
  const v: number[] = [];
  // align so the last point is exactly `to`
  const start = to - Math.floor((len - 1) / stride) * stride;
  // Missing points show the last real value (flagged through FacilityState.dataQuality), never 0.
  let lead = NaN;
  for (let i = start; i <= to && Number.isNaN(lead); i++) if (Number.isFinite(arr[i])) lead = arr[i];
  for (let i = start; i <= to; i += stride) {
    t.push(ds.t0 + i * ds.dt);
    let x = arr[i];
    if (!Number.isFinite(x)) x = lastFinite(arr, i);
    if (!Number.isFinite(x)) x = lead;
    v.push(Number.isFinite(x) ? Math.round(x * 100) / 100 : 0);
  }
  return { t, v };
}

/** Mean of the finite readings in [from, to]; with none, the last real value before; else 0. */
function avg(arr: Float64Array, from: number, to: number): number {
  let s = 0;
  let n = 0;
  for (let i = Math.max(0, from); i <= to; i++) {
    if (Number.isFinite(arr[i])) {
      s += arr[i];
      n++;
    }
  }
  if (n) return s / n;
  const last = lastFinite(arr, to);
  return Number.isFinite(last) ? last : 0;
}

/** Latest value for display: the reading at N (measured or held), else the last real one, else `fallback`. */
function shown(arr: Float64Array, N: number, fallback = 0): number {
  const x = Number.isFinite(arr[N]) ? arr[N] : lastFinite(arr, N);
  return Number.isFinite(x) ? x : fallback;
}

const QUALITY: Quality[] = ["VALID", "HELD", "INVALID", "DROPPED"];
const CHANNELS = [
  ["level", "Tank level"],
  ["pumpStatus", "Pump status"],
  ["flow", "Pump flow"],
  ["inflow", "Tank inflow"],
] as const;

function fmtAgo(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** Quality of a facility's key readings (level, pump status, pump flow, inflow) at step N. */
function facilityQuality(ds: LoadedDataset, fc: FacilityCtx, N: number): DataQuality {
  const nowUnix = ds.t0 + N * ds.dt;
  let worst = Q_VALID;
  const reasons: string[] = [];
  for (const [ch, name] of CHANNELS) {
    const { q, lastObs } = fc.quality[ch];
    const code = q[N];
    if (code === Q_VALID) continue;
    worst = Math.max(worst, code);
    const lo = lastObs[N];
    if (lo < 0) {
      reasons.push(code === Q_INVALID ? `${name} readings are blank or unreadable` : `${name} has no readings`);
      continue;
    }
    const ago = fmtAgo(((N - lo) * ds.dt) / 60);
    const at = when(ds.t0 + lo * ds.dt, nowUnix);
    if (code === Q_HELD) reasons.push(`${name} not reported for ${ago}; showing the ${at} reading`);
    else if (code === Q_INVALID) reasons.push(`${name} blank or unreadable for ${ago}; last good reading at ${at}`);
    else reasons.push(`${name} not reported for ${ago}; last reading at ${at}`);
  }
  return { quality: QUALITY[worst], reasons };
}

export async function getSnapshot(datasetId: string, atUnix?: number): Promise<Snapshot> {
  return buildSnapshot(datasetId, atUnix);
}

export function buildSnapshot(datasetId: string, atUnix?: number): Snapshot {
  const ds = loadDataset(datasetId);
  const N = stepOf(ds, atUnix);
  const ck = `${ds.id}|${ds.mtimeKey}|${N}`;
  const hit = snapCache.get(ck);
  if (hit) return hit;

  const nowUnix = ds.t0 + N * ds.dt;
  const facs = facsOf(ds);
  const sd = shutdownPct(ds);
  const tk = trucking(ds);
  const { events } = detect(ds, facs, N);
  const qualityOf = new Map<FacilityCtx, DataQuality>();
  for (const fc of facs) qualityOf.set(fc, facilityQuality(ds, fc, N));

  // ---------- incidents ----------
  const incidents: Incident[] = [];
  const byEvent = new Map<RawEvent, Incident>();
  for (const e of events) {
    const onsetUnix = ds.t0 + e.onsetIdx * ds.dt;
    const inc: Incident = {
      id: incidentId(e, onsetUnix),
      category: e.category,
      status: e.endIdx === null ? "ongoing" : "resolved",
      systemId: e.fc.sys.id,
      facilityId: e.fc.fac.id,
      assetId: e.assetId,
      onsetUnix,
      endUnix: e.endIdx === null ? null : ds.t0 + e.endIdx * ds.dt,
      confidence: Math.round(e.confidence * 100) / 100,
      evidence: e.evidence.slice(0, 3),
    };
    if (e.category === "pipeline_leak") inc.estLeakBblPerDay = Math.round(e.estLeakBblPerDay ?? 0);
    if (e.category === "pump_degradation") inc.capacityLossPct = Math.round((e.capacityLossPct ?? 0) * 10) / 10;
    if (inc.status === "ongoing") {
      const dq = qualityOf.get(e.fc)!;
      inc.dataQuality = { quality: dq.quality, reasons: dq.reasons.slice() };
    }
    if (e.category === "pump_failure") {
      inc.repairEndsUnix = onsetUnix + repairMin(ds) * 60;
      inc.lostRevenuePerHour = Math.round(e.fc.revenuePerHour * 100) / 100;
    }
    incidents.push(inc);
    byEvent.set(e, inc);
  }

  // ---------- resolved failures: what the cheapest plan at onset would have been ----------
  const onsetPlans = plansAtOnset(ds, events, N);
  for (const op of onsetPlans) {
    const inc = byEvent.get(op.event)!;
    if (inc.status === "resolved") {
      inc.plan = op.plan;
      inc.options = op.options;
      inc.levelPct = Math.round(op.job.levelPct * 10) / 10;
      inc.hoursToLimit = null;
    }
  }

  // ---------- ongoing failures: plan together per system at "now" ----------
  const ongoingFail = events.filter((e) => e.category === "pump_failure" && e.endIdx === null);
  const jobs = new Map<RawEvent, { job: TankJob; est: ReturnType<typeof estimateTank> }>();
  for (const e of ongoingFail) jobs.set(e, makeJob(ds, e, N, Math.max(e.onsetIdx, N - LEVEL_WIN), N));
  const fleets: FleetState[] = [];
  const planOf = new Map<RawEvent, PlanOption>();
  for (const sys of ds.network.systems) {
    const fleetSize = ds.ops.systems[sys.id]?.emergency_fleet_size ?? 0;
    const evs = ongoingFail.filter((e) => e.fc.sys.id === sys.id);
    const sysJobs = evs.map((e) => jobs.get(e)!.job);
    const budget = allocateFleet(sysJobs, tk, fleetSize);
    evs.forEach((e, i) => {
      const { job, est } = jobs.get(e)!;
      const { plan } = planOptions(job, tk, budget[i]);
      // alternatives may also use trucks no other failure in this system needs
      const spare = fleetSize - budget.reduce((a, b, j) => (j === i ? a : a + b), 0);
      const ext = planOptions(job, tk, Math.max(budget[i], spare)).options;
      const options = [plan, ...ext.filter((o) => o.kind !== plan.kind)].sort((a, b) => a.cost - b.cost);
      planOf.set(e, plan);
      const inc = byEvent.get(e)!;
      inc.plan = plan;
      inc.options = options;
      inc.levelPct = Math.round(est.levelPct * 10) / 10;
      const h = hoursToLimit(est, sd, job.capacityBbl);
      const r2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : 999);
      inc.hoursToLimit = { p10: r2(h.p10), p50: r2(h.p50), p90: r2(h.p90) };
      if (est.tripped) inc.evidence.push(`Tank at shutdown (${sd}%); wells shut in until the repair ends at ${when(inc.repairEndsUnix!, nowUnix)}`);
      else {
        const rate = (est.inflowBpd / 24 / job.capacityBbl) * 100;
        const hit = Number.isFinite(h.p50) ? nowUnix + h.p50 * 3600 : null;
        inc.evidence.push(
          `Tank at ${est.levelPct.toFixed(1)}% and filling ${rate.toFixed(1)}%/h` +
            (hit && hit < inc.repairEndsUnix! ? `; reaches shutdown (${sd}%) around ${when(hit, nowUnix)}, before the repair at ${when(inc.repairEndsUnix!, nowUnix)}` : `; repair due ${when(inc.repairEndsUnix!, nowUnix)}`)
        );
      }
      inc.evidence = inc.evidence.slice(0, 3);
      // say plainly when the countdown rests on held, stale or assumed readings
      const pq = e.fc.quality.pumpStatus;
      if (pq.q[N] !== Q_VALID && pq.lastObs[N] >= 0)
        inc.evidence.push(`No pump status reading after ${when(ds.t0 + pq.lastObs[N] * ds.dt, nowUnix)}; the fault is assumed to continue`);
      const lq = e.fc.quality.level;
      if (est.levelAssumed) inc.evidence.push(`No tank level readings; level assumed at the pump start level (${e.fc.fac.pump.start_level_pct}%) when the fault began`);
      else if (lq.q[N] !== Q_VALID && lq.q[N] !== Q_HELD)
        inc.evidence.push(`Tank level not reported since ${when(ds.t0 + lq.lastObs[N] * ds.dt, nowUnix)}; level projected from the last readings`);
      const fo = facOps(ds, e.fc);
      if (fo.noSystem) inc.evidence.push(`ops.json has no entry for ${e.fc.sys.id}, so no trucks are assumed`);
      else if (fo.estimated)
        inc.evidence.push(`Truck travel times for ${e.fc.fac.id} are missing from ops.json; using typical times for ${e.fc.sys.id}`);
    });
    // truck assignments from the recommended plans
    const assignments: TruckAssignment[] = [];
    let truckNo = 1;
    const ordered = evs.slice().sort((a, b) => (byEvent.get(a)!.hoursToLimit?.p50 ?? 0) - (byEvent.get(b)!.hoursToLimit?.p50 ?? 0));
    for (const e of ordered) {
      const p = planOf.get(e)!;
      const { job } = jobs.get(e)!;
      for (let k = 0; k < p.trucks && truckNo <= fleetSize; k++) {
        assignments.push({
          truck: truckNo++,
          incidentId: byEvent.get(e)!.id,
          facilityId: e.fc.fac.id,
          fromUnix: nowUnix,
          toUnix: nowUnix + truckBusyUntilMin(job, p) * 60,
          tripsArrivalUnix: p.truckArrivalsMin.map((m) => nowUnix + Math.round(m * 60)),
        });
      }
    }
    fleets.push({ systemId: sys.id, size: fleetSize, assignments });
  }

  // ---------- alerts order (SPEC) ----------
  const ongoing = incidents.filter((i) => i.status === "ongoing");
  const catRank = (c: Incident["category"]) => (c === "pump_failure" ? 0 : c === "pipeline_leak" ? 1 : 2);
  ongoing.sort((a, b) => {
    const ca = catRank(a.category);
    const cb = catRank(b.category);
    if (ca !== cb) return ca - cb;
    if (ca === 0) {
      const ha = a.hoursToLimit?.p50 ?? Infinity;
      const hb = b.hoursToLimit?.p50 ?? Infinity;
      if (Math.abs(ha - hb) > 1e-6) return ha - hb;
      return (b.lostRevenuePerHour ?? 0) - (a.lostRevenuePerHour ?? 0);
    }
    return a.onsetUnix - b.onsetUnix;
  });
  const history = incidents.filter((i) => i.status === "resolved").sort((a, b) => (b.endUnix ?? b.onsetUnix) - (a.endUnix ?? a.onsetUnix) || b.onsetUnix - a.onsetUnix);

  // ---------- systems / facilities ----------
  const systems: SystemState[] = [];
  const from48 = Math.max(0, N - Math.round((48 * 3600) / ds.dt) + 1);
  for (const sys of ds.network.systems) {
    const fstates: FacilityState[] = [];
    for (const fc of facs.filter((f) => f.sys.id === sys.id)) {
      const fac = fc.fac;
      const cap = fac.tank.capacity_bbl;
      const inflow = shown(fc.inflow, N);
      const flow = shown(fc.flow, N);
      const inflow3 = avg(fc.inflow, N - 2, N);
      const flow3 = avg(fc.flow, N - 2, N);
      const wells: WellState[] = fc.wells.map((w) => {
        const revDay = w.revenuePerHour * 24;
        return {
          id: w.w.id,
          producing: shown(w.status, N, 1) !== 0,
          waterBpd: Math.round(shown(w.water, N) * 10) / 10,
          baselineWaterBpd: w.w.baseline_water_bpd,
          oilBpd: w.w.oil_bpd,
          gasMcfd: w.w.gas_mcfd,
          revenuePerHour: Math.round(w.revenuePerHour * 100) / 100,
          costPerBblAvoided: w.w.baseline_water_bpd > 0 ? Math.round((revDay / w.w.baseline_water_bpd) * 100) / 100 : 0,
        };
      });
      const myInc = ongoing.filter((i) => i.facilityId === fac.id);
      const failInc = myInc.find((i) => i.category === "pump_failure");
      const dq = qualityOf.get(fc)!;
      let health: FacilityHealth = "ok";
      const allShut = fc.wells.length > 0 && fc.wells.every((w) => w.status[N] === 0);
      // Hard rule 9: a key reading missing or unreadable at "now" is never shown as healthy.
      if (dq.quality === "INVALID" || dq.quality === "DROPPED") health = "no_data";
      else if (allShut && fc.level[N] >= shutdownPct(ds) - 0.5) health = "shut_in";
      else if (failInc) health = "failure";
      else if (myInc.some((i) => i.category === "pipeline_leak")) health = "leak";
      else if (myInc.some((i) => i.category === "pump_degradation")) health = "degradation";
      // missing status shows the last status actually read (a fault stays a fault), never "stopped"
      const st = shown(fc.pumpStatus, N, failInc ? 2 : 0);
      fstates.push({
        id: fac.id,
        systemId: sys.id,
        letter: fc.letter,
        lat: fac.lat,
        lon: fac.lon,
        tank: { id: fac.tank.id, capacityBbl: cap, levelPct: Math.round(shown(fc.level, N, failInc?.levelPct ?? 0) * 100) / 100 },
        pump: {
          id: fac.pump.id,
          status: (st === 0 || st === 1 || st === 2 ? st : 0) as 0 | 1 | 2,
          flowBpd: Math.round(flow * 10) / 10,
          maxFlowBpd: fac.pump.max_flow_bpd,
          dischargePsi: Math.round(shown(fc.dischargePsi, N) * 10) / 10,
          startLevelPct: fac.pump.start_level_pct,
          stopLevelPct: fac.pump.stop_level_pct,
        },
        pipeline: { id: fac.pipeline.id, receiveFlowBpd: Math.round(shown(fc.recv, N) * 10) / 10, pressurePsi: Math.round(shown(fc.pipePsi, N) * 10) / 10 },
        inflowBpd: Math.round(inflow * 10) / 10,
        wells,
        fillPctPerHour: Math.round((((inflow3 - flow3) / 24 / cap) * 100) * 100) / 100,
        revenuePerHour: Math.round(fc.revenuePerHour * 100) / 100,
        health,
        dataQuality: dq,
        incidentIds: myInc.map((i) => i.id),
        series: {
          level: downsample(ds, fc.level, from48, N),
          inflow: downsample(ds, fc.inflow, from48, N),
          pumpFlow: downsample(ds, fc.flow, from48, N),
          receiveFlow: downsample(ds, fc.recv, from48, N),
        },
      });
    }
    systems.push({
      id: sys.id,
      center: sys.center,
      truckYard: sys.truck_yard,
      disposal: { id: sys.disposal_site.id, lat: sys.disposal_site.lat, lon: sys.disposal_site.lon, pressurePsi: sys.disposal_site.pressure_psi },
      fleetSize: ds.ops.systems[sys.id]?.emergency_fleet_size ?? 0,
      facilities: fstates,
    });
  }

  const atRiskFacs = new Set(ongoing.map((i) => i.facilityId));
  const failFacs = new Set(ongoing.filter((i) => i.category === "pump_failure").map((i) => i.facilityId));
  const snap: Snapshot = {
    dataset: datasetInfo(ds),
    limits: { warningPct: ds.network.defaults.tank_limits_pct.warning, shutdownPct: sd },
    nowUnix,
    systems,
    alerts: ongoing,
    history,
    fleets,
    totals: {
      facilities: facs.length,
      atRisk: atRiskFacs.size,
      revenueAtRiskPerHour: Math.round(facs.filter((f) => failFacs.has(f.fac.id)).reduce((a, f) => a + f.revenuePerHour, 0) * 100) / 100,
      planCost: Math.round(ongoing.reduce((a, i) => a + (i.plan?.cost ?? 0), 0) * 100) / 100,
    },
  };
  if (snapCache.size >= SNAP_CACHE_MAX) snapCache.delete(snapCache.keys().next().value!);
  snapCache.set(ck, snap);
  return snap;
}

// ---------------------------------------------------------------- events.json export
export interface EventsJsonEvent {
  event_id: string;
  system_id: string;
  facility_id: string;
  asset_id: string;
  category: "pump_degradation" | "pump_failure" | "pipeline_leak" | "other";
  status: "resolved" | "ongoing";
  onset_ts: string;
  onset_unix: number;
  end_ts: string | null;
  end_unix: number | null;
  confidence: number;
  evidence: string[];
  level_pct?: number;
  hours_to_limit?: { p50: number; p10?: number; p90?: number } | null;
  recommended_actions: Record<string, unknown>[];
  est_cost?: number;
}

const iso = (u: number) => new Date(u * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

export function toEventsJson(snapshot: Snapshot): EventsJsonEvent[] {
  const all = [...snapshot.alerts, ...snapshot.history].sort((a, b) => a.onsetUnix - b.onsetUnix || a.assetId.localeCompare(b.assetId));
  return all.map((i, k) => {
    const actions: Record<string, unknown>[] = [];
    if (i.category === "pump_failure") {
      const p = i.plan;
      if (p && p.trucks > 0) actions.push({ type: "dispatch_truck", facility_id: i.facilityId, trucks: p.trucks, trips_per_truck: p.tripsPerTruck });
      if (p && p.shutIns.length) {
        const groups = new Map<number, string[]>();
        for (const s of p.shutIns) groups.set(s.startAfterMin, [...(groups.get(s.startAfterMin) ?? []), s.wellId]);
        for (const [start, wells] of Array.from(groups.entries()).sort((a, b) => a[0] - b[0])) actions.push({ type: "shut_in_wells", wells, start_after_min: start });
      }
      if (!actions.length) actions.push({ type: "none" });
    } else actions.push({ type: "field_inspection", asset_id: i.assetId });
    const ev: EventsJsonEvent = {
      event_id: `EV-${String(k + 1).padStart(4, "0")}`,
      system_id: i.systemId,
      facility_id: i.facilityId,
      asset_id: i.assetId,
      category: i.category,
      status: i.status,
      onset_ts: iso(i.onsetUnix),
      onset_unix: i.onsetUnix,
      end_ts: i.endUnix === null ? null : iso(i.endUnix),
      end_unix: i.endUnix,
      confidence: i.confidence,
      evidence: i.evidence,
      recommended_actions: actions,
    };
    if (i.category === "pump_failure") {
      if (i.levelPct !== undefined) ev.level_pct = i.levelPct;
      // 999 is the engine's "tank isn't filling" marker; export that as no countdown.
      ev.hours_to_limit =
        i.status === "ongoing" && i.hoursToLimit && i.hoursToLimit.p50 < 999
          ? { p50: i.hoursToLimit.p50, p10: i.hoursToLimit.p10, p90: i.hoursToLimit.p90 }
          : null;
      if (i.plan) ev.est_cost = Math.round(i.plan.cost);
    } else ev.hours_to_limit = null;
    return ev;
  });
}

