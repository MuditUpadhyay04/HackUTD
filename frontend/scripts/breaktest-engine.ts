// Break-test the engine against the synthetic worst-case datasets in ../breaktest/data (and ../breaktest/test).
//   DATA_ROOT=/path/to/breaktest/data npx tsx scripts/breaktest-engine.ts
// Read-only with respect to src/. Writes ../breaktest/results-engine.json.
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { listDatasets, getSnapshot, toEventsJson } from "../src/lib/engine";
import { loadDataset } from "../src/lib/engine/datasets";
import type { Incident, PlanOption, Snapshot } from "../src/lib/engine/types";

type Finding = { dataset: string; at: string; kind: string; detail: string };
const findings: Finding[] = [];
const passes: string[] = [];
const add = (dataset: string, at: string, kind: string, detail: string) => findings.push({ dataset, at, kind, detail });

// fields where a negative number is legitimate
const NEG_OK = /(\.lat$|\.lon$|center\[|truckYard\[|fillPctPerHour$|\.lon\b|\.lat\b)/;

function walk(o: unknown, p: string, cb: (path: string, v: unknown) => void) {
  cb(p, o);
  if (Array.isArray(o)) o.forEach((x, i) => walk(x, `${p}[${i}]`, cb));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`, cb);
}

function scanValues(ds: string, at: string, root: unknown, label: string) {
  const bad: string[] = [];
  walk(root, label, (p, v) => {
    if (typeof v === "number") {
      if (Number.isNaN(v)) bad.push(`NaN at ${p}`);
      else if (!Number.isFinite(v)) bad.push(`${v} at ${p}`);
      else if (v < 0 && !NEG_OK.test(p)) bad.push(`negative ${v} at ${p}`);
      if (v === 999 && /hoursToLimit|hours_to_limit/.test(p)) bad.push(`sentinel 999 at ${p}`);
    } else if (typeof v === "string") {
      if (/\bNaN\b|Infinity|undefined|\bnull\b/.test(v)) bad.push(`text "${v}" at ${p}`);
    } else if (v === undefined) bad.push(`undefined at ${p}`);
  });
  // collapse long lists
  const byKind = new Map<string, string[]>();
  for (const b of bad) {
    const k = b.replace(/\[\d+\]/g, "[]").replace(/^(NaN|negative [-\d.e]+|-?Infinity|text ".*"|sentinel 999) at /, (m) => m.replace(/[-\d.e]+ at/, "N at"));
    const key = k.replace(/"[^"]*"/, '"…"');
    byKind.set(key, [...(byKind.get(key) ?? []), b]);
  }
  for (const [, arr] of byKind) add(ds, at, "bad-value", `${arr[0]}${arr.length > 1 ? ` (+${arr.length - 1} similar)` : ""}`);
}

function checkPlan(ds: string, at: string, inc: Incident, opt: PlanOption, fleet: number, horizonMin: number, sd: number, tag: string) {
  const id = `${inc.facilityId} ${tag} "${opt.label}"`;
  if (!opt.label || !opt.label.trim()) add(ds, at, "empty-label", `${inc.facilityId} ${tag} has empty label`);
  if (opt.trucks > fleet) add(ds, at, "spec-fleet", `${id}: ${opt.trucks} trucks > fleet ${fleet}`);
  if (opt.trucks > 0 && opt.tripsPerTruck < 1) add(ds, at, "spec-trips", `${id}: trucks>0 but tripsPerTruck=${opt.tripsPerTruck}`);
  for (const a of opt.truckArrivalsMin) if (a >= horizonMin - 1e-6) add(ds, at, "spec-trip-after-repair", `${id}: arrival at ${a}m >= repair in ${horizonMin.toFixed(1)}m`);
  if (opt.trucks > 0 && opt.truckArrivalsMin.length !== opt.tripsPerTruck)
    add(ds, at, "spec-trips", `${id}: tripsPerTruck=${opt.tripsPerTruck} but ${opt.truckArrivalsMin.length} arrivals before repair/trip`);
  for (const s of opt.shutIns) {
    if (s.startAfterMin < 0 || s.startAfterMin >= horizonMin) add(ds, at, "spec-shutin", `${id}: shut-in ${s.wellId} at ${s.startAfterMin}m outside [0, ${horizonMin.toFixed(1)})`);
  }
  if (opt.cost < 0) add(ds, at, "spec-cost", `${id}: negative cost ${opt.cost}`);
  if (opt.tankTrips !== (opt.tripAtMin !== null)) add(ds, at, "inconsistent", `${id}: tankTrips=${opt.tankTrips} tripAtMin=${opt.tripAtMin}`);
  if (opt.levelCurve.length === 0 && horizonMin > 0) add(ds, at, "empty-curve", `${id}: levelCurve empty`);
  for (const c of opt.levelCurve) {
    if (c.pct < -1e-6) add(ds, at, "spec-overdraw", `${id}: level ${c.pct}% at ${c.min}m`);
    if (c.pct > sd + 0.01) add(ds, at, "spec-overflow", `${id}: level ${c.pct}% > ${sd} at ${c.min}m`);
  }
  if (!opt.tankTrips && opt.levelCurve.some((c) => c.pct >= sd + 0.01)) add(ds, at, "inconsistent", `${id}: says no trip but curve hits ${sd}`);
}

function checkSnapshot(ds: string, at: string, s: Snapshot) {
  const net = loadDataset(ds).network;
  const ops = loadDataset(ds).ops;
  const sd = net.defaults.tank_limits_pct.shutdown;
  scanValues(ds, at, s, "snap");
  if (!s.dataset.label?.trim()) add(ds, at, "empty-label", "dataset label empty");
  const nFac = net.systems.reduce((a, x) => a + x.facilities.length, 0);
  if (s.totals.facilities !== nFac) add(ds, at, "count", `totals.facilities ${s.totals.facilities} != network ${nFac}`);
  if (s.systems.length !== net.systems.length) add(ds, at, "count", `systems ${s.systems.length} != network ${net.systems.length}`);
  for (const sy of s.systems)
    for (const f of sy.facilities) {
      if (!f.letter?.trim()) add(ds, at, "empty-label", `${f.id} letter empty`);
      if (f.series.level.t.length === 0) add(ds, at, "empty-series", `${f.id} level series empty`);
    }
  // alerts order (SPEC)
  const al = s.alerts;
  let seenOther = false;
  for (let i = 0; i < al.length; i++) {
    const a = al[i];
    if (a.status !== "ongoing") add(ds, at, "alerts", `${a.id} in alerts but status ${a.status}`);
    if (a.category !== "pump_failure") seenOther = true;
    else if (seenOther) add(ds, at, "alerts-order", `pump_failure ${a.id} after a non-failure alert`);
    if (i > 0 && a.category === "pump_failure" && al[i - 1].category === "pump_failure") {
      const p = al[i - 1];
      const hp = p.hoursToLimit?.p50 ?? Infinity;
      const ha = a.hoursToLimit?.p50 ?? Infinity;
      if (ha < hp - 1e-6) add(ds, at, "alerts-order", `${a.facilityId} (${ha}h) after ${p.facilityId} (${hp}h)`);
      if (Math.abs(ha - hp) <= 1e-6 && (a.lostRevenuePerHour ?? 0) > (p.lostRevenuePerHour ?? 0) + 1e-6)
        add(ds, at, "alerts-order", `tie ${ha}h: ${a.facilityId} $${a.lostRevenuePerHour}/h after ${p.facilityId} $${p.lostRevenuePerHour}/h`);
    }
    for (const e of a.evidence) if (!e.trim()) add(ds, at, "empty-label", `${a.id} empty evidence line`);
    if (a.evidence.length === 0) add(ds, at, "empty-label", `${a.id} has no evidence`);
  }
  // plans
  const trucksBySys = new Map<string, number>();
  for (const a of al) {
    if (a.category !== "pump_failure") continue;
    const fleet = ops.systems[a.systemId]?.emergency_fleet_size ?? 0;
    const horizon = ((a.repairEndsUnix ?? 0) - s.nowUnix) / 60;
    if (!a.plan) {
      add(ds, at, "missing-plan", `${a.id} ongoing failure has no plan`);
      continue;
    }
    if (!a.hoursToLimit) add(ds, at, "missing", `${a.id} ongoing failure has no hoursToLimit`);
    checkPlan(ds, at, a, a.plan, fleet, horizon, sd, "plan");
    for (const [k, o] of (a.options ?? []).entries()) checkPlan(ds, at, a, o, fleet, horizon, sd, `option${k}`);
    const cheapest = Math.min(...(a.options ?? [a.plan]).map((o) => o.cost));
    if (a.plan.cost > cheapest + 0.5) add(ds, at, "not-cheapest", `${a.facilityId}: plan $${a.plan.cost} but an option costs $${cheapest}`);
    trucksBySys.set(a.systemId, (trucksBySys.get(a.systemId) ?? 0) + a.plan.trucks);
  }
  for (const [sys, t] of trucksBySys) {
    const fleet = ops.systems[sys]?.emergency_fleet_size ?? 0;
    if (t > fleet) add(ds, at, "spec-shared-fleet", `${sys}: recommended plans use ${t} trucks, fleet is ${fleet}`);
    const fl = s.fleets.find((f) => f.systemId === sys);
    if (fl && fl.assignments.length !== t) add(ds, at, "fleet-view", `${sys}: plans use ${t} trucks but fleet view shows ${fl.assignments.length} assignments`);
  }
  for (const a of s.history) {
    if (a.status !== "resolved" || a.endUnix === null) add(ds, at, "history", `${a.id} in history but status ${a.status} end ${a.endUnix}`);
    if (a.category === "pump_failure" && a.plan) {
      const fleet = ops.systems[a.systemId]?.emergency_fleet_size ?? 0;
      checkPlan(ds, at, a, a.plan, fleet, ((a.repairEndsUnix ?? 0) - a.onsetUnix) / 60, sd, "history-plan");
    }
  }
}

function checkEvents(ds: string, at: string, ev: ReturnType<typeof toEventsJson>) {
  scanValues(ds, at, ev, "events");
  for (const e of ev) {
    if (e.status === "resolved" && !e.end_ts) add(ds, at, "events", `${e.event_id} resolved without end_ts`);
    if (e.category === "pump_failure" && e.status === "ongoing" && (!e.hours_to_limit || !Number.isFinite(e.hours_to_limit.p50)))
      add(ds, at, "events", `${e.event_id} ongoing failure hours_to_limit ${JSON.stringify(e.hours_to_limit)}`);
    if (!e.recommended_actions.length) add(ds, at, "events", `${e.event_id} has no actions`);
  }
}

// Ground truth from gen.py (ongoing pump failures at "now")
const EXPECT: Record<string, string[]> = {
  test_like: ["S6_FACILITY_A", "S6_FACILITY_B", "S6_FACILITY_C", "S8_FACILITY_B", "S8_FACILITY_D", "S7_FACILITY_A"],
  test: ["S6_FACILITY_A", "S6_FACILITY_B", "S6_FACILITY_C", "S8_FACILITY_B", "S8_FACILITY_D", "S7_FACILITY_A"],
  asset_sorted: ["S6_FACILITY_A", "S6_FACILITY_B", "S6_FACILITY_C", "S8_FACILITY_B", "S8_FACILITY_D", "S7_FACILITY_A"],
  crlf: ["S6_FACILITY_A", "S6_FACILITY_B", "S6_FACILITY_C", "S8_FACILITY_B", "S8_FACILITY_D", "S7_FACILITY_A"],
  calm: [],
  single_calm: [],
  single: ["S1_FACILITY_A"],
  at_shutdown: ["S1_FACILITY_A", "S1_FACILITY_B", "S2_FACILITY_A", "S2_FACILITY_C"],
  onset_now: ["S3_FACILITY_A", "S3_FACILITY_B"],
  short3: ["S1_FACILITY_A", "S2_FACILITY_B"],
  short1: ["S1_FACILITY_A"],
  odd_ids: ["S10_FACILITY_AA", "S12_FACILITY_1", "s13_facility_a", "s13_FACILITY_NORTH_RIDGE_LONGNAME", "S100_FACILITY_Z"],
  missing_zero: ["S1_FACILITY_A", "S1_FACILITY_B", "S2_FACILITY_A", "S2_FACILITY_B", "S3_FACILITY_A"],
  no_wells: ["S1_FACILITY_A", "S1_FACILITY_B"],
};

async function main() {
  const out: Record<string, unknown> = {};
  let list;
  try {
    list = listDatasets();
  } catch (e) {
    console.log("listDatasets CRASH", e);
    return;
  }
  const ids = list.map((d) => d.id);
  console.log("datasets:", list.map((d) => `${d.id} [${d.label}] ${d.startUnix}..${d.nowUnix}`).join("\n  "));
  for (const want of Object.keys(EXPECT)) if (!ids.includes(want)) add(want, "list", "missing-dataset", `listDatasets did not return ${want}`);
  for (const d of list) {
    if (!d.label?.trim()) add(d.id, "list", "empty-label", "label empty");
    if (/NaN|undefined|Infinity/.test(d.label)) add(d.id, "list", "bad-label", d.label);
  }
  const all_failing_extra = { all_failing: "*" };
  for (const d of list) {
    if (d.id.startsWith("snapshot") || d.id.startsWith("full_week") || d.id.startsWith("mock")) continue;
    const mid = Math.round((d.startUnix + d.nowUnix) / 2);
    const res: Record<string, unknown> = {};
    for (const [at, atU] of [["now", undefined], ["mid", mid], ["start", d.startUnix]] as const) {
      const t0 = performance.now();
      let snap: Snapshot;
      try {
        snap = await getSnapshot(d.id, atU);
      } catch (e) {
        add(d.id, at, "CRASH getSnapshot", (e as Error).stack?.split("\n").slice(0, 4).join(" | ") ?? String(e));
        continue;
      }
      const ms = performance.now() - t0;
      if (ms > 5000) add(d.id, at, "slow", `getSnapshot took ${ms.toFixed(0)} ms`);
      try {
        checkSnapshot(d.id, at, snap);
      } catch (e) {
        add(d.id, at, "CRASH checker", (e as Error).stack?.split("\n").slice(0, 3).join(" | ") ?? String(e));
      }
      let ev;
      try {
        ev = toEventsJson(snap);
        checkEvents(d.id, at, ev);
      } catch (e) {
        add(d.id, at, "CRASH toEventsJson", (e as Error).stack?.split("\n").slice(0, 4).join(" | ") ?? String(e));
      }
      if (at === "now") {
        const got = snap.alerts.filter((a) => a.category === "pump_failure").map((a) => a.facilityId).sort();
        const exp = d.id === "all_failing" ? snap.systems.flatMap((s) => s.facilities.map((f) => f.id)).sort() : EXPECT[d.id]?.slice().sort();
        if (exp && JSON.stringify(got) !== JSON.stringify(exp)) add(d.id, at, "detect", `ongoing failures got [${got}] expected [${exp}]`);
        const others = snap.alerts.filter((a) => a.category !== "pump_failure").map((a) => `${a.category}@${a.facilityId}`);
        res.summary = {
          ms: Math.round(ms),
          alerts: snap.alerts.map((a) => ({
            fac: a.facilityId, cat: a.category, p50: a.hoursToLimit?.p50, lvl: a.levelPct, plan: a.plan?.label, cost: a.plan?.cost, trucks: a.plan?.trucks,
          })),
          others,
          history: snap.history.length,
          fleets: snap.fleets.map((f) => `${f.systemId}:${f.assignments.length}/${f.size}`),
          health: snap.systems.flatMap((s) => s.facilities.map((f) => `${f.id}:${f.health}`)),
          totals: snap.totals,
        };
      }
      passes.push(`${d.id}@${at} ran in ${ms.toFixed(0)}ms`);
    }
    out[d.id] = res;
  }
  void all_failing_extra;
  // explicit nonsense inputs
  for (const atU of [NaN, -1, 1e12]) {
    try {
      const s = await getSnapshot("calm", atU);
      passes.push(`calm@${atU} -> now=${s.nowUnix}`);
    } catch (e) {
      add("calm", String(atU), "CRASH getSnapshot", String(e));
    }
  }
  try {
    await getSnapshot("does_not_exist");
    add("does_not_exist", "now", "no-error", "unknown id did not throw");
  } catch (e) {
    passes.push(`unknown dataset throws: ${(e as Error).message}`);
  }
  const report = { findings, passes, results: out };
  const file = path.resolve(process.cwd(), "../breaktest/results-engine.json");
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\n${findings.length} findings`);
  for (const f of findings) console.log(`- [${f.dataset} @${f.at}] ${f.kind}: ${f.detail}`);
  console.log(`\nwrote ${file}`);
}

main();
