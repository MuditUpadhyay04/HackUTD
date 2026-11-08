import { describe, expect, test } from "bun:test";
import type { Incident, Snapshot } from "@/lib/engine/types";
import { diffCues, JUMP_STEPS, probeAt, type AudioProbe } from "./audio-events";

const NOW = 1_000_000;
const failure = (over: Partial<Incident> = {}): Incident => ({
  id: "F1", category: "pump_failure", status: "ongoing", systemId: "S1", facilityId: "S1_FACILITY_A", assetId: "S1_PUMP_A",
  onsetUnix: NOW - 3 * 3600, endUnix: null, confidence: 1, evidence: [], hoursToLimit: { p10: 1.5, p50: 2, p90: 3 }, ...over,
});
const snap = (alerts: Incident[]): Snapshot => ({ nowUnix: NOW, alerts, history: [], systems: [], fleets: [] } as unknown as Snapshot);
const probe = (step: number, failing: string[] = [], underHour: string[] = [], tripped: string[] = []): AudioProbe => ({ step, failing, underHour, tripped });

describe("probeAt", () => {
  const s = snap([failure()]);
  test("failure becomes active at onset", () => {
    expect(probeAt(s, NOW - 3 * 3600 - 1).failing).toEqual([]);
    expect(probeAt(s, NOW - 3 * 3600).failing).toEqual(["F1"]);
  });
  test("countdown under one hour uses p50 remaining", () => {
    expect(probeAt(s, NOW).underHour).toEqual([]); // 2 h left
    expect(probeAt(s, NOW + 3600 + 60).underHour).toEqual(["F1"]); // 59 min left
    expect(probeAt(s, NOW + 2 * 3600 + 60).underHour).toEqual([]); // shut, not "dropping below"
  });
  test("steps are 5 minutes", () => {
    expect(probeAt(s, 3000).step).toBe(10);
    expect(probeAt(s, 3299).step).toBe(10);
    expect(probeAt(s, 3300).step).toBe(11);
  });
});

describe("diffCues", () => {
  test("no cues without a previous probe or when paused", () => {
    expect(diffCues(null, probe(2), true)).toEqual({ tick: false, alert: false, trip: false });
    expect(diffCues(probe(1), probe(2, ["F1"]), false)).toEqual({ tick: false, alert: false, trip: false });
  });
  test("tick per step crossed while playing", () => {
    expect(diffCues(probe(1), probe(2), true)).toEqual({ tick: true, alert: false, trip: false });
    expect(diffCues(probe(2), probe(2), true)).toEqual({ tick: false, alert: false, trip: false });
  });
  test("alert when a failure becomes active or a countdown drops under 1 h", () => {
    expect(diffCues(probe(1), probe(2, ["F1"]), true)).toEqual({ tick: true, alert: true, trip: false });
    expect(diffCues(probe(1, ["F1"]), probe(1, ["F1"], ["F1"]), true)).toEqual({ tick: false, alert: true, trip: false });
    expect(diffCues(probe(1, ["F1"], ["F1"]), probe(2, ["F1"], ["F1"]), true).alert).toBe(false);
  });
  test("backwards moves and seeks are silent", () => {
    expect(diffCues(probe(5), probe(4, ["F1"]), true)).toEqual({ tick: false, alert: false, trip: false });
    expect(diffCues(probe(0), probe(JUMP_STEPS + 1, ["F1"]), true)).toEqual({ tick: false, alert: false, trip: false });
    expect(diffCues(probe(0), probe(JUMP_STEPS, ["F1"]), true).alert).toBe(true);
  });
});

describe("projected trip cue", () => {
  const curve = [{ min: 0, pct: 60 }, { min: 120, pct: 95 }];
  const plan = { kind: "do_nothing" as const, label: "", cost: 1, trucks: 0, tripsPerTruck: 0, truckArrivalsMin: [], shutIns: [], tankTrips: true, tripAtMin: 120, levelCurve: curve };
  const s = { ...snap([failure({ plan, options: [plan], repairEndsUnix: NOW + 4 * 3600 })]), limits: { warningPct: 80, shutdownPct: 95 }, dataset: { nowUnix: NOW } } as unknown as Snapshot;
  test("tripped only once the projected tank reaches the limit", () => {
    expect(probeAt(s, NOW + 3600).tripped).toEqual([]);
    expect(probeAt(s, NOW + 2 * 3600).tripped).toEqual(["F1"]);
    expect(probeAt(s, NOW - 60).tripped).toEqual([]);
  });
  test("trip cue fires on the transition during forward play", () => {
    const a = probeAt(s, NOW + 2 * 3600 - 300), b = probeAt(s, NOW + 2 * 3600);
    expect(diffCues(a, b, true).trip).toBe(true);
    expect(diffCues(b, b, true).trip).toBe(false);
    expect(diffCues(a, b, false).trip).toBe(false);
  });
});
