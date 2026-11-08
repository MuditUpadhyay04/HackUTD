"use client";
// One facility line: wells -> tank -> pump -> pipeline -> trunk -> terminus. Static geometry is rendered once; the
// state (color, pattern, text) is switched by data attributes from a memoized view model, so playhead updates at
// 60 fps only touch the few lines whose visible state changed. Packets live on the shared canvas (packets.ts).
import { memo, useEffect, useMemo, useRef } from "react";
import type { FacilityState, Snapshot } from "@/lib/engine/types";
import { lineColor } from "@/lib/v4/derive";
import { makeLineSelector, type LineVM } from "@/lib/v4/pipeview-model";
import type { LineLayout, Pt } from "@/lib/v4/pipeview-layout";
import { keyboardRecent, reducedMotion } from "@/lib/v4/pipeview-motion";
import { usePlayhead } from "@/lib/v4/store";
import type { PacketEngine } from "./packets";

const pts = (p: readonly Pt[]) => p.map((a) => `${a[0]},${a[1]}`).join(" ");
const NE = { vectorEffect: "non-scaling-stroke" as const };

export interface LineViewProps {
  line: LineLayout;
  facility: FacilityState;
  snapshot: Snapshot;
  /** Prefix for ids of the shared defs (masks, patterns). */
  uid: string;
  engine: PacketEngine;
  hl: "" | "on" | "dim";
  onEnter(fid: string, e: { clientX: number; clientY: number }): void;
  onLeave(fid: string): void;
  onFocusLine(fid: string, el: Element): void;
}

/** Dither-dissolve (4 steps over 280ms via SVG masks); reduced motion: 150ms fade; keyboard: instant. */
function dissolve(el: SVGGElement, uid: string, timer: { id: number | undefined }) {
  window.clearTimeout(timer.id);
  el.removeAttribute("mask");
  if (keyboardRecent()) return;
  if (reducedMotion()) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: "ease-out" }); return; }
  let i = 0;
  const go = () => {
    if (i < 3) { el.setAttribute("mask", `url(#${uid}-dm${++i})`); timer.id = window.setTimeout(go, 70); }
    else el.removeAttribute("mask");
  };
  go();
}

function ariaFor(f: FacilityState, vm: LineVM) {
  const parts = [f.id, vm.stateText || "FLOWING", `TANK ${vm.tankText}`];
  if (vm.alarm) parts.push(vm.alarm.text);
  return parts.join(", ");
}

function LineViewImpl({ line, facility, snapshot, uid, engine, hl, onEnter, onLeave, onFocusLine }: LineViewProps) {
  const select = useMemo(() => makeLineSelector(snapshot, facility), [snapshot, facility]);
  const vm = usePlayhead(select);
  const color = lineColor(line.index);
  const ci = ((line.index % 8) + 8) % 8 + 1;
  const full = pts(line.full);
  const shutPct = snapshot.limits.shutdownPct;
  const visRef = useRef<SVGGElement>(null);
  const pulseRef = useRef<SVGCircleElement>(null);
  const badgeRef = useRef<SVGRectElement>(null);
  const timer = useRef<{ id: number | undefined }>({ id: undefined });
  const prev = useRef<{ status: string; q: number; alarm: boolean } | null>(null);

  // Packets follow the view model (read by the canvas loop, no React involvement per frame).
  useEffect(() => {
    engine.setState(line.facilityId, { motion: vm.motion, flowRatio: vm.flowRatio, inflowRatio: vm.inflowRatio, inflowOn: (vm.inflowBpd ?? 0) > 0 });
  }, [engine, line.facilityId, vm.motion, vm.flowRatio, vm.inflowRatio, vm.inflowBpd]);

  // State change: dither-dissolve; onset of pump down: 3 pulses then steady ring; alarm raise: blinks twice.
  useEffect(() => {
    const p = prev.current;
    const hasAlarm = vm.alarm != null;
    if (p && (p.status !== vm.status || p.q !== vm.q) && visRef.current) {
      dissolve(visRef.current, uid, timer.current);
      if (vm.status === "down" && p.status !== "down" && !keyboardRecent() && !reducedMotion()) {
        pulseRef.current?.animate([{ transform: "scale(0.6)", opacity: 0.9 }, { transform: "scale(1.5)", opacity: 0 }], { duration: 700, iterations: 3, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
      }
    }
    if (p && hasAlarm && !p.alarm && !keyboardRecent() && !reducedMotion()) {
      badgeRef.current?.animate([{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }, { opacity: 1 }], { duration: 700, easing: "steps(1)" });
    }
    prev.current = { status: vm.status, q: vm.q, alarm: hasAlarm };
  }, [vm.status, vm.q, vm.alarm, uid]);
  useEffect(() => () => window.clearTimeout(timer.current.id), []);

  const gaugeScale = vm.levelPct == null ? 0 : Math.max(0, Math.min(1, vm.levelPct / 100));
  const limitY = 9 - 18 * (Math.max(0, Math.min(100, shutPct)) / 100);

  return (
    <g
      className="pv-line"
      tabIndex={0}
      role="img"
      aria-label={ariaFor(facility, vm)}
      data-fid={line.facilityId}
      data-k={vm.status}
      data-q={vm.q}
      data-tone={vm.tone}
      data-red={vm.redOn ? 1 : 0}
      data-hl={hl}
      data-gauge={vm.levelPct == null ? "none" : "ok"}
      data-alarm={vm.alarm ? 1 : 0}
      style={{ "--c": color } as React.CSSProperties}
      onPointerEnter={(e) => onEnter(line.facilityId, e)}
      onPointerLeave={() => onLeave(line.facilityId)}
      onFocus={(e) => { if (e.target === e.currentTarget) onFocusLine(line.facilityId, e.currentTarget); }}
      onBlur={(e) => { if (e.target === e.currentTarget) onLeave(line.facilityId); }}
    >
      <g className="vis" ref={visRef}>
        {line.wells.map((w) => (
          <g key={w.id}>
            <polyline {...NE} className="pv-wb pv-draw" points={pts(w.path)} />
            <polyline {...NE} className="pv-wgrey" points={pts(w.path)} />
          </g>
        ))}
        <polyline {...NE} className="pv-up pv-draw" points={pts(line.up)} />
        <polyline {...NE} className="pv-dn pv-draw" points={pts(line.down)} />
        {([1, 2, 3] as const).map((s) => (
          <polyline key={s} {...NE} className={`pv-dith pv-d${s}`} points={full} style={{ stroke: `url(#${uid}-d-${ci}-${s})` }} />
        ))}
        <polyline {...NE} className="pv-red" points={pts(line.down)} />
        <polyline {...NE} className="pv-hatch" points={pts(line.pipe)} style={{ stroke: `url(#${uid}-hatchw)` }} />
      </g>

      <g className="pv-stations">
        {line.wells.map((w) => (
          <g key={w.id} transform={`translate(${w.at[0]} ${w.at[1]})`}>
            <g className="gs"><circle className="pv-wt" r={3.5} /></g>
            <g className="cs"><text className="lbl well" x={-8} y={3} textAnchor="end">{w.id}</text></g>
          </g>
        ))}
        <g transform={`translate(${line.tank[0]} ${line.tank[1]})`} data-tank="">
          <g className="gs">
            <circle className="pv-ring" r={17} />
            <circle className="pv-pulse" r={17} ref={pulseRef} />
            <rect className="pv-tbody" x={-9} y={-11} width={18} height={22} />
            <g mask={`url(#${uid}-gauge)`}>
              <rect className="pv-tfill" x={-7} y={-9} width={14} height={18} style={{ transform: `scaleY(${gaugeScale})` }} />
            </g>
            <rect className="pv-tlimit" x={-10} y={limitY - 0.6} width={20} height={1.2} />
            <rect className="pv-badge" x={8} y={-18} width={8} height={8} ref={badgeRef} />
          </g>
        </g>
        <g transform={`translate(${line.pump[0]} ${line.pump[1]})`}>
          <g className="gs">
            <circle className="pv-pring" r={13} style={{ stroke: `url(#${uid}-hatchpx)` }} />
            <circle className="pv-pbody" r={8} />
            <polygon className="pv-pglyph" points="-3,-4.5 5,0 -3,4.5" />
          </g>
        </g>
        <g transform={`translate(${line.anchors.id[0]} ${line.anchors.id[1]})`} className="pv-lbl-id"><g className="cs"><text className="lbl id" x={0} y={0}>{line.facilityId}</text></g></g>
        <g transform={`translate(${line.anchors.tank[0]} ${line.anchors.tank[1]})`} className="pv-lbl-num"><g className="cs"><text className="lbl num" x={0} y={0} textAnchor="middle">{vm.tankText}</text></g></g>
        <g transform={`translate(${line.anchors.flow[0]} ${line.anchors.flow[1]})`} className="pv-lbl-slot"><g className="cs"><text className="lbl slot" x={0} y={0} textAnchor="middle">{vm.slot}</text></g></g>
      </g>

      <g className="pv-hit">
        <polyline {...NE} points={full} />
        {line.wells.map((w) => <polyline key={w.id} {...NE} points={pts(w.path)} />)}
      </g>
    </g>
  );
}

export const LineView = memo(LineViewImpl);
