"use client";
// Mini scrubber: the loaded local window inside the full dataset range; not-loaded parts are dithered (never invent
// data outside the window). Dragging seeks the playhead; the shell commits a new run after the debounce.
import { useLayoutEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { Snapshot } from "@/lib/engine/types";
import { localWindow } from "@/lib/v4/derive";
import { stamp } from "@/lib/v4/format";
import { usePlayhead, usePlayheadActions, usePlayheadStore } from "@/lib/v4/store";

export function MiniScrubber({ snapshot }: { snapshot: Snapshot }) {
  const store = usePlayheadStore();
  const a = usePlayheadActions();
  const minute = usePlayhead((s) => Math.floor(s.t / 60) * 60);
  const lo = snapshot.dataset.startUnix;
  const hi = snapshot.dataset.nowUnix;
  const span = Math.max(1, hi - lo);
  const win = useMemo(() => localWindow(snapshot), [snapshot]);
  const frac = (t: number) => Math.min(1, Math.max(0, (t - lo) / span));
  const head = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useLayoutEffect(() => {
    const apply = () => {
      if (head.current) head.current.style.transform = `translateX(${(((store.getState().t - lo) / span) * 100).toFixed(3)}%)`;
    };
    apply();
    return store.subscribe(apply);
  }, [store, lo, span]);

  const seekFrom = (e: PointerEvent<HTMLDivElement>) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    a.seek(lo + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * span);
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    a.pause();
    seekFrom(e);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => { if (dragging.current) seekFrom(e); };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  // Home and End jump to the dataset ends; arrows are handled by the global keyboard hook.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Home") { e.preventDefault(); a.seek(lo); }
    else if (e.key === "End") { e.preventDefault(); a.seek(hi); }
  };

  const ws = frac(win.start);
  const we = frac(win.end);
  const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
  return (
    <div
      className="sc"
      role="slider"
      tabIndex={0}
      aria-label="Playhead position in the dataset"
      aria-valuemin={lo}
      aria-valuemax={hi}
      aria-valuenow={minute}
      aria-valuetext={stamp(minute)}
      title={`LOADED ${stamp(win.start)} TO ${stamp(win.end)}. DITHERED PARTS ARE NOT LOADED.`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onKeyDown={onKey}
    >
      <div className="sc-track" ref={track}>
        <i className="sc-seg" data-loaded="false" style={{ left: 0, width: pct(ws) }} />
        <i className="sc-seg" data-loaded="true" style={{ left: pct(ws), width: pct(Math.max(0, we - ws)) }} />
        <i className="sc-seg" data-loaded="false" style={{ left: pct(we), width: pct(1 - we) }} />
      </div>
      <i className="sc-now" style={{ left: pct(frac(snapshot.nowUnix)) }} />
      <div className="sc-head" ref={head} />
    </div>
  );
}
