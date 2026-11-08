"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import type { Snapshot } from "@/lib/engine/types";
import { isProjected, localWindow, projectedOffsetText } from "@/lib/v4/derive";
import { usePlayhead, usePlayheadActions, usePlayheadStore } from "@/lib/v4/store";
import { stamp } from "@/lib/v4/format";
import { clampView, gridTicks, panView, timeToX, viewSpan, xToTime, zoomView, type View } from "@/lib/v4/arrangement-scale";
import { facilityClips } from "@/lib/v4/arrangement-clips";
import { ongoingFailures, orderedFacilities, timeDomain, unloadedRegions } from "@/lib/v4/arrangement-takes";
import { notesFromAnalysis, stackNotes, type NoteView } from "@/lib/v4/arrangement-notes";
import { ArrContext, useArr, type ArrCtx } from "./ctx";
import { useAnalysis } from "./use-analysis";
import { FacilityBlock, GroupRow, Reveal } from "./tracks";
import "./arrangement.css";

const NOTE_ROW_PX = 22;

function initialView(domainStart: number, domainEnd: number, winStart: number, minSpan: number): View {
  const t0 = Math.max(domainStart, winStart);
  return clampView({ t0, t1: Math.max(domainEnd, t0 + minSpan) }, { start: domainStart, end: domainEnd });
}

export function Arrangement({ snapshot }: { snapshot: Snapshot }) {
  return <ArrangementInner key={snapshot.runId} snapshot={snapshot} />;
}

function ArrangementInner({ snapshot }: { snapshot: Snapshot }) {
  const win = useMemo(() => localWindow(snapshot), [snapshot]);
  const domain = useMemo(() => timeDomain(snapshot), [snapshot]);
  const failures = useMemo(() => ongoingFailures(snapshot), [snapshot]);
  const regions = useMemo(() => unloadedRegions(snapshot), [snapshot]);
  const home = useMemo(() => initialView(domain.start, domain.end, win.start, 3600), [domain, win]);
  const [view, setView] = useState<View>(home);
  const [width, setWidth] = useState(0);
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const withFailure = new Set(failures.map((f) => f.systemId));
    return Object.fromEntries(snapshot.systems.map((s, i) => [s.id, withFailure.size > 0 ? withFailure.has(s.id) : i === 0]));
  });
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => Object.fromEntries(failures.map((f) => [f.facilityId, true])));
  const [animate, setAnimate] = useState(false);
  const actions = usePlayheadActions();

  const rootRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const live = useRef({ view, width, domain });
  useEffect(() => { live.current = { view, width, domain }; }, [view, width, domain]);

  useEffect(() => {
    const el = rulerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ctrl+wheel (and trackpad pinch) zooms about the pointer; horizontal wheel or shift+wheel pans; vertical wheel scrolls tracks.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      const { view: v, width: w, domain: d } = live.current;
      const area = rulerRef.current?.getBoundingClientRect();
      if (!area || w <= 0) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const anchor = xToTime(v, w, Math.min(w, Math.max(0, e.clientX - area.left)));
        setView(zoomView(v, d, anchor, Math.exp(-e.deltaY * 0.0025)));
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        setView(panView(v, d, (dx / w) * viewSpan(v)));
      }
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, []);

  const ctx = useMemo<ArrCtx>(() => ({ snapshot, view, width, domain, window: win }), [snapshot, view, width, domain, win]);

  const toggleSystem = useCallback((id: string, e: MouseEvent) => {
    setAnimate(e.detail > 0); // keyboard activation (detail 0) never animates
    setOpen((o) => ({ ...o, [id]: !o[id] }));
  }, []);
  const toggleFacility = useCallback((id: string, e: MouseEvent) => {
    setAnimate(e.detail > 0);
    setExpanded((o) => ({ ...o, [id]: !o[id] }));
  }, []);

  const zoomBy = (f: number) => setView((v) => zoomView(v, domain, (v.t0 + v.t1) / 2, f));

  // Ruler scrubbing: direct seek, no easing.
  const dragging = useRef(false);
  const seekAt = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    actions.seek(xToTime(view, r.width, e.clientX - r.left));
  };
  const onRulerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    actions.pause();
    seekAt(e);
  };
  const onRulerMove = (e: PointerEvent<HTMLDivElement>) => { if (dragging.current) seekAt(e); };
  const onRulerUp = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  const ready = width > 0;
  return (
    <ArrContext.Provider value={ctx}>
      <div className="arr" ref={rootRef} aria-label="Arrangement">
        <div className="arr-ruler">
          <div className="arr-hdr">
            <TimeReadout snapshot={snapshot} />
            <span className="arr-zoom">
              <button type="button" className="press" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.6)}>-</button>
              <button type="button" className="press" aria-label="Zoom in" onClick={() => zoomBy(1.6)}>+</button>
              <button type="button" className="press" aria-label="Fit loaded window" onClick={() => setView(home)}>FIT</button>
            </span>
          </div>
          <div
            className="arr-lane arr-rulerlane"
            ref={rulerRef}
            title="Drag to move the playhead"
            onPointerDown={onRulerDown}
            onPointerMove={onRulerMove}
            onPointerUp={onRulerUp}
            onPointerCancel={onRulerUp}
          >
            {ready && <RulerTicks />}
          </div>
        </div>
        <div className="arr-bodywrap">
          {ready && <Grid />}
          <div className="arr-scroll" tabIndex={-1}>
            <NemotronTrack />
            {snapshot.systems.map((system) => {
              const isOpen = !!open[system.id];
              const entries = orderedFacilities(system, failures);
              return (
                <div className="arr-sys" key={system.id}>
                  <GroupRow
                    id={system.id}
                    count={system.facilities.length}
                    open={isOpen}
                    clips={isOpen ? [] : entries.flatMap(({ facility }) => facilityClips(snapshot, facility, win).filter((c) => c.kind !== "nodata").map((c) => ({ ...c, id: `${facility.id}:${c.id}`, label: `${facility.letter} ${c.label}` })))}
                    onToggle={(e) => toggleSystem(system.id, e)}
                  />
                  {isOpen && (
                    <Reveal animate={animate}>
                      {entries.map(({ facility, index }) => (
                        <FacilityBlock
                          key={facility.id}
                          facility={facility}
                          index={index}
                          expanded={!!expanded[facility.id]}
                          failure={failures.find((f) => f.facilityId === facility.id) ?? null}
                          animate={animate}
                          onToggle={(e) => toggleFacility(facility.id, e)}
                        />
                      ))}
                    </Reveal>
                  )}
                </div>
              );
            })}
          </div>
          {ready && <Regions regions={regions} />}
        </div>
        {ready && <Playhead />}
      </div>
    </ArrContext.Provider>
  );
}

// ---------------------------------------------------------------------------

function TimeReadout({ snapshot }: { snapshot: Snapshot }) {
  const minute = usePlayhead((s) => Math.floor(s.t / 60));
  const projected = isProjected(snapshot, minute * 60);
  return <span className="arr-time" data-projected={projected}>{stamp(minute * 60)}{projected ? ` PROJECTED ${projectedOffsetText(snapshot, minute * 60)}` : ""}</span>;
}

const RulerTicks = memo(function RulerTicks() {
  const { view, width } = useArr();
  const ticks = useMemo(() => gridTicks(view, width), [view, width]);
  return (
    <>
      {ticks.map((t) => (
        <span key={t.t} className={`arr-tk ${t.kind}`} style={{ left: timeToX(view, width, t.t) }}>{t.label}</span>
      ))}
    </>
  );
});

const Grid = memo(function Grid() {
  const { view, width } = useArr();
  const ticks = useMemo(() => gridTicks(view, width), [view, width]);
  return (
    <svg className="arr-grid" aria-hidden>
      {ticks.map((t) => {
        const x = Math.round(timeToX(view, width, t.t)) + 0.5;
        return <line key={t.t} className={t.kind} x1={x} x2={x} y1="0" y2="100%" />;
      })}
    </svg>
  );
});

function Regions({ regions }: { regions: ReturnType<typeof unloadedRegions> }) {
  const { view, width } = useArr();
  return (
    <div className="arr-regions" aria-hidden>
      {regions.map((r) => {
        const l = timeToX(view, width, r.start), rr = timeToX(view, width, r.end);
        if (rr < 0 || l > width) return null;
        const left = Math.max(0, l);
        return (
          <div key={`${r.kind}:${r.start}`} className={`arr-region ${r.kind}`} style={{ left, width: Math.min(width, rr) - left }}>
            <span>{r.kind === "notloaded" ? "NOT LOADED" : "PROJECTED, NOT RECORDED"}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Positioned with transform from the store subscription: no React render per frame. */
function Playhead() {
  const { view, width } = useArr();
  const store = usePlayheadStore();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const x = timeToX(view, width, store.getState().t);
      el.style.transform = `translate3d(${x}px,0,0)`;
      el.style.visibility = x < -1 || x > width + 1 ? "hidden" : "visible";
    };
    apply();
    return store.subscribe(apply);
  }, [store, view, width]);
  return <div className="arr-phwrap" aria-hidden><div className="arr-ph" ref={ref} /></div>;
}

// ---------------------------------------------------------------------------
// Track 0: Nemotron notes

interface PopoverState { note: NoteView; left: number; vertical: "top" | "bottom"; offset: number; maxH: number; instant: boolean; origin: string }

function NemotronTrack() {
  const { snapshot, view, width } = useArr();
  const analysis = useAnalysis(snapshot.runId);
  const notes = useMemo(() => notesFromAnalysis(analysis.record, snapshot.nowUnix), [analysis.record, snapshot.nowUnix]);
  const [showAll, setShowAll] = useState(false);
  const [pop, setPop] = useState<PopoverState | null>(null);

  const noteWidth = (n: NoteView) => Math.min(300, 118 + Math.min(n.title.length + n.text.length, 34) * 5.4);
  const maxRows = showAll ? 12 : 3;
  const { placed, hidden } = useMemo(() => stackNotes(
    notes,
    (n) => Math.min(Math.max(0, timeToX(view, width, n.unix)), Math.max(0, width - noteWidth(n))),
    noteWidth, maxRows,
  ), [notes, view, width, maxRows]);
  const rows = Math.max(1, ...placed.map((p) => p.row + 1));
  const status = analysis.status === "loading" ? "READING" : analysis.status === "error" ? "NO NOTE" : `${notes.length} NOTE${notes.length === 1 ? "" : "S"}`;

  const openNote = (note: NoteView, e: MouseEvent<HTMLButtonElement>) => {
    if (pop?.note.id === note.id) { setPop(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    const below = window.innerHeight - r.bottom >= 220 || window.innerHeight - r.bottom >= r.top;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 356));
    setPop({
      note, left, vertical: below ? "top" : "bottom",
      offset: below ? r.bottom + 4 : window.innerHeight - r.top + 4,
      maxH: Math.min(320, (below ? window.innerHeight - r.bottom : r.top) - 16),
      instant: e.detail === 0 || pop != null, // keyboard, or a popover was already open: no animation
      origin: `${Math.round(r.left + Math.min(r.width, 40) / 2 - left)}px ${below ? "top" : "bottom"}`,
    });
  };

  return (
    <div className="arr-row nem" style={{ height: rows * NOTE_ROW_PX }}>
      <div className="arr-hdr nem">
        <span className="arr-nv">NEMOTRON</span>
        <em title={analysis.error ?? undefined}>{status}</em>
      </div>
      <div className="arr-lane">
        {placed.map(({ item, row, left, width: w }) => {
          const outside = item.unix < view.t0 ? "<" : item.unix > view.t1 ? ">" : null;
          return (
            <button
              key={item.id}
              type="button"
              className="arr-note"
              data-draft={item.provenance !== "MODEL-WRITTEN"}
              aria-expanded={pop?.note.id === item.id}
              aria-haspopup="dialog"
              style={{ left, width: w, top: row * NOTE_ROW_PX + 2 }}
              onClick={(e) => openNote(item, e)}
            >
              <i className="arr-nvbar" />
              <b>{outside}{item.provenance}</b>
              <span>{item.title}: {item.text}</span>
            </button>
          );
        })}
        {hidden.length > 0 && (
          <button type="button" className="arr-more" onClick={() => setShowAll(true)}>+{hidden.length} MORE</button>
        )}
        {showAll && notes.length > 3 && (
          <button type="button" className="arr-more less" onClick={() => setShowAll(false)}>FEWER</button>
        )}
      </div>
      {pop && <NotePopover pop={pop} snapshot={snapshot} onClose={() => setPop(null)} />}
    </div>
  );
}

function NotePopover({ pop, snapshot, onClose }: { pop: PopoverState; snapshot: Snapshot; onClose: () => void }) {
  const [shown, setShown] = useState(pop.instant);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pop.instant) return;
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [pop]);
  useEffect(() => {
    const onDown = (e: globalThis.PointerEvent) => {
      const target = e.target as Element | null;
      if (ref.current?.contains(target) || target?.closest(".arr-note")) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", onDown, true); window.removeEventListener("keydown", onKey); };
  }, [onClose]);
  const n = pop.note;
  const model = n.provenance === "MODEL-WRITTEN";
  return (
    <div
      ref={ref}
      className="arr-pop"
      role="dialog"
      aria-label={`${n.provenance} note`}
      data-state={shown ? "open" : "closed"}
      data-instant={pop.instant}
      style={{ left: pop.left, [pop.vertical === "top" ? "top" : "bottom"]: pop.offset, maxHeight: pop.maxH, transformOrigin: pop.origin }}
    >
      <div className="arr-pop-h"><i className="arr-nvbar" />{model ? "NEMOTRON, MODEL WRITTEN" : "DETERMINISTIC DRAFT, NOT MODEL WRITTEN"}</div>
      <div className="arr-pop-r"><span>ABOUT</span><b>{n.title}</b></div>
      <div className="arr-pop-r"><span>PINNED AT</span><b>{stamp(n.unix)}{n.unix === snapshot.nowUnix ? ", NOW" : ""}</b></div>
      {n.model && <div className="arr-pop-r"><span>MODEL</span><b>{n.model}</b></div>}
      <p className="arr-pop-t">{n.text}</p>
      {n.steps.length > 0 && (
        <ol className="arr-pop-steps">
          {n.steps.map((s, i) => <li key={i}><b>{s.agent}</b> {s.text}</li>)}
        </ol>
      )}
      <div className="arr-pop-f">ADVISES ONLY, NEVER DISPATCHES</div>
    </div>
  );
}
