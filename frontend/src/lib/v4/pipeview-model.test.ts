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
  test("flowing shows flow in the single label slot and flow motion", () => {
    const f = fac();
    const vm = lineViewAt(snap(f), f, NOW);
    expect(vm.status).toBe("flowing");
    expect(vm.motion).toBe("flow");
    expect(vm.slot).toBe("100 BPD");
    expect(vm.flowRatio).toBe(0.5);
  });
  test("idle: no motion, IDLE", () => {
    const f = fac({}, Array(8).fill(50), Array(8).fill(0));
    const vm = lineViewAt(snap(f), f, NOW);
    expect(vm.status).toBe("idle");
    expect(vm.motion).toBe("none");
    expect(vm.slot).toBe("IDLE");
  });
  test("pump down: red, no packets, countdown, unknown stays UNKNOWN", () => {
    const f = fac();
    const down = inc({ id: "i1", category: "pump_failure", hoursToLimit: { p10: 10, p50: 13.85, p90: 20 } });
    const vm = lineViewAt(snap(f, [down]), f, NOW);
    expect(vm.status).toBe("down");
    expect(vm.redOn).toBe(true);
    expect(vm.motion).toBe("none");
    expect(vm.stateText).toBe("SHUTDOWN 13:51");
    const unk = lineViewAt(snap(f, [inc({ id: "i2", category: "pump_failure", hoursToLimit: null })]), f, NOW);
    expect(unk.stateText).toBe("SHUTDOWN UNKNOWN");
  });
  test("leak and worn: hatch, inspect text, packets still move", () => {
    const f = fac();
    const leak = lineViewAt(snap(f, [inc({ id: "l", category: "pipeline_leak", estLeakBblPerDay: 120 })]), f, NOW);
    expect(leak.hatchPipe).toBe(true);
    expect(leak.motion).toBe("leak");
    expect(leak.stateText).toBe("INSPECT 120 BBL/D EST");
    expect(leak.slot.length).toBeLessThanOrEqual(20);
    const worn = lineViewAt(snap(f, [inc({ id: "w", category: "pump_degradation", capacityLossPct: 18 })]), f, NOW);
    expect(worn.hatchPump).toBe(true);
    expect(worn.motion).toBe("worn");
    expect(worn.stateText).toBe("INSPECT 18% CAP LOSS");
  });
  test("shut in: grey wells", () => {
    const f = fac();
    const vm = lineViewAt(snap(f, [inc({ id: "s", category: "facility_shut_in" })]), f, NOW);
    expect(vm.wellsGrey).toBe(true);
    expect(vm.stateText).toBe("SHUT IN");
  });
  test("missing data is never healthy: grain, NO DATA, no packets", () => {
    const f = fac({ dataQuality: { quality: "DROPPED", reasons: ["Tank level not reported for 35 min"] } }, Array(7).fill(50).concat([null]), Array(7).fill(100).concat([null]));
    const vm = lineViewAt(snap(f), f, NOW);
    expect(vm.status).toBe("nodata");
    expect(vm.q).toBe(3);
    expect(vm.motion).toBe("none");
    expect(vm.stateText).toBe("NO DATA");
    expect(vm.reasonText).toBe("TANK LEVEL NOT REPORTED FOR 35 MIN");
    expect(vm.tankText).toBe("UNKNOWN");
  });
  test("HELD data renders as grain level 1 with HELD text", () => {
    const f = fac({ dataQuality: { quality: "HELD", reasons: ["held"] } });
    const vm = lineViewAt(snap(f), f, NOW);
    expect(vm.q).toBe(1);
    expect(vm.stateText.startsWith("HELD")).toBe(true);
    expect(vm.motion).toBe("none");
  });
  test("board alarm is a display-only badge with text for the tooltip", () => {
    const f = fac();
    const board = { source: "live", provenance: "fpga", online: true, mode: "NORMAL", lastSeenUnix: NOW, weightsVersion: 4, autonomousSinceUnix: null, replayedAlerts: 0,
      facilities: [{ facilityId: f.id, updatedUnix: NOW, scores: null, overThreshold: [], source: "rule", sinceReset: 1, alarm: "e_stop", alarmState: "raised", alarmSinceUnix: NOW - 600, replayed: false, degradationTrend: null }] } as Snapshot["board"];
    const vm = lineViewAt(snap(f, [], board), f, NOW);
    expect(vm.alarm?.text).toBe("E-STOP (BOARD, DISPLAY ONLY)");
    expect(lineViewAt(snap(f, [], board), f, NOW - 1200).alarm).toBeNull();
  });
  test("strings never contain middle dots or em dashes", () => {
    const f = fac();
    const vm = lineViewAt(snap(f, [inc({ id: "l", category: "pipeline_leak" })]), f, NOW);
    expect(/[·—]/.test(JSON.stringify(vm))).toBe(false);
  });
});
