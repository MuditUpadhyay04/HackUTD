// Offline verification of the engine against the practice answer keys.
// This script (and only this script) reads answer_key.json.
//   npx tsx scripts/check-engine.ts
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { listDatasets, loadDataset } from "../src/lib/engine/datasets";
import { buildSnapshot, plansAtOnset, toEventsJson } from "../src/lib/engine/snapshot";
import { facilityContexts } from "../src/lib/engine/model";
import { detect } from "../src/lib/engine/detect";

interface KeyEv {
  id: string;
  system: string;
  facility: string;
  asset: string;
  category: string;
  onset_unix: number;
  end_unix: number | null;
  status: string;
  reference_action: string;
  level_final_pct?: number;
  hours_to_limit_final?: number;
  lost_revenue_per_hour?: number;
  order?: number;
}

const iso = (u: number) => new Date(u * 1000).toISOString().slice(5, 16).replace("T", " ");
const refCost = (s: string): number => {
  if (/^none/i.test(s)) return 0;
  const m = /~\$([\d,]+)/.exec(s);
  return m ? Number(m[1].replace(/,/g, "")) : NaN;
};
const money = (x: number) => "$" + Math.round(x).toLocaleString("en-US");
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const TOL = 30 * 60;
let problems = 0;
const flag = (ok: boolean) => (ok ? "OK " : (problems++, "XX "));

function readKey(dir: string): KeyEv[] | null {
  const p = path.join(dir, "answer_key.json");
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as KeyEv[]) : null;
}

// ------------------------------------------------------------------ timing
console.log("== Datasets & timing (cold load = parse telemetry.csv; snapshot = detect + plan + build)");
for (const d of listDatasets()) {
  const t0 = performance.now();
  loadDataset(d.id);
  const t1 = performance.now();
  buildSnapshot(d.id);
  const t2 = performance.now();
  buildSnapshot(d.id);
  const t3 = performance.now();
  console.log(`${pad(d.id, 30)} ${pad(d.label, 44)} load ${(t1 - t0).toFixed(0)}ms  snapshot ${(t2 - t1).toFixed(0)}ms  cached ${(t3 - t2).toFixed(2)}ms`);
}

// ------------------------------------------------------------------ detection on full_week
{
  console.log("\n== full_week detection vs answer key (match: same facility + category, onset within ±30 min)");
  const ds = loadDataset("full_week");
  const key = readKey(ds.dir)!;
  const facs = facilityContexts(ds);
  const { events } = detect(ds, facs, ds.n - 1);
  const used = new Set<number>();
  const cats = ["pump_failure", "pipeline_leak", "pump_degradation"];
  const tp: Record<string, number> = {};
  const nKey: Record<string, number> = {};
  const nDet: Record<string, number> = {};
  for (const c of cats) (tp[c] = 0), (nKey[c] = 0), (nDet[c] = 0);
  for (const e of events) nDet[e.category]++;
  for (const k of key) {
    nKey[k.category]++;
    const j = events.findIndex((e, j) => !used.has(j) && e.fc.fac.id === k.facility && e.category === k.category && Math.abs(ds.t0 + e.onsetIdx * ds.dt - k.onset_unix) <= TOL);
    const e = events[j];
    if (j >= 0) {
      used.add(j);
      tp[k.category]++;
    }
    const dOn = e ? (ds.t0 + e.onsetIdx * ds.dt - k.onset_unix) / 60 : NaN;
    const dEnd = e && e.endIdx !== null && k.end_unix ? (ds.t0 + e.endIdx * ds.dt - k.end_unix) / 60 : NaN;
    const dDet = e ? (ds.t0 + e.detectIdx * ds.dt - k.onset_unix) / 60 : NaN;
    console.log(
      `${flag(j >= 0)}${pad(k.id, 9)} ${pad(k.category, 17)} ${pad(k.asset, 14)} onset ${iso(k.onset_unix)}  ` +
        (e ? `onsetΔ ${pad(dOn + "m", 6)} endΔ ${pad(dEnd + "m", 6)} detected +${dDet}m  conf ${e.confidence.toFixed(2)}` : "MISSED")
    );
  }
  events.forEach((e, j) => {
    if (!used.has(j)) console.log(`XX FALSE POSITIVE ${e.category} ${e.assetId} onset ${iso(ds.t0 + e.onsetIdx * ds.dt)}`), problems++;
  });
  console.log("category           precision  recall");
  for (const c of cats) console.log(`${pad(c, 18)} ${pad(`${tp[c]}/${nDet[c]}`, 10)} ${tp[c]}/${nKey[c]}`);

  // ---------------- at-onset reference plans
  console.log("\n== full_week pump failures planned at onset (earlier plans' trucks stay busy) vs reference_action");
  const ops = plansAtOnset(ds, events, ds.n - 1);
  let sumRef = 0;
  let sumOurs = 0;
  for (const k of key.filter((x) => x.category === "pump_failure")) {
    const op = ops.find((o) => o.event.fc.fac.id === k.facility && Math.abs(ds.t0 + o.event.onsetIdx * ds.dt - k.onset_unix) <= TOL);
    const rc = refCost(k.reference_action);
    sumRef += rc;
    if (!op) {
      console.log(`XX ${k.id} no plan`);
      problems++;
      continue;
    }
    sumOurs += op.plan.cost;
    const ok = Math.abs(op.plan.cost - rc) <= Math.max(5, rc * 0.005);
    console.log(`${flag(ok)}${pad(k.id, 9)} ${pad(k.asset, 11)} free ${op.freeTrucks}  ours ${pad(money(op.plan.cost), 8)} ref ${pad(money(rc), 8)} | ${op.plan.label}  ||  ref: ${k.reference_action}`);
  }
  console.log(`   total ours ${money(sumOurs)}  ref ${money(sumRef)}`);
}

// ------------------------------------------------------------------ snapshots
for (const d of listDatasets().filter((x) => x.id.startsWith("snapshot"))) {
  const ds = loadDataset(d.id);
  const key = readKey(ds.dir);
  if (!key) continue;
  const snap = buildSnapshot(d.id);
  console.log(`\n== ${d.id}  now ${iso(snap.nowUnix)}`);
  const ongoingKey = key.filter((k) => k.status === "ongoing");
  // detection of every ongoing event
  for (const k of ongoingKey) {
    const a = snap.alerts.find((x) => x.facilityId === k.facility && x.category === k.category && Math.abs(x.onsetUnix - k.onset_unix) <= TOL);
    console.log(`${flag(!!a)}${pad(k.id, 9)} ${pad(k.category, 17)} ${pad(k.asset, 14)} ${a ? `detected, onsetΔ ${(a.onsetUnix - k.onset_unix) / 60}m conf ${a.confidence}` : "NOT IN ALERTS"}`);
  }
  for (const a of snap.alerts) {
    if (!ongoingKey.some((k) => k.facility === a.facilityId && k.category === a.category)) console.log(`XX extra alert ${a.category} ${a.assetId} onset ${iso(a.onsetUnix)}`), problems++;
  }
  // resolved events visible in history
  const resolvedKey = key.filter((k) => k.status === "resolved");
  const histHits = resolvedKey.filter((k) => snap.history.some((h) => h.facilityId === k.facility && h.category === k.category && Math.abs(h.onsetUnix - k.onset_unix) <= TOL)).length;
  console.log(`${flag(histHits === resolvedKey.length && snap.history.length === resolvedKey.length)}history: ${histHits}/${resolvedKey.length} resolved key events matched; ${snap.history.length} resolved incidents reported`);
  // order + plans
  const fails = snap.alerts.filter((a) => a.category === "pump_failure");
  const orderOurs = fails.map((a) => a.assetId).join(" > ");
  const orderRef = ongoingKey.filter((k) => k.order).sort((a, b) => a.order! - b.order!).map((k) => k.asset).join(" > ");
  console.log(`${flag(orderOurs === orderRef)}alert order ours: ${orderOurs}\n   alert order ref : ${orderRef}`);
  let sumO = 0;
  let sumR = 0;
  for (const k of ongoingKey.filter((x) => x.category === "pump_failure")) {
    const a = fails.find((x) => x.facilityId === k.facility);
    if (!a || !a.plan) continue;
    const rc = refCost(k.reference_action);
    sumO += a.plan.cost;
    sumR += rc;
    const okC = Math.abs(a.plan.cost - rc) <= Math.max(5, rc * 0.005);
    const okH = Math.abs((a.hoursToLimit?.p50 ?? NaN) - (k.hours_to_limit_final ?? NaN)) <= 0.05;
    const okL = Math.abs((a.levelPct ?? NaN) - (k.level_final_pct ?? NaN)) <= 0.3;
    const okR = Math.abs((a.lostRevenuePerHour ?? NaN) - (k.lost_revenue_per_hour ?? NaN)) < 0.01;
    console.log(
      `${flag(okC)}${pad(k.id, 9)} cost ours ${pad(money(a.plan.cost), 8)} ref ${pad(money(rc), 8)} | ${a.plan.label}  ||  ref: ${k.reference_action}\n` +
        `   ${flag(okH)}hours_to_limit p50 ${a.hoursToLimit?.p50} (p10 ${a.hoursToLimit?.p10}, p90 ${a.hoursToLimit?.p90}) ref ${k.hours_to_limit_final}   ${flag(okL)}level ${a.levelPct} ref ${k.level_final_pct}   ${flag(okR)}lost rev/h ${a.lostRevenuePerHour} ref ${k.lost_revenue_per_hour}\n` +
        `   options: ${a.options!.map((o) => `[${o.kind} ${money(o.cost)}${o.tankTrips ? " trips" : ""}] ${o.label}`).join(" ; ")}`
    );
  }
  console.log(`   system plan total ours ${money(sumO)} ref ${money(sumR)}; snapshot totals ${JSON.stringify(snap.totals)}`);
  for (const f of snap.fleets.filter((f) => f.assignments.length)) console.log(`   fleet ${f.systemId} (${f.size}): ` + f.assignments.map((a) => `truck ${a.truck} -> ${a.facilityId} arrivals ${a.tripsArrivalUnix.map(iso).join(",")} free ${iso(a.toUnix)}`).join("; "));

  // time-travel consistency: full_week at the same moment must give the same alerts and plans
  const tt = buildSnapshot("full_week", snap.nowUnix);
  const sig = (s: typeof snap) => s.alerts.map((a) => `${a.id}:${a.plan ? Math.round(a.plan.cost) : "-"}`).join(",");
  console.log(`${flag(sig(tt) === sig(snap))}time-travel full_week@${iso(snap.nowUnix)} matches snapshot folder`);
}

// ------------------------------------------------------------------ mock test + events.json
for (const d of listDatasets().filter((x) => !x.id.startsWith("snapshot") && x.id !== "full_week")) {
  const snap = buildSnapshot(d.id);
  console.log(`\n== ${d.id} (${d.label}) now ${iso(snap.nowUnix)} — alerts:`);
  for (const a of snap.alerts) {
    console.log(
      `   ${pad(a.category, 17)} ${pad(a.assetId, 14)} onset ${iso(a.onsetUnix)} conf ${a.confidence}` +
        (a.category === "pump_failure" ? ` level ${a.levelPct}% h2l p50 ${a.hoursToLimit?.p50}h  plan ${money(a.plan!.cost)}: ${a.plan!.label}` : "") +
        `\n      ${a.evidence.join(" | ")}`
    );
  }
  console.log(`   history: ${snap.history.length} resolved; totals ${JSON.stringify(snap.totals)}`);
  const ev = toEventsJson(snap);
  console.log(`   events.json: ${ev.length} events; first ongoing: ${JSON.stringify(ev.find((e) => e.status === "ongoing" && e.category === "pump_failure") ?? null)}`);
}

// ------------------------------------------------------------------ time-travel sweep
{
  const d = listDatasets().find((x) => x.id === "full_week")!;
  let worst = 0;
  let n = 0;
  let maxAlerts = 0;
  let bad = 0;
  for (let u = d.startUnix; u <= d.nowUnix; u += 1800) {
    const t0 = performance.now();
    const s = buildSnapshot("full_week", u);
    worst = Math.max(worst, performance.now() - t0);
    n++;
    maxAlerts = Math.max(maxAlerts, s.alerts.length);
    for (const a of s.alerts) {
      if (a.category === "pump_failure" && (!a.plan || !a.options?.length || !a.hoursToLimit)) bad++;
      if (a.plan && a.options && a.options[0].cost > a.plan.cost + 0.01) bad++;
      if (a.plan && a.plan.trucks > (s.systems.find((x) => x.id === a.systemId)?.fleetSize ?? 0)) bad++;
    }
    for (const f of s.fleets) if (f.assignments.length > f.size) bad++;
  }
  console.log(`\n== time-travel sweep full_week every 30 min: ${n} snapshots, worst ${worst.toFixed(0)}ms, max ${maxAlerts} alerts, ${bad} invariant violations`);
  if (bad) problems++;
}

console.log(`\n${problems === 0 ? "ALL CHECKS OK" : `${problems} check(s) flagged XX`}`);
