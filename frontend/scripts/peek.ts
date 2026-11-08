// Dev: print alerts for a dataset at a given time.  npx tsx scripts/peek.ts full_week 2026-10-08T14:00
import { buildSnapshot } from "../src/lib/engine/snapshot";
const [id, at] = process.argv.slice(2);
const s = buildSnapshot(id, at ? Date.parse(at + "Z") / 1000 : undefined);
console.log("json KB", (JSON.stringify(s).length / 1024).toFixed(0), "now", new Date(s.nowUnix * 1000).toISOString());
for (const a of s.alerts) {
  console.log(a.id, a.category, "conf", a.confidence, "lvl", a.levelPct, "h2l", JSON.stringify(a.hoursToLimit), "\n  ", a.evidence.join(" | "));
  for (const o of a.options ?? []) console.log("   ", o.kind, o.cost, o.label, "arr", o.truckArrivalsMin, "trip", o.tripAtMin, "curve", o.levelCurve.length, JSON.stringify(o.levelCurve.filter((_, i) => i % 12 === 0 || i === o.levelCurve.length - 1)));
}
console.log(JSON.stringify(s.fleets.filter((f) => f.assignments.length)), JSON.stringify(s.totals));
const f = s.systems[1].facilities[0];
console.log(f.id, f.health, f.fillPctPerHour, f.series.level.t.length, f.wells[0]);
