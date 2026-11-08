import { describe, expect, test } from "bun:test";
import type { BoardFacility, BoardStatus, FacilityState, Incident, PlanOption, Snapshot } from "@/lib/engine/types";
import {
  datasetLabel, detectionUnavailable, missingFacilities, overviewHeadline, overviewStats, pumpCountdown, readingStamp, savings, sumOrNull, systemRows,
} from "./overview";

const NOW = 1_791_646_200; // Saturday, October 10, 2026, 15:30 UTC
const ts = [NOW - 600, NOW - 300, NOW];

function facility(id: string, sys: string, over: Partial<FacilityState> = {}): FacilityState {
  return {
    id, systemId: sys, letter: id.slice(-1), lat: 0, lon: 0,
    tank: { id: "T", capacityBbl: 1000, levelPct: 50 },
    pump: { id: "P", status: 1, flowBpd: 10, maxFlowBpd: 100, dischargePsi: null, startLevelPct: 70, stopLevelPct: 30 },
    pipeline: { id: "L", receiveFlowBpd: null, pressurePsi: null },
    inflowBpd: 10, wells: [], fillPctPerHour: null, revenuePerHour: 0, health: "ok",
    dataQuality: { quality: "VALID", reasons: [] }, incidentIds: [],
    series: { level: { t: ts, v: [50, 50, 50] }, inflow: { t: ts, v: [10, 10, 10] }, pumpFlow: { t: ts, v: [10, 10, 10] }, receiveFlow: { t: ts, v: [10, 10, 10] } },
    ...over,
  };
}
const plan = (cost: number, kind: PlanOption["kind"] = "trucks"): PlanOption => ({ kind, label: "Send 1 truck now", cost, trucks: 1, tripsPerTruck: 1, truckArrivalsMin: [], shutIns: [], tankTrips: false, tripAtMin: null, levelCurve: [] });
function pump(id: string, sys: string, hours: number | null, cost: number | null, idle: number | null = 9000, extra: Partial<Incident> = {}): Incident {
  return {
    id, category: "pump_failure", status: "ongoing", systemId: sys, facilityId: `${sys}_FACILITY_${id}`, assetId: `${sys}_PUMP_${id}`,
    onsetUnix: NOW - 3600, endUnix: null, confidence: 1, evidence: [],
    hoursToLimit: hours == null ? null : { p10: hours - 0.3, p50: hours, p90: hours + 0.5 },
    plan: cost == null ? undefined : plan(cost),
    options: idle == null ? [] : [plan(idle, "do_nothing")],
    ...extra,
  };
}
const leak = (id: string, sys = "S1"): Incident => ({ id, category: "pipeline_leak", status: "ongoing", systemId: sys, facilityId: `${sys}_FACILITY_${id}`, assetId: `${sys}_PIPELINE_${id}`, onsetUnix: NOW - 100, endUnix: null, confidence: 0.9, evidence: [], estLeakBblPerDay: 120 });

function snap(over: Partial<Snapshot> = {}, systems?: Snapshot["systems"]): Snapshot {
  const sys = (id: string, n: number, fleet: number) => ({
    id, center: [0, 0] as [number, number], truckYard: [0, 0] as [number, number], disposal: { id: "D", lat: 0, lon: 0, pressurePsi: 0 }, fleetSize: fleet,
    facilities: Array.from({ length: n }, (_, i) => facility(`${id}_FACILITY_${"ABCDEF"[i]}`, id, {})),
  });
  return {
    runId: "r", dataset: { id: "d", label: "Snapshot · Sat Oct 10, 15:30", startUnix: NOW - 86400, nowUnix: NOW },
    limits: { warningPct: 80, shutdownPct: 95 }, nowUnix: NOW,
    systems: systems ?? [sys("S1", 3, 2), sys("S2", 2, 1)],
    alerts: [], history: [], fleets: [{ systemId: "S1", size: 2, assignments: [] }, { systemId: "S2", size: 1, assignments: [] }],
    totals: { facilities: 5, atRisk: 0, revenueAtRiskPerHour: 0, planCost: 0 },
    ...over,
  };
}
// Incident ids must equal the facility letter used by pump(): facility S1_FACILITY_A has id "A".
const withHealth = (health: FacilityState["health"], quality: FacilityState["dataQuality"]["quality"] = "VALID") =>
  snap({}, [{ ...snap().systems[0], facilities: [facility("S1_FACILITY_A", "S1", { health, dataQuality: { quality, reasons: quality === "VALID" ? [] : ["Tank level not reported for 35 min"] } }), facility("S1_FACILITY_B", "S1", { health })] }]);

describe("overviewHeadline", () => {
  test("no failures and everything reporting", () => {
    expect(overviewHeadline(snap())).toBe("Every pump is running.");
  });
  test("one failure in one system", () => {
    expect(overviewHeadline(snap({ alerts: [pump("A", "S1", 2, 100)] }))).toBe("One pump in System 1 is down.");
  });
  test("two failures in one system share the fleet", () => {
    expect(overviewHeadline(snap({ alerts: [pump("A", "S1", 2, 100), pump("B", "S1", 3, 100)] }))).toBe("Two pumps in System 1 are down and share two trucks.");
  });
  test("a single-truck fleet and a zero-truck fleet", () => {
    expect(overviewHeadline(snap({ alerts: [pump("A", "S2", 2, 100), pump("B", "S2", 3, 100)] }))).toBe("Two pumps in System 2 are down and share one truck.");
    const none = snap({ alerts: [pump("A", "S2", 2, 100), pump("B", "S2", 3, 100)] });
    none.systems[1] = { ...none.systems[1], fleetSize: 0 };
    expect(overviewHeadline(none)).toBe("Two pumps in System 2 are down and have no emergency trucks.");
  });
  test("failures across systems", () => {
    expect(overviewHeadline(snap({ alerts: [pump("A", "S1", 2, 100), pump("B", "S2", 3, 100)] }))).toBe("Two pumps are down across two systems.");
  });
  test("inspections add a clause", () => {
    expect(overviewHeadline(snap({ alerts: [pump("A", "S1", 2, 100), leak("B")] }))).toBe("One pump in System 1 is down. One problem needs an inspector.");
    expect(overviewHeadline(snap({ alerts: [leak("A"), leak("B")] }))).toBe("Every pump is running. Two problems need an inspector.");
  });
  test("real missing data is reported as no recent readings", () => {
    const s = withHealth("ok", "DROPPED");
    expect(overviewHeadline(s)).toBe("No pumps are reported down. One facility has no recent readings.");
  });
  test("health unknown with VALID readings is NOT missing data", () => {
    const s = withHealth("unknown");
    expect(missingFacilities(s)).toHaveLength(0);
    expect(overviewHeadline(s)).toBe("Every pump is running.");
  });
  test("health no_data counts as missing", () => {
    expect(missingFacilities(withHealth("no_data"))).toHaveLength(2);
  });
});

describe("detectionUnavailable", () => {
  test("all facilities unknown and no model scores means unavailable", () => {
    expect(detectionUnavailable(withHealth("unknown"))).toBe(true);
  });
  test("any confirmed ok means the classifier ran", () => {
    expect(detectionUnavailable(withHealth("ok"))).toBe(false);
    expect(detectionUnavailable(snap())).toBe(false);
  });
  test("a classified leak means it ran", () => {
    expect(detectionUnavailable(snap({ ...withHealth("unknown"), alerts: [leak("A")] }))).toBe(false);
  });
  test("board scores mean it ran", () => {
    const bf = { facilityId: "S1_FACILITY_A", scores: { pipeline_leak: 0, pump_degradation: 0, pump_failure: 0, facility_shut_in: 0 } } as unknown as BoardFacility;
    const board: BoardStatus = { source: "live", provenance: "fpga", online: true, mode: "NORMAL", lastSeenUnix: NOW, weightsVersion: 1, autonomousSinceUnix: null, replayedAlerts: 0, facilities: [bf] };
    expect(detectionUnavailable({ ...withHealth("unknown"), board })).toBe(false);
    const empty = { ...board, facilities: [{ ...bf, scores: null }] };
    expect(detectionUnavailable({ ...withHealth("unknown"), board: empty })).toBe(true);
  });
  test("facilities that only have no_data are not 'detection off'", () => {
    expect(detectionUnavailable(withHealth("no_data"))).toBe(false);
  });
});

describe("sums", () => {
  test("unknown in any term makes the sum null, never 0", () => {
    expect(sumOrNull([100, null])).toBeNull();
    expect(sumOrNull([100, undefined])).toBeNull();
    expect(sumOrNull([100, 250])).toBe(350);
    expect(sumOrNull([])).toBe(0);
  });
  test("stats: unknown plan cost stays null, and ifNobodyActs too", () => {
    const s = snap({ alerts: [pump("A", "S1", 2, 100, 900), pump("B", "S1", 3, null, null)] });
    const st = overviewStats(s);
    expect(st.pumpsDown).toBe(2);
    expect(st.planCost).toBeNull();
    expect(st.ifNobodyActs).toBeNull();
  });
  test("stats: known sums and the earliest shutdown", () => {
    const s = snap({ alerts: [pump("A", "S1", 3, 100, 900), pump("B", "S1", 2, 50, 700)] });
    const st = overviewStats(s);
    expect(st.planCost).toBe(150);
    expect(st.ifNobodyActs).toBe(1600);
    expect(st.firstShutdown).toEqual({ kind: "clock", unix: NOW + 2 * 3600 });
  });
  test("stats: no failures is a known zero and no shutdown", () => {
    expect(overviewStats(snap())).toEqual({ pumpsDown: 0, firstShutdown: { kind: "none" }, planCost: 0, ifNobodyActs: 0 });
  });
  test("stats: unknown estimate reads unknown", () => {
    expect(overviewStats(snap({ alerts: [pump("A", "S1", null, 100)] })).firstShutdown).toEqual({ kind: "unknown" });
  });
});

describe("pump cards", () => {
  test("counting, repair first, shut in, not filling", () => {
    const s = snap();
    expect(pumpCountdown(pump("A", "S1", 2, 1), s)).toMatchObject({ kind: "counting", hours: 2 });
    expect(pumpCountdown(pump("A", "S1", 2, 1, 1, { repairEndsUnix: NOW + 3600 }), s).kind).toBe("repair_first");
    expect(pumpCountdown(pump("A", "S1", 0, 1), s).kind).toBe("shut_in");
    expect(pumpCountdown({ ...pump("A", "S1", 2, 1), countdown: { status: "not_filling", hours: null } } as Incident, s).kind).toBe("not_filling");
  });
  test("savings only when the plan beats doing nothing", () => {
    expect(savings(pump("A", "S1", 2, 100, 4834))).toBe(4734);
    expect(savings(pump("A", "S1", 2, 100, 50))).toBeNull();
    expect(savings(pump("A", "S1", 2, 100, null))).toBeNull();
  });
});

describe("formatting and rows", () => {
  test("reading stamp and dataset label", () => {
    expect(readingStamp(NOW)).toBe("Saturday, October 10, 15:30 UTC");
    expect(datasetLabel("Snapshot · Sat Oct 10, 15:30")).toBe("Snapshot, Sat Oct 10, 15:30");
  });
  test("system rows: status words and trucks free", () => {
    const s = snap({
      alerts: [pump("A", "S1", 2, 100)],
      fleets: [{ systemId: "S1", size: 2, assignments: [{ truck: 1, incidentId: "A", facilityId: "S1_FACILITY_A", fromUnix: NOW - 10, toUnix: NOW + 100, tripsArrivalUnix: [] }] }, { systemId: "S2", size: 1, assignments: [] }],
    });
    const rows = systemRows(s);
    expect(rows[0]).toMatchObject({ word: "Pump down", tone: "red", trucksFree: 1, fleetSize: 2, facilities: 3 });
    expect(rows[1]).toMatchObject({ word: "Running", tone: "ok", trucksFree: 1 });
  });
});
