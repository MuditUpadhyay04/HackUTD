import { describe, expect, test } from "bun:test";
import type { Incident, Snapshot } from "@/lib/engine/types";
import { AUTOPLAY_LOOP_SECONDS, autoplayLoop, createPlayheadStore } from "./store";

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

describe("auto-play showcase loop", () => {
  const withSeries = (alerts: Incident[], startAgo = 24 * H) => {
    const series = { t: [NOW - startAgo, NOW], v: [1, 2] };
    const facility = { id: "F", series: { level: series, inflow: series, pumpFlow: series, receiveFlow: series } };
    return { ...snap(alerts), systems: [{ id: "S1", facilities: [facility] }] } as unknown as Pick<Snapshot, "nowUnix" | "dataset" | "systems" | "alerts" | "fleets">;
  };
  const opts = { reducedMotion: false };

  test("loop runs from now - 12 h to the projection end, sized to about 25 s", () => {
    const loop = autoplayLoop(withSeries([pf]));
    expect(loop).not.toBeNull();
    expect(loop!.start).toBe(NOW - 12 * H);
    expect(loop!.end).toBe(NOW + 2 * H);
    expect(loop!.projection).toBe(true);
    expect((loop!.end - loop!.start) / loop!.rate).toBeCloseTo(AUTOPLAY_LOOP_SECONDS, 6);
  });
  test("without a projection the loop ends at now; a short window starts at the window start", () => {
    const calm = autoplayLoop(withSeries([]));
    expect(calm).toMatchObject({ start: NOW - 12 * H, end: NOW, projection: false });
    expect(autoplayLoop(withSeries([], 3 * H))!.start).toBe(NOW - 3 * H);
    expect(autoplayLoop(snap([]))).toBeNull(); // no series: nothing to replay
  });
  test("startAutoplay jumps to the start, plays, and the playhead wraps seamlessly at the end", () => {
    const st = createPlayheadStore(withSeries([pf]), opts);
    expect(st.actions.startAutoplay()).toBe(true);
    const loop = st.getState().autoplay!;
    expect(st.getState()).toMatchObject({ t: loop.start, playing: true });
    st.advance(10);
    expect(st.getState().t).toBeCloseTo(loop.start + 10 * loop.rate, 6);
    st.advance(10);
    st.advance(10); // 30 s of real time = 5 s past the end: wraps to start + 5 s
    expect(st.getState().t).toBeCloseTo(loop.start + 5 * loop.rate, 6);
    expect(st.getState().t).toBeGreaterThanOrEqual(loop.start);
    expect(st.getState().t).toBeLessThan(loop.end);
    expect(st.getState().autoplay).not.toBeNull();
  });
  test("reduced motion never auto-plays", () => {
    const st = createPlayheadStore(withSeries([pf]), { reducedMotion: true });
    expect(st.actions.startAutoplay()).toBe(false);
    expect(st.getState().autoplay).toBeNull();
    expect(st.getState().t).toBe(NOW);
    expect(st.getState().playing).toBe(false);
  });
  test("any user time action stops auto-play and leaves the playhead paused where it is", () => {
    const acts: [string, (a: ReturnType<typeof createPlayheadStore>["actions"]) => void][] = [
      ["pause", (a) => a.pause()],
      ["toggle", (a) => a.toggle()],
      ["stopAutoplay", (a) => a.stopAutoplay()],
      ["setSpeed", (a) => a.setSpeed(4)],
      ["seek", (a) => a.seek(NOW - 3 * H)],
      ["step", (a) => a.step(1)],
    ];
    for (const [name, act] of acts) {
      const st = createPlayheadStore(withSeries([pf]), opts);
      st.actions.startAutoplay();
      st.advance(5);
      const t = st.getState().t;
      act(st.actions);
      const s = st.getState();
      expect(s.autoplay, name).toBeNull();
      expect(s.playing, name).toBe(false);
      if (name === "pause" || name === "toggle" || name === "stopAutoplay" || name === "setSpeed") expect(s.t, name).toBe(t);
      st.advance(5);
      expect(st.getState().t, name).toBe(s.t); // no longer moving
    }
    const st = createPlayheadStore(withSeries([pf]), opts);
    st.actions.startAutoplay();
    st.actions.setSpeed(1);
    st.actions.play(); // Play keeps going as ordinary playback
    expect(st.getState()).toMatchObject({ autoplay: null, playing: true });
    st.actions.pause();
  });
  test("hover focus and sound do not stop auto-play", () => {
    const st = createPlayheadStore(withSeries([pf]), opts);
    st.actions.startAutoplay();
    st.actions.setFocus({ kind: "facility", id: "F" });
    st.actions.toggleSound();
    expect(st.getState().autoplay).not.toBeNull();
    st.actions.stopAutoplay();
    st.actions.toggleSound();
  });
});
