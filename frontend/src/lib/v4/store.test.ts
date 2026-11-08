import { describe, expect, test } from "bun:test";
import type { Incident, Snapshot } from "@/lib/engine/types";
import { createPlayheadStore } from "./store";

const NOW = 1_000_000;
const H = 3600;
const pf = { id: "pf", category: "pump_failure", status: "ongoing", systemId: "S1", facilityId: "F", assetId: "P", onsetUnix: NOW - 600, endUnix: null, confidence: 1, evidence: [], repairEndsUnix: NOW + 2 * H } as Incident;
const snap = (alerts: Incident[]) => ({
  nowUnix: NOW, dataset: { id: "d", label: "d", startUnix: NOW - 86400, nowUnix: NOW }, systems: [], alerts, fleets: [],
}) as unknown as Pick<Snapshot, "nowUnix" | "dataset" | "systems" | "alerts" | "fleets">;

describe("playhead range", () => {
  test("a live snapshot with a pump failure lets t run to projectionEnd", () => {
    const st = createPlayheadStore(snap([pf]));
    st.actions.seek(NOW + 10 * H);
    expect(st.getState().t).toBe(NOW + 2 * H);
    st.actions.seek(NOW + H);
    expect(st.getState().t).toBe(NOW + H);
    st.actions.step(1);
    expect(st.getState().t).toBe(Math.round((NOW + H) / 300) * 300 + 300);
  });
  test("without a failure t is clamped to the dataset end", () => {
    const st = createPlayheadStore(snap([]));
    st.actions.seek(NOW + H);
    expect(st.getState().t).toBe(NOW);
  });
  test("play at the projection end loops to the window start", () => {
    const st = createPlayheadStore(snap([pf]));
    st.actions.seek(NOW + 2 * H);
    st.actions.play();
    expect(st.getState().t).toBeLessThanOrEqual(NOW); // no series in this fixture: window start = nowUnix
    expect(st.getState().playing).toBe(true);
    st.actions.pause();
  });
});
