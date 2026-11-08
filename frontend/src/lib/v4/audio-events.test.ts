import { describe, expect, test } from "bun:test";
import type { Incident, Snapshot } from "@/lib/engine/types";
import { diffCues, JUMP_STEPS, probeAt, type AudioProbe } from "./audio-events";

const NOW = 1_000_000;
const failure = (over: Partial<Incident> = {}): Incident => ({
  id: "F1", category: "pump_failure", status: "ongoing", systemId: "S1", facilityId: "S1_FACILITY_A", assetId: "S1_PUMP_A",
  onsetUnix: NOW - 3 * 3600, endUnix: null, confidence: 1, evidence: [], hoursToLimit: { p10: 1.5, p50: 2, p90: 3 }, ...over,
});
const snap = (alerts: Incident[]): Snapshot => ({ nowUnix: NOW, alerts, history: [], systems: [], fleets: [] } as unknown as Snapshot);
const probe = (step: number, failing: string[] = [], underHour: string[] = []): AudioProbe => ({ step, failing, underHour });

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
    expect(diffCues(null, probe(2), true)).toEqual({ tick: false, alert: false });
    expect(diffCues(probe(1), probe(2, ["F1"]), false)).toEqual({ tick: false, alert: false });
  });
  test("tick per step crossed while playing", () => {
    expect(diffCues(probe(1), probe(2), true)).toEqual({ tick: true, alert: false });
    expect(diffCues(probe(2), probe(2), true)).toEqual({ tick: false, alert: false });
  });
  test("alert when a failure becomes active or a countdown drops under 1 h", () => {
    expect(diffCues(probe(1), probe(2, ["F1"]), true)).toEqual({ tick: true, alert: true });
    expect(diffCues(probe(1, ["F1"]), probe(1, ["F1"], ["F1"]), true)).toEqual({ tick: false, alert: true });
    expect(diffCues(probe(1, ["F1"], ["F1"]), probe(2, ["F1"], ["F1"]), true).alert).toBe(false);
  });
  test("backwards moves and seeks are silent", () => {
    expect(diffCues(probe(5), probe(4, ["F1"]), true)).toEqual({ tick: false, alert: false });
    expect(diffCues(probe(0), probe(JUMP_STEPS + 1, ["F1"]), true)).toEqual({ tick: false, alert: false });
    expect(diffCues(probe(0), probe(JUMP_STEPS, ["F1"]), true).alert).toBe(true);
  });
});
