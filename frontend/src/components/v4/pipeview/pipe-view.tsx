"use client";
// Pipe View (brief section 2.2): infinite dot-grid canvas, one neon metro line per facility flow path.
// Camera = one transform on one group, applied imperatively (no React render per pan/zoom frame). Packets are a
// single canvas loop independent of React. Keyboard (Pipe View focused): + - zoom, 0 fit, 1-9 frame system N;
// keyboard-initiated camera moves never animate.
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { FacilityState, Snapshot, SystemState } from "@/lib/engine/types";
import { lineColor } from "@/lib/v4/derive";
import { bpd } from "@/lib/v4/format";
import { dotSpacing, fitCam, lodAt, zoomAt, type Cam } from "@/lib/v4/pipeview-camera";
import { computeLayout, layoutKey, type Box, type ClusterLayout, type PipeLayout, type SystemInput } from "@/lib/v4/pipeview-layout";
import { makeLineSelector, type LineVM } from "@/lib/v4/pipeview-model";
import { introSeen, markIntroSeen, reducedMotion, trackInputModality } from "@/lib/v4/pipeview-motion";
import { usePlayhead, usePlayheadActions, usePlayheadStore } from "@/lib/v4/store";
import { LineView } from "./line-view";
import { PacketEngine, type PacketLine } from "./packets";
import { PvDefs } from "./pv-defs";
import "./pipe-view.css";

const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

// ---- layout memo (single entry: layout depends only on order and counts) ----------------------------------
let cached: { key: string; layout: PipeLayout } | null = null;
function layoutFor(snapshot: Snapshot): { key: string; layout: PipeLayout } {
  const input: SystemInput[] = snapshot.systems.map((s) => ({ id: s.id, facilities: s.facilities.map((f) => ({ id: f.id, wellIds: f.wells.map((w) => w.id) })) }));
  const key = layoutKey(input);
  if (!cached || cached.key !== key) cached = { key, layout: computeLayout(input) };
  return cached;
}

// ---- tooltip -----------------------------------------------------------------------------------------------
let lastTipClosed = 0;
/** Subsequent tooltips (opened within 400ms of one closing) appear instantly. */
const tipIsInstant = () => performance.now() - lastTipClosed < 400;

function TipCard({ snapshot, facility, color, instant }: { snapshot: Snapshot; facility: FacilityState; color: string; instant: boolean }) {
  const select = useMemo(() => makeLineSelector(snapshot, facility), [snapshot, facility]);
  const vm: LineVM = usePlayhead(select);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => { el.dataset.state = "open"; });
    return () => { cancelAnimationFrame(id); lastTipClosed = performance.now(); };
  }, []);
  const row = (k: string, v: string, tone?: string) => <div className="pv-tr" data-tone={tone} key={k}><span>{k}</span><b>{v}</b></div>;
  return (
    <div className="tip" ref={cardRef} data-state={instant ? "open" : "closed"} data-instant={instant} style={{ "--c": color } as React.CSSProperties}>
      <div className="pv-th">{facility.id}</div>
      {row("STATE", vm.stateText || "FLOWING", vm.tone === "down" ? "down" : vm.tone === "inspect" ? "inspect" : undefined)}
      {row("TANK", vm.tankText)}
      {row("PUMP FLOW", vm.flowBpd == null ? "UNKNOWN" : bpd(vm.flowBpd))}
      {row("RECEIVE", vm.receiveBpd == null ? "UNKNOWN" : bpd(vm.receiveBpd))}
      {row("WELLS", String(facility.wells.length))}
      {vm.q > 0 && row("QUALITY", vm.quality)}
      {vm.reasonText && row("REASON", vm.reasonText)}
      {vm.alarm && row("BOARD", vm.alarm.text, "alarm")}
      {vm.etaText && <><div className="pv-tr"><span>SHUTDOWN</span><b>{vm.etaText}</b></div><div className="pv-band" aria-hidden="true" /><div className="pv-tn">ESTIMATE, P10 TO P90</div></>}
    </div>
  );
}

// ---- static cluster chrome ---------------------------------------------------------------------------------
const ClusterChrome = memo(function ClusterChrome({ cluster, system }: { cluster: ClusterLayout; system: SystemState }) {
  const { x, y, r } = cluster.terminus;
  const psi = Number.isFinite(system.disposal.pressurePsi) ? `${Math.round(system.disposal.pressurePsi)} PSI` : "";
  return (
    <g className="pv-cluster" data-sys={cluster.systemId}>
      <g transform={`translate(${cluster.titleAt[0]} ${cluster.titleAt[1]})`}>
        <g className="cs">
          <text className="lbl sys" x={0} y={0}>{system.id} SYSTEM</text>
          <text className="lbl dim" x={0} y={13}>{system.facilities.length} FACILITIES, FLEET {system.fleetSize}</text>
        </g>
      </g>
      <circle className="pv-tring" cx={x} cy={y} r={r} vectorEffect="non-scaling-stroke" />
      <circle className="pv-tring" cx={x} cy={y} r={Math.max(4, r - 6)} vectorEffect="non-scaling-stroke" />
      <g transform={`translate(${x} ${y + r + 8})`}>
        <g className="cs">
          <text className="lbl dim" x={0} y={8} textAnchor="middle">DISPOSAL {system.disposal.id}</text>
          {psi && <text className="lbl num" x={0} y={20} textAnchor="middle">{psi}</text>}
        </g>
      </g>
    </g>
  );
});

function pxColor(root: HTMLElement, v: string): string {
  const name = /var\((--[\w-]+)\)/.exec(v)?.[1];
  return name ? getComputedStyle(root).getPropertyValue(name).trim() || "#2CE5FF" : v;
}

export function PipeView({ snapshot }: { snapshot: Snapshot }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "_");
  const store = usePlayheadStore();
  const { setFocus } = usePlayheadActions();
  const focus = usePlayhead((s) => s.focus);
  const { key: lkey, layout } = layoutFor(snapshot);
  const engine = useState(() => new PacketEngine())[0];

  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const worldRef = useRef<SVGGElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const camRef = useRef<Cam>({ x: 0, y: 0, z: 1 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const camState = useRef<{ z: number; lod: string; grain: SVGPatternElement[]; dots: SVGPatternElement | null }>({ z: Number.NaN, lod: "", grain: [], dots: null });
  const tween = useRef(0);
  const introRef = useRef<boolean | null>(null);
  const [tip, setTip] = useState<{ fid: string; instant: boolean } | null>(null);
  const tipPos = useRef({ x: 0, y: 0 });

  const facilities = useMemo(() => {
    const m = new Map<string, { facility: FacilityState; system: SystemState }>();
    for (const s of snapshot.systems) for (const f of s.facilities) m.set(f.id, { facility: f, system: s });
    return m;
  }, [snapshot.systems]);

  // ---- camera (imperative) ------------------------------------------------------------------------------
  const apply = useCallback(() => {
    const svg = svgRef.current, world = worldRef.current;
    if (!svg || !world) return;
    const c = camRef.current, st = camState.current;
    world.setAttribute("transform", `translate(${c.x} ${c.y}) scale(${c.z})`);
    if (st.z !== c.z) {
      st.z = c.z;
      svg.style.setProperty("--iz", String(1 / c.z));
      svg.style.setProperty("--gz", String(Math.min(1 / c.z, 2)));
      for (const p of st.grain) p.setAttribute("patternTransform", p.dataset.grain === "hatch" ? `rotate(45) scale(${1 / c.z})` : `scale(${1 / c.z})`);
      const lod = lodAt(c.z);
      if (lod !== st.lod) { st.lod = lod; svg.dataset.lod = lod; }
    }
    if (st.dots) {
      const sp = dotSpacing(c.z) * c.z;
      st.dots.setAttribute("width", String(sp));
      st.dots.setAttribute("height", String(sp));
      st.dots.setAttribute("patternTransform", `translate(${c.x - 1} ${c.y - 1})`);
    }
    engine.redraw();
  }, [engine]);

  const goTo = useCallback((target: Cam, ms: number) => {
    cancelAnimationFrame(tween.current);
    if (ms <= 0 || reducedMotion()) { camRef.current = target; apply(); return; }
    const from = { ...camRef.current };
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = 1 - (1 - p) ** 4; // ease-out
      camRef.current = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, z: from.z + (target.z - from.z) * e };
      apply();
      if (p < 1) tween.current = requestAnimationFrame(step);
    };
    tween.current = requestAnimationFrame(step);
  }, [apply]);

  const fitBox = useCallback((box: Box, ms: number) => {
    const { w, h } = sizeRef.current;
    if (w > 0 && h > 0) goTo(fitCam(box, w, h), ms);
  }, [goTo]);
  const frame = useCallback((i: number, ms: number) => {
    const c = i > 0 ? layout.clusters[i - 1] : undefined;
    fitBox(c ? c.bounds : layout.bounds, ms);
  }, [layout, fitBox]);
  const zoomBy = useCallback((f: number, ms: number) => {
    const { w, h } = sizeRef.current;
    goTo(zoomAt(camRef.current, f, w / 2, h / 2), ms);
  }, [goTo]);

  // ---- mount: size, first fit, intro, packets ---------------------------------------------------------------
  useEffect(() => {
    const root = rootRef.current, svg = svgRef.current, canvas = canvasRef.current;
    if (!root || !svg || !canvas) return;
    const off = trackInputModality();
    const st = camState.current;
    st.z = Number.NaN;
    st.grain = Array.from(svg.querySelectorAll<SVGPatternElement>("[data-grain]"));
    st.dots = svg.querySelector<SVGPatternElement>(`[id="${uid}-dots"]`);
    engine.attach(canvas, () => camRef.current, reducedMotion());
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const onMq = () => engine.setReduced(mq.matches);
    mq.addEventListener("change", onMq);
    const lines: PacketLine[] = layout.clusters.flatMap((c) => c.lines.map((l) => ({
      id: l.facilityId, color: pxColor(root, lineColor(l.index)), up: l.up, down: l.down, leakS: l.leakS,
    })));
    engine.setLines(lines);

    if (introRef.current === null) { introRef.current = !introSeen() && !reducedMotion(); markIntroSeen(); }
    const anims: Animation[] = [];
    let needFit = true;

    const intro = () => {
      const z = camRef.current.z;
      const groups = Array.from(svg.querySelectorAll<SVGGElement>(".pv-line"));
      let last: Animation | null = null;
      groups.forEach((g, i) => {
        const delay = Math.min(i * 40, 2400);
        const draw = (sel: string, d0: number, dur: number) => g.querySelectorAll<SVGGeometryElement>(sel).forEach((p) => {
          const len = Math.ceil(p.getTotalLength() * z) + 2; // non-scaling stroke: dashes are in screen px
          anims.push(p.animate(
            [{ strokeDasharray: `${len} ${len}`, strokeDashoffset: len }, { strokeDasharray: `${len} ${len}`, strokeDashoffset: 0 }],
            { duration: dur, delay: delay + d0, easing: EASE_IN_OUT, fill: "backwards" },
          ));
        });
        draw(".pv-wb", 0, 260); draw(".pv-up", 120, 280); draw(".pv-dn", 380, 320);
        const stations = g.querySelector(".pv-stations");
        if (stations) { last = stations.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: delay + 700, easing: EASE_OUT, fill: "backwards" }); anims.push(last); }
      });
      if (last) (last as Animation).finished.then(() => engine.start(), () => undefined);
      else engine.start();
    };

    const onSize = () => {
      const r = root.getBoundingClientRect();
      const w = Math.round(r.width), h = Math.round(r.height);
      if (w === 0 || h === 0) return;
      sizeRef.current = { w, h };
      engine.resize(w, h, Math.min(2, window.devicePixelRatio || 1));
      if (needFit) {
        needFit = false;
        goTo(fitCam(layout.bounds, w, h), 0);
        if (introRef.current) { introRef.current = false; intro(); }
        else engine.start();
      } else apply();
    };
    const ro = new ResizeObserver(onSize);
    ro.observe(root);
    onSize();
    return () => {
      ro.disconnect(); off(); mq.removeEventListener("change", onMq);
      cancelAnimationFrame(tween.current);
      anims.forEach((a) => a.cancel());
      engine.detach();
    };
  }, [lkey, layout, engine, uid, goTo, apply]);

  // Keyboard-originated camera commands from elsewhere (B3's global shortcuts) via a window event. Never animated.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ action: "fit" | "frame" | "zoom-in" | "zoom-out"; index?: number }>).detail;
      if (!d) return;
      if (d.action === "fit") frame(0, 0);
      else if (d.action === "frame") frame(d.index ?? 0, 0);
      else if (d.action === "zoom-in") zoomBy(1.25, 0);
      else if (d.action === "zoom-out") zoomBy(0.8, 0);
    };
    window.addEventListener("v4:pipeview", on);
    return () => window.removeEventListener("v4:pipeview", on);
  }, [frame, zoomBy]);

  // Wheel: ctrl/meta (pinch on trackpads) zooms around the cursor; plain scroll pans. Needs a non-passive listener.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelAnimationFrame(tween.current);
      const k = e.deltaMode === 1 ? 16 : 1;
      const dx = e.deltaX * k, dy = e.deltaY * k;
      if (e.ctrlKey || e.metaKey) {
        const r = svg.getBoundingClientRect();
        camRef.current = zoomAt(camRef.current, Math.exp(-dy * 0.01), e.clientX - r.left, e.clientY - r.top);
      } else camRef.current = { ...camRef.current, x: camRef.current.x - dx, y: camRef.current.y - dy };
      apply();
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [apply, lkey]);

  // ---- pointer: drag pan, two-finger pinch ---------------------------------------------------------------
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const pinch = useRef<{ d: number; z: number } | null>(null);

  const hideTip = useCallback(() => { setTip(null); }, []);
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    rootRef.current?.focus({ preventScroll: true });
    cancelAnimationFrame(tween.current);
    e.currentTarget.setPointerCapture(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 1) drag.current = { x: e.clientX, y: e.clientY, cx: camRef.current.x, cy: camRef.current.y };
    else if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: camRef.current.z };
      drag.current = null;
    }
    e.currentTarget.dataset.drag = "1";
    hideTip();
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = ptrs.current.get(e.pointerId);
    if (p) {
      p.x = e.clientX; p.y = e.clientY;
      if (ptrs.current.size >= 2 && pinch.current) {
        const [a, b] = [...ptrs.current.values()];
        const r = e.currentTarget.getBoundingClientRect();
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const f = (pinch.current.z * (d / pinch.current.d)) / camRef.current.z;
        camRef.current = zoomAt(camRef.current, f, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
        apply();
      } else if (drag.current) {
        camRef.current = { ...camRef.current, x: drag.current.cx + e.clientX - drag.current.x, y: drag.current.cy + e.clientY - drag.current.y };
        apply();
      }
    }
    tipPos.current = { x: e.clientX, y: e.clientY };
    placeTip();
  };
  const onPointerEnd = (e: React.PointerEvent<SVGSVGElement>) => {
    ptrs.current.delete(e.pointerId);
    pinch.current = null;
    if (ptrs.current.size === 1) { const [p] = [...ptrs.current.values()]; drag.current = { x: p.x, y: p.y, cx: camRef.current.x, cy: camRef.current.y }; }
    else { drag.current = null; }
    if (ptrs.current.size === 0) delete e.currentTarget.dataset.drag;
  };

  // ---- tooltip placement (origin-aware) ------------------------------------------------------------------
  const placeTip = useCallback(() => {
    const wrap = tipRef.current, root = rootRef.current;
    if (!wrap || !root) return;
    const r = root.getBoundingClientRect();
    const w = wrap.offsetWidth || 220, h = wrap.offsetHeight || 140;
    let x = tipPos.current.x - r.left + 14, y = tipPos.current.y - r.top + 14;
    let ox = "left", oy = "top";
    if (x + w > r.width - 4) { x = tipPos.current.x - r.left - 14 - w; ox = "right"; }
    if (y + h > r.height - 4) { y = tipPos.current.y - r.top - 14 - h; oy = "bottom"; }
    wrap.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
    const card = wrap.firstElementChild as HTMLElement | null;
    if (card) card.style.transformOrigin = `${ox} ${oy}`;
  }, []);
  useEffect(() => { if (tip) placeTip(); });

  const onEnter = useCallback((fid: string, e: { clientX: number; clientY: number }) => {
    if (svgRef.current?.dataset.drag) return;
    tipPos.current = { x: e.clientX, y: e.clientY };
    setFocus({ kind: "facility", id: fid });
    setTip((t) => (t && t.fid === fid ? t : { fid, instant: tipIsInstant() }));
  }, [setFocus]);
  const onLeave = useCallback((fid: string) => {
    const cur = store.getState().focus;
    if (cur && cur.kind === "facility" && cur.id === fid) setFocus(null);
    setTip((t) => (t && t.fid === fid ? null : t));
  }, [store, setFocus]);
  const onFocusLine = useCallback((fid: string, el: Element) => {
    const tank = el.querySelector("[data-tank]")?.getBoundingClientRect() ?? el.getBoundingClientRect();
    tipPos.current = { x: tank.left + tank.width / 2, y: tank.top + tank.height / 2 };
    setFocus({ kind: "facility", id: fid });
    setTip((t) => (t && t.fid === fid ? t : { fid, instant: tipIsInstant() }));
  }, [setFocus]);

  // ---- keyboard (only while the Pipe View has focus) ----------------------------------------------------
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest("button")) return;
    if (e.key === "+" || e.key === "=") zoomBy(1.25, 0);
    else if (e.key === "-" || e.key === "_") zoomBy(0.8, 0);
    else if (/^[0-9]$/.test(e.key)) frame(Number(e.key), 0);
    else return;
    e.preventDefault();
  };

  // ---- focus from the store (Arrangement hover highlights the line here) -----------------------------------
  const focusSet = useMemo<ReadonlySet<string> | null>(() => {
    if (!focus) return null;
    if (focus.kind === "facility") return new Set([focus.id]);
    if (focus.kind === "system") return new Set(snapshot.systems.find((s) => s.id === focus.id)?.facilities.map((f) => f.id) ?? []);
    const inc = [...snapshot.alerts, ...snapshot.history].find((i) => (focus.kind === "incident" ? i.id === focus.id : (i.plan as { id?: string } | undefined)?.id === focus.id));
    return inc ? new Set([inc.facilityId]) : null;
  }, [focus, snapshot]);

  const tipInfo = tip ? facilities.get(tip.fid) : undefined;
  const tipColor = tipInfo ? lineColor(tipInfo.system.facilities.indexOf(tipInfo.facility)) : "";
  const empty = layout.clusters.length === 0;

  return (
    <div className="pv" ref={rootRef} tabIndex={0} role="group" aria-label="Pipe View, network map" onKeyDown={onKeyDown}>
      <svg
        className="pv-svg" ref={svgRef} data-lod="near"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
      >
        <PvDefs uid={uid} />
        <rect width="100%" height="100%" fill={`url(#${uid}-dots)`} />
        <g ref={worldRef}>
          {layout.clusters.map((c, ci) => {
            const system = snapshot.systems[ci];
            return (
              <g key={c.systemId}>
                <ClusterChrome cluster={c} system={system} />
                {c.lines.map((l) => (
                  <LineView
                    key={l.facilityId} line={l} facility={system.facilities[l.index]} snapshot={snapshot} uid={uid} engine={engine}
                    hl={focusSet ? (focusSet.has(l.facilityId) ? "on" : "dim") : ""}
                    onEnter={onEnter} onLeave={onLeave} onFocusLine={onFocusLine}
                  />
                ))}
              </g>
            );
          })}
        </g>
      </svg>
      <canvas className="pv-canvas" ref={canvasRef} aria-hidden="true" />
      <div className="pv-hud">
        <div className="pv-hint">DRAG PAN, CTRL SCROLL ZOOM, 0 FIT, 1 TO 9 FRAME SYSTEM</div>
        <div className="pv-legend" aria-label="State encoding">
          <span className="pv-lg"><i className="pv-sw" />FLOWING</span>
          <span className="pv-lg"><i className="pv-sw idle" />IDLE</span>
          <span className="pv-lg"><i className="pv-sw red" />PUMP DOWN</span>
          <span className="pv-lg"><i className="pv-sw hatch" />INSPECT</span>
          <span className="pv-lg"><i className="pv-sw dith" />NO DATA</span>
          <span className="pv-lg"><i className="pv-sw alarm" />BOARD ALARM</span>
        </div>
        <div className="pv-zoom">
          <button type="button" className="tp-btn press" aria-label="Zoom out" onClick={(e) => zoomBy(0.8, e.detail === 0 ? 0 : 240)}>-</button>
          <button type="button" className="tp-btn press" aria-label="Fit all" onClick={(e) => frame(0, e.detail === 0 ? 0 : 240)}>FIT</button>
          <button type="button" className="tp-btn press" aria-label="Zoom in" onClick={(e) => zoomBy(1.25, e.detail === 0 ? 0 : 240)}>+</button>
        </div>
      </div>
      {empty && <div className="pv-empty"><span className="label">NO SYSTEMS IN THIS RUN</span></div>}
      {tip && tipInfo && (
        <div className="pv-tipwrap" ref={tipRef} key={tip.fid}>
          <TipCard snapshot={snapshot} facility={tipInfo.facility} color={tipColor} instant={tip.instant} />
        </div>
      )}
    </div>
  );
}
