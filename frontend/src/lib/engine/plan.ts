// Tank countdown + cheapest-plan solver (SPEC "Plans").
import type { PlanOption } from "./types";
import type { LoadedDataset } from "./datasets";
import { clock, fmtDur, type FacilityCtx } from "./model";

// ---------------------------------------------------------------- tank state
export interface PlanWell {
  id: string;
  waterBpd: number; // rate it adds to the tank while producing
  revPerHour: number; // lost revenue per hour while shut in
  producing: boolean;
}

export interface TankJob {
  key: string; // incident id
  fc: FacilityCtx;
  startUnix: number; // plan start ("now" or onset)
  levelPct: number;
  capacityBbl: number;
  shutdownPct: number;
  wells: PlanWell[];
  horizonMin: number; // repair time remaining
  responseMin: number;
  cycleMin: number;
  tripped: boolean; // already shut in at shutdown
}

export interface TankEstimate {
  levelPct: number; // best estimate
  planLevelPct: number; // cautious estimate used for planning
  levelSigma: number;
  inflowBpd: number; // current inflow while producing
  inflowSigma: number;
  tripped: boolean;
  wells: PlanWell[];
  levelAssumed: boolean; // no tank level reading at all: level assumed at the pump start level at onset
}

function meanStd(xs: number[]): [number, number] {
  if (!xs.length) return [NaN, 0];
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(1, xs.length - 1);
  return [m, Math.sqrt(v)];
}

/**
 * Tank level and fill rate at step `at` during a pump failure that began at `onset`.
 * Uses readings in [winFrom, winTo] while the pump is down and wells produce: each reading is
 * projected to `at` along the fill rate implied by inflow, then averaged (cuts sensor noise).
 */
export function estimateTank(ds: LoadedDataset, fc: FacilityCtx, onset: number, at: number, winFrom: number, winTo: number, shutdownPct: number): TankEstimate {
  const cap = fc.fac.tank.capacity_bbl;
  const stepH = ds.dt / 3600;
  const lo = Math.max(onset, winFrom);
  const hi = Math.min(winTo, ds.n - 1);
  const inflows: number[] = [];
  for (let k = lo; k <= hi; k++) if (fc.pumpStatus[k] !== 1 && fc.inflow[k] > 0) inflows.push(fc.inflow[k]);
  const [inMean, inStd] = meanStd(inflows);
  const baseSum = fc.fac.wells.reduce((a, w) => a + w.baseline_water_bpd, 0);
  // If the measured inflow agrees with the wells' nameplate (baseline) rates within its own noise,
  // use the nameplate numbers (noise-free); otherwise trust the readings.
  const snap = !Number.isFinite(inMean) || Math.abs(inMean - baseSum) <= Math.max((3 * inStd) / Math.sqrt(Math.max(1, inflows.length)), 0.005 * baseSum);
  const inflowBpd = snap ? baseSum : inMean;
  const slopePerStep = (inflowBpd / 24 / cap) * 100 * stepH;
  const preds: number[] = [];
  for (let k = lo; k <= hi; k++) {
    if (fc.pumpStatus[k] === 1 || !(fc.inflow[k] > 0) || !(fc.level[k] < shutdownPct - 0.3)) continue; // also skips missing levels
    preds.push(fc.level[k] + slopePerStep * (at - k));
  }
  // Readings from the pumping run just before the failure pin the level at onset too (level is continuous).
  {
    const pre: number[] = [];
    for (let k = onset - 1; k >= Math.max(0, onset - 24) && fc.pumpStatus[k] === 1; k--)
      if (Number.isFinite(fc.level[k]) && Number.isFinite(fc.flow[k]) && Number.isFinite(fc.inflow[k])) pre.push(k);
    if (pre.length >= 6) {
      const fl = pre.map((k) => fc.flow[k]);
      const inn = pre.map((k) => fc.inflow[k]);
      const [fm, fs] = meanStd(fl);
      const [im, is] = meanStd(inn);
      const maxF = fc.fac.pump.max_flow_bpd;
      const fSnap = Math.abs(fm - maxF) <= Math.max((3 * fs) / Math.sqrt(pre.length), 0.005 * maxF);
      const iSnap = Math.abs(im - baseSum) <= Math.max((3 * is) / Math.sqrt(pre.length), 0.005 * baseSum);
      const net = (iSnap ? baseSum : im) - (fSnap ? maxF : fm);
      const runSlope = (net / 24 / cap) * 100 * stepH;
      for (const k of pre) preds.push(fc.level[k] + runSlope * (onset - k) + slopePerStep * (at - onset));
    }
  }
  const atC = Math.min(at, ds.n - 1);
  // A reading at the limit means the facility has shut in automatically (SPEC: wells go to 0 at
  // shutdown), even if the well flags and inflow still lag one step behind.
  const tripped = fc.level[atC] >= shutdownPct - 0.05;
  let [lvl, sd] = meanStd(preds);
  let levelAssumed = false;
  if (!Number.isFinite(lvl)) {
    // no usable reading in the window: project the last real level forward at the fill rate
    let k0 = -1;
    for (let k = atC; k >= 0; k--)
      if (Number.isFinite(fc.level[k])) {
        k0 = k;
        break;
      }
    if (k0 >= 0) {
      lvl = fc.level[k0] + (k0 >= onset ? slopePerStep * (at - k0) : slopePerStep * (at - onset));
      sd = 0.5 + 0.1 * Math.max(0, at - k0) * Math.abs(slopePerStep);
    } else {
      // no level reading at all: assume the top of the pump's normal band at onset (cautious)
      lvl = fc.fac.pump.start_level_pct + slopePerStep * (at - onset);
      sd = 5;
      levelAssumed = true;
    }
  }
  if (tripped) lvl = shutdownPct;
  const levelSigma = tripped ? 0 : Math.max(0.01, sd / Math.sqrt(Math.max(1, preds.length)));

  // per-well rates: recent producing readings, else baseline
  const wells: PlanWell[] = fc.wells.map((w) => {
    const xs: number[] = [];
    for (let k = Math.max(0, hi - 11); k <= hi; k++) if (w.status[k] === 1 && w.water[k] > 0) xs.push(w.water[k]);
    const [m] = meanStd(xs);
    const producing = tripped ? true : w.status[atC] !== 0; // auto shut-in wells come back after repair
    return { id: w.w.id, waterBpd: snap || !Number.isFinite(m) ? w.w.baseline_water_bpd : m, revPerHour: w.revenuePerHour, producing };
  });
  // keep per-well rates consistent with the measured tank inflow
  const wsum = wells.filter((w) => w.producing).reduce((a, w) => a + w.waterBpd, 0);
  if (!tripped && !snap && wsum > 0) for (const w of wells) w.waterBpd *= inflowBpd / wsum;
  const levelPct = Math.min(lvl, shutdownPct);
  // plans are made against the cautious (p90) level so a noisy reading can't make a plan trip
  const planLevelPct = Math.min(shutdownPct, levelPct + 1.2816 * levelSigma);
  return { levelPct, planLevelPct, levelSigma, inflowBpd, inflowSigma: inStd || 0, tripped, wells, levelAssumed };
}

export function hoursToLimit(est: TankEstimate, shutdownPct: number, capacityBbl: number): { p10: number; p50: number; p90: number } {
  if (est.tripped) return { p10: 0, p50: 0, p90: 0 };
  const rate = est.inflowBpd > 0 ? (est.inflowBpd / 24 / capacityBbl) * 100 : 0; // %/h
  if (rate <= 0) return { p10: Infinity, p50: Infinity, p90: Infinity };
  const room = Math.max(0, shutdownPct - est.levelPct);
  const rs = (est.inflowSigma / 24 / capacityBbl) * 100;
  const z = 1.2816;
  const p50 = room / rate;
  const p10 = Math.max(0, room - z * est.levelSigma) / (rate + z * rs);
  const p90 = (room + z * est.levelSigma) / Math.max(1e-9, rate - z * rs);
  return { p10, p50, p90 };
}

// ---------------------------------------------------------------- simulation
export interface Trucking {
  capacityBbl: number;
  costPerTrip: number;
}

interface Plan {
  trucks: number;
  trips: number; // per truck
  shut: { w: number; start: number }[]; // well index, minutes from start
}

interface SimResult {
  tripAt: number | null;
  cost: number;
  tripsDone: number; // per truck, arrivals before trip
}

function arrivals(job: TankJob, trips: number): number[] {
  const out: number[] = [];
  for (let j = 0; j < trips; j++) out.push(job.responseMin + j * job.cycleMin);
  return out;
}

function maxTrips(job: TankJob): number {
  let m = 0;
  while (job.responseMin + m * job.cycleMin < job.horizonMin - 1e-9) m++;
  return m;
}

function simulate(job: TankJob, tk: Trucking, p: Plan, curve?: { min: number; pct: number }[]): SimResult {
  const cap = job.capacityBbl;
  const S = (job.shutdownPct / 100) * cap;
  const H = job.horizonMin;
  let V = (job.levelPct / 100) * cap;
  const wells = job.wells;
  const shutStart = new Map<number, number>();
  for (const s of p.shut) shutStart.set(s.w, s.start);
  const arr = p.trucks > 0 ? arrivals(job, p.trips) : [];
  // event times
  const evts = new Set<number>([H]);
  for (const a of arr) if (a < H) evts.add(a);
  for (const s of p.shut) if (s.start < H) evts.add(s.start);
  const times = Array.from(evts).sort((a, b) => a - b);
  const rateAt = (t: number) => {
    let r = 0;
    wells.forEach((w, i) => {
      if (!w.producing) return;
      const s = shutStart.get(i);
      if (s !== undefined && s <= t) return;
      r += w.waterBpd;
    });
    return r / 1440; // bbl/min
  };
  let t = 0;
  let tripAt: number | null = null;
  let tripsDone = 0;
  const pts: { min: number; v: number }[] = curve ? [{ min: 0, v: V }] : [];
  if (job.tripped) tripAt = 0;
  for (const te of times) {
    if (tripAt !== null) break;
    const r = rateAt(t);
    const dtm = te - t;
    if (V + r * dtm >= S - 1e-9 && r > 0) {
      tripAt = t + (S - V) / r;
      if (tripAt >= H) tripAt = null; // reaches exactly at repair end: no trip
      else {
        V = S;
        if (curve) pts.push({ min: tripAt, v: V });
        break;
      }
    }
    V += r * dtm;
    t = te;
    if (te >= H) {
      if (curve) pts.push({ min: te, v: V });
      break;
    }
    if (arr.includes(te)) {
      if (curve) pts.push({ min: te, v: V });
      for (let k = 0; k < p.trucks; k++) V -= Math.min(V, tk.capacityBbl);
      tripsDone++;
      if (curve) pts.push({ min: te, v: V });
    } else if (curve) pts.push({ min: te, v: V });
  }
  // cost
  let cost = tripsDone * p.trucks * tk.costPerTrip;
  wells.forEach((w, i) => {
    if (!w.producing) return;
    const s = shutStart.get(i);
    let off = H;
    if (s !== undefined) off = Math.min(off, s);
    if (tripAt !== null) off = Math.min(off, tripAt);
    cost += (w.revPerHour * Math.max(0, H - off)) / 60;
  });
  if (curve) {
    // resample to 5-minute steps, keeping exact truck drops
    const at = (m: number): number => {
      if (tripAt !== null && m >= tripAt) return S;
      for (let k = pts.length - 1; k >= 0; k--) {
        if (pts[k].min > m) continue;
        const a = pts[k];
        const b = pts[k + 1];
        if (!b || b.min === a.min) return a.v;
        return a.v + ((b.v - a.v) * (m - a.min)) / (b.min - a.min);
      }
      return pts[0].v;
    };
    const drops = new Set(arr.filter((a) => a < H && (tripAt === null || a < tripAt)));
    const end = Math.ceil(H / 5) * 5;
    for (let m = 0; m <= end; m += 5) {
      const mm = Math.min(m, H);
      curve.push({ min: mm, pct: +((at(mm) / cap) * 100).toFixed(2) });
    }
    for (const d of drops) {
      const idx = pts.findIndex((q) => q.min === d);
      if (idx >= 0 && idx + 1 < pts.length) {
        for (let k = curve.length - 1; k >= 0; k--) if (curve[k].min === d) curve.splice(k, 1);
        curve.push({ min: d, pct: +((pts[idx].v / cap) * 100).toFixed(2) });
        curve.push({ min: d, pct: +((pts[idx + 1].v / cap) * 100).toFixed(2) });
      }
    }
    if (tripAt !== null) curve.push({ min: tripAt, pct: job.shutdownPct });
    curve.sort((a, b) => a.min - b.min);
    for (const c of curve) c.min = +c.min.toFixed(3);
  }
  return { tripAt, cost, tripsDone };
}

// ---------------------------------------------------------------- search
interface Cand extends Plan {
  res: SimResult;
}

function better(a: Cand, b: Cand): boolean {
  const ea = 0.5; // dollars: treat as tie
  if (a.res.cost < b.res.cost - ea) return true;
  if (a.res.cost > b.res.cost + ea) return false;
  const ta = a.res.tripAt === null ? 0 : 1;
  const tb = b.res.tripAt === null ? 0 : 1;
  if (ta !== tb) return ta < tb;
  const ra = a.trucks * a.trips;
  const rb = b.trucks * b.trips;
  if (ra !== rb) return ra < rb;
  if (a.trucks !== b.trucks) return a.trucks < b.trucks;
  return a.shut.length < b.shut.length;
}

function kindOf(c: Plan): PlanOption["kind"] {
  if (c.trucks > 0 && c.shut.length) return "mixed";
  if (c.trucks > 0) return "trucks";
  if (c.shut.length) return "shut_in";
  return "do_nothing";
}

/** All candidate plans using at most maxTrucks trucks. */
function candidates(job: TankJob, tk: Trucking, maxTrucks: number): Cand[] {
  const out: Cand[] = [];
  const H = job.horizonMin;
  const prodIdx = job.wells.map((w, i) => (w.producing ? i : -1)).filter((i) => i >= 0);
  const mt = maxTrips(job);
  const truckOpts: [number, number][] = [[0, 0]];
  if (!job.tripped) for (let k = 1; k <= maxTrucks; k++) for (let m = 1; m <= mt; m++) truckOpts.push([k, m]);
  const subsets: number[][] = [];
  const nW = prodIdx.length;
  for (let mask = 0; mask < 1 << nW; mask++) subsets.push(prodIdx.filter((_, b) => mask & (1 << b)));
  const H1 = Math.max(0, Math.ceil(H) - 1);
  for (const [k, m] of truckOpts) {
    for (const sub of subsets) {
      if (job.tripped && sub.length) continue;
      if (!sub.length) {
        const p: Plan = { trucks: k, trips: m, shut: [] };
        out.push({ ...p, res: simulate(job, tk, p) });
        continue;
      }
      for (const partial of sub) {
        const mk = (start: number): Plan => ({ trucks: k, trips: m, shut: sub.map((w) => ({ w, start: w === partial ? start : 0 })) });
        const p0 = mk(0);
        const r0 = simulate(job, tk, p0);
        if (r0.tripAt !== null) {
          if (partial === sub[0]) out.push({ ...p0, res: r0 }); // tripping variant, once per subset
          continue;
        }
        // latest whole minute the partial well can start without tripping
        let lo = 0;
        let hi = H1;
        let best = { p: p0, r: r0 };
        const rHi = simulate(job, tk, mk(hi));
        if (rHi.tripAt === null) best = { p: mk(hi), r: rHi };
        else {
          while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            const r = simulate(job, tk, mk(mid));
            if (r.tripAt === null) {
              lo = mid;
              best = { p: mk(mid), r };
            } else hi = mid;
          }
        }
        out.push({ ...best.p, res: best.r });
      }
    }
  }
  // drop shut-ins of wells that start at/after the horizon (they cost nothing and do nothing)
  for (const c of out) c.shut = c.shut.filter((s) => s.start < H);
  // a truck trip that would arrive after the tank already tripped is never sent: that plan is the
  // same as the one with fewer trips, which is enumerated separately
  return out.filter((c) => c.trucks === 0 || c.res.tripsDone >= c.trips);
}

export function bestPlan(job: TankJob, tk: Trucking, maxTrucks: number): Cand {
  let best: Cand | null = null;
  for (const c of candidates(job, tk, maxTrucks)) if (!best || better(c, best)) best = c;
  return best!;
}

function label(job: TankJob, c: Cand): string {
  const tripClock = (min: number) => clock(job.startUnix + Math.round(min * 60));
  const repairClock = clock(job.startUnix + Math.round(job.horizonMin * 60));
  const parts: string[] = [];
  if (c.trucks > 0) {
    const t = c.trucks === 1 ? "1 truck" : `${c.trucks} trucks`;
    if (c.trips <= 1) parts.push(`Send ${t} now`);
    else parts.push(`Send ${t} now, ${c.trips} trips${c.trucks > 1 ? " each" : ""}`);
    if (c.trucks > 1 && c.trips <= 1) parts[parts.length - 1] += ", 1 trip each";
  }
  const byStart = new Map<number, string[]>();
  for (const s of c.shut) {
    const arr = byStart.get(s.start) ?? [];
    arr.push(job.wells[s.w].id);
    byStart.set(s.start, arr);
  }
  for (const [start, ids] of Array.from(byStart.entries()).sort((a, b) => a[0] - b[0])) {
    const what = ids.length === 1 ? `well ${ids[0]}` : `wells ${ids.join(", ")}`;
    parts.push(`${parts.length ? "shut in" : "Shut in"} ${what} ${start <= 0 ? "now" : `in ${fmtDur(start)}`}`);
  }
  if (!parts.length) {
    if (job.tripped) return `Wells already shut in at shutdown; they restart when the repair ends at ${repairClock}`;
    if (c.res.tripAt !== null) return `Do nothing; wells shut in automatically at ${tripClock(c.res.tripAt)}`;
    return `No action needed; tank stays below shutdown until the repair ends at ${repairClock}`;
  }
  let s = parts.join(" + ");
  if (c.res.tripAt !== null) s += ` (tank still reaches shutdown at ${tripClock(c.res.tripAt)})`;
  return s;
}

export function toOption(job: TankJob, tk: Trucking, c: Cand): PlanOption {
  const levelCurve: { min: number; pct: number }[] = [];
  simulate(job, tk, c, levelCurve);
  const arr = c.trucks > 0 ? arrivals(job, c.trips).filter((a) => a < job.horizonMin && (c.res.tripAt === null || a < c.res.tripAt)) : [];
  return {
    kind: kindOf(c),
    label: label(job, c),
    cost: Math.round(c.res.cost * 100) / 100,
    trucks: c.trucks,
    tripsPerTruck: c.trucks > 0 ? c.trips : 0,
    truckArrivalsMin: arr,
    shutIns: c.shut.map((s) => ({ wellId: job.wells[s.w].id, startAfterMin: s.start })),
    tankTrips: c.res.tripAt !== null,
    tripAtMin: c.res.tripAt === null ? null : Math.round(c.res.tripAt * 10) / 10,
    levelCurve,
  };
}

/** Recommended plan + options (cheapest first): do nothing, best shut-in only, best trucks only, best mixed. */
export function planOptions(job: TankJob, tk: Trucking, maxTrucks: number): { plan: PlanOption; options: PlanOption[]; best: Cand } {
  const cands = candidates(job, tk, maxTrucks);
  const bestOf = new Map<PlanOption["kind"], Cand>();
  let best: Cand | null = null;
  for (const c of cands) {
    const k = kindOf(c);
    const cur = bestOf.get(k);
    if (!cur || better(c, cur)) bestOf.set(k, c);
    if (!best || better(c, best)) best = c;
  }
  const picked = Array.from(bestOf.values()).sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
  const options = picked.map((c) => toOption(job, tk, c));
  const plan = options[picked.indexOf(best!)];
  return { plan, options, best: best! };
}

/**
 * Shared fleet: choose how many of the free trucks each failure gets so the system's total cost is lowest.
 * Returns the truck budget per job.
 */
export function allocateFleet(jobs: TankJob[], tk: Trucking, freeTrucks: number): number[] {
  const n = jobs.length;
  if (!n) return [];
  const costBy: number[][] = jobs.map((j) => {
    const row: number[] = [];
    for (let k = 0; k <= freeTrucks; k++) row.push(bestPlan(j, tk, k).res.cost);
    return row;
  });
  const usedBy: number[][] = jobs.map((j) => {
    const row: number[] = [];
    for (let k = 0; k <= freeTrucks; k++) row.push(bestPlan(j, tk, k).trucks);
    return row;
  });
  let bestAlloc: number[] = new Array(n).fill(0);
  let bestCost = Infinity;
  let bestUsed = Infinity;
  const cur: number[] = new Array(n).fill(0);
  const rec = (i: number, left: number, cost: number, used: number) => {
    if (i === n) {
      if (cost < bestCost - 0.5 || (Math.abs(cost - bestCost) <= 0.5 && used < bestUsed)) {
        bestCost = cost;
        bestUsed = used;
        bestAlloc = cur.slice();
      }
      return;
    }
    for (let k = 0; k <= left; k++) {
      cur[i] = k;
      rec(i + 1, left - usedBy[i][k], cost + costBy[i][k], used + usedBy[i][k]);
    }
  };
  rec(0, freeTrucks, 0, 0);
  // budget = trucks the chosen plan actually uses
  return bestAlloc.map((k, i) => usedBy[i][k]);
}

export function truckBusyUntilMin(job: TankJob, opt: PlanOption): number {
  if (!opt.trucks) return 0;
  return job.responseMin + opt.tripsPerTruck * job.cycleMin;
}
