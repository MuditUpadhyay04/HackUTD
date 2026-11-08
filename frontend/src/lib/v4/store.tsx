"use client";
// Playhead store (time model: docs/ui-v4-build.md). One store per run; it is recreated when snapshot.runId changes,
// resetting t to snapshot.nowUnix. speed, sound and playing carry over so a commitAt does not stop playback.
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Snapshot } from "@/lib/engine/types";
import type { OperatorAction, Snapshot as ApiSnapshot } from "@hackutd/contracts";
import { api, commandKey, unwrap } from "@/lib/api";
import { localWindow, projectionEnd } from "@/lib/v4/derive";

export const STEP_SECONDS = 300;
/** 1x = 5 minutes of data per second. */
export const SPEEDS = [1, 4, 16] as const;
export type Speed = (typeof SPEEDS)[number];
export const SECONDS_PER_REAL_SECOND = 300;

export type Focus = { kind: "facility" | "incident" | "system" | "plan"; id: string } | null;

export interface PlayheadState {
  /** Playhead unix seconds (fractional while playing). */
  t: number;
  playing: boolean;
  speed: Speed;
  sound: boolean;
  /** Incident ids and plan ids acknowledged in this run. */
  approved: readonly string[];
  focus: Focus;
  /** Showcase loop (docs/ui-v4-balance.md). Non-null while auto-playing; any user time action clears it. */
  autoplay: AutoplayLoop | null;
}

/** One showcase loop: playhead runs start to end in AUTOPLAY_LOOP_SECONDS of real time, then wraps. */
export interface AutoplayLoop {
  start: number;
  end: number;
  /** True when the loop runs on into the projected (what-if) zone. */
  projection: boolean;
  /** Data seconds per real second. */
  rate: number;
}

export const AUTOPLAY_HOURS = 12;
export const AUTOPLAY_LOOP_SECONDS = 25;
export const AUTOPLAY_DELAY_MS = 1200;

/**
 * The showcase loop for a snapshot: from max(window start, dataset start, now - 12 h) to the projection end (or now when
 * there is no projection). Null when that range is under a minute. Pure; the playhead range limits already contain it.
 */
export function autoplayLoop(snapshot: Pick<Snapshot, "nowUnix" | "dataset" | "systems" | "alerts" | "fleets">): AutoplayLoop | null {
  const now = snapshot.nowUnix;
  const proj = projectionEnd(snapshot as Snapshot);
  const start = Math.max(localWindow(snapshot as Snapshot).start, snapshot.dataset.startUnix, now - AUTOPLAY_HOURS * 3600);
  const end = proj ?? now;
  if (!(end - start >= 60)) return null;
  return { start, end, projection: proj != null && proj > now, rate: (end - start) / AUTOPLAY_LOOP_SECONDS };
}

export interface PlayheadActions {
  play(): void;
  pause(): void;
  toggle(): void;
  /** direction * 5 minutes. */
  step(direction: 1 | -1): void;
  /** Clamped to [dataset.startUnix, projectionEnd or dataset.nowUnix]; stops playback at the end. */
  seek(t: number): void;
  setSpeed(speed: Speed): void;
  toggleSound(): void;
  /** Local acknowledgement only (ghost trucks turn solid). Use approvePlan() to also POST it. */
  approve(id: string): void;
  setFocus(focus: Focus): void;
  /** Starts the showcase loop. Returns false (and does nothing) under reduced motion or when there is no range. */
  startAutoplay(): boolean;
  /** Ends the loop (and the pending auto-start) for this session; the playhead stays where it is, paused. */
  stopAutoplay(): void;
}

export interface PlayheadStore {
  getState(): PlayheadState;
  subscribe(listener: () => void): () => void;
  actions: PlayheadActions;
  /** Starts the rAF loop; returns a disposer. Called by the provider. */
  attach(): () => void;
  /** Moves the playhead by dt real seconds (the rAF loop calls this; exposed for tests). */
  advance(dt: number): void;
}

export interface PlayheadOptions {
  /** Injectable prefers-reduced-motion flag (defaults to the media query). Reduced motion never auto-plays. */
  reducedMotion?: boolean;
  /** Delay before the first auto-play after attach (stands in for the Pipe View draw-in). */
  autoplayDelayMs?: number;
}

// Survives run changes (module scope, per browser tab).
const carry = { playing: false, speed: 1 as Speed, sound: false, /** a user interaction ended auto-play: it never restarts this session */ autoplayStopped: false };

const prefersReducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function createPlayheadStore(snapshot: Pick<Snapshot, "nowUnix" | "dataset" | "systems" | "alerts" | "fleets">, options: PlayheadOptions = {}): PlayheadStore {
  const lo = snapshot.dataset.startUnix;
  // End of the playable range: the dataset end, or the end of the projection (what-if zone) on a live snapshot with a
  // pump failure. Past snapshot.nowUnix the shell never commits a run (it is a simulation, hard rule 6).
  const hi = Math.max(snapshot.dataset.nowUnix, projectionEnd(snapshot as Snapshot) ?? 0);
  let state: PlayheadState = { t: snapshot.nowUnix, playing: carry.playing, speed: carry.speed, sound: carry.sound, approved: [], focus: null, autoplay: null };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<PlayheadState>) => {
    const next = { ...state, ...patch };
    if ((Object.keys(patch) as (keyof PlayheadState)[]).every((k) => Object.is(state[k], next[k]))) return;
    state = next;
    carry.playing = state.playing && !state.autoplay; carry.speed = state.speed; carry.sound = state.sound;
    listeners.forEach((l) => l());
  };
  const windowStart = () => Math.min(hi, Math.max(lo, localWindow(snapshot as Snapshot).start));
  const clamp = (t: number) => Math.min(hi, Math.max(lo, t));
  // Any user time action ends auto-play for the session and leaves the playhead paused where it is (Play excepted).
  const userPatch = (patch: Partial<PlayheadState>): Partial<PlayheadState> => {
    carry.autoplayStopped = true;
    return state.autoplay ? { autoplay: null, playing: false, ...patch } : patch;
  };
  const actions: PlayheadActions = {
    // At the end of the data Play restarts from the start of the loaded window (DAW behavior).
    play: () => {
      carry.autoplayStopped = true;
      if (state.t < hi) { set({ playing: true, autoplay: null }); return; }
      const start = windowStart();
      set({ t: start, playing: start < hi, autoplay: null });
    },
    pause: () => set(userPatch({ playing: false })),
    toggle: () => (state.playing ? actions.pause() : actions.play()),
    step: (d) => set(userPatch({ t: clamp(Math.round(state.t / STEP_SECONDS) * STEP_SECONDS + d * STEP_SECONDS), playing: false })),
    seek: (t) => set(Number.isFinite(t) ? userPatch({ t: clamp(t) }) : {}),
    setSpeed: (speed) => set(userPatch({ speed })),
    toggleSound: () => set({ sound: !state.sound }),
    approve: (id) => { if (!state.approved.includes(id)) set({ approved: [...state.approved, id] }); },
    setFocus: (focus) => {
      const a = state.focus;
      if (a === focus || (a && focus && a.kind === focus.kind && a.id === focus.id)) return;
      set({ focus });
    },
    startAutoplay: () => {
      const reduced = options.reducedMotion ?? prefersReducedMotion();
      const loop = reduced ? null : autoplayLoop(snapshot);
      if (!loop) return false;
      set({ autoplay: loop, t: loop.start, playing: true });
      return true;
    },
    stopAutoplay: () => set(userPatch({})),
  };
  const advance = (dt: number) => {
    const ap = state.autoplay;
    if (ap) {
      const span = ap.end - ap.start;
      const next = state.t + dt * ap.rate;
      set({ t: next >= ap.end ? ap.start + ((next - ap.start) % span) : next });
      return;
    }
    if (!state.playing) return;
    const next = state.t + dt * SECONDS_PER_REAL_SECOND * state.speed;
    if (next >= hi) set({ t: hi, playing: false });
    else set({ t: next });
  };
  const attach = () => {
    let raf = 0;
    let last = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      if (document.hidden) return;
      advance(dt);
    };
    const start = () => { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    // Pause the loop entirely while the tab is hidden (the playhead does not drift).
    const onVis = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVis);
    if (!document.hidden) start();
    // First-load showcase: shortly after attach (the Pipe View draw-in takes about a second), unless the user acted.
    const timer = carry.autoplayStopped ? undefined : window.setTimeout(() => {
      if (!carry.autoplayStopped && !state.autoplay && !state.playing) actions.startAutoplay();
    }, options.autoplayDelayMs ?? AUTOPLAY_DELAY_MS);
    return () => { document.removeEventListener("visibilitychange", onVis); window.clearTimeout(timer); stop(); };
  };
  return {
    getState: () => state,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    actions,
    attach,
    advance,
  };
}

const Ctx = createContext<PlayheadStore | null>(null);

function Inner({ snapshot, children }: { snapshot: Snapshot; children: ReactNode }) {
  const [store] = useState(() => createPlayheadStore(snapshot));
  useEffect(() => store.attach(), [store]);
  const { runId, revision } = snapshot as Snapshot & { revision?: number };
  useEffect(() => { loadAcknowledged(snapshot, store).catch(() => undefined); }, [store, runId, revision]); // eslint-disable-line react-hooks/exhaustive-deps -- reload on a new revision only
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

/** Provides the playhead store, recreated (t reset to snapshot.nowUnix, approvals cleared) for every new runId. */
export function PlayheadProvider({ snapshot, children }: { snapshot: Snapshot; children: ReactNode }) {
  return <Inner key={snapshot.runId} snapshot={snapshot}>{children}</Inner>;
}

export function usePlayheadStore(): PlayheadStore {
  const s = useContext(Ctx);
  if (!s) throw new Error("usePlayhead must be used inside <PlayheadProvider>");
  return s;
}

/** Subscribe to a slice. The selector must return a primitive or a referentially stable value. */
export function usePlayhead<T>(selector: (s: PlayheadState) => T): T {
  const store = usePlayheadStore();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getState()));
}

/** Stable action functions (never cause a re-render). */
export function usePlayheadActions(): PlayheadActions {
  return usePlayheadStore().actions;
}

/** True when the snapshot carries the API fields (revision, system plan ids). Real snapshots always do. */
function isApiSnapshot(s: Snapshot): s is ApiSnapshot {
  return typeof (s as Partial<ApiSnapshot>).revision === "number";
}

/** The API refused the acknowledgement because the advice changed under the operator (409 STALE_PLAN). */
export class StalePlanError extends Error {
  constructor() { super("PLAN CHANGED, REFRESHING"); this.name = "StalePlanError"; }
}

/**
 * A system plan is shared by every failing incident in that system. Marks the system plan id and every incident
 * whose plan.systemPlanId matches as acknowledged, so all of that system's trucks turn solid.
 */
function markSystemPlan(snapshot: ApiSnapshot, store: PlayheadStore, systemPlanId: string, incidentId?: string) {
  store.actions.approve(systemPlanId);
  if (incidentId) store.actions.approve(incidentId);
  for (const i of [...snapshot.alerts, ...snapshot.history]) if (i.plan?.systemPlanId === systemPlanId) store.actions.approve(i.id);
}

/**
 * Acknowledge a plan: POST /runs/:id/actions {kind: "acknowledge_advice", planId: incident.plan.systemPlanId,
 * revision: snapshot.revision}, then mark it approved locally. This is advice acknowledgement only, never a dispatch
 * (hard rule 12). Throws StalePlanError on 409 STALE_PLAN and Error on any other failed request.
 */
export async function approvePlan(snapshot: Snapshot, store: PlayheadStore, incidentId: string): Promise<void> {
  if (!isApiSnapshot(snapshot)) throw new Error("Snapshot has no revision");
  const planId = snapshot.alerts.find((i) => i.id === incidentId)?.plan?.systemPlanId;
  if (!planId) throw new Error("Incident has no system plan to acknowledge");
  const result = await api.api.runs({ id: snapshot.runId }).actions.post(
    { incidentId, planId, revision: snapshot.revision, kind: "acknowledge_advice" },
    { headers: { "idempotency-key": commandKey() } },
  );
  if (result.error) {
    const v = (result.error as { value?: { code?: string } | string }).value;
    if (Number(result.error.status) === 409 && typeof v === "object" && v?.code === "STALE_PLAN") throw new StalePlanError();
  }
  unwrap(result);
  markSystemPlan(snapshot, store, planId, incidentId);
}

/** Pre-marks plans already acknowledged on the server (persistence across reloads, global_plan I-13). */
export async function loadAcknowledged(snapshot: Snapshot, store: PlayheadStore): Promise<void> {
  if (!isApiSnapshot(snapshot)) return;
  const actions: OperatorAction[] = unwrap(await api.api.runs({ id: snapshot.runId }).actions.get());
  for (const a of actions) if (a.kind === "acknowledge_advice" && a.planId) markSystemPlan(snapshot, store, a.planId, a.incidentId);
}
