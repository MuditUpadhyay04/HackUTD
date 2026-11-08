import { describe, expect, test } from "bun:test";
import type { FacilityState, Incident, Snapshot } from "@/lib/engine/types";
import { lineViewAt } from "./pipeview-model";

const NOW = 1_000_000;
const ts = Array.from({ length: 8 }, (_, i) => NOW - (7 - i) * 300);
function fac(over: Partial<FacilityState> = {}, level: (number | null)[] = Array(8).fill(50), pump: (number | null)[] = Array(8).fill(100)): FacilityState {
  return {
    id: "S1_FACILITY_A", systemId: "S1", letter: "A", lat: 0, lon: 0,
    tank: { id: "T", capacityBbl: 1000, levelPct: level[7] },
    pump: { id: "P", status: 1, flowBpd: pump[7], maxFlowBpd: 200, dischargePsi: null, startLevelPct: 70, stopLevelPct: 30 },
    pipeline: { id: "L", receiveFlowBpd: null, pressurePsi: null },
    inflowBpd: 10, wells: [], fillPctPerHour: null, revenuePerHour: 0, health: "ok",
    dataQuality: { quality: "VALID", reasons: [] }, incidentIds: [],
    series: { level: { t: ts, v: level }, inflow: { t: ts, v: Array(8).fill(10) }, pumpFlow: { t: ts, v: pump }, receiveFlow: { t: ts, v: pump } },
    ...over,
  };
}
const inc = (p: Partial<Incident> & Pick<Incident, "id" | "category">): Incident => ({
  status: "ongoing", systemId: "S1", facilityId: "S1_FACILITY_A", assetId: "A", onsetUnix: NOW - 3600, endUnix: null, confidence: 1, evidence: [], ...p,
});
const snap = (f: FacilityState, alerts: Incident[] = [], board?: Snapshot["board"]): Snapshot => ({
  runId: "r", dataset: { id: "d", label: "d", startUnix: NOW - 86400, nowUnix: NOW }, limits: { warningPct: 80, shutdownPct: 95 }, nowUnix: NOW, board,
  systems: [{ id: "S1", center: [0, 0], truckYard: [0, 0], disposal: { id: "D", lat: 0, lon: 0, pressurePsi: 0 }, fleetSize: 1, facilities: [f] }],
  alerts, history: [], fleets: [], totals: { facilities: 1, atRisk: 0, revenueAtRiskPerHour: 0, planCost: 0 },
});

describe("lineViewAt state encoding", () => {
  test("flowing carries the flow text and flow motion", () => {
    const f = fac();
    const vm = lineViewAt(snap(f), f, NOW);
    expect(vm.status).toBe("flowing");
    expect(vm.motion).toBe("flow");
    expect(vm.flowText).toBe("100 bpd");
    expect(vm.problem).toBe(false);
    expect(vm.pillText).toBe("");
    expect(vm.flowRatio).toBe(0.5);
  });
  test("idle: no motion, Idle, not a problem", () => {
    const f = fac({}, Array(8).fill(50), Array(8).fill(0));
    const vm = lineViewAt(snap(f), f, NOW);
    expect(vm.status).toBe("idle");
    expect(vm.motion).toBe("none");
    expect(vm.stateText).toBe("Idle");
    expect(vm.problem).toBe(false);
  });
  test("pump down: red, no packets, countdown, unknown stays unknown", () => {
    const f = fac();
    const down = inc({ id: "i1", category: "pump_failure", hoursToLimit: { p10: 10, p50: 13.85, p90: 20 } });
    const vm = lineViewAt(snap(f, [down]), f, NOW);
    expect(vm.status).toBe("down");
    expect(vm.redOn).toBe(true);
    expect(vm.motion).toBe("none");
    expect(vm.stateText).toBe("Pump down, shutdown in 13:51");
    expect(vm.pillText).toBe("Pump down 13:51");
    expect(vm.problem).toBe(true);
    const unk = lineViewAt(snap(f, [inc({ id: "i2", category: "pump_failure", hoursToLimit: null })]), f, NOW);
    expect(unk.stateText).toBe("Pump down, shutdown time unknown");
  });
  test("leak and worn: hatch, inspect text, packets still move", () => {
    const f = fac();
    const leak = lineViewAt(snap(f, [inc({ id: "l", category: "pipeline_leak", estLeakBblPerDay: 120 })]), f, NOW);
    expect(leak.hatchPipe).toBe(true);
    expect(leak.motion).toBe("leak");
    expect(leak.stateText).toBe("Inspect, leak about 120 bbl/d");
    expect(leak.pillText).toBe("Inspect 120 bbl/d");
    expect(leak.problem).toBe(true);
    const worn = lineViewAt(snap(f, [inc({ id: "w", category: "pump_degradation", capacityLossPct: 18 })]), f, NOW);
    expect(worn.hatchPump).toBe(true);
    expect(worn.motion).toBe("worn");
    expect(worn.stateText).toBe("Inspect, 18% capacity loss");
  });
  test("shut in: grey wells", () => {
    const f = fac();
    const vm = lineViewAt(snap(f, [inc({ id: "s", category: "facility_shut_in" })]), f, NOW);
    expect(vm.wellsGrey).toBe(true);
    expect(vm.stateText).toBe("Shut in");
    expect(vm.problem).toBe(true);
  });
  test("missing data is never healthy: grain, No data, no packets", () => {
    const f = fac({ dataQuality: { quality: "DROPPED", reasons: ["Tank level not reported for 35 min"] } }, Array(7).fill(50).concat([null]), Array(7).fill(100).concat([null]));
    const vm = lineViewAt(snap(f), f, NOW);
    expect(vm.status).toBe("nodata");
    expect(vm.q).toBe(3);
    expect(vm.motion).toBe("none");
    expect(vm.stateText).toBe("No data");
    expect(vm.pillText).toBe("No data");
    expect(vm.problem).toBe(true);
    expect(vm.reasonText).toBe("Tank level not reported for 35 min");
    expect(vm.tankText).toBe("Unknown");
  });
  test("HELD data renders as grain level 1 with Held text", () => {
    const f = fac({ dataQuality: { quality: "HELD", reasons: ["held"] } });
    const vm = lineViewAt(snap(f), f, NOW);
    expect(vm.q).toBe(1);
    expect(vm.stateText.startsWith("Held")).toBe(true);
    expect(vm.motion).toBe("none");
  });
  test("health unknown with valid readings renders as normal measured flow, never no-data and never healthy", () => {
    const f = fac({ health: "unknown" });
    const vm = lineViewAt(snap(f), f, NOW);
    expect(vm.status).toBe("flowing");
    expect(vm.q).toBe(0);
    expect(vm.motion).toBe("flow");
    expect(vm.tone).toBe("none");
    expect(vm.problem).toBe(false);
    expect(vm.flowText).toBe("100 bpd");
    expect(vm.checksUnavailable).toBe(true);
    expect(vm.tankText).toBe("50%");
    expect(/healthy|\bok\b/i.test(JSON.stringify(vm))).toBe(false);
    // known health never raises the note, and real missing data stays no-data (the note is not shown over it)
    expect(lineViewAt(snap(fac()), fac(), NOW).checksUnavailable).toBe(false);
    const g = fac({ health: "unknown", dataQuality: { quality: "DROPPED", reasons: [] } }, Array(7).fill(50).concat([null]), Array(7).fill(100).concat([null]));
    const nd = lineViewAt(snap(g), g, NOW);
    expect(nd.status).toBe("nodata");
    expect(nd.checksUnavailable).toBe(false);
  });
  test("board alarm is a display-only badge with text for the tooltip", () => {
    const f = fac();
    const board = { source: "live", provenance: "fpga", online: true, mode: "NORMAL", lastSeenUnix: NOW, weightsVersion: 4, autonomousSinceUnix: null, replayedAlerts: 0,
      facilities: [{ facilityId: f.id, updatedUnix: NOW, scores: null, overThreshold: [], source: "rule", sinceReset: 1, alarm: "e_stop", alarmState: "raised", alarmSinceUnix: NOW - 600, replayed: false, degradationTrend: null }] } as Snapshot["board"];
    const vm = lineViewAt(snap(f, [], board), f, NOW);
    expect(vm.alarm?.text).toBe("E-stop (board, display only)")
    expect(vm.problem).toBe(true);
    expect(lineViewAt(snap(f, [], board), f, NOW - 1200).alarm).toBeNull();
  });
  test("no on-canvas text is ALL CAPS", () => {
    const f = fac();
    for (const alerts of [[], [inc({ id: "l", category: "pipeline_leak" })], [inc({ id: "d", category: "pump_failure", hoursToLimit: { p10: 10, p50: 13.85, p90: 20 } })]]) {
      const vm = lineViewAt(snap(f, alerts), f, NOW);
      for (const t of [vm.stateText, vm.pillText, vm.flowText, vm.tankText, vm.etaText ?? ""]) expect(/[A-Z]{3,}/.test(t)).toBe(false);
    }
  });
  test("strings never contain middle dots or em dashes", () => {
    const f = fac();
    const vm = lineViewAt(snap(f, [inc({ id: "l", category: "pipeline_leak" })]), f, NOW);
    expect(/[·—]/.test(JSON.stringify(vm))).toBe(false);
  });
});
