import { describe, expect, test } from "bun:test";
import type { SimulationTimeline } from "@hackutd/contracts";
import { importDataset } from "../datasets/service";
import { boardIndex } from "../runtimes/board";
import { buildTimeline, TimelineCache } from "./timeline";

/** One system, one facility: the pump fails (status 2) at step 6 and the tank fills; 24 five-minute steps. */
async function failingFacility() {
  const network = { defaults: { tank_limits_pct: { warning: 85, shutdown: 92 } }, systems: [{ id: "SX", center: [31, -102], truck_yard: [31.1, -102.1], disposal_site: { id: "SX_D", lat: 31.05, lon: -102, pressure_psi: 1000 },
    facilities: [{ id: "SX_F", lat: 31.02, lon: -102.02, wells: [{ id: "SX_W1", baseline_water_bpd: 2000, oil_bpd: 300, gas_mcfd: 900 }], tank: { id: "SX_T", capacity_bbl: 1000 },
      pump: { id: "SX_P", max_flow_bpd: 3000, start_level_pct: 70, stop_level_pct: 30 }, pipeline: { id: "SX_L", max_bpd: 4000, max_pressure_psi: 1700 } }] }] };
  const ops = { prices: { oil_per_bbl: 60, gas_per_mcf: 3 }, expected_repair_hours: { pump_failure: 6 }, emergency_trucking: { truck_capacity_bbl: 150, cost_per_trip: 905 },
    systems: { SX: { emergency_fleet_size: 2, facilities: { SX_F: { response_min: 60, cycle_min: 200 } } } } };
  const rows = ["timestamp,ts_unix,asset_id,metric,value"];
  const t0 = 1791158400;
  for (let k = 0; k < 24; k++) {
    const ts = t0 + k * 300, iso = new Date(ts * 1000).toISOString().replace(".000", ""), down = k >= 6;
    const level = down ? 50 + (k - 6) * 0.7 : 50;
    for (const [a, m, v] of [["SX_W1", "water_bpd", 2000], ["SX_W1", "status", 1], ["SX_F", "inflow_bpd", 2000], ["SX_T", "level_pct", level], ["SX_P", "status", down ? 2 : 1],
      ["SX_P", "flow_bpd", down ? 0 : 2000], ["SX_P", "discharge_psi", down ? 1000 : 1150], ["SX_L", "receive_flow_bpd", down ? 0 : 2000], ["SX_L", "pressure_psi", down ? 1000 : 1050]] as const)
      rows.push(`${iso},${ts},${a},${m},${v}`);
  }
  return importDataset({ network: JSON.stringify(network), ops: JSON.stringify(ops), telemetry: rows.join("\n") + "\n" });
}

describe("simulation timeline", () => {
  test("one pass: incidents, the plan made at onset with its cost vs doing nothing, trucks, levels", async () => {
    const d = await failingFacility();
    const t = await buildTimeline(d);
    expect(t).toMatchObject({ datasetId: d.info.id, startUnix: d.info.startUnix, nowUnix: d.info.nowUnix, stepSeconds: 300, seriesStepSeconds: 300 });
    expect(t.detections.from).toBe("software");
    expect(t.incidents.map((i) => [i.category, i.facilityId, i.onsetUnix])).toEqual([["pump_failure", "SX_F", d.info.startUnix + 6 * 300]]);
    expect(t.plans).toHaveLength(1);
    const p = t.plans[0]!;
    expect(p.plannedUnix).toBe(t.incidents[0]!.onsetUnix);
    if (p.cost != null && p.doNothingCost != null) expect(p.kept).toBe(Math.max(0, p.doNothingCost - p.cost));
    for (const k of t.trucks) { expect(k.systemId).toBe("SX"); expect(k.fromUnix).toBeGreaterThanOrEqual(p.plannedUnix); expect(k.arrivalsUnix.every((a) => a >= k.fromUnix && a <= k.toUnix)).toBe(true); }
    expect(t.levels.SX_F).toHaveLength(24);
    expect(t.levels.SX_F![0]).toBe(50);
    expect(t.totals.failures).toBe(1);
    expect(t.systems[0]).toMatchObject({ id: "SX", fleetSize: 2, facilities: [{ id: "SX_F", capacityBbl: 1000, wells: 1 }] });
  });
});

describe("simulation timeline while the board is part-way through", () => {
  test("the story ends at the board's last result; a failure still on there stays open", async () => {
    const d = await failingFacility();
    const lines = Array.from({ length: 12 }, (_, k) => ({ type: "result", facility: "SX_F", ts_unix: d.info.startUnix + k * 300, status: "VALID",
      above_threshold: k >= 6 ? ["pump_failure"] : [], active: k >= 7 ? ["pump_failure"] : [], weights_ver: 4, source: "fpga" }));
    const t = await buildTimeline(d, { board: boardIndex(lines) });
    expect(t.nowUnix).toBe(d.info.startUnix + 11 * 300);
    expect(t.datasetNowUnix).toBe(d.info.nowUnix);
    expect(t.detections).toMatchObject({ from: "board", provenance: "fpga", boardResults: 12, boardLastUnix: t.nowUnix });
    // opened by the pump's own fault status (telemetry), still on at the board's last result
    expect(t.incidents.find((i) => i.category === "pump_failure")).toMatchObject({ endUnix: null });
  });
});

describe("incremental rebuild", () => {
  test("a rebuild with the previous timeline keeps the plans already made and gives the same story", async () => {
    const d = await failingFacility();
    const first = await buildTimeline(d);
    const again = await buildTimeline(d, { prev: first });
    expect(again.plans).toEqual(first.plans);
    expect(again.trucks).toEqual(first.trucks);
    expect(again.incidents).toEqual(first.incidents);
    // a previous timeline of another dataset is ignored
    expect((await buildTimeline(d, { prev: { ...first, datasetId: "other", plans: [] } })).plans).toEqual(first.plans);
  });
});

describe("timeline cache", () => {
  const fake = (n: number) => ({ datasetId: `d${n}` }) as unknown as SimulationTimeline;
  test("concurrent requests share one build; same stamp is served from cache", async () => {
    const c = new TimelineCache(6, 0);
    let builds = 0;
    const build = async () => { builds++; await Bun.sleep(5); return fake(builds); };
    const [a, b] = await Promise.all([c.get("x", "s1", build), c.get("x", "s1", build)]);
    expect(a).toBe(b);
    expect(await c.get("x", "s1", build)).toBe(a);
    expect(builds).toBe(1);
  });
  test("a new board stamp rebuilds, but within minAge the previous timeline is reused", async () => {
    const c = new TimelineCache(6, 60_000);
    let builds = 0;
    const build = async () => fake(++builds);
    const first = await c.get("x", "s1", build);
    expect(await c.get("x", "s2", build)).toBe(first);            // board file grew, but the timeline is fresh
    const old = new TimelineCache(6, 0);
    const prev = await old.get("x", "s1", build);
    expect(await old.get("x", "s2", build)).toBe(prev);          // stale while the rebuild runs
    await Bun.sleep(1);
    expect((await old.get("x", "s2", build)).datasetId).toBe(`d${builds}`);
  });
  test("a failed build is not cached and doesn't poison the next request", async () => {
    const c = new TimelineCache(6, 0);
    await expect(c.get("x", "s1", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect((await c.get("x", "s1", async () => fake(7))).datasetId).toBe("d7");
  });
  test("keeps at most `max` datasets", async () => {
    const c = new TimelineCache(2, 0);
    let builds = 0;
    const build = async () => fake(++builds);
    for (const id of ["a", "b", "c"]) await c.get(id, "s", build);
    await c.get("a", "s", build);
    expect(builds).toBe(4);                                       // "a" was evicted
  });
});
