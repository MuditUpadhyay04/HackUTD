"use client";
// One facility line: wells -> tank -> pump -> pipeline -> trunk -> terminus. Static geometry is rendered once; the
// state (color, pattern, text) is switched by data attributes from a memoized view model, so playhead updates at
// 60 fps only touch the few lines whose visible state changed. Packets live on the shared canvas (packets.ts).
import { memo, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { FacilityState, Snapshot } from "@/lib/engine/types";
import { lineColor } from "@/lib/v4/derive";
import { makeLineSelector, type LineVM } from "@/lib/v4/pipeview-model";
import type { LineLayout, Pt } from "@/lib/v4/pipeview-layout";
import type { PillPlan } from "@/lib/v4/pipeview-labels";
import { facilityLabel, LANES, planPill } from "@/lib/v4/pipeview-labels";
import { jumpRecent, keyboardRecent, PULSE_COOLDOWN_MS, reducedMotion } from "@/lib/v4/pipeview-motion";
import type { ZoomStore } from "@/lib/v4/pipeview-zoom";
import { usePlayhead } from "@/lib/v4/store";
import type { PacketEngine } from "./packets";

const pts = (p: readonly Pt[]) => p.map((a) => `${a[0]},${a[1]}`).join(" ");
const FLOW_BASE = -14; // px above the row line (flow numbers, hover only)
const NE = { vectorEffect: "non-scaling-stroke" as const };

export interface LineViewProps {
  line: LineLayout;
  facility: FacilityState;
  snapshot: Snapshot;
  /** Prefix for ids of the shared defs (masks, patterns). */
  uid: string;
  engine: PacketEngine;
  /** Camera zoom store: the line picks its label variant from it without a render per camera frame. */
  zoom: ZoomStore;
  /** Tightest row pitch (world units) of the layout: the label tier is picked from it (same for every row). */
  minPitch: number;
  hl: "" | "on" | "dim";
  onEnter(fid: string, e: { clientX: number; clientY: number }): void;
  onLeave(fid: string): void;
  onFocusLine(fid: string, el: Element): void;
}

/** Dither-dissolve (4 steps over 280ms via SVG masks); reduced motion: 150ms fade; keyboard: instant. */
function dissolve(el: SVGGElement, uid: string, timer: { id: number | undefined }, instant: boolean) {
  window.clearTimeout(timer.id);
  el.removeAttribute("mask");
  if (instant) return;
  if (reducedMotion()) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150, easing: "ease-out" }); return; }
  let i = 0;
  const go = () => {
    if (i < 3) { el.setAttribute("mask", `url(#${uid}-dm${++i})`); timer.id = window.setTimeout(go, 70); }
    else el.removeAttribute("mask");
  };
  go();
}

/** The status pill, one variant chosen by planPill (sized from its text estimate, so it can never cross the trunk). */
function Pill({ plan, title, tone }: { plan: PillPlan; title: string; tone: LineVM["tone"] }) {
  const { w, h, variant, text } = plan;
  const dot = variant === "dot";
  return (
    <g className={`pv-pill pv-pill-${variant}`} style={{ transform: "translateX(var(--pg, 18px))" }}>
      <title>{title}</title>
      <rect className="pv-pbg" x={0} y={-h / 2} width={w} height={h} rx={h / 2} />
      <rect className="pv-ptint" x={0} y={-h / 2} width={w} height={h} rx={h / 2} />
      <g className="pv-pshape" transform={`translate(${dot ? w / 2 : 8} 0)`}>
        {tone === "down" && <circle r={2.8} />}
        {tone === "inspect" && <rect x={-2.6} y={-2.6} width={5.2} height={5.2} rx={1.3} transform="rotate(45)" />}
        {tone === "nodata" && <circle r={2.8} className="ring" />}
        {tone === "none" && <rect x={-3} y={-1.2} width={6} height={2.4} rx={1.2} />}
      </g>
      {!dot && <text className="pv-ptext" x={15} y={3.3}>{text}</text>}
    </g>
  );
}

function ariaFor(f: FacilityState, vm: LineVM) {
  const parts = [f.id, vm.stateText || "Flowing", `Tank ${vm.tankText}`];
  if (vm.alarm) parts.push(vm.alarm.text);
  if (vm.checksUnavailable) parts.push("Leak and wear checks unavailable");
  return parts.join(", ");
}

function LineViewImpl({ line, facility, snapshot, uid, engine, zoom, minPitch, hl, onEnter, onLeave, onFocusLine }: LineViewProps) {
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
  const lastPulse = useRef(0);

  // Label plan for the current zoom. The snapshot is a short string, so this line re-renders only when its
  // variant (or whether the name shows) changes, never per camera frame.
  const planKey = useSyncExternalStore(
    zoom.subscribe,
    () => { const z = zoom.get(); const p = planPill(line, z, vm.pillText, minPitch * z); return `${p.row}|${p.variant}|${p.name}`; },
    () => "none|null|false",
  );
  const plan = useMemo(() => { const z = zoom.get(); return planPill(line, z, vm.pillText, minPitch * z); }, [planKey, line, vm.pillText, minPitch, zoom]); // eslint-disable-line react-hooks/exhaustive-deps -- planKey stands for the zoom

  // Packets follow the view model (read by the canvas loop, no React involvement per frame).
  useEffect(() => {
    engine.setState(line.facilityId, { motion: vm.motion, flowRatio: vm.flowRatio, inflowRatio: vm.inflowRatio, inflowOn: (vm.inflowBpd ?? 0) > 0 });
  }, [engine, line.facilityId, vm.motion, vm.flowRatio, vm.inflowRatio, vm.inflowBpd]);

  // State change: dither-dissolve; onset of pump down: 3 pulses then steady ring; alarm raise: blinks twice.
  // Keyboard input and playhead jumps (the auto-play loop wrapping back to its start, a seek) switch instantly: no
  // dissolve, no pulse, no blink. A pulse run starts at most once per PULSE_COOLDOWN_MS so a flicker cannot re-fire it.
  useEffect(() => {
    const p = prev.current;
    const hasAlarm = vm.alarm != null;
    const instant = keyboardRecent() || jumpRecent();
    const calm = !instant && !reducedMotion();
    if (p && (p.status !== vm.status || p.q !== vm.q) && visRef.current) {
      dissolve(visRef.current, uid, timer.current, instant);
      const now = performance.now();
      if (vm.status === "down" && p.status !== "down" && calm && now - lastPulse.current > PULSE_COOLDOWN_MS) {
        lastPulse.current = now;
        pulseRef.current?.animate([{ transform: "scale(0.6)", opacity: 0.9 }, { transform: "scale(1.5)", opacity: 0 }], { duration: 700, iterations: 3, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
      }
    }
    if (p && hasAlarm && !p.alarm && calm) {
      badgeRef.current?.animate([{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }, { opacity: 1 }], { duration: 700, easing: "steps(1)" });
    }
    prev.current = { status: vm.status, q: vm.q, alarm: hasAlarm };
  }, [vm.status, vm.q, vm.alarm, uid]);
  useEffect(() => () => window.clearTimeout(timer.current.id), []);

  const gaugeScale = vm.levelPct == null ? 0 : Math.max(0, Math.min(1, vm.levelPct / 100));
  const limitY = 8.5 - 17 * (Math.max(0, Math.min(100, shutPct)) / 100);
  const detailText = vm.flowText || (vm.status === "idle" ? "Idle" : "");

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
      data-problem={vm.problem ? 1 : 0}
      data-name={plan.name ? 1 : 0}
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
            <g className="gs"><circle className="pv-wt" r={3} /></g>
            <g className="cs pv-detail"><text className="lbl well" x={-8} y={3} textAnchor="end">{w.id}</text></g>
          </g>
        ))}
        <g transform={`translate(${line.tank[0]} ${line.tank[1]})`} data-tank="">
          <g className="gs">
            <circle className="pv-ring" r={14} />
            <circle className="pv-pulse" r={14} ref={pulseRef} />
            <rect className="pv-tbody" x={-6.5} y={-10} width={13} height={20} rx={6.5} />
            <g clipPath={`url(#${uid}-cap)`}>
              <rect className="pv-tfill" x={-5} y={-8.5} width={10} height={17} style={{ transform: `scaleY(${gaugeScale})` }} />
            </g>
            <rect className="pv-tlimit" x={-8} y={limitY - 0.6} width={16} height={1.2} rx={0.6} />
            <rect className="pv-badge" x={6.5} y={-16} width={8} height={8} rx={2.6} ref={badgeRef} />
          </g>
        </g>
        <g transform={`translate(${line.pump[0]} ${line.pump[1]})`}>
          <g className="gs">
            <circle className="pv-pring" r={10.5} style={{ stroke: `url(#${uid}-hatchpx)` }} />
            <circle className="pv-pbody" r={6.5} />
            <polygon className="pv-pglyph" points="-2,-3.2 3.6,0 -2,3.2" />
          </g>
        </g>
        {plan.name && plan.row !== "none" && LANES[plan.row].id && (
          <g transform={`translate(${line.anchors.id[0]} ${line.anchors.id[1]})`} className="pv-lbl-id"><g className="cs"><text className="lbl id" x={0} y={LANES[plan.row].id![1]}>{facilityLabel(line.facilityId)}</text></g></g>
        )}
        <g transform={`translate(${line.anchors.tank[0]} ${line.anchors.tank[1]})`} className="pv-lbl-num pv-detail"><g className="cs"><text className="lbl num" x={0} y={0} textAnchor="middle">{vm.tankText}</text></g></g>
        <g transform={`translate(${line.anchors.flow[0]} ${line.anchors.flow[1]})`} className="pv-lbl-slot pv-detail"><g className="cs"><text className="lbl slot num" x={0} y={FLOW_BASE} textAnchor="middle">{detailText}</text></g></g>
        {vm.pillText && plan.variant && (
          <g transform={`translate(${line.anchors.state[0]} ${line.anchors.state[1]})`} className="pv-pillwrap">
            <g className="cs">
              <Pill plan={plan} title={vm.pillText} tone={vm.tone} />
            </g>
          </g>
        )}
      </g>

      <g className="pv-hit">
        <polyline {...NE} points={full} />
        {line.wells.map((w) => <polyline key={w.id} {...NE} points={pts(w.path)} />)}
      </g>
    </g>
  );
}

export const LineView = memo(LineViewImpl);
