// Shared state and pure derived queries. Everything on screen is a function of clock.t.
import { snapshot, FULL, T0, NOW, N, STEP, END, LIMITS, FLEET, NEON } from './data.js';
export { snapshot, FULL, T0, NOW, N, STEP, END, LIMITS, FLEET, NEON };

export const clock = { t: NOW, playing: false, dir: 1, speed: 1, instant: false };
export const plan = { selected: {}, approved: {}, v: 0 }; // selected[incidentId] = option kind; approved[systemId] = true

// ---- change notification, batched to one rAF -------------------------------------------------
const subs = [];
let queued = false;
export const subscribe = (fn) => subs.push(fn);
export function notify(instant = false) {
  if (instant) clock.instant = true;
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    for (const fn of subs) fn(clock);
    clock.instant = false;
  });
}
export function setTime(t, instant = false) {
  clock.t = Math.max(T0, Math.min(END, t));
  notify(instant);
}

// ---- lookups --------------------------------------------------------------------------------
export const systems = snapshot.systems;
export const facilities = systems.flatMap((s) => s.facilities);
export const facById = Object.fromEntries(facilities.map((f) => [f.id, f]));
export const allIncidents = [...snapshot.alerts, ...snapshot.history];
export const failures = snapshot.alerts.filter((i) => i.category === 'pump_failure'); // rule 7 order
export const colorOf = (fac) => NEON[systems.find((s) => s.id === fac.systemId).facilities.indexOf(fac) % NEON.length];
export const letterOf = (fid) => facById[fid].letter;

export function optionOf(inc) {
  const kind = plan.selected[inc.id] || inc.plan.kind; // default: recommended (cheapest)
  return inc.options.find((o) => o.kind === kind);
}
/** Effective option: the selected take once the system is approved, otherwise do nothing (recommended is not enacted). */
export function effectiveOption(inc) {
  return plan.approved[inc.systemId] ? optionOf(inc) : inc.options.find((o) => o.kind === 'do_nothing');
}
export function approve(systemId) { plan.approved[systemId] = true; plan.v++; notify(); }
export function select(incId, kind) { plan.selected[incId] = kind; plan.v++; notify(); }

// ---- time series sampling -------------------------------------------------------------------
const qIdx = (t) => Math.max(0, Math.min(N - 1, Math.round((Math.min(t, NOW) - T0) / STEP)));
/** After NOW we repeat the last day of recorded behaviour (a projection, never recorded data). */
const projIdx = (t) => (t <= NOW ? qIdx(t) : qIdx(t - 86400 * Math.ceil((t - NOW) / 86400)));
export const quality = (fac, t) => (t <= NOW ? FULL[fac.id].Q[qIdx(t)] : FULL[fac.id].Q[N - 1] === 3 ? 3 : 0);
const failureOf = (fac) => failures.find((i) => i.facilityId === fac.id);
function curveAt(curve, min) {
  if (min <= 0) return curve[0].pct;
  for (let i = 1; i < curve.length; i++) if (curve[i].min >= min) {
    const a = curve[i - 1], b = curve[i];
    return a.pct + ((b.pct - a.pct) * (min - a.min)) / (b.min - a.min);
  }
  return curve[curve.length - 1].pct;
}
export function levelAt(fac, t) {
  const inc = failureOf(fac);
  if (inc && t > NOW) return curveAt(effectiveOption(inc).levelCurve, (t - NOW) / 60);
  if (quality(fac, t) >= 2) return null;
  const v = FULL[fac.id].L[projIdx(t)];
  return Number.isNaN(v) ? null : v;
}
export function flowAt(fac, key, t) {
  const inc = failureOf(fac);
  if (key === 'PF' && inc && t >= inc.onsetUnix) return 0;
  if (key === 'RF' && inc && t >= inc.onsetUnix) return 0;
  if (quality(fac, t) >= 2) return null;
  const v = FULL[fac.id][key][projIdx(t)];
  return Number.isNaN(v) ? null : v;
}

// ---- per facility state at time t -----------------------------------------------------------
export function incidentsAt(fac, t) {
  return allIncidents.filter((i) => i.facilityId === fac.id && t >= i.onsetUnix && (i.endUnix == null || t < i.endUnix));
}
export function statusAt(fac, t) {
  const q = quality(fac, t), level = levelAt(fac, t), pf = flowAt(fac, 'PF', t), inflow = flowAt(fac, 'IN', t), rf = flowAt(fac, 'RF', t);
  const inc = incidentsAt(fac, t);
  const fail = inc.find((i) => i.category === 'pump_failure'), leak = inc.find((i) => i.category === 'pipeline_leak'), worn = inc.find((i) => i.category === 'pump_degradation');
  let kind;
  if (q === 3) kind = 'nodata';
  else if (fail) kind = level != null && level >= LIMITS.shutdownPct - 0.01 ? 'shutin' : 'down';
  else if (leak) kind = 'leak';
  else if (worn) kind = 'worn';
  else kind = pf != null && pf > 50 ? 'flow' : 'idle';
  const st = { fac, q, level, pf, inflow, rf, kind, inc: fail || leak || worn || null, dither: [0, 0.25, 0.5, 0.75][q],
    flow: kind === 'down' || kind === 'shutin' || kind === 'nodata' ? 0 : pf || 0, countdownMin: null, p10: null, p90: null, alarm: null };
  if (kind === 'down' && fail.options) {
    const o = effectiveOption(fail);
    if (o.tripAtMin != null) {
      const rem = (NOW + o.tripAtMin * 60 - t) / 60, h = fail.hoursToLimit;
      st.countdownMin = rem; st.p10 = (rem * h.p10) / h.p50; st.p90 = (rem * h.p90) / h.p50;
    }
  }
  const bf = snapshot.board?.facilities.find((b) => b.facilityId === fac.id);
  if (bf && bf.alarm !== 'none' && t >= bf.alarmSinceUnix) st.alarm = bf.alarm;
  return st;
}
let memo = { k: '', v: null };
export function allStatus(t) {
  const k = `${t}|${plan.v}`;
  if (memo.k !== k) memo = { k, v: facilities.map((f) => statusAt(f, t)) };
  return memo.v;
}

// ---- trucks: pure function of t and the schedule --------------------------------------------
const DRIVE = (FLEET.cycleMin - FLEET.unloadMin) / 2; // minutes each way
/** All trucks of a system for the active failures, numbered in alert order (rule 5: shared fleet). */
export function trucksOf(sys) {
  const out = [];
  let n = 0;
  for (const inc of failures.filter((i) => i.systemId === sys.id)) {
    const o = optionOf(inc);
    for (let j = 0; j < o.trucks && n < sys.fleetSize; j++, n++) {
      const arr = o.truckArrivalsMin.filter((_, k) => k % o.trucks === j).map((m) => NOW + m * 60);
      out.push({ truck: n + 1, incidentId: inc.id, facilityId: inc.facilityId, arrivals: arr });
    }
  }
  return out;
}
/** progress 0 at yard, 1 at the facility stop; state for labels. */
export function truckState(tr, t) {
  const d = DRIVE * 60, u = FLEET.unloadMin * 60;
  for (const A of tr.arrivals) {
    if (t >= A - d && t < A) return { p: (t - (A - d)) / d, mode: 'out' };
    if (t >= A && t < A + u) return { p: 1, mode: 'unload' };
    if (t >= A + u && t < A + u + d) return { p: 1 - (t - A - u) / d, mode: 'back' };
  }
  return { p: 0, mode: 'yard' };
}
export const trucksBusy = (sys, t) => trucksOf(sys).filter((tr) => truckState(tr, t).mode !== 'yard' || (t >= NOW && t < tr.arrivals[tr.arrivals.length - 1])).length;

// ---- formatting -----------------------------------------------------------------------------
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const p2 = (n) => String(n).padStart(2, '0');
export const fmtTime = (t) => { const d = new Date(t * 1000); return `${MON[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
export const fmtHM = (t) => { const d = new Date(t * 1000); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
export const fmtDay = (t) => { const d = new Date(t * 1000); return `${DOW[d.getUTCDay()]} ${p2(d.getUTCDate())}`; };
export const fmtCountdown = (min) => { const m = Math.max(0, Math.floor(min)); return `${Math.floor(m / 60)}:${p2(m % 60)}`; };
export const fmtUsd = (n) => '$' + Math.round(n).toLocaleString('en-US');
export const fmtBpd = (n) => (n == null ? 'UNKNOWN' : Math.round(n).toLocaleString('en-US'));
