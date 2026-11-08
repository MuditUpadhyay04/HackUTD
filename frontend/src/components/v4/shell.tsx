"use client";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Snapshot } from "@/lib/engine/types";
import type { RunControls } from "@/lib/v4/use-run";
import { inWindow, localWindow } from "@/lib/v4/derive";
import { usePlayheadStore } from "@/lib/v4/store";
import { Ticker } from "./ticker/ticker";
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
 */
function useDebouncedCommit(snapshot: Snapshot, run: RunControls) {
  const store = usePlayheadStore();
  const win = useMemo(() => localWindow(snapshot), [snapshot]);
  const { commitAt, loading } = run;
  useEffect(() => {
    let timer: number | undefined;
    const fire = () => {
      timer = undefined;
      const s = store.getState();
      if (!inWindow(win, s.t)) commitAt(s.t);
    };
    const check = () => {
      const s = store.getState();
      if (loading || inWindow(win, s.t)) { window.clearTimeout(timer); timer = undefined; return; }
      // While playing past the window the playhead moves every frame: keep the pending timer instead of re-arming it.
      if (s.playing && timer !== undefined) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(fire, COMMIT_DEBOUNCE_MS);
    };
    check();
    const off = store.subscribe(check);
    return () => { off(); window.clearTimeout(timer); };
  }, [store, win, commitAt, loading]);
}

const MIN = 0.2, MAX = 0.8;

export function Shell({ snapshot, run }: { snapshot: Snapshot; run: RunControls }) {
  useDebouncedCommit(snapshot, run);
  const [ratio, setRatio] = useState(0.53); // Pipe View share of Pipe View + Arrangement (45% vs 40% of the column)
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
    <div className="v4-shell">
      <header className="v4-ticker-slot"><Ticker snapshot={snapshot} /></header>
      <Rail snapshot={snapshot} datasetId={run.dataset?.id} />
      <main className="v4-main">
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
        <section className="v4-trucks-slot" aria-label="Truck road"><TruckRoad snapshot={snapshot} /></section>
      </main>
      <footer className="v4-transport-slot"><Transport snapshot={snapshot} run={run} /></footer>
      {run.error && <div className="v4-toast" role="alert">{run.error}</div>}
    </div>
  );
}
