import { describe, expect, test } from "bun:test";
import type { FacilityState, Incident, Snapshot } from "@/lib/engine/types";
import { countdownAt, facilityAt, incidentsAt, lineColor, localWindow, sampleSeries, tickerAt, truckPositions } from "./derive";

const NOW = 1_000_000;
const ts = (n: number) => Array.from({ length: n }, (_, i) => NOW - (n - 1 - i) * 300);

function facility(id: string, level: (number | null)[], pump: (number | null)[], quality: "VALID" | "DROPPED" = "VALID"): FacilityState {
  const t = ts(level.length);
  return {
    id, systemId: "S1", letter: id.slice(-1), lat: 0, lon: 0,
    tank: { id: "T", capacityBbl: 1000, levelPct: level[level.length - 1] },
    pump: { id: "P", status: 1, flowBpd: pump[pump.length - 1], maxFlowBpd: 100, dischargePsi: null, startLevelPct: 70, stopLevelPct: 30 },
    pipeline: { id: "L", receiveFlowBpd: null, pressurePsi: null },
    inflowBpd: 10, wells: [], fillPctPerHour: null, revenuePerHour: 0, health: "ok",
    dataQuality: { quality, reasons: [] }, incidentIds: [],
    series: { level: { t, v: level }, inflow: { t, v: level.map(() => 10) }, pumpFlow: { t, v: pump }, receiveFlow: { t, v: pump } },
  };
}
const incident = (p: Partial<Incident> & Pick<Incident, "id" | "category">): Incident => ({
  status: "ongoing", systemId: "S1", facilityId: "S1_FACILITY_A", assetId: "S1_PUMP_A", onsetUnix: NOW - 3600, endUnix: null, confidence: 1, evidence: [], ...p,
});
function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    runId: "r", dataset: { id: "d", label: "d", startUnix: NOW - 86400, nowUnix: NOW },
    limits: { warningPct: 80, shutdownPct: 95 }, nowUnix: NOW,
    systems: [{ id: "S1", center: [0, 0], truckYard: [0, 0], disposal: { id: "D", lat: 0, lon: 0, pressurePsi: 0 }, fleetSize: 2,
      facilities: [facility("S1_FACILITY_A", [50, 51, 52, 53], [10, 10, 10, 10]), facility("S1_FACILITY_B", [50, null, null, null], [10, null, null, null], "DROPPED")] }],
    alerts: [], history: [], fleets: [{ systemId: "S1", size: 2, assignments: [] }],
    totals: { facilities: 2, atRisk: 0, revenueAtRiskPerHour: 0, planCost: 0 },
    ...over,
  };
}

describe("sampleSeries", () => {
  const s = { t: [0, 300, 600, 1200], v: [0, 10, null, 30] as (number | null)[] };
  test("step holds the last sample and linear interpolates", () => {
    expect(sampleSeries(s, 450, "step")).toBe(10);
    expect(sampleSeries(s, 150, "linear")).toBe(5);
    expect(sampleSeries(s, 300, "linear")).toBe(10);
  });
  test("null stays null, never 0", () => {
    expect(sampleSeries(s, 600, "step")).toBeNull();
    expect(sampleSeries(s, 450, "linear")).toBeNull(); // next neighbour is null
    expect(sampleSeries(s, 700, "step")).toBeNull();
  });
  test("before the first sample and after a long gap is null", () => {
    expect(sampleSeries(s, -1)).toBeNull();
    expect(sampleSeries({ t: [0, 300], v: [1, 2] }, 5000)).toBeNull();
    expect(sampleSeries({ t: [], v: [] }, 0)).toBeNull();
  });
});

describe("localWindow", () => {
  test("starts at the earliest series sample and ends at nowUnix", () => {
    expect(localWindow(snap())).toEqual({ start: NOW - 900, end: NOW });
  });
});

describe("facilityAt: missing data is never healthy", () => {
  test("healthy facility flows", () => {
    const s = snap();
    expect(facilityAt(s, s.systems[0].facilities[0], NOW).status).toBe("flowing");
  });
  test("null series reads nodata with null numbers", () => {
    const s = snap();
    const r = facilityAt(s, s.systems[0].facilities[1], NOW);
    expect(r.status).toBe("nodata");
    expect(r.levelPct).toBeNull();
    expect(r.pumpFlowBpd).toBeNull();
    expect(r.quality).toBe("DROPPED");
  });
  test("zero pump flow is idle, null pump flow is not", () => {
    const s = snap({ systems: [{ ...snap().systems[0], facilities: [facility("S1_FACILITY_A", [50, 50], [0, null])] }] });
    expect(facilityAt(s, s.systems[0].facilities[0], NOW).status).toBe("nodata");
    const s2 = snap({ systems: [{ ...snap().systems[0], facilities: [facility("S1_FACILITY_A", [50, 50], [0, 0])] }] });
    expect(facilityAt(s2, s2.systems[0].facilities[0], NOW).status).toBe("idle");
  });
  test("incident states win and shut-in follows the limit", () => {
    const pf = incident({ id: "pf", category: "pump_failure", onsetUnix: NOW - 450 });
    const s = snap({ alerts: [pf] });
    expect(facilityAt(s, s.systems[0].facilities[0], NOW).status).toBe("down");
    expect(facilityAt(s, s.systems[0].facilities[0], NOW - 600).status).toBe("flowing"); // before onset
    const full = snap({ alerts: [pf], systems: [{ ...snap().systems[0], facilities: [facility("S1_FACILITY_A", [96, 96], [0, 0])] }] });
    expect(facilityAt(full, full.systems[0].facilities[0], NOW).status).toBe("shut");
    const leak = snap({ alerts: [incident({ id: "lk", category: "pipeline_leak" })] });
    expect(facilityAt(leak, leak.systems[0].facilities[0], NOW).status).toBe("leak");
  });
});

describe("incidentsAt ordering (hard rule 7)", () => {
  test("pump failures first, soonest shutdown first, then revenue, then others", () => {
    const s = snap({
      alerts: [
        incident({ id: "leak", category: "pipeline_leak" }),
        incident({ id: "late", category: "pump_failure", hoursToLimit: { p10: 4, p50: 5, p90: 6 }, lostRevenuePerHour: 10 }),
        incident({ id: "tieLow", category: "pump_failure", hoursToLimit: { p10: 1, p50: 2, p90: 3 }, lostRevenuePerHour: 5 }),
        incident({ id: "tieHigh", category: "pump_failure", hoursToLimit: { p10: 1, p50: 2, p90: 3 }, lostRevenuePerHour: 50 }),
        incident({ id: "unk", category: "pump_failure", hoursToLimit: null }),
        incident({ id: "worn", category: "pump_degradation" }),
      ],
      history: [incident({ id: "old", category: "pump_failure", status: "resolved", onsetUnix: NOW - 9000, endUnix: NOW - 8000 })],
    });
    expect(incidentsAt(s, NOW).map((i) => i.id)).toEqual(["tieHigh", "tieLow", "late", "unk", "leak", "worn"]);
    expect(incidentsAt(s, NOW - 8500).map((i) => i.id)).toEqual(["old"]);
  });
});

describe("countdownAt", () => {
  const pf = incident({ id: "pf", category: "pump_failure", hoursToLimit: { p10: 1, p50: 2, p90: 4 } });
  test("shifts from snapshot.nowUnix", () => {
    const s = snap({ alerts: [pf] });
    expect(countdownAt(pf, s, NOW).remainingHours).toEqual({ p10: 1, p50: 2, p90: 4 });
    expect(countdownAt(pf, s, NOW - 1800).remainingHours?.p50).toBe(2.5);
    const late = countdownAt(pf, s, NOW + 3600); // 1h into the future
    expect(late.kind).toBe("counting");
    expect(late.remainingHours?.p50).toBe(1);
    expect(countdownAt(pf, s, NOW + 7200).kind).toBe("shut");
  });
  test("unknown stays unknown, other categories have none", () => {
    const s = snap();
    expect(countdownAt(incident({ id: "x", category: "pump_failure", hoursToLimit: null }), s, NOW).kind).toBe("unknown");
    expect(countdownAt(incident({ id: "y", category: "pipeline_leak" }), s, NOW).kind).toBe("none");
    expect(countdownAt(pf, s, NOW - 7200).kind).toBe("none"); // before onset
  });
});

describe("truckPositions", () => {
  // call at NOW, first arrival +30 min, second +90 min, free at +120 min. T = 30 min.
  const call = NOW;
  const a1 = call + 1800, a2 = call + 5400, free = call + 7200;
  const pf = incident({
    id: "pf", category: "pump_failure", onsetUnix: call - 600,
    plan: { kind: "trucks", label: "x", cost: 1, trucks: 1, tripsPerTruck: 2, truckArrivalsMin: [30, 90], shutIns: [], tankTrips: false, tripAtMin: null, levelCurve: [] },
  });
  const s = snap({
    alerts: [pf],
    fleets: [{ systemId: "S1", size: 2, assignments: [{ truck: 1, incidentId: "pf", facilityId: "S1_FACILITY_A", fromUnix: call, toUnix: free, tripsArrivalUnix: [a1, a2] }] }],
  });
  const at = (t: number, approved: string[] = []) => truckPositions(s, "S1", t, approved).find((x) => x.truck === 1)!;
  test("every fleet truck is returned; unassigned trucks idle at the yard", () => {
    const all = truckPositions(s, "S1", NOW, []);
    expect(all.length).toBe(2);
    expect(all[1]).toMatchObject({ truck: 2, phase: "yard", incidentId: null, planned: false });
  });
  test("phases follow the schedule", () => {
    expect(at(call - 100).phase).toBe("yard");
    expect(at(call + 900)).toMatchObject({ phase: "outbound", progress: 0.5 });
    expect(at(a1)).toMatchObject({ phase: "unloading", progress: 1 });
    expect(at(a1 + 100).phase).toBe("unloading");
    const back = at(a1 + 1500);
    expect(back.phase).toBe("returning");
    expect(back.progress).toBeLessThan(1);
    expect(back.progress).toBeGreaterThan(0);
    expect(at(a2 - 900).phase).toBe("outbound"); // second trip
    expect(at(a2 + 60).phase).toBe("unloading");
    expect(at(free + 10).phase).toBe("yard");
  });
  test("ghost until approved (incident id or plan id)", () => {
    expect(at(a1).planned).toBe(true);
    expect(at(a1, ["pf"]).planned).toBe(false);
  });
  test("falls back to plan.truckArrivalsMin when tripsArrivalUnix is empty", () => {
    const s2 = snap({ alerts: [pf], fleets: [{ systemId: "S1", size: 1, assignments: [{ truck: 1, incidentId: "pf", facilityId: "x", fromUnix: call, toUnix: free, tripsArrivalUnix: [] }] }] });
    expect(truckPositions(s2, "S1", call + 900, [])[0].phase).toBe("outbound");
  });
});

describe("tickerAt", () => {
  test("unknowns are null, never 0", () => {
    const s = snap({ alerts: [incident({ id: "pf", category: "pump_failure", hoursToLimit: null })] });
    const m = Object.fromEntries(tickerAt(s, NOW).map((i) => [i.key, i.value]));
    expect(m.pumpsDown).toBe(1);
    expect(m.firstShutdown).toBeNull();
    expect(m.plan).toBeNull();
    expect(m.ifNobodyActs).toBeNull();
    expect(m.noData).toBe(1);
    expect(m.alarms).toBeNull(); // local mode: no board status
    expect(m.trucksFree).toBe("2/2");
  });
  test("known values", () => {
    const plan = { kind: "trucks" as const, label: "", cost: 400, trucks: 1, tripsPerTruck: 1, truckArrivalsMin: [], shutIns: [], tankTrips: false, tripAtMin: null, levelCurve: [] };
    const s = snap({ alerts: [incident({ id: "pf", category: "pump_failure", hoursToLimit: { p10: 1, p50: 2, p90: 3 }, plan, options: [plan, { ...plan, kind: "do_nothing", cost: 9000 }] })] });
    const m = Object.fromEntries(tickerAt(s, NOW).map((i) => [i.key, i.value]));
    expect(m.firstShutdown).toBe(NOW + 7200);
    expect(m.plan).toBe(400);
    expect(m.ifNobodyActs).toBe(9000);
  });
});

test("lineColor cycles n1..n8", () => {
  expect(lineColor(0)).toBe("var(--n1)");
  expect(lineColor(7)).toBe("var(--n8)");
  expect(lineColor(8)).toBe("var(--n1)");
  expect(lineColor(-1)).toBe("var(--n8)");
});
