// Deterministic FAKE data shaped like Snapshot (frontend/src/lib/engine/types.ts). Mockup only.
// 7-day week at 5 minute steps, 3 systems. Seeded PRNG: same output on every load.
export const STEP = 300, HOUR = 3600, DAY = 86400;
export const NOW = Date.UTC(2026, 9, 8, 12, 0, 0) / 1000; // last ts_unix, never the clock
export const T0 = NOW - 7 * DAY;
export const N = (NOW - T0) / STEP + 1;
export const HORIZON = 20 * HOUR; // projected zone after NOW (plans and trucks live here)
export const END = NOW + HORIZON;
export const NEON = ['#2CE5FF', '#B4FF39', '#A880FF', '#4D8DFF', '#3CFFB4', '#7AF0FF', '#C6A8FF', '#E4FF6B'];
export const LIMITS = { warningPct: 75, shutdownPct: 90 };
// Flat truck rules (SPEC): first arrival response_min after the call, then every cycle_min.
export const FLEET = { responseMin: 45, cycleMin: 90, unloadMin: 20, capacityBbl: 360, costPerTrip: 650 };

const ago = (h) => NOW - Math.round((h * HOUR) / STEP) * STEP;
const idxOf = (t) => Math.max(0, Math.min(N - 1, Math.round((t - T0) / STEP)));
function rng(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYS = [
  { id: 'S1', center: [32.41, -102.31], yard: [32.4, -102.35], fleet: 2, press: 310, fac: [
    { w: [1900, 1400, 900], fill: 3.1 }, { w: [2600, 1800], fill: 2.8 },
    { w: [1500, 1300, 1100, 700], fill: 3.3 }, { w: [2200], fill: 3.0 }] },
  { id: 'S2', center: [32.18, -102.05], yard: [32.15, -102.1], fleet: 3, press: 295, fac: [
    { w: [2100, 1700], fill: 3.0 }, { w: [1600, 1500, 1200], fill: 3.5 }, { w: [2400, 1800], fill: 2.9 },
    { w: [1300, 1200, 1000, 900], fill: 4.1 }, { w: [2000], fill: 3.1 }] },
  { id: 'S3', center: [31.95, -102.6], yard: [31.93, -102.64], fleet: 2, press: 330, fac: [
    { w: [1800, 1500], fill: 3.0 }, { w: [2300, 1200, 800], fill: 3.2 }, { w: [1700, 1600], fill: 2.9 }] },
];
const EVENTS = [
  { cat: 'pump_failure', fac: 'S1_FACILITY_D', onset: ago(96), end: ago(90) },
  { cat: 'pipeline_leak', fac: 'S1_FACILITY_C', onset: ago(26), end: null, leak: 340 },
  { cat: 'pump_failure', fac: 'S2_FACILITY_B', onset: ago(2.17), end: null, repairH: 30 },
  { cat: 'pump_failure', fac: 'S2_FACILITY_D', onset: ago(1.33), end: null, repairH: 26 },
  { cat: 'pump_degradation', fac: 'S3_FACILITY_A', onset: ago(72), end: null, loss: 22 },
];
const QSPANS = [
  { fac: 'S1_FACILITY_A', from: ago(30), steps: 2, q: 1 }, { fac: 'S1_FACILITY_B', from: ago(52), steps: 4, q: 2 },
  { fac: 'S2_FACILITY_E', from: ago(80), steps: 3, q: 1 }, { fac: 'S2_FACILITY_A', from: ago(41), steps: 5, q: 3 },
  { fac: 'S3_FACILITY_B', from: ago(12), steps: 2, q: 1 },
  { fac: 'S3_FACILITY_C', from: ago(50 / 60), steps: 11, q: 3 }, // DROPPED for the last 50 minutes
];

function simulate(fid, spec, seed) {
  const r = rng(seed), base = spec.w.reduce((a, b) => a + b, 0);
  const cap = Math.round((base * 100) / (24 * spec.fill) / 10) * 10, pmax = Math.round((base * 2.1) / 50) * 50;
  const evs = EVENTS.filter((e) => e.fac === fid);
  const L = new Float32Array(N), IN = new Float32Array(N), PF = new Float32Array(N), RF = new Float32Array(N);
  const ST = new Uint8Array(N), Q = new Uint8Array(N);
  let lvl = 36 + r() * 14, on = false;
  const ph = r() * 6.28;
  for (let i = 0; i < N; i++) {
    const t = T0 + i * STEP;
    const inflow = base * (1 + 0.1 * Math.sin((2 * Math.PI * (t - T0)) / DAY + ph)) * (1 + (r() - 0.5) * 0.04);
    const down = evs.some((e) => e.cat === 'pump_failure' && t >= e.onset && (e.end == null || t < e.end));
    const deg = evs.find((e) => e.cat === 'pump_degradation' && t >= e.onset);
    const leak = evs.find((e) => e.cat === 'pipeline_leak' && t >= e.onset);
    const loss = deg ? (deg.loss / 100) * Math.min(1, (t - deg.onset) / (2 * DAY)) : 0;
    if (lvl >= 55) on = true;
    if (lvl <= 30) on = false;
    const pf = down ? 0 : on ? pmax * (1 - loss) * (0.97 + 0.03 * r()) : 0;
    lvl = Math.min(100, Math.max(0, lvl + ((inflow - pf) / cap) * 100 * (STEP / DAY)));
    L[i] = lvl; IN[i] = inflow; PF[i] = pf; ST[i] = pf > 0 ? 1 : 0;
    RF[i] = pf * (leak ? 1 - 0.12 * Math.min(1, (t - leak.onset) / (6 * HOUR)) : 0.985);
  }
  for (const s of QSPANS.filter((q) => q.fac === fid)) {
    const a = idxOf(s.from), b = Math.min(N - 1, a + s.steps - 1);
    for (let i = a; i <= b; i++) {
      Q[i] = s.q;
      for (const arr of [L, IN, PF, RF]) arr[i] = s.q === 1 ? arr[a - 1] : NaN;
    }
  }
  return { L, IN, PF, RF, ST, Q, cap, pmax, base };
}

function buildOption(kind, F, label) {
  // Level projection in 5 minute steps from NOW. Trip = projected tank reaches shutdown.
  const nTr = kind === 'trucks' ? F.trucks : kind === 'mixed' ? 1 : 0;
  const tripsPer = nTr ? Math.floor((F.repairMin - FLEET.responseMin) / FLEET.cycleMin) + 1 : 0;
  const arrivals = [];
  for (let i = 0; i < tripsPer; i++) for (let j = 0; j < nTr; j++) arrivals.push(FLEET.responseMin + i * FLEET.cycleMin + j * 10);
  const shut = kind === 'shut_in' ? F.wells.map((w) => w.id) : kind === 'mixed' ? [F.cheapWell] : [];
  const open = () => F.wells.filter((w) => !shut.includes(w.id)).reduce((a, w) => a + w.water, 0);
  let pct = F.L0, tripAt = null, ai = 0;
  const curve = [{ min: 0, pct }];
  for (let m = 5; m <= 2400; m += 5) {
    pct += ((open() * F.inflowScale) / F.cap) * 100 * (5 / 1440);
    while (ai < arrivals.length && arrivals[ai] <= m) { pct -= (FLEET.capacityBbl / F.cap) * 100; ai++; }
    pct = Math.max(0, pct);
    if (pct >= LIMITS.shutdownPct && tripAt == null) { tripAt = m; pct = LIMITS.shutdownPct; }
    if (tripAt != null) pct = LIMITS.shutdownPct;
    if (m % 15 === 0 && m <= HORIZON / 60) curve.push({ min: m, pct: +pct.toFixed(2) });
  }
  const revH = F.wells.reduce((a, w) => a + w.rev, 0), repairH = F.repairMin / 60;
  const tripCost = arrivals.length * FLEET.costPerTrip;
  const shutRev = F.wells.filter((w) => shut.includes(w.id)).reduce((a, w) => a + w.rev, 0) * repairH;
  const downCost = tripAt != null ? 25000 + revH * Math.max(0, repairH - tripAt / 60) : 0;
  return {
    kind, label, cost: Math.round(tripCost + shutRev + downCost), trucks: nTr, tripsPerTruck: tripsPer,
    truckArrivalsMin: arrivals, shutIns: shut.map((w) => ({ wellId: w, startAfterMin: 0 })),
    tankTrips: tripAt != null, tripAtMin: tripAt, levelCurve: curve,
  };
}

function build() {
  const r = rng(77), FULL = {}, facilities = [], systems = [], incidents = [];
  const lastQ = (Q) => Q[N - 1];
  SYS.forEach((s, si) => {
    const facs = s.fac.map((spec, fi) => {
      const letter = String.fromCharCode(65 + fi), fid = `${s.id}_FACILITY_${letter}`;
      const S = simulate(fid, spec, 1000 * (si + 1) + fi);
      FULL[fid] = S;
      const wells = spec.w.map((w, wi) => {
        const rev = Math.round(300 + r() * 220);
        return { id: `${fid}_WELL_${wi + 1}`, producing: true, waterBpd: w, baselineWaterBpd: w, oilBpd: Math.round(w * 0.22),
          gasMcfd: Math.round(w * 0.05), revenuePerHour: rev, costPerBblAvoided: +((rev * 24) / w).toFixed(2) };
      });
      const q = lastQ(S.Q), ev = EVENTS.filter((e) => e.fac === fid && e.end == null);
      const health = q === 3 ? 'no_data' : ev.some((e) => e.cat === 'pump_failure') ? 'failure' : ev.some((e) => e.cat === 'pipeline_leak') ? 'leak' : ev.some((e) => e.cat === 'pump_degradation') ? 'degradation' : 'ok';
      const ds = (A) => { const t = [], v = []; for (let i = N - 577; i < N; i += 3) { t.push(T0 + i * STEP); v.push(Number.isNaN(A[i]) ? null : +A[i].toFixed(1)); } return { t, v }; };
      const fac = {
        id: fid, systemId: s.id, letter, lat: s.center[0] + (fi - 2) * 0.012, lon: s.center[1] + fi * 0.01,
        tank: { id: `${fid}_TANK`, capacityBbl: S.cap, levelPct: q === 3 ? null : +S.L[N - 1].toFixed(1) },
        pump: { id: `${fid}_PUMP`, status: q === 3 ? null : S.ST[N - 1], flowBpd: q === 3 ? null : Math.round(S.PF[N - 1]), maxFlowBpd: S.pmax,
          dischargePsi: q === 3 ? null : S.PF[N - 1] > 0 ? 410 : 0, startLevelPct: 55, stopLevelPct: 30 },
        pipeline: { id: `${fid}_PIPE`, receiveFlowBpd: q === 3 ? null : Math.round(S.RF[N - 1]), pressurePsi: q === 3 ? null : 285 },
        inflowBpd: q === 3 ? null : Math.round(S.IN[N - 1]), wells,
        fillPctPerHour: q === 3 ? null : +(((S.L[N - 1] - S.L[N - 7]) / 0.5)).toFixed(2),
        revenuePerHour: wells.reduce((a, w) => a + w.revenuePerHour, 0), health,
        dataQuality: { quality: ['VALID', 'HELD', 'INVALID', 'DROPPED'][q], reasons: q === 3 ? ['Tank level not reported for 50 min', 'Pump flow not reported for 50 min'] : [] },
        incidentIds: [], series: { level: ds(S.L), inflow: ds(S.IN), pumpFlow: ds(S.PF), receiveFlow: ds(S.RF) },
      };
      facilities.push(fac);
      return fac;
    });
    systems.push({ id: s.id, center: s.center, truckYard: s.yard, disposal: { id: `${s.id}_DISPOSAL_1`, lat: s.center[0], lon: s.center[1] + 0.06, pressurePsi: s.press }, fleetSize: s.fleet, facilities: facs });
  });
  const byId = Object.fromEntries(facilities.map((f) => [f.id, f]));
  for (const e of EVENTS) {
    const f = byId[e.fac], S = FULL[e.fac], sys = f.systemId;
    const inc = { id: `${sys}_${e.cat === 'pipeline_leak' ? 'PIPE' : 'PUMP'}_${f.letter}@${e.onset}`,
      category: e.cat, status: e.end == null ? 'ongoing' : 'resolved', systemId: sys, facilityId: e.fac,
      assetId: e.cat === 'pipeline_leak' ? f.pipeline.id : f.pump.id, onsetUnix: e.onset, endUnix: e.end, confidence: e.cat === 'pump_failure' ? 0.97 : 0.84,
      evidence: [], dataQuality: f.dataQuality };
    if (e.cat === 'pump_failure') {
      inc.evidence = ['Pump flow is zero while the tank level keeps rising', 'Discharge pressure fell to zero'];
      if (e.end == null) {
        const repairMin = (e.onset + e.repairH * HOUR - NOW) / 60;
        const F = { L0: S.L[N - 1], cap: S.cap, repairMin, trucks: 1, inflowScale: 1,
          wells: f.wells.map((w) => ({ id: w.id, water: w.waterBpd, rev: w.revenuePerHour })),
          cheapWell: [...f.wells].sort((a, b) => a.revenuePerHour - b.revenuePerHour)[0].id };
        const opts = [buildOption('do_nothing', F, 'Do nothing'), buildOption('trucks', F, 'Send 1 truck now'),
          buildOption('shut_in', F, 'Shut in all wells now'), buildOption('mixed', F, 'Send 1 truck and shut in 1 well')].sort((a, b) => a.cost - b.cost);
        const dn = opts.find((o) => o.kind === 'do_nothing'), p50 = dn.tripAtMin / 60;
        Object.assign(inc, { levelPct: F.L0, hoursToLimit: { p10: +(p50 * 0.78).toFixed(2), p50: +p50.toFixed(2), p90: +(p50 * 1.3).toFixed(2) },
          repairEndsUnix: e.onset + e.repairH * HOUR, lostRevenuePerHour: f.revenuePerHour, plan: opts[0], options: opts });
      }
    } else if (e.cat === 'pipeline_leak') {
      inc.evidence = ['Receive flow is below pump flow and the gap is growing', 'Pressure drop across the segment'];
      inc.estLeakBblPerDay = e.leak;
    } else if (e.cat === 'pump_degradation') {
      inc.evidence = ['Pump flow at the same level cycle is lower than a week ago'];
      inc.capacityLossPct = e.loss;
    }
    incidents.push(inc);
    if (e.end == null) f.incidentIds.push(inc.id);
  }
  const rank = (i) => (i.category === 'pump_failure' ? 0 : 1);
  const alerts = incidents.filter((i) => i.status === 'ongoing').sort((a, b) => rank(a) - rank(b) || (a.hoursToLimit?.p50 ?? 0) - (b.hoursToLimit?.p50 ?? 0) || (b.lostRevenuePerHour ?? 0) - (a.lostRevenuePerHour ?? 0));
  const history = incidents.filter((i) => i.status === 'resolved');
  const fleets = systems.map((s) => ({ systemId: s.id, size: s.fleetSize, assignments: [] }));
  const board = { source: 'simulated', provenance: 'fpga', online: true, mode: 'NORMAL', lastSeenUnix: NOW - 20, weightsVersion: 4, autonomousSinceUnix: null, replayedAlerts: 0,
    facilities: facilities.map((f) => ({ facilityId: f.id, updatedUnix: NOW - 20, scores: null, overThreshold: [], source: 'rule', sinceReset: 255,
      alarm: f.id === 'S3_FACILITY_B' ? 'night_shift' : 'none', alarmState: f.id === 'S3_FACILITY_B' ? 'raised' : null,
      alarmSinceUnix: f.id === 'S3_FACILITY_B' ? ago(0.5) : null, replayed: false, degradationTrend: null })) };
  const snapshot = { runId: 'mock-v4', dataset: { id: 'snapshot_2026-10-08T1200', label: 'Snapshot, Thu Oct 8, 12:00', startUnix: T0, nowUnix: NOW },
    limits: LIMITS, board, nowUnix: NOW, systems, alerts, history, fleets,
    totals: { facilities: facilities.length, atRisk: alerts.length, revenueAtRiskPerHour: alerts.reduce((a, i) => a + (i.lostRevenuePerHour || 0), 0),
      planCost: alerts.reduce((a, i) => a + (i.plan?.cost || 0), 0) } };
  const failOnset = alerts.find((i) => i.facilityId === 'S2_FACILITY_D').onsetUnix;
  const NOTES = [
    { id: 'n1', t: failOnset + 600, facilityId: 'S2_FACILITY_D', source: 'model', model: 'Nemotron',
      text: 'S2 Facility D pump stopped and its tank is filling. One truck covers the inflow. The fleet of 3 is shared with Facility B, so one truck stays free.' },
    { id: 'n2', t: ago(26) + 1800, facilityId: 'S1_FACILITY_C', source: 'draft', model: 'Deterministic draft',
      text: 'Draft: receive flow at S1 Facility C is below pump flow. Estimated loss 340 bbl/d. Field inspection advised. A leak has no countdown.' },
  ];
  return { snapshot, FULL, NOTES, EVENTS };
}
const D = build();
export const snapshot = D.snapshot, FULL = D.FULL, NOTES = D.NOTES;
