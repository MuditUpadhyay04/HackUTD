"use client";
// Truck road (brief 2.4). One strip per system with an active pump_failure at the playhead; null when there are none
// (the shell hides the empty slot). Truck positions are a pure function of t (truckPositions in derive.ts): no random,
// no independent timers. Positions are written straight to the DOM (transform: translateX) on every playhead change,
// so playing never re-renders React. Trucks are PLANNED, NOT DISPATCHED (hard rule 12).
import "./trucks.css";
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { Snapshot } from "@/lib/engine/types";
import { incidentsAt, lineColor, truckPositions } from "@/lib/v4/derive";
import { facilityName } from "@/lib/v4/format";
import { usePlayhead, usePlayheadStore, STEP_SECONDS } from "@/lib/v4/store";

const SPRITE = [
  ".#########.....",
  "###########.##.",
  "###########.###",
  "###############",
  "###############",
  ".##..##....##..",
];
const PX = 2;
const SW = SPRITE[0].length * PX;
const SH = SPRITE.length * PX;
const YARD_W = 46; // room for the depot glyph; trucks park at its right
const PAD_R = 56; // room for the last stop label
const SLOT = 8; // parked trucks fan out by this many px

function Sprite() {
  const cells = useMemo(() => {
    const out: { x: number; y: number; d: 0 | 1 }[] = [];
    SPRITE.forEach((row, y) => [...row].forEach((c, x) => {
      if (c !== "#") return;
      // Tank body (left, interior rows) is dithered in a checkerboard; cab and wheels stay solid.
      out.push({ x, y, d: x <= 10 && y >= 1 && y <= 3 && (x + y) % 2 === 1 ? 1 : 0 });
    }));
    return out;
  }, []);
  return (
    <svg className="rd-sprite" viewBox={`0 0 ${SW} ${SH}`} width={SW} height={SH} aria-hidden="true">
      <rect className="rd-outline" x={-2.5} y={-2.5} width={SW + 5} height={SH + 5} />
      {cells.map((c) => <rect key={`${c.x}-${c.y}`} className="rd-px" data-d={c.d} x={c.x * PX} y={c.y * PX} width={PX} height={PX} />)}
    </svg>
  );
}

function Depot() {
  // 15x12 pixel garage: roof, walls, open bay.
  const rows = ["......##......", ".....####.....", "....######....", "...########...", "..##########..", "..##......##..", "..##......##..", "..##......##.."];
  return (
    <svg className="rd-yard" viewBox="0 0 28 16" width={30} height={24} shapeRendering="crispEdges" aria-hidden="true">
      {rows.flatMap((row, y) => [...row].map((c, x) => c === "#" ? <rect key={`${x}-${y}`} x={x * 2} y={y * 2} width={2} height={2} fill="currentColor" /> : null))}
    </svg>
  );
}

let reducedQuery: MediaQueryList | null = null;
const hasReducedMotion = () => {
  if (typeof window === "undefined") return false;
  reducedQuery ??= window.matchMedia("(prefers-reduced-motion: reduce)");
  return reducedQuery.matches;
};

const Strip = memo(function Strip({ snapshot, systemId }: { snapshot: Snapshot; systemId: string }) {
  const store = usePlayheadStore();
  const system = snapshot.systems.find((s) => s.id === systemId);
  const fleet = snapshot.fleets.find((f) => f.systemId === systemId);
  const size = fleet?.size ?? system?.fleetSize ?? 0;

  // Stops in network order: facilities with assigned trips plus the ones failing at t.
  const stopKey = usePlayhead((s) => {
    const want = new Set<string>((fleet?.assignments ?? []).map((a) => a.facilityId));
    for (const i of incidentsAt(snapshot, s.t)) if (i.category === "pump_failure" && i.systemId === systemId) want.add(i.facilityId);
    return (system?.facilities ?? []).filter((f) => want.has(f.id)).map((f) => f.id).join(",");
  });
  const downKey = usePlayhead((s) => incidentsAt(snapshot, s.t).filter((i) => i.category === "pump_failure" && i.systemId === systemId).map((i) => i.facilityId).join(","));
  const approvedAll = usePlayhead((s) => {
    const mine = incidentsAt(snapshot, s.t).filter((i) => i.category === "pump_failure" && i.systemId === systemId);
    return mine.length > 0 && mine.every((i) => s.approved.includes(i.id) || (i.plan != null && s.approved.includes((i.plan as { id?: string }).id ?? "\0")));
  });
  const free = usePlayhead((s) => truckPositions(snapshot, systemId, s.t, s.approved).filter((p) => p.phase === "yard").length);

  const stops = useMemo(() => (stopKey ? stopKey.split(",") : []), [stopKey]);
  const downs = useMemo(() => new Set(downKey ? downKey.split(",") : []), [downKey]);
  const laneRef = useRef<HTMLDivElement>(null);
  const trucks = useRef<(HTMLDivElement | null)[]>([]);
  const apply = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const colors = new Map((system?.facilities ?? []).map((f, i) => [f.id, lineColor(i)]));
    apply.current = () => {
      const lane = laneRef.current;
      if (!lane) return;
      const L = Math.max(YARD_W + SW + 24, lane.clientWidth - PAD_R);
      const s = store.getState();
      const t = hasReducedMotion() ? Math.floor(s.t / STEP_SECONDS) * STEP_SECONDS : s.t; // trucks jump per step
      for (const p of truckPositions(snapshot, systemId, t, s.approved)) {
        const el = trucks.current[p.truck - 1];
        if (!el) continue;
        const park = YARD_W + (p.truck - 1) * SLOT;
        const idx = p.facilityId ? stops.indexOf(p.facilityId) : -1;
        const end = idx < 0 ? park : YARD_W + (L - YARD_W) * ((idx + 1) / stops.length) - SW - 3 - ((p.truck - 1) % 3) * (SW / 3);
        const x = park + (Math.max(park, end) - park) * Math.min(1, Math.max(0, p.progress));
        el.style.transform = `translateX(${x.toFixed(2)}px)`;
        el.style.color = p.facilityId ? (colors.get(p.facilityId) ?? "var(--muted)") : "var(--muted)";
        if (el.dataset.phase !== p.phase) el.dataset.phase = p.phase;
        const planned = String(p.planned);
        if (el.dataset.planned !== planned) el.dataset.planned = planned;
      }
    };
    apply.current();
  }, [store, snapshot, systemId, system, stops, size]);

  useEffect(() => {
    const run = () => apply.current();
    const off = store.subscribe(run);
    const ro = new ResizeObserver(run);
    if (laneRef.current) ro.observe(laneRef.current);
    return () => { off(); ro.disconnect(); };
  }, [store]);

  return (
    <div className="rd" role="group" aria-label={`Truck road, system ${systemId}`}>
      <div className="rd-head">
        <div className="rd-title"><b>SYSTEM {systemId}</b><span>TRUCKS FREE {free}/{size}</span></div>
        <span className="rd-tag" data-kind="plan">PLANNED, NOT DISPATCHED</span>
        <span className="rd-tag" data-ok={approvedAll}>{approvedAll ? "APPROVED, ACKNOWLEDGED" : "RECOMMENDED, NOT APPROVED"}</span>
      </div>
      <div className="rd-lane" ref={laneRef}>
        <div className="rd-road" />
        <span className="rd-yard-l">YARD</span>
        <Depot />
        {stops.map((id, i) => (
          <div key={id} className="rd-stop" data-down={downs.has(id)} style={{ left: `calc(${YARD_W}px + (100% - ${PAD_R + YARD_W}px) * ${(i + 1) / stops.length})` }}>
            <span className="rd-stop-l">{facilityName(id)}{downs.has(id) ? " DOWN" : ""}</span>
          </div>
        ))}
        {Array.from({ length: size }, (_, i) => (
          <div key={i} className="rd-truck" data-phase="yard" data-planned="false" ref={(el) => { trucks.current[i] = el; }} title={`Truck ${i + 1}`}>
            <i className="rd-drain" />
            <Sprite />
          </div>
        ))}
      </div>
    </div>
  );
});

export function TruckRoad({ snapshot }: { snapshot: Snapshot }) {
  const key = usePlayhead((s) => [...new Set(incidentsAt(snapshot, s.t).filter((i) => i.category === "pump_failure").map((i) => i.systemId))].join(","));
  if (!key) return null;
  return (
    <div className="rd-stack">
      {key.split(",").map((id) => <Strip key={id} snapshot={snapshot} systemId={id} />)}
    </div>
  );
}
