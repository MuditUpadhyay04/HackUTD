import { describe, expect, test } from "bun:test";
import type { Frame, ImportedDataset } from "@hackutd/contracts";
import { boardIndex, buildRunSnapshot, parseRegisteredModel, planningInputForSnapshot } from "./service";

const frame = (tsUnix: number, patch: Partial<Frame> = {}): Frame => ({ facilityId: "facility", tsUnix, inflowBpd: 240, levelPct: 50, pumpStatus: 1, pumpFlowBpd: 240, receiveFlowBpd: 240, dischargePsi: 100, pipelinePsi: 100, wellStatus: [1], wellWaterBpd: [240], ...patch });
function dataset(frames: Frame[]): ImportedDataset {
  return {
    info: { id: "ds", label: "ds", startUnix: 0, nowUnix: 1200, status: "ready", createdAt: "", fileHashes: {}, warnings: [], hardwareEligible: true, hardwareReasons: [] },
    network: { defaults: { tank_limits_pct: { warning: 80, shutdown: 90 } }, systems: [{ id: "system", center: [0, 0], truck_yard: [0, 0], disposal_site: { id: "disposal", lat: 0, lon: 0, pressure_psi: 100 }, facilities: [{ id: "facility", lat: 0, lon: 0, wells: [{ id: "well", baseline_water_bpd: 240, oil_bpd: 100, gas_mcfd: 10 }], tank: { id: "tank", capacity_bbl: 1000 }, pump: { id: "pump", max_flow_bpd: 500, start_level_pct: 70, stop_level_pct: 30 }, pipeline: { id: "pipe" } }] }] },
    ops: { prices: { oil_per_bbl: 60, gas_per_mcf: 3 }, expected_repair_hours: { pump_failure: 6 }, emergency_trucking: { truck_capacity_bbl: 100, cost_per_trip: 100 }, systems: { system: { emergency_fleet_size: 1, facilities: { facility: { response_min: 30, cycle_min: 60 } } } } }, samples: [], frames,
  };
}
const run = (d: ImportedDataset, at: number, runId = "run") => buildRunSnapshot(d, { runId, at, runtime: "software" });

describe("causal runtime projection", () => {
  test("no future records, classifier scores, or fabricated health", async () => {
    const d = dataset([frame(0), frame(300, { pumpStatus: 2, pumpFlowBpd: 0 }), frame(600, { levelPct: 90 })]);
    const s = await run(d, 0);
    expect(s.alerts).toHaveLength(0); expect(s.runtime.scoresAvailable).toBe(false);
    expect(s.systems[0].facilities[0].health).toBe("unknown");
    expect(s.systems[0].facilities[0].series.level.t).toEqual([0]);
  });
  test("fault and independent observed shut-in survive missing pump status", async () => {
    const d = dataset([frame(0), frame(300, { pumpStatus: 2, pumpFlowBpd: 0 }), frame(600, { pumpStatus: null, pumpFlowBpd: 0, levelPct: 90, inflowBpd: 0, wellStatus: [0], wellWaterBpd: [0] })]);
    const s = await run(d, 600);
    expect(s.alerts).toHaveLength(1); expect(s.alerts[0].countdown?.status).toBe("at_limit");
    expect(s.systems[0].facilities[0].wells[0].producing).toBe(false);
    expect(s.systems[0].facilities[0].observedShutIn).toBe(true);
    expect(s.systems[0].facilities[0].dataQuality.reasons).toContain("missing pumpStatus");
  });
  test("left-censored and overdue faults never get a current plan", async () => {
    const first = await run(dataset([frame(0, { pumpStatus: 2, pumpFlowBpd: 0 })]), 0);
    expect(first.alerts[0].planningStatus).toBe("uncertain_horizon"); expect(first.alerts[0].plan).toBeUndefined();
    const d = dataset([frame(0), frame(300, { pumpStatus: 2, pumpFlowBpd: 0 }), frame(1200, { pumpStatus: 2, pumpFlowBpd: 0 })]);
    d.ops.expected_repair_hours.pump_failure = 0.1;
    const overdue = await run(d, 1200);
    expect(overdue.alerts[0].planningStatus).toBe("uncertain_horizon"); expect(overdue.alerts[0].plan).toBeUndefined();
  });
  test("run-qualified ids and resolved history contain no retrospective plan", async () => {
    const d = dataset([frame(0), frame(300, { pumpStatus: 2, pumpFlowBpd: 0 }), frame(600)]);
    const a = await run(d, 600, "a"); const b = await run(d, 600, "b");
    expect(a.history[0].id).not.toBe(b.history[0].id); expect(a.history[0].plan).toBeUndefined();
    expect(a.history[0].endUnix).toBe(600);
  });
  test("strict FPGA fails without a bridge", async () => {
    await expect(buildRunSnapshot(dataset([frame(0)]), { runId: "x", at: 0, runtime: "fpga" })).rejects.toMatchObject({ status: 503 });
  });
  test("all-null synthetic frame is not received coverage", async () => {
    const d = dataset([frame(0), frame(300, { inflowBpd: null, levelPct: null, pumpStatus: null, pumpFlowBpd: null, receiveFlowBpd: null, dischargePsi: null, pipelinePsi: null, wellStatus: [null], wellWaterBpd: [null] })]);
    const s = await run(d, 300);
    expect(s.coverage).toEqual({ expected: 1, received: 0, complete: false });
    expect(s.systems[0].facilities[0].observedShutIn).toBeNull();
  });
  test("scenario planning helper shares the current horizon and rejects uncertain failures", async () => {
    const d = dataset([frame(0), frame(300, { pumpStatus: 2, pumpFlowBpd: 0 })]);
    const s = await run(d, 300);
    const input = planningInputForSnapshot(d, s, "system");
    expect(input.jobs[0].horizonMin).toBe(360);
    expect(input.jobs[0].incidentId).toBe(s.alerts[0].id);
    s.alerts[0].planningStatus = "uncertain_horizon";
    expect(() => planningInputForSnapshot(d, s, "system")).toThrow();
  });
  test("series are bounded, aligned, and retain null gaps", async () => {
    const frames = Array.from({ length: 580 }, (_, i) => frame(i * 300, { levelPct: i === 500 ? null : 50 }));
    const d = dataset(frames); d.info.nowUnix = frames.at(-1)!.tsUnix;
    const s = await run(d, d.info.nowUnix);
    const series = s.systems[0].facilities[0].series;
    expect(series.level.t.length).toBeLessThanOrEqual(300);
    expect(series.level.t).toEqual(series.inflow.t);
    expect(series.level.v).toContain(null);
    expect(series.level.t[0]).toBeGreaterThanOrEqual(d.info.nowUnix - 48 * 3600);
  });
  test("registered independent heads produce simultaneous incidents and freeze on missing data", async () => {
    const model = parseRegisteredModel({ id: "test-bias-only", weightsVer: 1, weights: Array(124).fill(0), biases: [4, -4, 4, -4], outputShift: 0, logitScale: 1, thresholds: [0.8, 0.8, 0.8, 0.8], persistK: 1 });
    const d = dataset([frame(0), frame(300, { pumpStatus: null }), frame(600, { pumpStatus: 2, pumpFlowBpd: 0 }), frame(900)]);
    const s = await buildRunSnapshot(d, { runId: "model", at: 600, runtime: "software" }, { model });
    expect(s.runtime.scoresAvailable).toBe(true);
    expect(s.alerts.map(i => i.category)).toEqual(["pump_failure", "pipeline_leak"]);
    expect(s.alerts.find(i => i.category === "pipeline_leak")?.confidence).toBeGreaterThan(0.8);
    expect(s.history).toHaveLength(0);
    expect(s.systems[0].facilities[0].incidentIds).toHaveLength(2);
    expect(() => parseRegisteredModel({ ...model, thresholds: [0, 0, 0, NaN] })).toThrow();
    expect(() => parseRegisteredModel({ ...model, weights: [99999] })).toThrow();
  });
  test("streams bounded raw inference batches only through cutoff", async () => {
    const frames = Array.from({ length: 505 }, (_, i) => frame(i * 300));
    const d = dataset(frames); d.info.nowUnix = frames.at(-1)!.tsUnix;
    const batches: import("@hackutd/contracts").InferenceObservation[][] = [];
    await buildRunSnapshot(d, { runId: "stream", at: 502 * 300, runtime: "software" }, { onResults: async batch => { batches.push(batch); } });
    expect(batches.map(b => b.length)).toEqual([500, 3]);
    expect(batches.flat().at(-1)?.tsUnix).toBe(502 * 300);
    expect(Array.isArray((batches[0][0].body as { channels: unknown }).channels)).toBe(true);
  });
});

describe("board results as the detection source (test plan step 2)", () => {
  const line = (ts: number, above: string[], active: string[], extra: Record<string, unknown> = {}) =>
    ({ type: "result", facility: "facility", ts_unix: ts, status: "VALID", above_threshold: above, active, weights_ver: 4, source: "fpga",
       probability: { pipeline_leak: active.includes("pipeline_leak") ? 0.97 : 0.1 }, ...extra });
  const long = () => { const d = dataset(Array.from({ length: 8 }, (_, i) => frame(i * 300))); d.info.nowUnix = 2100; return d; };
  const L = ["pipeline_leak"];

  test("a leak the board flags becomes an incident from the board, with onset, provenance and model version", async () => {
    const board = boardIndex([line(0, [], []), line(300, L, []), line(600, L, L), line(900, L, L), line(1200, [], []), line(1500, [], []), line(1800, [], []), line(2100, [], [])]);
    const s = await buildRunSnapshot(long(), { runId: "run", at: 900, runtime: "software" }, { board });
    const leak = s.alerts.find((i) => i.category === "pipeline_leak")!;
    expect(leak).toMatchObject({ status: "ongoing", onsetUnix: 300, provenance: "fpga", modelVersion: "weights v4", confidence: 0.97 });
    expect(s.runtime.scoresAvailable).toBe(true);
    expect(s.runtime.reasons.join(" ")).toContain("board results (fpga, weights v4)");
    // resolved after three usable board records without it: 1200, 1500, 1800
    const later = await buildRunSnapshot(long(), { runId: "run", at: 2100, runtime: "software" }, { board });
    expect(later.alerts.some((i) => i.category === "pipeline_leak")).toBe(false);
    expect(later.history.find((i) => i.category === "pipeline_leak")).toMatchObject({ status: "resolved", endUnix: 1800 });
    // checked by the board and clear: "ok"; at a cutoff the board never scored: "unknown", never healthy (hard rule 9)
    expect(s.systems[0]!.facilities[0]!.health).toBe("leak");
    expect(later.systems[0]!.facilities[0]!.health).toBe("ok");
    const unscored = boardIndex([line(0, [], []), line(300, [], []), line(600, [], [])]);
    expect((await buildRunSnapshot(long(), { runId: "run", at: 900, runtime: "software" }, { board: unscored })).systems[0]!.facilities[0]!.health).toBe("unknown");
  });

  test("an INVALID board record freezes the streak instead of resolving it", async () => {
    const board = boardIndex([line(300, L, []), line(600, L, L), line(900, [], []), line(1200, [], [], { status: "INVALID" }), line(1500, [], [], { status: "INVALID" }), line(1800, [], [])]);
    const s = await buildRunSnapshot(long(), { runId: "run", at: 1800, runtime: "software" }, { board });
    expect(s.alerts.find((i) => i.category === "pipeline_leak")?.status).toBe("ongoing"); // only 2 usable records without it
  });

  test("board results for another dataset are ignored, and the run says so", async () => {
    const board = boardIndex([{ ...line(300, L, L), facility: "OTHER" }]);
    const s = await buildRunSnapshot(long(), { runId: "run", at: 900, runtime: "software" }, { board });
    expect(s.alerts).toHaveLength(0);
    expect(s.runtime.scoresAvailable).toBe(false);
    expect(s.runtime.reasons.join(" ")).toContain("do not cover");
  });
});
