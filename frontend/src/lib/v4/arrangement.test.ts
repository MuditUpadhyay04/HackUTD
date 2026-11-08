import { describe, expect, test } from "bun:test";
import type { FacilityState, Incident, PlanOption, Snapshot } from "@/lib/engine/types";
import { clampView, gridTicks, panView, timeToX, xToTime, zoomView } from "./arrangement-scale";
import { curvePath, seriesGaps, seriesPath } from "./arrangement-paths";
import { facilityClips, mergeGaps } from "./arrangement-clips";
import { incidentFacilityIds, ongoingFailures, orderedFacilities, orderTakes, splitTakes, timeDomain, unloadedRegions } from "./arrangement-takes";
import { notesFromAnalysis, provenanceOf, sentenceCase, stackNotes } from "./arrangement-notes";

const NOW = 1_000_000;
const STEP = 300;

describe("scale", () => {
  const view = { t0: 1000, t1: 2000 };
  test("time and x round trip", () => {
    expect(timeToX(view, 500, 1500)).toBe(250);
    expect(xToTime(view, 500, 250)).toBe(1500);
  });
  test("zoom keeps the anchor fixed and stays in bounds", () => {
    const b = { start: 0, end: 10_000 };
    const v = zoomView({ t0: 1000, t1: 5000 }, b, 3000, 2);
    expect(v.t1 - v.t0).toBe(2000);
    expect(timeToX(v, 800, 3000)).toBeCloseTo(timeToX({ t0: 1000, t1: 5000 }, 800, 3000), 6);
    const out = zoomView(v, b, 3000, 0.0001);
    expect(out).toEqual({ t0: 0, t1: 10_000 });
  });
  test("pan clamps", () => {
    const b = { start: 0, end: 10_000 };
    expect(panView({ t0: 100, t1: 1100 }, b, -500)).toEqual({ t0: 0, t1: 1000 });
    expect(panView({ t0: 8900, t1: 9900 }, b, 5000)).toEqual({ t0: 9000, t1: 10_000 });
    expect(clampView({ t0: -5, t1: 5 }, b).t0).toBe(0);
  });
  test("ticks: hourly with stronger 6h and day lines", () => {
    const day = 1_000_000 - (1_000_000 % 86400);
    const t = gridTicks({ t0: day, t1: day + 86400 }, 1200);
    expect(t.filter((x) => x.kind === "day").length).toBe(2);
    expect(t.filter((x) => x.kind === "six").length).toBe(3);
    expect(t.filter((x) => x.kind === "hour").length).toBe(24 + 1 - 5);
    const far = gridTicks({ t0: day, t1: day + 86400 * 20 }, 600);
    expect(far.every((x) => x.kind === "day")).toBe(true);
  });
});

describe("paths", () => {
  const t = [0, 300, 600, 900, 1200, 1500];
  const win = { start: 0, end: 1500 };
  test("null samples break the path and are reported as gaps, never bridged or zero", () => {
    const s = { t, v: [10, 20, null, null, 50, 60] };
    const { d, gaps } = seriesPath(s, { base: 0, max: 100, window: win });
    expect(d.match(/M/g)?.length).toBe(2);
    expect(d).toBe("M0 90L300 80M1200 50L1500 40");
    expect(gaps).toEqual([{ t0: 300, t1: 1200 }]);
    // nothing is drawn at x in (300, 1200)
    const xs = [...d.matchAll(/[ML](\d+(?:\.\d+)?) /g)].map((m) => Number(m[1]));
    expect(xs.some((x) => x > 300 && x < 1200)).toBe(false);
  });
  test("lone sample gets a visible stub; all-null series is one full gap and empty path", () => {
    expect(seriesPath({ t, v: [null, 5, null, null, null, null] }, { base: 0, max: 10, window: win }).d).toBe("M300 50L301 50");
    const none = seriesPath({ t, v: t.map(() => null) }, { base: 0, max: 10, window: win });
    expect(none.d).toBe("");
    expect(none.gaps).toEqual([{ t0: 0, t1: 1500 }]);
  });
  test("long hold between valid samples is a gap even without nulls", () => {
    const s = { t: [0, 300, 600, 5000, 5300], v: [1, 1, 1, 1, 1] };
    const r = seriesPath(s, { base: 0, max: 2, window: { start: 0, end: 5300 } });
    expect(r.d.match(/M/g)?.length).toBe(2);
    expect(r.gaps).toEqual([{ t0: 600, t1: 5000 }]);
  });
  test("leading and trailing missing data become gaps", () => {
    const g = seriesGaps({ t: [3000, 3300], v: [1, 1] }, { start: 0, end: 9000 });
    expect(g).toEqual([{ t0: 0, t1: 3000 }, { t0: 3300, t1: 9000 }]);
  });
  test("curve path in plan time, clamped, non-finite breaks", () => {
    expect(curvePath([{ min: 0, pct: 50 }, { min: 10, pct: 120 }], 1000, 400)).toBe("M600 50L1200 0");
    expect(curvePath([{ min: 0, pct: 1 }, { min: 1, pct: NaN }, { min: 2, pct: 3 }], 0, 0)).toBe("M0 99M120 97");
  });
});

function fac(id: string, level: (number | null)[], pump: (number | null)[], quality: "VALID" | "DROPPED" = "VALID"): FacilityState {
  const t = level.map((_, i) => NOW - (level.length - 1 - i) * STEP);
  return {
    id, systemId: "S1", letter: id.slice(-1), lat: 0, lon: 0,
    tank: { id: "T", capacityBbl: 1000, levelPct: level[level.length - 1] },
    pump: { id: "P", status: 1, flowBpd: null, maxFlowBpd: 100, dischargePsi: null, startLevelPct: 70, stopLevelPct: 30 },
    pipeline: { id: "L", receiveFlowBpd: null, pressurePsi: null },
    inflowBpd: 10, wells: [], fillPctPerHour: null, revenuePerHour: 0, health: "ok",
    dataQuality: { quality, reasons: [] }, incidentIds: [],
    series: { level: { t, v: level }, inflow: { t, v: level.map(() => 1) }, pumpFlow: { t, v: pump }, receiveFlow: { t, v: pump } },
  };
}
const opt = (kind: PlanOption["kind"], cost: number): PlanOption => ({ kind, label: kind, cost, trucks: 0, tripsPerTruck: 0, truckArrivalsMin: [], shutIns: [], tankTrips: false, tripAtMin: null, levelCurve: [{ min: 0, pct: 50 }, { min: 600, pct: 60 }] });
const inc = (p: Partial<Incident> & Pick<Incident, "id" | "category">): Incident => ({ status: "ongoing", systemId: "S1", facilityId: "S1_FACILITY_A", assetId: "P", onsetUnix: NOW - 3600, endUnix: null, confidence: 1, evidence: [], ...p });
function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    runId: "r", dataset: { id: "d", label: "d", startUnix: NOW - 7 * 86400, nowUnix: NOW }, limits: { warningPct: 80, shutdownPct: 95 }, nowUnix: NOW,
    systems: [{ id: "S1", center: [0, 0], truckYard: [0, 0], disposal: { id: "D", lat: 0, lon: 0, pressurePsi: 0 }, fleetSize: 1,
      facilities: [fac("S1_FACILITY_A", [10, 20, 30, 40], [1, 1, 1, 1]), fac("S1_FACILITY_B", [10, null, null, 40], [1, null, null, 1]), fac("S1_FACILITY_C", [10, 20, 30, 40], [1, 1, 1, 1])] }],
    alerts: [], history: [], fleets: [], totals: { facilities: 3, atRisk: 0, revenueAtRiskPerHour: 0, planCost: 0 }, ...over,
  };
}

describe("clips", () => {
  test("clips per facility: incidents spans and no-data spans only for the right facility", () => {
    const alerts = [inc({ id: "a", category: "pump_failure", facilityId: "S1_FACILITY_A" }), inc({ id: "l", category: "pipeline_leak", facilityId: "S1_FACILITY_C", onsetUnix: NOW - 1800 })];
    const history = [inc({ id: "h", category: "pump_degradation", facilityId: "S1_FACILITY_A", status: "resolved", onsetUnix: NOW - 7200, endUnix: NOW - 5400 })];
    const s = snap({ alerts, history });
    const win = { start: NOW - 3 * STEP, end: NOW };
    const a = facilityClips(s, s.systems[0].facilities[0], win);
    expect(a.map((c) => [c.kind, c.start, c.end])).toEqual([["degradation", NOW - 7200, NOW - 5400], ["pump_failure", NOW - 3600, NOW]]);
    const b = facilityClips(s, s.systems[0].facilities[1], win);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ kind: "nodata", start: NOW - 3 * STEP, end: NOW });
    const c = facilityClips(s, s.systems[0].facilities[2], win);
    expect(c.map((x) => x.kind)).toEqual(["leak"]);
  });
  test("merge gaps", () => {
    expect(mergeGaps([{ t0: 5, t1: 9 }, { t0: 1, t1: 6 }, { t0: 20, t1: 30 }])).toEqual([{ t0: 1, t1: 9 }, { t0: 20, t1: 30 }]);
  });
  test("reported DROPPED quality at now adds a final no-data clip", () => {
    const s = snap();
    s.systems[0].facilities[0].dataQuality.quality = "DROPPED";
    const clips = facilityClips(s, s.systems[0].facilities[0], { start: NOW - 3 * STEP, end: NOW });
    expect(clips.some((c) => c.kind === "nodata" && c.end === NOW)).toBe(true);
  });
});

describe("takes and ordering", () => {
  test("cheapest first, missing cost last, stable", () => {
    const o = orderTakes([opt("trucks", 500), { ...opt("shut_in", NaN) }, opt("do_nothing", 900), opt("mixed", 500)]);
    expect(o.map((x) => x.kind)).toEqual(["trucks", "mixed", "do_nothing", "shut_in"]);
  });
  test("failures follow rule 7 and facilities with failures come first", () => {
    const a = inc({ id: "a", category: "pump_failure", facilityId: "S1_FACILITY_A", hoursToLimit: { p10: 9, p50: 10, p90: 11 }, lostRevenuePerHour: 1 });
    const c = inc({ id: "c", category: "pump_failure", facilityId: "S1_FACILITY_C", hoursToLimit: { p10: 2, p50: 3, p90: 4 }, lostRevenuePerHour: 1 });
    const s = snap({ alerts: [a, c] });
    const f = ongoingFailures(s);
    expect(f.map((i) => i.id)).toEqual(["c", "a"]);
    expect(orderedFacilities(s.systems[0], f).map((e) => [e.facility.letter, e.index])).toEqual([["C", 2], ["A", 0], ["B", 1]]);
  });
  test("domain extends over the projection and regions are reported", () => {
    const f = inc({ id: "a", category: "pump_failure", options: [opt("do_nothing", 1)] });
    const s = snap({ alerts: [f] });
    expect(timeDomain(s).end).toBe(NOW + 600 * 60);
    const r = unloadedRegions(s);
    expect(r.map((x) => x.kind)).toEqual(["notloaded", "projected"]);
    expect(r[0].end).toBe(NOW - 3 * STEP);
    expect(r[1]).toEqual({ start: NOW, end: NOW + 36000, kind: "projected" });
  });
});

describe("notes", () => {
  const base = { id: "x", runId: "r", inputRevision: 1, steps: [{ agent: "Planner", model: "m", text: "step" }], handoff: "hello", evidenceIds: [], planIds: [], error: null, createdAt: "" };
  test("provenance", () => {
    expect(provenanceOf({ source: "nemotron", state: "completed" })).toBe("MODEL-WRITTEN");
    expect(provenanceOf({ source: "draft", state: "completed" })).toBe("DETERMINISTIC DRAFT");
    expect(provenanceOf({ source: "ai-sdk", state: "completed" })).toBe("DETERMINISTIC DRAFT");
    expect(provenanceOf({ source: "ai-sdk", model: "m", state: "completed" })).toBe("MODEL-WRITTEN");
    expect(provenanceOf({ source: "nemotron", state: "running" })).toBe("DETERMINISTIC DRAFT");
  });
  test("notes pinned at now and nothing before completion", () => {
    expect(notesFromAnalysis({ ...base, state: "running", source: "nemotron" }, NOW)).toEqual([]);
    const n = notesFromAnalysis({ ...base, state: "completed", source: "draft" }, NOW);
    expect(n.map((x) => x.unix)).toEqual([NOW, NOW]);
    expect(n[0].provenance).toBe("DETERMINISTIC DRAFT");
  });
  test("stacking never overlaps and overflow is hidden", () => {
    const items = [{ unix: 0 }, { unix: 1 }, { unix: 2 }, { unix: 500 }];
    const { placed, hidden } = stackNotes(items, (i) => i.unix, () => 100, 2);
    expect(placed.map((p) => p.row)).toEqual([0, 1, 0]);
    expect(hidden).toHaveLength(1);
    expect(placed.find((p) => p.item.unix === 500)?.row).toBe(0);
  });
});

describe("softened disclosure helpers", () => {
  test("splitTakes shows only the recommended take, every other option (do nothing too) behind Show options", () => {
    const takes = [opt("trucks", 1), opt("shut_in", 2), opt("do_nothing", 3), opt("mixed", 4)];
    const { shown, rest } = splitTakes(takes);
    expect(shown.map((t) => [t.index, t.option.kind])).toEqual([[0, "trucks"]]);
    expect(rest.map((t) => t.option.kind)).toEqual(["shut_in", "do_nothing", "mixed"]);
    expect(splitTakes([opt("do_nothing", 1), opt("trucks", 2)]).rest).toHaveLength(1);
    expect(splitTakes([]).shown).toEqual([]);
  });
  test("incidentFacilityIds keeps facilities with an incident in the window and drops the rest", () => {
    const snap = { nowUnix: NOW, alerts: [{ id: "a", facilityId: "F1", onsetUnix: NOW - 600, endUnix: null, category: "pump_failure", status: "ongoing" }], history: [
      { id: "h1", facilityId: "F2", onsetUnix: NOW - 5000, endUnix: NOW - 4000 },
      { id: "h2", facilityId: "F3", onsetUnix: NOW - 90_000, endUnix: NOW - 80_000 },
    ] } as unknown as Snapshot;
    const ids = incidentFacilityIds(snap, { start: NOW - 10_000, end: NOW }, []);
    expect([...ids].sort()).toEqual(["F1", "F2"]);
  });
  test("sentenceCase", () => {
    expect(sentenceCase("PLANNER_AGENT")).toBe("Planner agent");
    expect(sentenceCase("handoff")).toBe("Handoff");
  });
});
