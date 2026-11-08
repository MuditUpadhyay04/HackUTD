// Dev-only: dump a facility's readings over a time window.  npx tsx scripts/explore.ts full_week S2_FACILITY_A 2026-10-05T18:00 2026-10-06T22:00 [everyN]
import { loadDataset, getSeries } from "../src/lib/engine/datasets";
const [id, fac, a, b, every] = process.argv.slice(2);
const t = Date.now();
const ds = loadDataset(id);
console.error("load ms", Date.now() - t, "n", ds.n, "series", ds.series.size);
const sys = ds.network.systems.find((s) => s.facilities.some((f) => f.id === fac))!;
const f = sys.facilities.find((f) => f.id === fac)!;
const i0 = Math.max(0, (Date.parse(a + "Z") / 1000 - ds.t0) / ds.dt);
const i1 = Math.min(ds.n - 1, (Date.parse(b + "Z") / 1000 - ds.t0) / ds.dt);
const cols: [string, Float64Array][] = [
  ["lvl", getSeries(ds, f.tank.id, "level_pct")],
  ["in", getSeries(ds, f.id, "inflow_bpd")],
  ["pst", getSeries(ds, f.pump.id, "status")],
  ["flow", getSeries(ds, f.pump.id, "flow_bpd")],
  ["dpsi", getSeries(ds, f.pump.id, "discharge_psi")],
  ["recv", getSeries(ds, f.pipeline.id, "receive_flow_bpd")],
  ["ppsi", getSeries(ds, f.pipeline.id, "pressure_psi")],
  ...f.wells.map((w) => [w.id.slice(-2), getSeries(ds, w.id, "water_bpd")] as [string, Float64Array]),
];
console.log("time  " + cols.map((c) => c[0].padStart(8)).join(""), " recv-flow");
for (let i = i0; i <= i1; i += Number(every ?? 1)) {
  const ts = new Date((ds.t0 + i * ds.dt) * 1000).toISOString().slice(5, 16);
  console.log(ts + cols.map((c) => c[1][i].toFixed(1).padStart(8)).join(""), (cols[5][1][i] - cols[3][1][i]).toFixed(1).padStart(8));
}
