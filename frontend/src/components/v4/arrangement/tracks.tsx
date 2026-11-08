"use client";
import { memo, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import type { FacilityState, Incident, PlanOption, Snapshot } from "@/lib/engine/types";
import { approvePlan, StalePlanError, usePlayhead, usePlayheadActions, usePlayheadStore } from "@/lib/v4/store";
import { facilityAt, isProjected, lineColor, sampleSeries, type FacilityStatus } from "@/lib/v4/derive";
import { facilityName, hhmm, usd, UNKNOWN } from "@/lib/v4/format";
import { curvePath, seriesMax, seriesPath } from "@/lib/v4/arrangement-paths";
import { facilityClips, type Clip } from "@/lib/v4/arrangement-clips";
import { splitTakes, takesOf } from "@/lib/v4/arrangement-takes";
import { laneViewBox, useArr, xOf } from "./ctx";

/** Playhead time in whole minutes: readouts re-render at most once per data minute, never per frame. */
function useApproved() {
  return usePlayhead((s) => s.approved);
}

function useMinuteT(): number {
  return usePlayhead((s) => Math.floor(s.t / 60)) * 60;
}

// ---------------------------------------------------------------------------
// Status glyph: shape plus text, never colour alone.

const STATUS: Record<FacilityStatus, { label: string; color: string }> = {
  flowing: { label: "Flowing", color: "var(--muted)" },
  idle: { label: "Idle", color: "var(--faint)" },
  down: { label: "Pump down", color: "var(--red)" },
  leak: { label: "Leak", color: "var(--magenta)" },
  worn: { label: "Worn pump", color: "var(--magenta)" },
  shut: { label: "Shut in", color: "var(--red)" },
  nodata: { label: "No data", color: "var(--muted)" },
};

function Glyph({ status }: { status: FacilityStatus }) {
  const c = STATUS[status].color;
  return (
    <svg className="arr-glyph" width="9" height="9" viewBox="0 0 9 9" aria-hidden>
      {status === "flowing" && <path d="M1.5 1.5 L7.5 4.5 L1.5 7.5 Z" fill={c} stroke={c} strokeWidth="1" strokeLinejoin="round" />}
      {status === "idle" && <path d="M2 1 V8 M7 1 V8" stroke={c} strokeWidth="1.5" strokeLinecap="round" />}
      {status === "down" && <rect x="1" y="1" width="7" height="7" rx="2" fill={c} />}
      {status === "shut" && <path d="M1 1 L8 8 M8 1 L1 8" stroke={c} strokeWidth="1.8" strokeLinecap="round" />}
      {(status === "leak" || status === "worn") && (
        <>
          <rect x="0.75" y="0.75" width="7.5" height="7.5" rx="2" fill="none" stroke={c} strokeWidth="1.2" />
          <path d="M1 8 L8 1 M1 5 L5 1 M4 8 L8 4" stroke={c} strokeWidth="1" />
        </>
      )}
      {status === "nodata" && <path d="M1 1h2v2H1zM5 1h2v2H5zM3 3h2v2H3zM7 3h2v2H7zM1 5h2v2H1zM5 5h2v2H5zM3 7h2v2H3z" fill={c} />}
    </svg>
  );
}

function FacilityReadout({ facility }: { facility: FacilityState }) {
  const { snapshot } = useArr();
  const t = useMinuteT();
  const approved = useApproved();
  const at = useMemo(() => facilityAt(snapshot, facility, t, approved), [snapshot, facility, t, approved]);
  const s = STATUS[at.status];
  return (
    <span className="arr-readout">
      <Glyph status={at.status} />
      <span className="arr-status" style={{ color: s.color }}>{s.label}</span>
      {at.levelPct == null ? <b className="arr-unk">{UNKNOWN}</b> : <b>{Math.round(at.levelPct)}%</b>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Clips

const clipClass = (c: Clip) => (c.kind === "nodata" ? `arr-clip nodata q-${c.quality ?? "DROPPED"}` : `arr-clip ${c.kind}`);

export function Clips({ clips, prefix }: { clips: Clip[]; prefix?: string }) {
  const ctx = useArr();
  return (
    <>
      {clips.map((c) => {
        const l = xOf(ctx, c.start);
        const r = xOf(ctx, c.end);
        if (r < 0 || l > ctx.width) return null;
        const left = Math.max(l, 0);
        const w = Math.max(3, Math.min(r, ctx.width) - left);
        const text = `${prefix ? `${prefix} ` : ""}${c.label}`;
        const title = `${text} ${hhmm(c.start)} to ${c.end >= ctx.snapshot.nowUnix && c.kind !== "nodata" ? "now" : hhmm(c.end)}`;
        return (
          <div key={c.id} className={clipClass(c)} style={{ left, width: w }} title={title} role="img" aria-label={title}>
            <span>{text}</span>
          </div>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Reveal: children mount with an opacity + clip-path reveal. Pointer toggles animate; keyboard toggles do not.

export function Reveal({ animate, children }: { animate: boolean; children: ReactNode }) {
  const [anim] = useState(animate); // fixed at mount: a later toggle elsewhere must not replay this one
  return <div className={anim ? "arr-reveal" : undefined}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Group (system) row

export function GroupRow({ id, count, open, clips, onToggle }: { id: string; count: number; open: boolean; clips: Clip[]; onToggle: (e: MouseEvent) => void }) {
  return (
    <div className="arr-row group">
      <div className="arr-hdr">
        <button type="button" className="arr-chev" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} system ${id}`} onClick={onToggle} />
        <b>{id}</b>
        <em>{count} {count === 1 ? "facility" : "facilities"}</em>
      </div>
      <div className="arr-lane">
        {!open && <GroupClips clips={clips} />}
      </div>
    </div>
  );
}

function GroupClips({ clips }: { clips: Clip[] }) {
  return <Clips clips={clips} />;
}

// ---------------------------------------------------------------------------
// Automation lanes

const LanePath = memo(function LanePath({ d, color, opacity, dash }: { d: string; color: string; opacity: number; dash?: string }) {
  return d ? <path d={d} className="arr-data" style={{ stroke: color, opacity }} strokeDasharray={dash} /> : null;
});

function GapDither({ gaps }: { gaps: { t0: number; t1: number }[] }) {
  const ctx = useArr();
  return (
    <>
      {gaps.map((g, i) => {
        const l = xOf(ctx, g.t0), r = xOf(ctx, g.t1);
        if (r < 0 || l > ctx.width) return null;
        const left = Math.max(l, 0);
        return <div key={i} className="arr-gap" style={{ left, width: Math.max(2, Math.min(r, ctx.width) - left) }} />;
      })}
    </>
  );
}

const LANES = [
  { key: "level", name: "Tank" },
  { key: "inflow", name: "Inflow" },
  { key: "pumpFlow", name: "Pump" },
  { key: "receiveFlow", name: "Receive" },
] as const;

function LaneValue({ facility, lane }: { facility: FacilityState; lane: (typeof LANES)[number]["key"] }) {
  const { snapshot } = useArr();
  const t = useMinuteT();
  const approved = useApproved();
  const pct = lane === "level";
  // Past nowUnix the lanes hold their last reading; only a failing tank follows its level curve (derive.facilityAt).
  const v = isProjected(snapshot, t)
    ? (pct ? facilityAt(snapshot, facility, t, approved).levelPct : sampleSeries(facility.series[lane], snapshot.nowUnix, "step"))
    : sampleSeries(facility.series[lane], t, pct ? "linear" : "step");
  if (v == null) return <b className="arr-unk">{UNKNOWN}</b>;
  return <b>{pct ? `${v.toFixed(0)}%` : `${Math.round(v).toLocaleString("en-US")} bpd`}</b>;
}

function Lanes({ facility, color }: { facility: FacilityState; color: string }) {
  const ctx = useArr();
  const { snapshot, window: win, domain } = ctx;
  const [more, setMore] = useState(false);
  const [animate, setAnimate] = useState(false);
  const built = useMemo(() => LANES.map((l) => {
    const series = facility.series[l.key];
    const max = l.key === "level" ? 100 : (l.key === "pumpFlow" ? Math.max(facility.pump.maxFlowBpd, seriesMax(series)) : seriesMax(series)) * 1.1;
    return seriesPath(series, { base: domain.start, max, window: win });
  }), [facility, domain.start, win]);
  const vb = laneViewBox(ctx);
  const limitY = 100 - snapshot.limits.shutdownPct;
  const row = (i: number) => {
    const l = LANES[i];
    return (
      <div className="arr-row sub" key={l.key}>
        <div className="arr-hdr sub" style={{ ["--c" as string]: color }}>
          <span>{l.name}{l.key === "level" ? <i className="arr-limit"> Limit {snapshot.limits.shutdownPct}%</i> : null}</span>
          <LaneValue facility={facility} lane={l.key} />
        </div>
        <div className="arr-lane">
          <GapDither gaps={built[i].gaps} />
          <svg className="arr-svg" viewBox={vb} preserveAspectRatio="none" aria-hidden>
            {l.key === "level" && <line className="arr-shut" x1={ctx.view.t0 - domain.start} x2={ctx.view.t1 - domain.start} y1={limitY} y2={limitY} />}
            <LanePath d={built[i].d} color={color} opacity={l.key === "level" ? 1 : 0.75} />
          </svg>
          {l.key === "level" && <span className="arr-limit-tag" style={{ top: `calc(${limitY}% + 2px)` }}>Limit {snapshot.limits.shutdownPct}%</span>}
        </div>
      </div>
    );
  };
  return (
    <div className="arr-lanes">
      {row(0)}
      <div className="arr-row more">
        <div className="arr-hdr sub">
          <button
            type="button"
            className="press arr-toggle"
            aria-expanded={more}
            onClick={(e) => { setAnimate(e.detail > 0); setMore((m) => !m); }}
          >
            {more ? "Hide inflow, pump, receive" : "Inflow, pump, receive"}
          </button>
        </div>
        <div className="arr-lane" />
      </div>
      {more && <Reveal animate={animate}>{row(1)}{row(2)}{row(3)}</Reveal>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan takes

function tripText(o: PlanOption, planStart: number): string {
  return o.tripAtMin == null || !Number.isFinite(o.tripAtMin) ? "No trip" : `Trip ${hhmm(planStart + o.tripAtMin * 60)}`;
}

function ApproveButton({ snapshot, incident }: { snapshot: Snapshot; incident: Incident }) {
  const store = usePlayheadStore();
  const approved = usePlayhead((s) => s.approved.includes(incident.id));
  const [state, setState] = useState<"idle" | "sending" | "error" | "stale">("idle");
  const label = approved ? "Acknowledged" : state === "sending" ? "Sending" : state === "stale" ? "Plan changed, refreshing" : state === "error" ? "Not sent, retry" : "Approve";
  return (
    <div className="arr-approve">
      <button
        type="button"
        className="press arr-btn"
        disabled={approved || state === "sending" || state === "stale"}
        data-done={approved}
        data-state={state}
        aria-label={approved ? "Plan acknowledged, not dispatched" : "Approve recommended plan (acknowledges advice, does not dispatch)"}
        onClick={() => {
          setState("sending");
          approvePlan(snapshot, store, incident.id).then(
            () => setState("idle"),
            (e: unknown) => {
              if (!(e instanceof StalePlanError)) { setState("error"); return; }
              // The snapshot stream resyncs on its own; allow another try once it has.
              setState("stale");
              window.setTimeout(() => setState("idle"), 3000);
            },
          );
        }}
      >
        {approved && (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M1.8 5.4 L4 7.5 L8.3 2.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        )}
        {label}
      </button>
      <span aria-live="polite">{approved ? "Not dispatched" : "Advice only"}</span>
    </div>
  );
}

function Takes({ incident, color }: { incident: Incident; color: string }) {
  const ctx = useArr();
  const { snapshot, domain } = ctx;
  const takes = useMemo(() => takesOf(incident), [incident]);
  const { shown, rest } = useMemo(() => splitTakes(takes), [takes]);
  const [more, setMore] = useState(false);
  const [animate, setAnimate] = useState(false);
  const vb = laneViewBox(ctx);
  const planStart = snapshot.nowUnix;
  const limitY = 100 - snapshot.limits.shutdownPct;
  const facility = snapshot.systems.flatMap((s) => s.facilities).find((f) => f.id === incident.facilityId);
  const recorded = useMemo(() => (facility ? seriesPath(facility.series.level, { base: domain.start, max: 100, window: ctx.window }).d : ""), [facility, domain.start, ctx.window]);
  const curves = useMemo(() => takes.map((o) => curvePath(o.levelCurve, planStart, domain.start)), [takes, planStart, domain.start]);
  const x0 = ctx.view.t0 - domain.start, x1 = ctx.view.t1 - domain.start;
  const takeRow = ({ option: o, index: i }: { option: PlanOption; index: number }) => {
    const rec = i === 0;
    return (
      <div className="arr-row take" key={`${o.kind}:${i}`} data-rec={rec}>
        <div className="arr-hdr take">
          <div className="arr-take-label">{rec && <i>Recommended</i>}{o.label}</div>
          <div className="arr-take-meta">
            <b className={Number.isFinite(o.cost) ? undefined : "arr-unk"}>{Number.isFinite(o.cost) ? usd(o.cost) : UNKNOWN}</b>
            <span>{o.trucks} {o.trucks === 1 ? "truck" : "trucks"}</span>
            <span className={o.tripAtMin == null ? undefined : "arr-trip"}>{tripText(o, planStart)}</span>
          </div>
        </div>
        <div className="arr-lane">
          <svg className="arr-svg" viewBox={vb} preserveAspectRatio="none" aria-hidden>
            <line className="arr-shut" x1={x0} x2={x1} y1={limitY} y2={limitY} />
            <LanePath d={recorded} color={color} opacity={0.3} />
            {o.tripAtMin != null && Number.isFinite(o.tripAtMin) && <line className="arr-tripline" x1={planStart + o.tripAtMin * 60 - domain.start} x2={planStart + o.tripAtMin * 60 - domain.start} y1="0" y2="100" />}
            {o.truckArrivalsMin.filter(Number.isFinite).map((m, k) => <line key={k} className="arr-arrive" x1={planStart + m * 60 - domain.start} x2={planStart + m * 60 - domain.start} y1="78" y2="100" />)}
            <LanePath d={curves[i]} color={color} opacity={1} />
          </svg>
          <span className="arr-limit-tag" style={{ top: `calc(${limitY}% + 2px)` }}>Limit {snapshot.limits.shutdownPct}%</span>
          {rec && <ApproveButton snapshot={snapshot} incident={incident} />}
        </div>
      </div>
    );
  };
  return (
    <div className="arr-takes">
      <div className="arr-row takehead">
        <div className="arr-hdr sub"><span>Plan takes</span><em>Cheapest first</em></div>
        <div className="arr-lane"><span className="arr-hint">Plan starts {hhmm(planStart)}, projected level of each option</span></div>
      </div>
      {takes.length === 0 && (
        <div className="arr-row takehead"><div className="arr-hdr sub"><span>No options</span><em>{UNKNOWN}</em></div><div className="arr-lane" /></div>
      )}
      {shown.map(takeRow)}
      {rest.length > 0 && (
        <div className="arr-row more">
          <div className="arr-hdr sub">
            <button
              type="button"
              className="press arr-toggle"
              aria-expanded={more}
              onClick={(e) => { setAnimate(e.detail > 0); setMore((m) => !m); }}
            >
              {more ? "Show fewer options" : `Show ${rest.length} more ${rest.length === 1 ? "option" : "options"}`}
            </button>
          </div>
          <div className="arr-lane" />
        </div>
      )}
      {more && <Reveal animate={animate}>{rest.map(takeRow)}</Reveal>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Facility block (track + lanes + takes). Hover sets the shared focus; focus from the Pipe View highlights it.

export function FacilityBlock({ facility, index, expanded, failure, onToggle, animate }: {
  facility: FacilityState; index: number; expanded: boolean; failure: Incident | null; onToggle: (e: MouseEvent) => void; animate: boolean;
}) {
  const ctx = useArr();
  const actions = usePlayheadActions();
  const store = usePlayheadStore();
  const focused = usePlayhead((s) => s.focus?.kind === "facility" && s.focus.id === facility.id);
  const color = lineColor(index);
  const clips = useMemo(() => facilityClips(ctx.snapshot, facility, ctx.window), [ctx.snapshot, facility, ctx.window]);
  const name = facilityName(facility.id);
  return (
    <div
      className="arr-fac"
      data-focus={focused}
      onPointerEnter={() => actions.setFocus({ kind: "facility", id: facility.id })}
      onPointerLeave={() => {
        const f = store.getState().focus;
        if (f && f.kind === "facility" && f.id === facility.id) actions.setFocus(null);
      }}
    >
      <div className="arr-row track" style={{ ["--c" as string]: color }}>
        <div className="arr-hdr track">
          <button type="button" className="arr-chev" aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Show"} lanes for ${name}`} onClick={onToggle} />
          <i className="arr-chip" aria-hidden />
          <span className="arr-name">{name}</span>
          <FacilityReadout facility={facility} />
        </div>
        <div className="arr-lane"><Clips clips={clips} /></div>
      </div>
      {expanded && (
        <Reveal animate={animate}>
          <Lanes facility={facility} color={color} />
          {failure && <Takes incident={failure} color={color} />}
        </Reveal>
      )}
    </div>
  );
}
