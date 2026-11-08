"use client";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import type { Snapshot } from "@/lib/engine/types";
import type { RunControls } from "@/lib/v4/use-run";
import { inWindow, isProjected, localWindow } from "@/lib/v4/derive";
import { usePlayheadStore } from "@/lib/v4/store";
import { setOverviewOpen, useOverviewLayout } from "@/lib/v4/layout-state";
import { OverviewPanel } from "@/components/v4/overview/overview-panel";
import { PipeView } from "./pipeview/pipe-view";
import { Arrangement } from "./arrangement/arrangement";
import { TruckRoad } from "./trucks/truck-road";
import { Transport } from "./transport/transport";
import { Rail } from "./rail";

export const COMMIT_DEBOUNCE_MS = 600;

/**
 * Time model (docs/ui-v4-build.md): inside localWindow(snapshot) the playhead is rendered locally. Outside it, wait
 * 600 ms after the last scrub (or after play runs past nowUnix) and load a run at that time. A run already loading
 * blocks further commits. t at or past the dataset end commits LIVE (commitAt does the mapping).
 * Exception: on a live snapshot with a pump failure, t past nowUnix is the PROJECTED what-if zone (derive.isProjected):
 * it is simulated locally and never commits a run (hard rule 6).
 */
function useDebouncedCommit(snapshot: Snapshot, run: RunControls) {
  const store = usePlayheadStore();
  const win = useMemo(() => localWindow(snapshot), [snapshot]);
  const { commitAt, loading } = run;
  useEffect(() => {
    const local = (t: number) => inWindow(win, t) || isProjected(snapshot, t);
    let timer: number | undefined;
    const fire = () => {
      timer = undefined;
      const s = store.getState();
      if (!local(s.t)) commitAt(s.t);
    };
    const check = () => {
      const s = store.getState();
      if (loading || local(s.t)) { window.clearTimeout(timer); timer = undefined; return; }
      // While playing past the window the playhead moves every frame: keep the pending timer instead of re-arming it.
      if (s.playing && timer !== undefined) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(fire, COMMIT_DEBOUNCE_MS);
    };
    check();
    const off = store.subscribe(check);
    return () => { off(); window.clearTimeout(timer); };
  }, [store, win, snapshot, commitAt, loading]);
}

/**
 * Any user interaction ends the showcase auto-play for the session and leaves the playhead paused where it is:
 * pointerdown or wheel on the main column (map pan and zoom, timeline), pointerdown on the rail, and any key press.
 * The keydown listener is registered after the transport's keyboard hook (child effects run first), so a Space press
 * toggles playback against the already stopped state instead of racing it.
 */
function useStopAutoplayOnInteraction(main: React.RefObject<HTMLElement | null>, rail: React.RefObject<HTMLElement | null>) {
  const store = usePlayheadStore();
  useEffect(() => {
    const stop = () => { if (store.getState().autoplay) store.actions.stopAutoplay(); };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta" || e.key === "Tab") return;
      stop();
    };
    const m = main.current, r = rail.current;
    m?.addEventListener("pointerdown", stop, true);
    m?.addEventListener("wheel", stop, { capture: true, passive: true });
    r?.addEventListener("pointerdown", stop, true);
    document.addEventListener("keydown", onKey);
    return () => {
      m?.removeEventListener("pointerdown", stop, true);
      m?.removeEventListener("wheel", stop, true);
      r?.removeEventListener("pointerdown", stop, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [store, main, rail]);
}

const MIN = 0.2, MAX = 0.8;

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" style={{ transform: dir === "left" ? "scaleX(-1)" : undefined } as CSSProperties}>
      <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Shell({ snapshot, run }: { snapshot: Snapshot; run: RunControls }) {
  useDebouncedCommit(snapshot, run);
  const [ratio, setRatio] = useState(0.62); // Pipe View is the hero: about 62% of Pipe View + timeline
  const overview = useOverviewLayout();
  const mainRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  useStopAutoplayOnInteraction(mainRef, railRef);
  const hasTrucks = useMemo(() => snapshot.fleets.some((f) => f.assignments.length > 0), [snapshot.fleets]);
  useEffect(() => {
    if (!overview.narrow || !overview.open) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setOverviewOpen(false, true); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [overview.narrow, overview.open]);
  const [drag, setDrag] = useState(false);
  const split = useRef<HTMLDivElement>(null);
  const clamp = (r: number) => Math.min(MAX, Math.max(MIN, r));

  const onDown = (e: PointerEvent<HTMLDivElement>) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag(true); };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag || !split.current) return;
    const rect = split.current.getBoundingClientRect();
    setRatio(clamp((e.clientY - rect.top) / rect.height));
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => { e.currentTarget.releasePointerCapture(e.pointerId); setDrag(false); };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowUp") { e.preventDefault(); setRatio((r) => clamp(r - 0.02)); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setRatio((r) => clamp(r + 0.02)); }
  };

  return (
    <div className="v4-shell" data-ov={overview.open ? "open" : "closed"}>
      <div className="v4-rail-slot" ref={railRef}><Rail snapshot={snapshot} datasetId={run.dataset?.id} /></div>
      <main className="v4-main" ref={mainRef}>
        <div
          className="v4-split"
          ref={split}
          style={{ "--pv": `${(ratio * 100).toFixed(2)}fr`, "--ar": `${((1 - ratio) * 100).toFixed(2)}fr` } as React.CSSProperties}
        >
          <section className="v4-pane" aria-label="Pipe View"><PipeView snapshot={snapshot} /></section>
          <div
            className="v4-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize Pipe View and Arrangement"
            aria-valuemin={MIN * 100}
            aria-valuemax={MAX * 100}
            aria-valuenow={Math.round(ratio * 100)}
            tabIndex={0}
            data-drag={drag}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onKeyDown={onKey}
          />
          <section className="v4-pane" aria-label="Arrangement"><Arrangement snapshot={snapshot} /></section>
        </div>
        {hasTrucks && <section className="v4-trucks-slot" aria-label="Truck road"><TruckRoad snapshot={snapshot} /></section>}
        <footer className="v4-transport-slot"><Transport snapshot={snapshot} run={run} /></footer>
      </main>
      {overview.narrow && <div className="v4-scrim" data-open={overview.open} data-instant={overview.instant} onPointerDown={() => setOverviewOpen(false)} aria-hidden="true" />}
      <div
        className="v4-overview"
        data-open={overview.open}
        data-narrow={overview.narrow}
        data-instant={overview.instant}
        inert={!overview.open || undefined}
      >
        <button type="button" className="v4-ov-tab press" onClick={() => setOverviewOpen(false)} aria-label="Hide overview" title="Hide overview"><Chevron dir="right" /></button>
        <OverviewPanel snapshot={snapshot} />
      </div>
      {!overview.open && (
        <button type="button" className="v4-ov-open press" onClick={() => setOverviewOpen(true)} aria-label="Show overview" title="Show overview"><Chevron dir="left" /><span>Overview</span></button>
      )}
      {run.error && <div className="v4-toast" role="alert">{run.error}</div>}
    </div>
  );
}
